import type { GraphNode, GraphResponse } from '../../shared/protocol.js';
import type { LayoutNodeInput } from '../layout/types.js';

export interface GraphView {
  nodes: GraphNode[];
  visibleIds: ReadonlySet<string>;
  collapsedIds: string[];
  topicFilter: string | null;
  /** Descendants hidden behind each collapsed node, for the "+N" badge. */
  hiddenDescendantCounts: Map<string, number>;
  /** Changes only with structure/filter/collapse: text edits keep the same key. */
  structureKey: string;
  layoutNodes: LayoutNodeInput[];
  /** Number of direct children in the whole graph (0 = leaf). */
  childCounts: Map<string, number>;
}

/** A reading boundary, not a source mutation or shared Agent focus. */
export function scopeGraphToTopic(graph: GraphResponse, topicId: string | null): GraphResponse {
  const topics = graph.topics.filter((topic) => topic.id === topicId);
  const nodes = graph.nodes.filter((node) => node.topicId === topicId && topics.length > 0);
  return {
    ...graph, topics, nodes,
    activeNode: nodes.some((node) => node.id === graph.activeNode) ? graph.activeNode : null,
  };
}

function childrenMap(graph: GraphResponse): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.from === null) continue;
    const list = children.get(node.from);
    if (list === undefined) children.set(node.from, [node.id]);
    else list.push(node.id);
  }
  return children;
}

function descendantsOf(id: string, children: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    const grand = children.get(next);
    if (grand !== undefined) stack.push(...grand);
  }
  return [...seen];
}

function ancestorsOf(id: string, byId: Map<string, GraphNode>): string[] {
  const result: string[] = [];
  const seen = new Set<string>([id]);
  let current = byId.get(id)?.from ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    current = byId.get(current)?.from ?? null;
  }
  return result;
}

/**
 * UI-only filtering. Hidden nodes stay in the domain graph and source files; they
 * are simply not laid out or drawn. Topic focus keeps ancestor paths visible.
 */
export function buildGraphView(
  graph: GraphResponse,
  collapsed: ReadonlySet<string>,
  topicFilter: string | null,
): GraphView {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = childrenMap(graph);
  const base = new Set<string>(graph.nodes.map((node) => node.id));

  if (topicFilter !== null) {
    const topic = graph.topics.find((candidate) => candidate.id === topicFilter);
    const keep = new Set<string>();
    for (const id of topic?.nodeIds ?? []) {
      keep.add(id);
      for (const ancestor of ancestorsOf(id, byId)) keep.add(ancestor);
    }
    for (const id of [...base]) if (!keep.has(id)) base.delete(id);
  }

  const hidden = new Set<string>();
  for (const id of collapsed) {
    if (!base.has(id)) continue;
    for (const descendant of descendantsOf(id, children)) {
      if (base.has(descendant)) hidden.add(descendant);
    }
  }

  const visibleIds = new Set<string>();
  for (const id of base) if (!hidden.has(id)) visibleIds.add(id);

  // The count shown on a collapsed card is "how many cards this collapse hides",
  // so it is limited to the current topic-filtered base set. Nodes already removed
  // by the topic filter are not attributable to collapsing.
  const hiddenDescendantCounts = new Map<string, number>();
  for (const id of collapsed) {
    if (!byId.has(id) || !base.has(id)) continue;
    let count = 0;
    for (const descendant of descendantsOf(id, children)) {
      if (base.has(descendant)) count += 1;
    }
    if (count > 0) hiddenDescendantCounts.set(id, count);
  }

  const nodes = graph.nodes.filter((node) => visibleIds.has(node.id));
  const layoutNodes: LayoutNodeInput[] = nodes.map((node) => {
    // Shared legacy topics can enter from outside the reading boundary. Only
    // the layout treats that entry as a local root; source relationship stays.
    const localRoot = node.from !== null && !byId.has(node.from);
    return {
      id: node.id,
      from: localRoot ? null : node.from,
      flow: localRoot ? 'root' : node.flow,
      side: !localRoot && node.flow === 'branch' ? node.side ?? null : null,
      order: !localRoot && node.flow === 'branch' ? node.order ?? null : null,
      label: node.label ?? null,
      topicId: node.topicId,
    };
  });

  // Counted over the whole graph: a collapsed node still has children and must
  // keep its expand control, even though none of them are visible.
  const childCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.from === null) continue;
    childCounts.set(node.from, (childCounts.get(node.from) ?? 0) + 1);
  }

  const keyParts = nodes
    .map((node) =>
      [node.id, node.from ?? '', node.flow, node.side ?? '', String(node.order ?? ''), node.label ?? '', node.topicId].join('~'),
    )
    .sort();
  const structureKey = [topicFilter ?? '*', [...collapsed].sort().join(','), keyParts.join('|')].join('#');

  return {
    nodes,
    visibleIds,
    collapsedIds: [...collapsed].filter((id) => visibleIds.has(id)),
    topicFilter,
    hiddenDescendantCounts,
    structureKey,
    layoutNodes,
    childCounts,
  };
}
