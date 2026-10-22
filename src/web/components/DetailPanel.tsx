import { useEffect, useRef } from 'react';
import type { GraphNode, GraphResponse, GraphTopic, NodeDetailResponse, TopicDetailResponse } from '../../shared/protocol.js';
import { MarkdownBody } from './MarkdownBody.js';
import { StateChip, flowLabel } from './display.js';

export type DetailTab = 'node' | 'topic';

export interface DetailPanelProps {
  graph: GraphResponse;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  topic: GraphTopic | null;
  node: GraphNode | null;
  nodeDetail: NodeDetailResponse | null;
  topicDetail: TopicDetailResponse | null;
  loading: boolean;
  error: string | null;
  /** Version the shown detail belongs to; differs while updating after a snapshot. */
  detailVersion: string | null;
  activeNodeId: string | null;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onRetry: () => void;
  onClose: () => void;
  onOpenTopic: (path: string) => void;
  onCopyContinuation: () => void;
  copied: boolean;
  /** Markdown image key → data URI, from the same frozen snapshot as the text. */
  resources?: Readonly<Record<string, string>>;
  /** Resolves a workspace-relative .md path to a stable node id. */
  resolvePathToNode?: (path: string) => string | null;
  onOpenNode?: (nodeId: string) => void;
  /** Boundary nodes from other topics, shown as context only (never full body). */
  boundaryNodes?: GraphNode[];
};

function versionLabel(instanceId: string, revision: number): string {
  return instanceId.slice(0, 8) + ' / r' + String(revision);
}

export function DetailPanel(props: DetailPanelProps): React.JSX.Element {
  const {
    graph, tab, onTabChange, topic, node, nodeDetail, topicDetail, loading, error, detailVersion,
    activeNodeId, selectedNodeId, onSelectNode, onRetry, onClose, onOpenTopic, onCopyContinuation, copied,
    resources, resolvePathToNode, onOpenNode, boundaryNodes,
  } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [tab, node?.id, topic?.id]);

  // description is the format-2 connection text; label is the legacy format-1 fallback.
  const connectionText = ((tab === 'node' ? node?.description ?? node?.label : '') ?? '').trim();
  const topicNodes = topicDetail?.nodes ?? null;
  const graphVersion = graph.instanceId + ':' + String(graph.revision);
  const outdated = detailVersion !== null && detailVersion !== graphVersion;

  return (
    <aside className="detail panel" id="detail-panel" aria-label="详情">
      <div className="panel__head">
        <div
          className="detail__tabs"
          role="tablist"
          aria-label="详情视图"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            onTabChange(tab === 'node' ? 'topic' : 'node');
          }}
        >
          <button
            type="button"
            role="tab"
            id="tab-node"
            aria-selected={tab === 'node'}
            aria-controls="detail-panel-body"
            tabIndex={tab === 'node' ? 0 : -1}
            className="tab"
            onClick={() => { onTabChange('node'); }}
          >
            单卡
          </button>
          <button
            type="button"
            role="tab"
            id="tab-topic"
            aria-selected={tab === 'topic'}
            aria-controls="detail-panel-body"
            tabIndex={tab === 'topic' ? 0 : -1}
            className="tab"
            onClick={() => { onTabChange('topic'); }}
          >
            完整主题
          </button>
        </div>
        <span className="app-header__spacer" />
        <span aria-live="polite" className="visually-hidden">{copied ? '已复制继续讨论提示' : ''}</span>
        <button type="button" onClick={onClose} aria-label="收起详情" title="收起详情">×</button>
      </div>

      {error !== null ? (
        <div className="banner banner--error" role="alert">
          <span className="banner__text">{error}</span>
          <button type="button" onClick={onRetry}>重试</button>
        </div>
      ) : null}
      {outdated ? (
        <div className="banner banner--stale" role="status">
          <span className="banner__text">图已更新，正在获取对应版本详情；此前显示的是 {detailVersion?.split(':')[1] ?? ''} 版本。</span>
        </div>
      ) : null}
      {graph.stale ? (
        <div className="banner banner--stale" role="status">
          <span className="banner__text">磁盘内容当前无效，这里显示上一份有效内容。</span>
        </div>
      ) : null}

      <div
        className="panel__scroll detail__scroll"
        id="detail-panel-body"
        role="tabpanel"
        aria-labelledby={tab === 'node' ? 'tab-node' : 'tab-topic'}
      >
        {tab === 'node' ? (
          node === null ? (
            <div className="state-block">
              <h3>未选择卡片</h3>
              <p>在图或导航中选择一张卡片查看完整正文。</p>
            </div>
          ) : (
            <article className="detail__article" aria-labelledby="detail-node-title">
              <div className="detail__meta">
                <span className="detail__number">{node.number}</span>
                <StateChip node={node} active={node.id === activeNodeId} />
                {node.id === selectedNodeId ? <span className="detail__flag">已选中</span> : null}
                <span className="detail__flag">{flowLabel(node)}</span>
              </div>
              <h2 id="detail-node-title" ref={headingRef} tabIndex={-1} className="detail__title">{node.title}</h2>
              <p className="detail__source">
                {node.from !== null ? '来自 ' + (graph.nodes.find((item) => item.id === node.from)?.number ?? node.from) + ' · ' : ''}
                {topic?.path ?? node.topicId}
              </p>
              {connectionText !== '' ? (
                <div className="detail__connection">
                  <span className="detail__connection-label">
                    {node.flow === 'branch' ? '分支说明' : node.flow === 'root' ? '根说明' : '连接说明'}
                  </span>
                  <p className="detail__connection-text">{connectionText}</p>
                </div>
              ) : null}
              {loading ? (
                <p className="detail__loading" role="status">
                  <span className="spinner" /> 正在获取与当前图版本一致的正文…
                </p>
              ) : null}
              {nodeDetail === null && !loading ? (
                <div className="state-block">
                  <h3>正文暂不可用</h3>
                  <p>未收到与当前图版本一致的正文。可以重试，或直接阅读源文件。</p>
                </div>
              ) : null}
              {nodeDetail !== null && nodeDetail.node.id === node.id ? (
                <>
                  <MarkdownBody
                    source={nodeDetail.body}
                    topicPath={nodeDetail.path}
                    onOpenTopic={onOpenTopic}
                    {...(resolvePathToNode !== undefined ? { resolvePathToNode } : {})}
                    {...(onOpenNode !== undefined ? { onOpenNode } : {})}
                    {...(resources !== undefined ? { resources } : {})}
                  />
                  <p className="detail__version">
                    内容版本 {versionLabel(nodeDetail.instanceId, nodeDetail.revision)} · 来源有效快照
                    {graph.stale ? '（磁盘文件当前无效）' : ''}
                  </p>
                </>
              ) : null}
            </article>
          )
        ) : topic === null ? (
          <div className="state-block">
            <h3>未选择主题</h3>
            <p>在主题目录中打开主题，再选择主题页连续阅读。</p>
          </div>
        ) : (
          <article className="detail__article" aria-labelledby="detail-topic-title">
            <div className="detail__meta">
              <span className="detail__flag">主题</span>
              <span className="detail__number">{String(topic.nodeIds.length)} 张卡片</span>
            </div>
            <h2 id="detail-topic-title" ref={headingRef} tabIndex={-1} className="detail__title">{topic.title}</h2>
            <p className="detail__source">{topic.path} · 文件哈希 {topic.fileHash.slice(0, 12)}…</p>
            {topicDetail !== null ? (
              <p className="detail__origin" data-source={topicDetail.source}>
                {topicDetail.source === 'snapshot'
                  ? '内容来源：有效快照 r' + String(topicDetail.revision) + (graph.stale ? '（磁盘文件当前无效）' : '')
                  : '内容来源：磁盘原文' + (topicDetail.valid ? '' : '（当前无法解析）')}
              </p>
            ) : null}
            <div className="detail__actions">
              <button
                type="button"
                onClick={() => { onCopyContinuation(); }}
              >
                {copied ? '已复制' : '复制继续讨论提示'}
              </button>
              {node !== null ? (
                <button type="button" onClick={() => { onTabChange('node'); }}>回到选中卡片</button>
              ) : null}
            </div>
            {loading ? (
              <p className="detail__loading" role="status">
                <span className="spinner" /> 正在获取与当前图版本一致的完整主题…
              </p>
            ) : null}
            {topicDetail !== null && !topicDetail.valid && topicDetail.source === 'disk' ? (
              <div className="banner banner--error" role="alert">
                <span className="banner__text">磁盘上的主题文件当前无法解析，未显示部分正文。</span>
              </div>
            ) : null}
            <ol className="topic-reader" aria-label="按结构顺序的卡片">
              {topicNodes === null || (topicDetail !== null && topicDetail.topic.id !== topic.id) ? (
                <li className="topic-reader__empty">正文尚未载入；等待与当前图版本一致的内容。</li>
              ) : (
                topicNodes.map((item, index) => (
                  <li key={item.id} className="topic-reader__item" data-selected={item.id === selectedNodeId ? 'true' : 'false'}>
                    <div className="topic-reader__head">
                      <span className="topic-reader__index">{String(index + 1)}</span>
                      <div className="topic-reader__titles">
                        <button
                          type="button"
                          className="topic-reader__title"
                          onClick={() => { onSelectNode(item.id); onTabChange('node'); }}
                        >
                          {item.title}
                        </button>
                        <span className="topic-reader__sub">
                          {item.number} · {flowLabel(item)}
                          {item.id === activeNodeId ? ' · 当前讨论' : ''}
                        </span>
                        {((item.description ?? item.label ?? '').trim()) !== '' ? (
                          <p className="topic-reader__desc">{((item.description ?? item.label ?? '').trim())}</p>
                        ) : null}
                      </div>
                      <StateChip node={item} active={item.id === activeNodeId} />
                    </div>
                    <MarkdownBody
                      source={item.body}
                      topicPath={item.path}
                      onOpenTopic={onOpenTopic}
                      compact
                      {...(resolvePathToNode !== undefined ? { resolvePathToNode } : {})}
                      {...(onOpenNode !== undefined ? { onOpenNode } : {})}
                      {...(resources !== undefined ? { resources } : {})}
                    />
                  </li>
                ))
              )}
            </ol>
            {boundaryNodes !== undefined && boundaryNodes.length > 0 ? (
              <section className="boundary" aria-label="其他主题的边界节点">
                <h3 className="boundary__title">其他主题的来历（仅元数据）</h3>
                <p className="boundary__hint">
                  这些卡片属于别的主题，只保留编号、标题和状态用于说明来路；这里没有它们的正文。
                </p>
                <ul className="boundary__list">
                  {boundaryNodes.map((item) => (
                    <li key={item.id} className="boundary__item">
                      <span className="boundary__number">{item.number}</span>
                      <span className="boundary__label">{item.title}</span>
                      <StateChip node={item} />
                      <span className="boundary__topic">{item.topicId}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <p className="detail__version">
              结构顺序阅读，由 from／flow 决定
              {topicDetail !== null ? ' · 内容版本 ' + versionLabel(topicDetail.instanceId, topicDetail.revision) : ''}
            </p>
          </article>
        )}
      </div>
    </aside>
  );
}
