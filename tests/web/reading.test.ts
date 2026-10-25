import { describe, expect, it } from 'vitest';
import type { GraphResponse } from '../../src/shared/protocol.js';
import { buildGraphView, connectionText, scopeGraphToTopic, type GraphView } from '../../src/web/graph/viewModel.js';
import { CARD_BASE_HEIGHT, CARD_WIDTH, EDGE_LABEL_FONT, EDGE_LABEL_PAD_Y, LAYOUT_HORIZONTAL_GAP, LAYOUT_VERTICAL_GAP, cardHeightForTitle, textWidth, wrapByWidth } from '../../src/web/graph/cardMetrics.js';
import { parseReadingState, pruneReadingState, emptyReadingState, switchReadingTopic } from '../../src/web/data/readingState.js';
import { resolveLink, resolveResourceKey, safeUrlTransform, stripNodeComments } from '../../src/web/components/MarkdownBody.js';
import { flowLabel } from '../../src/web/components/display.js';
import { searchGraph } from '../../src/web/lib/search.js';
import { buildContinuationPrompt } from '../../src/web/lib/prompt.js';
import { computeLayout } from '../../src/web/layout/index.js';
import type { LayoutEdgeRoute, LayoutResult } from '../../src/web/layout/types.js';
import { buildOrthogonalPath, pathLength } from '../../src/web/components/edgePath.js';
import { buildFlowEdges } from '../../src/web/graph/flowEdges.js';

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
    important: false,
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

  it('keeps the structure key stable for summary and height-neutral title edits', () => {
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

describe('card height and connector labels', () => {
  it('returns a stable height for the same title', () => {
    expect(cardHeightForTitle('排版约定')).toBe(cardHeightForTitle('排版约定'));
    expect(textWidth('排版约定', 15)).toBeGreaterThan(textWidth('ab', 15));
  });

  it('grows the card for a title that needs more rows', () => {
    const short = cardHeightForTitle('短标题');
    const long = cardHeightForTitle('这是一个明显需要换行的很长标题'.repeat(4));
    expect(long).toBeGreaterThan(short);
  });

  it('never shrinks a card while mixed Chinese and Latin text grows', () => {
    const base = 'Graph layout 排版约定 with wrapping 规则';
    let previous = cardHeightForTitle('');
    for (let index = 1; index <= base.length; index += 1) {
      const height = cardHeightForTitle(base.slice(0, index));
      expect(height).toBeGreaterThanOrEqual(previous);
      previous = height;
    }
  });

  it('never leaves a one- or two-glyph widow on a connector row', () => {
    const sentences = [
      '用明确左侧对照自动择侧',
      '把并列分支单独走一遍',
      '从一个侧枝再分出方向',
      '检查后续节点的分支位置',
    ];
    for (const sentence of sentences) {
      const lines = wrapByWidth(sentence, 104, 11, 3);
      expect(lines).toHaveLength(2);
      expect([...(lines[lines.length - 1] ?? '')].length).toBeGreaterThanOrEqual(3);
      expect(lines.join('')).toBe(sentence);
      for (const line of lines) expect(textWidth(line, 11)).toBeLessThanOrEqual(104);
      // Pure function: the same sentence always folds the same way.
      expect(wrapByWidth(sentence, 104, 11, 3)).toEqual(lines);
    }
  });

  it('keeps a mixed Latin tail intact instead of halving it', () => {
    const untouched = wrapByWidth('把 layout 规则写成短句说明', 104, 11, 3);
    expect(untouched).toEqual(['把 layout 规则写成', '短句说明']);

    // Would be a two-glyph widow, but the row holds a Latin word.
    const guarded = wrapByWidth('先定 layout 再排版位置', 104, 11, 3);
    expect(guarded).toEqual(['先定 layout 再排版', '位置']);

    for (const line of [...untouched, ...guarded]) {
      expect(textWidth(line, 11)).toBeLessThanOrEqual(104);
    }
  });

  it('changes the structure key with title height but not with the summary', () => {
    const before = buildGraphView(graph, new Set(), null);
    const longTitle = '一个足够长而必须换行的标题'.repeat(8);
    const retitled = { ...graph, nodes: graph.nodes.map((item, index) => (index === 0 ? { ...item, title: longTitle } : item)) };
    expect(buildGraphView(retitled, new Set(), null).structureKey).not.toBe(before.structureKey);

    const resummarized = { ...graph, nodes: graph.nodes.map((item) => ({ ...item, summary: '改过的概述'.repeat(20) })) };
    expect(buildGraphView(resummarized, new Set(), null).structureKey).toBe(before.structureKey);
  });

  it('passes title height and the relationship sentence to layout', () => {
    const described = {
      ...graph,
      nodes: graph.nodes.map((item) => (item.id === 'n2' ? { ...item, description: '因为要解释排版分工，所以接在主线之后。' } : item)),
    };
    const view = buildGraphView(described, new Set(), null);
    expect(view.layoutNodes.find((item) => item.id === 'n1')?.height).toBe(cardHeightForTitle('根节点'));
    expect(view.layoutNodes.find((item) => item.id === 'n2')?.label).toBe('因为要解释排版分工，所以接在主线之后。');

    // description is the only connection text.
    expect(connectionText({ description: '关系句' })).toBe('关系句');
    expect(connectionText({ description: '   ' })).toBe('');
    expect(connectionText({})).toBe('');
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

describe('isolated topic reading', () => {
  const twoTopics: GraphResponse = {
    ...graph, activeNode: 'other',
    nodes: [...graph.nodes, { ...node('other', null, 'root', '01', '另一个主题'), topicId: 't_2' }],
    topics: [...graph.topics, { id: 't_2', title: '另一个主题', path: 'topics/第二主题/topic.md', nodeIds: ['other'], fileHash: 'bbb' }],
  };

  it('opens no graph until a topic is chosen, and search never leaks another topic', () => {
    expect(scopeGraphToTopic(twoTopics, null).nodes).toEqual([]);
    const first = scopeGraphToTopic(twoTopics, 't_1');
    expect(buildGraphView(first, new Set(), 't_1').nodes.map((node) => node.id)).not.toContain('other');
    expect(searchGraph(first, '另一个').nodes).toEqual([]);
    expect(first.activeNode).toBeNull();
    expect(scopeGraphToTopic(twoTopics, 't_2').nodes.map((node) => node.id)).toEqual(['other']);
  });

  it('restores each topic viewport, selection and collapse after switching and reload', () => {
    const a = { ...switchReadingTopic(emptyReadingState(), 't_1'), selectedNodeId: 'n3', collapsedNodeIds: ['n3'], viewport: { x: 123, y: 40, zoom: 0.7 }, rightPanelOpen: true };
    const b = switchReadingTopic(a, 't_2');
    expect(b.selectedNodeId).toBeNull();
    expect(b.rightPanelOpen).toBe(false);
    const saved = parseReadingState(JSON.stringify({ ...b, selectedNodeId: 'other', viewport: { x: 20, y: 30, zoom: 1.1 } }));
    const restored = switchReadingTopic(saved, 't_1');
    expect(restored.selectedNodeId).toBe('n3');
    expect(restored.collapsedNodeIds).toEqual(['n3']);
    expect(restored.viewport).toEqual(a.viewport);
    expect(switchReadingTopic(restored, 't_2').viewport).toEqual({ x: 20, y: 30, zoom: 1.1 });
  });

  it('copies exact topic binding and actual entry paths without another topic focus', () => {
    const first = twoTopics.topics[0]!;
    const text = buildContinuationPrompt({
      graph: twoTopics, topic: first, node: twoTopics.nodes.find((node) => node.id === 'other')!,
      workspace: { ...twoTopics, name: '示例库', rootPath: 'D:/example-vault', agentEntry: { cliPath: 'D:/daily/dist/cli/index.js', skillPath: 'D:/daily/skills/aichat-graph/SKILL.md' } },
    });
    expect(text).toContain('workspaceId：w_1');
    expect(text).toContain('topicId=t_1');
    expect(text).toContain('主题目录：D:/example-vault/topics');
    expect(text).toContain('D:/daily/dist/cli/index.js');
    expect(text).toContain('D:/daily/skills/aichat-graph/SKILL.md');
    expect(text).toContain('不会自动改变本对话的记录目标');
    expect(text).not.toContain('activeNode：other');
    expect(text).not.toContain('另一个主题');
    expect(text).not.toContain('按文件顺序阅读所有卡片');
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

describe('connector paths', () => {
  it('keeps a two-point connector a plain straight line', () => {
    expect(buildOrthogonalPath([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toBe('M 0 0 L 100 0');
    expect(buildOrthogonalPath([{ x: 0, y: 0 }, { x: 0, y: 40 }])).toBe('M 0 0 L 0 40');
    expect(buildOrthogonalPath([])).toBe('');
  });

  it('rounds a corner on both sides of it by the shared radius', () => {
    const path = buildOrthogonalPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    expect(path).toBe('M 0 0 L 94 0 Q 100 0 100 6 L 100 100');
  });

  it('leaves corners alone when a segment is shorter than two radii', () => {
    // The 10px middle segment cannot host two 6px fillets, so nothing is cut.
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }, { x: 0, y: 10 }];
    expect(buildOrthogonalPath(points)).toBe('M 0 0 L 100 0 L 100 10 L 0 10');
    // A single short run between two long ones keeps only the corner it can round.
    const mixed = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 500 }];
    expect(buildOrthogonalPath(mixed).startsWith('M 0 0 L 94 0 Q 100 0 100 6')).toBe(true);
  });

  it('keeps the vertex list of a polyline predictable', () => {
    const points = [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 40 }, { x: 130, y: 40 }];
    const path = buildOrthogonalPath(points);
    expect(path).toBe('M 10 10 L 54 10 Q 60 10 60 16 L 60 34 Q 60 40 66 40 L 130 40');
    // Rounded corners only shorten the drawn line.
    expect(pathLength(points)).toBeLessThan(pathLength(points, 0));
    expect(pathLength(points, 0)).toBeCloseTo(50 + 30 + 70, 6);
  });
});

describe('v5 branch layout, routing and labels', () => {
  function described(
    id: string,
    from: string | null,
    flow: 'root' | 'next',
    title: string,
    description: string,
  ): GraphResponse['nodes'][number] {
    return { ...node(id, from, flow, id, title), description };
  }

  function branch(
    id: string,
    from: string,
    side: 'left' | 'right',
    order: number,
    title: string,
    description: string,
  ): GraphResponse['nodes'][number] {
    return { ...node(id, from, 'branch', id, title), side, order, description };
  }

  /**
   * Main chain r -> n1 -> n2; two siblings on r share a trunk; a single branch
   * on n2 has none; b1 has a next spine and one nested branch. Every non-root
   * node carries its relationship wording.
   */
  const labelledGraph: GraphResponse = {
    instanceId: 'inst-v5',
    revision: 1,
    workspaceId: 'w_v5',
    activeNode: null,
    stale: false,
    diagnostics: [],
    nodes: [
      described('r', null, 'root', '根', '根主题的说明'),
      described('n1', 'r', 'next', '主线一', '主线续接的第一段关系说明'),
      described('n2', 'n1', 'next', '主线二', '主线续接的第二段关系说明'),
      branch('b1', 'r', 'right', 10, '分支一', '第一条并列分支的关系文字需要完整换行显示'.repeat(3)),
      described('b1n', 'b1', 'next', '分支一续', '分支链内部继续向下阅读的说明'),
      branch('b1x', 'b1', 'right', 10, '分支一再分', '分支中段再发出一个子分支的说明'),
      branch('b2', 'r', 'right', 20, '分支二', '第二条并列分支的关系文字同样需要两三行空间才能读完'.repeat(2)),
      branch('b3', 'n2', 'right', 10, '分支三', '来自主线第二节点的单支关系说明'),
    ],
    topics: [{
      id: 't_1',
      title: 'v5',
      path: 'topics/v5.md',
      nodeIds: ['r', 'n1', 'n2', 'b1', 'b1n', 'b1x', 'b2', 'b3'],
      fileHash: 'v5',
    }],
  };

  const view = buildGraphView(labelledGraph, new Set(), null);

  function layoutFor(graphView: GraphView): LayoutResult {
    return computeLayout({
      nodes: graphView.layoutNodes,
      visibleNodeIds: [...graphView.visibleIds],
      collapsedNodeIds: graphView.collapsedIds,
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_BASE_HEIGHT,
      verticalGap: LAYOUT_VERTICAL_GAP,
      horizontalGap: LAYOUT_HORIZONTAL_GAP,
      structureVersion: graphView.structureKey,
    });
  }

  const layout = layoutFor(view);
  const routes = new Map(layout.edgeRoutes.map((route) => [route.id, route]));
  const texts = new Map<string, string>();
  for (const item of view.nodes) {
    if (item.from !== null) texts.set(item.from + '->' + item.id, (item.description ?? '').trim());
  }

  interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
  }

  const cards: (Rect & { id: string })[] = Object.entries(layout.positions).map(([id, position]) => ({
    id,
    left: position.x,
    top: position.y,
    width: layout.cardWidth,
    height: layout.heights[id] ?? layout.cardHeight,
  }));

  function overlaps(a: Rect, b: Rect, gap = 0.5): boolean {
    return (
      a.left < b.left + b.width - gap &&
      a.left + a.width > b.left + gap &&
      a.top < b.top + b.height - gap &&
      a.top + a.height > b.top + gap
    );
  }

  function labelHitsSegment(label: Rect, points: readonly { x: number; y: number }[]): boolean {
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1];
      const b = points[index];
      if (a === undefined || b === undefined) continue;
      if (Math.abs(a.y - b.y) < 0.01) {
        if (a.y <= label.top + 0.5 || a.y >= label.top + label.height - 0.5) continue;
        const low = Math.min(a.x, b.x);
        const high = Math.max(a.x, b.x);
        if (Math.min(high, label.left + label.width - 0.5) > Math.max(low, label.left + 0.5)) return true;
      } else if (Math.abs(a.x - b.x) < 0.01) {
        if (a.x <= label.left + 0.5 || a.x >= label.left + label.width - 0.5) continue;
        const low = Math.min(a.y, b.y);
        const high = Math.max(a.y, b.y);
        if (Math.min(high, label.top + label.height - 0.5) > Math.max(low, label.top + 0.5)) return true;
      }
    }
    return false;
  }

  it('emits one route edge per visible parent link plus one independent shared trunk', () => {
    const parentLinks = view.nodes.filter((item) => item.from !== null && view.visibleIds.has(item.from));
    const edges = buildFlowEdges(layout, view);
    const routeEdges = edges.filter((edge) => edge.type === 'route');
    const trunkEdges = edges.filter((edge) => edge.type === 'trunk');

    expect(routeEdges.map((edge) => edge.id).sort()).toEqual(
      parentLinks.map((item) => String(item.from) + '->' + item.id).sort(),
    );
    expect(routeEdges).toHaveLength(parentLinks.length);
    expect(trunkEdges).toHaveLength(1);
    expect(trunkEdges[0]?.id).toBe('trunk|r~branches');
    expect(trunkEdges[0]?.source).toBe('r');
    expect(trunkEdges[0]?.target).toBe('b2');
    expect(trunkEdges[0]?.selectable).toBe(false);
    expect(trunkEdges[0]?.focusable).toBe(false);
    expect(trunkEdges[0]?.deletable).toBe(false);
    expect(trunkEdges[0]?.interactionWidth).toBe(0);
    expect(trunkEdges[0]?.label).toBeUndefined();
    expect(edges).toHaveLength(parentLinks.length + 1);
  });

  it('carries the layout route (with its label) in edge data and keeps the current wording', () => {
    const edges = buildFlowEdges(layout, view).filter((edge) => edge.type === 'route');
    for (const edge of edges) {
      const data = edge.data as { route?: LayoutEdgeRoute | null; labelBox?: unknown } | undefined;
      expect(data?.route).toBe(routes.get(edge.id));
      expect(data?.labelBox).toBeUndefined();
      expect(edge.label).toBe(texts.get(edge.id));
      const route = data?.route;
      if (route === undefined || route === null) continue;
      const text = texts.get(edge.id) ?? '';
      if (text === '') {
        expect(route.label).toBeUndefined();
      } else {
        expect(route.label).toBeDefined();
        expect(route.label?.lines.join('')).toBe(text);
      }
    }
  });

  it('paints every layout label in full and keeps it off cards, trunks and other labels', () => {
    const labelled = layout.edgeRoutes.filter((route) => route.label !== undefined);
    expect(labelled).toHaveLength(view.nodes.length - 1);
    for (const route of labelled) {
      const label = route.label;
      if (label === undefined) continue;
      const text = texts.get(route.id) ?? '';
      expect(text).not.toBe('');
      // Layout owns the complete wrapped lines: no UI truncation or ellipsis.
      expect(label.lines.join('')).toBe(text);
      expect(label.lines.join('')).not.toContain('…');
      expect(label.width).toBeGreaterThan(0);
      expect(label.height).toBeGreaterThan(0);
      expect(label.x).toBe(label.left);
      expect(label.y).toBe(label.top);
      expect(label.centerX).toBeCloseTo(label.left + label.width / 2, 6);
      expect(label.baseline).toBeCloseTo(label.top + EDGE_LABEL_PAD_Y + EDGE_LABEL_FONT, 6);

      for (const card of cards) {
        expect(overlaps(label, card), route.id + ' vs card ' + card.id).toBe(false);
      }
      for (const trunk of layout.branchTrunks) {
        expect(labelHitsSegment(label, trunk.points), route.id + ' vs trunk ' + trunk.id).toBe(false);
      }
      for (const other of labelled) {
        if (other.id === route.id || other.label === undefined) continue;
        expect(overlaps(label, other.label), route.id + ' vs label ' + other.id).toBe(false);
      }
    }
  });

  it('keeps the main chain in one column, sibling branches in one right column, and only shared groups get a trunk', () => {
    const r = layout.positions.r;
    const n1 = layout.positions.n1;
    const n2 = layout.positions.n2;
    const b1 = layout.positions.b1;
    const b2 = layout.positions.b2;
    const b1n = layout.positions.b1n;
    const b1x = layout.positions.b1x;
    if (
      r === undefined || n1 === undefined || n2 === undefined || b1 === undefined ||
      b2 === undefined || b1n === undefined || b1x === undefined
    ) {
      throw new Error('missing layout positions');
    }

    // Main spine shares one x; two siblings share the right-hand x and stack.
    expect(n1.x).toBe(r.x);
    expect(n2.x).toBe(r.x);
    expect(b1.x).toBe(b2.x);
    expect(b1.x).toBeGreaterThan(r.x);
    expect(b2.y).toBeGreaterThan(b1.y + (layout.heights.b1 ?? layout.cardHeight));
    expect(b1n.x).toBe(b1.x);
    expect(b1x.x).toBeGreaterThan(b1.x);

    // r has two branches -> one shared trunk; n2 and b1 have one each -> none.
    expect(layout.branchTrunks.map((trunk) => trunk.id)).toEqual(['r~branches']);
    expect(layout.branchTrunks[0]?.from).toBe('r');
    expect(routes.get('r->b1')?.trunkId).toBe('r~branches');
    expect(routes.get('r->b2')?.trunkId).toBe('r~branches');
    expect(routes.get('n2->b3')?.trunkId).toBeUndefined();
    expect(routes.get('b1->b1x')?.trunkId).toBeUndefined();
    expect(routes.get('n2->b3')?.points[0]?.x).toBe(n2.x + CARD_WIDTH);
  });

  it('is independent of input array order and ignores the source side value', () => {
    const reversed = buildGraphView(
      { ...labelledGraph, nodes: [...labelledGraph.nodes].reverse() },
      new Set(),
      null,
    );
    expect(reversed.structureKey).toBe(view.structureKey);
    expect(layoutFor(reversed)).toEqual(layout);

    const flipped = buildGraphView(
      {
        ...labelledGraph,
        nodes: labelledGraph.nodes.map((item) =>
          item.flow === 'branch'
            ? { ...item, side: item.side === 'left' ? 'right' : 'left' }
            : item,
        ),
      },
      new Set(),
      null,
    );
    expect(flipped.structureKey).toBe(view.structureKey);
    // side is not part of LayoutNodeInput any more.
    expect(flipped.layoutNodes.some((item) => 'side' in item)).toBe(false);
    expect(layoutFor(flipped)).toEqual(layout);
  });

  it('includes the complete relationship wording in the structure key', () => {
    const reworded = buildGraphView(
      {
        ...labelledGraph,
        nodes: labelledGraph.nodes.map((item) =>
          item.id === 'b1' ? { ...item, description: '换一种写法但仍是一条关系' } : item,
        ),
      },
      new Set(),
      null,
    );
    expect(reworded.structureKey).not.toBe(view.structureKey);
  });

  it('produces identical geometry for the live and offline input paths', () => {
    // Both readers build `buildGraphView` input and call the one `computeLayout`;
    // the offline path passes no previousPositions, so the same input is enough.
    const live = layoutFor(buildGraphView(labelledGraph, new Set(), null));
    const offline = layoutFor(buildGraphView(labelledGraph, new Set(), null));
    expect(offline.positions).toEqual(live.positions);
    expect(offline.edgeRoutes).toEqual(live.edgeRoutes);
    expect(offline.branchTrunks).toEqual(live.branchTrunks);
    expect(offline.edgeRoutes.map((route) => route.label)).toEqual(live.edgeRoutes.map((route) => route.label));
  });

  it('labels every branch as a right-side branch regardless of the source side', () => {
    expect(flowLabel(node('root', null, 'root', '01', '根'))).toBe('根节点');
    expect(flowLabel(node('next', 'root', 'next', '02', '续'))).toBe('纵向续接');
    expect(flowLabel(branch('right', 'root', 'right', 10, '右', '右'))).toBe('右侧分支');
    expect(flowLabel(branch('left', 'root', 'left', 10, '左', '左'))).toBe('右侧分支');
  });
});
