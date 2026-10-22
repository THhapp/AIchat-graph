import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ExportError } from './errors.js';
import type { ReadReaderAssetsOptions, ReaderAssets } from './types.js';

/**
 * 默认从模块自身位置推导项目 dist/offline，而不是相对 cwd：CLI 可从项目外启动。
 * src/export 与 dist/export 向上两级都是项目根，再取 dist/offline。
 */
function defaultDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDirectory, '..', '..', 'dist', 'offline');
}

const CSS_IMPORT = /@import[^;}]*(?:;|})/i;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 离线读者必须完全自包含：CSS 内所有 url() 都是 data:，且没有 @import。
 * 不符合即拒绝导出，避免成品偷偷依赖旁边 assets 或 CDN。
 */
export function assertSelfContainedStyles(styles: string): void {
  if (CSS_IMPORT.test(styles)) {
    throw new ExportError('READER_ASSET_UNSAFE', 'reader.css 含 @import，未完全内联');
  }
  CSS_URL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSS_URL.exec(styles)) !== null) {
    const url = (match[2] ?? '').trim();
    if (url.length === 0) continue;
    if (!url.startsWith('data:')) {
      throw new ExportError('READER_ASSET_UNSAFE', 'reader.css 含未内联的 url(): ' + truncate(url));
    }
  }
}

/** 读取构建好的离线读者资源；不执行 Vite、不写任何文件。 */
export async function readReaderAssets(options: ReadReaderAssetsOptions = {}): Promise<ReaderAssets> {
  const directory = options.directory ?? defaultDirectory();
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new ExportError('READER_ASSETS_MISSING', '读者资源目录不能为空');
  }
  const absoluteDirectory = path.resolve(directory);
  const scriptPath = path.join(absoluteDirectory, 'reader.js');
  const stylesPath = path.join(absoluteDirectory, 'reader.css');

  const readFile = async (file: string): Promise<string> => {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new ExportError(
        'READER_ASSETS_MISSING',
        (code === 'ENOENT' ? '读者资源不存在: ' : '无法读取读者资源: ') + file,
        { cause: error, path: file },
      );
    }
  };

  const script = await readFile(scriptPath);
  const styles = await readFile(stylesPath);
  if (script.trim().length === 0) {
    throw new ExportError('READER_ASSETS_MISSING', 'reader.js 为空: ' + scriptPath, { path: scriptPath });
  }
  if (styles.trim().length === 0) {
    throw new ExportError('READER_ASSETS_MISSING', 'reader.css 为空: ' + stylesPath, { path: stylesPath });
  }
  // 脚本为 C 构建的可信 IIFE；其外部依赖由构建与真实 file:// 验收负责，
  // 这里只硬性约束 CSS 不得外链。
  assertSelfContainedStyles(styles);

  return {
    script,
    styles,
    buildFingerprint: sha256(script + '\u0000' + styles),
    directory: absoluteDirectory,
  };
}

function truncate(value: string): string {
  return value.length > 120 ? value.slice(0, 117) + '...' : value;
}
