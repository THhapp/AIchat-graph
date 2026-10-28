import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { GraphNode } from '../../next/protocol.js';
import { StateChip, stateLabel } from './display.js';

export interface TopicCardData extends Record<string, unknown> {
  node: GraphNode;
  /** Card height in px, already matched by layout and by the graph geometry. */
  height: number;
  active: boolean;
  hiddenCount: number;
  collapsed: boolean;
  childCount: number;
  /** This node is part of the current topic's `GraphResponse.lastChanges[topicId].nodeIds`. */
  recent: boolean;
  /** An importance write for this card is in flight; the button keeps its size. */
  importanceBusy: boolean;
  /** Omitted in the read-only offline reader, so no write control is rendered. */
  onToggleImportant?: (node: GraphNode, important: boolean) => void;
  onToggleCollapse: (id: string) => void;
}

/**
 * Variable-height card. The title wraps in full and its height comes from the
 * layout result; the summary keeps a fixed three-line preview so cards do not
 * change height while someone types. The relationship sentence is not repeated
 * here — it belongs to the connector — so the footer row carries the recent-change
 * marker instead, inside the height the card already had.
 */
function TopicCardComponent({ data, selected }: NodeProps): React.JSX.Element {
  const { node, height, active, hiddenCount, collapsed, childCount, recent, importanceBusy, onToggleImportant, onToggleCollapse } = data as TopicCardData;
  const important = node.important;
  const importanceLabel = (important ? '取消重要标记：' : '标记为重要：') + node.number + ' ' + node.title;
  return (
    <article
      className="topic-card"
      style={{ height }}
      data-state={node.state}
      data-flow={node.flow}
      data-active={active ? 'true' : 'false'}
      data-selected={selected === true ? 'true' : 'false'}
      data-recent={recent ? 'true' : 'false'}
      data-important={important ? 'true' : 'false'}
      aria-label={node.number + ' ' + node.title + '，' + stateLabel(node.state) + (important ? '，重要' : '') + (recent ? '，最近更新' : '')}
    >
      <Handle type="target" position={Position.Top} className="rf-handle" isConnectable={false} />
      <header className="topic-card__head">
        <span className="topic-card__number">{node.number}</span>
        <StateChip node={node} active={active} />
        <span className="topic-card__spacer" />
        {onToggleImportant !== undefined ? (
          <button
            type="button"
            className="topic-card__pin topic-card__pin--action nodrag nopan"
            aria-pressed={important}
            aria-busy={importanceBusy}
            aria-label={importanceLabel}
            title={importanceBusy ? '正在保存…' : important ? '取消重要标记（写入数据库）' : '标记为重要（写入数据库）'}
            disabled={importanceBusy}
            data-busy={importanceBusy ? 'true' : 'false'}
            onClick={(event) => {
              // The whole card selects / opens detail; the pin is its own control.
              event.stopPropagation();
              onToggleImportant(node, !important);
            }}
            onDoubleClick={(event) => { event.stopPropagation(); }}
            onPointerDown={(event) => { event.stopPropagation(); }}
          >
            {important ? '★' : '☆'}
          </button>
        ) : important ? (
          <span className="topic-card__pin" title="已标记为重要" aria-label="已标记为重要">★</span>
        ) : null}
        {childCount > 0 ? (
          <button
            type="button"
            className="topic-card__toggle nodrag nopan"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开 ' + String(hiddenCount) + ' 个隐藏节点' : '折叠 ' + String(childCount) + ' 个后继节点'}
            title={collapsed ? '展开 ' + String(hiddenCount) + ' 个隐藏的后继节点' : '折叠 ' + String(childCount) + ' 个后继节点'}
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
        {recent ? (
          <span className="topic-card__recent" title="最近一次写入涉及这张卡片">
            <span className="topic-card__recent-dot" aria-hidden="true" />最近更新
          </span>
        ) : null}
      </footer>
      <Handle type="source" position={Position.Bottom} className="rf-handle" isConnectable={false} />
    </article>
  );
}

export const TopicCard = memo(TopicCardComponent);
