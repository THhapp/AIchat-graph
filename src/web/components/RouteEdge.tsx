import { BaseEdge, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { LayoutEdgeRoute } from '../layout/types.js';
import {
  EDGE_LABEL_FONT,
  EDGE_LABEL_LINE_HEIGHT,
  EDGE_LABEL_RADIUS,
} from '../graph/cardMetrics.js';
import { layoutEdgeLabel, type EdgeLabelBox } from './routeLabels.js';
import { EDGE_ORIGIN_RADIUS, buildOrthogonalPath } from './edgePath.js';

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

function RouteLabel(
  { text, box }: { text: string; box: EdgeLabelBox },
): React.JSX.Element {
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
  const payload = data as { route?: LayoutEdgeRoute | null; labelBox?: EdgeLabelBox | null } | undefined;
  const route = payload?.route ?? null;
  const text = typeof label === 'string' ? label.trim() : '';
  if (route !== null) {
    const path = buildOrthogonalPath(routePoints(route));
    // Only a branch that leaves the card directly gets the origin dot: a
    // trunked branch starts on the shared run, where a dot would only mark a
    // T junction, and a continuing edge is a straight continuation rather than
    // a new departure.
    const origin = route.join === undefined && route.flow === 'branch' ? route.points[0] : undefined;
    // Placement is computed once for all routes in `buildFlowEdges`; the local
    // fallback only covers callers that assemble an edge without that pass.
    const box = text === '' ? null : payload?.labelBox ?? layoutEdgeLabel(route, text);
    return (
      <>
        <BaseEdge id={id} path={path} className="rf-edge" />
        {box !== null ? <RouteLabel text={text} box={box} /> : null}
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
