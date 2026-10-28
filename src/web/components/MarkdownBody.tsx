import { useMemo } from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

/**
 * 协议 4 的正文链接只有两类稳定目标：
 * - '#anchor' 留在当前页面；
 * - 'aichat:node/<nodeId>' 指向同一工作区中的另一张卡片。
 * http(s) 外链在新窗口打开；相对路径、本地文件路径和其他协议一律拒绝。
 * 领域 DTO 不含源文件路径，因此这里不再把相对 .md 链接解释成文件。
 */
export type LinkTarget =
  | { kind: 'anchor'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'node'; nodeId: string }
  | { kind: 'blocked'; reason: string };

const EXTERNAL = /^https?:\/\//i;
const AICHAT = /^aichat:/i;
const NODE_LINK = /^aichat:node\/([^/?#\s]+)(?:#[^/?#\s]*)?$/i;
const BLOCKED_PROTOCOL = /^(javascript|data|vbscript|file|blob):/i;
const HAS_PROTOCOL = /^[a-z][a-z0-9+.-]*:/i;
/** 稳定节点 ID 只含这些字符；其他 aichat:node 目标按无效链接处理。 */
const NODE_ID = /^[A-Za-z0-9_-]+$/;
/** Only inline raster images may be rendered; SVG and other types never are. */
const SAFE_RASTER_DATA = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/i;
/** 同源资源 URL：以单个 '/' 开头的站内路径，不能变成协议或外部主机。 */
const SAME_ORIGIN = /^\/(?!\/)/;

/** decodeURIComponent that leaves malformed input untouched instead of throwing. */
function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolves a Markdown link found in a node body.
 *
 * Only 'aichat:node/<id>' may open another card. Anything that looks like a
 * workspace path (relative, absolute, drive letter) is refused: the domain
 * stores no source files, so such a link has no reader-side meaning.
 */
export function resolveLink(rawHref: string): LinkTarget {
  const href = rawHref.trim();
  if (href.length === 0) return { kind: 'blocked', reason: '空链接' };
  if (href.startsWith('#')) return { kind: 'anchor', href };
  if (BLOCKED_PROTOCOL.test(href)) return { kind: 'blocked', reason: '不允许的链接协议' };
  if (EXTERNAL.test(href)) return { kind: 'external', href };
  const nodeMatch = NODE_LINK.exec(href);
  if (nodeMatch !== null) {
    const nodeId = safeDecodeUri(nodeMatch[1] ?? '').trim();
    if (nodeId.length === 0 || !NODE_ID.test(nodeId)) {
      return { kind: 'blocked', reason: '节点链接缺少有效 ID' };
    }
    return { kind: 'node', nodeId };
  }
  if (AICHAT.test(href)) return { kind: 'blocked', reason: '不支持的 aichat 链接目标' };
  if (HAS_PROTOCOL.test(href)) return { kind: 'blocked', reason: '不允许的链接协议' };
  if (href.startsWith('/') || href.startsWith('\\') || /^[a-z]:/i.test(href)) {
    return { kind: 'blocked', reason: '不打开本地文件路径' };
  }
  return { kind: 'blocked', reason: '仅支持 aichat:node/<id> 形式的卡片链接' };
}

/**
 * react-markdown urlTransform.
 *
 * This runs before the renderers, so it must not discard what they need:
 * 'aichat:node/<id>' links, relative resource references and safe raster data
 * images are kept for the renderers to validate. Everything else dangerous is
 * emptied here.
 *
 * @param key the attribute being transformed ('href' for links, 'src' for images)
 */
export function safeUrlTransform(url: string, key?: string): string {
  const value = url.trim();
  if (value.length === 0) return '';
  if (value.startsWith('#') || value.startsWith('?')) return value;
  if (EXTERNAL.test(value) || /^mailto:/i.test(value) || AICHAT.test(value)) return value;
  if (value.startsWith('//')) return '';
  if (/^data:/i.test(value)) {
    // Only images may carry inline data, and only supported raster formats.
    return key === 'src' && SAFE_RASTER_DATA.test(value) ? value : '';
  }
  if (BLOCKED_PROTOCOL.test(value) || HAS_PROTOCOL.test(value)) return '';
  // Relative resource references: resolveLink()/resolveImageUrl() decide.
  return value;
}

interface ResourceReference {
  /** Decoded reference without query/fragment, backslashes normalized. */
  path: string;
  /** Same as path but before trailing punctuation cleanup. */
  decoded: string;
}

function parseResourceReference(rawSrc: string): ResourceReference | null {
  const src = rawSrc.trim();
  if (src.length === 0) return null;
  if (src.startsWith('//') || HAS_PROTOCOL.test(src)) return null;
  const decoded = safeDecodeUri(src).replace(/\\/g, '/');
  const path = (decoded.split(/[?#]/)[0] ?? '').replace(/[.,;:!?，。；：！？、》】"'`]+$/, '');
  if (path.length === 0) return null;
  return { path, decoded };
}

/**
 * Candidate resource keys for one Markdown image src, most specific first.
 *
 * Body references use workspace-relative keys such as 'resources/x.png'. A
 * reference written as '../resources/x.png' normalizes to the same key; anything
 * that does not stay below 'resources/' is not a resource reference at all.
 */
export function resourceKeyCandidates(rawSrc: string): string[] {
  const reference = parseResourceReference(rawSrc);
  if (reference === null) return [];
  const keys: string[] = [];
  const addFrom = (value: string): void => {
    const index = value.indexOf('resources/');
    if (index < 0) return;
    const tail = value.slice(index + 'resources/'.length);
    const segments = tail.split('/');
    if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return;
    const key = 'resources/' + segments.join('/');
    if (keys.length === 0 || keys[keys.length - 1] !== key) {
      if (!keys.includes(key)) keys.push(key);
    }
  };
  addFrom(reference.path);
  addFrom(reference.decoded);
  return keys;
}

/** Primary resource key for a Markdown image src, or null when it is not a key. */
export function resolveResourceKey(rawSrc: string): string | null {
  return resourceKeyCandidates(rawSrc)[0] ?? null;
}

/** Only raster data URIs and root-relative same-origin URLs may be rendered. */
function safeResourceUrl(value: string): string | null {
  const url = value.trim();
  if (url.length === 0) return null;
  if (SAFE_RASTER_DATA.test(url)) return url;
  if (SAME_ORIGIN.test(url) && !/[\\\u0000-\u001f]/.test(url)) return url;
  return null;
}

/**
 * Maps a Markdown image src to the rendered URL from the resource map.
 * The map comes from the same detail response as the body: live details carry
 * same-origin URLs, exported documents carry inline data URIs.
 */
export function resolveImageUrl(
  rawSrc: string,
  resources: Readonly<Record<string, string>> | undefined,
): string | null {
  if (resources === undefined) return null;
  for (const key of resourceKeyCandidates(rawSrc)) {
    const value = resources[key];
    if (typeof value !== 'string') continue;
    const safe = safeResourceUrl(value);
    if (safe !== null) return safe;
  }
  return null;
}

/**
 * Removes hidden node-id comments if a body still carries them.
 * Import already strips them; this is a display-level safety net.
 */
export function stripNodeComments(source: string): string {
  return source.replace(/<!--\s*node:[^>]*?-->/gi, '').replace(/\n{3,}/g, '\n\n');
}

export interface MarkdownBodyProps {
  source: string;
  /**
   * Opens the card referenced by 'aichat:node/<id>'. When omitted (offline
   * read-only contexts without another card) the link is rendered inert.
   */
  onOpenNode?: (nodeId: string) => void;
  /**
   * Resource map for the same detail response: Markdown src key (for example
   * 'resources/x.png') to a same-origin URL or raster data URI. An absent or
   * empty map shows an explicit placeholder instead of fetching anything.
   */
  resources?: Readonly<Record<string, string>>;
  compact?: boolean;
}

export function MarkdownBody({
  source,
  onOpenNode,
  resources,
  compact = false,
}: MarkdownBodyProps): React.JSX.Element {
  const components = useMemo<Components>(() => {
    const link: Components['a'] = ({ href, children }) => {
      const target = resolveLink(href ?? '');
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
      if (onOpenNode === undefined) {
        return (
          <span className="md-link-blocked" title="当前页面不能打开其他卡片">
            {children}
          </span>
        );
      }
      const nodeId = target.nodeId;
      return (
        <a
          href={'#'}
          onClick={(event) => {
            event.preventDefault();
            onOpenNode(nodeId);
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
      // 2. A resource key from the same detail response. react-markdown resolves
      // reference-style images to their final src, so both forms are covered.
      const resolved = resolveImageUrl(raw, resources);
      if (resolved !== null) {
        return <img src={resolved} alt={alt ?? ''} loading="lazy" className="md-image" />;
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
  }, [onOpenNode, resources]);

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
