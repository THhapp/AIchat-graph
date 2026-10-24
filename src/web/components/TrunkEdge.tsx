import { BaseEdge } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { LayoutBranchTrunk } from '../layout/types.js';
import { EDGE_ORIGIN_RADIUS, buildOrthogonalPath } from './edgePath.js';

/**
 * The horizontal trunk that sibling branches share on one side of a parent.
 *
 * Display geometry only: it carries no relationship, so it has no arrow, no
 * label and no selection. It is drawn as a normal React Flow edge, which puts it
 * in the edge layer under the cards. It is deliberately *not* styled like a
 * branch: the shared run is the structure (solid, 1.5px) and every branch keeps
 * its own dashed 3/3 stub, so a reader can tell which part of the line is shared
 * and which part belongs to one relationship. Nothing is painted twice on top of
 * itself, because branches start at their join on this line.
 *
 * The first point sits on the source card's border, so it gets the origin dot
 * that says "this line starts at that card". Branches joining this run do not.
 */
export function TrunkEdge({ id, data }: EdgeProps): React.JSX.Element | null {
  const trunk = (data as { trunk?: LayoutBranchTrunk | null } | undefined)?.trunk ?? null;
  if (trunk === null || trunk.points.length < 2) return null;
  const origin = trunk.points[0];
  return (
    <>
      <BaseEdge
        id={id}
        path={buildOrthogonalPath(trunk.points)}
        className="rf-edge rf-edge--trunk"
        // No interaction surface: the trunk belongs to no relationship and must
        // not take hover, focus or pan gestures away from the canvas.
        interactionWidth={0}
      />
      {origin !== undefined ? (
        <circle className="rf-edge__origin" cx={origin.x} cy={origin.y} r={EDGE_ORIGIN_RADIUS} />
      ) : null}
    </>
  );
}
