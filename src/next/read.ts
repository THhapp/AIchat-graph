/**
 * Pure read projections for overview / structure / content / resume.
 * Bodies are sliced from the database text; revisions drive cursor validation.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_READ_LENGTH,
  MAX_READ_SEGMENT,
  locateSection,
  sliceBody,
  type BodyRange,
} from '../core/reading.js';
import {
  DomainError,
  findNode,
  findTopic,
  publicNode,
  publicTopic,
  type NodeView,
  type Snapshot,
  type TopicView,
} from './model.js';
import type {
  GraphNode,
  ReadBudget,
  ReadItem,
  ReadNode,
  ReadPage,
  ReadScope,
  ReadViewKind,
  ReadViewResponse,
} from './protocol.js';

export const DEFAULT_READ_BUDGET = 12000;
export const MAX_READ_BUDGET = 1_000_000;

export interface ReadRequest {
  view: ReadViewKind;
  topicId?: string | undefined;
  from?: string | undefined;
  nodeIds?: string[] | undefined;
  anchor?: string | undefined;
  budget: number;
  cursor?: string | undefined;
  start?: number | undefined;
  length?: number | undefined;
  full?: boolean | undefined;
  section?: string | undefined;
  sectionIndex?: number | undefined;
  meta?: boolean | undefined;
}

interface CursorState {
  v: 2;
  view: ReadViewKind;
  topicId: string;
  /** Compact original range; explicit content node ids/order are kept only here. */
  scope: ReadScope;
  anchor?: string | undefined;
  index: number;
  start: number;
  /** Slice conditions survive across pages. */
  bodyMode: 'segment' | 'full' | 'meta';
  length: number;
  fingerprint: string;
}

interface ContentCandidate {
  node: NodeView;
  role?: ReadItem['role'];
  bodySegment?: ReturnType<typeof sliceBody>;
  omitted: boolean;
}

function fingerprintOf(snapshot: Snapshot, topic: TopicView, nodeIds: readonly string[]): string {
  const nodes = nodeIds.map((id) => {
    const node = snapshot.nodes.find((entry) => entry.id === id);
    return node === undefined ? id + ':-' : node.id + ':' + String(node.revision);
  });
  return createHash('sha256').update(JSON.stringify({ topic: topic.id + ':' + String(topic.revision), nodes })).digest('hex');
}

function scopeOf(effective: ReadRequest, built: { topic: TopicView; items: ContentCandidate[] }): ReadScope {
  if (effective.view === 'overview' || effective.view === 'resume') return { kind: 'topic' };
  if (effective.view === 'structure') {
    return effective.from === undefined ? { kind: 'topic' } : { kind: 'subtree', from: effective.from };
  }
  return { kind: 'nodes', nodeIds: built.items.map((item) => item.node.id) };
}

/** Read items omit topicId: the response-level topic already owns the scope. */
function readNode(node: NodeView): ReadNode {
  const { topicId: _topicId, ...rest } = publicNode(node);
  return rest;
}

function mainline(topic: TopicView, nodes: readonly NodeView[]): NodeView[] {
  const root = nodes.find((node) => node.topicId === topic.id && node.flow === 'root');
  if (!root) return [];
  const chain: NodeView[] = [];
  let current: NodeView | undefined = root;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = nodes.find((node) => node.id === current?.nextId && node.topicId === topic.id);
  }
  return chain;
}

function descendants(nodes: readonly NodeView[], from: string): NodeView[] {
  const result: NodeView[] = [];
  const walk = (id: string): void => {
    const node = nodes.find((entry) => entry.id === id);
    if (!node) return;
    result.push(node);
    for (const child of nodes.filter((entry) => entry.from === id)) walk(child.id);
  };
  walk(from);
  return result;
}

function candidatesFor(snapshot: Snapshot, request: ReadRequest): { topic: TopicView; items: ContentCandidate[]; note: string } {
  const topicId = request.topicId;
  if (topicId === undefined) throw new DomainError('INVALID_READ', 'read 需要 topicId');
  const topic = findTopic(snapshot, topicId);
  const topicNodes = snapshot.nodes.filter((node) => node.topicId === topicId);
  if (request.view === 'overview') {
    const chain = mainline(topic, topicNodes);
    const entries = new Map(chain.map((node) => [node.id, node]));
    for (const node of chain) {
      for (const branchId of node.branchIds) {
        const branch = snapshot.nodes.find((entry) => entry.id === branchId);
        if (branch) entries.set(branch.id, branch);
      }
    }
    return {
      topic,
      items: [...entries.values()].map((node) => ({ node, omitted: true })),
      note: '主线与直接分支入口；分支内部默认未展开，用 structure／content 继续读取。',
    };
  }
  if (request.view === 'structure') {
    const start = request.from === undefined ? topicNodes.find((node) => node.flow === 'root') : snapshot.nodes.find((node) => node.id === request.from);
    if (start === undefined) throw new DomainError('NOT_FOUND', 'structure 起点不存在', 404);
    const nodes = request.from === undefined ? topicNodes : descendants(topicNodes, request.from);
    return { topic, items: nodes.map((node) => ({ node, omitted: true })), note: request.from === undefined ? '主题全部结构。' : '从指定节点可达的结构。' };
  }
  if (request.view === 'resume') {
    if (request.anchor === undefined) throw new DomainError('INVALID_READ', 'resume 需要 --node anchor');
    const anchor = findNode(snapshot, request.anchor);
    if (anchor.topicId !== topicId) throw new DomainError('NODE_CROSS_TOPIC', 'anchor 不属于该主题');
    const ancestors: NodeView[] = [];
    let current = anchor.from === null ? undefined : snapshot.nodes.find((node) => node.id === anchor.from);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      ancestors.push(current);
      current = current.from === null ? undefined : snapshot.nodes.find((node) => node.id === current?.from);
    }
    ancestors.reverse();
    const next = anchor.nextId === null ? undefined : snapshot.nodes.find((node) => node.id === anchor.nextId);
    const branches = anchor.branchIds.map((id) => snapshot.nodes.find((node) => node.id === id)).filter((node): node is NodeView => node !== undefined);
    const existing = new Set([anchor.id, ...ancestors.map((node) => node.id), ...(next ? [next.id] : []), ...branches.map((node) => node.id)]);
    const important = topicNodes.filter((node) => node.important && !existing.has(node.id)).slice(0, 5);
    const recentIds = topic.lastChangeIds.filter((id) => !existing.has(id)).slice(0, 5);
    const recent = recentIds.map((id) => snapshot.nodes.find((node) => node.id === id)).filter((node): node is NodeView => node !== undefined);
    const items: ContentCandidate[] = [
      { node: anchor, role: 'anchor', omitted: false },
      ...ancestors.map((node) => ({ node, role: 'ancestor' as const, omitted: true })),
      ...(next ? [{ node: next, role: 'next' as const, omitted: true }] : []),
      ...branches.map((node) => ({ node, role: 'branch' as const, omitted: true })),
      ...important.map((node) => ({ node, role: 'important' as const, omitted: true })),
      ...recent.map((node) => ({ node, role: 'recent' as const, omitted: true })),
    ];
    return { topic, items, note: 'anchor 正文＋来路和附近分支的摘要；其他内容按需展开。' };
  }
  const ids = request.nodeIds ?? [];
  if (ids.length === 0) throw new DomainError('INVALID_READ', 'content 需要 --node');
  const items: ContentCandidate[] = ids.map((id) => ({ node: findNode(snapshot, id), omitted: request.meta === true }));
  for (const item of items) {
    if (item.node.topicId !== topicId) throw new DomainError('NODE_CROSS_TOPIC', 'content 节点不属于该主题');
  }
  return { topic, items, note: '按请求顺序读取节点正文；正文超过预算时可继续分页。' };
}

function segmentFor(node: NodeView, request: ReadRequest, startOverride?: number): ReturnType<typeof sliceBody> | null {
  if (request.meta === true) return null;
  let start = startOverride ?? request.start ?? 0;
  if (startOverride === undefined && request.section !== undefined) {
    try {
      const found = locateSection(node.body, request.section, request.sectionIndex);
      start = found.start;
    } catch (error) {
      throw new DomainError('INVALID_READ', error instanceof Error ? error.message : String(error), 422);
    }
  }
  const length = request.length ?? DEFAULT_READ_LENGTH;
  if (!request.full && (!Number.isInteger(length) || length < 1)) {
    throw new DomainError('INVALID_READ', 'length 必须是正整数', 422);
  }
  return sliceBody(node.body, { start, length: Math.min(length, MAX_READ_SEGMENT), full: request.full === true });
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}
function decodeCursor(raw: string): CursorState {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CursorState;
    if (value.v !== 2 || typeof value.topicId !== 'string') throw new Error('bad');
    if (!isCursorScope(value.scope)) throw new Error('bad');
    if (value.bodyMode !== 'segment' && value.bodyMode !== 'full' && value.bodyMode !== 'meta') throw new Error('bad');
    if (!Number.isInteger(value.length) || value.length < 1) throw new Error('bad');
    return value;
  } catch {
    throw new DomainError('INVALID_READ', 'cursor 无效或已过期', 400);
  }
}

function isCursorScope(value: unknown): value is ReadScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  if (scope['kind'] === 'topic') return true;
  if (scope['kind'] === 'subtree') return typeof scope['from'] === 'string' && scope['from'].length > 0;
  if (scope['kind'] === 'nodes') return Array.isArray(scope['nodeIds']) && scope['nodeIds'].every((id) => typeof id === 'string');
  return false;
}

function cursorRequest(request: ReadRequest, cursor: CursorState): ReadRequest {
  const scope = cursor.scope;
  return {
    ...request,
    view: cursor.view,
    topicId: cursor.topicId,
    ...(scope.kind === 'nodes' ? { nodeIds: scope.nodeIds } : { nodeIds: undefined }),
    ...(scope.kind === 'subtree' ? { from: scope.from } : { from: undefined }),
    anchor: cursor.anchor,
    start: cursor.start,
    ...(cursor.bodyMode === 'meta'
      ? { meta: true, full: false }
      : cursor.bodyMode === 'full'
        ? { meta: false, full: true }
        : { meta: false, full: false, length: cursor.length }),
    section: undefined,
    sectionIndex: undefined,
  };
}

function usedOf(response: ReadViewResponse): number {
  let used = 0;
  for (let i = 0; i < 8; i += 1) {
    const text = JSON.stringify({ ...response, budget: { ...response.budget, used } });
    const next = text.length + 1;
    if (next === used) return used;
    used = next;
  }
  return used;
}

function finalBudget<T extends { budget: ReadBudget }>(response: T): T {
  let used = usedOf(response as unknown as ReadViewResponse);
  for (let i = 0; i < 4; i += 1) {
    const next = usedOf({ ...(response as unknown as ReadViewResponse), budget: { ...response.budget, used } });
    if (next === used) break;
    used = next;
  }
  response.budget.used = used;
  return response;
}

export function readView(
  snapshot: Snapshot,
  request: ReadRequest,
  source: 'online' | 'disk' | 'database' = 'online',
): ReadViewResponse {
  const budget = request.budget;
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_READ_BUDGET) {
    throw new DomainError('INVALID_READ', 'budget 必须是 1-' + String(MAX_READ_BUDGET) + ' 的整数', 400);
  }
  const cursor = request.cursor === undefined ? null : decodeCursor(request.cursor);
  const effective: ReadRequest = cursor === null
    ? { ...request }
    : cursorRequest(request, cursor);
  if (effective.topicId === undefined) throw new DomainError('INVALID_READ', 'read 需要主题或 cursor');
  const view = effective.view;
  const built = candidatesFor(snapshot, effective);
  const topic = built.topic;
  const fingerprint = fingerprintOf(snapshot, topic, built.items.map((item) => item.node.id));
  if (cursor !== null && cursor.fingerprint !== fingerprint) {
    throw new DomainError('STALE_READ', '相关节点已变化；请丢弃旧 cursor，从原范围重新读取', 409);
  }
  const scope = scopeOf(effective, built);
  const bodyMode: CursorState['bodyMode'] = effective.meta === true
    ? 'meta'
    : effective.full === true
      ? 'full'
      : 'segment';
  const bodyLength = bodyMode === 'segment' ? (effective.length ?? DEFAULT_READ_LENGTH) : 1;
  const cursorFor = (index: number, start: number): string => encodeCursor({
    v: 2,
    view,
    topicId: topic.id,
    scope,
    anchor: effective.anchor,
    index,
    start,
    bodyMode,
    length: bodyLength,
    fingerprint,
  });
  const startIndex = cursor?.index ?? 0;
  let bodyStart = cursor?.start ?? 0;
  const items: ReadItem[] = [];
  let index = startIndex;

  const build = (cutoff: number, nextToken?: string): ReadViewResponse => {
    const candidate: ReadViewResponse = {
      ok: true, command: 'read', source, workspaceId: snapshot.workspaceId, view,
      topicId: topic.id, topicTitle: topic.title,
      scope: { ...scope, nodeCount: built.items.length, note: built.note },
      ...(view === 'resume' && effective.anchor !== undefined ? { anchorId: effective.anchor } : {}),
      items: items.slice(0, cutoff),
      page: { hasMore: nextToken !== undefined, ...(nextToken !== undefined ? { next: nextToken } : {}) },
      budget: { unit: 'utf16', limit: budget, used: 0, mode: 'auto' },
      fingerprint,
      diagnostics: [],
    };
    return candidate;
  };

  while (index < built.items.length) {
    const candidate = built.items[index] as ContentCandidate;
    const segment = candidate.omitted || effective.meta === true ? null : segmentFor(candidate.node, effective, bodyStart);
    const item: ReadItem = {
      node: readNode(candidate.node),
      ...(candidate.role !== undefined ? { role: candidate.role } : {}),
      ...(segment !== null
        ? { body: segment.text, range: segment.range, truncated: segment.truncated }
        : { omitted: true as const }),
    };
    items.push(item);
    const moreAfterBody = segment !== null && segment.range.end < segment.range.total;
    const nextToken = moreAfterBody
      ? cursorFor(index, segment.range.end)
      : (index + 1 < built.items.length ? cursorFor(index + 1, 0) : undefined);
    const response = build(items.length, nextToken);
    if (usedOf(response) <= budget) {
      bodyStart = 0;
      if (nextToken === undefined) {
        index += 1;
        break;
      }
      if (moreAfterBody) {
        return finalBudget(response);
      }
      index += 1;
      continue;
    }

    // Doesn't fit: shrink the first body segment, otherwise stop before this item.
    if (items.length === 1 && segment !== null) {
      let low = 0;
      let high = segment.text.length;
      let best: ReadItem | null = null;
      let bestToken: string | undefined;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const shorter = sliceBody(candidate.node.body, { start: segment.range.start, length: Math.max(1, mid) });
        const item2: ReadItem = {
          node: readNode(candidate.node),
          ...(candidate.role !== undefined ? { role: candidate.role } : {}),
          body: shorter.text,
          range: shorter.range,
          truncated: shorter.truncated,
        };
        items[0] = item2;
        const token = shorter.range.end < shorter.range.total
          ? cursorFor(0, shorter.range.end)
          : (built.items.length > 1 ? cursorFor(1, 0) : undefined);
        const r = build(1, token);
        if (usedOf(r) <= budget) {
          best = item2;
          bestToken = token;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (best === null) {
        throw new DomainError('BUDGET_TOO_SMALL', '预算不足以容纳最小读取页；请增大 budget', 400, { minimum: usedOf(build(1)) });
      }
      items[0] = best;
      return finalBudget(build(1, bestToken));
    }

    items.pop();
    if (items.length === 0) {
      throw new DomainError('BUDGET_TOO_SMALL', '预算不足以容纳最小读取页；请增大 budget', 400, { minimum: usedOf(build(0)) });
    }
    const token = cursorFor(index, bodyStart);
    return finalBudget(build(items.length, token));
  }

  return finalBudget(build(items.length));
}

export function findTopicSafe(snapshot: Snapshot, topicId: string): TopicView { return findTopic(snapshot, topicId); }
export function publicGraphNode(node: NodeView): GraphNode { return publicNode(node); }
export type { BodyRange };
