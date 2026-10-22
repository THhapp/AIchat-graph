import { useMemo } from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

/**
 * Resolve a Markdown link found in a topic file.
 * - '#anchor' stays in the current card.
 * - external http(s) opens in the browser.
 * - relative '.md' links inside topics/ open the topic reader.
 * - everything else (javascript:, file:, absolute paths, '..' escapes) is refused.
 */
export type LinkTarget =
  | { kind: 'anchor'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'topic'; path: string }
  | { kind: 'blocked'; reason: string };

const EXTERNAL = /^https?:\/\//i;
const BLOCKED_PROTOCOL = /^(javascript|data|vbscript|file|blob):/i;
const HAS_PROTOCOL = /^[a-z][a-z0-9+.-]*:/i;
/** Only inline raster images may be rendered; SVG and other types never are. */
const SAFE_RASTER_DATA = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/i;

/** decodeURIComponent that leaves malformed input untouched instead of throwing. */
function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitFragment(href: string): [string, string] {
  const index = href.indexOf('#');
  if (index < 0) return [href, ''];
  return [href.slice(0, index), href.slice(index + 1)];
}

export function resolveLink(rawHref: string, topicPath: string): LinkTarget {
  const href = rawHref.trim();
  if (href.length === 0) return { kind: 'blocked', reason: '空链接' };
  if (href.startsWith('#')) return { kind: 'anchor', href };
  if (BLOCKED_PROTOCOL.test(href)) return { kind: 'blocked', reason: '不允许的链接协议' };
  if (EXTERNAL.test(href)) return { kind: 'external', href };
  if (HAS_PROTOCOL.test(href)) return { kind: 'blocked', reason: '不允许的链接协议' };
  if (href.startsWith('/') || href.startsWith('\\') || /^[a-z]:/i.test(href)) {
    return { kind: 'blocked', reason: '不打开工作区外或本地文件路径' };
  }

  const [rawPath = '', fragment = ''] = splitFragment(href);
  if (!rawPath.toLowerCase().endsWith('.md')) return { kind: 'blocked', reason: '仅支持工作区内主题文件链接' };
  const base = topicPath.split('/').slice(0, -1);
  const resolved: string[] = [];
  for (const segment of [...base, ...rawPath.split('/')]) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return { kind: 'blocked', reason: '链接超出工作区 topics 目录' };
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  const path = resolved.join('/');
  if (!path.startsWith('topics/')) return { kind: 'blocked', reason: '仅支持 topics/ 内的主题文件' };
  return { kind: 'topic', path: fragment.length > 0 ? path + '#' + fragment : path };
}

/**
 * react-markdown urlTransform.
 *
 * This runs before the renderers, so it must not discard what they need:
 * relative paths are kept intact for link resolution and resource lookup, and
 * safe raster data images are kept for the image renderer. Links never render a
 * data: URL, and images are re-checked when rendered.
 *
 * @param key the attribute being transformed ('href' for links, 'src' for images)
 */
export function safeUrlTransform(url: string, key?: string): string {
  const value = url.trim();
  if (value.length === 0) return '';
  if (value.startsWith('#') || value.startsWith('?')) return value;
  if (EXTERNAL.test(value) || /^mailto:/i.test(value)) return value;
  if (value.startsWith('//')) return '';
  if (/^data:/i.test(value)) {
    // Only images may carry inline data, and only supported raster formats.
    return key === 'src' && SAFE_RASTER_DATA.test(value) ? value : '';
  }
  if (BLOCKED_PROTOCOL.test(value) || HAS_PROTOCOL.test(value)) return '';
  // Relative workspace paths: resolveLink() and resolveResourceKey() decide.
  return value;
}

/**
 * Maps a Markdown image src to the key used by the frozen resource map.
 * Resolves relative to the node's own file, accepts a root-relative fallback,
 * and refuses escapes above the workspace root.
 */
export function resolveResourceKey(rawSrc: string, nodePath: string): string | null {
  const src = rawSrc.trim();
  if (src.length === 0) return null;
  if (src.startsWith('//') || HAS_PROTOCOL.test(src)) return null;
  // react-markdown percent-encodes some characters; decode before matching the
  // capture-side key so "图（1）.png" and "my pic.png" still resolve.
  const decoded = safeDecodeUri(src);
  const normalized = decoded.replace(/\\/g, '/');
  const base = nodePath.split('/').slice(0, -1);
  const segments = normalized.startsWith('/') ? normalized.slice(1).split('/') : [...base, ...normalized.split('/')];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.length === 0 ? null : resolved.join('/');
}

/**
 * Removes hidden node-id comments if a service ever sends them in body text.
 * The parser should already strip them; this is a display-level safety net.
 */
export function stripNodeComments(source: string): string {
  return source.replace(/<!--\s*node:[^>]*?-->/gi, '').replace(/\n{3,}/g, '\n\n');
}

export interface MarkdownBodyProps {
  source: string;
  /**
   * Workspace-relative path of the node this body belongs to. Format 2 stores one
   * node per file, so relative links resolve against this path, not a topic file.
   */
  topicPath: string;
  onOpenTopic: (path: string) => void;
  /**
   * Resolves a workspace-relative .md path to a stable node id. When it returns an
   * id, the reader opens that card instead of navigating to a file path.
   */
  resolvePathToNode?: (path: string) => string | null;
  onOpenNode?: (nodeId: string) => void;
  /**
   * Resource map (Markdown src key → data URI) for offline exports and live details.
   * An empty map means images are not available and are shown as placeholders.
   */
  resources?: Readonly<Record<string, string>>;
  compact?: boolean;
}

export function MarkdownBody({
  source,
  topicPath,
  onOpenTopic,
  resolvePathToNode,
  onOpenNode,
  resources,
  compact = false,
}: MarkdownBodyProps): React.JSX.Element {
  const components = useMemo<Components>(() => {
    const link: Components['a'] = ({ href, children }) => {
      const target = resolveLink(href ?? '', topicPath);
      if (target.kind === 'blocked') {
        return (
          <span className="md-link-blocked" title={target.reason}>
            {children}
          </span>
        );
      }
      if (target.kind === 'anchor') return <a href={target.href}>{children}</a>;
      if (target.kind === 'external') {
        return (
          <a href={target.href} target="_blank" rel="noopener noreferrer nofollow">
            {children}
            <span className="visually-hidden">（在新窗口打开）</span>
          </a>
        );
      }
      const path = target.path;
      // A #fragment identifies a position inside the target, not part of its path.
      const cleanPath = path.split('#')[0] ?? path;
      const nodeId = resolvePathToNode?.(cleanPath) ?? null;
      return (
        <a
          href={'#'}
          onClick={(event) => {
            event.preventDefault();
            if (nodeId !== null && onOpenNode !== undefined) onOpenNode(nodeId);
            else onOpenTopic(path);
          }}
        >
          {children}
        </a>
      );
    };
    const image: Components['img'] = ({ src, alt }) => {
      const raw = typeof src === 'string' ? src.trim() : '';
      // 1. Inline raster data images already in the Markdown.
      if (SAFE_RASTER_DATA.test(raw)) {
        return <img src={raw} alt={alt ?? ''} loading="lazy" className="md-image" />;
      }
      // 2. A captured resource, resolved relative to this node's file.
      // react-markdown resolves reference-style images to their final src, so this
      // covers both inline and ![alt][ref] forms without special cases.
      const key = raw === '' ? null : resolveResourceKey(raw, topicPath);
      let dataUri = key !== null ? resources?.[key] : undefined;
      if (dataUri === undefined) {
        // Fall back to the raw src as captured, for keys stored with their literals.
        const literal = raw.replace(/^\.\//, '');
        dataUri = resources?.[literal] ?? resources?.[safeDecodeUri(literal)];
      }
      if (dataUri !== undefined && SAFE_RASTER_DATA.test(dataUri)) {
        return <img src={dataUri} alt={alt ?? ''} loading="lazy" className="md-image" />;
      }
      // 3. Anything else is never fetched: no network request, no arbitrary file.
      return (
        <span className="md-image-blocked" role="note">
          [图片未显示{alt !== undefined && alt !== '' ? '：' + alt : ''}]
        </span>
      );
    };
    const table: Components['table'] = ({ children }) => (
      <div className="md-table-wrap">
        <table>{children}</table>
      </div>
    );
    return { a: link, img: image, table };
  }, [topicPath, onOpenTopic, resolvePathToNode, onOpenNode, resources]);

  return (
    <div className={compact ? 'md-body md-body--compact' : 'md-body'}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        // output:'html' is a shared choice for live and offline readers: MathML is not a
        // product requirement, and it keeps the reader bundle free of a second rendering
        // path. The original TeX stays in the Markdown/export payload untouched.
        rehypePlugins={[[rehypeKatex, { output: 'html', throwOnError: false, strict: false, trust: false }]]}
        skipHtml
        urlTransform={safeUrlTransform}
        components={components}
      >
        {stripNodeComments(source)}
      </Markdown>
    </div>
  );
}