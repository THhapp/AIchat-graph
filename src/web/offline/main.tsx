import { Component, StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { GraphNode, GraphResponse, OfflineTopicDocument } from '../../next/protocol.js';
import { buildGraphView } from '../graph/viewModel.js';
import { layoutInputForView } from '../graph/layoutBridge.js';
import { computeLayout } from '../layout/index.js';
import type { LayoutResult } from '../layout/types.js';
import { searchGraph } from '../lib/search.js';
import { cardChangeKinds, nodeChangeFromDetail, nodeChangeKind } from '../lib/changes.js';
import { useCopyFeedback } from '../lib/clipboard.js';
import { GraphCanvas } from '../components/GraphCanvas.js';
import { DetailPanel } from '../components/DetailPanel.js';
import { Sidebar } from '../components/Sidebar.js';
import { LicenseNotices } from '../components/LicenseNotices.js';
import { bodyById, readEmbeddedDocument, toGraphResponse, OfflineDocumentError } from './document.js';
import { deriveOfflineDetails } from './details.js';
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/graph.css';
import '../styles/detail.css';
import 'katex/dist/katex.min.css';

/* ------------------------------------------------------------------ *
 * Offline reader
 *
 * Everything comes from the inert JSON block in this same file. Layout runs
 * synchronously in-process (a file:// page cannot load a sibling worker), and
 * there is no fetch, no EventSource and no network dependency.
 * ------------------------------------------------------------------ */

const FIT_SIGNAL_NONE = 0;

interface OfflineState {
  graph: GraphResponse;
  bodies: Map<string, string>;
  doc: OfflineTopicDocument;
}

function useOfflineDocument(): { state: OfflineState | null; error: OfflineDocumentError | Error | null } {
  const [state, setState] = useState<OfflineState | null>(null);
  const [error, setError] = useState<OfflineDocumentError | Error | null>(null);

  useEffect(() => {
    try {
      const doc = readEmbeddedDocument(window.document);
      setState({ doc, graph: toGraphResponse(doc), bodies: bodyById(doc) });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }, []);

  return { state, error };
}

class RenderBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // A crash must be reported, not leave a silently blank page.
    console.error('offline render failed', error, info.componentStack);
  }
  render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <div className="app app--center">
          <div className="state-block state-block--center">
            <h3>离线阅读渲染失败</h3>
            <p role="alert">{this.state.message}</p>
            <p>这是成品本身的问题；请重新导出，或把这段文字反馈给维护者。</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function OfflineReader(): React.JSX.Element {
  const { state, error } = useOfflineDocument();
  const [query, setQuery] = useState('');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [tab, setTab] = useState<'node' | 'topic'>('node');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** Directory folds are separate from the graph, exactly like the live reader. */
  const [navCollapsed, setNavCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expandedTopics, setExpandedTopics] = useState<ReadonlySet<string> | null>(null);
  const [fitSignal, setFitSignal] = useState(FIT_SIGNAL_NONE);
  const [savedViewport] = useState<null>(null);
  const [changeTargetNodeId, setChangeTargetNodeId] = useState<string | null>(null);
  const { copied, copy: copyText } = useCopyFeedback();

  const graph = state?.graph ?? null;
  const bodies = state?.bodies ?? new Map<string, string>();

  const view = useMemo(
    () => (graph === null ? null : buildGraphView(graph, collapsed, null)),
    [graph, collapsed],
  );

  // Deterministic synchronous layout: same module and the same input builder as
  // the live reader, so offline never spells the card geometry out again.
  const layout = useMemo<LayoutResult | null>(
    () => (view === null ? null : computeLayout(layoutInputForView(view))),
    [view],
  );

  const anchorNodeId = useMemo(() => {
    if (view === null || selectedNodeId === null) return null;
    if (view.visibleIds.has(selectedNodeId)) return selectedNodeId;
    return null;
  }, [view, selectedNodeId]);

  const selectedNode: GraphNode | null = graph !== null && selectedNodeId !== null
    ? graph.nodes.find((node) => node.id === selectedNodeId) ?? null
    : null;
  const selectedTopic = graph?.topics[0] ?? null;

  const details = useMemo(
    () => deriveOfflineDetails({
      graph,
      doc: state?.doc ?? null,
      bodies,
      tab,
      node: selectedNode,
      topic: selectedTopic,
    }),
    [graph, state, tab, selectedNode, selectedTopic, bodies],
  );
  // The frozen batch is embedded in the export; labels and the topic change list
  // come from it, exactly like the live reader's graph.lastChanges.
  const changeKinds = useMemo(
    () => cardChangeKinds(graph, selectedTopic?.id ?? null),
    [graph, selectedTopic],
  );
  const changeKind = nodeChangeKind(details.batch, selectedNodeId);
  // The same target id drives the card diff and the inline topic change row.
  const targetChange = useMemo(
    () => nodeChangeFromDetail(state?.doc.changes ?? null, changeTargetNodeId),
    [state, changeTargetNodeId],
  );

  const openDetail = useCallback((id: string) => {
    setSelectedNodeId(id);
    setTab('node');
    setRightOpen(true);
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (error !== null) {
    return (
      <div className="app app--center">
        <div className="state-block state-block--center">
          <h3>无法读取导出内容</h3>
          <p role="alert">{error.message}</p>
          <p>这个 HTML 可能被截断或不是由本工具生成的完整成品。请重新导出。</p>
        </div>
      </div>
    );
  }

  if (graph === null || view === null) {
    return (
      <div className="app app--center">
        <div className="state-block state-block--center"><h3>正在读取内嵌内容…</h3></div>
      </div>
    );
  }

  const results = searchGraph(graph, query);
  const resources = state?.doc.resources ?? {};
  const resourceProblems = graph.diagnostics;
  const exportedAt = state?.doc.generatedAt ?? '';

  return (
    <div className="app offline">
      <header className="app-header">
        <div className="app-header__brand">
          <span className="app-header__title">{selectedTopic?.title ?? '主题'}</span>
          <span className="app-header__workspace">{state?.doc.workspaceName ?? graph.workspaceId} · 离线成品</span>
        </div>
        <span className="app-header__spacer" />
        <div className="app-header__meta">
          <span>r{graph.revision}</span>
          <button type="button" aria-pressed={leftOpen} aria-controls="nav-panel" onClick={() => { setLeftOpen((v) => !v); }}>
            {leftOpen ? '收起导航' : '导航'}
          </button>
          <button type="button" onClick={() => { setCollapsed(new Set()); setFitSignal((v) => v + 1); }}>查看全部</button>
          <button type="button" aria-pressed={rightOpen} aria-controls="detail-panel" onClick={() => { setRightOpen((v) => !v); }}>
            {rightOpen ? '收起详情' : '打开详情'}
          </button>
        </div>
      </header>

      {resourceProblems.length > 0 ? (
        <div className="banner banner--error" role="status">
          <span className="banner__text">
            资源问题 {String(resourceProblems.length)} 项：{resourceProblems.map((d) => d.message).join('；')}
          </span>
        </div>
      ) : null}

      <div
        className="app-main"
        style={{
          gridTemplateColumns: (leftOpen ? 'var(--sidebar-width) ' : '') + 'minmax(0, 1fr)' + (rightOpen ? ' 5px var(--detail-width)' : ''),
          // The offline shell has no status-bar row; the canvas must get a real height.
          gridTemplateRows: 'minmax(0, 1fr)',
        }}
      >
        {leftOpen ? (
          <Sidebar
            graph={graph}
            query={query}
            onQueryChange={setQuery}
            results={results}
            activeNodeId={null}
            selectedNodeId={selectedNodeId}
            topicFilter={null}
            onSelectNode={setSelectedNodeId}
            onOpenTopic={() => { setTab('topic'); setRightOpen(true); }}
            navCollapsed={navCollapsed}
            expandedTopicIds={expandedTopics ?? new Set(graph.topics.map((topic) => topic.id))}
            onToggleNavNode={(id) => {
              setNavCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onToggleTopicFolder={(id) => {
              setExpandedTopics((current) => {
                const next = new Set(current ?? graph.topics.map((topic) => topic.id));
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onTopicFilter={() => { /* offline: single topic, nothing to filter */ }}
            onClose={() => { setLeftOpen(false); }}
          />
        ) : null}

        <main className="canvas-host" id="main-content">
          <GraphCanvas
            view={view}
            layout={layout}
            layoutStatus={layout === null ? 'error' : 'ready'}
            layoutError={layout === null ? '布局未生成' : null}
            activeNodeId={null}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onOpenNodeDetail={openDetail}
            onToggleCollapse={toggleCollapse}
            onViewportChange={() => { /* offline reading state is not persisted */ }}
            fitSignal={fitSignal}
            savedViewport={savedViewport}
            anchorNodeId={anchorNodeId}
            changeKinds={changeKinds}
          />
        </main>

        {rightOpen ? (
          <>
            <div className="detail-resizer" aria-hidden="true" />
            <DetailPanel
              graph={graph}
              tab={tab}
              onTabChange={setTab}
              topic={selectedTopic}
              node={selectedNode}
              nodeDetail={details.nodeDetail}
              topicDetail={details.topicDetail}
              loading={false}
              error={null}
              detailVersion={details.detailVersion}
              activeNodeId={null}
              selectedNodeId={selectedNodeId}
              onSelectNode={(id) => { setSelectedNodeId(id); }}
              onRetry={() => undefined}
              onClose={() => { setRightOpen(false); }}
              onOpenNode={(id) => { setSelectedNodeId(id); setTab('node'); }}
              boundaryNodes={state?.doc.boundaryNodes ?? []}
              batch={details.batch}
              changeKind={changeKind}
              changeTargetNodeId={changeTargetNodeId}
              nodeChange={targetChange}
              nodeChangeLoading={false}
              nodeChangeMissing={changeTargetNodeId !== null && targetChange === null && details.batch !== null}
              nodeChangeError={null}
              onToggleChange={(nodeId) => {
                setChangeTargetNodeId((current) => (current === nodeId ? null : nodeId));
              }}
              important={selectedNode?.important === true}
              onCopyContinuation={() => {
                copyText(
                  '离线导出：' + (selectedTopic?.title ?? '') + (selectedNode ? ' · ' + selectedNode.number + ' ' + selectedNode.title : '') +
                    '\nworkspaceId：' + graph.workspaceId +
                    (selectedTopic !== null ? '\ntopicId：' + selectedTopic.id : '') +
                    (selectedNode !== null ? '\nnodeId：' + selectedNode.id + '  revision=' + String(selectedNode.revision) : '') +
                    '\n快照：' + graph.instanceId + ' / r' + String(graph.revision) +
                    '\n说明：这是离线成品，内容冻结于 ' + exportedAt + '；续谈请回到源工作区，用实际 CLI／Skill 入口读取上面的 ID。',
                );
              }}
              copied={copied}
            />
          </>
        ) : null}
      </div>

      <footer className="app-status">
        <span className="dot dot--ok" aria-hidden="true" />
        <span>离线只读 · 内容冻结于 {exportedAt}</span>
        <span>{String(graph.nodes.length)} 节点</span>
        <span className="app-status__spacer" />
        <span>资源 {String(Object.keys(resources).length)}</span>
        <span>离线成品无法写回源文件</span>
        <LicenseNotices />
      </footer>
    </div>
  );
}

// The exporter's HTML wrapper provides #root; reading a different id would render nothing.
const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <RenderBoundary>
        <OfflineReader />
      </RenderBoundary>
    </StrictMode>,
  );
}
