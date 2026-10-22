import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent } from 'mdast';
import type { Diagnostic, SnapshotVersion } from '../shared/protocol.js';
import { ExportError } from './errors.js';
import {
  DEFAULT_MAX_RESOURCE_BYTES,
  DEFAULT_MAX_TOTAL_RESOURCE_BYTES,
  type CaptureResourcesOptions,
  type CapturedDataImage,
  type CapturedResourceFile,
  type ExportResourceNode,
  type ResourceCapture,
  type ResourceReference,
} from './types.js';

const MARKDOWN_PARSER = unified().use(remarkParse).use(remarkGfm);

const MEDIA_BY_EXTENSION = new Map<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i;

interface PendingReference {
  nodeId?: string;
  src: string;
  /** 归一化工作区相对路径。 */
  path: string;
}

/**
 * 捕获正文明确引用的必要图片。
 *
 * 只读取工作区 resources/ 下的普通 PNG/JPEG/GIF/WebP，以及正文中已内联的
 * data 图片；不扫描附件库、不联网。缺失、越界、类型不符、超限都产生 error
 * 诊断（调用方须把导出状态置 error），不会静默省略引用。
 */
export async function captureResources(
  root: string,
  nodes: readonly ExportResourceNode[],
  options: CaptureResourcesOptions = {},
): Promise<ResourceCapture> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_RESOURCE_BYTES;
  if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', 'maxFileBytes 必须是正数');
  }
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', 'maxTotalBytes 必须是正数');
  }
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new ExportError('WORKSPACE_ROOT_INVALID', '工作区根路径不能为空');
  }
  if (!Array.isArray(nodes)) {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', 'nodes 必须是数组');
  }

  let rootReal: string;
  try {
    rootReal = await fs.realpath(path.resolve(root));
    const stat = await fs.stat(rootReal);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new ExportError('WORKSPACE_ROOT_INVALID', '无法解析工作区根目录: ' + root, { cause: error });
  }

  const snapshot: SnapshotVersion | null = options.snapshot ?? null;
  const diagnostics: Diagnostic[] = [];
  const references: ResourceReference[] = [];
  const pending = new Map<string, PendingReference>();
  const dataImageBytes = new Map<string, { mediaType: CapturedDataImage['mediaType']; bytes: Buffer; count: number }>();
  let totalBytes = 0;

  for (const node of nodes) {
    const body = typeof node.body === 'string' ? node.body : '';
    const topicPath = typeof node.path === 'string' ? normalizeSlashes(node.path) : '';
    const baseDir = dirnameRelative(topicPath);

    const collected = collectImageSources(body);
    for (const unresolved of collected.unresolved) {
      diagnostics.push(
        errorAt(
          'RESOURCE_REFERENCE_UNRESOLVED',
          '图片引用没有匹配的链接定义，无法确认资源',
          node.id,
          undefined,
          '![' + unresolved + ']',
        ),
      );
    }

    for (const src of collected.sources) {
      const trimmed = src.trim();
      if (trimmed.length === 0) continue;

      const dataMatch = DATA_IMAGE.exec(trimmed);
      if (dataMatch !== null) {
        const mediaType = (dataMatch[1] ?? '').toLowerCase() as CapturedDataImage['mediaType'];
        const encoded = (dataMatch[2] ?? '').replace(/\s+/g, '');
        let bytes: Buffer;
        try {
          bytes = Buffer.from(encoded, 'base64');
        } catch {
          diagnostics.push(errorAt('RESOURCE_DATA_URI_INVALID', '内联图片的 base64 无法解码', node.id, undefined, trimmed));
          continue;
        }
        const actual = detectMediaType(bytes);
        if (actual !== mediaType) {
          diagnostics.push(errorAt('RESOURCE_TYPE_MISMATCH', '内联图片声明类型与实际内容不符', node.id, undefined, trimmed));
          continue;
        }
        const sha256 = await sha256Of(bytes);
        const existing = dataImageBytes.get(sha256);
        if (existing === undefined) {
          dataImageBytes.set(sha256, { mediaType, bytes, count: 1 });
        } else {
          existing.count += 1;
        }
        totalBytes += bytes.byteLength;
        references.push({ ...(node.id === undefined ? {} : { nodeId: node.id }), src: trimmed.slice(0, 64), kind: 'data', key: sha256 });
        continue;
      }

      const resolved = resolveResourcePath(baseDir, trimmed);
      if (resolved === null) {
        diagnostics.push(
          errorAt('RESOURCE_UNSUPPORTED', '仅支持工作区 resources/ 内的相对图片引用', node.id, undefined, trimmed),
        );
        continue;
      }

      if (!pending.has(resolved)) pending.set(resolved, { ...(node.id === undefined ? {} : { nodeId: node.id }), src: trimmed, path: resolved });
      references.push({ ...(node.id === undefined ? {} : { nodeId: node.id }), src: trimmed, kind: 'workspace', key: resolved });
    }
  }

  const resources: Record<string, string> = {};
  const files: CapturedResourceFile[] = [];
  for (const pendingRef of pending.values()) {
    const result = await readOneResource(rootReal, pendingRef, maxFileBytes, totalBytes, maxTotalBytes);
    if ('diagnostic' in result) {
      diagnostics.push(result.diagnostic);
      continue;
    }
    totalBytes += result.file.byteLength;
    files.push(result.file);
    resources[result.file.path] = result.file.dataUri;
  }

  const dataImages: CapturedDataImage[] = [];
  for (const [sha256, entry] of dataImageBytes) {
    dataImages.push({ sha256, mediaType: entry.mediaType, byteLength: entry.bytes.byteLength, count: entry.count });
  }

  if (totalBytes > maxTotalBytes) {
    diagnostics.push({
      code: 'RESOURCE_TOTAL_TOO_LARGE',
      message: '资源总量超过 ' + String(maxTotalBytes) + ' 字节',
      severity: 'error',
    });
  }

  files.sort((a, b) => compareIds(a.path, b.path));
  dataImages.sort((a, b) => compareIds(a.sha256, b.sha256));

  return {
    resources,
    files,
    dataImages,
    references,
    diagnostics: dedupeDiagnostics(diagnostics),
    totalBytes,
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    snapshot,
  };
}

interface ResourceReadResult {
  file: CapturedResourceFile;
}

async function readOneResource(
  rootReal: string,
  reference: PendingReference,
  maxFileBytes: number,
  usedBytes: number,
  maxTotalBytes: number,
): Promise<ResourceReadResult | { diagnostic: Diagnostic }> {
  const fail = (code: string, message: string): { diagnostic: Diagnostic } => ({
    diagnostic: errorAt(code, message, reference.nodeId, reference.path, reference.src),
  });

  const extension = path.posix.extname(reference.path).toLowerCase();
  const expectedType = MEDIA_BY_EXTENSION.get(extension);
  if (expectedType === undefined) {
    return fail('RESOURCE_UNSUPPORTED', '不支持的图片类型: ' + reference.path);
  }

  const segments = reference.path.split('/');
  let current = rootReal;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] as string);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      return fail(
        'RESOURCE_MISSING',
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? '资源文件不存在: ' + reference.path
          : '无法读取资源文件: ' + reference.path,
      );
    }
    if (stat.isSymbolicLink()) {
      return fail('RESOURCE_UNSAFE', '资源路径包含符号链接或 junction: ' + reference.path);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      return fail('RESOURCE_MISSING', '资源路径的上级不是目录: ' + reference.path);
    }
    if (index === segments.length - 1) {
      if (!stat.isFile()) return fail('RESOURCE_UNSUPPORTED', '资源不是普通文件: ' + reference.path);
      if (stat.size > maxFileBytes) {
        return fail('RESOURCE_TOO_LARGE', '资源超过单件上限 ' + String(maxFileBytes) + ' 字节: ' + reference.path);
      }
      if (usedBytes + stat.size > maxTotalBytes) {
        return fail('RESOURCE_TOTAL_TOO_LARGE', '资源总量将超过 ' + String(maxTotalBytes) + ' 字节: ' + reference.path);
      }
    }
    let real: string;
    try {
      real = await fs.realpath(current);
    } catch {
      return fail('RESOURCE_MISSING', '无法解析资源真实路径: ' + reference.path);
    }
    const fromRoot = path.relative(rootReal, real);
    if (fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot)) {
      return fail('RESOURCE_UNSAFE', '资源路径越出工作区: ' + reference.path);
    }
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(current);
  } catch (error) {
    return fail('RESOURCE_MISSING', '无法读取资源文件: ' + reference.path);
  }
  if (bytes.byteLength > maxFileBytes) {
    return fail('RESOURCE_TOO_LARGE', '资源超过单件上限 ' + String(maxFileBytes) + ' 字节: ' + reference.path);
  }
  if (usedBytes + bytes.byteLength > maxTotalBytes) {
    return fail('RESOURCE_TOTAL_TOO_LARGE', '资源总量将超过 ' + String(maxTotalBytes) + ' 字节: ' + reference.path);
  }
  const actualType = detectMediaType(bytes);
  if (actualType === null) {
    return fail('RESOURCE_UNSUPPORTED', '无法识别资源图片格式: ' + reference.path);
  }
  if (actualType !== expectedType) {
    return fail('RESOURCE_TYPE_MISMATCH', '资源扩展名与实际内容不符: ' + reference.path);
  }

  const sha256 = await sha256Of(bytes);
  return {
    file: {
      path: reference.path,
      mediaType: actualType,
      byteLength: bytes.byteLength,
      sha256,
      dataUri: 'data:' + actualType + ';base64,' + bytes.toString('base64'),
    },
  };
}

const SKIPPED_NODE_TYPES = new Set([
  'code',
  'inlineCode',
  'html',
  'definition',
  'yaml',
  'toml',
]);

interface CollectedImages {
  /** 直接图片与成功解析的引用式图片的 src。 */
  sources: string[];
  /** 解析器保留为 imageReference 但定义缺失的标识；必须报错而不是静默跳过。 */
  unresolved: string[];
}

/**
 * 收集 Markdown 图片引用：只按 AST 的 image / imageReference + definition。
 * 未定义定义的引用式图片会被标准 Markdown 解析为普通文本，读者也原样显示文字，
 * 因此这里不重新解释原文（不另造第二套内容解释，也避免把教材文字误判成图片）。
 */
function collectImageSources(body: string): CollectedImages {
  if (body.length === 0) return { sources: [], unresolved: [] };
  let tree: Root;
  try {
    tree = MARKDOWN_PARSER.parse(body) as Root;
  } catch {
    return { sources: [], unresolved: [] };
  }

  const definitions = new Map<string, string>();
  for (const child of tree.children) {
    if (child.type !== 'definition') continue;
    const url = child.url;
    if (typeof url === 'string' && url.trim().length > 0) {
      definitions.set(normalizeIdentifier(child.identifier), url);
    }
  }

  const sources: string[] = [];
  const unresolved: string[] = [];
  const stack: RootContent[] = [...tree.children];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    if (current.type === 'image') {
      if (typeof current.url === 'string' && current.url.trim().length > 0) sources.push(current.url);
      continue;
    }
    if (current.type === 'imageReference') {
      const identifier = normalizeIdentifier(current.identifier);
      const resolved = definitions.get(identifier);
      if (resolved === undefined) {
        unresolved.push(current.identifier.length > 0 ? current.identifier : '!' + current.alt);
      } else {
        sources.push(resolved);
      }
      continue;
    }
    if (current.type === 'definition') continue;
    if (SKIPPED_NODE_TYPES.has(current.type)) continue;
    const children = (current as { children?: RootContent[] }).children;
    if (Array.isArray(children)) for (const child of children) stack.push(child);
  }
  return { sources, unresolved };
}

/** mdast 的引用标识归一化：小写并折叠空白。 */
function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[\t\n\r ]+/g, ' ').trim();
}

/**
 * Markdown src → 工作区相对资源路径。
 * 仅接受 resources/ 下的相对引用；绝对路径、协议、越界与非 resources 前缀返回 null。
 */
export function resolveResourcePath(baseDir: string, rawSrc: string): string | null {
  let src = rawSrc.trim();
  if (src.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  if (src.startsWith('/') || src.startsWith('\\') || /^[a-z]:/i.test(src)) return null;

  src = src.replace(/[?#].*$/, '');
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    decoded = src;
  }
  decoded = decoded.replace(/\\/g, '/');

  // 先按主题文件目录解析（../resources/...），再回退到工作区根相对写法
  // （resources/...）；两种都只接受 resources/ 下的结果。
  const relativeToTopic = resolveSegments(baseDir, decoded);
  if (relativeToTopic !== null && relativeToTopic.startsWith('resources/')) return relativeToTopic;
  return resolveSegments('', decoded);
}

function resolveSegments(baseDir: string, src: string): string | null {
  const segments = [
    ...baseDir.split('/').filter((segment) => segment.length > 0 && segment !== '.'),
    ...src.split('/'),
  ];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    if (segment.includes('\u0000')) return null;
    resolved.push(segment);
  }
  if (resolved.length === 0) return null;
  if (resolved[0] !== 'resources') return null;
  return resolved.join('/');
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function dirnameRelative(relativePath: string): string {
  const segments = relativePath.split('/');
  segments.pop();
  return segments.join('/');
}

function detectMediaType(bytes: Uint8Array): CapturedResourceFile['mediaType'] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6) {
    const head = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0, bytes[5] ?? 0);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0) === 'RIFF' &&
    String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 构造共享 Diagnostic。共享类型没有 src 字段，不能额外塞入；
 * 引用原文只作为消息里的可读上下文（截断），资源位置放在 path。
 */
function errorAt(code: string, message: string, nodeId?: string, resourcePath?: string, src?: string): Diagnostic {
  const withSource = src === undefined ? message : message + '（引用: ' + truncateForMessage(src) + '）';
  return {
    code,
    message: withSource,
    severity: 'error',
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(resourcePath === undefined ? {} : { path: resourcePath }),
  };
}

function truncateForMessage(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 160 ? compact.slice(0, 157) + '...' : compact;
}

function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const item of items) {
    const key = [item.code, item.severity ?? '', item.nodeId ?? '', item.path ?? '', item.message].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
