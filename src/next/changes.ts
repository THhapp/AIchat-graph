/**
 * Content change batches: the latest commit-level diff for each topic.
 *
 * Field diffs cover title/summary/from/flow/description/side/order. Body text is
 * always represented as a unified line patch with a little context, and
 * important is deliberately not a change field. A batch stores before/after
 * NodeRecord snapshots for exactly the nodes whose final values changed, so
 * readers never need old bodies elsewhere and no passive fields are invented.
 */
import { createTwoFilesPatch, diffLines } from 'diff';
import type {
  ChangeBatchDetail,
  ChangeBatchSummary,
  ChangeBodyPatch,
  ChangeCounts,
  ChangeFieldDiff,
  ChangeFieldName,
  ChangeKind,
  ChangeNodeDiff,
  ChangeNodeSummary,
} from './protocol.js';
import type { NodeRecord } from './model.js';

/** Field-level changes that belong to a batch; body has its own patch. */
export const CHANGE_FIELDS: readonly ChangeFieldName[] = [
  'title',
  'summary',
  'from',
  'flow',
  'description',
  'side',
  'order',
];

/** Small context keeps a long body from dumping two full copies. */
export const BODY_PATCH_CONTEXT_LINES = 3;
/** Hard cap on serialized unified patch characters; longer patches set truncated. */
export const MAX_BODY_PATCH_CHARS = 16_000;

/** One changed node inside a stored batch. Added: before=null, deleted: after=null. */
export interface StoredChangeNode {
  readonly nodeId: string;
  readonly kind: ChangeKind;
  readonly before: NodeRecord | null;
  readonly after: NodeRecord | null;
}

/** Persisted shape of topic_changes.nodes_json plus its row identity. */
export interface StoredChangeBatch {
  readonly topicId: string;
  readonly requestId: string;
  readonly at: string;
  readonly nodes: readonly StoredChangeNode[];
}

function titleOf(node: NodeRecord | null): string {
  return node === null ? '' : node.title;
}

export function changedFieldsOf(before: NodeRecord, after: NodeRecord): ChangeFieldName[] {
  const fields: ChangeFieldName[] = [];
  for (const field of CHANGE_FIELDS) {
    if (before[field] !== after[field]) fields.push(field);
  }
  return fields;
}

function fieldDiffOf(
  field: ChangeFieldName,
  before: NodeRecord,
  after: NodeRecord,
): ChangeFieldDiff {
  return { field, before: before[field], after: after[field] };
}

/** True when final values differ in a way that belongs to a content batch. */
function contentChangedForBatch(before: NodeRecord, after: NodeRecord): boolean {
  if (before.body !== after.body) return true;
  return changedFieldsOf(before, after).length > 0;
}

/** Build one stored node entry, or null when the final values are unchanged. */
export function changeNodeOf(
  before: NodeRecord | null,
  after: NodeRecord | null,
): StoredChangeNode | null {
  if (before === null) {
    if (after === null) return null;
    return { nodeId: after.id, kind: 'added', before: null, after };
  }
  if (after === null) return { nodeId: before.id, kind: 'deleted', before, after: null };
  if (!contentChangedForBatch(before, after)) return null;
  return { nodeId: before.id, kind: 'modified', before, after };
}

/**
 * Compute batches from the same before/candidate final node lists used by the
 * commit. Nodes are grouped by their final topic; topics with no batch are
 * absent, so callers can leave their previous persisted batch untouched.
 */
export function computeChangeBatches(
  beforeNodes: readonly NodeRecord[],
  afterNodes: readonly NodeRecord[],
  requestId: string,
  at: string,
): StoredChangeBatch[] {
  const beforeById = new Map(beforeNodes.map((node) => [node.id, node] as const));
  const afterById = new Map(afterNodes.map((node) => [node.id, node] as const));
  const ordered: StoredChangeNode[] = [];
  // Candidate order covers added + modified with their same-batch final values.
  for (const node of afterNodes) {
    const change = changeNodeOf(beforeById.get(node.id) ?? null, node);
    if (change !== null) ordered.push(change);
  }
  // Deleted nodes only exist in the before list; final deletion wins.
  for (const node of beforeNodes) {
    if (afterById.has(node.id)) continue;
    const change = changeNodeOf(node, null);
    if (change !== null) ordered.push(change);
  }
  const byTopic = new Map<string, StoredChangeNode[]>();
  for (const change of ordered) {
    const reference = change.after ?? change.before;
    if (reference === null) continue;
    const list = byTopic.get(reference.topicId);
    if (list === undefined) byTopic.set(reference.topicId, [change]);
    else list.push(change);
  }
  return [...byTopic].map(([topicId, nodes]) => ({ topicId, requestId, at, nodes }));
}

export function changeCountsOf(nodes: readonly StoredChangeNode[]): ChangeCounts {
  const counts: ChangeCounts = { added: 0, modified: 0, deleted: 0 };
  for (const node of nodes) counts[node.kind] += 1;
  return counts;
}

export function summarizeStoredBatch(batch: StoredChangeBatch): ChangeBatchSummary {
  const nodes: ChangeNodeSummary[] = batch.nodes.map((stored) => {
    const before = stored.before;
    const after = stored.after;
    return {
      nodeId: stored.nodeId,
      kind: stored.kind,
      title: titleOf(after ?? before),
      fields:
        stored.kind === 'modified' && before !== null && after !== null
          ? changedFieldsOf(before, after)
          : [],
    };
  });
  return {
    requestId: batch.requestId,
    topicId: batch.topicId,
    at: batch.at,
    counts: changeCountsOf(batch.nodes),
    nodes,
  };
}

/** Serialize two bodies into a context-limited unified patch plus line statistics. */
export function buildBodyPatch(beforeBody: string, afterBody: string): ChangeBodyPatch {
  let addedLines = 0;
  let removedLines = 0;
  for (const part of diffLines(beforeBody, afterBody)) {
    if (part.added) addedLines += part.count;
    else if (part.removed) removedLines += part.count;
  }
  const raw = createTwoFilesPatch(
    'before',
    'after',
    beforeBody,
    afterBody,
    '',
    '',
    { context: BODY_PATCH_CONTEXT_LINES },
  );
  // Drop the file header (names/headers carry no meaning for a node body) and
  // keep the hunks, which are the actual unified patch.
  const lines = raw.split('\n');
  const hunkStart = lines.findIndex((line) => line.startsWith('@@'));
  let patch = hunkStart < 0 ? '' : lines.slice(hunkStart).join('\n').replace(/\n+$/, '');
  let truncated = false;
  if (patch.length > MAX_BODY_PATCH_CHARS) {
    const kept: string[] = [];
    let used = 0;
    for (const line of patch.split('\n')) {
      if (used + line.length + 1 > MAX_BODY_PATCH_CHARS) break;
      kept.push(line);
      used += line.length + 1;
    }
    patch = kept.join('\n');
    truncated = true;
  }
  return { patch, addedLines, removedLines, truncated };
}

function bodyPatchOf(
  before: NodeRecord | null,
  after: NodeRecord | null,
): ChangeBodyPatch | undefined {
  if (before === null && after === null) return undefined;
  const beforeBody = before === null ? '' : before.body;
  const afterBody = after === null ? '' : after.body;
  if (beforeBody === afterBody) return undefined;
  return buildBodyPatch(beforeBody, afterBody);
}

export function detailNodeOf(stored: StoredChangeNode): ChangeNodeDiff {
  const before = stored.before;
  const after = stored.after;
  const fields =
    stored.kind === 'modified' && before !== null && after !== null
      ? changedFieldsOf(before, after)
      : [];
  const fieldDiffs =
    before !== null && after !== null
      ? fields.map((field) => fieldDiffOf(field, before, after))
      : [];
  // Added/deleted nodes still get a body patch (empty -> body / body -> empty)
  // so a deletion opened from the topic list is not an empty field-only card.
  const body = bodyPatchOf(before, after);
  return {
    nodeId: stored.nodeId,
    kind: stored.kind,
    title: titleOf(after ?? before),
    fields,
    beforeRevision: before === null ? null : before.revision,
    afterRevision: after === null ? null : after.revision,
    fieldDiffs,
    ...(body === undefined ? {} : { body }),
  };
}

export function detailStoredBatch(batch: StoredChangeBatch): ChangeBatchDetail {
  return {
    requestId: batch.requestId,
    topicId: batch.topicId,
    at: batch.at,
    counts: changeCountsOf(batch.nodes),
    nodes: batch.nodes.map(detailNodeOf),
  };
}

/** A batch that only removes nodes; such a commit still becomes the latest batch. */
export function isPureDeletionBatch(batch: StoredChangeBatch): boolean {
  return batch.nodes.length > 0 && batch.nodes.every((node) => node.kind === 'deleted');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeRecordLike(value: unknown): value is NodeRecord {
  if (!isRecord(value)) return false;
  return typeof value['id'] === 'string' &&
    typeof value['topicId'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['body'] === 'string' &&
    typeof value['flow'] === 'string' &&
    typeof value['important'] === 'boolean' &&
    typeof value['revision'] === 'number';
}

function parseStoredNode(value: unknown): StoredChangeNode | null {
  if (!isRecord(value)) return null;
  const nodeId = value['nodeId'];
  const kind = value['kind'];
  if (typeof nodeId !== 'string') return null;
  if (kind !== 'added' && kind !== 'modified' && kind !== 'deleted') return null;
  const beforeRaw = value['before'];
  const afterRaw = value['after'];
  const before = beforeRaw === null ? null : isNodeRecordLike(beforeRaw) ? beforeRaw : undefined;
  const after = afterRaw === null ? null : isNodeRecordLike(afterRaw) ? afterRaw : undefined;
  if (before === undefined || after === undefined) return null;
  if (kind === 'added' && (before !== null || after === null)) return null;
  if (kind === 'deleted' && (before === null || after !== null)) return null;
  if (kind === 'modified' && (before === null || after === null)) return null;
  return { nodeId, kind, before, after };
}

/** Parse persisted nodes_json defensively; damaged rows read as no batch. */
export function parseStoredNodes(json: unknown): StoredChangeNode[] {
  if (typeof json !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const nodes: StoredChangeNode[] = [];
  for (const entry of parsed) {
    const node = parseStoredNode(entry);
    if (node !== null) nodes.push(node);
  }
  return nodes;
}

/** Build a batch from a topic_changes row; invalid/corrupt nodes read as absent. */
export function parseStoredBatch(
  topicId: string,
  requestId: string,
  at: string,
  nodesJson: unknown,
): StoredChangeBatch | null {
  const nodes = parseStoredNodes(nodesJson);
  if (nodes.length === 0) return null;
  return { topicId, requestId, at, nodes };
}
