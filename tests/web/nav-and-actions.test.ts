import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode, GraphResponse } from '../../src/next/protocol.js';
import {
  emptyReadingState,
  navCollapsedNodeIds,
  switchReadingTopic,
  toggleNavNode,
} from '../../src/web/data/readingState.js';
import { visibleTreeNodes } from '../../src/web/components/directoryTree.js';
import { buildGraphView } from '../../src/web/graph/viewModel.js';
import { writeImportance } from '../../src/web/lib/importance.js';

function node(id: string, from: string | null, flow: 'root' | 'next' | 'branch', number: string, title: string, topicId = 't_1'): GraphNode {
  return {
    id, topicId, title, summary: title + ' 摘要', number, from, flow, state: 'agreed', important: false, revision: 1,
    ...(flow === 'branch' ? { side: 'right' as const, order: 10 } : {}),
  };
}

const graph: GraphResponse = {
  instanceId: 'inst-a',
  revision: 3,
  workspaceId: 'w_1',
  activeNode: null,
  stale: false,
  diagnostics: [],
  nodes: [
    node('n05', null, 'root', '05', '根'),
    node('n06', 'n05', 'next', '06', '排版约定'),
    node('n07', 'n06', 'next', '07', '参考外部规范'),
    node('n0601', 'n06', 'branch', '06-01', '标题与标注的分工'),
  ],
  topics: [
    { id: 't_1', key: '协作方式', title: '协作方式', nodeIds: ['n05', 'n06', 'n07', 'n0601'], revision: 2 },
  ],
};

/** Wiring checks that need both the reader state and the canvas view together. */

describe('directory fold versus graph fold', () => {
  it('hides directory rows while the canvas still draws every card', () => {
    const state = toggleNavNode(switchReadingTopic(emptyReadingState(), 't_1'), 't_1', 'n06');
    const topicNodes = graph.nodes.filter((item) => item.topicId === 't_1');

    const rows = visibleTreeNodes(topicNodes, new Set(navCollapsedNodeIds(state.navTree, 't_1')));
    // The directory folder of 06 hides its branch 06-01, not the mainline 07.
    expect(rows.map((row) => row.id)).toEqual(['n05', 'n06', 'n07']);

    const view = buildGraphView(graph, new Set(state.collapsedNodeIds), 't_1');
    expect(state.collapsedNodeIds).toEqual([]);
    expect(view.visibleIds.has('n07')).toBe(true);
    expect(view.visibleIds.has('n0601')).toBe(true);
  });
});

describe('importance write', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts the documented body and returns the snapshot node', async () => {
    const updated = { ...node('n06', 'n05', 'next', '06', '排版约定'), important: true };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, instanceId: 'inst-a', revision: 9, node: updated }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await writeImportance(
      { topicId: 't_1', nodeId: 'n06', important: true, revision: 3 },
      new AbortController().signal,
    );
    expect(result.node.important).toBe(true);
    expect(result.revision).toBe(9);

    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/importance');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-aichat-client']).toBe('cli');
    expect(JSON.parse(String(init.body))).toEqual({ topicId: 't_1', nodeId: 'n06', important: true, revision: 3 });
  });

  it('omits a hash it never saw and refuses an empty answer', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, instanceId: 'i', revision: 2, node: node('n06', 'n05', 'next', '06', 'x') }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    await writeImportance({ topicId: 't_1', nodeId: 'n06', important: false }, new AbortController().signal);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ topicId: 't_1', nodeId: 'n06', important: false });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    await expect(writeImportance({ topicId: 't_1', nodeId: 'n06', important: false }, new AbortController().signal))
      .rejects.toThrow('服务没有返回更新后的卡片');
  });
});
