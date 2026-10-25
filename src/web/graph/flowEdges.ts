import type { Edge } from '@xyflow/react';
import type { GraphResponse } from '../../shared/protocol.js';
import type { LayoutResult } from '../layout/types.js';
import { connectionText, type GraphView } from './viewModel.js';

/**
 * Display edges for one layout result.
 *
 * One relationship is still exactly one edge, and the shared vertical trunk of
 * a branch group is a separate, relationship-free edge drawn once. Counting
 * stays checkable — relationship edges equal the visible parent links, display
 * paths equal that plus the trunks.
 *
 * Label geometry comes from layout (`route.label`); this module never places a
 * label. Kept outside the React component so tests and non-canvas callers do not
 * pull in @xyflow/react at runtime.
 */
export function buildFlowEdges(layout: LayoutResult, view: GraphView): Edge[] {
  const routes = new Map(layout.edgeRoutes.map((route) => [route.id, route]));
  const edges: Edge[] = [];

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
      // The shared run belongs to no relationship and must not steal pointer
      // gestures from the canvas.
      interactionWidth: 0,
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
      // Current relationship wording, kept on the edge for callers/tooltips.
      // The painted text is `route.label.lines`, because layout owns the box.
      label: connectionText(node) || undefined,
      // The route carries its own points and label box; no UI-side placement.
      data: { route },
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
