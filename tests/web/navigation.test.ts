import { describe, expect, it } from 'vitest';
import type { GraphNode, GraphResponse, WorkspaceResponse } from '../../src/shared/protocol.js';
import {
  emptyReadingState,
  leftPanelOpenFor,
  navCollapsedNodeIds,
  navFolderExpanded,
  parseReadingState,
  pruneReadingState,
  setLeftPanelOpen,
  switchReadingTopic,
  toggleLeftPanel,
  toggleNavFolder,
  toggleNavNode,
  type ReadingState,
} from '../../src/web/data/readingState.js';
import { hiddenTreeCounts, treeChildCounts, visibleTreeNodes } from '../../src/web/components/Sidebar.js';
import { buildGraphView } from '../../src/web/graph/viewModel.js';
import { absoluteWorkspacePath, buildLocateText } from '../../src/web/lib/locate.js';
import { recentNodeIds } from '../../src/web/lib/recent.js';
import { importanceErrorMessage, importanceOf } from '../../src/web/lib/importance.js';
import { ApiError } from '../../src/web/data/client.js';

function node(id: string, from: string | null, flow: 'root' | 'next' | 'branch', number: string, title: string, topicId = 't_1'): GraphNode {
  return {
    id, topicId, title, summary: title + ' 摘要', number, from, flow, state: 'agreed', important: false,
    ...(flow === 'branch' ? { side: 'right' as const, order: 10 } : {}),
  };
}

/** 06 -> 07 (next), 06-01 (branch) -> 06-02 (next), 06-03 (branch) -> 06-03-01 -> 06-03-02 */
const tree: GraphNode[] = [
  node('n05', null, 'root', '05', '根'),
  node('n06', 'n05', 'next', '06', '排版约定'),
  node('n07', 'n06', 'next', '07', '参考外部规范'),
  node('n0601', 'n06', 'branch', '06-01', '标题与标注的分工'),
  node('n0602', 'n0601', 'next', '06-02', '分支内的层级编号'),
  node('n0603', 'n06', 'branch', '06-03', '跨批次沿用约定'),
  node('n060301', 'n0603', 'branch', '06-03-01', '模板方案'),
  node('n060302', 'n060301', 'next', '06-03-02', '设计思想'),
];

const graph: GraphResponse = {
  instanceId: 'inst',
  revision: 7,
  workspaceId: 'w_1',
  activeNode: 'n06',
  stale: false,
  diagnostics: [],
  nodes: [...tree, node('nX', null, 'root', '01', '另一个主题', 't_2')],
  topics: [
    { id: 't_1', title: '协作方式', path: 'topics/协作方式/topic.md', nodeIds: tree.map((item) => item.id), fileHash: 'aaa' },
    { id: 't_2', title: '记录的分寸', path: 'topics/记录的分寸/topic.md', nodeIds: ['nX'], fileHash: 'bbb' },
  ],
};

describe('directory panel is remembered per topic', () => {
  it('never moves the panel when switching topics', () => {
    let state: ReadingState = switchReadingTopic(emptyReadingState(), 't_1');
    expect(leftPanelOpenFor(state)).toBe(false);
    state = setLeftPanelOpen(state, true);
    expect(leftPanelOpenFor(state)).toBe(true);

    // Switching is a browsing action: an open directory stays open.
    const other = switchReadingTopic(state, 't_2');
    expect(leftPanelOpenFor(other)).toBe(true);

    const closed = setLeftPanelOpen(other, false);
    expect(leftPanelOpenFor(closed)).toBe(false);
    // …and a closed one stays closed, even when the target topic was open before.
    const back = switchReadingTopic(closed, 't_1');
    expect(leftPanelOpenFor(back)).toBe(false);
  });

  it('restores each topic’s recorded value after a reload', () => {
    // A saved state where the two topics disagree: only a reload may use this.
    const saved = JSON.stringify({
      ...emptyReadingState(),
      topicFilter: 't_1',
      topicStates: {
        t_1: { viewport: null, selectedNodeId: null, collapsedNodeIds: [], navLeftPanelOpen: false },
        t_2: { viewport: null, selectedNodeId: null, collapsedNodeIds: [], navLeftPanelOpen: true },
      },
    });
    const parsed = parseReadingState(saved);
    expect(leftPanelOpenFor(parsed)).toBe(false);
    expect(leftPanelOpenFor({ ...parsed, topicFilter: 't_2' })).toBe(true);
  });

  it('survives closing, reloading and reopening the panel', () => {
    let state = switchReadingTopic(emptyReadingState(), 't_1');
    state = toggleLeftPanel(state);
    expect(leftPanelOpenFor(state)).toBe(true);
    state = toggleLeftPanel(state);
    expect(leftPanelOpenFor(state)).toBe(false);

    // A component rebuild / page reload only has the saved string.
    const restored = parseReadingState(JSON.stringify(state));
    expect(leftPanelOpenFor(restored)).toBe(false);
    expect(leftPanelOpenFor(toggleLeftPanel(restored))).toBe(true);
  });

  it('migrates the old workspace-level flag instead of discarding it', () => {
    const legacy = JSON.stringify({
      viewport: { x: 12, y: 34, zoom: 0.8 },
      selectedNodeId: 'n06',
      collapsedNodeIds: ['n06'],
      detailWidth: 420,
      topicFilter: 't_1',
      leftPanelOpen: true,
      rightPanelOpen: false,
      topicStates: { t_1: { viewport: { x: 1, y: 2, zoom: 1 }, selectedNodeId: 'n07', collapsedNodeIds: ['n07'] } },
    });
    const state = parseReadingState(legacy);
    expect(state.leftPanelOpen).toBe(true);
    expect(leftPanelOpenFor(state)).toBe(true);
    // Nothing else from the old save is lost.
    expect(state.detailWidth).toBe(420);
    expect(state.viewport).toEqual({ x: 12, y: 34, zoom: 0.8 });
    expect(state.selectedNodeId).toBe('n06');
    expect(state.collapsedNodeIds).toEqual(['n06']);
    expect(state.topicStates['t_1']?.selectedNodeId).toBe('n07');
    expect(state.topicStates['t_1']?.collapsedNodeIds).toEqual(['n07']);
  });
});

describe('directory folds are their own state', () => {
  it('folds topic folders without touching the graph collapse', () => {
    const base = switchReadingTopic(emptyReadingState(), 't_1');
    const foldedFolder = toggleNavFolder(base, 't_1', 't_1');
    expect(navFolderExpanded(foldedFolder.navTree, 't_1', 't_1')).toBe(false);
    // The diagram keeps every card: this is a navigation fold only.
    expect(foldedFolder.collapsedNodeIds).toEqual([]);
    // A node fold survives folding its folder.
    const withNodeFold = toggleNavNode(foldedFolder, 't_1', 'n06');
    expect(navCollapsedNodeIds(withNodeFold.navTree, 't_1')).toEqual(['n06']);
    expect(withNodeFold.collapsedNodeIds).toEqual([]);
  });

  it('does not touch the graph fold either direction', () => {
    const state: ReadingState = { ...switchReadingTopic(emptyReadingState(), 't_1'), collapsedNodeIds: ['n0601'] };
    const folded = toggleNavNode(state, 't_1', 'n06');
    expect(folded.collapsedNodeIds).toEqual(['n0601']);
    expect(navCollapsedNodeIds(folded.navTree, 't_1')).toEqual(['n06']);
  });

  it('round-trips through storage and prunes ids the graph no longer has', () => {
    let state = switchReadingTopic(emptyReadingState(), 't_1');
    state = toggleNavNode(state, 't_1', 'n06');
    state = toggleNavFolder(state, 't_2', 't_1');
    const restored = parseReadingState(JSON.stringify(state));
    expect(navCollapsedNodeIds(restored.navTree, 't_1')).toEqual(['n06']);
    // t_2 was folded shut by default (it is not the topic being read); one toggle opens it.
    expect(navFolderExpanded(restored.navTree, 't_2', 't_1')).toBe(true);
    expect(navFolderExpanded(toggleNavFolder(restored, 't_2', 't_1').navTree, 't_2', 't_1')).toBe(false);

    const pruned = pruneReadingState(restored, { ...graph, nodes: tree, topics: [graph.topics[0]!] });
    expect(pruned.navTree.collapsedNodeIdsByTopic['t_1']).toEqual(['n06']);
    expect(pruned.navTree.collapsedTopicIds).toEqual([]);
  });

  it('drops tree folds pointing at deleted nodes only', () => {
    let state = switchReadingTopic(emptyReadingState(), 't_1');
    state = toggleNavNode(state, 't_1', 'n06');
    state = toggleNavNode(state, 't_1', 'n_gone');
    const pruned = pruneReadingState(state, graph);
    expect(navCollapsedNodeIds(pruned.navTree, 't_1')).toEqual(['n06']);
  });
});

describe('directory tree rows', () => {
  it('hides the descendants of a folded node and keeps the rest', () => {
    const rows = visibleTreeNodes(tree, new Set(['n06']));
    expect(rows.map((row) => row.id)).toEqual(['n05', 'n06']);
    expect(hiddenTreeCounts(tree, new Set(['n06'])).get('n06')).toBe(6);
  });

  it('keeps the folded node itself and its ancestors visible', () => {
    const rows = visibleTreeNodes(tree, new Set(['n0601']));
    expect(rows.map((row) => row.id)).toEqual(['n05', 'n06', 'n07', 'n0601', 'n0603', 'n060301', 'n060302']);
    expect(hiddenTreeCounts(tree, new Set(['n0601'])).get('n0601')).toBe(1);
    expect(treeChildCounts(tree).get('n06')).toBe(3);
  });

  it('ignores ids that are not part of this topic', () => {
    const rows = visibleTreeNodes(tree, new Set(['nX']));
    expect(rows).toHaveLength(tree.length);
  });
});

describe('card locator', () => {
  const workspace: WorkspaceResponse = {
    ...graph,
    name: '示例库',
    rootPath: 'D:\\vault\\示例',
    agentEntry: { cliPath: 'D:/daily/dist/cli/index.js', skillPath: 'D:/daily/skills/aichat-graph/SKILL.md' },
  };

  it('writes the ids, the real node file and the entry paths', () => {
    const target = { ...tree[1]!, sourcePath: 'topics/协作方式/n_06.md' };
    const text = buildLocateText({ workspace, graph, topic: graph.topics[0]!, node: target });
    expect(text.split('\n')).toEqual([
      '工作区：示例库（D:\\vault\\示例）  workspaceId=w_1',
      'topicId=t_1  nodeId=n06',
      '源文件：D:\\vault\\示例\\topics\\协作方式\\n_06.md',
      'CLI：D:/daily/dist/cli/index.js   Skill：D:/daily/skills/aichat-graph/SKILL.md',
      '当前：06 排版约定',
    ]);
  });

  it('says which files are missing instead of inventing paths', () => {
    const text = buildLocateText({ workspace: { ...graph, name: '库', rootPath: '/srv/vault' }, graph, topic: graph.topics[0]!, node: tree[1]! });
    expect(text).toContain('源文件：未提供该节点的独立源文件；主题文件 /srv/vault/topics/协作方式/topic.md');
    expect(text).toContain('CLI：使用与本服务同版本的入口   Skill：使用与本服务同版本的入口');
    expect(text).not.toContain('D:/daily');
  });

  it('never leaks body text or another topic', () => {
    const text = buildLocateText({ workspace, graph, topic: graph.topics[0]!, node: { ...tree[1]!, sourcePath: 'topics/a.md' } });
    expect(text).not.toContain('摘要');
    expect(text).not.toContain('另一个主题');
    expect(text).not.toContain('t_2');
  });

  it('joins paths with the separator the root actually uses', () => {
    expect(absoluteWorkspacePath('D:\\vault\\', 'topics/a.md')).toBe('D:\\vault\\topics\\a.md');
    expect(absoluteWorkspacePath('/srv/vault/', 'topics/a.md')).toBe('/srv/vault/topics/a.md');
    expect(absoluteWorkspacePath('/srv/vault', '/topics/a.md')).toBe('/srv/vault/topics/a.md');
  });
});

describe('recent-change marker', () => {
  it('keeps each topic’s own latest batch', () => {
    const onlyFirst = { ...graph, lastChanges: { t_1: { at: 'a', nodeIds: ['n06', 'n0601'] } } };
    expect([...recentNodeIds(onlyFirst, 't_1')]).toEqual(['n06', 'n0601']);
    // A topic without its own record has no marker; it never falls back to t_1.
    expect(recentNodeIds(onlyFirst, 't_2').size).toBe(0);
    expect(recentNodeIds(onlyFirst, 't_missing').size).toBe(0);

    const onlySecond = { ...graph, lastChanges: { t_2: { at: 'b', nodeIds: ['nX'] } } };
    expect([...recentNodeIds(onlySecond, 't_2')]).toEqual(['nX']);
    expect(recentNodeIds(onlySecond, 't_1').size).toBe(0);

    // Switching the reading topic switches the marker with it.
    const both = {
      ...graph,
      lastChanges: {
        t_1: { at: 'a', nodeIds: ['n06'] },
        t_2: { at: 'b', nodeIds: ['nX'] },
      },
    };
    expect([...recentNodeIds(both, 't_1')]).toEqual(['n06']);
    expect([...recentNodeIds(both, 't_2')]).toEqual(['nX']);

    // Decoration only: the marker data never changes the drawn structure.
    expect(buildGraphView(onlyFirst, new Set(), 't_1').structureKey)
      .toBe(buildGraphView(graph, new Set(), 't_1').structureKey);
  });

  it('merges every topic in the whole-workspace view without duplicates', () => {
    const changes = {
      t_1: { at: 'a', nodeIds: ['n06', 'n07'] },
      t_2: { at: 'b', nodeIds: ['n07', 'nX'] },
    };
    const merged = { ...graph, lastChanges: changes };
    expect([...recentNodeIds(merged, null)].sort()).toEqual(['n06', 'n07', 'nX']);
    // Omitting the topic means the same whole-library view.
    expect([...recentNodeIds(merged)].sort()).toEqual(['n06', 'n07', 'nX']);
    expect([...recentNodeIds(merged, '')].sort()).toEqual(['n06', 'n07', 'nX']);
  });

  it('has no marker when nothing is recorded and ignores non-string ids', () => {
    expect(recentNodeIds(graph, 't_1').size).toBe(0);
    expect(recentNodeIds(null).size).toBe(0);
    expect(recentNodeIds(null, 't_1').size).toBe(0);
    expect(recentNodeIds({ lastChanges: {} }, 't_1').size).toBe(0);
    expect(recentNodeIds({ lastChanges: { t_1: { at: 'x', nodeIds: [] } } }, 't_1').size).toBe(0);
    expect(recentNodeIds({ lastChanges: { t_1: { at: 'x', nodeIds: [] } } }, null).size).toBe(0);

    const dirty = {
      lastChanges: { t_1: { at: 'x', nodeIds: ['n06', 7, null, 'n06'] } },
    } as unknown as Parameters<typeof recentNodeIds>[0];
    expect([...recentNodeIds(dirty, 't_1')]).toEqual(['n06']);
  });
});

describe('importance control', () => {
  it('reads the source flag defensively', () => {
    expect(importanceOf({ important: true })).toBe(true);
    expect(importanceOf({ important: false })).toBe(false);
    expect(importanceOf(null)).toBe(false);
  });

  it('explains a stale write, a missing card and a bad request', () => {
    expect(importanceErrorMessage(new ApiError(412, 'VERSION_CONFLICT', 'stale'))).toContain('内容已变化');
    expect(importanceErrorMessage(new ApiError(409, 'NOT_FOUND', 'gone'))).toContain('已不存在');
    expect(importanceErrorMessage(new ApiError(400, 'BAD_REQUEST', '非法字段'))).toContain('非法字段');
    expect(importanceErrorMessage(new ApiError(0, 'NETWORK', 'offline'))).toContain('无法连接');
  });
});
