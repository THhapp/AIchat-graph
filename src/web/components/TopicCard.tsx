import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { BranchSide, GraphNode } from '../../shared/protocol.js';
import { StateChip } from './display.js';

export interface TopicCardData extends Record<string, unknown> {
  node: GraphNode;
  /** Card height in px, already matched by layout and by the graph geometry. */
  height: number;
  active: boolean;
  /** Side the incoming branch edge actually landed on; null when unknown. */
  resolvedSide: BranchSide | null;
  hiddenCount: number;
  collapsed: boolean;
  childCount: number;
  onToggleCollapse: (id: string) => void;
  /** Explicit "read this card" action; a plain click only selects. */
  onOpenDetail: (id: string) => void;
}

/** Local hint only: the relationship sentence is drawn on the connector. */
function sideLabel(side: BranchSide | null): string {
  if (side === 'left') return '左分支';
  if (side === 'right') return '右分支';
  return '分支';
}

/**
 * Variable-height card. The title wraps in full and its height comes from the
 * layout result; the summary keeps a fixed three-line preview so cards do not
 * change height while someone types. The relationship sentence is not repeated
 * here — it belongs to the connector.
 */
function TopicCardComponent({ data, selected }: NodeProps): React.JSX.Element {
  const { node, height, active, resolvedSide, hiddenCount, collapsed, childCount, onToggleCollapse, onOpenDetail } =
    data as TopicCardData;
  // Prefer the side the layout actually used; fall back to the declared one.
  const side = resolvedSide ?? node.side ?? null;
  return (
    <article
      className="topic-card"
      style={{ height }}
      data-state={node.state}
      data-flow={node.flow}
      data-active={active ? 'true' : 'false'}
      data-selected={selected === true ? 'true' : 'false'}
      aria-label={node.number + ' ' + node.title + '，' + node.state}
    >
      <Handle type="target" position={Position.Top} className="rf-handle" isConnectable={false} />
      <header className="topic-card__head">
        <span className="topic-card__number">{node.number}</span>
        <StateChip node={node} active={active} />
        <span className="topic-card__spacer" />
        <button
          type="button"
          className="topic-card__open nodrag nopan"
          title="阅读全文"
          aria-label={'阅读全文：' + node.title}
          onClick={(event) => { event.stopPropagation(); onOpenDetail(node.id); }}
        >
          全文
        </button>
        {childCount > 0 ? (
          <button
            type="button"
            className="topic-card__toggle nodrag nopan"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开 ' + String(hiddenCount) + ' 个隐藏节点' : '折叠 ' + String(childCount) + ' 个后继节点'}
            title={collapsed ? '展开隐藏的后继' : '折叠后继链'}
            onClick={(event) => {
              event.stopPropagation();
              onToggleCollapse(node.id);
            }}
          >
            {collapsed ? '+' + String(hiddenCount) : '−'}
          </button>
        ) : null}
      </header>
      <h3 className="topic-card__title">{node.title}</h3>
      <p className="topic-card__summary">{node.summary}</p>
      <footer className="topic-card__foot">
        <span className="topic-card__flow">
          {node.flow === 'branch' ? sideLabel(side) : ''}
        </span>
      </footer>
      <Handle type="source" position={Position.Bottom} className="rf-handle" isConnectable={false} />
    </article>
  );
}

export const TopicCard = memo(TopicCardComponent);
