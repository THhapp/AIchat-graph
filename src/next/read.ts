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
  v: 1;
  view: ReadViewKind;
  topicId: string;
  nodeIds: string[];
  anchor?: string | undefined;
  index: number;
  start: number;
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

function scopeOf(view: ReadViewKind, topic: TopicView, nodeIds: readonly string[]): ReadScope {
  if (view === 'overview' || view === 'resume') return { kind: 'topic' };
  return { kind: 'nodes', nodeIds: [...nodeIds] };
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
    if (value.v !== 1 || typeof value.topicId !== 'string' || !Array.isArray(value.nodeIds)) throw new Error('bad');
    return value;
  } catch {
    throw new DomainError('INVALID_READ', 'cursor 无效或已过期', 400);
  }
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
  const view = cursor?.view ?? request.view;
  const topicId = cursor?.topicId ?? request.topicId;
  if (topicId === undefined) throw new DomainError('INVALID_READ', 'read 需要主题或 cursor');
  const effective: ReadRequest = {
    ...request,
    view,
    topicId,
    nodeIds: cursor?.nodeIds ?? request.nodeIds,
    anchor: cursor?.anchor ?? request.anchor,
    section: cursor === null ? request.section : undefined,
    sectionIndex: cursor === null ? request.sectionIndex : undefined,
  };
  const built = candidatesFor(snapshot, effective);
  const topic = built.topic;
  const fingerprint = fingerprintOf(snapshot, topic, built.items.map((item) => item.node.id));
  if (cursor !== null) {
    if (cursor.fingerprint !== fingerprint) {
      throw new DomainError('STALE_READ', '相关节点已变化；请丢弃旧 cursor，从原范围重新读取', 409);
    }
  }
  const startIndex = cursor?.index ?? 0;
  let bodyStart = cursor?.start ?? 0;
  const items: ReadItem[] = [];
  let index = startIndex;
  let hasMore = false;
  let next: string | undefined;

  const build = (cutoff: number, withNext: boolean): ReadViewResponse => {
    const scope: ReadScope = scopeOf(view, topic, built.items.map((item) => item.node.id));
    const candidate: ReadViewResponse = {
      ok: true, command: 'read', source, workspaceId: snapshot.workspaceId, view,
      topicId: topic.id, topicTitle: topic.title,
      scope: { ...scope, nodeCount: built.items.length, note: built.note },
      ...(view === 'resume' && effective.anchor !== undefined ? { anchor: publicNode(findNode(snapshot, effective.anchor)) } : {}),
      items: items.slice(0, cutoff),
      page: { hasMore: withNext, ...(withNext ? { next: '' } : {}) },
      budget: { unit: 'utf16', limit: budget, used: 0, mode: 'auto' },
      fingerprint,
      diagnostics: [],
    };
    if (withNext) {
      const lastIndex = cutoff - 1;
      const state: CursorState = {
        v: 1, view, topicId: topic.id, nodeIds: built.items.map((item) => item.node.id), anchor: effective.anchor,
        index: Math.max(0, lastIndex), start: items[lastIndex]?.range.end ?? 0, fingerprint,
      };
      candidate.page.next = encodeCursor(state);
    }
    return candidate;
  };

  while (index < built.items.length) {
    const candidate = built.items[index] as ContentCandidate;
    const segment = candidate.omitted ? null : segmentFor(candidate.node, effective, bodyStart);
    const range = segment?.range ?? { start: bodyStart, end: bodyStart, total: candidate.node.body.length, unit: 'utf16' as const };
    const item: ReadItem = {
      node: publicNode(candidate.node),
      ...(candidate.role !== undefined ? { role: candidate.role } : {}),
      body: segment?.text ?? '',
      range,
      truncated: segment?.truncated ?? false,
      ...(candidate.omitted ? { omitted: true } : {}),
    };
    const trial = [...items, item];
    const old = items.length;
    items.push(item);
    const moreAfterBody = segment !== null && segment.range.end < segment.range.total;
    hasMore = moreAfterBody || index + 1 < built.items.length;
    const response = build(items.length, hasMore);
    const length = usedOf(response);
    if (length <= budget) {
      bodyStart = 0;
      if (!hasMore) { index += 1; break; }
      if (moreAfterBody) {
        next = encodeCursor({ v: 1, view, topicId: topic.id, nodeIds: built.items.map((entry) => entry.node.id), anchor: effective.anchor, index, start: range.end, fingerprint });
        hasMore = true;
        break;
      }
      index += 1;
      continue;
    }
    // Doesn't fit: shrink first/single body, otherwise stop before this item.
    if (items.length === 1 && segment !== null) {
      let low = 0;
      let high = segment.text.length;
      let best: ReadItem | null = null;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const shorter = sliceBody(candidate.node.body, { start: range.start, length: Math.max(1, mid) });
        const item2: ReadItem = { node: publicNode(candidate.node), ...(candidate.role !== undefined ? { role: candidate.role } : {}), body: shorter.text, range: shorter.range, truncated: shorter.truncated };
        items[0] = item2;
        const r = build(1, true);
        if (usedOf(r as unknown as ReadViewResponse) <= budget) { best = item2; low = mid + 1; } else high = mid - 1;
      }
      if (best === null) {
        throw new DomainError('BUDGET_TOO_SMALL', '预算不足以容纳最小读取页；请增大 budget', 400, { minimum: usedOf(build(1, false)) });
      }
      items[0] = best;
      hasMore = best.range.end < best.range.total || index + 1 < built.items.length;
      next = encodeCursor({ v: 1, view, topicId: topic.id, nodeIds: built.items.map((entry) => entry.node.id), anchor: effective.anchor, index, start: best.range.end, fingerprint });
      break;
    }
    items.pop();
    if (old === 0) throw new DomainError('BUDGET_TOO_SMALL', '预算不足以容纳最小读取页；请增大 budget', 400, { minimum: usedOf(build(1, false)) });
    hasMore = true;
    next = encodeCursor({ v: 1, view, topicId: topic.id, nodeIds: built.items.map((entry) => entry.node.id), anchor: effective.anchor, index: old - 1, start: items[old - 1]?.range.end ?? 0, fingerprint });
    break;
  }

  const response = build(items.length, hasMore || next !== undefined);
  response.page = { hasMore: hasMore || next !== undefined, ...(next !== undefined || (hasMore && items.length > 0) ? { next: next ?? build(items.length, true).page.next } : {}) };
  return finalBudget(response);
}

export function findTopicSafe(snapshot: Snapshot, topicId: string): TopicView { return findTopic(snapshot, topicId); }
export function publicGraphNode(node: NodeView): GraphNode { return publicNode(node); }
export type { BodyRange };
