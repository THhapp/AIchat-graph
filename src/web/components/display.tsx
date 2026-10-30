import type { GraphNode } from '../../next/protocol.js';

/**
 * Neutral marker for the current discussion node (activeNode).
 *
 * The product no longer maintains a node classification, so this only says
 * "this is where the conversation currently is". It is deliberately not a
 * colour-coded state: important / recent / selected have their own cues.
 */
export function CurrentMarker(): React.JSX.Element {
  return (
    <span className="current-marker" title="当前讨论节点（activeNode）">
      当前
    </span>
  );
}

/**
 * Branch geometry is single-sided in v5: every branch unfolds to the right of
 * its source, so the source `side` value must not be echoed as a reading fact.
 */
export function flowLabel(node: Pick<GraphNode, 'flow'>): string {
  if (node.flow === 'root') return '根节点';
  if (node.flow === 'next') return '纵向续接';
  return '右侧分支';
}
