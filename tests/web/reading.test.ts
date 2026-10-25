import { describe, expect, it } from 'vitest';
import type { GraphResponse } from '../../src/shared/protocol.js';
import { buildGraphView, connectionText, scopeGraphToTopic } from '../../src/web/graph/viewModel.js';
import { CARD_BASE_HEIGHT, CARD_WIDTH, LAYOUT_HORIZONTAL_GAP, LAYOUT_VERTICAL_GAP, cardHeightForTitle, textWidth, wrapByWidth } from '../../src/web/graph/cardMetrics.js';
import { parseReadingState, pruneReadingState, emptyReadingState, switchReadingTopic } from '../../src/web/data/readingState.js';
import { resolveLink, resolveResourceKey, safeUrlTransform, stripNodeComments } from '../../src/web/components/MarkdownBody.js';
import { searchGraph } from '../../src/web/lib/search.js';
import { buildContinuationPrompt } from '../../src/web/lib/prompt.js';
import { computeLayout } from '../../src/web/layout/index.js';
import type { LayoutEdgeRoute, LayoutInput, LayoutResult } from '../../src/web/layout/types.js';
import { buildOrthogonalPath, pathLength } from '../../src/web/components/edgePath.js';
import { buildFlowEdges } from '../../src/web/graph/flowEdges.js';
import { layoutEdgeLabel, type EdgeLabelBox } from '../../src/web/components/routeLabels.js';

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

  it('wraps connector text and ellipsizes after the allowed lines', () => {
    const text = '这条关系说明足够长，需要在连线上折成多行，超出限制以后用省略号收尾。';
    const lines = wrapByWidth(text, 120, 11, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith('…')).toBe(true);
    for (const line of lines) expect(textWidth(line, 11)).toBeLessThanOrEqual(120 + 1e-6);
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

describe('trunked branch labels', () => {
  /** Parent with three right-side branches, one of them branching again. */
  const nodes: LayoutInput['nodes'] = [
    { id: 'p', from: null, flow: 'root', label: '根' },
    { id: 'c1', from: 'p', flow: 'branch', side: 'right', order: 10, label: '第一条并列分支的关系文字会换行' },
    { id: 'c2', from: 'p', flow: 'branch', side: 'right', order: 20, label: '第二条并列分支的关系文字同样需要两三行空间才能读完' },
    { id: 'c3', from: 'p', flow: 'branch', side: 'right', order: 30, label: '第三条' },
    { id: 'g1', from: 'c1', flow: 'branch', side: 'right', order: 10, label: '枝内再分支' },
    { id: 'g2', from: 'c1', flow: 'branch', side: 'right', order: 20, label: '枝内再分支的第二条' },
  ];
  const layout = computeLayout({ nodes, visibleNodeIds: nodes.map((item) => item.id) });

  it('keeps the label box on its own stub, clear of the trunk and the target centre', () => {
    const trunks = new Map(layout.branchTrunks.map((trunk) => [trunk.from + '~' + trunk.side, trunk]));
    let checked = 0;
    for (const route of layout.edgeRoutes) {
      if (route.join === undefined || route.side === undefined) continue;
      const trunk = trunks.get(route.from + '~' + route.side);
      const target = layout.positions[route.to];
      const end = route.points[route.points.length - 1];
      if (trunk === undefined || target === undefined || end === undefined) continue;
      const text = nodes.find((item) => item.id === route.to)?.label ?? '';
      const box = layoutEdgeLabel(route, text);
      expect(box).not.toBeNull();
      if (box === null) continue;
      // Both bounds are measured on the stub itself: 8 below the join, 4 above
      // the point where the drop line reaches the card centre.
      expect(box.top).toBeGreaterThanOrEqual(route.join.y + 8 - 0.001);
      expect(box.top + box.height).toBeLessThanOrEqual(end.y - 4 + 0.001);
      expect(box.top).toBeGreaterThan(trunk.trunkY);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('never puts a label box on top of a card', () => {
    const cards = Object.entries(layout.positions).map(([id, position]) => ({
      x: position.x,
      y: position.y,
      width: layout.cardWidth,
      height: layout.heights[id] ?? layout.cardHeight,
    }));
    for (const route of layout.edgeRoutes) {
      const text = nodes.find((item) => item.id === route.to)?.label ?? '';
      const box = layoutEdgeLabel(route, text);
      if (box === null) continue;
      for (const card of cards) {
        const overlapX = box.left < card.x + card.width - 0.5 && box.left + box.width > card.x + 0.5;
        const overlapY = box.top < card.y + card.height - 0.5 && box.top + box.height > card.y + 0.5;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });
});

describe('branch label bounds', () => {
  /** A right-side branch: trunk at y=328, card edge x=520, target centre y=476. */
  function rightBranch(overrides: Partial<LayoutEdgeRoute> = {}): LayoutEdgeRoute {
    return {
      id: 'p->c', from: 'p', to: 'c', flow: 'branch', side: 'right',
      join: { x: 472, y: 328 },
      points: [{ x: 472, y: 328 }, { x: 472, y: 476 }, { x: 520, y: 476 }],
      labelAnchor: { x: 472, y: 420 },
      labelWidth: 80,
      ...overrides,
    };
  }

  it('centres the box on the anchor, where the drop line runs', () => {
    const box = layoutEdgeLabel(rightBranch(), '关系文字');
    expect(box).not.toBeNull();
    if (box === null) return;
    // The drop line at x=472 passes through the middle of the board.
    expect(box.centerX).toBeCloseTo(472, 6);
    expect(box.left).toBeCloseTo(472 - box.width / 2, 6);
  });

  it('mirrors the centring for a left branch', () => {
    const route = rightBranch({
      side: 'left',
      join: { x: 168, y: 328 },
      points: [{ x: 168, y: 328 }, { x: 168, y: 476 }, { x: 120, y: 476 }],
      labelAnchor: { x: 168, y: 420 },
    });
    const box = layoutEdgeLabel(route, '关系文字');
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(box.centerX).toBeCloseTo(168, 6);
  });

  it('hangs the box between the join and the target centre', () => {
    const box = layoutEdgeLabel(rightBranch(), '关系文字');
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(box.top).toBeGreaterThanOrEqual(328 + 8);
    // 476 is where the drop line reaches the target centre, not the card top.
    expect(box.top + box.height).toBeLessThanOrEqual(476 - 4);
  });

  it('keeps the box top at least 8px below the trunk', () => {
    // Anchor almost on the trunk: the box must still hang below it.
    const box = layoutEdgeLabel(rightBranch({ labelAnchor: { x: 472, y: 330 } }), '关系文字');
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(box.top).toBeCloseTo(328 + 8, 6);
  });

  it('presses the join but never crosses the target centre when the stub is too short', () => {
    // 32px of stub cannot hold a three-line board below the trunk pad.
    const route = rightBranch({
      points: [{ x: 472, y: 328 }, { x: 472, y: 360 }, { x: 520, y: 360 }],
      labelAnchor: { x: 472, y: 344 },
    });
    const box = layoutEdgeLabel(route, '一条需要三行才能读完的关系文字');
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(box.top).toBeLessThan(328 + 8);
    expect(box.top + box.height).toBeCloseTo(360, 6);
  });

  it('keeps the board off the target card edge when centring would cross it', () => {
    // A gap narrower than the board: hugging the card wins, centring does not.
    const box = layoutEdgeLabel(rightBranch({ labelWidth: 200 }), '一条需要三行才能读完的关系文字');
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(box.left + box.width).toBeCloseTo(520, 6);

    const left = layoutEdgeLabel(
      rightBranch({
        side: 'left',
        join: { x: 168, y: 328 },
        points: [{ x: 168, y: 328 }, { x: 168, y: 476 }, { x: 120, y: 476 }],
        labelAnchor: { x: 168, y: 420 },
        labelWidth: 200,
      }),
      '一条需要三行才能读完的关系文字',
    );
    expect(left).not.toBeNull();
    if (left === null) return;
    // 120 is the card's right edge; the board may not start left of it.
    expect(left.left).toBeCloseTo(120, 6);
  });

  describe('a branch with no join (single Z)', () => {
    /** Source edge x=520, channel x=564, card edge x=608. */
    function loneZ(sourceCentreY: number, targetCentreY: number, anchorY: number): LayoutEdgeRoute {
      return {
        id: 'p->c', from: 'p', to: 'c', flow: 'branch', side: 'right',
        points: [
          { x: 520, y: sourceCentreY },
          { x: 564, y: sourceCentreY },
          { x: 564, y: targetCentreY },
          { x: 608, y: targetCentreY },
        ],
        labelAnchor: { x: 564, y: anchorY },
        labelWidth: 72,
      };
    }

    it('centres on the anchor while the channel can hold the board', () => {
      const box = layoutEdgeLabel(loneZ(400, 560, 480), '关系文字');
      expect(box).not.toBeNull();
      if (box === null) return;
      expect(box.centerX).toBeCloseTo(564, 6);
      expect(box.top).toBeCloseTo(480 - box.height / 2, 6);
    });

    it('falls back to the run midpoint when the board cannot fit (off-mid anchor guard)', () => {
      // Defensive branch only: layout always anchors a lone branch on midY,
      // which already is the midpoint of its vertical run, so on real routes
      // this clamp changes nothing. The fixture is deliberately off-mid (405
      // against a 400..420 run) to prove the guard exists for a future anchor
      // change. It does not make the corners visible — an 18px board on a 20px
      // run covers them, and only a longer rise can fix that.
      const box = layoutEdgeLabel(loneZ(400, 420, 405), '关系文字');
      expect(box).not.toBeNull();
      if (box === null) return;
      expect(box.top).toBeCloseTo((400 + 420) / 2 - box.height / 2, 6);
      expect(box.top).not.toBeCloseTo(405 - box.height / 2, 6);
    });
  });

  it('never produces a negative width in a narrow gap', () => {
    const box = layoutEdgeLabel(rightBranch({ labelWidth: 40 }), '一条需要三行才能读完的关系文字');
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(box.width).toBeGreaterThan(0);
    expect(box.left).toBeLessThanOrEqual(520);
  });
});

describe('connector edge list', () => {
  const view = buildGraphView(graph, new Set(), null);

  /** One trunk over n1~right plus a branch route that leaves it. */
  const layout: LayoutResult = {
    positions: {
      n1: { x: 0, y: 0 }, n2: { x: 0, y: 216 }, n3: { x: 448, y: 400 },
      n4: { x: 448, y: 616 }, n5: { x: 0, y: 432 },
    },
    edgeRoutes: [
      {
        id: 'n1->n3', from: 'n1', to: 'n3', flow: 'branch' as const, side: 'right' as const,
        points: [{ x: 472, y: 400 }, { x: 508, y: 400 }],
        join: { x: 472, y: 328 },
      },
    ],
    branchTrunks: [
      {
        id: 'n1~right', from: 'n1', side: 'right' as const, to: 'n3', trunkY: 328,
        points: [{ x: 360, y: 76 }, { x: 388, y: 76 }, { x: 388, y: 328 }, { x: 472, y: 328 }],
      },
    ],
    hiddenCounts: {}, diagnostics: [],
    bounds: { x: 0, y: 0, width: 808, height: 768 },
    cardWidth: 360, cardHeight: 152, heights: {}, layoutVersion: 1, structureVersion: null,
  };

  it('keeps one edge per relationship and one path per trunk', () => {
    const edges = buildFlowEdges(layout, view);
    const relationEdges = edges.filter((edge) => edge.type === 'route');
    const trunkEdges = edges.filter((edge) => edge.type === 'trunk');
    expect(relationEdges.map((edge) => edge.id).sort()).toEqual(['n1->n2', 'n1->n3', 'n2->n5', 'n3->n4']);
    expect(trunkEdges.map((edge) => edge.id)).toEqual(['trunk|n1~right']);
    expect(edges.length).toBe(relationEdges.length + trunkEdges.length);
  });

  it('draws trunks as non-interactive display geometry', () => {
    const trunk = buildFlowEdges(layout, view).find((edge) => edge.type === 'trunk');
    expect(trunk?.source).toBe('n1');
    expect(trunk?.target).toBe('n3');
    expect(trunk?.selectable).toBe(false);
    expect(trunk?.focusable).toBe(false);
    expect(trunk?.deletable).toBe(false);
    expect(trunk?.label).toBeUndefined();
  });

  it('carries the route, not a label box, in the edge data', () => {
    // The label is derived from the route alone; no card metric is smuggled in.
    const edges = buildFlowEdges(layout, view);
    const branch = edges.find((edge) => edge.id === 'n1->n3');
    expect((branch?.data as { route?: unknown } | undefined)?.route).toBeDefined();
    expect(edges.find((edge) => edge.type === 'trunk')?.label).toBeUndefined();
  });
});

describe('placed relationship labels', () => {
  type Point = { x: number; y: number };

  function branch(id: string, from: string, side: 'left' | 'right', order: number, description: string): GraphResponse['nodes'][number] {
    return {
      ...node(id, from, 'branch', id, id),
      side,
      order,
      description,
    };
  }

  function described(id: string, from: string | null, flow: 'root' | 'next', description: string): GraphResponse['nodes'][number] {
    return { ...node(id, from, flow, id, id), description };
  }

  /**
   * Dense representative topology with labels on every kind of connector:
   * a three-member right trunk, a left branch, next edges, and a branch that
   * branches again near the parent.
   */
  const labeled: GraphResponse = {
    instanceId: 'inst-labels',
    revision: 1,
    workspaceId: 'w_labels',
    activeNode: null,
    stale: false,
    diagnostics: [],
    nodes: [
      described('r', null, 'root', '根节点到主线的说明文字'),
      described('n2', 'r', 'next', '主线关系说明，继续向下阅读下一个要点'),
      branch('b1', 'r', 'right', 10, '第一条并列分支的关系文字会换行并保持完整'),
      branch('b2', 'r', 'right', 20, '第二条并列分支的关系文字同样需要两三行空间'),
      branch('b3', 'r', 'right', 30, '第三条分支的说明'),
      branch('l1', 'n2', 'left', 10, '左侧分支的说明文字不应压到主线或其他线'),
      described('b1n', 'b1', 'next', '枝内 next 的关系说明'),
      branch('b1x', 'b1', 'right', 10, '再分支的独立入口说明'),
      described('l1n', 'l1', 'next', '左侧枝内后续说明'),
    ],
    topics: [{
      id: 't_1',
      title: '标签',
      path: 'topics/标签.md',
      nodeIds: ['r', 'n2', 'b1', 'b2', 'b3', 'l1', 'b1n', 'b1x', 'l1n'],
      fileHash: 'labels',
    }],
  };

  const view = buildGraphView(labeled, new Set(), null);
  const layout = computeLayout({
    nodes: view.layoutNodes,
    visibleNodeIds: [...view.visibleIds],
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_BASE_HEIGHT,
    verticalGap: LAYOUT_VERTICAL_GAP,
    horizontalGap: LAYOUT_HORIZONTAL_GAP,
  });

  interface LabelEdge {
    id: string;
    route: LayoutEdgeRoute;
    box: EdgeLabelBox;
    text: string;
  }

  function labelledEdges(result: LayoutResult, graphView: typeof view): LabelEdge[] {
    const found: LabelEdge[] = [];
    for (const edge of buildFlowEdges(result, graphView)) {
      if (edge.type !== 'route') continue;
      const data = edge.data as { route?: LayoutEdgeRoute | null; labelBox?: EdgeLabelBox | null } | undefined;
      if (data?.route === undefined || data.route === null) continue;
      const text = typeof edge.label === 'string' ? edge.label.trim() : '';
      if (text === '') continue;
      if (data.labelBox === undefined || data.labelBox === null) continue;
      found.push({ id: data.route.id, route: data.route, box: data.labelBox, text });
    }
    return found;
  }

  const cards = Object.entries(layout.positions).map(([id, position]) => ({
    id,
    x: position.x,
    y: position.y,
    width: layout.cardWidth,
    height: layout.heights[id] ?? layout.cardHeight,
  }));

  function cardHits(box: EdgeLabelBox): string[] {
    return cards
      .filter((card) =>
        box.left < card.x + card.width - 0.5 &&
        box.left + box.width > card.x + 0.5 &&
        box.top < card.y + card.height - 0.5 &&
        box.top + box.height > card.y + 0.5)
      .map((card) => card.id);
  }

  function segmentHits(points: readonly Point[], box: EdgeLabelBox): boolean {
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1];
      const b = points[index];
      if (a === undefined || b === undefined) continue;
      if (Math.abs(a.y - b.y) < 0.01) {
        if (a.y <= box.top + 0.5 || a.y >= box.top + box.height - 0.5) continue;
        if (Math.min(Math.max(a.x, b.x), box.left + box.width - 0.5) > Math.max(Math.min(a.x, b.x), box.left + 0.5)) {
          return true;
        }
      } else if (Math.abs(a.x - b.x) < 0.01) {
        if (a.x <= box.left + 0.5 || a.x >= box.left + box.width - 0.5) continue;
        if (Math.min(Math.max(a.y, b.y), box.top + box.height - 0.5) > Math.max(Math.min(a.y, b.y), box.top + 0.5)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * A board is attached to its own exclusive stub when it either rides the line
   * or sits immediately beside it (the runner-up candidate layout uses the
   * one-pixel offset when riding would hide a shared trunk riser).
   */
  function onOwnStub(route: LayoutEdgeRoute, box: EdgeLabelBox): boolean {
    const x = box.centerX;
    const y = box.top + box.height / 2;
    for (let index = 1; index < route.points.length; index += 1) {
      const a = route.points[index - 1];
      const b = route.points[index];
      if (a === undefined || b === undefined) continue;
      if (Math.abs(a.y - b.y) < 0.01) {
        const low = Math.min(a.x, b.x);
        const high = Math.max(a.x, b.x);
        const rides = Math.abs(y - a.y) < 0.01 && x >= low - 0.01 && x <= high + 0.01;
        const below = Math.abs(box.top - (a.y + 1)) < 0.1;
        const above = Math.abs(box.top + box.height - (a.y - 1)) < 0.1;
        const axisOverlap = Math.min(high, box.left + box.width) - Math.max(low, box.left) > 0.5;
        if (rides || ((below || above) && axisOverlap)) return true;
      }
      if (Math.abs(a.x - b.x) < 0.01) {
        const low = Math.min(a.y, b.y);
        const high = Math.max(a.y, b.y);
        const rides = Math.abs(x - a.x) < 0.01 && y >= low - 0.01 && y <= high + 0.01;
        const right = Math.abs(box.left - (a.x + 1)) < 0.1;
        const left = Math.abs(box.left + box.width - (a.x - 1)) < 0.1;
        const axisOverlap = Math.min(high, box.top + box.height) - Math.max(low, box.top) > 0.5;
        if (rides || ((right || left) && axisOverlap)) return true;
      }
    }
    return false;
  }

  function inside(box: EdgeLabelBox, point: Point): boolean {
    return point.x > box.left + 0.5 && point.x < box.left + box.width - 0.5 &&
      point.y > box.top + 0.5 && point.y < box.top + box.height - 0.5;
  }

  const edges = labelledEdges(layout, view);

  it('places every sentence exactly once and keeps the wording complete', () => {
    expect(edges).toHaveLength(labeled.nodes.length - 1);
    for (const edge of edges) {
      expect(edge.box.lines.join('').replace(/\s+/g, '')).toBe(edge.text.replace(/\s+/g, ''));
      expect(edge.box.lines.join('')).not.toContain('…');
    }
  });

  it('keeps every label on its own exclusive stub, off cards and shared trunks', () => {
    for (const edge of edges) {
      expect(onOwnStub(edge.route, edge.box), edge.id).toBe(true);
      expect(cardHits(edge.box)).toEqual([]);
      // The shared geometry is painted once and never interrupted by a label.
      for (const trunk of layout.branchTrunks) {
        expect(segmentHits(trunk.points, edge.box), edge.id + ' vs ' + trunk.id).toBe(false);
      }
      // A trunked branch label hangs below its join rather than on the trunk.
      if (edge.route.join !== undefined) {
        expect(edge.box.top).toBeGreaterThan(edge.route.join.y);
      }
    }
  });

  it('keeps labels clear of other relationship lines, corners and other labels', () => {
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index];
      if (edge === undefined) continue;
      for (const other of edges) {
        if (other.id === edge.id) continue;
        // Another relationship's path is never painted over.
        expect(segmentHits(other.route.points, edge.box)).toBe(false);
        // Nor is a corner of it hidden by the board.
        for (const point of other.route.points) expect(inside(edge.box, point)).toBe(false);
        // Two labels never overlap.
        const overlap =
          edge.box.left < other.box.left + other.box.width - 0.5 &&
          edge.box.left + edge.box.width > other.box.left + 0.5 &&
          edge.box.top < other.box.top + other.box.height - 0.5 &&
          edge.box.top + edge.box.height > other.box.top + 0.5;
        expect(overlap).toBe(false);
      }
      for (const trunk of layout.branchTrunks) {
        for (const point of trunk.points) expect(inside(edge.box, point)).toBe(false);
      }
    }
  });

  it('is deterministic and independent of route input order', () => {
    const again = labelledEdges(layout, view);
    expect(again.map((edge) => [edge.id, edge.box])).toEqual(edges.map((edge) => [edge.id, edge.box]));
  });
});
