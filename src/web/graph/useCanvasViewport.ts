import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import {
  useOnViewportChange,
  useReactFlow,
  type Viewport,
} from '@xyflow/react';
import type { LayoutResult } from '../layout/types.js';
import type { SavedViewport } from '../data/readingState.js';
import type { GraphView } from './viewModel.js';

export interface CanvasViewportOptions {
  view: GraphView;
  layout: LayoutResult | null;
  selectedNodeId: string | null;
  /** Node to keep at its previous screen position after a structural change. */
  anchorNodeId: string | null;
  /** Incremented by the user's "view all" action; never by data refreshes. */
  fitSignal: number;
  savedViewport: SavedViewport | null;
  onViewportChange: (viewport: SavedViewport) => void;
}

export interface CanvasViewport {
  containerRef: RefObject<HTMLDivElement | null>;
  handleMoveEnd: (event: unknown, viewport: Viewport) => void;
}

/**
 * Owns the React Flow viewport side of the canvas: the container the viewport is
 * relative to, the screen-fixed edge scale, the initial fit / saved viewport,
 * structural anchor compensation, panel ResizeObserver compensation, selection
 * centring and the explicit fit signal. GraphCanvas keeps projection, callbacks,
 * overlays and the React Flow composition.
 *
 * Must be called inside a ReactFlowProvider so `useReactFlow` resolves the same
 * instance the canvas renders.
 */
export function useCanvasViewport(options: CanvasViewportOptions): CanvasViewport {
  const { view, layout, selectedNodeId, anchorNodeId, fitSignal, savedViewport, onViewportChange } = options;
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

  const didInitialFit = useRef(false);
  const lastFitSignal = useRef(0);
  const lastStructureKey = useRef('');
  /**
   * Id whose selection has already been handled. Initialised with the restored
   * selection (if any): a reload keeps its saved viewport and must not jump to
   * centre. Starting from null is deliberate — the first directory/search pick
   * in a topic without a restored selection is a user action and may centre.
   */
  const lastCentered = useRef<string | null>(selectedNodeId);
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
  // A restored selection was already consumed by the initial ref value above;
  // only a later, user-driven change reaches this effect.
  useEffect(() => {
    if (selectedNodeId === null || layout === null) return;
    if (lastCentered.current === selectedNodeId) return;
    // Wait for the geometry of the current structure; an older result still on
    // screen must not be used to compute a centre.
    if (layout.structureVersion !== null && String(layout.structureVersion) !== view.structureKey) return;
    // A node hidden by graph folding has no position to centre on. Do not expand
    // ancestors implicitly; leave the selection intact and retry if it becomes
    // visible through a later layout change.
    const node = getNode(selectedNodeId);
    if (node === undefined) return;
    lastCentered.current = selectedNodeId;
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
  }, [selectedNodeId, layout, view.structureKey, getNode, getViewport, setViewport]);

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

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => { onViewportChange({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }); },
    [onViewportChange],
  );

  return { containerRef, handleMoveEnd };
}
