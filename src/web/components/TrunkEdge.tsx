import { BaseEdge } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { LayoutBranchTrunk } from '../layout/types.js';
import { buildTrunkPath } from './edgePath.js';

/**
 * The vertical trunk that sibling branches share to the right of a parent.
 *
 * Display geometry only: it carries no relationship, so it has no arrow, no
 * label and no selection. It is drawn as a normal React Flow edge, which puts it
 * in the edge layer under the cards. It is deliberately *not* styled like a
 * branch: the shared run is the structure (solid, 1.5px) and every branch keeps
 * its own dashed 3/4 stub, so a reader can tell which part of the line is shared
 * and which part belongs to one relationship. Nothing is painted twice on top of
 * itself, because branches start where the trunk reaches their entry y.
 *
 * The path is split into the feeder and the riser (see `buildTrunkPath`), so the
 * first branch entry meets a square corner instead of the inside of a fillet.
 * The line ends at the cards' edges; there is no origin dot.
 */
export function TrunkEdge({ id, data }: EdgeProps): React.JSX.Element | null {
  const trunk = (data as { trunk?: LayoutBranchTrunk | null } | undefined)?.trunk ?? null;
  if (trunk === null || trunk.points.length < 2) return null;
  return (
    <BaseEdge
      id={id}
      path={buildTrunkPath(trunk.points)}
      className="rf-edge rf-edge--trunk"
      // No interaction surface: the trunk belongs to no relationship and must
      // not take hover, focus or pan gestures away from the canvas.
      interactionWidth={0}
    />
  );
}
