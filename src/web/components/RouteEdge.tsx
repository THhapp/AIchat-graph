import { BaseEdge, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { LayoutEdgeRoute } from '../layout/types.js';
import {
  EDGE_LABEL_FONT,
  EDGE_LABEL_LINE_HEIGHT,
  EDGE_LABEL_PAD_X,
  EDGE_LABEL_PAD_Y,
  EDGE_LABEL_RADIUS,
  textWidth,
  wrapByWidth,
} from '../graph/cardMetrics.js';
import { EDGE_ORIGIN_RADIUS, buildOrthogonalPath } from './edgePath.js';

/**
 * A continuing edge is short; a branch has a longer side channel.
 */
const MAX_LABEL_LINES: Record<'next' | 'branch', number> = { next: 2, branch: 3 };

/** Minimum distance between a label box and the trunk it hangs from. */
const LABEL_TRUNK_PAD = 8;
/** Clearance between the label box and the target card centre it points at. */
const LABEL_CARD_GAP = 4;
/** Tolerance for "the first point already is the join". */
const SAME_POINT = 0.01;

/**
 * Branch geometry as drawn: a branch that leaves a shared trunk starts at its
 * join point, so the trunk itself is never painted twice.
 */
function routePoints(route: LayoutEdgeRoute): readonly { x: number; y: number }[] {
  const join = route.join;
  const first = route.points[0];
  if (join === undefined) return route.points;
  if (first === undefined) return [join];
  if (Math.abs(first.x - join.x) < SAME_POINT && Math.abs(first.y - join.y) < SAME_POINT) {
    return route.points;
  }
  return [join, ...route.points];
}

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

/**
 * Box for a relationship sentence, laid out on the channel the branch runs in.
 *
 * The connector is interrupted by an opaque box rather than running through the
 * words, so the box position is a geometry decision, not a styling one.
 *
 * What the text is allowed to interrupt, and what it never touches: the shared
 * horizontal run of a trunk is never broken by a label — every label hangs
 * below it. A label can only cut a vertical segment it sits on, and that is
 * always this relationship's own run (its drop to the card, or — for the
 * innermost member — the exit riser it shares with the trunk at the near end).
 * Accepted as-is: a reader still sees where each line goes, while moving the
 * label off that run would either break the "label rides its own line" rule or
 * push the box onto a card.
 *
 * Horizontally the box is centred on `labelAnchor.x`. The layout puts that
 * anchor on the gap centre — the trunk drop line and the single-branch channel
 * both rise through the middle of the gap — so centring keeps the vertical run
 * passing through the middle of the board instead of clipping its edge. One
 * defensive bound remains: the board must not cross the card edge the branch
 * enters (a right-side branch stops at the target card's left edge, a left-side
 * branch at its right edge); if it ever would, it is pushed back against the
 * card. A continuing (`next`) edge enters from above and has no such edge.
 *
 * Vertically a trunked branch is bounded by its own stub, not by the target
 * card: the board's top keeps `LABEL_TRUNK_PAD` below the join it hangs from,
 * and its bottom keeps `LABEL_CARD_GAP` above the target centre, which is where
 * the drop line ends. When the stub is too short for both, hugging the join
 * wins and only the target-centre bound is still honoured. A lone branch has no
 * join: the board stays centred on the anchor, with a defensive clamp onto the
 * midpoint of its vertical channel that is inert for today's anchors (they are
 * already the channel midpoint) and only guards a future anchor change.
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
    // The last point sits on the card edge the branch enters; the board may sit
    // on the gap side of that edge but never across it.
    const hugLeft = route.side === 'right' ? end.x - boxWidth : end.x;
    left = route.side === 'right' ? Math.min(left, hugLeft) : Math.max(left, hugLeft);
  }

  let top = anchor.y - boxHeight / 2;
  const join = route.join;
  if (join === undefined) {
    // Lone branch: centred on the anchor. The guard below is defensive only —
    // layout anchors a lone branch on `midY`, which already is the midpoint of
    // its vertical run, so on current routes the clamp computes the same value.
    // It only keeps a future anchor from sitting off-centre on a run too short
    // to hold the board. No vertical run at all (a straight fallback) leaves it
    // centred.
    const run = longestVerticalRun(route.points);
    if (run !== undefined && boxHeight > run.bottom - run.top - LABEL_TRUNK_PAD * 2) {
      top = (run.top + run.bottom) / 2 - boxHeight / 2;
    }
  } else {
    const minTop = join.y + LABEL_TRUNK_PAD;
    // The branch's last point is the target centre: the drop line ends there,
    // so that is the bound the text may not pass — not the card's top edge.
    if (end === undefined) {
      top = Math.max(top, minTop);
    } else {
      const maxTop = end.y - LABEL_CARD_GAP - boxHeight;
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
function longestVerticalRun(
  points: readonly { x: number; y: number }[],
): { top: number; bottom: number } | undefined {
  let best: { top: number; bottom: number } | undefined;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) continue;
    if (Math.abs(a.x - b.x) >= SAME_POINT) continue;
    const length = Math.abs(a.y - b.y);
    if (length < SAME_POINT) continue;
    if (best === undefined || length > best.bottom - best.top) {
      best = { top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
    }
  }
  return best;
}

function RouteLabel(
  { text, route }: { text: string; route: LayoutEdgeRoute },
): React.JSX.Element | null {
  const box = layoutEdgeLabel(route, text);
  if (box === null) return null;
  return (
    <g className="rf-edge__label-group">
      <title>{text}</title>
      <rect
        className="rf-edge__label-bg"
        x={box.left}
        y={box.top}
        width={box.width}
        height={box.height}
        rx={EDGE_LABEL_RADIUS}
        ry={EDGE_LABEL_RADIUS}
      />
      <text className="rf-edge__label" x={box.centerX} y={box.baseline} textAnchor="middle">
        {box.lines.map((line, index) => (
          <tspan key={index} x={box.centerX} dy={index === 0 ? 0 : EDGE_LABEL_LINE_HEIGHT}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

/**
 * Draws the layout owner's orthogonal route when present. Falls back to a smooth
 * step only if the route is missing, and never draws through cards silently:
 * a missing route is surfaced as a dashed fallback.
 */
export function RouteEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, data }: EdgeProps): React.JSX.Element {
  const payload = data as { route?: LayoutEdgeRoute | null } | undefined;
  const route = payload?.route ?? null;
  const text = typeof label === 'string' ? label.trim() : '';
  if (route !== null) {
    const path = buildOrthogonalPath(routePoints(route));
    // Only a branch that leaves the card directly gets the origin dot: a
    // trunked branch starts on the shared run, where a dot would only mark a
    // T junction, and a continuing edge is a straight continuation rather than
    // a new departure.
    const origin = route.join === undefined && route.flow === 'branch' ? route.points[0] : undefined;
    return (
      <>
        <BaseEdge id={id} path={path} className="rf-edge" />
        {text !== '' ? <RouteLabel text={text} route={route} /> : null}
        {origin !== undefined ? (
          <circle className="rf-edge__origin" cx={origin.x} cy={origin.y} r={EDGE_ORIGIN_RADIUS} />
        ) : null}
      </>
    );
  }
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 4,
    offset: 16,
  });
  return (
    <>
      <BaseEdge id={id} path={path} className="rf-edge rf-edge--fallback" />
      {label !== undefined && label !== '' ? (
        <text className="rf-edge__label" x={labelX} y={labelY} textAnchor="middle">{label}</text>
      ) : null}
    </>
  );
}
