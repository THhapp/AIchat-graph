import type { GraphNode, NodeState } from '../../next/protocol.js';

const STATE_LABEL: Record<NodeState, string> = {
  agreed: '已确认',
  proposed: '待确认',
  reference: '参考',
};

export function stateLabel(state: NodeState): string {
  return STATE_LABEL[state];
}

/** Branch entries of agreed chains are cyan; every other agreed node is green. */
export function stateChipTone(node: Pick<GraphNode, 'state' | 'flow'>): NodeState | 'branch' {
  return node.state === 'agreed' && node.flow === 'branch' ? 'branch' : node.state;
}

export function StateChip({ node, active = false }: { node: Pick<GraphNode, 'state' | 'flow' | 'id'>; active?: boolean }): React.JSX.Element {
  return (
    <span
      className="state-chip"
      data-state={stateChipTone(node)}
      data-active={active ? 'true' : 'false'}
      title={active ? '当前讨论节点（activeNode）' : stateLabel(node.state)}
    >
      {active ? '当前' : stateLabel(node.state)}
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
