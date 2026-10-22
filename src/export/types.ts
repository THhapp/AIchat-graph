/**
 * export 模块的对外契约：资源捕获与安全单 HTML 封装。
 *
 * 共享 DTO（OfflineTopicDocument、Diagnostic）由 src/shared/protocol.ts 定义，
 * 这里只导入，不复制长期类型。本模块不实现读者、Markdown 渲染或布局，
 * 也不在运行时执行 Vite。
 */
import type {
  Diagnostic,
  OfflineTopicDocument,
  SnapshotVersion,
} from '../shared/protocol.js';

export const EXPORT_FORMAT_VERSION = 1;
/** 离线数据容器 ID，与 web/offline 读者约定冻结。 */
export const EXPORT_DATA_ELEMENT_ID = 'aichat-export-data';
export const DEFAULT_MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_RESOURCE_BYTES = 32 * 1024 * 1024;

export type ExportErrorCode =
  | 'EXPORT_DOCUMENT_INVALID'
  | 'EXPORT_READER_INVALID'
  | 'READER_ASSETS_MISSING'
  | 'READER_ASSET_UNSAFE'
  | 'WORKSPACE_ROOT_INVALID'
  | string;

/** captureResources 的最小输入；B1 的节点详情可直接结构化传入。 */
export interface ExportResourceNode {
  id?: string;
  /** 工作区相对主题文件路径，用于解析正文中的相对图片引用。 */
  path: string;
  body: string;
}

export interface CaptureResourcesOptions {
  /** 单件上限，默认 8 MiB。 */
  maxFileBytes?: number;
  /** 总量上限（文件 + 内联 data 图片），默认 32 MiB。 */
  maxTotalBytes?: number;
  /** 可选的快照身份；原样回传到 ResourceCapture.snapshot，供防旧写核对。 */
  snapshot?: SnapshotVersion | null;
}

export interface CapturedResourceFile {
  /** 归一化工作区相对路径（'/' 分隔），同时作为 resources 的键。 */
  path: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  byteLength: number;
  sha256: string;
  dataUri: string;
}

export interface CapturedDataImage {
  sha256: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  byteLength: number;
  /** 同一字节内容被引用的次数。 */
  count: number;
}

export interface ResourceReference {
  nodeId?: string;
  src: string;
  kind: 'workspace' | 'data';
  /** workspace: 归一化资源路径；data: 内容 sha256。 */
  key: string;
}

export interface ResourceCapture {
  /** 归一化工作区相对资源路径 → data: URI，直接放入 OfflineTopicDocument.resources。 */
  resources: Record<string, string>;
  /** 资源字节事实（供指纹与防旧写核对）；比 B1 需求多带类型/长度/dataUri。 */
  files: CapturedResourceFile[];
  dataImages: CapturedDataImage[];
  /** src → 资源键，供读者实现与诊断使用。 */
  references: ResourceReference[];
  /** 共享 Diagnostic；severity='error' 时 ok=false。 */
  diagnostics: Diagnostic[];
  totalBytes: number;
  /** false ⇔ 存在 severity='error' 的诊断（调用方应把导出状态置 error）。 */
  ok: boolean;
  /** 一次捕获对应的快照身份（调用方提供时原样回传）。 */
  snapshot: SnapshotVersion | null;
}

/**
 * 内容指纹与渲染使用的结构化子集；完整 OfflineTopicDocument 可直接传入。
 * 保留完整文档原样序列化，不复制共享 DTO 的长期定义。
 */
export interface ExportDocumentLike {
  format: number;
  workspaceId: string;
  /** 内容指纹；必须等于 computeContentFingerprint(document)。 */
  fingerprint: string;
  topic: { id: string; title: string };
  workspaceName?: unknown;
  nodes?: unknown;
  boundaryNodes?: unknown;
  resources?: Record<string, string> | unknown;
  resourceDiagnostics?: unknown;
}

export interface RenderTopicHtmlInput {
  /** 完整冻结传输文档；原样整体嵌入，不裁剪、不按折叠/过滤删减。 */
  document: OfflineTopicDocument;
  /** dist/offline/reader.js 的完整内容（独立 IIFE）。 */
  readerScript: string;
  /** dist/offline/reader.css 的完整内容（所有 url 已内联）。 */
  readerStyles: string;
}

export interface ExportFingerprints {
  /** 内容指纹：文档自带的 fingerprint（快照源内容）。 */
  contentFingerprint: string;
  /** 读者构建指纹：sha256(readerScript + '\0' + readerStyles)。 */
  readerFingerprint: string;
  /** 成品指纹：内容 + 读者 + 导出格式版本。 */
  exportFingerprint: string;
}

export interface ExportMarkers {
  format: number;
  workspaceId: string;
  topicId: string;
  contentFingerprint: string;
  readerFingerprint: string;
  exportFingerprint: string;
}

export interface ReaderAssets {
  script: string;
  styles: string;
  buildFingerprint: string;
  directory: string;
}

export interface ReadReaderAssetsOptions {
  /** 默认 dist/offline（相对当前工作目录）；也可传绝对路径。 */
  directory?: string;
}