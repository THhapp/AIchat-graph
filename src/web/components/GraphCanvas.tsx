import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphNode, GraphResponse } from '../../shared/protocol.js';
import type { LayoutResult } from '../layout/types.js';
import type { GraphView } from '../graph/viewModel.js';
import type { SavedViewport } from '../data/readingState.js';
import { TopicCard, type TopicCardData } from './TopicCard.js';
import { RouteEdge } from './RouteEdge.js';

export interface CanvasProps {
  graph: GraphResponse;
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
  /** Screen position of the anchor captured *before* the new geometry was applied. */
  anchorScreen: { x: number; y: number } | null;
}

const nodeTypes = { topic: TopicCard };
const edgeTypes = { route: RouteEdge };

function CanvasInner(props: CanvasProps): React.JSX.Element {
  const { graph, view, layout, layoutStatus, layoutError, activeNodeId, selectedNodeId, onSelectNode, onOpenNodeDetail, onToggleCollapse, onViewportChange, fitSignal, savedViewport, anchorNodeId, anchorScreen } = props;
  const { fitView, getNode, setViewport, getViewport } = useReactFlow();
  const containerRef = useRef<HTMLDivElement | null>(null);

  /** React Flow viewport x/y are relative to its container, not the page. */
  const containerOrigin = (): { x: number; y: number; width: number; height: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: rect?.x ?? 0, y: rect?.y ?? 0, width: rect?.width ?? window.innerWidth, height: rect?.height ?? window.innerHeight };
  };
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TopicCardData>>([]);
  const didInitialFit = useRef(false);
  const lastFitSignal = useRef(0);
  const lastStructureKey = useRef('');
  const lastCentered = useRef<string | null>(null);
  /**
   * Screen positions of the layout currently drawn, keyed by node id. Compensating by
   * the layout delta (instead of a DOM measurement made after re-render) works whether
   * the new geometry arrives asynchronously (live worker) or in the same commit
   * (offline reader, computed synchronously).
   */
  const previousPositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  const previousStructureKey = useRef<string | null>(null);
  /** Container origin from before the last panel change, used to cancel the shift. */
  const previousOrigin = useRef<{ x: number; y: number } | null>(null);

  const flowNodes = useMemo<Node<TopicCardData>[]>(() => {
    if (layout === null) return [];
    const children = view.childCounts;
    const collapsed = new Set(view.collapsedIds);
    const result: Node<TopicCardData>[] = [];
    for (const node of view.nodes) {
      const position = layout.positions[node.id];
      // A node without coordinates must never reach React Flow: it would be
      // initialised with an undefined position and crash the reader.
      if (position === undefined || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
      result.push({
        id: node.id,
        type: 'topic',
        position: { x: position.x, y: position.y },
        width: layout.cardWidth,
        height: layout.cardHeight,
        draggable: false,
        connectable: false,
        selectable: true,
        selected: node.id === selectedNodeId,
        data: {
          node,
          active: node.id === activeNodeId,
          // The UI owns this number: it counts descendants hidden by this collapse
          // within the current topic filter. Layout only receives already-filtered
          // input, so its hiddenCounts cannot know about them.
          hiddenCount: view.hiddenDescendantCounts.get(node.id) ?? 0,
          collapsed: collapsed.has(node.id),
          childCount: children.get(node.id) ?? 0,
          onToggleCollapse,
          onOpenDetail: onOpenNodeDetail,
        },
      });
    }
    return result;
  }, [layout, view, activeNodeId, selectedNodeId, onToggleCollapse, onOpenNodeDetail]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (layout === null) return [];
    const routes = new Map(layout.edgeRoutes.map((route) => [route.id, route]));
    const edges: Edge[] = [];
    for (const node of view.nodes) {
      if (node.from === null || !view.visibleIds.has(node.from)) continue;
      if (layout.positions[node.id] === undefined || layout.positions[node.from] === undefined) continue;
      const id = node.from + '->' + node.id;
      const route = routes.get(id) ?? null;
      edges.push({
        id,
        source: node.from,
        target: node.id,
        type: 'route',
        className: 'rf-edge--' + node.flow,
        label: node.label,
        data: { flow: node.flow, route },
        selectable: false,
        focusable: false,
        deletable: false,
      });
    }
    return edges;
  }, [layout, view]);

  useEffect(() => {
    setNodes(flowNodes);
  }, [flowNodes, setNodes]);

  useEffect(() => {
    if (layout === null) return;
    // Only compensate once the geometry actually matches the current structure;
    // an older result still on screen must not teach us the wrong anchor position.
    if (layout.structureVersion !== null && String(layout.structureVersion) !== view.structureKey) return;
    const first = !didInitialFit.current;
    if (first) didInitialFit.current = true;
    else if (lastStructureKey.current === view.structureKey) return;
    lastStructureKey.current = view.structureKey;

    requestAnimationFrame(() => {
      if (first) {
        if (savedViewport !== null) setViewport(savedViewport, { duration: 0 });
        else fitView({ padding: 0.16, duration: 0, maxZoom: 1 }).catch(() => undefined);
        return;
      }
      const targetId = anchorNodeId;
      if (targetId === null) return;
      const node = getNode(targetId);
      if (node === undefined) return;
      const previous = previousPositions.current.get(targetId);
      // Keep the zoom level and pan by exactly how much the anchor moved in layout
      // coordinates, so the card stays at its previous screen position.
      if (previous === undefined) return;
      const dx = node.position.x - previous.x;
      const dy = node.position.y - previous.y;
      if (dx === 0 && dy === 0) return;
      const current = getViewport();
      setViewport(
        {
          x: current.x - dx * current.zoom,
          y: current.y - dy * current.zoom,
          zoom: current.zoom,
        },
        { duration: 0 },
      );
      previousStructureKey.current = view.structureKey;
      const latest = new Map<string, { x: number; y: number }>();
      for (const item of view.nodes) {
        const p = layout.positions[item.id];
        if (p !== undefined) latest.set(item.id, { x: p.x, y: p.y });
      }
      previousPositions.current = latest;
    });
  }, [layout, view.structureKey, anchorNodeId, savedViewport, fitView, getNode, getViewport, setViewport]);

  /**
   * Keeps the last drawn positions. When the structure key changes, the values still in
   * the ref are the previous geometry, which is exactly the baseline the compensation
   * effect needs. Runs before the compensation effect reads it.
   */
  useLayoutEffect(() => {
    if (layout === null) return;
    if (previousStructureKey.current === null) {
      // First time: adopt the current geometry as the baseline and remember its key.
      previousStructureKey.current = view.structureKey;
    } else if (previousStructureKey.current !== view.structureKey) {
      // A new structure is arriving on screen: keep the baseline that the
      // compensation effect still needs, and let that effect refresh it.
      return;
    }
    const next = new Map<string, { x: number; y: number }>();
    for (const node of view.nodes) {
      const position = layout.positions[node.id];
      if (position !== undefined) next.set(node.id, { x: position.x, y: position.y });
    }
    previousPositions.current = next;
  }, [layout, view.structureKey, view.nodes]);

  /**
   * Opening a side panel moves this container and changes its width. React Flow's
   * viewport is relative to the container, so without compensation every card jumps
   * sideways by the panel width. The delta is computed against the origin recorded
   * before the DOM changed, never against a post-change measurement of the same frame.
   */
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const read = (): { x: number; y: number } => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    };
    previousOrigin.current = read();
    const observer = new ResizeObserver(() => {
      const next = read();
      const previous = previousOrigin.current;
      previousOrigin.current = next;
      if (previous === null) return;
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      if (dx === 0 && dy === 0) return;
      const current = getViewport();
      setViewport({ x: current.x - dx, y: current.y - dy, zoom: current.zoom }, { duration: 0 });
    });
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [getViewport, setViewport]);

  // Selection from outside the canvas centres the card without changing zoom.
  useEffect(() => {
    if (selectedNodeId === null || layout === null) return;
    if (lastCentered.current === null) {
      lastCentered.current = selectedNodeId;
      return;
    }
    if (lastCentered.current === selectedNodeId) return;
    lastCentered.current = selectedNodeId;
    const node = getNode(selectedNodeId);
    if (node === undefined) return;
    requestAnimationFrame(() => {
      const current = getViewport();
      const origin = containerOrigin();
      const width = node.width ?? layout.cardWidth;
      const height = node.height ?? layout.cardHeight;
      setViewport(
        {
          x: origin.width / 2 - (node.position.x + width / 2) * current.zoom,
          y: origin.height / 2 - (node.position.y + height / 2) * current.zoom,
          zoom: current.zoom,
        },
        { duration: 160 },
      );
    });
  }, [selectedNodeId, layout, getNode, getViewport, setViewport]);

  useEffect(() => {
    if (fitSignal === lastFitSignal.current) return;
    lastFitSignal.current = fitSignal;
    requestAnimationFrame(() => {
      fitView({ padding: 0.16, duration: 200, maxZoom: 1 }).catch(() => undefined);
    });
  }, [fitSignal, fitView]);

  const handleNodeClick = useCallback<NodeMouseHandler<Node<TopicCardData>>>(
    (_event, node) => { onSelectNode(node.id); },
    [onSelectNode],
  );

  const handleNodeDoubleClick = useCallback<NodeMouseHandler<Node<TopicCardData>>>(
    (_event, node) => { onOpenNodeDetail(node.id); },
    [onOpenNodeDetail],
  );

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => { onViewportChange({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }); },
    [onViewportChange],
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

/** Anchor = selected node, else nearest visible ancestor, else root. */
export function findAnchorNodeId(view: GraphView, selectedId: string | null, graph: GraphResponse): string | null {
  if (selectedId === null) return graph.nodes.find((node) => node.flow === 'root')?.id ?? null;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  let current: string | null = selectedId;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    if (view.visibleIds.has(current)) return current;
    seen.add(current);
    current = byId.get(current)?.from ?? null;
  }
  return graph.nodes.find((node) => node.flow === 'root')?.id ?? null;
}

export type { GraphNode };