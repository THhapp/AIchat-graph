import type { GraphResponse, LastChange } from '../../shared/protocol.js';

/**
 * Nodes the graph reports as changed by the latest write, per topic.
 *
 * This is a pure view of `GraphResponse.lastChanges`: nothing is accumulated,
 * nothing is stored, and view-only actions (fold, zoom, select) cannot change it.
 * A new commit replaces that topic's entry as a whole; a topic without an entry
 * has no marker at all.
 */
const EMPTY: ReadonlySet<string> = new Set<string>();

function stringIds(change: LastChange | null | undefined): string[] {
  if (change === undefined || change === null || !Array.isArray(change.nodeIds)) return [];
  return change.nodeIds.filter((id): id is string => typeof id === 'string');
}

/**
 * Recent node ids for one topic, or for the whole workspace when `topicId` is
 * null/undefined. A topic never falls back to another topic's record.
 */
export function recentNodeIds(
  graph: Pick<GraphResponse, 'lastChanges'> | null | undefined,
  topicId?: string | null,
): ReadonlySet<string> {
  const byTopic = graph?.lastChanges;
  if (byTopic === undefined || byTopic === null || typeof byTopic !== 'object') return EMPTY;

  if (typeof topicId === 'string' && topicId.length > 0) {
    const ids = stringIds(byTopic[topicId]);
    return ids.length === 0 ? EMPTY : new Set(ids);
  }

  // Whole-workspace view: every node belongs to exactly one topic, so merging
  // is safe; a Set also keeps a malformed duplicate from being drawn twice.
  const merged = new Set<string>();
  for (const change of Object.values(byTopic)) {
    for (const id of stringIds(change)) merged.add(id);
  }
  return merged.size === 0 ? EMPTY : merged;
}
