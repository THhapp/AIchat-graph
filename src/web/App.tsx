import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSnapshot } from './data/snapshot.js';
import { loadReadingState, pruneReadingState, saveReadingState, switchReadingTopic, type ReadingState } from './data/readingState.js';
import { useDetails } from './data/details.js';
import { buildGraphView, scopeGraphToTopic } from './graph/viewModel.js';
import { useLayoutEngine } from './graph/layoutBridge.js';
import { useGraphLayout } from './graph/useGraphLayout.js';
import { searchGraph } from './lib/search.js';
import { buildContinuationPrompt } from './lib/prompt.js';
import { Sidebar } from './components/Sidebar.js';
import { DetailPanel, type DetailTab } from './components/DetailPanel.js';
import { GraphCanvas, findAnchorNodeId } from './components/GraphCanvas.js';
import { EmptyState } from './components/States.js';
import { ExportPanel } from './components/ExportPanel.js';

const DETAIL_MIN = 300;
const DETAIL_MAX = 680;

/** Panels are independent: either, both, or neither may be open. */
function columnTemplate(leftOpen: boolean, detailOpen: boolean, detailWidth: number): string {
  const parts = ['minmax(0, 1fr)'];
  if (leftOpen) parts.unshift('var(--sidebar-width)');
  if (detailOpen) parts.push('5px', String(detailWidth) + 'px');
  return parts.join(' ');
}

export function App(): React.JSX.Element {
  const snapshot = useSnapshot();
  const engineSlot = useLayoutEngine();
  const graph = snapshot.graph;
  const workspaceId = snapshot.workspace?.workspaceId ?? graph?.workspaceId ?? null;

  const [reading, setReading] = useState<ReadingState | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<DetailTab>('node');
  const [fitSignal, setFitSignal] = useState(0);
  const [copied, setCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // Local reading state is per workspace and pruned against the current graph.
  useEffect(() => {
    if (workspaceId === null) return;
    setReading(loadReadingState(workspaceId));
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId === null || reading === null || graph === null) return;
    const pruned = pruneReadingState(reading, graph);
    saveReadingState(workspaceId, pruned);
    const changed =
      pruned.selectedNodeId !== reading.selectedNodeId ||
      pruned.topicFilter !== reading.topicFilter ||
      pruned.collapsedNodeIds.length !== reading.collapsedNodeIds.length;
    if (changed) setReading(pruned);
  }, [workspaceId, reading, graph]);

  const update = useCallback((patch: Partial<ReadingState>) => {
    setReading((current) => (current === null ? current : { ...current, ...patch }));
  }, []);

  const closeDetail = useCallback(() => { update({ rightPanelOpen: false }); }, [update]);

  // Both panels start closed and are toggled independently.
  const leftOpen = reading?.leftPanelOpen ?? false;
  const detailOpen = reading?.rightPanelOpen ?? false;

  const collapsedSet = useMemo(() => new Set(reading?.collapsedNodeIds ?? []), [reading]);
  const currentTopicId = reading?.topicFilter ?? null;
  const topicGraph = useMemo(() => graph === null ? null : scopeGraphToTopic(graph, currentTopicId), [graph, currentTopicId]);
  const view = useMemo(
    () => (topicGraph === null ? null : buildGraphView(topicGraph, collapsedSet, currentTopicId)),
    [topicGraph, collapsedSet, currentTopicId],
  );
  const anchorNodeId = useMemo(
    () => (topicGraph === null || view === null ? null : findAnchorNodeId(view, reading?.selectedNodeId ?? null, topicGraph)),
    [topicGraph, view, reading?.selectedNodeId],
  );

  // Capture the anchor's screen rect before the new geometry is applied. The
  // layout result arrives asynchronously, so at this point the DOM still shows
  // the previous positions and the rect is the one we must preserve.
  const [anchorScreen, setAnchorScreen] = useState<{ x: number; y: number } | null>(null);
  const capturedKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = view?.structureKey ?? null;
    if (key === null || key === capturedKey.current) {
      if (key !== null) return;
      capturedKey.current = null;
      setAnchorScreen(null);
      return;
    }
    capturedKey.current = key;
    if (anchorNodeId === null) {
      setAnchorScreen(null);
      return;
    }
    const element = document.querySelector<HTMLElement>('.react-flow__node[data-id="' + CSS.escape(anchorNodeId) + '"]');
    const cardRect = element?.getBoundingClientRect();
    setAnchorScreen(cardRect !== undefined && cardRect.width > 0 ? { x: cardRect.x, y: cardRect.y } : null);
  }, [view?.structureKey, anchorNodeId]);

  const layoutState = useGraphLayout(view, engineSlot);
  const effectiveTopicId = graph?.topics.some((topic) => topic.id === currentTopicId) ? currentTopicId : null;

  const selectedNode = graph !== null && reading?.selectedNodeId != null
    ? topicGraph?.nodes.find((node) => node.id === reading.selectedNodeId) ?? null
    : null;
  const selectedTopic = graph !== null && effectiveTopicId !== null
    ? graph.topics.find((topic) => topic.id === effectiveTopicId) ?? null
    : null;

  const details = useDetails(
    graph,
    detailOpen && tab === 'node' ? reading?.selectedNodeId ?? null : null,
    detailOpen && tab === 'topic' ? effectiveTopicId : null,
    detailOpen,
    snapshot.refresh,
  );

  const toggleLeft = useCallback(() => {
    setReading((current) => (current === null ? current : { ...current, leftPanelOpen: !current.leftPanelOpen }));
  }, []);
  const toggleRight = useCallback(() => {
    setReading((current) => (current === null ? current : { ...current, rightPanelOpen: !current.rightPanelOpen }));
  }, []);

  const openTopic = useCallback((id: string) => {
    if (!graph?.topics.some((topic) => topic.id === id)) return;
    setReading((current) => current === null ? current : switchReadingTopic(current, id));
    setQuery('');
    setTab('node');
    setCopied(false);
    setFitSignal(0);
  }, [graph]);

  // A link to another theme explicitly opens that theme before its node.
  const selectNode = useCallback((id: string) => {
    const node = graph?.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) return;
    setReading((current) => current === null ? current : { ...switchReadingTopic(current, node.topicId), selectedNodeId: id });
    setTab('node');
    if (node.topicId !== currentTopicId) setQuery('');
  }, [graph, currentTopicId]);

  const selectNodeAndOpen = useCallback((id: string) => {
    const node = graph?.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) return;
    setReading((current) => current === null ? current : { ...switchReadingTopic(current, node.topicId), selectedNodeId: id, rightPanelOpen: true });
    setTab('node');
    if (node.topicId !== currentTopicId) setQuery('');
  }, [graph, currentTopicId]);

  const openTopicByPath = useCallback((path: string) => {
    if (graph === null) return;
    const clean = path.split('#')[0] ?? path;
    const topic = graph.topics.find((candidate) => candidate.path === clean);
    if (topic !== undefined) openTopic(topic.id);
  }, [graph, openTopic]);

  const toggleCollapse = useCallback((id: string) => {
    const node = graph?.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) return;
    setReading((current) => {
      if (current === null) return current;
      const target = switchReadingTopic(current, node.topicId);
      const exists = target.collapsedNodeIds.includes(id);
      return {
        ...target,
        collapsedNodeIds: exists
          ? target.collapsedNodeIds.filter((candidate) => candidate !== id)
          : [...target.collapsedNodeIds, id],
      };
    });
    if (node.topicId !== currentTopicId) {
      setQuery('');
      setTab('node');
    }
  }, [graph, currentTopicId]);

  const copyPrompt = useCallback(() => {
    if (graph === null) return;
    const topic = selectedTopic ?? (selectedNode !== null ? graph.topics.find((item) => item.id === selectedNode.topicId) ?? null : null);
    const text = buildContinuationPrompt({
      workspace: snapshot.workspace,
      graph,
      topic,
      node: selectedNode,
    });
    const done = (): void => {
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 2000);
    };
    const fallback = (): void => {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      if (ok) done();
      else setCopied(false);
    };
    if (navigator.clipboard !== undefined) {
      navigator.clipboard.writeText(text).then(done, () => { fallback(); });
    } else {
      fallback();
    }
  }, [graph, snapshot.workspace, selectedNode, selectedTopic]);

  const detailWidth = reading?.detailWidth ?? 380;
  const resizeDetail = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = reading?.detailWidth ?? 380;
    const onMove = (move: PointerEvent): void => {
      const next = Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, startWidth + (startX - move.clientX)));
      update({ detailWidth: next });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [reading?.detailWidth, update]);

  if (snapshot.loading) {
    return (
      <div className="app app--center">
        <div className="state-block state-block--center">
          <h3><span className="spinner" /> 正在载入工作区…</h3>
          <p>连接本地服务并读取有效快照。非法文件不会被当作空图。</p>
        </div>
      </div>
    );
  }

  if (graph === null) {
    return (
      <div className="app app--center">
        <div className="state-block state-block--center">
          <h3>无法载入图</h3>
          <p role="alert">{snapshot.error?.message ?? '服务未返回有效图数据。'}</p>
          <p>请确认本地服务已启动并指向正确的工作区；界面不会用空白图伪装成功。</p>
          <div className="state-block__actions">
            <button type="button" onClick={() => { snapshot.refresh(); }}>重试</button>
            <a href="/api/diagnostics" target="_blank" rel="noreferrer">查看诊断</a>
          </div>
        </div>
      </div>
    );
  }

  const results = searchGraph(topicGraph ?? scopeGraphToTopic(graph, null), query);
  const status = snapshot.error !== null
    ? { tone: 'bad', text: '刷新失败' }
    : graph.stale
      ? { tone: 'warn', text: '上一份有效内容' }
      : snapshot.connection === 'open'
        ? { tone: 'ok', text: '已同步' }
        : { tone: 'warn', text: snapshot.connection === 'reconnecting' ? '正在重连' : '离线' };

  const isEmpty = graph.nodes.length === 0;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__brand">
          <span className="app-header__title">AIchat-graph</span>
          <span className="app-header__workspace">{snapshot.workspace?.name ?? graph.workspaceId}</span>
          <button type="button" className="app-header__topic" onClick={() => { update({ leftPanelOpen: true }); }} title={(selectedTopic?.title ?? '选择主题') + ' · 打开主题目录'}>
            {selectedTopic?.title ?? '选择主题'} ▾
          </button>
        </div>
        <span className="app-header__spacer" />
        <div className="app-header__meta">
          <span>图 r{graph.revision}</span>
          {topicGraph?.activeNode != null ? (
            <button
              type="button"
              onClick={() => { selectNode(topicGraph.activeNode as string); }}
              title="定位当前讨论节点"
            >
              当前讨论
            </button>
          ) : null}
          <button type="button" disabled={selectedTopic === null} onClick={() => { update({ collapsedNodeIds: [] }); setFitSignal((value) => value + 1); }} title="展开并适配当前主题">查看全部</button>
          <button type="button" disabled={selectedTopic === null} onClick={copyPrompt}>{copied ? '已复制' : '复制给 Agent'}</button>
          <button
            type="button"
            aria-pressed={leftOpen}
            aria-controls="nav-panel"
            onClick={toggleLeft}
            title="主题目录"
          >
            {leftOpen ? '收起目录' : '主题目录'}
          </button>
          <button
            type="button"
            aria-pressed={detailOpen}
            aria-controls="detail-panel"
            onClick={toggleRight}
            title="详情面板"
          >
            {detailOpen ? '收起详情' : '打开详情'}
          </button>
          <button
            type="button"
            aria-pressed={exportOpen}
            aria-controls="export-panel"
            onClick={() => { setExportOpen((value) => !value); }}
            title="导出为独立 HTML"
          >
            {exportOpen ? '收起导出' : '导出'}
          </button>
        </div>
      </header>

      {exportOpen ? (
        <ExportPanel
          graphRevision={graph.revision}
          instanceId={graph.instanceId}
          focusedTopicId={effectiveTopicId}
          liveStatuses={snapshot.exportStatuses}
          onClose={() => { setExportOpen(false); }}
        />
      ) : null}
      {graph.stale ? (
        <div className="banner banner--stale" role="status">
          <span className="banner__text">
            <strong>显示上一份有效内容。</strong> 磁盘上的源文件当前不合法或无法读取，图与详情来自同一份有效快照，不是当前磁盘事实。
          </span>
          <button type="button" onClick={() => { snapshot.refresh(); }}>重新检查</button>
        </div>
      ) : null}
      {snapshot.error !== null ? (
        <div className="banner banner--error" role="alert">
          <span className="banner__text">刷新失败：{snapshot.error.message}（保留当前阅读内容）</span>
          <button type="button" onClick={() => { snapshot.refresh(); }}>重试</button>
        </div>
      ) : null}

      <div
        className="app-main"
        data-left={leftOpen ? 'open' : 'closed'}
        data-detail={detailOpen ? 'open' : 'closed'}
        style={{
          gridTemplateColumns: columnTemplate(leftOpen, detailOpen, detailWidth),
        }}
      >
        {leftOpen ? <Sidebar
          graph={graph}
          query={query}
          onQueryChange={setQuery}
          results={results}
          collapsed={collapsedSet}
          activeNodeId={graph.activeNode}
          selectedNodeId={reading?.selectedNodeId ?? null}
          topicFilter={reading?.topicFilter ?? null}
          onSelectNode={selectNode}
          onOpenTopic={openTopic}
          onToggleCollapse={toggleCollapse}
          onTopicFilter={(id) => { update({ topicFilter: id }); }}
          onSelectTopicPath={openTopicByPath}
          onClose={() => { update({ leftPanelOpen: false }); }}
          directoryMode
          onCopyTopic={copyPrompt}
          copied={copied}
        /> : null}

        <main className="canvas-host" id="main-content">
          {isEmpty ? (
            <EmptyState topicCount={graph.topics.length} onRetry={() => { snapshot.refresh(); }} />
          ) : selectedTopic === null ? (
            <div className="canvas-host__empty"><div className="state-block">
              <h3>选择一个主题开始阅读</h3>
              <p>每个主题有独立的讨论图。打开主题目录选择；新主题由外部 Agent 创建。</p>
              <button type="button" onClick={() => { update({ leftPanelOpen: true }); }}>打开主题目录</button>
            </div></div>
          ) : (
            <GraphCanvas
              key={selectedTopic.id}
              graph={topicGraph ?? graph}
              view={view ?? buildGraphView(topicGraph ?? graph, collapsedSet, currentTopicId)}
              layout={layoutState.result?.structureVersion === view?.structureKey ? layoutState.result : null}
              layoutStatus={layoutState.status}
              layoutError={layoutState.error?.message ?? null}
              activeNodeId={topicGraph?.activeNode ?? null}
              selectedNodeId={reading?.selectedNodeId ?? null}
              onSelectNode={selectNode}
              onOpenNodeDetail={selectNodeAndOpen}
              onToggleCollapse={toggleCollapse}
              onViewportChange={(viewport) => { update({ viewport }); }}
              fitSignal={fitSignal}
              savedViewport={reading?.viewport ?? null}
              anchorNodeId={anchorNodeId}
              anchorScreen={anchorScreen}
            />
          )}
        </main>

        {detailOpen ? (
          <>
            <div
              className="detail-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整详情宽度"
              aria-valuemin={DETAIL_MIN}
              aria-valuemax={DETAIL_MAX}
              aria-valuenow={detailWidth}
              tabIndex={0}
              onPointerDown={resizeDetail}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') update({ detailWidth: Math.min(DETAIL_MAX, detailWidth + 24) });
                if (event.key === 'ArrowRight') update({ detailWidth: Math.max(DETAIL_MIN, detailWidth - 24) });
              }}
            />
            <DetailPanel
              graph={graph}
              tab={tab}
              onTabChange={(next) => {
                setTab(next);
              }}
              topic={selectedTopic}
              node={selectedNode}
              nodeDetail={details.nodeDetail}
              topicDetail={details.topicDetail}
              loading={details.loading}
              error={details.error}
              detailVersion={details.detailVersion}
              activeNodeId={topicGraph?.activeNode ?? null}
              selectedNodeId={reading?.selectedNodeId ?? null}
              onSelectNode={selectNodeAndOpen}
              onRetry={details.retry}
              onClose={closeDetail}
              onOpenTopic={openTopicByPath}
              onCopyContinuation={copyPrompt}
              copied={copied}
              resolvePathToNode={(path) => graph.nodes.find((candidate) => candidate.sourcePath === path)?.id ?? null}
              onOpenNode={(id) => { selectNodeAndOpen(id); }}
            />
          </>
        ) : null}
      </div>

      <footer className="app-status">
        <span className={'dot dot--' + status.tone} aria-hidden="true" />
        <span role="status">{status.text}</span>
        <span>{String(topicGraph?.nodes.length ?? 0)} 节点 · 当前主题 / 全库 {String(graph.topics.length)} 主题</span>
        {(graph.topicMode ?? snapshot.workspace?.topicMode ?? 'shared') === 'shared' ? <span title="旧主题可能有跨主题来路；当前仅显示所选主题，源关系未改写。">共享图兼容（未迁移）</span> : null}
        {layoutState.result !== null ? (
          <span>{String(Object.keys(layoutState.result.positions).length)} 可见</span>
        ) : null}
        <span className="app-status__spacer" />
        <span>实例 {graph.instanceId.slice(0, 8)} · r{graph.revision}</span>
        <a href="/api/diagnostics" target="_blank" rel="noreferrer">诊断</a>
      </footer>
    </div>
  );
}
