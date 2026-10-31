import { describe, expect, it } from 'vitest';
import type { ChangeBatchSummary, ChangeKind, GraphNode, GraphResponse, WorkspaceResponse } from '../../src/next/protocol.js';
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
import { hiddenTreeCounts, treeChildCounts, visibleTreeNodes } from '../../src/web/components/directoryTree.js';
import { buildGraphView } from '../../src/web/graph/viewModel.js';
import { buildLocateText } from '../../src/web/lib/locate.js';
import { cardChangeKinds, changeCountsLabel, nodeChangeKind, topicChangeBatch } from '../../src/web/lib/changes.js';
import { importanceErrorMessage, importanceOf } from '../../src/web/lib/importance.js';
import { ApiError } from '../../src/web/data/client.js';

function node(id: string, from: string | null, flow: 'root' | 'next' | 'branch', number: string, title: string, topicId = 't_1'): GraphNode {
  return {
    id, topicId, title, summary: title + ' 摘要', number, from, flow, important: false, revision: 1,
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
    { id: 't_1', key: '协作方式', title: '协作方式', nodeIds: tree.map((item) => item.id), revision: 4 },
    { id: 't_2', key: '记录的分寸', title: '记录的分寸', nodeIds: ['nX'], revision: 2 },
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
  it('nests a branch chain under its source instead of after the whole mainline', () => {
    const rows = visibleTreeNodes(tree, new Set());
    expect(rows.map((row) => row.id)).toEqual([
      'n05', 'n06',
      'n0601', 'n0602',
      'n0603', 'n060301', 'n060302',
      'n07',
    ]);
  });

  it('folds only the directory subtree, never the mainline next sibling', () => {
    const rows = visibleTreeNodes(tree, new Set(['n06']));
    // 07 is the next mainline sibling of 06; folding 06's branches must not hide it.
    expect(rows.map((row) => row.id)).toEqual(['n05', 'n06', 'n07']);
    expect(hiddenTreeCounts(tree, new Set(['n06'])).get('n06')).toBe(5);
  });

  it('keeps a folded node itself and its ancestors visible', () => {
    // 06-03 hides its own branch subtree only; 06-02 stays as the sibling continuation.
    const rows = visibleTreeNodes(tree, new Set(['n0603']));
    expect(rows.map((row) => row.id)).toEqual(['n05', 'n06', 'n0601', 'n0602', 'n0603', 'n07']);
    expect(hiddenTreeCounts(tree, new Set(['n0603'])).get('n0603')).toBe(2);
    expect(treeChildCounts(tree).get('n06')).toBe(2);
  });

  it('has no directory children for a node whose only continuation is next', () => {
    // 06-01's next (06-02) is a same-level sibling in the directory.
    expect(treeChildCounts(tree).get('n0601')).toBeUndefined();
    expect(hiddenTreeCounts(tree, new Set(['n0601'])).get('n0601')).toBeUndefined();
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

  it('writes the stable ids, revisions and the actual entry paths', () => {
    const text = buildLocateText({ workspace, graph, topic: graph.topics[0]!, node: tree[1]! });
    expect(text.split('\n')).toEqual([
      '工作区：示例库  workspaceId=w_1',
      '主题：协作方式  topicId=t_1  r4',
      '节点：06 排版约定  nodeId=n06  revision=1',
      '快照：inst / r7',
      'CLI：D:/daily/dist/cli/index.js   Skill：D:/daily/skills/aichat-graph/SKILL.md',
      '当前：06 排版约定',
    ]);
  });

  it('states the missing entry paths instead of inventing a file path', () => {
    const text = buildLocateText({ workspace: { ...graph, name: '库', rootPath: '/srv/vault' }, graph, topic: graph.topics[0]!, node: tree[1]! });
    expect(text).toContain('工作区：库  workspaceId=w_1');
    expect(text).toContain('CLI：使用与本服务同版本的入口   Skill：使用与本服务同版本的入口');
    expect(text).not.toContain('D:/daily');
    expect(text).not.toContain('/srv/vault');
    expect(text).not.toContain('源文件');
  });

  it('never leaks body text or another topic', () => {
    const text = buildLocateText({ workspace, graph, topic: graph.topics[0]!, node: tree[1]! });
    expect(text).not.toContain('摘要');
    expect(text).not.toContain('另一个主题');
    expect(text).not.toContain('t_2');
  });
});

describe('latest change labels', () => {
  function batch(
    topicId: string,
    nodes: Array<{ nodeId: string; kind: ChangeKind; title?: string }>,
  ): ChangeBatchSummary {
    const counts = { added: 0, modified: 0, deleted: 0 };
    for (const node of nodes) counts[node.kind] += 1;
    return {
      requestId: 'req-' + topicId,
      topicId,
      at: '2026-01-01T00:00:00Z',
      counts,
      nodes: nodes.map((node) => ({
        nodeId: node.nodeId,
        kind: node.kind,
        title: node.title ?? node.nodeId,
        fields: [],
      })),
    };
  }

  it('labels only added/modified cards and never falls back to another topic', () => {
    const onlyFirst = {
      ...graph,
      lastChanges: {
        t_1: batch('t_1', [
          { nodeId: 'n06', kind: 'modified' },
          { nodeId: 'n0601', kind: 'added' },
          { nodeId: 'n_gone', kind: 'deleted' },
        ]),
      },
    };
    expect([...cardChangeKinds(onlyFirst, 't_1')]).toEqual([
      ['n06', 'modified'],
      ['n0601', 'added'],
    ]);
    expect(cardChangeKinds(onlyFirst, 't_2').size).toBe(0);
    expect(cardChangeKinds(onlyFirst, 't_missing').size).toBe(0);

    const onlySecond = { ...graph, lastChanges: { t_2: batch('t_2', [{ nodeId: 'nX', kind: 'modified' }]) } };
    expect([...cardChangeKinds(onlySecond, 't_2')]).toEqual([['nX', 'modified']]);
    expect(cardChangeKinds(onlySecond, 't_1').size).toBe(0);

    // Decoration only: the batch data never changes the drawn structure.
    expect(buildGraphView(onlyFirst, new Set(), 't_1').structureKey)
      .toBe(buildGraphView(graph, new Set(), 't_1').structureKey);
  });

  it('keeps deleted nodes in the topic change list and reports counts', () => {
    const changed = {
      ...graph,
      lastChanges: {
        t_1: batch('t_1', [
          { nodeId: 'n06', kind: 'modified' },
          { nodeId: 'n_gone', kind: 'deleted', title: '删掉的卡片' },
        ]),
      },
    };
    const stored = topicChangeBatch(changed, 't_1');
    expect(stored).not.toBeNull();
    expect(stored?.nodes.map((node) => [node.nodeId, node.kind])).toEqual([
      ['n06', 'modified'],
      ['n_gone', 'deleted'],
    ]);
    expect(nodeChangeKind(stored, 'n_gone')).toBe('deleted');
    expect(nodeChangeKind(stored, 'n07')).toBeNull();
    expect(changeCountsLabel(stored!.counts)).toBe('新增 0 · 改动 1 · 删除 1');
  });

  it('has no labels when nothing is recorded or the stored shape is unusable', () => {
    expect(cardChangeKinds(graph, 't_1').size).toBe(0);
    expect(cardChangeKinds(null, 't_1').size).toBe(0);
    expect(topicChangeBatch(null, 't_1')).toBeNull();
    expect(topicChangeBatch({ lastChanges: {} }, 't_1')).toBeNull();
    expect(topicChangeBatch(graph, null)).toBeNull();
    expect(cardChangeKinds({ lastChanges: { t_1: batch('t_1', []) } }, 't_1').size).toBe(0);

    const dirty = {
      lastChanges: { t_1: { at: 'x', nodes: 'not-an-array' } },
    } as unknown as Pick<GraphResponse, 'lastChanges'>;
    expect(topicChangeBatch(dirty, 't_1')).toBeNull();
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
