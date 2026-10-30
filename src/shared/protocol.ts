/**
 * AIchat-graph HTTP / SSE transport DTO.
 *
 * Type-only: this module must not add runtime values, dependencies, AST objects,
 * file handles or storage details. It is the wire contract shared by service,
 * CLI and web; core schema stays the authority for validation.
 *
 * Conventions
 * - Paths are workspace-relative, always '/' separated.
 * - fileHash is SHA-256 of the raw file bytes (hex).
 * - Snapshot identity is { instanceId, revision }; a new service instance gets a
 *   new instanceId, and every accepted snapshot increments revision.
 * - Source offsets are UTF-16 offsets into the decoded file text, half-open
 *   [offset, endOffset).
 */

/** Effective snapshot identity. */
export interface SnapshotVersion {
  instanceId: string;
  revision: number;
}

/** Query parameters for consistent reads: details must be served from this snapshot. */
export interface SnapshotQuery {
  instanceId: string;
  revision: number;
}

/** Connection role of a node inside the layout. */
export type NodeFlow = 'root' | 'next' | 'branch';

export type BranchSide = 'left' | 'right';

/** Lightweight graph node: no coordinates, no full body. */
export interface GraphNode {
  id: string;
  topicId: string;
  title: string;
  /** Explicit meta summary, or the first body paragraph truncated to 120 code points. */
  summary: string;
  /** Display-only numbering (e.g. "06-02-01"); it changes with structure, never used as an ID. */
  number: string;
  from: string | null;
  flow: NodeFlow;
  /**
   * branch only; present only when the source record declares a side explicitly.
   * Absent means "the source did not choose"; the reading side picks the side.
   */
  side?: BranchSide;
  /** branch only; integer ordering among siblings of the same source. */
  order?: number;
  /**
   * Important flag: "worth attention", nothing else. It never affects numbering,
   * connection or order, and defaults to false for sources without the field.
   */
  important: boolean;
  /**
   * Why this node connects to its source; the only connection text.
   */
  description?: string;
  /**
   * Real source file of this node (its own Markdown). Lets readers resolve
   * relative links in the node body.
   */
  sourcePath?: string;
}

export interface GraphTopic {
  id: string;
  title: string;
  /** Workspace-relative path of the topic metadata file (topic.md). */
  path: string;
  /** Nodes of this topic in the effective snapshot; reading order comes from topic detail. */
  nodeIds: string[];
  /** SHA-256 of the declared topic metadata file bytes (topic.md). */
  fileHash: string;
  /**
   * SHA-256 over every real source file of this topic (metadata + node files).
   * Detail pages and exports use it to detect any topic-level source change.
   */
  contentHash?: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  severity?: 'error' | 'warning' | 'info';
  /** Workspace-relative path when the diagnostic belongs to a file. */
  path?: string;
  topicId?: string;
  nodeId?: string;
  /** 1-based line / UTF-16 column when known. */
  line?: number;
  column?: number;
  /** UTF-16 offsets, half-open. */
  offset?: number;
  endOffset?: number;
}

/**
 * 程序身份：程序名、接口版本与构建清单。只在 Node 侧（CLI/service）产生，
 * web 不 import 构建清单模块。
 */
export interface ProgramInfo {
  program: 'aichat-graph';
  version: string;
  interfaceVersion: number;
  buildId: string;
  commit: string | null;
  builtAt: string | null;
  manifest?: 'dist' | 'dev' | 'invalid';
}

/** GET /api/workspace */
export interface WorkspaceResponse extends SnapshotVersion {
  /** 服务新版必须返回；旧服务缺失时 CLI 按接口不匹配处理。 */
  program?: ProgramInfo;
  agentEntry?: { cliPath: string; skillPath: string };
  workspaceId: string;
  name: string;
  rootPath: string;
  activeNode: string | null;
  /** true when the effective snapshot is the last valid one and the disk content is invalid/unreadable. */
  stale: boolean;
  diagnostics: Diagnostic[];
}

/**
 * Nodes whose source file was created or actually rewritten by a topic's latest
 * successful commit. View-only actions, numbering, revisions, exports and reads
 * never replace it; a failed or rolled-back commit never produces one.
 */
export interface LastChange {
  /** ISO timestamp of the accepted commit. */
  at: string;
  nodeIds: string[];
}

/** GET /api/graph */
export interface GraphResponse extends SnapshotVersion {
  workspaceId: string;
  activeNode: string | null;
  stale: boolean;
  diagnostics: Diagnostic[];
  nodes: GraphNode[];
  topics: GraphTopic[];
  /**
   * Latest content change per stable topicId. A change in one topic never
   * replaces another topic's record. Absent when no topic has a record.
   */
  lastChanges?: Record<string, LastChange>;
}

/** GET /api/topics */
export interface TopicsResponse extends SnapshotVersion {
  topics: GraphTopic[];
}

/** GET /api/nodes/:id?instanceId=&revision= */
export interface NodeDetailResponse extends SnapshotVersion {
  node: GraphNode;
  /** Markdown body of the effective snapshot, hidden node-id comment removed. */
  body: string;
  topicId: string;
  /** Workspace-relative path of the source topic file. */
  path: string;
  fileHash: string;
}

/** Node entry inside topic detail; body is included so a whole topic reads in one request. */
export interface TopicNodeDetail extends GraphNode {
  body: string;
  /** Workspace-relative path of this node's real source file. */
  path: string;
  /** SHA-256 of that source file's raw bytes. */
  fileHash: string;
}

/**
 * Which bytes the detail describes. With instanceId+revision the service answers
 * from that effective snapshot; without them it reads the real disk file. The web
 * reader always sends the snapshot version, so a disk hash is never attached to
 * snapshot raw text.
 */
export type DetailSource = 'snapshot' | 'disk';

/**
 * GET /api/topics/:id?instanceId=&revision=
 * - with version: snapshot topic, nodes and hash of the effective snapshot.
 * - without version: real disk bytes; if the file is invalid, valid=false and
 *   nodes may be empty while diagnostics explain why.
 */
export interface TopicDetailResponse extends SnapshotVersion {
  source: DetailSource;
  valid: boolean;
  topic: GraphTopic;
  /** Raw text matched by fileHash for the stated source. */
  raw: string;
  fileHash: string;
  /** Nodes in original file order (the topic reading order). */
  nodes: TopicNodeDetail[];
  diagnostics: Diagnostic[];
}

/**
 * POST /api/importance — flip a node's important flag.
 *
 * Only this one metadata field changes; body editing stays on the write channel.
 * expectedHash is the SHA-256 of the node source bytes the caller actually saw;
 * when supplied and no longer current the request fails with 412.
 */
export interface ImportanceRequest {
  topicId: string;
  nodeId: string;
  important: boolean;
  expectedHash?: string | undefined;
}

export interface ImportanceResponse extends SnapshotVersion {
  ok: true;
  /** Node as it exists in the published snapshot. */
  node: GraphNode;
}

export type SearchField = 'title' | 'summary' | 'body';

export interface SearchHit {
  nodeId: string;
  topicId: string;
  title: string;
  /** Workspace-relative topic path. */
  path: string;
  /** Short excerpt around the match. */
  snippet: string;
  field: SearchField;
}

/** GET /api/search?q= */
export interface SearchResponse extends SnapshotVersion {
  query: string;
  hits: SearchHit[];
  truncated: boolean;
}

/** GET /api/diagnostics */
export interface DiagnosticsResponse extends SnapshotVersion {
  stale: boolean;
  diagnostics: Diagnostic[];
}

/** SSE event names are 'snapshot' and 'diagnostics'. */
export interface SnapshotEvent extends SnapshotVersion {
  event: 'snapshot';
  changedTopicIds: string[];
  changedNodeIds: string[];
  stale: boolean;
}

export interface DiagnosticsEvent extends SnapshotVersion {
  event: 'diagnostics';
  diagnostics: Diagnostic[];
}

export type ServerEvent = SnapshotEvent | DiagnosticsEvent | ExportEvent;

/** Known 4xx/5xx codes. Services may add codes; clients must handle unknown codes generically. */
export type KnownApiErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'STALE_SNAPSHOT'
  | 'VERSION_CONFLICT'
  | 'OPERATION_CONFLICT'
  | 'VALIDATION_FAILED'
  | 'UNKNOWN_CHANGE'
  | 'INTERNAL';

/** Every error response body: { error: { code, message } }. */
export interface ApiErrorResponse {
  error: {
    code: KnownApiErrorCode | string;
    message: string;
    diagnostics?: Diagnostic[];
    /** Machine-readable payload for conflicts (hashes, missingFiles, ...). */
    details?: unknown;
  };
}

/* ------------------------------------------------------------------ *
 * Bounded agent read + instance-bound edit credentials
 * ------------------------------------------------------------------ */

/** UTF-16 range of a returned body fragment; start/end are into the real source body. */
export interface AgentReadRange {
  start: number;
  end: number;
  total: number;
  unit: 'utf16';
}

/**
 * Optional section locator; start/end are UTF-16 offsets into the node body.
 * `index` is this heading's 0-based position among all headings in the body
 * (fenced code is not a heading), not the same-title match index accepted by
 * the read query's `section-index` parameter.
 */
export interface AgentSection {
  /** 0-based order of this heading among all headings in the node body. */
  index: number;
  title: string;
  level: number;
  start: number;
  end: number;
}

/**
 * Instance-bound write credential issued by a real read.
 * It binds workspace, topic, node, real source path, the byte hash actually read,
 * and the snapshot version. After restart or source change it must be rejected;
 * display numbers are never used to relocate a node.
 */
export interface AgentEditRef {
  /** Opaque token sent back with a later agent request. */
  ref: string;
  workspaceId: string;
  topicId: string;
  nodeId: string;
  /** Workspace-relative path of the node's real source file. */
  path: string;
  /** SHA-256 of the source bytes at read time. */
  fileHash: string;
  instanceId: string;
  revision: number;
  issuedAt: string;
}

/** GET /api/agent/nodes/:id?start=&length=&full= */
export interface AgentNodeReadResponse extends SnapshotVersion {
  workspaceId: string;
  node: GraphNode;
  /** Requested fragment of the node body; full body only with full=true. */
  body: string;
  /** true 表示只返回元数据与 editRef，正文被明确省略（meta=true）。 */
  bodyOmitted?: boolean;
  range: AgentReadRange;
  truncated: boolean;
  /** Real source file of this node (its own Markdown). */
  path: string;
  fileHash: string;
  /** Topic metadata file (topic.md). */
  topicPath: string;
  editRef: AgentEditRef;
  /** The last section containing range.start, when headings exist. */
  section: AgentSection | null;
}

/** One literal replacement; old must be non-empty and match exactly once. */
export interface AgentReplace {
  old: string;
  new: string;
}

/**
 * 一次编辑：内容、入边说明／来源与重要性可组合给出，服务端编译成同一事务。
 * 正文模式（replace／append／body）仍互斥。
 */
export interface AgentPatchNodeAction {
  action: 'patchNode';
  editRef: string;
  title?: string;
  /** null removes an explicit summary. */
  summary?: string | null;
  replace?: AgentReplace[];
  append?: string;
  body?: string;
  /** 显式翻转重要标记；仅此项时不替换最近内容更新。 */
  important?: boolean;
  /** 现有入边的说明；只改说明时单独给。 */
  description?: string;
  /** 明确改来源时使用；必须与 flow、description 同用。 */
  fromRef?: string;
  /** 只改关系类型时保留当前来源；root 节点不接受任何入边字段。 */
  flow?: 'next' | 'branch';
}

export interface AgentCreateBranchAction {
  action: 'createBranch';
  editRef: string;
  title: string;
  body: string;
  description: string;
  /** 显式摘要；缺省由正文首段派生。 */
  summary?: string;
  side?: BranchSide;
  order?: number;
  /** Defaults to the source node's topic. */
  topicId?: string;
}

/**
 * 纵向后继：与 createBranch 同一条编译/事务路径，只是 flow="next" 且不带 side／order。
 * 来源已有 next 时拒绝（不自动 insert、不挤走旧主线）。
 */
export interface AgentCreateNextAction {
  action: 'createNext';
  editRef: string;
  title: string;
  body: string;
  description: string;
  /** 显式摘要；缺省由正文首段派生。 */
  summary?: string;
  /** Defaults to the source node's topic. */
  topicId?: string;
}

export interface AgentUpdateConnectionAction {
  action: 'updateConnection';
  editRef: string;
  /** Required when reattaching to another source. */
  fromRef?: string;
  flow?: NodeFlow;
  side?: BranchSide | null;
  order?: number | null;
  description: string;
}

/**
 * 一次表达若干节点的最终入边；服务端在同一批候选里先腾空再落位，
 * 中间排序只存在于内存，不落盘、不进入最终图。
 */
export interface AgentRearrangeEdit {
  /** 要改接的节点。 */
  editRef: string;
  /** 最终来源节点。 */
  fromRef: string;
  flow: 'next' | 'branch';
  /** 仅 flow=branch 允许。 */
  side?: BranchSide;
  /** 仅 flow=branch 允许。 */
  order?: number;
  /** 最终连接的说明，非空单行。 */
  description: string;
}

export interface AgentRearrangeAction {
  action: 'rearrange';
  /** 至少 1 条。 */
  edits: AgentRearrangeEdit[];
}

/** 只翻转一张卡片的重要标记；不手写底层 apply JSON。 */
export interface AgentSetImportanceAction {
  action: 'setImportance';
  editRef: string;
  important: boolean;
}

export interface AgentCreateRootAction {
  action: 'createRoot';
  topicTitle: string;
  title: string;
  body: string;
  summary?: string;
  description?: string;
}

export interface AgentCreateTopicAction {
  action: 'createTopic';
  topicTitle: string;
  directory?: string;
  title?: string;
  body: string;
  summary?: string;
}

/* ------------------------------------------------------------------ *
 * 批次编辑（batch）与插入（insert）
 * ------------------------------------------------------------------ */

/** 批次内节点选择：ref 指向批前快照已有节点，local 指向本批 create 的局部名称，二选一。 */
export interface AgentNodeSelector {
  ref?: string;
  local?: string;
}

/** 批次内一次属性／正文修改；与 patchNode 的字段一致，target 只能是已有节点。 */
export interface AgentBatchEditPatch {
  title?: string;
  /** null 删除显式摘要。 */
  summary?: string | null;
  body?: string;
  append?: string;
  replace?: AgentReplace[];
}

export interface AgentBatchEditOp {
  op: 'edit';
  target: { ref: string };
  patch: AgentBatchEditPatch;
}

export interface AgentBatchCreateOp {
  op: 'create';
  /** 本批唯一的局部名称，供同批其他 op 前向引用。 */
  as: string;
  from: AgentNodeSelector;
  flow: 'next' | 'branch';
  title: string;
  body: string;
  /** 为什么接到来源，非空单行。 */
  description: string;
  summary?: string;
  important?: boolean;
  /** 仅 flow=branch 允许。 */
  side?: BranchSide;
  /** 仅 flow=branch 允许；缺省由编译器按输入顺序稳定分配。 */
  order?: number;
}

export interface AgentBatchConnectOp {
  op: 'connect';
  /** 只允许已有节点。 */
  target: { ref: string };
  /** 出现时 flow 必须一起出现；只给 flow 时沿用当前来源。 */
  from?: AgentNodeSelector;
  flow?: 'next' | 'branch';
  /** 最终连接的说明，非空单行；只给 description 时只改说明。 */
  description: string;
  /** 仅最终 flow=branch 允许。 */
  side?: BranchSide;
  /** 仅最终 flow=branch 允许。 */
  order?: number;
}

export interface AgentBatchImportantOp {
  op: 'important';
  target: { ref: string };
  important: boolean;
}

export type AgentBatchOp =
  | AgentBatchEditOp
  | AgentBatchCreateOp
  | AgentBatchConnectOp
  | AgentBatchImportantOp;

/** 一次批次维护一个已存在主题内的多个节点；原子编译、一次提交。 */
export interface AgentBatchAction {
  action: 'batch';
  topicId: string;
  ops: AgentBatchOp[];
}

/** 在 after 与 before 的当前真实相邻 next 之间插入一个新节点。 */
export interface AgentInsertAction {
  action: 'insert';
  afterRef: string;
  beforeRef: string;
  title: string;
  body: string;
  /** 新节点为什么接在 after 之后。 */
  description: string;
  /** before 为什么接到新节点。 */
  nextDescription: string;
  summary?: string;
}

export type AgentChangeAction =
  | AgentPatchNodeAction
  | AgentCreateBranchAction
  | AgentCreateNextAction
  | AgentUpdateConnectionAction
  | AgentRearrangeAction
  | AgentSetImportanceAction
  | AgentCreateRootAction
  | AgentCreateTopicAction
  | AgentBatchAction
  | AgentInsertAction;

/** POST /api/agent/changes */
export interface AgentChangeRequest {
  workspaceId: string;
  /** Generated by the CLI; replay must return the original result. */
  requestId: string;
  /** 仅 batch 支持：true 时只编译与检查，不落盘、不写 agentLog、不更新最近更新。 */
  dryRun?: boolean;
  action: AgentChangeAction;
}

/** Stable IDs created by one agent request; replay must return the same values. */
export interface AgentCreatedIds {
  topicId: string | null;
  topicPath: string | null;
  nodeIds: string[];
  paths: string[];
  /** batch：局部名称 → 稳定 nodeId；非 batch/insert 为 {}。 */
  aliases: Record<string, string>;
}

/** POST /api/agent/changes response. */
export interface AgentChangeResponse extends SnapshotVersion {
  ok: true;
  requestId: string;
  action: AgentChangeAction['action'];
  workspaceId: string;
  /** 本次写入所属主题；批量／插入为动作主题，单个动作为目标节点主题。 */
  topicId: string;
  state: 'committed' | 'noop' | 'committed_refresh_pending';
  created: AgentCreatedIds;
  changedNodeIds: string[];
  /**
   * 按 nodeId 索引的不透明刷新凭据，覆盖本次 changedNodeIds 中仍在快照里的节点；
   * 提交／无操作后有效，committed_refresh_pending 时为空对象。
   */
  refs: Record<string, string>;
  touchedFiles: Array<{
    path: string;
    beforeSha256: string | null;
    afterSha256: string | null;
    byteLength: number;
  }>;
  summary: string;
  diagnostics: Diagnostic[];
  transactionId: string | null;
  journalCleaned: boolean;
  replayed?: boolean;
}

/**
 * batch dry-run 响应：只报告将要写入的文件，不返回 created／refs／aliases，
 * 不写 agentLog、不更新最近更新。
 */
export interface AgentBatchCheckResponse {
  ok: true;
  command: 'batch';
  dryRun: true;
  state: 'checked';
  requestId: string;
  workspaceId: string;
  topicId: string;
  summary: string;
  diagnostics: Diagnostic[];
  files: Array<{
    path: string;
    beforeSha256: string | null;
    nextSha256: string | null;
    deleted: boolean;
  }>;
}

/* ------------------------------------------------------------------ *
 * Topic export (frozen offline HTML)
 * ------------------------------------------------------------------ */

/** Frozen transfer document handed to export.renderTopicHtml. Never a long-term mirror. */
export interface OfflineTopicDocument {
  format: 1;
  workspaceId: string;
  workspaceName: string;
  instanceId: string;
  revision: number;
  /** Snapshot fingerprint (all source files), used to detect stale exports. */
  fingerprint: string;
  generatedAt: string;
  topic: GraphTopic;
  nodes: Array<GraphNode & { body: string; path: string; fileHash: string }>;
  /** Cross-topic neighbours outside this topic; IDs/titles only, no copied body. */
  boundaryNodes: GraphNode[];
  /** Resolved resource key (as referenced by Markdown) → data URI. */
  resources: Record<string, string>;
  /** Resource problems; any entry forces export state 'error'. */
  resourceDiagnostics: Diagnostic[];
}

export type ExportState = 'unset' | 'pending' | 'writing' | 'ready' | 'error' | 'stale';

/** GET /api/exports */
export interface TopicExportStatus {
  topicId: string;
  topicTitle: string;
  /** Absolute local .html path chosen by the user; null when unset. */
  targetPath: string | null;
  state: ExportState;
  /** Snapshot fingerprint the current source content has. */
  sourceFingerprint: string | null;
  /** Fingerprint of the last successful export. */
  exportedFingerprint: string | null;
  exportedRevision: number | null;
  lastSuccessAt: string | null;
  /** Concrete reason when state is error/stale. */
  error: string | null;
  resourceDiagnostics: Diagnostic[];
  /** Last known byte hash of the file the service wrote; detects external edits. */
  targetHash: string | null;
  targetPresent: boolean;
}

export interface ExportsResponse extends SnapshotVersion {
  topics: TopicExportStatus[];
}

/** PUT /api/exports/:topicId/target */
export interface ExportTargetRequest {
  /** Absolute local .html path, or null to unbind (existing output is kept). */
  path: string | null;
}

export interface ExportTargetResponse extends TopicExportStatus {
  ok: true;
}

/** SSE 'export' event: status only, never body text. */
export interface ExportEvent extends SnapshotVersion {
  event: 'export';
  status: TopicExportStatus;
}

/* ------------------------------------------------------------------ *
 * Progressive agent read views (overview / structure / content)
 * ------------------------------------------------------------------ */

export type ReadViewKind = 'overview' | 'structure' | 'content';

/** Which part of a topic an agent read view covers. */
export type ReadScope =
  | { kind: 'topic' }
  | { kind: 'subtree'; from: string }
  | { kind: 'nodes'; nodeIds: string[] };

export interface ReadViewPage {
  hasMore: boolean;
  /** Opaque continuation token; only meaningful with the same scope and fingerprint. */
  next?: string;
}

export interface ReadViewBudget {
  unit: 'utf16';
  /** Caller-supplied limit for this response. */
  limit: number;
  /** Final JSON.stringify(response).length. */
  used: number;
  mode: 'auto' | 'explicit';
}

export interface ReadScopeInfo {
  kind: 'topic' | 'subtree' | 'nodes';
  /** Present only for subtree scope. */
  from?: string;
  /** Nodes in the scope, not the number of items on this page. */
  nodeCount: number;
  note?: string;
}

export interface ReadOverviewItem {
  role: 'mainline' | 'branch';
  id: string;
  title: string;
  summary: string;
  number: string;
  flow: NodeFlow;
  from: string | null;
  description?: string;
  important: boolean;
  /** branch entry: visible subtree nodes inside the scope, including itself. */
  subtreeNodeCount?: number;
  /** branch entry: where to continue reading its internal structure. */
  read?: { view: 'structure'; from: string };
}

export interface ReadStructureItem {
  id: string;
  title: string;
  summary: string;
  number: string;
  flow: NodeFlow;
  from: string | null;
  description?: string;
  side?: BranchSide;
  order?: number;
  important: boolean;
}

export interface ReadContentItem {
  node: GraphNode;
  body: string;
  bodyOmitted?: boolean;
  range: AgentReadRange;
  /** True only when more body follows this segment; a tail read is false. */
  truncated: boolean;
  path: string;
  fileHash: string;
}

/** A real connection crossing the selected subtree boundary. */
export interface ReadBoundary {
  from: string;
  to: string;
  flow: 'next' | 'branch';
  description?: string;
  external: { id: string; title: string; topicId?: string };
}

export type ReadViewItem = ReadOverviewItem | ReadStructureItem | ReadContentItem;

export type ReadOnlineInfo =
  | { available: true; instanceId: string; revision: number; workspaceId: string }
  | { available: false; code: string; reason: string };

export interface ReadViewResponse {
  ok: true;
  command: 'read';
  source: 'online' | 'disk';
  root: string;
  online: ReadOnlineInfo;
  workspaceId: string;
  view: ReadViewKind;
  topicId: string | null;
  topicTitle: string | null;
  scope: ReadScopeInfo;
  items: ReadViewItem[];
  boundaries?: ReadBoundary[];
  /**
   * 当前页实际返回节点的刷新凭据：nodeId → opaque token。
   * overview／structure／离线为 {}；只覆盖本页，不累积旧页凭据。
   */
  refs: Record<string, string>;
  page: ReadViewPage;
  budget: ReadViewBudget;
  fingerprint: string;
}
