/**
 * Index 模块的纯数据契约：manifest 与进程内检索索引。
 *
 * manifest 是派生数据，不包含正文全文；只保存节点定位、结构、链接与文件哈希。
 * 检索索引在内存中保存本次有效快照的正文，用于 Unicode 子串检索，不落库。
 */
import type { ParsedNode, WorkspaceGraph } from "../core/index.js";
import type { SearchField, SearchHit } from "../shared/protocol.js";

export const INDEX_FORMAT = 1 as const;

/** 构建索引时的主题来源；fileHash 必须来自同一份扫描结果。 */
export interface IndexTopicSource {
  readonly topicId: string;
  readonly path: string;
  /** 主题入口文件（topic.md）的原始字节哈希。 */
  readonly fileHash: string;
  readonly nodes: readonly ParsedNode[];
  /** 可选：该主题全部真实源文件；缺省为 [path]。 */
  readonly sourcePaths?: readonly string[] | undefined;
  /** 可选：源路径 → 原始字节哈希；缺省只用 { path: fileHash }。 */
  readonly fileHashes?: Readonly<Record<string, string>> | undefined;
}

export interface IndexSource {
  readonly workspaceId: string;
  readonly graph: WorkspaceGraph;
  readonly topics: readonly IndexTopicSource[];
  /** 便于确定性测试与缓存；默认取当前时间。 */
  readonly generatedAt?: string | undefined;
}

export interface ManifestNode {
  readonly id: string;
  readonly topicId: string;
  /** 主题入口路径（topic.md）。 */
  readonly topicPath: string;
  /** 节点真实来源文件（该节点自己的 Markdown）。 */
  readonly sourcePath: string;
  readonly title: string;
  readonly summary: string;
  /** 连接来源的说明；root 节点缺省。 */
  readonly description?: string | undefined;
  readonly state: string;
  readonly flow: string;
  readonly from: string | null;
  readonly side?: string | undefined;
  readonly order?: number | undefined;
  /** 派生展示编号，不用于引用。 */
  readonly number: string;
  readonly nextId: string | null;
  readonly branchIds: readonly string[];
}

export interface ManifestTopic {
  readonly topicId: string;
  readonly title: string;
  readonly path: string;
  /** 主题入口文件的哈希。 */
  readonly fileHash: string;
  /** 该主题全部真实源文件（含入口）。 */
  readonly sourcePaths: readonly string[];
  /** 源路径 → 原始字节哈希，覆盖入口与每个节点文件。 */
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly nodeIds: readonly string[];
}

/** 一条 from → to 的结构连接；flow 为 to 的布局角色。 */
export interface ManifestLink {
  readonly from: string;
  readonly to: string;
  readonly flow: "next" | "branch";
}

export interface IndexManifest {
  readonly format: typeof INDEX_FORMAT;
  readonly workspaceId: string;
  readonly generatedAt: string;
  /** 工作区相对路径 → 本次扫描的原始字节 SHA-256。 */
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly topics: readonly ManifestTopic[];
  readonly nodes: readonly ManifestNode[];
  readonly links: readonly ManifestLink[];
  /** 反向引用：nodeId → 以它为 from 的子节点 ID（next 与 branch，按 manifest 节点顺序）。 */
  readonly backlinks: Readonly<Record<string, readonly string[]>>;
  /** root 节点 ID；空工作区为空数组。 */
  readonly roots: readonly string[];
}

/** 检索用文档；body 来自有效快照，保证详情与检索同一版本。 */
export interface SearchDocument {
  readonly id: string;
  readonly topicId: string;
  readonly title: string;
  readonly summary: string;
  readonly number: string;
  /** 节点真实来源文件；搜索命中的是这份文件。 */
  readonly path: string;
  readonly body: string;
}

export interface SearchIndex {
  readonly format: typeof INDEX_FORMAT;
  readonly workspaceId: string;
  readonly documents: readonly SearchDocument[];
}

/** 一次检索的结果窗口；totalHits 是排序后的全部命中数。 */
export interface SearchOutcome {
  readonly hits: SearchHit[];
  readonly totalHits: number;
  readonly truncated: boolean;
}

/** searchDocuments 的窗口选项；缺省 limit 返回 offset 之后的全部命中。 */
export interface SearchDocumentsOptions {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** 索引构建结果；manifest 可写缓存，search 只留在进程内。 */
export interface BuiltIndex {
  readonly manifest: IndexManifest;
  readonly search: SearchIndex;
}

export type { SearchField, SearchHit };