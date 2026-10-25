/**
 * Pure label geometry for the relationship connectors.
 *
 * A label is allowed to interrupt the exclusive stub of its own relationship —
 * that is the established reading of "the sentence rides its line". It must not
 * cover a card, a shared trunk, another relationship's line, another label, or
 * a corner of a foreign line, and it must not be pushed onto the shared part of
 * a trunk. Placement runs once for all routes so later labels can avoid earlier
 * ones deterministically.
 *
 * This module deliberately imports no React and no React Flow: the live reader,
 * the offline reader and the layout tests all use the same numbers.
 */
import type { LayoutBranchTrunk, LayoutEdgeRoute, LayoutPoint } from '../layout/types.js';
import {
  EDGE_LABEL_FONT,
  EDGE_LABEL_LINE_HEIGHT,
  EDGE_LABEL_PAD_X,
  EDGE_LABEL_PAD_Y,
  textWidth,
  wrapByWidth,
} from '../graph/cardMetrics.js';

/** Continuing edges are short; a branch has a longer side channel. */
export const MAX_LABEL_LINES: Record<'next' | 'branch', number> = { next: 2, branch: 3 };

/** Where the relationship sentence lands, in layout coordinates. */
export interface EdgeLabelBox {
  left: number;
  top: number;
  width: number;
  height: number;
  centerX: number;
  baseline: number;
  lines: string[];
}

/** A visible card as seen by the label placer. */
export interface LabelCardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EPS = 0.01;
/** Distance from a label box to any line it is not riding. */
const LABEL_LINE_GAP = 1;
/** Distance between a trunked label and the trunk it hangs from. */
const LABEL_TRUNK_PAD = 8;
/** Distance between two label boxes. */
const LABEL_LABEL_GAP = 2;
/** Spacing of the deterministic candidate grid along each stub. */
const CANDIDATE_STEP = 8;
/** Small preference for a board that rides the line over one beside it. */
const OFFSET_PENALTY = 20;
/** Soft cost for covering a corner of the route the label belongs to. */
const OWN_CORNER_PENALTY = 1000;

interface Segment {
  a: LayoutPoint;
  b: LayoutPoint;
  horizontal: boolean;
}

interface Candidate {
  box: EdgeLabelBox;
  score: number;
}

function segmentsOf(points: readonly LayoutPoint[]): Segment[] {
  const segments: Segment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) continue;
    if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) continue;
    if (Math.abs(a.x - b.x) >= EPS && Math.abs(a.y - b.y) >= EPS) continue;
    segments.push({ a, b, horizontal: Math.abs(a.y - b.y) < EPS });
  }
  return segments;
}

function boxFrom(centerX: number, centerY: number, width: number, height: number, lines: string[]): EdgeLabelBox {
  const left = centerX - width / 2;
  const top = centerY - height / 2;
  return {
    left,
    top,
    width,
    height,
    centerX,
    baseline: top + EDGE_LABEL_PAD_Y + EDGE_LABEL_FONT,
    lines,
  };
}

function rectsOverlap(box: EdgeLabelBox, other: LabelCardRect, gap: number): boolean {
  return (
    box.left < other.x + other.width - gap - EPS &&
    box.left + box.width > other.x + gap + EPS &&
    box.top < other.y + other.height - gap - EPS &&
    box.top + box.height > other.y + gap + EPS
  );
}

function boxesOverlap(a: EdgeLabelBox, b: EdgeLabelBox, gap: number): boolean {
  return (
    a.left < b.left + b.width - gap - EPS &&
    a.left + a.width > b.left + gap + EPS &&
    a.top < b.top + b.height - gap - EPS &&
    a.top + a.height > b.top + gap + EPS
  );
}

/** True when a box would paint over an axis-aligned line segment. */
function boxHitsSegment(box: EdgeLabelBox, segment: Segment): boolean {
  const gap = LABEL_LINE_GAP;
  if (segment.horizontal) {
    const y = segment.a.y;
    if (y <= box.top + gap + EPS || y >= box.top + box.height - gap - EPS) return false;
    const low = Math.min(segment.a.x, segment.b.x);
    const high = Math.max(segment.a.x, segment.b.x);
    return Math.min(high, box.left + box.width - gap) > Math.max(low, box.left + gap) + EPS;
  }
  const x = segment.a.x;
  if (x <= box.left + gap + EPS || x >= box.left + box.width - gap - EPS) return false;
  const low = Math.min(segment.a.y, segment.b.y);
  const high = Math.max(segment.a.y, segment.b.y);
  return Math.min(high, box.top + box.height - gap) > Math.max(low, box.top + gap) + EPS;
}

function pointInsideBox(box: EdgeLabelBox, point: LayoutPoint): boolean {
  return (
    point.x > box.left + EPS &&
    point.x < box.left + box.width - EPS &&
    point.y > box.top + EPS &&
    point.y < box.top + box.height - EPS
  );
}

/** Deterministic candidate positions along one exclusive segment. */
function candidatesForStub(
  route: LayoutEdgeRoute,
  segment: Segment,
  segmentIndex: number,
  boxWidth: number,
  boxHeight: number,
  lines: string[],
): Candidate[] {
  const axisLow = segment.horizontal
    ? Math.min(segment.a.x, segment.b.x)
    : Math.min(segment.a.y, segment.b.y);
  const axisHigh = segment.horizontal
    ? Math.max(segment.a.x, segment.b.x)
    : Math.max(segment.a.y, segment.b.y);
  if (axisHigh - axisLow < EPS) return [];
  const fixed = segment.horizontal ? segment.a.y : segment.a.x;

  const anchor = route.labelAnchor;
  const anchorAxis = anchor === undefined
    ? (axisLow + axisHigh) / 2
    : segment.horizontal
      ? anchor.x
      : anchor.y;
  const positions = new Set<number>();
  const add = (value: number): void => {
    const clamped = Math.min(axisHigh, Math.max(axisLow, value));
    // A stable two-decimal grid keeps candidate order independent of float noise.
    positions.add(Math.round(clamped * 100) / 100);
  };
  add(anchorAxis);
  add((axisLow + axisHigh) / 2);
  add(axisLow + (axisHigh - axisLow) * 0.25);
  add(axisLow + (axisHigh - axisLow) * 0.75);
  add(axisLow);
  add(axisHigh);
  for (let value = axisLow; value <= axisHigh; value += CANDIDATE_STEP) add(value);

  const candidates: Candidate[] = [];
  const half = segment.horizontal ? boxWidth / 2 : boxHeight / 2;
  const anchorX = anchor?.x;
  const anchorY = anchor?.y;
  // Three attachments per stub: riding the line, or sitting just beside it.
  // A board beside the line is still attached to this relationship's exclusive
  // stub, but leaves the stroke visible — needed where the innermost member's
  // drop coincides with the shared trunk riser.
  const offsets: { value: number; penalty: number }[] = [
    { value: 0, penalty: 0 },
    { value: LABEL_LINE_GAP, penalty: OFFSET_PENALTY },
    { value: -LABEL_LINE_GAP, penalty: OFFSET_PENALTY },
  ];
  for (const axis of positions) {
    for (const offset of offsets) {
      const centerX = segment.horizontal
        ? axis
        : fixed + offset.value + (offset.value === 0 ? 0 : Math.sign(offset.value) * boxWidth / 2);
      const centerY = segment.horizontal
        ? fixed + offset.value + (offset.value === 0 ? 0 : Math.sign(offset.value) * boxHeight / 2)
        : axis;
      const box = boxFrom(centerX, centerY, boxWidth, boxHeight, lines);
      // Keep the measured box in the same order as the route: the sentence rides
      // its own stub, not a future stub of a different relationship.
      let ownCorners = 0;
      for (const point of route.points) {
        if (pointInsideBox(box, point)) ownCorners += 1;
      }
      const overflow =
        Math.max(0, axisLow - (axis - half)) + Math.max(0, axis + half - axisHigh);
      const distanceFromAnchor = anchorX === undefined || anchorY === undefined
        ? 0
        : Math.hypot(centerX - anchorX, centerY - anchorY);
      candidates.push({
        box,
        score:
          distanceFromAnchor +
          overflow * 0.5 +
          ownCorners * OWN_CORNER_PENALTY +
          offset.penalty +
          segmentIndex * 0.01 +
          axis * 1e-6,
      });
    }
  }
  return candidates;
}

function candidatesFor(
  route: LayoutEdgeRoute,
  boxWidth: number,
  boxHeight: number,
  lines: string[],
): Candidate[] {
  const candidates: Candidate[] = [];
  const segments = segmentsOf(route.points);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    candidates.push(...candidatesForStub(route, segment, index, boxWidth, boxHeight, lines));
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates;
}

interface Obstacles {
  cards: readonly LabelCardRect[];
  trunkSegments: readonly Segment[];
  trunkVertices: readonly LayoutPoint[];
  routeSegments: ReadonlyMap<string, readonly Segment[]>;
  routeVertices: ReadonlyMap<string, readonly LayoutPoint[]>;
}

function interference(box: EdgeLabelBox, ownerId: string, placed: readonly EdgeLabelBox[], obstacles: Obstacles): number {
  let hits = 0;
  for (const card of obstacles.cards) {
    if (rectsOverlap(box, card, 0)) hits += 8;
  }
  for (const segment of obstacles.trunkSegments) {
    if (boxHitsSegment(box, segment)) hits += 8;
  }
  for (const [id, segments] of obstacles.routeSegments) {
    if (id === ownerId) continue;
    for (const segment of segments) {
      if (boxHitsSegment(box, segment)) hits += 4;
    }
  }
  for (const [id, vertices] of obstacles.routeVertices) {
    if (id === ownerId) continue;
    for (const vertex of vertices) {
      if (pointInsideBox(box, vertex)) hits += 4;
    }
  }
  for (const vertex of obstacles.trunkVertices) {
    if (pointInsideBox(box, vertex)) hits += 4;
  }
  for (const other of placed) {
    if (boxesOverlap(box, other, LABEL_LABEL_GAP)) hits += 8;
  }
  return hits;
}

function isClear(box: EdgeLabelBox, ownerId: string, placed: readonly EdgeLabelBox[], obstacles: Obstacles): boolean {
  return interference(box, ownerId, placed, obstacles) === 0;
}

/**
 * Places every relationship sentence once.
 *
 * Each candidate is attached to one of the route's own exclusive segments (the
 * entry run, the drop line, or a lone Z's channel): either riding it or sitting
 * one pixel beside it, so a label can never be dropped on a shared trunk.
 * Candidates are tried in deterministic preference order and the first one
 * clear of cards, trunks, other route lines and already placed labels wins. If
 * a pathological topology leaves no clear slot, the least-interfering candidate
 * is used rather than hiding the text.
 */
export function placeRouteLabels(
  routes: readonly LayoutEdgeRoute[],
  trunks: readonly LayoutBranchTrunk[],
  cards: readonly LabelCardRect[],
  texts: ReadonlyMap<string, string>,
): Map<string, EdgeLabelBox> {
  const result = new Map<string, EdgeLabelBox>();
  const routeSegments = new Map<string, Segment[]>();
  const routeVertices = new Map<string, LayoutPoint[]>();
  for (const route of routes) {
    routeSegments.set(route.id, segmentsOf(route.points));
    routeVertices.set(route.id, route.points);
  }
  const trunkSegments: Segment[] = [];
  const trunkVertices: LayoutPoint[] = [];
  for (const trunk of trunks) {
    trunkSegments.push(...segmentsOf(trunk.points));
    trunkVertices.push(...trunk.points);
  }
  const obstacles: Obstacles = {
    cards,
    trunkSegments,
    trunkVertices,
    routeSegments,
    routeVertices,
  };

  const placed: EdgeLabelBox[] = [];
  const ordered = [...routes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const route of ordered) {
    const text = texts.get(route.id);
    const labelWidth = route.labelWidth;
    if (text === undefined || labelWidth === undefined || !(labelWidth > 0)) continue;
    const lines = wrapByWidth(text, labelWidth, EDGE_LABEL_FONT, MAX_LABEL_LINES[route.flow]);
    if (lines.length === 0) continue;
    const widest = Math.max(...lines.map((line) => textWidth(line, EDGE_LABEL_FONT)));
    const boxWidth = Math.min(labelWidth, widest) + EDGE_LABEL_PAD_X * 2;
    const boxHeight = lines.length * EDGE_LABEL_LINE_HEIGHT + EDGE_LABEL_PAD_Y * 2;

    const candidates = candidatesFor(route, boxWidth, boxHeight, lines);
    if (candidates.length === 0) continue;
    let chosen: Candidate | undefined;
    for (const candidate of candidates) {
      if (isClear(candidate.box, route.id, placed, obstacles)) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === undefined) {
      // Deterministic fallback: the least-interfering slot, still on the stub.
      let best = candidates[0] as Candidate;
      let bestHits = interference(best.box, route.id, placed, obstacles);
      for (let index = 1; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (candidate === undefined) continue;
        const hits = interference(candidate.box, route.id, placed, obstacles);
        if (hits < bestHits) {
          best = candidate;
          bestHits = hits;
        }
      }
      chosen = best;
    }
    placed.push(chosen.box);
    result.set(route.id, chosen.box);
  }
  return result;
}

/**
 * Single-route fallback used when an edge reaches the renderer without a
 * precomputed box (for example a caller assembling an edge by hand). The board
 * is centred on the anchor, bounded by the target card edge and by the branch's
 * own join-to-target stub. Full collision avoidance lives in `placeRouteLabels`.
 */
export function layoutEdgeLabel(route: LayoutEdgeRoute, text: string): EdgeLabelBox | null {
  const anchor = route.labelAnchor;
  const labelWidth = route.labelWidth;
  if (anchor === undefined || labelWidth === undefined || !(labelWidth > 0)) return null;

  const lines = wrapByWidth(text, labelWidth, EDGE_LABEL_FONT, MAX_LABEL_LINES[route.flow]);
  if (lines.length === 0) return null;

  const widest = Math.max(...lines.map((line) => textWidth(line, EDGE_LABEL_FONT)));
  const boxWidth = Math.min(labelWidth, widest) + EDGE_LABEL_PAD_X * 2;
  const boxHeight = lines.length * EDGE_LABEL_LINE_HEIGHT + EDGE_LABEL_PAD_Y * 2;

  const end = route.points[route.points.length - 1];

  let left = anchor.x - boxWidth / 2;
  if (route.side !== undefined && end !== undefined) {
    const hugLeft = route.side === 'right' ? end.x - boxWidth : end.x;
    left = route.side === 'right' ? Math.min(left, hugLeft) : Math.max(left, hugLeft);
  }

  let top = anchor.y - boxHeight / 2;
  const join = route.join;
  if (join === undefined) {
    const run = longestVerticalRun(route.points);
    if (run !== undefined && boxHeight > run.bottom - run.top - EDGE_LABEL_PAD_Y * 2) {
      top = (run.top + run.bottom) / 2 - boxHeight / 2;
    }
  } else {
    const minTop = join.y + LABEL_TRUNK_PAD;
    if (end === undefined) {
      top = Math.max(top, minTop);
    } else {
      const maxTop = end.y - 4 - boxHeight;
      top = maxTop >= minTop
        ? Math.min(Math.max(top, minTop), maxTop)
        : Math.min(minTop, end.y - boxHeight);
    }
  }

  return {
    left,
    top,
    width: boxWidth,
    height: boxHeight,
    centerX: left + boxWidth / 2,
    baseline: top + EDGE_LABEL_PAD_Y + EDGE_LABEL_FONT,
    lines,
  };
}

/** Longest vertical stretch of an orthogonal polyline, if it has one. */
function longestVerticalRun(points: readonly LayoutPoint[]): { top: number; bottom: number } | undefined {
  let best: { top: number; bottom: number } | undefined;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) continue;
    if (Math.abs(a.x - b.x) >= EPS) continue;
    const length = Math.abs(a.y - b.y);
    if (length < EPS) continue;
    if (best === undefined || length > best.bottom - best.top) {
      best = { top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
    }
  }
  return best;
}
