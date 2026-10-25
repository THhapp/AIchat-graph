/** Reading anchor, orthogonal routes, relation labels and bounds. */
import {
  EDGE_LABEL_FONT,
  EDGE_LABEL_PAD_Y,
  LAYOUT_LABEL_GAP,
  LAYOUT_TRUNK_INSET,
  edgeLabelBoxSize,
  type EdgeLabelBoxSize,
} from '../graph/cardMetrics.js';
import { isRecord } from '../../shared/guards.js';
import { compareIds, type LayoutConfig, type VisibleTree, type WorkingNode } from './internal.js';
import { branchLabelMaxWidth, nextLabelMaxWidth } from './measure.js';
import type {
  LayoutBranchTrunk,
  LayoutEdgeRoute,
  LayoutLabelBox,
  LayoutPoint,
  LayoutPosition,
  LayoutRect,
} from './types.js';

interface BranchEntry {
  child: WorkingNode;
  target: LayoutPosition;
  /** Entry port: centre of the target head card's left edge. */
  entryY: number;
}

export interface BuiltRoutes {
  routes: LayoutEdgeRoute[];
  trunks: LayoutBranchTrunk[];
}

/**
 * Shifts every node so the primary root returns to its previous top-left
 * coordinate. Routes and labels are generated after this step, so they move
 * with the cards automatically.
 */
export function applyPreviousAnchor(
  raw: unknown,
  primaryRoot: WorkingNode | undefined,
  positions: Map<string, LayoutPosition>,
): void {
  if (primaryRoot === undefined || !isRecord(raw)) return;
  const previous = raw[primaryRoot.id];
  if (!isRecord(previous)) return;
  const x = previous.x;
  const y = previous.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const current = positions.get(primaryRoot.id);
  if (current === undefined) return;
  const dx = x - current.x;
  const dy = y - current.y;
  if (dx === 0 && dy === 0) return;
  for (const [id, position] of positions) positions.set(id, { x: position.x + dx, y: position.y + dy });
}

function labelBoxFrom(size: EdgeLabelBoxSize, left: number, top: number, centerX: number): LayoutLabelBox {
  return {
    x: left,
    y: top,
    left,
    top,
    width: size.width,
    height: size.height,
    centerX,
    baseline: top + EDGE_LABEL_PAD_Y + EDGE_LABEL_FONT,
    lines: size.lines,
  };
}

function labelSize(text: string | null | undefined, maxWidth: number): EdgeLabelBoxSize | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  const size = edgeLabelBoxSize(text, maxWidth);
  return size.lines.length === 0 ? undefined : size;
}

function branchExitY(source: LayoutPosition, sourceHeight: number, firstEntryY: number): number {
  const low = source.y + 12;
  const high = source.y + sourceHeight - 12;
  if (high < low) return source.y + sourceHeight / 2;
  return Math.min(high, Math.max(low, firstEntryY));
}

/** Branch labels sit above their own entry run; measurement reserves the same gap. */
function branchLabelTop(entryY: number, labelHeight: number): number {
  return entryY - LAYOUT_LABEL_GAP - labelHeight;
}

/**
 * Builds next routes, branch routes, shared vertical trunks and all relation
 * label boxes. `positions` already contains the final reading-anchor offset.
 */
export function buildEdgeRoutes(
  byId: ReadonlyMap<string, WorkingNode>,
  tree: VisibleTree,
  positions: ReadonlyMap<string, LayoutPosition>,
  config: LayoutConfig,
): BuiltRoutes {
  const { cardWidth } = config;
  const routes: LayoutEdgeRoute[] = [];
  const trunks: LayoutBranchTrunk[] = [];
  const nextMaxWidth = nextLabelMaxWidth(config);
  const branchMaxWidth = branchLabelMaxWidth(config);

  // 1. next: bottom-centre to top-centre; equal x collapses to one segment.
  for (const [fromId, child] of tree.nextByParent) {
    const sourceNode = byId.get(fromId);
    const source = positions.get(fromId);
    const target = positions.get(child.id);
    if (sourceNode === undefined || source === undefined || target === undefined) continue;
    const centerX = source.x + cardWidth / 2;
    const route: LayoutEdgeRoute = {
      id: fromId + '->' + child.id,
      from: fromId,
      to: child.id,
      flow: 'next',
      points: simplifyPoints([
        { x: centerX, y: source.y + sourceNode.height },
        { x: target.x + cardWidth / 2, y: target.y },
      ]),
    };
    const size = labelSize(child.label, nextMaxWidth);
    if (size !== undefined) {
      route.label = labelBoxFrom(
        size,
        centerX - size.width / 2,
        source.y + sourceNode.height + LAYOUT_LABEL_GAP,
        centerX,
      );
    }
    routes.push(route);
  }

  // 2. branch: one shared riser per source when it has more than one child.
  for (const [fromId, children] of tree.branchesByParent) {
    const sourceNode = byId.get(fromId);
    const source = positions.get(fromId);
    if (sourceNode === undefined || source === undefined || children.length === 0) continue;
    const entries: BranchEntry[] = [];
    for (const child of children) {
      const target = positions.get(child.id);
      if (target === undefined) continue;
      entries.push({ child, target, entryY: target.y + child.height / 2 });
    }
    if (entries.length === 0) continue;

    const sourceEdge = source.x + cardWidth;
    const channelX = sourceEdge + LAYOUT_TRUNK_INSET;
    const first = entries[0];
    if (first === undefined) continue;
    const exitY = branchExitY(source, sourceNode.height, first.entryY);

    if (entries.length === 1) {
      const route: LayoutEdgeRoute = {
        id: fromId + '->' + first.child.id,
        from: fromId,
        to: first.child.id,
        flow: 'branch',
        points: simplifyPoints([
          { x: sourceEdge, y: exitY },
          { x: channelX, y: exitY },
          { x: channelX, y: first.entryY },
          { x: first.target.x, y: first.entryY },
        ]),
      };
      const size = labelSize(first.child.label, branchMaxWidth);
      if (size !== undefined) {
        const left = channelX + 4;
        route.label = labelBoxFrom(
          size,
          left,
          branchLabelTop(first.entryY, size.height),
          left + size.width / 2,
        );
      }
      routes.push(route);
      continue;
    }

    const last = entries[entries.length - 1];
    if (last === undefined) continue;
    const trunkId = fromId + '~branches';
    trunks.push({
      id: trunkId,
      from: fromId,
      to: last.child.id,
      points: simplifyPoints([
        { x: sourceEdge, y: exitY },
        { x: channelX, y: exitY },
        { x: channelX, y: last.entryY },
      ]),
    });

    for (const entry of entries) {
      const route: LayoutEdgeRoute = {
        id: fromId + '->' + entry.child.id,
        from: fromId,
        to: entry.child.id,
        flow: 'branch',
        trunkId,
        points: simplifyPoints([
          { x: channelX, y: entry.entryY },
          { x: entry.target.x, y: entry.entryY },
        ]),
      };
      const size = labelSize(entry.child.label, branchMaxWidth);
      if (size !== undefined) {
        const left = channelX + 4;
        route.label = labelBoxFrom(
          size,
          left,
          branchLabelTop(entry.entryY, size.height),
          left + size.width / 2,
        );
      }
      routes.push(route);
    }
  }

  routes.sort((a, b) => compareIds(a.id, b.id));
  trunks.sort((a, b) => compareIds(a.id, b.id));
  return { routes, trunks };
}

function simplifyPoints(raw: LayoutPoint[]): LayoutPoint[] {
  const deduped: LayoutPoint[] = [];
  for (const point of raw) {
    const last = deduped[deduped.length - 1];
    if (last !== undefined && Math.abs(last.x - point.x) < 1e-9 && Math.abs(last.y - point.y) < 1e-9) continue;
    deduped.push({ x: point.x, y: point.y });
  }

  let changed = true;
  while (changed && deduped.length > 2) {
    changed = false;
    for (let index = 1; index < deduped.length - 1; index += 1) {
      const a = deduped[index - 1];
      const b = deduped[index];
      const c = deduped[index + 1];
      if (a === undefined || b === undefined || c === undefined) continue;
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(cross) < 1e-9) {
        deduped.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return deduped;
}

export function computeBounds(
  positions: Record<string, LayoutPosition>,
  heights: Record<string, number>,
  cardWidth: number,
  labels: readonly LayoutRect[],
): LayoutRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [id, position] of Object.entries(positions)) {
    const height = heights[id] ?? 0;
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + cardWidth);
    maxY = Math.max(maxY, position.y + height);
  }
  for (const label of labels) {
    minX = Math.min(minX, label.x);
    minY = Math.min(minY, label.y);
    maxX = Math.max(maxX, label.x + label.width);
    maxY = Math.max(maxY, label.y + label.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
