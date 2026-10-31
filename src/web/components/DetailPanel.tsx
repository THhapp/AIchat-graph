import { useEffect, useRef } from 'react';
import type {
  ChangeBatchSummary,
  ChangeKind,
  ChangeNodeDiff,
  GraphNode,
  GraphResponse,
  GraphTopic,
  NodeDetailResponse,
  TopicDetailResponse,
} from '../../next/protocol.js';
import { changeCountsLabel, changeFieldLabel, changeKindLabel, formatChangeValue, graphHasNode } from '../lib/changes.js';
import { MarkdownBody } from './MarkdownBody.js';
import { CurrentMarker, flowLabel } from './display.js';

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
  onCopyContinuation: () => void;
  copied: boolean;
  /** Opens a card referenced from body text (aichat:node/<id>); absent offline. */
  onOpenNode?: (nodeId: string) => void;
  /** Boundary nodes from other topics, shown as context only (never full body). */
  boundaryNodes?: GraphNode[];
  /** Copies the stable locator of the selected card; the parent builds the text. */
  onCopyLocate?: () => void;
  locateCopied?: boolean;
  /** Source-level importance flag of the selected card. */
  important?: boolean;
  onToggleImportant?: (next: boolean) => void;
  importanceBusy?: boolean;
  /** The service is stopped, so the importance write cannot run. */
  importanceDisabled?: boolean;
  importanceError?: string | null;
  /** Latest persisted content batch of the open topic; drives the change list. */
  batch?: ChangeBatchSummary | null;
  /** This node's change kind in that batch, if it changed. */
  changeKind?: ChangeKind | null;
  /**
   * Node whose diff is expanded, from the card meta or a topic change row.
   * The parent owns the target so the same on-demand request backs both places.
   */
  changeTargetNodeId?: string | null;
  nodeChange?: ChangeNodeDiff | null;
  nodeChangeLoading?: boolean;
  /** The service answered that the node has no diff in the latest batch. */
  nodeChangeMissing?: boolean;
  nodeChangeError?: string | null;
  /** Expand/collapse one node's diff; selecting an existing card is the caller's job. */
  onToggleChange?: (nodeId: string) => void;
};

function versionLabel(instanceId: string, revision: number): string {
  return instanceId.slice(0, 8) + ' / r' + String(revision);
}

interface ChangeDiffBodyProps {
  change: ChangeNodeDiff | null;
  loading: boolean;
  missing: boolean;
  error: string | null;
  kind: ChangeKind | null;
}

/** Field before/after rows plus the unified body patch; shared by card and list. */
function ChangeDiffBody({ change, loading, missing, error, kind }: ChangeDiffBodyProps): React.JSX.Element {
  return (
    <>
      {loading ? (
        <p className="detail__loading" role="status">
          <span className="spinner" /> 正在读取本次差异…
        </p>
      ) : null}
      {error !== null ? (
        <div className="banner banner--error" role="alert">
          <span className="banner__text">{error}</span>
        </div>
      ) : null}
      {!loading && error === null && change === null ? (
        <p className="change-diff__empty">
          {missing ? '最新变化批次里没有这张卡片。' : '本次变化没有这张卡片的可读差异。'}
        </p>
      ) : null}
      {change !== null ? (
        <>
          {change.fieldDiffs.length > 0 ? (
            <ul className="change-fields" aria-label="字段差异">
              {change.fieldDiffs.map((diff) => (
                <li key={diff.field} className="change-fields__row">
                  <span className="change-fields__name">{changeFieldLabel(diff.field)}</span>
                  <span className="change-fields__before">{formatChangeValue(diff.before)}</span>
                  <span className="change-fields__arrow" aria-hidden="true">→</span>
                  <span className="change-fields__after">{formatChangeValue(diff.after)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="change-diff__empty">
              {kind === 'added' ? '本次新增了这张卡片。' : kind === 'deleted' ? '本次删除了这张卡片。' : '本次没有字段级变化。'}
            </p>
          )}
          {change.body !== undefined ? (
            <div className="change-patch">
              <p className="change-patch__meta">
                正文差异 +{String(change.body.addedLines)} / −{String(change.body.removedLines)}
                {change.body.truncated ? '（已截断）' : ''}
              </p>
              <pre className="change-patch__pre" aria-label="正文 unified diff">
                {change.body.patch.split('\n').map((line, index) => {
                  const tone = line.startsWith('+') && !line.startsWith('+++')
                    ? 'add'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'del'
                      : line.startsWith('@@')
                        ? 'hunk'
                        : 'plain';
                  return (
                    <span key={String(index)} className={'change-patch__line change-patch__line--' + tone}>
                      {line}{'\n'}
                    </span>
                  );
                })}
              </pre>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function DetailPanel(props: DetailPanelProps): React.JSX.Element {
  const {
    graph, tab, onTabChange, topic, node, nodeDetail, topicDetail, loading, error, detailVersion,
    activeNodeId, selectedNodeId, onSelectNode, onRetry, onClose, onCopyContinuation, copied,
    onOpenNode, boundaryNodes,
    onCopyLocate, locateCopied, important = false, onToggleImportant, importanceBusy = false, importanceDisabled = false, importanceError = null,
    batch = null, changeKind = null, changeTargetNodeId = null, nodeChange = null, nodeChangeLoading = false,
    nodeChangeMissing = false, nodeChangeError = null, onToggleChange,
  } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [tab, node?.id, topic?.id]);

  const connectionText = (tab === 'node' ? node?.description ?? '' : '').trim();
  const topicNodes = topicDetail?.nodes ?? null;
  const graphVersion = graph.instanceId + ':' + String(graph.revision);
  const outdated = detailVersion !== null && detailVersion !== graphVersion;
  const changeTarget = changeTargetNodeId ?? null;
  const nodeChangeVisible = node !== null && changeTarget === node.id;
  const nodeChangeToggleVisible = changeKind !== null && onToggleChange !== undefined;

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
          <span className="banner__text">当前显示上一份有效快照。</span>
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
                {node.id === activeNodeId ? <CurrentMarker /> : null}
                {node.id === selectedNodeId ? <span className="detail__flag">已选中</span> : null}
                <span className="detail__flag">{flowLabel(node)}</span>
                {changeKind !== null ? (
                  <span className="detail__change" data-kind={changeKind}>{changeKindLabel(changeKind)}</span>
                ) : null}
                {important ? <span className="detail__flag detail__flag--important">重要</span> : null}
              </div>
              <h2 id="detail-node-title" ref={headingRef} tabIndex={-1} className="detail__title">{node.title}</h2>
              <p className="detail__source">
                {node.from !== null ? '来自 ' + (graph.nodes.find((item) => item.id === node.from)?.number ?? node.from) + ' · ' : ''}
                {topic !== null ? '主题 ' + topic.key + ' · r' + String(topic.revision) : 'topicId ' + node.topicId}
              </p>
              {onCopyLocate !== undefined || onToggleImportant !== undefined || nodeChangeToggleVisible ? (
                <div className="detail__actions">
                  {onCopyLocate !== undefined ? (
                    <button type="button" onClick={() => { onCopyLocate(); }}>{locateCopied === true ? '已复制定位' : '复制定位'}</button>
                  ) : null}
                  {nodeChangeToggleVisible && node !== null && onToggleChange !== undefined ? (
                    <button type="button" aria-expanded={nodeChangeVisible} onClick={() => { onToggleChange(node.id); }}>
                      {nodeChangeVisible ? '收起本次差异' : '查看本次差异'}
                    </button>
                  ) : null}
                  {onToggleImportant !== undefined ? (
                    <button
                      type="button"
                      aria-pressed={important}
                      disabled={importanceBusy || importanceDisabled}
                      title={
                        importanceDisabled
                          ? '服务已停止，无法写入数据库'
                          : important
                            ? '取消重要标记（写入数据库）'
                            : '标记为重要（写入数据库）'
                      }
                      onClick={() => { onToggleImportant(!important); }}
                    >
                      {importanceBusy ? '正在保存…' : important ? '取消重要' : '设为重要'}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {importanceError !== null ? (
                <div className="banner banner--error" role="alert">
                  <span className="banner__text">{importanceError}</span>
                </div>
              ) : null}
              {nodeChangeVisible ? (
                <section className="change-diff" aria-label="本次差异">
                  <h3 className="change-diff__title">本次差异</h3>
                  <ChangeDiffBody
                    change={nodeChange}
                    loading={nodeChangeLoading}
                    missing={nodeChangeMissing}
                    error={nodeChangeError}
                    kind={changeKind}
                  />
                </section>
              ) : null}
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
                  <p>未收到与当前图版本一致的正文。可以重试，或让 Agent 重新读取这张卡片。</p>
                </div>
              ) : null}
              {nodeDetail !== null && nodeDetail.node.id === node.id ? (
                <>
                  <MarkdownBody
                    source={nodeDetail.body}
                    {...(onOpenNode !== undefined ? { onOpenNode } : {})}
                    {...(nodeDetail.resources !== undefined ? { resources: nodeDetail.resources } : {})}
                  />
                  <p className="detail__version">
                    内容版本 {versionLabel(nodeDetail.instanceId, nodeDetail.revision)} · 数据库快照
                    {graph.stale ? '（当前显示上一份有效快照）' : ''}
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
            <p className="detail__source">主题键 {topic.key} · r{String(topic.revision)}</p>
            {topicDetail !== null ? (
              <p className="detail__origin" data-source={topicDetail.source}>
                {'内容来源：数据库快照 r' + String(topicDetail.revision) + (graph.stale ? '（当前显示上一份有效快照）' : '')}
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
            {topicDetail !== null && !topicDetail.valid ? (
              <div className="banner banner--error" role="alert">
                <span className="banner__text">该主题的正文当前未能完整读取，未显示部分正文。</span>
              </div>
            ) : null}
            {batch !== null ? (
              <section className="topic-changes" aria-label="主题本次变化">
                <h3 className="topic-changes__title">
                  本次变化
                  <span className="topic-changes__counts">{changeCountsLabel(batch.counts)}</span>
                </h3>
                {batch.nodes.length === 0 ? (
                  <p className="topic-changes__empty">最新批次没有可列出的节点。</p>
                ) : (
                  <ul className="topic-changes__list">
                    {batch.nodes.map((item) => {
                      const selectable = graphHasNode(graph, item.nodeId);
                      const expanded = changeTarget === item.nodeId;
                      return (
                        <li key={item.nodeId} className="topic-changes__item" data-expanded={expanded ? 'true' : 'false'}>
                          {onToggleChange !== undefined ? (
                            <button
                              type="button"
                              className="topic-changes__row"
                              aria-expanded={expanded}
                              title={selectable ? '选中卡片并展开本次差异' : '展开本次差异（卡片已删除）'}
                              onClick={() => {
                                if (selectable) onSelectNode(item.nodeId);
                                onToggleChange(item.nodeId);
                              }}
                            >
                              <span className="detail__change" data-kind={item.kind}>{changeKindLabel(item.kind)}</span>
                              <span className="topic-changes__name">{item.title}</span>
                              {item.fields.length > 0 ? (
                                <span className="topic-changes__fields">{item.fields.map(changeFieldLabel).join('、')}</span>
                              ) : null}
                              <span className="topic-changes__action">{expanded ? '收起差异' : '查看差异'}</span>
                            </button>
                          ) : (
                            <div className="topic-changes__row">
                              <span className="detail__change" data-kind={item.kind}>{changeKindLabel(item.kind)}</span>
                              <span className="topic-changes__name">{item.title}</span>
                              {item.fields.length > 0 ? (
                                <span className="topic-changes__fields">{item.fields.map(changeFieldLabel).join('、')}</span>
                              ) : null}
                            </div>
                          )}
                          {expanded ? (
                            <div className="topic-changes__diff">
                              <ChangeDiffBody
                                change={nodeChange}
                                loading={nodeChangeLoading}
                                missing={nodeChangeMissing}
                                error={nodeChangeError}
                                kind={item.kind}
                              />
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
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
                        {(item.description ?? '').trim() !== '' ? (
                          <p className="topic-reader__desc">{(item.description ?? '').trim()}</p>
                        ) : null}
                      </div>
                      {item.id === activeNodeId ? <CurrentMarker /> : null}
                    </div>
                    <MarkdownBody
                      source={item.body}
                      compact
                      {...(onOpenNode !== undefined ? { onOpenNode } : {})}
                      {...(topicDetail?.resources !== undefined ? { resources: topicDetail.resources } : {})}
                    />
                  </li>
                ))
              )}
            </ol>
            {boundaryNodes !== undefined && boundaryNodes.length > 0 ? (
              <section className="boundary" aria-label="其他主题的边界节点">
                <h3 className="boundary__title">其他主题的来历（仅元数据）</h3>
                <p className="boundary__hint">
                  这些卡片属于别的主题，只保留编号、标题和主题用于说明来路；这里没有它们的正文。
                </p>
                <ul className="boundary__list">
                  {boundaryNodes.map((item) => (
                    <li key={item.id} className="boundary__item">
                      <span className="boundary__number">{item.number}</span>
                      <span className="boundary__label">{item.title}</span>
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
