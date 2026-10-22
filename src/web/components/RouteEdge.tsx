import { BaseEdge, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { LayoutEdgeRoute } from '../layout/types.js';

function pathFromRoute(route: LayoutEdgeRoute): string {
  const points = route.points;
  if (points.length === 0) return '';
  const first = points[0];
  if (first === undefined) return '';
  let path = 'M ' + String(first.x) + ' ' + String(first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    path += ' L ' + String(point.x) + ' ' + String(point.y);
  }
  return path;
}

/**
 * Draws the layout owner's orthogonal route when present. Falls back to a smooth
 * step only if the route is missing, and never draws through cards silently:
 * a missing route is surfaced as a dashed fallback.
 */
export function RouteEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, data }: EdgeProps): React.JSX.Element {
  const route = (data as { route?: LayoutEdgeRoute | null } | undefined)?.route ?? null;
  if (route !== null) {
    const path = pathFromRoute(route);
    return (
      <>
        <BaseEdge id={id} path={path} className="rf-edge" />
        {label !== undefined && label !== '' && route.labelAnchor !== undefined ? (
          <text className="rf-edge__label" x={route.labelAnchor.x} y={route.labelAnchor.y} textAnchor="middle">
            {label}
          </text>
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
