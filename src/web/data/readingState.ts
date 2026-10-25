import type { GraphResponse } from '../../shared/protocol.js';

/** Bumping this invalidates saved panel choices; bump when the meaning changes. */
export const VIEW_SCHEMA_VERSION = 2;

export interface SavedViewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Directory-only fold state. It is stored next to the graph's own collapse state
 * on purpose: folding a node in the navigation must not hide cards on the canvas,
 * so the two live in different fields and never share a value.
 */
export interface NavTreeState {
  /** Topic folders the reader explicitly opened. */
  expandedTopicIds: string[];
  /** Topic folders the reader explicitly folded shut. */
  collapsedTopicIds: string[];
  /** Nodes folded inside the directory tree, keyed by topic id. */
  collapsedNodeIdsByTopic: Record<string, string[]>;
}

export interface TopicReadingState {
  viewport: SavedViewport | null;
  selectedNodeId: string | null;
  collapsedNodeIds: string[];
  /**
   * Whether the directory was open while reading this topic. Absent means "this
   * topic has no opinion yet"; the workspace-level value is used instead.
   */
  navLeftPanelOpen?: boolean;
}

export interface ReadingState {
  viewport: SavedViewport | null;
  selectedNodeId: string | null;
  collapsedNodeIds: string[];
  detailWidth: number;
  topicFilter: string | null;
  /**
   * Default for topics that never recorded their own value. Older saves only had
   * this field, so it doubles as the migration source for per-topic panel state.
   */
  leftPanelOpen: boolean;
  /** Right detail panel. Closed by default; opened only by explicit action. */
  rightPanelOpen: boolean;
  /** Directory tree folds. Independent from `collapsedNodeIds` above. */
  navTree: NavTreeState;
  /** Saved reading position for each topic, never an Agent write target. */
  topicStates: Record<string, TopicReadingState>;
}

function emptyNavTree(): NavTreeState {
  return { expandedTopicIds: [], collapsedTopicIds: [], collapsedNodeIdsByTopic: {} };
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
    navTree: emptyNavTree(),
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function parseNavTree(value: unknown): NavTreeState {
  const tree = emptyNavTree();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return tree;
  const candidate = value as Record<string, unknown>;
  tree.expandedTopicIds = stringList(candidate.expandedTopicIds);
  tree.collapsedTopicIds = stringList(candidate.collapsedTopicIds);
  const byTopic = candidate.collapsedNodeIdsByTopic;
  if (typeof byTopic === 'object' && byTopic !== null && !Array.isArray(byTopic)) {
    for (const [topicId, ids] of Object.entries(byTopic)) {
      const list = stringList(ids);
      if (list.length > 0) tree.collapsedNodeIdsByTopic[topicId] = list;
    }
  }
  return tree;
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
    state.collapsedNodeIds = stringList(candidate.collapsedNodeIds);
  }
  if (typeof candidate.leftPanelOpen === 'boolean') state.leftPanelOpen = candidate.leftPanelOpen;
  if (typeof candidate.rightPanelOpen === 'boolean') state.rightPanelOpen = candidate.rightPanelOpen;
  state.navTree = parseNavTree(candidate.navTree);
  if (typeof candidate.topicStates === 'object' && candidate.topicStates !== null && !Array.isArray(candidate.topicStates)) {
    for (const [id, value] of Object.entries(candidate.topicStates)) {
      if (typeof value !== 'object' || value === null) continue;
      const saved = value as Record<string, unknown>;
      state.topicStates[id] = {
        viewport: isViewport(saved.viewport) ? saved.viewport : null,
        selectedNodeId: typeof saved.selectedNodeId === 'string' ? saved.selectedNodeId : null,
        collapsedNodeIds: stringList(saved.collapsedNodeIds),
        // Saves written before per-topic panel state simply lack it; the reader
        // then keeps using the workspace-level value, so nothing jumps on upgrade.
        ...(typeof saved.navLeftPanelOpen === 'boolean' ? { navLeftPanelOpen: saved.navLeftPanelOpen } : {}),
      };
    }
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * Directory panel + tree folds (local reading state only)
 * ------------------------------------------------------------------ */

/**
 * The directory is the only per-topic panel: a reader who keeps it open for one
 * topic should not force it open for every other topic.
 */
export function leftPanelOpenFor(state: ReadingState): boolean {
  const topicId = state.topicFilter;
  if (topicId !== null) {
    const saved = state.topicStates[topicId]?.navLeftPanelOpen;
    if (saved !== undefined) return saved;
  }
  return state.leftPanelOpen;
}

export function setLeftPanelOpen(state: ReadingState, open: boolean): ReadingState {
  const topicId = state.topicFilter;
  if (topicId === null) return { ...state, leftPanelOpen: open };
  const previous = state.topicStates[topicId];
  return {
    ...state,
    // Kept as the default for topics that have never been visited.
    leftPanelOpen: open,
    topicStates: {
      ...state.topicStates,
      [topicId]: {
        viewport: previous?.viewport ?? null,
        selectedNodeId: previous?.selectedNodeId ?? null,
        collapsedNodeIds: previous?.collapsedNodeIds ?? [],
        navLeftPanelOpen: open,
      },
    },
  };
}

export function toggleLeftPanel(state: ReadingState): ReadingState {
  return setLeftPanelOpen(state, !leftPanelOpenFor(state));
}

/** A folder with no recorded decision follows the topic being read. */
export function navFolderExpanded(tree: NavTreeState, topicId: string, currentTopicId: string | null): boolean {
  if (tree.collapsedTopicIds.includes(topicId)) return false;
  if (tree.expandedTopicIds.includes(topicId)) return true;
  return topicId === currentTopicId;
}

export function toggleNavFolder(state: ReadingState, topicId: string, currentTopicId: string | null): ReadingState {
  const tree = state.navTree;
  const open = navFolderExpanded(tree, topicId, currentTopicId);
  const without = (list: string[]): string[] => list.filter((id) => id !== topicId);
  const next: NavTreeState = {
    ...tree,
    expandedTopicIds: open ? without(tree.expandedTopicIds) : [...without(tree.expandedTopicIds), topicId],
    collapsedTopicIds: open ? [...without(tree.collapsedTopicIds), topicId] : without(tree.collapsedTopicIds),
  };
  return { ...state, navTree: next };
}

export function navCollapsedNodeIds(tree: NavTreeState, topicId: string): string[] {
  return tree.collapsedNodeIdsByTopic[topicId] ?? [];
}

/** Flips one node's fold inside the directory only; the canvas is untouched. */
export function toggleNavNode(state: ReadingState, topicId: string, nodeId: string): ReadingState {
  const current = navCollapsedNodeIds(state.navTree, topicId);
  const next = current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId];
  const byTopic = { ...state.navTree.collapsedNodeIdsByTopic };
  if (next.length === 0) delete byTopic[topicId];
  else byTopic[topicId] = next;
  return { ...state, navTree: { ...state.navTree, collapsedNodeIdsByTopic: byTopic } };
}

/**
 * Switching topics is a browsing action: it opens the diagram and never moves the
 * directory panel. The panel state on screen wins and is carried into the topic
 * being opened, so each topic restores its own value only on a reload / rebuild.
 */
export function switchReadingTopic(state: ReadingState, topicId: string): ReadingState {
  if (state.topicFilter === topicId) return state;
  const carriedPanel = leftPanelOpenFor(state);
  const topicStates = { ...state.topicStates };
  if (state.topicFilter !== null) {
    topicStates[state.topicFilter] = {
      viewport: state.viewport,
      selectedNodeId: state.selectedNodeId,
      collapsedNodeIds: state.collapsedNodeIds,
      navLeftPanelOpen: carriedPanel,
    };
  }
  const saved = topicStates[topicId];
  // Opening a topic leaves its folder open from then on, unless the reader folded
  // it deliberately: an explicit fold always wins over this default.
  const expandedTopicIds = state.navTree.collapsedTopicIds.includes(topicId) || state.navTree.expandedTopicIds.includes(topicId)
    ? state.navTree.expandedTopicIds
    : [...state.navTree.expandedTopicIds, topicId];
  return {
    ...state,
    topicStates: {
      ...topicStates,
      [topicId]: {
        viewport: saved?.viewport ?? null,
        selectedNodeId: saved?.selectedNodeId ?? null,
        collapsedNodeIds: saved?.collapsedNodeIds ?? [],
        // Carried over, not taken from the target's record: switching must not
        // close or open the panel by itself.
        navLeftPanelOpen: carriedPanel,
      },
    },
    topicFilter: topicId,
    navTree: { ...state.navTree, expandedTopicIds },
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
      ...(saved.navLeftPanelOpen !== undefined ? { navLeftPanelOpen: saved.navLeftPanelOpen } : {}),
    };
  }
  const validTopic = state.topicFilter !== null && topicIds.has(state.topicFilter) ? state.topicFilter : null;
  const allowed = new Set(graph.nodes.filter((node) => validTopic !== null && node.topicId === validTopic).map((node) => node.id));
  const tree = state.navTree;
  const collapsedNodeIdsByTopic: Record<string, string[]> = {};
  for (const [topicId, ids] of Object.entries(tree.collapsedNodeIdsByTopic)) {
    if (!topicIds.has(topicId)) continue;
    const kept = ids.filter((id) => nodeIds.has(id));
    if (kept.length > 0) collapsedNodeIdsByTopic[topicId] = kept;
  }
  return {
    viewport: validTopic === state.topicFilter ? state.viewport : null,
    selectedNodeId: state.selectedNodeId !== null && allowed.has(state.selectedNodeId) ? state.selectedNodeId : null,
    collapsedNodeIds: state.collapsedNodeIds.filter((id) => nodeIds.has(id) && (validTopic === null || allowed.has(id))),
    detailWidth: state.detailWidth,
    topicFilter: validTopic,
    leftPanelOpen: state.leftPanelOpen,
    rightPanelOpen: state.rightPanelOpen,
    navTree: {
      expandedTopicIds: tree.expandedTopicIds.filter((id) => topicIds.has(id)),
      collapsedTopicIds: tree.collapsedTopicIds.filter((id) => topicIds.has(id)),
      collapsedNodeIdsByTopic,
    },
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
