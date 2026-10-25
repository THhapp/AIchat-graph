import type { Edge } from '@xyflow/react';
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
 * Relationship edges are added first and trunks last, so the shared run is
 * painted over the branch stubs that meet it. Label geometry comes from layout
 * (`route.label`); this module never places a label. Kept outside the React
 * component so tests and non-canvas callers do not pull in @xyflow/react at
 * runtime.
 */
export function buildFlowEdges(layout: LayoutResult, view: GraphView): Edge[] {
  const routes = new Map(layout.edgeRoutes.map((route) => [route.id, route]));
  const edges: Edge[] = [];

  for (const node of view.nodes) {
    if (node.from === null || !view.visibleIds.has(node.from)) continue;
    if (layout.positions[node.id] === undefined || layout.positions[node.from] === undefined) continue;
    const id = node.from + '->' + node.id;
    const route = routes.get(id) ?? null;
    // A branch that joins a shared trunk leaves the trunk as a stub; the CSS
    // uses this class for the T-junction end, so single branches do not get it.
    const stub = node.flow === 'branch' && route?.trunkId !== undefined;
    edges.push({
      id,
      source: node.from,
      target: node.id,
      type: 'route',
      className: 'rf-edge--' + node.flow + (stub ? ' rf-edge--stub' : ''),
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

  // Trunks last, so the branch stubs are painted under the shared run.
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
  return edges;
}
