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
  /** Saved reading position for each topic, never an Agent write target. */
  topicStates: Record<string, TopicReadingState>;
}

export interface TopicReadingState {
  viewport: SavedViewport | null;
  selectedNodeId: string | null;
  collapsedNodeIds: string[];
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
    topicStates: {},
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
  if (typeof candidate.topicStates === 'object' && candidate.topicStates !== null && !Array.isArray(candidate.topicStates)) {
    for (const [id, value] of Object.entries(candidate.topicStates)) {
      if (typeof value !== 'object' || value === null) continue;
      const saved = value as Record<string, unknown>;
      state.topicStates[id] = {
        viewport: isViewport(saved.viewport) ? saved.viewport : null,
        selectedNodeId: typeof saved.selectedNodeId === 'string' ? saved.selectedNodeId : null,
        collapsedNodeIds: Array.isArray(saved.collapsedNodeIds) ? saved.collapsedNodeIds.filter((id): id is string => typeof id === 'string') : [],
      };
    }
  }
  return state;
}

/** Switching opens only the diagram; long details require an explicit action. */
export function switchReadingTopic(state: ReadingState, topicId: string): ReadingState {
  if (state.topicFilter === topicId) return state;
  const topicStates = { ...state.topicStates };
  if (state.topicFilter !== null) {
    topicStates[state.topicFilter] = {
      viewport: state.viewport,
      selectedNodeId: state.selectedNodeId,
      collapsedNodeIds: state.collapsedNodeIds,
    };
  }
  const saved = topicStates[topicId];
  return {
    ...state, topicStates, topicFilter: topicId,
    viewport: saved?.viewport ?? null,
    selectedNodeId: saved?.selectedNodeId ?? null,
    collapsedNodeIds: saved?.collapsedNodeIds ?? [],
    rightPanelOpen: false,
  };
}

/** Drop references that no longer exist in the effective graph. Missing nodes never delete content. */
export function pruneReadingState(state: ReadingState, graph: GraphResponse): ReadingState {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const topicIds = new Set(graph.topics.map((topic) => topic.id));
  const topicStates: Record<string, TopicReadingState> = {};
  for (const topic of graph.topics) {
    const saved = state.topicStates[topic.id];
    if (saved === undefined) continue;
    const ids = new Set(topic.nodeIds);
    topicStates[topic.id] = {
      viewport: saved.viewport,
      selectedNodeId: saved.selectedNodeId !== null && ids.has(saved.selectedNodeId) ? saved.selectedNodeId : null,
      collapsedNodeIds: saved.collapsedNodeIds.filter((id) => ids.has(id)),
    };
  }
  const validTopic = state.topicFilter !== null && topicIds.has(state.topicFilter) ? state.topicFilter : null;
  const allowed = new Set(graph.nodes.filter((node) => validTopic !== null && node.topicId === validTopic).map((node) => node.id));
  return {
    viewport: validTopic === state.topicFilter ? state.viewport : null,
    selectedNodeId: state.selectedNodeId !== null && allowed.has(state.selectedNodeId) ? state.selectedNodeId : null,
    collapsedNodeIds: state.collapsedNodeIds.filter((id) => nodeIds.has(id) && (validTopic === null || allowed.has(id))),
    detailWidth: state.detailWidth,
    topicFilter: validTopic,
    leftPanelOpen: state.leftPanelOpen,
    rightPanelOpen: state.rightPanelOpen,
    topicStates,
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
