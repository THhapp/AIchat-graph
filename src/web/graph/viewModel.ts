import type { GraphNode, GraphResponse } from '../../shared/protocol.js';
import type { LayoutNodeInput } from '../layout/types.js';
import { cardHeightForTitle } from './cardMetrics.js';

/** The relationship sentence drawn on the connector. */
export function connectionText(node: Pick<GraphNode, 'description'>): string {
  return (node.description ?? '').trim();
}

/**
 * A layout input row plus this card's own height. Layout accepts a per-node height
 * hint; the shared `cardHeight` stays the fallback for callers that omit it.
 */
export interface LayoutNodeWithHeight extends LayoutNodeInput {
  height: number;
}

export interface GraphView {
  nodes: GraphNode[];
  visibleIds: ReadonlySet<string>;
  collapsedIds: string[];
  topicFilter: string | null;
  /** Descendants hidden behind each collapsed node, for the "+N" badge. */
  hiddenDescendantCounts: Map<string, number>;
  /**
   * Changes with structure, filter, collapse, title height and relationship
   * wording: label wrapping and label height are layout geometry. When wording
   * changes, the layout recomputes but the reading-anchor compensation keeps the
   * current card in place. Summary text never affects geometry.
   */
  structureKey: string;
  layoutNodes: LayoutNodeWithHeight[];
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
  const layoutNodes: LayoutNodeWithHeight[] = nodes.map((node) => {
    // A topic boundary can expose a parent outside the graph being drawn. Only
    // the layout treats that entry as a local root; the source relationship stays.
    const localRoot = node.from !== null && !byId.has(node.from);
    return {
      id: node.id,
      from: localRoot ? null : node.from,
      flow: localRoot ? 'root' : node.flow,
      order: !localRoot && node.flow === 'branch' ? node.order ?? null : null,
      // Layout measures this sentence's label box; the full text is passed, so
      // wrapping and height are part of the geometry. The source `side` is not
      // interpreted: v5 always unfolds branches to the right.
      label: connectionText(node) || null,
      topicId: node.topicId,
      height: cardHeightForTitle(node.title),
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
      JSON.stringify([
        node.id,
        node.from ?? '',
        node.flow,
        String(node.order ?? ''),
        // Full wording, not just presence: the label box wraps and reserves
        // vertical space, so a rewording changes the layout geometry.
        connectionText(node),
        String(cardHeightForTitle(node.title)),
        node.topicId,
      ]),
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

/** Anchor = selected node, else nearest visible ancestor, else root. */
export function findAnchorNodeId(view: GraphView, selectedId: string | null, graph: GraphResponse): string | null {
  if (selectedId === null) return graph.nodes.find((node) => node.flow === 'root')?.id ?? null;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  let current: string | null = selectedId;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    if (view.visibleIds.has(current)) return current;
    seen.add(current);
    current = byId.get(current)?.from ?? null;
  }
  return graph.nodes.find((node) => node.flow === 'root')?.id ?? null;
}
