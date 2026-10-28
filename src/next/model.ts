/**
 * Domain records and pure graph operations for the SQLite-backed store.
 * No filesystem paths, source ranges, file hashes or transport concerns.
 */
import { randomUUID } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { deriveSummary } from '../core/summary.js';
import type {
  BranchSide,
  GraphNode,
  GraphTopic,
  LastChange,
  NodeCreate,
  NodeFlow,
  NodePatch,
  NodeState,
  NodeSelector,
  ExistingSelector,
  ReadViewKind,
  Diagnostic,
} from './protocol.js';

export type { NodeState, NodeFlow, BranchSide };

export interface NodeRecord {
  id: string;
  topicId: string;
  title: string;
  body: string;
  /** null means no explicit summary; readers derive one from body. */
  summary: string | null;
  state: NodeState;
  from: string | null;
  flow: NodeFlow;
  description: string | null;
  side: BranchSide | null;
  order: number | null;
  important: boolean;
  revision: number;
}

export interface TopicRecord {
  id: string;
  key: string;
  title: string;
  revision: number;
  lastChangeAt: string | null;
  lastChangeIds: string[];
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  activeNode: string | null;
  revision: number;
}

export interface NodeView extends NodeRecord {
  number: string;
  nextId: string | null;
  branchIds: string[];
}

export interface TopicView extends TopicRecord {
  nodeIds: string[];
}

export interface Snapshot {
  workspaceId: string;
  name: string;
  activeNode: string | null;
  revision: number;
  topics: TopicView[];
  nodes: NodeView[];
}

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, status = 422, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function newNodeId(): string {
  return 'n_' + randomUUID().replace(/-/g, '');
}
export function newTopicId(): string {
  return 't_' + randomUUID().replace(/-/g, '');
}

const MARKDOWN = unified().use(remarkParse).use(remarkGfm);
export function derivedSummary(body: string): string {
  try {
    const root = MARKDOWN.parse(body) as Root;
    return deriveSummary(root.children);
  } catch {
    return '';
  }
}

export function publicNode(node: NodeView): GraphNode {
  return {
    id: node.id,
    topicId: node.topicId,
    title: node.title,
    summary: node.summary ?? derivedSummary(node.body),
    number: node.number,
    from: node.from,
    flow: node.flow,
    state: node.state,
    ...(node.side !== null ? { side: node.side } : {}),
    ...(node.order !== null ? { order: node.order } : {}),
    important: node.important,
    ...(node.description !== null ? { description: node.description } : {}),
    revision: node.revision,
  };
}

export function publicTopic(topic: TopicView): GraphTopic {
  return { id: topic.id, key: topic.key, title: topic.title, nodeIds: [...topic.nodeIds], revision: topic.revision };
}

function padding(value: number): string {
  return value < 10 ? '0' + value : String(value);
}
function byNumber(left: string, right: string): number {
  const a = left.split('-').map(Number);
  const b = right.split('-').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Validate graph invariants and assign display numbers. Throws DomainError. */
export function projectSnapshot(
  workspace: WorkspaceRecord,
  topics: readonly TopicRecord[],
  nodes: readonly NodeRecord[],
): Snapshot {
  const topicById = new Map(topics.map((topic) => [topic.id, topic]));
  if (topicById.size !== topics.length) throw new DomainError('TOPIC_ID_DUPLICATED', '主题 ID 重复');
  const nodeById = new Map<string, NodeRecord>();
  for (const node of nodes) {
    if (nodeById.has(node.id)) throw new DomainError('NODE_ID_DUPLICATED', '节点 ID 重复：' + node.id);
    if (!topicById.has(node.topicId)) throw new DomainError('NODE_TOPIC_UNKNOWN', '节点主题不存在：' + node.id);
    nodeById.set(node.id, node);
  }

  const children = new Map<string, NodeRecord[]>();
  const roots: NodeRecord[] = [];
  for (const node of nodes) {
    if (node.flow === 'root') {
      if (node.from !== null) throw new DomainError('NODE_ROOT_INVALID', 'root 节点不能有来源');
      if (node.side !== null || node.order !== null) {
        throw new DomainError('NODE_FLOW_FIELD_INVALID', 'root 节点不使用 side/order');
      }
      roots.push(node);
    } else {
      if (node.from === null) throw new DomainError('NODE_FROM_MISSING', node.flow + ' 节点必须指定来源');
      if (!nodeById.has(node.from)) throw new DomainError('NODE_FROM_UNKNOWN', '来源不存在：' + node.from);
      const source = nodeById.get(node.from) as NodeRecord;
      if (source.topicId !== node.topicId) throw new DomainError('NODE_CROSS_TOPIC', '连接不能跨主题');
      if (node.flow === 'next' && (node.side !== null || node.order !== null)) {
        throw new DomainError('NODE_FLOW_FIELD_INVALID', 'next 节点不使用 side/order');
      }
      const bucket = children.get(node.from);
      if (bucket) bucket.push(node);
      else children.set(node.from, [node]);
    }
  }

  for (const topic of topics) {
    const topicNodes = nodes.filter((node) => node.topicId === topic.id);
    const topicRoots = roots.filter((node) => node.topicId === topic.id);
    if (topicNodes.length > 0 && topicRoots.length !== 1) {
      throw new DomainError('NODE_ROOT_COUNT', '每个非空主题必须恰好有一个 root');
    }
  }
  for (const [sourceId, childrenOf] of children) {
    const next = childrenOf.filter((node) => node.flow === 'next');
    if (next.length > 1) throw new DomainError('NODE_NEXT_MULTIPLE', '来源 ' + sourceId + ' 只能有一个 next 后继');
    const orders = new Map<number, number>();
    for (const branch of childrenOf.filter((node) => node.flow === 'branch')) {
      if (branch.order === null) continue;
      orders.set(branch.order, (orders.get(branch.order) ?? 0) + 1);
    }
    for (const [order, count] of orders) {
      if (count > 1) throw new DomainError('NODE_BRANCH_ORDER_DUPLICATED', '来源 ' + sourceId + ' 的 branch order 重复：' + String(order));
    }
  }
  // cycles
  for (const node of nodes) {
    const seen = new Set<string>();
    let current: NodeRecord | undefined = node;
    while (current !== undefined) {
      if (seen.has(current.id)) throw new DomainError('GRAPH_CYCLE', '连接形成环：' + current.id);
      seen.add(current.id);
      current = current.from === null ? undefined : nodeById.get(current.from);
    }
  }
  const reachable = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const node = queue.shift() as NodeRecord;
    if (reachable.has(node.id)) continue;
    reachable.add(node.id);
    for (const child of children.get(node.id) ?? []) queue.push(child);
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) throw new DomainError('NODE_UNREACHABLE', '节点不能从根到达：' + node.id);
  }
  if (workspace.activeNode !== null && !nodeById.has(workspace.activeNode)) {
    throw new DomainError('FOCUS_NODE_UNKNOWN', 'activeNode 指向不存在的节点');
  }

  const numbers = new Map<string, string>();
  const branchEntriesOf = (nodeId: string): NodeRecord[] =>
    (children.get(nodeId) ?? [])
      .filter((node) => node.flow === 'branch')
      .sort((left, right) => {
        if (left.order !== null && right.order !== null) {
          const diff = left.order - right.order;
          if (diff !== 0) return diff;
        } else if (left.order !== null) return -1;
        else if (right.order !== null) return 1;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
  const nextChildOf = (nodeId: string): NodeRecord | undefined =>
    (children.get(nodeId) ?? []).find((node) => node.flow === 'next');
  const assignChain = (startId: string, prefix: string | null, startCounter: number): number => {
    let counter = startCounter;
    let currentId: string | undefined = startId;
    const seen = new Set<string>();
    while (currentId !== undefined && !seen.has(currentId)) {
      seen.add(currentId);
      const number = prefix === null ? padding(counter) : prefix + '-' + padding(counter);
      numbers.set(currentId, number);
      counter += 1;
      let branchCounter = 1;
      for (const entry of branchEntriesOf(currentId)) branchCounter = assignChain(entry.id, number, branchCounter);
      currentId = nextChildOf(currentId)?.id;
    }
    return counter;
  };
  for (const root of [...roots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    assignChain(root.id, null, 1);
  }
  if (numbers.size !== nodes.length) throw new DomainError('GRAPH_STRUCTURE_INCOMPLETE', '未能为全部节点编号');

  const nodeViews: NodeView[] = nodes
    .map((node) => {
      const number = numbers.get(node.id) as string;
      return {
        ...node,
        number,
        nextId: nextChildOf(node.id)?.id ?? null,
        branchIds: branchEntriesOf(node.id).map((entry) => entry.id),
      };
    })
    .sort((left, right) =>
      (left.topicId < right.topicId ? -1 : left.topicId > right.topicId ? 1 : 0) || byNumber(left.number, right.number));
  const viewById = new Map(nodeViews.map((node) => [node.id, node]));
  const topicViews: TopicView[] = topics.map((topic) => ({
    ...topic,
    nodeIds: nodeViews.filter((node) => node.topicId === topic.id).map((node) => node.id),
  }));
  return {
    workspaceId: workspace.id,
    name: workspace.name,
    activeNode: workspace.activeNode,
    revision: workspace.revision,
    topics: topicViews,
    nodes: nodeViews,
  };
}

export function findNode(snapshot: Snapshot, id: string): NodeView {
  const node = snapshot.nodes.find((entry) => entry.id === id);
  if (node === undefined) throw new DomainError('NODE_NOT_FOUND', '找不到节点 ' + id, 404, { nodeId: id });
  return node;
}
export function findTopic(snapshot: Snapshot, id: string): TopicView {
  const topic = snapshot.topics.find((entry) => entry.id === id);
  if (topic === undefined) throw new DomainError('TOPIC_NOT_FOUND', '找不到主题 ' + id, 404, { topicId: id });
  return topic;
}

export function checkSelector(snapshot: Snapshot, selector: ExistingSelector): NodeView {
  const node = findNode(snapshot, selector.id);
  if (!Number.isInteger(selector.revision) || selector.revision !== node.revision) {
    throw new DomainError(
      'VERSION_CONFLICT',
      '节点版本已变化：' + node.id + ' 期望 ' + selector.revision + '，当前 ' + node.revision,
      412,
      { nodeId: node.id, expectedRevision: selector.revision, actualRevision: node.revision, hint: '重新读取节点后再修改' },
    );
  }
  return node;
}

/** Apply append/replace/body semantics. */
export function applyBodyPatch(body: string, patch: NodePatch): { body: string; changed: boolean } {
  const modes = [patch.body !== undefined, patch.append !== undefined, patch.replace !== undefined].filter(Boolean).length;
  if (modes > 1) throw new DomainError('INVALID_PATCH', 'body／append／replace 只能选一个');
  if (patch.replace !== undefined) {
    if (patch.replace.length === 0) throw new DomainError('INVALID_PATCH', 'replace 至少要一项');
    let next = body;
    for (const replacement of patch.replace) {
      if (replacement.old.length === 0) throw new DomainError('INVALID_PATCH', 'replace.old 不能为空');
      const first = next.indexOf(replacement.old);
      if (first < 0) throw new DomainError('REPLACE_NOT_FOUND', 'replace.old 未匹配：' + replacement.old.slice(0, 40), 422);
      if (next.indexOf(replacement.old, first + replacement.old.length) >= 0) {
        throw new DomainError('REPLACE_NOT_UNIQUE', 'replace.old 匹配多次：' + replacement.old.slice(0, 40), 422);
      }
      next = next.slice(0, first) + replacement.new + next.slice(first + replacement.old.length);
    }
    return { body: next, changed: next !== body };
  }
  if (patch.append !== undefined) {
    const addition = patch.append.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
    if (addition.length === 0) return { body, changed: false };
    const base = body.replace(/\s+$/, '');
    const next = base.length === 0 ? addition : base + '\n\n' + addition;
    return { body: next, changed: next !== body };
  }
  if (patch.body !== undefined) return { body: patch.body, changed: patch.body !== body };
  return { body, changed: false };
}

const CONTENT_FIELDS = ['title', 'body', 'summary', 'state', 'from', 'flow', 'description', 'side', 'order'] as const;

export function contentChanged(before: NodeRecord, after: NodeRecord): boolean {
  for (const field of CONTENT_FIELDS) {
    if (before[field] !== after[field]) return true;
  }
  return false;
}

/** Apply a full NodePatch to a node. Source revision checks happen before calling. */
export function applyNodePatch(
  node: NodeView,
  patch: NodePatch,
  versionOf: (selector: ExistingSelector) => NodeView,
): NodeRecord {
  const incoming = patch.incoming;
  if (incoming !== undefined && Object.keys(incoming).length === 0) {
    throw new DomainError('INVALID_PATCH', 'incoming 至少要给出 description、from 或 flow');
  }
  if (node.flow === 'root' && incoming !== undefined) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'root 节点没有入边；只能修改普通内容或重要性',
      422,
      { nodeId: node.id, field: 'incoming', category: 'structure', hint: 'aichat help edit --json' },
    );
  }
  const hasAny =
    patch.title !== undefined ||
    patch.state !== undefined ||
    patch.summary !== undefined ||
    patch.body !== undefined ||
    patch.append !== undefined ||
    patch.replace !== undefined ||
    patch.important !== undefined ||
    incoming !== undefined;
  if (!hasAny) throw new DomainError('INVALID_PATCH', 'patch 至少需要一处修改');

  const next: NodeRecord = { ...node };
  if (patch.title !== undefined) {
    if (patch.title.trim().length === 0 || /[\r\n]/.test(patch.title)) {
      throw new DomainError('INVALID_PATCH', 'title 必须是非空单行文本');
    }
    next.title = patch.title.trim();
  }
  if (patch.state !== undefined) next.state = patch.state;
  if (patch.summary !== undefined) {
    if (patch.summary === null) next.summary = null;
    else if (patch.summary.trim().length === 0 || /[\r\n]/.test(patch.summary)) {
      throw new DomainError('INVALID_PATCH', 'summary 必须是非空单行文本；清除请用 summary:null');
    } else next.summary = patch.summary.trim();
  }
  const bodyResult = applyBodyPatch(node.body, patch);
  next.body = bodyResult.body;
  if (patch.important !== undefined) next.important = patch.important;

  if (incoming !== undefined) {
    if (incoming.from !== undefined) {
      if (incoming.flow === undefined) throw new DomainError('INVALID_PATCH', 'from 必须同时给出 flow');
      const source = versionOf(incoming.from);
      if (source.topicId !== node.topicId) throw new DomainError('NODE_CROSS_TOPIC', '来源不能跨主题');
      if (source.id === node.id) throw new DomainError('NODE_SELF_LINK', '节点不能以自身作为来源');
      next.from = source.id;
      next.flow = incoming.flow;
    } else if (incoming.flow !== undefined) {
      next.flow = incoming.flow;
    }
    if (incoming.flow !== undefined || incoming.from !== undefined) {
      if (incoming.description === undefined) {
        throw new DomainError('INVALID_PATCH', '改变来源或 flow 时必须给出 description');
      }
      if (incoming.description.trim().length === 0 || /[\r\n]/.test(incoming.description)) {
        throw new DomainError('INVALID_PATCH', 'description 必须是非空单行文本');
      }
      next.description = incoming.description.trim();
    } else if (incoming.description !== undefined) {
      if (incoming.description.trim().length === 0 || /[\r\n]/.test(incoming.description)) {
        throw new DomainError('INVALID_PATCH', 'description 必须是非空单行文本');
      }
      next.description = incoming.description.trim();
    }
    if (incoming.order !== undefined) next.order = incoming.order;
  }

  if (next.flow === 'root') {
    next.from = null;
    next.description = null;
    next.side = null;
    next.order = null;
  } else if (next.flow === 'next') {
    next.side = null;
    next.order = null;
  } else if (next.flow === 'branch') {
    if (next.from === null) throw new DomainError('NODE_FROM_MISSING', 'branch 必须有来源');
    if (next.order === null) {
      const siblings = 0; // order is completed by commit when omitted
      void siblings;
    }
  }
  return next;
}

export function normalizeCreate(
  input: NodeCreate,
  topicId: string,
): Omit<NodeRecord, 'id' | 'revision'> {
  if (input.title.trim().length === 0 || /[\r\n]/.test(input.title)) {
    throw new DomainError('INVALID_PATCH', '节点标题必须是非空单行文本');
  }
  if (input.summary !== undefined && (input.summary.trim().length === 0 || /[\r\n]/.test(input.summary))) {
    throw new DomainError('INVALID_PATCH', 'summary 必须是非空单行文本');
  }
  return {
    topicId,
    title: input.title.trim(),
    body: input.body,
    summary: input.summary === undefined ? null : input.summary.trim(),
    state: input.state ?? 'proposed',
    from: null,
    flow: 'root',
    description: null,
    side: input.side ?? null,
    order: input.order ?? null,
    important: input.important ?? false,
  };
}

export function topicKeyFromTitle(title: string): string {
  const key = title.trim().replace(/[<>:"|?*\\/\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '');
  return key.length > 0 ? key : 'topic-' + Date.now();
}

export function scopeNote(view: ReadViewKind): string | undefined {
  if (view === 'overview') return '分支内部默认未展开；用 structure／content 继续读取。';
  if (view === 'resume') return '只返回续谈必要的 anchor、来路和附近分支；其他内容按需展开。';
  return undefined;
}

export function emptyDiagnostic(): Diagnostic[] { return []; }

export type { LastChange, NodePatch, NodeSelector };
