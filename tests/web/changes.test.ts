import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeBatchDetail, GraphResponse } from '../../src/next/protocol.js';
import {
  changeCountsLabel,
  changeFieldLabel,
  changeKindLabel,
  changeSummaryFromDetail,
  formatChangeValue,
  graphHasNode,
  nodeChangeFromDetail,
} from '../../src/web/lib/changes.js';
import { fetchNodeChange, fetchTopicChange } from '../../src/web/data/changes.js';

const SIGNAL = new AbortController().signal;

function respondWith(body: string, status = 200) {
  const fetchMock = vi.fn(async () => new Response(
    body,
    { status, headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function detailFixture(): ChangeBatchDetail {
  return {
    requestId: 'req-1',
    topicId: 't_1',
    at: '2026-01-01T00:00:00Z',
    counts: { added: 1, modified: 1, deleted: 1 },
    nodes: [
      {
        nodeId: 'n_new',
        kind: 'added',
        title: '新增卡片',
        fields: [],
        beforeRevision: null,
        afterRevision: 1,
        fieldDiffs: [],
      },
      {
        nodeId: 'n_edit',
        kind: 'modified',
        title: '改过的卡片',
        fields: ['title', 'summary'],
        beforeRevision: 2,
        afterRevision: 3,
        fieldDiffs: [
          { field: 'title', before: '旧标题', after: '新标题' },
          { field: 'summary', before: null, after: '新摘要' },
        ],
        body: {
          patch: '@@ -1,2 +1,2 @@\n-旧正文\n+新正文\n 上下文',
          addedLines: 1,
          removedLines: 1,
          truncated: false,
        },
      },
      {
        nodeId: 'n_gone',
        kind: 'deleted',
        title: '删掉的卡片',
        fields: [],
        beforeRevision: 4,
        afterRevision: null,
        fieldDiffs: [],
      },
    ],
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('change display helpers', () => {
  it('labels kinds, fields and before/after values', () => {
    expect(changeKindLabel('added')).toBe('新增');
    expect(changeKindLabel('modified')).toBe('改动');
    expect(changeKindLabel('deleted')).toBe('删除');
    expect(changeFieldLabel('title')).toBe('标题');
    expect(changeFieldLabel('description')).toBe('入边说明');
    expect(formatChangeValue(null)).toBe('（空）');
    expect(formatChangeValue('正文')).toBe('正文');
    expect(formatChangeValue(3)).toBe('3');
  });

  it('summarizes a detail batch the same way the live graph does, deletions included', () => {
    const summary = changeSummaryFromDetail(detailFixture());
    expect(summary?.requestId).toBe('req-1');
    expect(summary?.topicId).toBe('t_1');
    expect(summary?.counts).toEqual({ added: 1, modified: 1, deleted: 1 });
    expect(summary?.nodes.map((node) => [node.nodeId, node.kind, node.fields])).toEqual([
      ['n_new', 'added', []],
      ['n_edit', 'modified', ['title', 'summary']],
      ['n_gone', 'deleted', []],
    ]);
    expect(changeCountsLabel(summary!.counts)).toBe('新增 1 · 改动 1 · 删除 1');
  });

  it('reads one frozen node diff and never invents one', () => {
    const detail = detailFixture();
    expect(nodeChangeFromDetail(detail, 'n_edit')?.fieldDiffs).toHaveLength(2);
    expect(nodeChangeFromDetail(detail, 'n_edit')?.body?.patch).toContain('+新正文');
    // A deleted node has no card but still has a readable diff for the topic list.
    expect(nodeChangeFromDetail(detail, 'n_gone')?.kind).toBe('deleted');
    expect(nodeChangeFromDetail(detail, 'n_gone')?.afterRevision).toBeNull();
    expect(nodeChangeFromDetail(detail, 'n_missing')).toBeNull();
    expect(nodeChangeFromDetail(null, 'n_edit')).toBeNull();
    expect(changeSummaryFromDetail(null)).toBeNull();
  });

  it('knows which change rows still have a card to select', () => {
    const graph = { nodes: [{ id: 'n_edit' }, { id: 'n_new' }] } as unknown as Pick<GraphResponse, 'nodes'>;
    expect(graphHasNode(graph, 'n_edit')).toBe(true);
    expect(graphHasNode(graph, 'n_new')).toBe(true);
    expect(graphHasNode(graph, 'n_gone')).toBe(false);
    expect(graphHasNode(graph, null)).toBe(false);
    expect(graphHasNode(null, 'n_edit')).toBe(false);
  });
});

describe('change transport', () => {
  it('reads the latest topic batch from /api/changes', async () => {
    const fetchMock = respondWith(JSON.stringify({
      instanceId: 'i',
      revision: 5,
      batch: {
        requestId: 'req-1',
        topicId: 't_1',
        at: 'a',
        counts: { added: 0, modified: 1, deleted: 0 },
        nodes: [{ nodeId: 'n1', kind: 'modified', title: '卡片', fields: ['title'] }],
      },
    }));
    const batch = await fetchTopicChange('t_1', SIGNAL);
    expect(batch?.requestId).toBe('req-1');
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/changes?topicId=t_1');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('reads one node diff from /api/changes/nodes/:nodeId with the topic query', async () => {
    const fetchMock = respondWith(JSON.stringify({
      instanceId: 'i',
      revision: 5,
      batchRequestId: 'req-1',
      change: detailFixture().nodes[1],
    }));
    const change = await fetchNodeChange('t_1', 'n_edit', SIGNAL);
    expect(change?.nodeId).toBe('n_edit');
    expect(change?.fieldDiffs[0]?.after).toBe('新标题');
    const [path] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/changes/nodes/n_edit?topicId=t_1');
  });

  it('treats CHANGE_NOT_FOUND as an empty answer, other errors as errors', async () => {
    respondWith(JSON.stringify({ error: { code: 'CHANGE_NOT_FOUND', message: '没有批次' } }), 404);
    await expect(fetchTopicChange('t_1', SIGNAL)).resolves.toBeNull();
    await expect(fetchNodeChange('t_1', 'n1', SIGNAL)).resolves.toBeNull();

    respondWith(JSON.stringify({ error: { code: 'DATABASE_ERROR', message: '读取失败' } }), 500);
    await expect(fetchTopicChange('t_1', SIGNAL)).rejects.toMatchObject({
      status: 500,
      code: 'DATABASE_ERROR',
      message: '读取失败',
    });
  });
});
