import type { GraphNode, NodeState } from '../../shared/protocol.js';

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
 * `resolvedSide` is the side layout actually used for this branch. Without an
 * explicit or resolved direction the label stays neutral instead of claiming a
 * right-hand branch the drawing may contradict.
 */
export function flowLabel(node: Pick<GraphNode, 'flow' | 'side'>, resolvedSide?: 'left' | 'right' | null): string {
  if (node.flow === 'root') return '根节点';
  if (node.flow === 'next') return '纵向续接';
  const side = resolvedSide ?? node.side ?? null;
  if (side === 'left') return '左侧分支';
  if (side === 'right') return '右侧分支';
  return '分支';
}
