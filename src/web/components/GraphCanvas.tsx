import { useCallback, useEffect, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { LayoutResult } from '../layout/types.js';
import type { GraphNode } from '../../shared/protocol.js';
import type { GraphView } from '../graph/viewModel.js';
import { buildFlowEdges } from '../graph/flowEdges.js';
import { useCanvasViewport } from '../graph/useCanvasViewport.js';
import type { SavedViewport } from '../data/readingState.js';
import { TopicCard, type TopicCardData } from './TopicCard.js';
import { RouteEdge } from './RouteEdge.js';
import { TrunkEdge } from './TrunkEdge.js';

export interface CanvasProps {
  view: GraphView;
  layout: LayoutResult | null;
  layoutStatus: 'idle' | 'loading' | 'ready' | 'error';
  layoutError: string | null;
  activeNodeId: string | null;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  /** Explicit open of the right detail panel (double click / Enter / detail affordance). */
  onOpenNodeDetail: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onViewportChange: (viewport: SavedViewport) => void;
  /** Incremented by the user's "view all" action; never by data refreshes. */
  fitSignal: number;
  savedViewport: SavedViewport | null;
  /** Node to keep at its previous screen position after a structural change. */
  anchorNodeId: string | null;
  /**
   * Node ids of the current topic's `GraphResponse.lastChanges[topicId].nodeIds`.
   * Read-only decoration: it never affects geometry, and view-only actions cannot
   * change it.
   */
  recentNodeIds?: ReadonlySet<string>;
  /** Stable node ids with an importance write in flight. */
  importanceBusyIds?: ReadonlySet<string>;
  /** Writes one node's important flag from its card; omitted in the read-only offline reader. */
  onToggleImportant?: (node: GraphNode, important: boolean) => void;
}

const nodeTypes = { topic: TopicCard };
const edgeTypes = { route: RouteEdge, trunk: TrunkEdge };

function CanvasInner(props: CanvasProps): React.JSX.Element {
  const { view, layout, layoutStatus, layoutError, activeNodeId, selectedNodeId, onSelectNode, onOpenNodeDetail, onToggleCollapse, onViewportChange, fitSignal, savedViewport, anchorNodeId, recentNodeIds, importanceBusyIds, onToggleImportant } = props;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TopicCardData>>([]);

  const flowNodes = useMemo<Node<TopicCardData>[]>(() => {
    if (layout === null) return [];
    const children = view.childCounts;
    const collapsed = new Set(view.collapsedIds);
    // Each card keeps its own height (title wrap); width stays shared by the layout.
    const heights = layout.heights;
    const result: Node<TopicCardData>[] = [];
    for (const node of view.nodes) {
      const position = layout.positions[node.id];
      // A node without coordinates must never reach React Flow: it would be
      // initialised with an undefined position and crash the reader.
      if (position === undefined || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
      const height = heights[node.id] ?? layout.cardHeight;
      result.push({
        id: node.id,
        type: 'topic',
        position: { x: position.x, y: position.y },
        width: layout.cardWidth,
        height,
        draggable: false,
        connectable: false,
        selectable: true,
        selected: node.id === selectedNodeId,
        data: {
          node,
          height,
          active: node.id === activeNodeId,
          // The UI owns this number: it counts descendants hidden by this collapse
          // within the current topic filter. Layout only receives already-filtered
          // input, so its hiddenCounts cannot know about them.
          hiddenCount: view.hiddenDescendantCounts.get(node.id) ?? 0,
          collapsed: collapsed.has(node.id),
          childCount: children.get(node.id) ?? 0,
          recent: recentNodeIds?.has(node.id) ?? false,
          importanceBusy: importanceBusyIds?.has(node.id) ?? false,
          ...(onToggleImportant !== undefined ? { onToggleImportant } : {}),
          onToggleCollapse,
        },
      });
    }
    return result;
  }, [layout, view, activeNodeId, selectedNodeId, onToggleCollapse, recentNodeIds, importanceBusyIds, onToggleImportant]);

  // `layout` is the dependency that carries `edgeRoutes` and `branchTrunks`
  // together, so a new trunk set always rebuilds the edge list.
  const flowEdges = useMemo<Edge[]>(() => {
    if (layout === null) return [];
    return buildFlowEdges(layout, view);
  }, [layout, view]);

  useEffect(() => {
    setNodes(flowNodes);
  }, [flowNodes, setNodes]);

  const { containerRef, handleMoveEnd } = useCanvasViewport({
    view,
    layout,
    selectedNodeId,
    anchorNodeId,
    fitSignal,
    savedViewport,
    onViewportChange,
  });

  const handleNodeClick = useCallback<NodeMouseHandler<Node<TopicCardData>>>(
    (_event, node) => { onSelectNode(node.id); },
    [onSelectNode],
  );

  const handleNodeDoubleClick = useCallback<NodeMouseHandler<Node<TopicCardData>>>(
    (_event, node) => { onOpenNodeDetail(node.id); },
    [onOpenNodeDetail],
  );

  return (
    <div className="canvas" aria-label="思想图" ref={containerRef}>
      {layoutStatus === 'loading' ? (
        <div className="canvas__overlay" role="status">
          <span className="spinner" /> {layout === null ? '正在计算布局…' : '结构已变化，正在更新布局…'}
        </div>
      ) : null}
      {layoutStatus === 'error' ? (
        <div className="canvas__overlay canvas__overlay--error" role="alert">
          <div className="state-block">
            <h3>布局暂不可用</h3>
            <p>{layoutError ?? '布局模块未返回结果，未使用伪造坐标绘制。'}</p>
            <p>左侧列表、主题搜索与详情仍可阅读。</p>
          </div>
        </div>
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onMoveEnd={handleMoveEnd}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        /*
         * Double-click belongs to the card, not to the canvas. React Flow's pane
         * listens for dblclick through d3-zoom and calls stopImmediatePropagation
         * there, so an ancestor swallows the event before React's delegated
         * handler runs: with zoom-on-double-click on, `onNodeDoubleClick` never
         * fires. Zooming stays available through the controls and the wheel.
         */
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={1.6}
        fitView={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border-strong)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          position="bottom-right"
          pannable={false}
          zoomable={false}
          nodeColor={(node) => {
            const data = node.data as TopicCardData | undefined;
            return data?.node.id === activeNodeId ? 'var(--accent)' : 'var(--border-strong)';
          }}
        />
      </ReactFlow>
    </div>
  );
}

export function GraphCanvas(props: CanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
