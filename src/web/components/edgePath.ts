/**
 * Shared geometry for the orthogonal connectors.
 *
 * The layout owner emits polylines in layout coordinates; this module turns them
 * into an SVG `d` with small rounded corners.
 */
import type { LayoutPoint } from '../layout/types.js';

/** Corner radius. Larger than this reads as a curve, smaller is invisible at 1x. */
export const EDGE_CORNER_RADIUS = 6;

/**
 * Radius of the dot that marks where a line leaves a card. Small enough to sit
 * on the border without reading as a node, large enough to survive zoom-out.
 * The `r` attribute is the fallback for browsers without the CSS `r` property;
 * graph.css otherwise drives the radius from `--edge-scale`, so the dot keeps
 * this size on screen at every zoom.
 */
export const EDGE_ORIGIN_RADIUS = 3.2;

/** Below this a segment counts as a duplicate point, not a direction. */
const EPSILON = 0.01;

type Vec = { x: number; y: number };

type Piece =
  | { kind: 'line'; from: Vec; to: Vec; start: number; end: number }
  | { kind: 'curve'; from: Vec; control: Vec; to: Vec; start: number; end: number };

/** Rounds for compact output; two decimals is well below one device pixel. */
function fmt(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded === 0 ? 0 : rounded);
}

function distance(a: Vec, b: Vec): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function dedupe(points: readonly LayoutPoint[]): Vec[] {
  const result: Vec[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const last = result[result.length - 1];
    if (last !== undefined && distance(last, point) < EPSILON) continue;
    result.push({ x: point.x, y: point.y });
  }
  return result;
}

function quadPoint(a: Vec, control: Vec, b: Vec, t: number): Vec {
  const mt = 1 - t;
  return {
    x: mt * mt * a.x + 2 * mt * t * control.x + t * t * b.x,
    y: mt * mt * a.y + 2 * mt * t * control.y + t * t * b.y,
  };
}

/** Sample count per corner: error < 0.02px at radius 6, cheap enough to run per edge. */
const CURVE_SAMPLES = 8;

function curveLength(piece: Extract<Piece, { kind: 'curve' }>): number {
  let total = 0;
  let previous = piece.from;
  for (let step = 1; step <= CURVE_SAMPLES; step += 1) {
    const next = quadPoint(piece.from, piece.control, piece.to, step / CURVE_SAMPLES);
    total += distance(previous, next);
    previous = next;
  }
  return total;
}

/**
 * Straight runs and corner arcs of one polyline, each with its cumulative path
 * length. Corners whose neighbouring segment is shorter than `2 * radius` stay
 * sharp: rounding them would eat the whole segment and visibly bow the line.
 */
function buildPieces(points: readonly LayoutPoint[], radius: number): Piece[] {
  const pts = dedupe(points);
  if (pts.length < 2) return [];
  const cornerRadius = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const pieces: Piece[] = [];
  let cursor: Vec = pts[0] as Vec;

  const pushLine = (to: Vec): void => {
    if (distance(cursor, to) < EPSILON) return;
    pieces.push({ kind: 'line', from: cursor, to, start: 0, end: 0 });
    cursor = to;
  };

  for (let index = 1; index < pts.length - 1; index += 1) {
    const point = pts[index] as Vec;
    const previous = pts[index - 1] as Vec;
    const next = pts[index + 1] as Vec;
    const inLength = distance(previous, point);
    const outLength = distance(point, next);
    if (inLength < EPSILON || outLength < EPSILON) {
      pushLine(point);
      continue;
    }
    const inX = (point.x - previous.x) / inLength;
    const inY = (point.y - previous.y) / inLength;
    const outX = (next.x - point.x) / outLength;
    const outY = (next.y - point.y) / outLength;
    const dot = inX * outX + inY * outY;
    // Straight through, or a full reversal: nothing to round.
    if (dot > 1 - 1e-6 || dot < -1 + 1e-6) {
      pushLine(point);
      continue;
    }
    if (cornerRadius <= 0 || inLength < cornerRadius * 2 || outLength < cornerRadius * 2) {
      pushLine(point);
      continue;
    }
    const before: Vec = { x: point.x - inX * cornerRadius, y: point.y - inY * cornerRadius };
    const after: Vec = { x: point.x + outX * cornerRadius, y: point.y + outY * cornerRadius };
    pushLine(before);
    pieces.push({ kind: 'curve', from: before, control: point, to: after, start: 0, end: 0 });
    cursor = after;
  }
  pushLine(pts[pts.length - 1] as Vec);

  let cursorLength = 0;
  for (const piece of pieces) {
    const length = piece.kind === 'line' ? distance(piece.from, piece.to) : curveLength(piece);
    piece.start = cursorLength;
    cursorLength += length;
    piece.end = cursorLength;
  }
  return pieces;
}

/**
 * SVG path for an orthogonal polyline. Two points stay a plain straight line so
 * the continuing (`next`) edge is unchanged.
 */
export function buildOrthogonalPath(
  points: readonly LayoutPoint[],
  radius: number = EDGE_CORNER_RADIUS,
): string {
  const pieces = buildPieces(points, radius);
  if (pieces.length === 0) {
    const first = dedupe(points)[0];
    return first === undefined ? '' : 'M ' + fmt(first.x) + ' ' + fmt(first.y);
  }
  const start = pieces[0]?.from;
  if (start === undefined) return '';
  let path = 'M ' + fmt(start.x) + ' ' + fmt(start.y);
  for (const piece of pieces) {
    if (piece.kind === 'line') {
      path += ' L ' + fmt(piece.to.x) + ' ' + fmt(piece.to.y);
    } else {
      path +=
        ' Q ' + fmt(piece.control.x) + ' ' + fmt(piece.control.y) +
        ' ' + fmt(piece.to.x) + ' ' + fmt(piece.to.y);
    }
  }
  return path;
}

/**
 * Length of the drawn path measured from the first point.
 * Exported for the path-length regression test; no production caller.
 */
export function pathLength(points: readonly LayoutPoint[], radius: number = EDGE_CORNER_RADIUS): number {
  const pieces = buildPieces(points, radius);
  const last = pieces[pieces.length - 1];
  return last === undefined ? 0 : last.end;
}
