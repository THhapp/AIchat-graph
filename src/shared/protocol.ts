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

export type NodeState = 'agreed' | 'proposed' | 'reference';

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
  state: NodeState;
  /** branch only; normalized to 'right' when the source omits it. */
  side?: BranchSide;
  /** branch only; integer ordering among siblings of the same source. */
  order?: number;
  /**
   * Why this node connects to its source (format 2). Format 1 workspaces may still
   * carry a short display label here; treat label as compatibility, description as truth.
   */
  description?: string;
  /** Legacy format-1 edge label; never written by format-2 tools. */
  label?: string;
  /**
   * Real source file of this node (format 2: the node's own Markdown; format 1:
   * the topic file). Lets readers resolve relative links in the node body.
   */
  sourcePath?: string;
}

export interface GraphTopic {
  id: string;
  title: string;
  /** Workspace-relative path of the topic file (format 2: the topic.md metadata file). */
  path: string;
  /** Nodes of this topic in the effective snapshot; reading order comes from topic detail. */
  nodeIds: string[];
  /** SHA-256 of the declared topic file bytes (format 2: topic.md). */
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

/** GET /api/workspace */
export interface WorkspaceResponse extends SnapshotVersion {
  topicMode?: 'isolated' | 'shared';
  agentEntry?: { cliPath: string; skillPath: string };
  workspaceId: string;
  name: string;
  rootPath: string;
  activeNode: string | null;
  /** true when the effective snapshot is the last valid one and the disk content is invalid/unreadable. */
  stale: boolean;
  diagnostics: Diagnostic[];
}

/** GET /api/graph */
export interface GraphResponse extends SnapshotVersion {
  topicMode?: 'isolated' | 'shared';
  workspaceId: string;
  activeNode: string | null;
  stale: boolean;
  diagnostics: Diagnostic[];
  nodes: GraphNode[];
  topics: GraphTopic[];
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

/** Optional section locator; line numbers are 1-based within the node body. */
export interface AgentSection {
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
  range: AgentReadRange;
  truncated: boolean;
  /** Real source file of this node (format 2: the node's own Markdown). */
  path: string;
  fileHash: string;
  /** Topic metadata file (format 2: topic.md). */
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

/** Body edit modes are mutually exclusive. */
export interface AgentPatchNodeAction {
  action: 'patchNode';
  editRef: string;
  title?: string;
  state?: NodeState;
  /** null removes an explicit summary. */
  summary?: string | null;
  replace?: AgentReplace[];
  append?: string;
  body?: string;
}

export interface AgentCreateBranchAction {
  action: 'createBranch';
  editRef: string;
  title: string;
  body: string;
  description: string;
  state?: NodeState;
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
  state?: NodeState;
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

export interface AgentCreateRootAction {
  action: 'createRoot';
  topicTitle: string;
  title: string;
  body: string;
  state?: NodeState;
  description?: string;
}

export interface AgentCreateTopicAction {
  action: 'createTopic';
  topicTitle: string;
  directory?: string;
  title?: string;
  body: string;
  state?: NodeState;
}

export type AgentChangeAction =
  | AgentPatchNodeAction
  | AgentCreateBranchAction
  | AgentCreateNextAction
  | AgentUpdateConnectionAction
  | AgentCreateRootAction
  | AgentCreateTopicAction;

/** POST /api/agent/changes */
export interface AgentChangeRequest {
  workspaceId: string;
  /** Generated by the CLI; replay must return the original result. */
  requestId: string;
  action: AgentChangeAction;
}

/** Stable IDs created by one agent request; replay must return the same values. */
export interface AgentCreatedIds {
  topicId: string | null;
  topicPath: string | null;
  nodeIds: string[];
  paths: string[];
}

/** POST /api/agent/changes response. */
export interface AgentChangeResponse extends SnapshotVersion {
  ok: true;
  requestId: string;
  action: AgentChangeAction['action'];
  state: 'committed' | 'noop' | 'committed_refresh_pending';
  created: AgentCreatedIds;
  affectedNodeIds: string[];
  changedNodeIds: string[];
  touchedFiles: Array<{
    path: string;
    beforeSha256: string | null;
    afterSha256: string | null;
    byteLength: number;
  }>;
  /** New credential for the primary affected node, when it is still readable. */
  editRef: AgentEditRef | null;
  summary: string;
  diagnostics: Diagnostic[];
  transactionId: string | null;
  journalCleaned: boolean;
  replayed?: boolean;
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