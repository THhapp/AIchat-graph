import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { GraphNode } from '../../shared/protocol.js';
import { StateChip, truncate } from './display.js';

/** One line only: the card shows the start, the full text lives in the detail panel. */
const CARD_DESC_LIMIT = 42;

export interface TopicCardData extends Record<string, unknown> {
  node: GraphNode;
  active: boolean;
  hiddenCount: number;
  collapsed: boolean;
  childCount: number;
  onToggleCollapse: (id: string) => void;
  /** Explicit "read this card" action; a plain click only selects. */
  onOpenDetail: (id: string) => void;
}

/** Fixed 360x152 card. Title clamps to two lines, summary to three. */
function TopicCardComponent({ data, selected }: NodeProps): React.JSX.Element {
  const { node, active, hiddenCount, collapsed, childCount, onToggleCollapse, onOpenDetail } = data as TopicCardData;
  // description is the format-2 truth; label is legacy format-1 compatibility.
  const edgeText = (node.description ?? node.label ?? '').trim();
  return (
    <article
      className="topic-card"
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
          {node.flow === 'branch' ? (node.side === 'left' ? '左分支' : '右分支') : ''}
        </span>
        {edgeText !== '' ? (
          <span className="topic-card__desc" title={edgeText}>
            {truncate(edgeText, CARD_DESC_LIMIT)}
          </span>
        ) : null}
      </footer>
      <Handle type="source" position={Position.Bottom} className="rf-handle" isConnectable={false} />
    </article>
  );
}

export const TopicCard = memo(TopicCardComponent);