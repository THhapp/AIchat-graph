import type {
  ChangeBatchDetail,
  ChangeBatchSummary,
  ChangeCounts,
  ChangeFieldName,
  ChangeKind,
  ChangeNodeDiff,
  ChangeNodeSummary,
  GraphResponse,
} from '../../next/protocol.js';

/**
 * Display helpers for the latest content-change batch.
 *
 * Only the persisted batch is shown: there is no accumulated history, no diff
 * inference and no "recent" fallback. Deleted nodes never own a card, so card
 * labels only ever use added/modified; the topic list keeps deleted entries.
 */
export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  added: '新增',
  modified: '改动',
  deleted: '删除',
};

export const CHANGE_FIELD_LABEL: Record<ChangeFieldName, string> = {
  title: '标题',
  summary: '摘要',
  from: '来源',
  flow: '流程',
  description: '入边说明',
  side: '侧',
  order: '顺序',
};

export function changeKindLabel(kind: ChangeKind): string {
  return CHANGE_KIND_LABEL[kind] ?? kind;
}

export function changeFieldLabel(field: ChangeFieldName): string {
  return CHANGE_FIELD_LABEL[field] ?? field;
}

/** A before/after value; null means the field was absent on that side. */
export function formatChangeValue(value: string | number | null): string {
  return value === null ? '（空）' : String(value);
}

/** "新增 1 · 改动 2 · 删除 1" for the topic change list. */
export function changeCountsLabel(counts: ChangeCounts): string {
  return '新增 ' + String(counts.added) + ' · 改动 ' + String(counts.modified) + ' · 删除 ' + String(counts.deleted);
}

/** Latest persisted batch for one topic, or null when there is none. */
export function topicChangeBatch(
  graph: Pick<GraphResponse, 'lastChanges'> | null | undefined,
  topicId: string | null | undefined,
): ChangeBatchSummary | null {
  if (topicId === null || topicId === undefined || topicId.length === 0) return null;
  const batch = graph?.lastChanges?.[topicId];
  if (batch === undefined || batch === null || typeof batch !== 'object') return null;
  if (!Array.isArray(batch.nodes)) return null;
  return batch;
}

/** Change kind of one node in a batch, or null when the node did not change. */
export function nodeChangeKind(
  batch: ChangeBatchSummary | null | undefined,
  nodeId: string | null | undefined,
): ChangeKind | null {
  if (batch === null || batch === undefined || nodeId === null || nodeId === undefined) return null;
  const node = batch.nodes.find((item) => item.nodeId === nodeId);
  return node?.kind ?? null;
}

/**
 * Node id -> card label kind for one topic. Deleted nodes are omitted: they have
 * no card, and the topic change list is where deletion is reported.
 */
export function cardChangeKinds(
  graph: Pick<GraphResponse, 'lastChanges'> | null | undefined,
  topicId: string | null | undefined,
): ReadonlyMap<string, ChangeKind> {
  const batch = topicChangeBatch(graph, topicId);
  const kinds = new Map<string, ChangeKind>();
  if (batch === null) return kinds;
  for (const node of batch.nodes) {
    if (node.kind === 'added' || node.kind === 'modified') kinds.set(node.nodeId, node.kind);
  }
  return kinds;
}

/** Project the frozen offline detail back to the same summary the live graph carries. */
export function changeSummaryFromDetail(
  detail: ChangeBatchDetail | null | undefined,
): ChangeBatchSummary | null {
  if (detail === null || detail === undefined || typeof detail !== 'object') return null;
  if (!Array.isArray(detail.nodes)) return null;
  return {
    requestId: detail.requestId,
    topicId: detail.topicId,
    at: detail.at,
    counts: {
      added: detail.counts?.added ?? 0,
      modified: detail.counts?.modified ?? 0,
      deleted: detail.counts?.deleted ?? 0,
    },
    nodes: detail.nodes.map((node): ChangeNodeSummary => ({
      nodeId: node.nodeId,
      kind: node.kind,
      title: node.title,
      fields: Array.isArray(node.fields) ? [...node.fields] : [],
    })),
  };
}

/** Whether the graph still has this node, i.e. clicking its change row can select a card. */
export function graphHasNode(
  graph: Pick<GraphResponse, 'nodes'> | null | undefined,
  nodeId: string | null | undefined,
): boolean {
  if (graph === null || graph === undefined || nodeId === null || nodeId === undefined) return false;
  return graph.nodes.some((node) => node.id === nodeId);
}

/** One node's frozen diff from an offline document, or null when it did not change. */
export function nodeChangeFromDetail(
  detail: ChangeBatchDetail | null | undefined,
  nodeId: string | null | undefined,
): ChangeNodeDiff | null {
  if (detail === null || detail === undefined || nodeId === null || nodeId === undefined) return null;
  if (!Array.isArray(detail.nodes)) return null;
  return detail.nodes.find((node) => node.nodeId === nodeId) ?? null;
}
