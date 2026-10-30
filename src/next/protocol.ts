/**
 * Interface 4 DTO: SQLite-backed discussion graph.
 * No file paths, file hashes, edit refs or expected files are part of this contract.
 */

export const INTERFACE_VERSION = 5;

export type NodeFlow = 'root' | 'next' | 'branch';
export type BranchSide = 'left' | 'right';

export interface ProgramInfo {
  program: 'aichat-graph';
  version: string;
  interfaceVersion: number;
  buildId: string;
  commit: string | null;
  builtAt: string | null;
  manifest?: 'dist' | 'dev' | 'invalid';
}

export interface SnapshotVersion {
  instanceId: string;
  revision: number;
}

export interface GraphNode {
  id: string;
  topicId: string;
  title: string;
  /** Explicit summary or first body paragraph truncated to 120 code points. */
  summary: string;
  /** Display-only numbering; never an identity. */
  number: string;
  from: string | null;
  flow: NodeFlow;
  side?: BranchSide;
  order?: number;
  important: boolean;
  description?: string;
  /** Persistent node revision; write conditions use this value. */
  revision: number;
}

export interface GraphTopic {
  id: string;
  /** User-facing stable key chosen at creation/import; not a filesystem path. */
  key: string;
  title: string;
  nodeIds: string[];
  revision: number;
}

export interface LastChange {
  at: string;
  nodeIds: string[];
}

export interface Diagnostic {
  code: string;
  message: string;
  severity?: 'error' | 'warning' | 'info';
  topicId?: string;
  nodeId?: string;
}

export interface WorkspaceResponse extends SnapshotVersion {
  program?: ProgramInfo;
  workspaceId: string;
  name: string;
  rootPath: string;
  activeNode: string | null;
  stale: boolean;
  diagnostics: Diagnostic[];
  agentEntry?: { cliPath: string; skillPath: string };
}

export interface GraphResponse extends SnapshotVersion {
  workspaceId: string;
  activeNode: string | null;
  stale: boolean;
  diagnostics: Diagnostic[];
  nodes: GraphNode[];
  topics: GraphTopic[];
  lastChanges?: Record<string, LastChange>;
}

export interface NodeDetailResponse extends SnapshotVersion {
  node: GraphNode;
  body: string;
  /** resource key -> same-origin URL; keys are body references such as resources/x.png. */
  resources?: Record<string, string>;
}

export interface TopicNodeDetail extends GraphNode {
  body: string;
}

export interface TopicDetailResponse extends SnapshotVersion {
  source: 'database';
  valid: boolean;
  topic: GraphTopic;
  nodes: TopicNodeDetail[];
  diagnostics: Diagnostic[];
  /** resource key -> same-origin URL for nodes in this topic. */
  resources?: Record<string, string>;
}

export interface ImportanceRequest {
  topicId: string;
  nodeId: string;
  important: boolean;
  /** Optional persistent revision to check. */
  revision?: number;
}

export interface ImportanceResponse extends SnapshotVersion {
  ok: true;
  node: GraphNode;
}

export type SearchField = 'title' | 'summary' | 'body';

export interface SearchHit {
  nodeId: string;
  topicId: string;
  title: string;
  path?: string;
  snippet: string;
  field: SearchField;
  revision: number;
}

export interface SearchResponse {
  ok: true;
  command: 'search';
  source: 'database';
  workspaceId: string;
  query: string;
  hits: SearchHit[];
  page: number;
  limit: number;
  totalHits: number;
  hasMore: boolean;
  truncated: boolean;
  diagnostics: Diagnostic[];
}

/* ----------------------------- read views ----------------------------- */

export type ReadViewKind = 'overview' | 'structure' | 'content' | 'resume';

export type ReadScope =
  | { kind: 'topic' }
  | { kind: 'subtree'; from: string }
  | { kind: 'nodes'; nodeIds: string[] };

export interface ReadRange {
  start: number;
  end: number;
  total: number;
  unit: 'utf16';
}

export interface ReadItem {
  node: GraphNode;
  /** Role of this item in a resume view; absent for normal views. */
  role?: 'anchor' | 'ancestor' | 'next' | 'branch' | 'important' | 'recent';
  body: string;
  range: ReadRange;
  truncated: boolean;
  /** true when body was intentionally omitted in a summary-only navigation item. */
  omitted?: boolean;
}

export interface ReadPage {
  hasMore: boolean;
  next?: string;
}

export interface ReadBudget {
  unit: 'utf16';
  limit: number;
  used: number;
  mode: 'auto';
}

export interface ReadViewResponse {
  ok: true;
  command: 'read';
  source: 'online' | 'disk' | 'database';
  workspaceId: string;
  view: ReadViewKind;
  topicId: string;
  topicTitle: string;
  scope: ReadScope & { nodeCount: number; note?: string };
  anchor?: GraphNode;
  items: ReadItem[];
  boundaries?: GraphNode[];
  page: ReadPage;
  budget: ReadBudget;
  fingerprint: string;
  diagnostics?: Diagnostic[];
}

/* ----------------------------- agent writes ----------------------------- */

export interface ExistingSelector {
  id: string;
  revision: number;
}

export interface LocalSelector {
  local: string;
}

export type NodeSelector = ExistingSelector | LocalSelector;

export interface IncomingPatch {
  /** New source; when present flow and description are required. */
  from?: ExistingSelector;
  flow?: 'next' | 'branch';
  description?: string;
  order?: number;
}

/**
 * The single full node patch shared by edit and batch edit.
 * summary:null clears the explicit summary; omitted body means unchanged.
 */
export interface NodePatch {
  title?: string;
  summary?: string | null;
  body?: string;
  append?: string;
  replace?: Array<{ old: string; new: string }>;
  important?: boolean;
  incoming?: IncomingPatch;
}

export interface NodeCreate {
  title: string;
  body: string;
  summary?: string;
  important?: boolean;
  side?: BranchSide;
  order?: number;
}

export interface AgentEditOp {
  op: 'edit';
  target: ExistingSelector;
  patch: NodePatch;
}

export interface AgentCreateOp {
  op: 'create';
  as: string;
  from: NodeSelector;
  flow: 'next' | 'branch';
  description: string;
  node: NodeCreate;
}

export interface AgentDeleteOp {
  op: 'delete';
  target: ExistingSelector;
}

export type AgentBatchOp = AgentEditOp | AgentCreateOp | AgentDeleteOp;

export interface AgentBatchAction {
  action: 'batch';
  topicId: string;
  ops: AgentBatchOp[];
}

export interface AgentInsertAction {
  action: 'insert';
  after: ExistingSelector;
  before: ExistingSelector;
  description: string;
  nextDescription: string;
  node: NodeCreate;
}

export interface AgentRearrangeEdit {
  target: ExistingSelector;
  from: ExistingSelector;
  flow: 'next' | 'branch';
  description: string;
  order?: number;
}

export interface AgentRearrangeAction {
  action: 'rearrange';
  edits: AgentRearrangeEdit[];
}

export interface AgentSetImportanceAction {
  action: 'setImportance';
  nodeId: string;
  important: boolean;
  revision?: number;
}

export interface AgentCreateTopicAction {
  action: 'createTopic';
  key?: string;
  topicTitle: string;
  node: NodeCreate;
}

export interface AgentCreateNextAction {
  action: 'createNext' | 'createBranch';
  from: ExistingSelector;
  description: string;
  node: NodeCreate;
}

export interface AgentDeleteAction {
  action: 'delete';
  target: ExistingSelector;
}

export type AgentChangeAction =
  | AgentBatchAction
  | AgentInsertAction
  | AgentRearrangeAction
  | AgentSetImportanceAction
  | AgentCreateTopicAction
  | AgentCreateNextAction
  | AgentDeleteAction;

export interface AgentChangeRequest {
  workspaceId: string;
  requestId: string;
  dryRun?: boolean;
  action: AgentChangeAction;
}

export interface AgentCreatedIds {
  topicId: string | null;
  nodeIds: string[];
  aliases: Record<string, string>;
}

export interface AgentChangeResponse extends SnapshotVersion {
  ok: true;
  requestId: string;
  action: AgentChangeAction['action'];
  workspaceId: string;
  topicId: string | null;
  state: 'committed' | 'noop' | 'committed_refresh_pending';
  created: AgentCreatedIds;
  changedNodeIds: string[];
  /**
   * 本次新建、真实修改，以及动作明确操作且仍存在的节点 → 提交后持久 node revision。
   * 删除的节点不出现；noop 也给出目标的实际版本；replay 原样返回；dry-run 不伪造。
   */
  nodeRevisions: Record<string, number>;
  replayed?: boolean;
  summary: string;
  diagnostics: Diagnostic[];
}

export interface AgentCheckResponse {
  ok: true;
  command: string;
  dryRun: true;
  state: 'checked';
  requestId: string;
  workspaceId: string;
  topicId: string | null;
  summary: string;
  diagnostics: Diagnostic[];
  changes: Array<{ nodeId: string; kind: 'create' | 'update' | 'delete' }>;
}

export interface ChangeStatusResponse {
  ok: true;
  requestId: string;
  status: 'committed' | 'noop' | 'unknown';
  httpStatus: number | null;
  state: string;
  recordedAt: string | null;
  source: 'database' | 'unknown';
}

/* ----------------------------- export ----------------------------- */

export interface OfflineNode extends GraphNode {
  body: string;
}

export interface OfflineTopicDocument {
  format: 1;
  workspaceId: string;
  workspaceName: string;
  instanceId: string;
  revision: number;
  fingerprint: string;
  generatedAt: string;
  topic: GraphTopic;
  nodes: OfflineNode[];
  boundaryNodes: GraphNode[];
  resources: Record<string, string>;
  resourceDiagnostics: Diagnostic[];
}

export type ExportState = 'unset' | 'pending' | 'writing' | 'ready' | 'error' | 'stale';

export interface TopicExportStatus {
  topicId: string;
  topicTitle: string;
  targetPath: string | null;
  state: ExportState;
  sourceFingerprint: string | null;
  exportedFingerprint: string | null;
  exportedRevision: number | null;
  lastSuccessAt: string | null;
  error: string | null;
  resourceDiagnostics: Diagnostic[];
  targetHash: string | null;
  targetPresent: boolean;
}

export interface ExportsResponse extends SnapshotVersion {
  topics: TopicExportStatus[];
}

export interface ExportEvent extends SnapshotVersion {
  event: 'export';
  status: TopicExportStatus;
}

export interface SnapshotEvent extends SnapshotVersion {
  event: 'snapshot' | 'diagnostics';
  changedTopicIds: string[];
  changedNodeIds: string[];
  stale: boolean;
  diagnostics?: Diagnostic[];
}

/* ------------------------- local runtime controls ------------------------- */

export interface RuntimeStopRequest {
  workspaceId: string;
  instanceId: string;
}

export interface RuntimeStopResponse {
  ok: true;
  state: 'stopping';
}

export interface RuntimeOpenWorkspaceRequest {
  workspaceId: string;
  instanceId: string;
}

export interface RuntimeOpenWorkspaceResponse {
  ok: true;
  state: 'started';
}
