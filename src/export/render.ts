import { createHash } from 'node:crypto';
import { ExportError } from './errors.js';
import {
  EXPORT_DATA_ELEMENT_ID,
  EXPORT_FORMAT_VERSION,
  type ExportDocumentLike,
  type ExportFingerprints,
  type ExportMarkers,
  type RenderTopicHtmlInput,
} from './types.js';

/**
 * 资源键只要求是规范的工作区相对路径：无绝对前缀/盘符、无控制字符、
 * 无 "."/".."/空段、无反斜杠；正常的 Unicode、空格与标点（如「图（1）.png」）允许。
 * 这些名称只进入 JSON 数据，不进可执行代码，安全性由数据块转义保证。
 */
function isSafeResourceKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (key.startsWith('/') || key.startsWith('\\') || /^[a-z]:/i.test(key)) return false;
  if (key.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  return key.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
const DATA_IMAGE_URI = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

/** 参与内容指纹的字段；运行字段（fingerprint/generatedAt/instanceId/revision）不参与。 */
const CONTENT_FIELDS = [
  'format',
  'workspaceId',
  'workspaceName',
  'topic',
  'nodes',
  'boundaryNodes',
  'resources',
  'resourceDiagnostics',
] as const;

/**
 * 稳定 JSON 序列化：对象键按字典序，省略 undefined。
 * 同一内容不因对象键插入顺序不同而产生不同指纹。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(record[key])).join(',') + '}';
  }
  return 'null';
}

/**
 * 内容指纹：只覆盖冻结内容字段，不含 fingerprint 自身、generatedAt、
 * instanceId、revision 等运行字段。重启或无关主题发布不会改变它。
 */
export function computeContentFingerprint(document: ExportDocumentLike): string {
  if (typeof document !== 'object' || document === null) {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', 'document 必须是对象');
  }
  const record = document as unknown as Record<string, unknown>;
  const content: Record<string, unknown> = {};
  for (const field of CONTENT_FIELDS) content[field] = record[field];
  return sha256(stableStringify(content));
}

/** 转义为可安全放进 <script type="application/json"> 的文本。 */
export function escapeJsonForHtml(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 转义 HTML 属性/文本，避免标题等字段破坏文档结构。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 计算成品指纹。
 * - contentFingerprint 由内容字段独立计算，不读 document.fingerprint。
 * - readerFingerprint 覆盖脚本与样式，读者构建变化即需重新导出。
 * - exportFingerprint 是内容 + 读者 + 导出格式版本的组合，供本机记录判断构建升级。
 */
export function computeExportFingerprints(input: RenderTopicHtmlInput): ExportFingerprints {
  const contentFingerprint = computeContentFingerprint(input.document);
  const documentFingerprint = input.document.fingerprint;
  if (
    typeof documentFingerprint === 'string' &&
    documentFingerprint.length > 0 &&
    documentFingerprint !== contentFingerprint
  ) {
    throw new ExportError(
      'EXPORT_DOCUMENT_INVALID',
      'document.fingerprint 与当前内容指纹不一致；请先用 computeContentFingerprint 填充',
    );
  }
  const readerFingerprint = sha256(input.readerScript + '\u0000' + input.readerStyles);
  const exportFingerprint = sha256(
    contentFingerprint + '\u0000' + readerFingerprint + '\u0000' + String(EXPORT_FORMAT_VERSION),
  );
  return { contentFingerprint, readerFingerprint, exportFingerprint };
}

/**
 * 封装单文件离线 HTML。只使用传入的冻结文档与已构建的读者资源，
 * 不读取当前 UI、磁盘正文或目标文件。
 */
export function renderTopicHtml(input: RenderTopicHtmlInput): string {
  const document = validateDocument(input.document);
  const readerScript = input.readerScript;
  const readerStyles = input.readerStyles;
  if (typeof readerScript !== 'string' || readerScript.trim().length === 0) {
    throw new ExportError('EXPORT_READER_INVALID', 'readerScript 不能为空');
  }
  if (typeof readerStyles !== 'string' || readerStyles.trim().length === 0) {
    throw new ExportError('EXPORT_READER_INVALID', 'readerStyles 不能为空');
  }

  const fingerprints = computeExportFingerprints({ document: input.document, readerScript, readerStyles });
  const json = escapeJsonForHtml(JSON.stringify(document));
  const scriptDataUri = 'data:text/javascript;base64,' + Buffer.from(readerScript, 'utf8').toString('base64');
  const title = escapeHtml(document.topic.title.length > 0 ? document.topic.title : '思想图');

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="aichat-export-format" content="' + String(EXPORT_FORMAT_VERSION) + '">',
    '<meta name="aichat-export-workspace" content="' + escapeHtml(document.workspaceId) + '">',
    '<meta name="aichat-export-topic" content="' + escapeHtml(document.topic.id) + '">',
    '<meta name="aichat-export-content-sha256" content="' + escapeHtml(fingerprints.contentFingerprint) + '">',
    '<meta name="aichat-export-reader-sha256" content="' + escapeHtml(fingerprints.readerFingerprint) + '">',
    '<meta name="aichat-export-sha256" content="' + escapeHtml(fingerprints.exportFingerprint) + '">',
    '<title>' + title + ' · 离线阅读</title>',
    '<style>' + readerStyles + '</style>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    '<noscript><p>离线阅读需要启用 JavaScript。</p></noscript>',
    '<script id="' + EXPORT_DATA_ELEMENT_ID + '" type="application/json">' + json + '</script>',
    '<script src="' + scriptDataUri + '"></script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** 读取本模块写入的导出标记；不属于本产品时返回 null。 */
export function readExportMarkers(html: string): ExportMarkers | null {
  if (typeof html !== 'string' || html.length === 0) return null;
  const read = (name: string): string | null => {
    const pattern = new RegExp('<meta\\s+name="' + name + '"\\s+content="([^"]*)"', 'i');
    const match = pattern.exec(html);
    return match?.[1] ?? null;
  };
  const format = read('aichat-export-format');
  const workspaceId = read('aichat-export-workspace');
  const topicId = read('aichat-export-topic');
  const contentFingerprint = read('aichat-export-content-sha256');
  const readerFingerprint = read('aichat-export-reader-sha256');
  const exportFingerprint = read('aichat-export-sha256');
  if (
    format === null ||
    workspaceId === null ||
    topicId === null ||
    contentFingerprint === null ||
    readerFingerprint === null ||
    exportFingerprint === null
  ) {
    return null;
  }
  const formatNumber = Number.parseInt(format, 10);
  if (!Number.isFinite(formatNumber)) return null;
  return {
    format: formatNumber,
    workspaceId: decodeEntities(workspaceId),
    topicId: decodeEntities(topicId),
    contentFingerprint: decodeEntities(contentFingerprint),
    readerFingerprint: decodeEntities(readerFingerprint),
    exportFingerprint: decodeEntities(exportFingerprint),
  };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function validateDocument(document: ExportDocumentLike): ExportDocumentLike {
  if (typeof document !== 'object' || document === null) {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', 'document 必须是对象');
  }
  if (document.format !== 1) {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', '不支持的导出文档 format: ' + String(document.format));
  }
  if (typeof document.workspaceId !== 'string' || document.workspaceId.length === 0) {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', 'document.workspaceId 不能为空');
  }
  if (typeof document.fingerprint !== 'string' || document.fingerprint.length === 0) {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', 'document.fingerprint 不能为空');
  }
  if (typeof document.topic !== 'object' || document.topic === null) {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', 'document.topic 必须是对象');
  }
  if (typeof document.topic.id !== 'string' || document.topic.id.length === 0) {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', 'document.topic.id 不能为空');
  }
  if (typeof document.topic.title !== 'string') {
    throw new ExportError('EXPORT_DOCUMENT_INVALID', 'document.topic.title 必须是字符串');
  }
  const resources: unknown = document.resources;
  if (resources !== undefined && resources !== null) {
    if (typeof resources !== 'object' || Array.isArray(resources)) {
      throw new ExportError('EXPORT_DOCUMENT_INVALID', 'document.resources 必须是对象');
    }
    for (const [key, value] of Object.entries(resources as Record<string, unknown>)) {
      if (!isSafeResourceKey(key)) {
        throw new ExportError('EXPORT_DOCUMENT_INVALID', '资源键不是安全的工作区相对路径: ' + key);
      }
      if (typeof value !== 'string' || !DATA_IMAGE_URI.test(value)) {
        throw new ExportError('EXPORT_DOCUMENT_INVALID', '资源值必须是受支持图片的 data URI: ' + key);
      }
    }
  }
  return document;
}
