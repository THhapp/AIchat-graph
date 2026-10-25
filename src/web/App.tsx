import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSnapshot } from './data/snapshot.js';
import {
  leftPanelOpenFor,
  navCollapsedNodeIds,
  navFolderExpanded,
  setLeftPanelOpen,
  switchReadingTopic,
  toggleLeftPanel,
  toggleNavFolder,
  toggleNavNode,
  type ReadingState,
} from './data/readingState.js';
import { useReadingSession } from './data/useReadingSession.js';
import { useDetails } from './data/details.js';
import { buildGraphView, scopeGraphToTopic } from './graph/viewModel.js';
import { useLayoutEngine } from './graph/layoutBridge.js';
import { useGraphLayout } from './graph/useGraphLayout.js';
import { searchGraph } from './lib/search.js';
import { buildContinuationPrompt } from './lib/prompt.js';
import { buildLocateText } from './lib/locate.js';
import { copyText } from './lib/clipboard.js';
import { recentNodeIds } from './lib/recent.js';
import { importanceOf, useImportance } from './lib/importance.js';
import { Sidebar } from './components/Sidebar.js';
import { DetailPanel, type DetailTab } from './components/DetailPanel.js';
import { GraphCanvas } from './components/GraphCanvas.js';
import { findAnchorNodeId } from './graph/flowEdges.js';
import { EmptyState } from './components/States.js';
import { ExportPanel } from './components/ExportPanel.js';
import { AppBanners, AppFooter, AppHeader, type AppStatus } from './components/AppChrome.js';
import type { GraphNode, GraphResponse } from '../shared/protocol.js';

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
  const sourceGraph = snapshot.graph;
  const workspaceId = snapshot.workspace?.workspaceId ?? sourceGraph?.workspaceId ?? null;

  // Local reading state is per workspace and pruned against the current graph.
  const { reading, setReading } = useReadingSession(workspaceId, sourceGraph);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<DetailTab>('node');
  const [fitSignal, setFitSignal] = useState(0);
  const [copied, setCopied] = useState(false);
  const [locateCopied, setLocateCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  /**
   * The last accepted importance write, applied on top of the snapshot until the
   * service's own snapshot catches up. Never a source of truth: entries are
   * dropped as soon as the graph already reports the same value.
   */
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, GraphNode>>({});

  const graph = useMemo<GraphResponse | null>(() => {
    if (sourceGraph === null) return null;
    const ids = Object.keys(nodeOverrides);
    if (ids.length === 0) return sourceGraph;
    return { ...sourceGraph, nodes: sourceGraph.nodes.map((node) => nodeOverrides[node.id] ?? node) };
  }, [sourceGraph, nodeOverrides]);

  // An override is only needed until the refreshed graph says the same thing.
  useEffect(() => {
    if (sourceGraph === null) return;
    setNodeOverrides((current) => {
      const ids = Object.keys(current);
      if (ids.length === 0) return current;
      const next = { ...current };
      let changed = false;
      for (const id of ids) {
        const fresh = sourceGraph.nodes.find((node) => node.id === id);
        if (fresh === undefined || importanceOf(fresh) === importanceOf(current[id])) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [sourceGraph]);

  const update = useCallback((patch: Partial<ReadingState>) => {
    setReading((current) => (current === null ? current : { ...current, ...patch }));
  }, []);

  const closeDetail = useCallback(() => { update({ rightPanelOpen: false }); }, [update]);

  // Both panels start closed and are toggled independently. The directory fold is
  // remembered per topic; the detail panel is a session-level choice.
  const leftOpen = reading === null ? false : leftPanelOpenFor(reading);
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

  // Decoration only: derived from the graph and the current topic, so folding,
  // zooming and selecting can never make it appear or disappear.
  const recent = useMemo(() => recentNodeIds(graph, effectiveTopicId), [graph, effectiveTopicId]);

  const navCollapsedSet = useMemo(
    () => new Set(reading === null ? [] : navCollapsedNodeIds(reading.navTree, currentTopicId ?? '')),
    [reading, currentTopicId],
  );
  const expandedTopicIds = useMemo(() => {
    const set = new Set<string>();
    if (graph === null || reading === null) return set;
    for (const topic of graph.topics) {
      if (navFolderExpanded(reading.navTree, topic.id, currentTopicId)) set.add(topic.id);
    }
    return set;
  }, [graph, reading, currentTopicId]);

  /** Directory folds are local reading state; they never collapse the graph. */
  const toggleTopicFolder = useCallback((topicId: string) => {
    setReading((current) => (current === null ? current : toggleNavFolder(current, topicId, current.topicFilter)));
  }, []);
  const toggleNavNodeId = useCallback((nodeId: string) => {
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) return;
    setReading((current) => (current === null ? current : toggleNavNode(current, node.topicId, nodeId)));
  }, [graph]);

  const selectedDetailHash = selectedNode !== null && details.nodeDetail !== null && details.nodeDetail.node.id === selectedNode.id
    ? details.nodeDetail.fileHash
    : null;
  const applyImportanceNode = useCallback((node: GraphNode) => {
    setNodeOverrides((current) => ({ ...current, [node.id]: node }));
  }, []);
  const importance = useImportance({
    onApplied: applyImportanceNode,
    onRefresh: snapshot.refresh,
  });
  const importantErrorForSelected = selectedNode !== null && importance.error?.nodeId === selectedNode.id
    ? importance.error.message
    : null;
  const importantBusyForSelected = selectedNode !== null && importance.busyIds.has(selectedNode.id);

  const toggleLeft = useCallback(() => {
    setReading((current) => (current === null ? current : toggleLeftPanel(current)));
  }, []);
  const openLeft = useCallback(() => {
    setReading((current) => (current === null ? current : setLeftPanelOpen(current, true)));
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
    copyText(
      text,
      () => {
        setCopied(true);
        window.setTimeout(() => { setCopied(false); }, 2000);
      },
      () => { setCopied(false); },
    );
  }, [graph, snapshot.workspace, selectedNode, selectedTopic]);

  /**
   * The locator is built from the card currently on screen: IDs, real paths and
   * the service's own entry paths. No body text and no other topic's content.
   */
  const copyLocate = useCallback(() => {
    if (graph === null || selectedNode === null) return;
    const topic = selectedTopic ?? graph.topics.find((item) => item.id === selectedNode.topicId) ?? null;
    const text = buildLocateText({ workspace: snapshot.workspace, graph, topic, node: selectedNode });
    copyText(
      text,
      () => {
        setLocateCopied(true);
        window.setTimeout(() => { setLocateCopied(false); }, 2000);
      },
      () => { setLocateCopied(false); },
    );
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
  const status: AppStatus = snapshot.error !== null
    ? { tone: 'bad', text: '刷新失败' }
    : graph.stale
      ? { tone: 'warn', text: '上一份有效内容' }
      : snapshot.connection === 'open'
        ? { tone: 'ok', text: '已同步' }
        : { tone: 'warn', text: snapshot.connection === 'reconnecting' ? '正在重连' : '离线' };

  const isEmpty = graph.nodes.length === 0;

  return (
    <div className="app">
      <AppHeader
        workspaceName={snapshot.workspace?.name ?? graph.workspaceId}
        graphRevision={graph.revision}
        selectedTopicTitle={selectedTopic?.title ?? null}
        activeNodeId={topicGraph?.activeNode ?? null}
        topicSelected={selectedTopic !== null}
        leftOpen={leftOpen}
        detailOpen={detailOpen}
        exportOpen={exportOpen}
        copied={copied}
        onOpenLeft={openLeft}
        onSelectNode={selectNode}
        onResetView={() => { update({ collapsedNodeIds: [] }); setFitSignal((value) => value + 1); }}
        onCopyPrompt={copyPrompt}
        onToggleLeft={toggleLeft}
        onToggleRight={toggleRight}
        onToggleExport={() => { setExportOpen((value) => !value); }}
      />

      {exportOpen ? (
        <ExportPanel
          graphRevision={graph.revision}
          instanceId={graph.instanceId}
          focusedTopicId={effectiveTopicId}
          liveStatuses={snapshot.exportStatuses}
          onClose={() => { setExportOpen(false); }}
        />
      ) : null}
      <AppBanners
        stale={graph.stale}
        error={snapshot.error}
        onRefresh={() => { snapshot.refresh(); }}
      />
      {importance.error !== null ? (
        <div className="banner banner--error" role="alert">
          <span className="banner__text">{importance.error.message}</span>
          <button type="button" onClick={importance.clearError}>知道了</button>
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
          navCollapsed={navCollapsedSet}
          expandedTopicIds={expandedTopicIds}
          onToggleNavNode={toggleNavNodeId}
          onToggleTopicFolder={toggleTopicFolder}
          activeNodeId={graph.activeNode}
          selectedNodeId={reading?.selectedNodeId ?? null}
          topicFilter={reading?.topicFilter ?? null}
          onSelectNode={selectNode}
          onOpenTopic={openTopic}
          onTopicFilter={(id) => { update({ topicFilter: id }); }}
          onSelectTopicPath={openTopicByPath}
          onClose={() => { setReading((current) => (current === null ? current : setLeftPanelOpen(current, false))); }}
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
              <button type="button" onClick={openLeft}>打开主题目录</button>
            </div></div>
          ) : (
            <GraphCanvas
              key={selectedTopic.id}
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
              recentNodeIds={recent}
              importanceBusyIds={importance.busyIds}
              onToggleImportant={importance.set}
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
              onCopyLocate={copyLocate}
              locateCopied={locateCopied}
              importanceBusy={importantBusyForSelected}
              importanceError={importantErrorForSelected}
              {...(selectedNode !== null
                ? {
                    important: importanceOf(selectedNode),
                    onToggleImportant: (next: boolean) => {
                      importance.set(selectedNode, next, selectedDetailHash);
                    },
                  }
                : {})}
              resolvePathToNode={(path) => graph.nodes.find((candidate) => candidate.sourcePath === path)?.id ?? null}
              onOpenNode={(id) => { selectNodeAndOpen(id); }}
            />
          </>
        ) : null}
      </div>

      <AppFooter
        status={status}
        topicNodeCount={topicGraph?.nodes.length ?? 0}
        topicCount={graph.topics.length}
        visibleCount={layoutState.result !== null ? Object.keys(layoutState.result.positions).length : null}
        instanceId={graph.instanceId}
        revision={graph.revision}
      />
    </div>
  );
}
