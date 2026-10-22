import type { GraphResponse } from '../../shared/protocol.js';

/** Bumping this invalidates saved panel choices; bump when the meaning changes. */
export const VIEW_SCHEMA_VERSION = 2;

export interface SavedViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ReadingState {
  viewport: SavedViewport | null;
  selectedNodeId: string | null;
  collapsedNodeIds: string[];
  detailWidth: number;
  topicFilter: string | null;
  /** Left navigation panel. Closed by default; independent from the detail panel. */
  leftPanelOpen: boolean;
  /** Right detail panel. Closed by default; opened only by explicit action. */
  rightPanelOpen: boolean;
}

export function emptyReadingState(): ReadingState {
  return {
    viewport: null,
    selectedNodeId: null,
    collapsedNodeIds: [],
    detailWidth: 380,
    topicFilter: null,
    leftPanelOpen: false,
    rightPanelOpen: false,
  };
}

const KEY_PREFIX = 'aichat-graph:view:v' + String(VIEW_SCHEMA_VERSION) + ':';

function storageKey(workspaceId: string): string {
  return KEY_PREFIX + workspaceId;
}

function isViewport(value: unknown): value is SavedViewport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.x === 'number' && Number.isFinite(candidate.x) &&
    typeof candidate.y === 'number' && Number.isFinite(candidate.y) &&
    typeof candidate.zoom === 'number' && Number.isFinite(candidate.zoom) && candidate.zoom > 0
  );
}

/** Parse defensively: local state is a convenience, never content. Invalid entries fall back to defaults. */
export function parseReadingState(raw: string | null): ReadingState {
  if (raw === null) return emptyReadingState();
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return emptyReadingState();
  }
  if (typeof value !== 'object' || value === null) return emptyReadingState();
  const candidate = value as Record<string, unknown>;
  const state = emptyReadingState();
  if (typeof candidate.detailWidth === 'number' && Number.isFinite(candidate.detailWidth)) {
    state.detailWidth = Math.min(680, Math.max(300, candidate.detailWidth));
  }
  if (isViewport(candidate.viewport)) state.viewport = candidate.viewport;
  if (typeof candidate.selectedNodeId === 'string') state.selectedNodeId = candidate.selectedNodeId;
  if (typeof candidate.topicFilter === 'string') state.topicFilter = candidate.topicFilter;
  if (Array.isArray(candidate.collapsedNodeIds)) {
    state.collapsedNodeIds = candidate.collapsedNodeIds.filter((id): id is string => typeof id === 'string');
  }
  if (typeof candidate.leftPanelOpen === 'boolean') state.leftPanelOpen = candidate.leftPanelOpen;
  if (typeof candidate.rightPanelOpen === 'boolean') state.rightPanelOpen = candidate.rightPanelOpen;
  return state;
}

/** Drop references that no longer exist in the effective graph. Missing nodes never delete content. */
export function pruneReadingState(state: ReadingState, graph: GraphResponse): ReadingState {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const topicIds = new Set(graph.topics.map((topic) => topic.id));
  return {
    viewport: state.viewport,
    selectedNodeId: state.selectedNodeId !== null && nodeIds.has(state.selectedNodeId) ? state.selectedNodeId : null,
    collapsedNodeIds: state.collapsedNodeIds.filter((id) => nodeIds.has(id)),
    detailWidth: state.detailWidth,
    topicFilter: state.topicFilter !== null && topicIds.has(state.topicFilter) ? state.topicFilter : null,
    leftPanelOpen: state.leftPanelOpen,
    rightPanelOpen: state.rightPanelOpen,
  };
}

export function loadReadingState(workspaceId: string): ReadingState {
  try {
    return parseReadingState(window.localStorage.getItem(storageKey(workspaceId)));
  } catch {
    return emptyReadingState();
  }
}

export function saveReadingState(workspaceId: string, state: ReadingState): void {
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(state));
  } catch {
    // Storage may be unavailable (private mode/quota); reading still works.
  }
}
