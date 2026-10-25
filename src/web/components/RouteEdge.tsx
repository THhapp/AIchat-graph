import { BaseEdge, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { LayoutEdgeRoute, LayoutLabelBox } from '../layout/types.js';
import { EDGE_LABEL_LINE_HEIGHT, EDGE_LABEL_RADIUS } from '../graph/cardMetrics.js';
import { buildOrthogonalPath } from './edgePath.js';

function RouteLabel(
  { text, box }: { text: string; box: LayoutLabelBox },
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
 * Draws the layout owner's orthogonal route and label box exactly as emitted.
 * Falls back to a smooth step only if the route is missing, and never draws
 * through cards silently: a missing route is surfaced as a dashed fallback.
 */
export function RouteEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, data }: EdgeProps): React.JSX.Element {
  const route = (data as { route?: LayoutEdgeRoute | null } | undefined)?.route ?? null;
  const text = typeof label === 'string' ? label.trim() : '';
  if (route !== null) {
    // The renderer paints `route.points`; there is no join/side reconstruction.
    // The line ends at the card border without an origin dot for either a
    // direct branch or a stub leaving a shared trunk.
    const path = buildOrthogonalPath(route.points);
    const box = route.label ?? null;
    // The tooltip keeps the current relationship sentence; the visible text is
    // always the complete wrapped lines measured by layout.
    const title = text !== '' ? text : box?.lines.join(' ') ?? '';
    return (
      <>
        <BaseEdge id={id} path={path} className="rf-edge" />
        {box !== null ? <RouteLabel text={title} box={box} /> : null}
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
      {text !== '' ? (
        <text className="rf-edge__label" x={labelX} y={labelY} textAnchor="middle">{text}</text>
      ) : null}
    </>
  );
}
