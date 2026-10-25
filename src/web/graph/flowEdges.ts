import type { Edge } from '@xyflow/react';
import type { GraphResponse } from '../../shared/protocol.js';
import type { LayoutResult } from '../layout/types.js';
import { placeRouteLabels, type LabelCardRect } from '../components/routeLabels.js';
import { connectionText, type GraphView } from './viewModel.js';

/**
 * Display edges for one layout result.
 *
 * One relationship is still exactly one edge (and one label), but the shared
 * geometry of sibling branches is now a separate, relationship-free edge: the
 * trunk is drawn once and every branch only paints its own exclusive stub from
 * the join down to its target. Counting stays checkable — relationship edges
 * equal the visible parent links, display paths equal that plus the trunks.
 *
 * Kept outside the React component so tests and non-canvas callers do not pull
 * in @xyflow/react at runtime.
 */
export function buildFlowEdges(layout: LayoutResult, view: GraphView): Edge[] {
  const routes = new Map(layout.edgeRoutes.map((route) => [route.id, route]));
  const edges: Edge[] = [];

  // Relationship text is display-only, but every label box is placed here in
  // one deterministic pass: cards, shared trunks, the other routes and the
  // labels placed before it are all subtracted from the candidate slots. The
  // renderer only draws the precomputed box, so live and offline geometry are
  // identical.
  const cards: LabelCardRect[] = Object.entries(layout.positions).map(([id, position]) => ({
    x: position.x,
    y: position.y,
    width: layout.cardWidth,
    height: layout.heights[id] ?? layout.cardHeight,
  }));
  const labelTexts = new Map<string, string>();
  for (const node of view.nodes) {
    if (node.from === null) continue;
    const text = connectionText(node);
    if (text !== '') labelTexts.set(node.from + '->' + node.id, text);
  }
  const labelBoxes = placeRouteLabels(layout.edgeRoutes, layout.branchTrunks ?? [], cards, labelTexts);

  // Trunks first, so the branch stubs are painted over the shared run.
  for (const trunk of layout.branchTrunks ?? []) {
    if (trunk.points.length < 2) continue;
    // `to` is only the node that mounts the display edge (the farthest member);
    // the geometry comes from `points`, never from the node positions.
    if (!view.visibleIds.has(trunk.from) || !view.visibleIds.has(trunk.to)) continue;
    if (layout.positions[trunk.from] === undefined || layout.positions[trunk.to] === undefined) continue;
    edges.push({
      id: 'trunk|' + trunk.id,
      source: trunk.from,
      target: trunk.to,
      type: 'trunk',
      className: 'rf-edge--trunk',
      data: { trunk },
      selectable: false,
      focusable: false,
      deletable: false,
    });
  }

  for (const node of view.nodes) {
    if (node.from === null || !view.visibleIds.has(node.from)) continue;
    if (layout.positions[node.id] === undefined || layout.positions[node.from] === undefined) continue;
    const id = node.from + '->' + node.id;
    const route = routes.get(id) ?? null;
    edges.push({
      id,
      source: node.from,
      target: node.id,
      type: 'route',
      className: 'rf-edge--' + node.flow,
      // The relationship sentence is description; the connector is the only
      // place it is drawn.
      label: connectionText(node) || undefined,
      data: { flow: node.flow, route, labelBox: route === null ? null : labelBoxes.get(route.id) ?? null },
      selectable: false,
      focusable: false,
      deletable: false,
    });
  }
  return edges;
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
