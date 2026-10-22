import { describe, expect, it } from 'vitest';
import type { GraphResponse } from '../../src/shared/protocol.js';
import { buildGraphView } from '../../src/web/graph/viewModel.js';
import { parseReadingState, pruneReadingState, emptyReadingState } from '../../src/web/data/readingState.js';
import { resolveLink, resolveResourceKey, safeUrlTransform, stripNodeComments } from '../../src/web/components/MarkdownBody.js';
import { searchGraph } from '../../src/web/lib/search.js';

function node(id: string, from: string | null, flow: 'root' | 'next' | 'branch', number: string, title: string): GraphResponse['nodes'][number] {
  return {
    id,
    topicId: 't_1',
    title,
    summary: title + ' 摘要',
    number,
    from,
    flow,
    state: 'agreed',
    ...(flow === 'branch' ? { side: 'right' as const, order: 10 } : {}),
  };
}

export const graph: GraphResponse = {
  instanceId: 'inst-a',
  revision: 3,
  workspaceId: 'w_1',
  activeNode: 'n2',
  stale: false,
  diagnostics: [],
  nodes: [
    node('n1', null, 'root', '01', '根节点'),
    node('n2', 'n1', 'next', '02', '主线二'),
    node('n3', 'n1', 'branch', '01-01', '侧枝'),
    node('n4', 'n3', 'next', '01-02', '侧枝续'),
    node('n5', 'n2', 'next', '03', '主线三'),
  ],
  topics: [{ id: 't_1', title: '条目整理', path: 'topics/条目整理.md', nodeIds: ['n1', 'n2', 'n3', 'n4', 'n5'], fileHash: 'abc' }],
};

/**
 * Structure mirroring the acceptance fixture's 06 subtree:
 *  06 -> 07 (next), 06-01 (right branch), 06-02 (next of 06-01),
 *  06-03 (left branch), 06-03-01 (branch), 06-03-02 (next of 06-03-01)
 * 06 therefore has 6 hidden descendants when collapsed.
 */
const treeGraph: GraphResponse = {
  instanceId: 'inst-tree',
  revision: 1,
  workspaceId: 'w_tree',
  activeNode: null,
  stale: false,
  diagnostics: [],
  nodes: [
    node('n05', null, 'root', '05', '根'),
    node('n06', 'n05', 'next', '06', '排版约定'),
    node('n07', 'n06', 'next', '07', '参考外部规范'),
    node('n0601', 'n06', 'branch', '06-01', '标题与标注的分工'),
    node('n0602', 'n0601', 'next', '06-02', '分支内的层级编号'),
    node('n0603', 'n06', 'branch', '06-03', '跨批次沿用约定'),
    node('n060301', 'n0603', 'branch', '06-03-01', '模板方案'),
    node('n060302', 'n060301', 'next', '06-03-02', '设计思想'),
    node('nX', 'n05', 'next', '06-x', '别的主题卡片'),
  ],
  topics: [
    { id: 't_1', title: '协作方式', path: 'topics/协作方式.md', nodeIds: ['n05', 'n06', 'n07', 'n0601', 'n0602', 'n0603', 'n060301', 'n060302'], fileHash: 'aaa' },
    { id: 't_2', title: '条目整理', path: 'topics/条目整理.md', nodeIds: ['nX'], fileHash: 'bbb' },
  ],
};

describe('view model', () => {
  it('hides descendants of a collapsed node and reports the count', () => {
    const view = buildGraphView(graph, new Set(['n3']), null);
    expect(view.visibleIds.has('n4')).toBe(false);
    expect(view.visibleIds.has('n5')).toBe(true);
    expect(view.hiddenDescendantCounts.get('n3')).toBe(1);
    expect(view.collapsedIds).toContain('n3');
  });

  it('keeps the structure key stable across text-only changes', () => {
    const a = buildGraphView(graph, new Set(), null);
    const edited = { ...graph, revision: 4, nodes: graph.nodes.map((item) => ({ ...item, title: item.title + '改', summary: '新摘要' })) };
    const b = buildGraphView(edited, new Set(), null);
    expect(a.structureKey).toBe(b.structureKey);
  });

  it('changes the structure key when geometry inputs change', () => {
    const a = buildGraphView(graph, new Set(), null);
    const b = buildGraphView(graph, new Set(['n1']), null);
    expect(a.structureKey).not.toBe(b.structureKey);
  });

  it('topic focus keeps the path from the root visible', () => {
    const focused = { ...graph, nodes: [...graph.nodes, node('n9', null, 'root', '99', '别的主题')] };
    const view = buildGraphView(focused, new Set(), 't_1');
    expect(view.visibleIds.has('n2')).toBe(true);
    expect(view.visibleIds.has('n9')).toBe(false);
  });
});

describe('reading state', () => {
  it('falls back to defaults on invalid JSON', () => {
    expect(parseReadingState('{not json')).toEqual(emptyReadingState());
    expect(parseReadingState(null)).toEqual(emptyReadingState());
  });

  it('prunes ids that no longer exist without touching the rest', () => {
    const state = { ...emptyReadingState(), selectedNodeId: 'n_gone', collapsedNodeIds: ['n3', 'n_gone'], topicFilter: 't_1', viewport: { x: 1, y: 2, zoom: 0.8 } };
    const pruned = pruneReadingState(state, graph);
    expect(pruned.selectedNodeId).toBeNull();
    expect(pruned.collapsedNodeIds).toEqual(['n3']);
    expect(pruned.topicFilter).toBe('t_1');
    expect(pruned.viewport).toEqual({ x: 1, y: 2, zoom: 0.8 });
  });
});

describe('markdown links', () => {
  it('opens same-workspace topic files only', () => {
    expect(resolveLink('条目整理.md', 'topics/协作方式.md')).toEqual({ kind: 'topic', path: 'topics/条目整理.md' });
    expect(resolveLink('./sub/a.md', 'topics/x/y.md')).toEqual({ kind: 'topic', path: 'topics/x/sub/a.md' });
    expect(resolveLink('../../outside.md', 'topics/y.md').kind).toBe('blocked');
    expect(resolveLink('file:///D:/Note/a.md', 'topics/y.md').kind).toBe('blocked');
    expect(resolveLink('D:/Note/a.md', 'topics/y.md').kind).toBe('blocked');
    expect(resolveLink('/etc/passwd', 'topics/y.md').kind).toBe('blocked');
    expect(resolveLink('other.txt', 'topics/y.md').kind).toBe('blocked');
  });

  it('opens external http(s) and refuses script protocols', () => {
    expect(resolveLink('https://example.com/a', 'topics/y.md')).toEqual({ kind: 'external', href: 'https://example.com/a' });
    expect(resolveLink('javascript:alert(1)', 'topics/y.md').kind).toBe('blocked');
    expect(safeUrlTransform('javascript:alert(1)')).toBe('');
    expect(safeUrlTransform('https://example.com')).toBe('https://example.com');
    expect(safeUrlTransform('#section')).toBe('#section');
  });
});

describe('search', () => {
  it('matches Chinese substrings in title and summary', () => {
    expect(searchGraph(graph, '侧枝').nodes.map((item) => item.id)).toEqual(['n3', 'n4']);
    expect(searchGraph(graph, '条目').topics.map((item) => item.id)).toEqual(['t_1']);
    expect(searchGraph(graph, '   ').nodes).toEqual([]);
  });
});
describe('body display', () => {
  it('drops hidden node-id comments but keeps their text', () => {
    const source = '正文一。\n\n<!-- node:n_00000000000000000000000000000001 -->\n\n正文二。';
    expect(stripNodeComments(source)).toBe('正文一。\n\n正文二。');
    expect(stripNodeComments('无注释')).toBe('无注释');
  });
});
describe('collapse counts shown on cards', () => {
  it('counts the six descendants hidden by collapsing 06', () => {
    const view = buildGraphView(treeGraph, new Set(['n06']), null);
    expect(view.hiddenDescendantCounts.get('n06')).toBe(6);
    expect(view.visibleIds.has('n07')).toBe(false);
    expect(view.visibleIds.has('n060302')).toBe(false);
    // The collapsed card itself stays visible and keeps its expand control.
    expect(view.visibleIds.has('n06')).toBe(true);
    expect(view.childCounts.get('n06')).toBe(3);
  });

  it('does not attribute topic-filtered nodes to a collapse', () => {
    // t_1 excludes nX; with the filter on, collapsing 06 must still report exactly 6,
    // and must not absorb the node removed by the topic filter.
    const filtered = buildGraphView(treeGraph, new Set(['n06']), 't_1');
    expect(filtered.visibleIds.has('nX')).toBe(false);
    expect(filtered.hiddenDescendantCounts.get('n06')).toBe(6);
  });

  it('reports zero-ish counts when the filter removes the descendants', () => {
    // t_2 contains only nX, so nothing under 06 is part of the filtered base set;
    // its collapse hides nothing that the filter had not already removed.
    const filtered = buildGraphView(treeGraph, new Set(['n06']), 't_2');
    expect(filtered.hiddenDescendantCounts.get('n06')).toBeUndefined();
  });
});
describe('urlTransform keeps what the renderers need', () => {
  it('does not erase relative .md links before resolveLink runs', () => {
    // If the transform returned '', resolveLink would receive an empty href and
    // the internal link would silently become a blocked span.
    expect(safeUrlTransform('../条目整理.md', 'href')).toBe('../条目整理.md');
    expect(safeUrlTransform('./sibling.md#part-2', 'href')).toBe('./sibling.md#part-2');
    const target = resolveLink(safeUrlTransform('./sibling.md#part-2', 'href'), 'topics/group/a.md');
    expect(target).toEqual({ kind: 'topic', path: 'topics/group/sibling.md#part-2' });
  });

  it('keeps safe raster data images for src but never for links', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    expect(safeUrlTransform(png, 'src')).toBe(png);
    expect(safeUrlTransform(png, 'href')).toBe('');
    expect(safeUrlTransform('data:image/svg+xml;base64,PHN2Zz4=', 'src')).toBe('');
    expect(safeUrlTransform('data:text/html;base64,PHNjcmlwdD4=', 'src')).toBe('');
  });

  it('keeps relative image paths but blocks remote and file schemes', () => {
    expect(safeUrlTransform('../../resources/pic.png', 'src')).toBe('../../resources/pic.png');
    expect(safeUrlTransform('https://example.com/p.png', 'src')).toBe('https://example.com/p.png');
    expect(safeUrlTransform('file:///C:/secret.png', 'src')).toBe('');
    expect(safeUrlTransform('javascript:alert(1)', 'href')).toBe('');
  });
});

describe('resource keys resolve against the node file', () => {
  it('resolves relative and root-relative resource paths', () => {
    expect(resolveResourceKey('../../resources/pic.png', 'topics/group/node.md')).toBe('resources/pic.png');
    expect(resolveResourceKey('./local.png', 'topics/group/node.md')).toBe('topics/group/local.png');
    expect(resolveResourceKey('/resources/pic.png', 'topics/group/node.md')).toBe('resources/pic.png');
  });

  it('keeps Unicode, spaces and parentheses in resource names', () => {
    // Capture-side keys are real workspace paths, not slugs.
    expect(resolveResourceKey('../../resources/图（1）.png', 'topics/group/node.md')).toBe('resources/图（1）.png');
    expect(resolveResourceKey('./my pic.png', 'topics/group/node.md')).toBe('topics/group/my pic.png');
    // react-markdown may percent-encode spaces; matching must still work.
    expect(resolveResourceKey('./my%20pic.png', 'topics/group/node.md')).toBe('topics/group/my pic.png');
  });

  it('refuses escapes and remote sources so no fetch is attempted', () => {
    expect(resolveResourceKey('../../../../outside.png', 'topics/a.md')).toBeNull();
    expect(resolveResourceKey('https://example.com/p.png', 'topics/a.md')).toBeNull();
    expect(resolveResourceKey('//cdn.example.com/p.png', 'topics/a.md')).toBeNull();
  });
});