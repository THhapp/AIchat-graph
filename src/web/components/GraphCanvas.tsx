import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useOnViewportChange,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphNode, GraphResponse } from '../../shared/protocol.js';
import type { LayoutBranchTrunk, LayoutResult } from '../layout/types.js';
import { connectionText, type GraphView } from '../graph/viewModel.js';
import type { SavedViewport } from '../data/readingState.js';
import { TopicCard, type TopicCardData } from './TopicCard.js';
import { RouteEdge } from './RouteEdge.js';
import { TrunkEdge } from './TrunkEdge.js';

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
  /**
   * Node ids of the current topic's `GraphResponse.lastChanges[topicId].nodeIds`.
   * Read-only decoration: it never affects geometry, and view-only actions cannot
   * change it.
   */
  recentNodeIds?: ReadonlySet<string>;
}

const nodeTypes = { topic: TopicCard };
const edgeTypes = { route: RouteEdge, trunk: TrunkEdge };

/**
 * Display edges for one layout result.
 *
 * One relationship is still exactly one edge (and one label), but the shared
 * geometry of sibling branches is now a separate, relationship-free edge: the
 * trunk is drawn once and every branch only paints its own exclusive stub from
 * the join down to its target. Counting stays checkable — relationship edges
 * equal the visible parent links, display paths equal that plus the trunks.
 */
export function buildFlowEdges(layout: LayoutResult, view: GraphView): Edge[] {
  const routes = new Map(layout.edgeRoutes.map((route) => [route.id, route]));
  const edges: Edge[] = [];

  // Trunks first, so the branch stubs are painted over the shared run.
  for (const trunk of layout.branchTrunks ?? []) {
    if (trunk.points.length < 2) continue;
    // `to` is only the node that mounts the display edge (the farthest member);
    // the geometry comes from `points`, never from the node positions.
    if (!view.visibleIds.has(trunk.from) || !view.visibleIds.has(trunk.to)) continue;
    if (layout.positions[trunk.from] === undefined || layout.positions[trunk.to] === undefined) continue;
    edges.push({
      id: 'trunk|' + trunk.id,
      source: trunk.from,
      target: trunk.to,
      type: 'trunk',
      className: 'rf-edge--trunk',
      data: { trunk },
      selectable: false,
      focusable: false,
      deletable: false,
    });
  }

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
      // Format 2 keeps the relationship sentence in description; label is the
      // legacy format-1 field. The connector is now the only place it is drawn.
      label: connectionText(node) || undefined,
      data: { flow: node.flow, route },
      selectable: false,
      focusable: false,
      deletable: false,
    });
  }
  return edges;
}

function CanvasInner(props: CanvasProps): React.JSX.Element {
  const { graph, view, layout, layoutStatus, layoutError, activeNodeId, selectedNodeId, onSelectNode, onOpenNodeDetail, onToggleCollapse, onViewportChange, fitSignal, savedViewport, anchorNodeId, anchorScreen, recentNodeIds } = props;
  const { fitView, getNode, setViewport, getViewport } = useReactFlow();
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Connector strokes are screen-fixed, not graph-fixed (see graph.css): the
   * canvas zoom is a CSS transform on `.react-flow__viewport`, an HTML ancestor of
   * the edge <svg>, so an SVG `vector-effect` cannot cancel it — measured, a 1.5px
   * line still painted 0.96px at 0.64. CSS therefore gets the scale and multiplies
   * the stroke back up.
   *
   * At 1x and above the scale stays 1: zooming in keeps 1.25 flow px, so the line
   * thickens together with the cards.
   * Below 1x it is `min(1 / zoom, 5)`. The 5 is exactly minZoom, so the stroke
   * still paints 1.25 / 1.5 screen px at 0.2 instead of fading into a sub-pixel
   * hairline (a 2x cap left 0.6px there, i.e. the fix kept a blind spot).
   * At 0.2 a connector is then ~3.5x the card border (measured: the 1px border
   * paints 0.36px, not 0.2px — Chrome keeps a minimum coverage). That ratio is
   * deliberate rather than a leftover asymmetry: at that zoom the card text is
   * unreadable and the connectors are the only layer still expressing structure.
   *
   * Published as a custom property, not React state: zooming then costs one style
   * write per frame instead of re-rendering every edge. `useOnViewportChange` fires
   * from the same transform handler as `onMove` (and also for programmatic
   * setViewport / fitView), which is why init and "view all" need no extra write.
   * The callback identity must be stable — the hook re-registers it per identity.
   */
  const publishEdgeScale = useCallback((viewport: Viewport) => {
    const edgeScale = viewport.zoom < 1 ? Math.min(1 / viewport.zoom, 5) : 1;
    containerRef.current?.style.setProperty('--edge-scale', String(edgeScale));
  }, []);
  useOnViewportChange({ onChange: publishEdgeScale });

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
          onToggleCollapse,
        },
      });
    }
    return result;
  }, [layout, view, activeNodeId, selectedNodeId, onToggleCollapse, recentNodeIds]);

  // `layout` is the dependency that carries `edgeRoutes` and `branchTrunks`
  // together, so a new trunk set always rebuilds the edge list.
  const flowEdges = useMemo<Edge[]>(() => {
    if (layout === null) return [];
    return buildFlowEdges(layout, view);
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
    // Expanding a collapsed topic changes its layout asynchronously. Fit only
    // once that expanded geometry exists, not the old (or empty) canvas.
    if (layout === null || (layout.structureVersion !== null && String(layout.structureVersion) !== view.structureKey)) return;
    lastFitSignal.current = fitSignal;
    requestAnimationFrame(() => {
      fitView({ padding: 0.16, duration: 200, maxZoom: 1 }).catch(() => undefined);
    });
  }, [fitSignal, fitView, layout, view.structureKey]);

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
