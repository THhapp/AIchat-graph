import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChangeBatchDetail,
  GraphNode,
  GraphResponse,
  GraphTopic,
  OfflineTopicDocument,
  WorkspaceResponse,
} from '../../src/next/protocol.js';
import {
  DETAIL_WIDTH_DEFAULT,
  DETAIL_WIDTH_MAX,
  DETAIL_WIDTH_MIN,
  emptyReadingState,
  parseReadingState,
} from '../../src/web/data/readingState.js';
import {
  hiddenTreeCounts,
  treeChildCounts,
  visibleTreeNodes,
} from '../../src/web/components/directoryTree.js';
import { ApiError, getJson, requestJson } from '../../src/web/data/client.js';
import { deriveOfflineDetails } from '../../src/web/offline/details.js';
import { parseOfflineDocument, toGraphResponse } from '../../src/web/offline/document.js';
import { buildContinuationPrompt } from '../../src/web/lib/prompt.js';

function node(
  id: string,
  from: string | null,
  flow: 'root' | 'next' | 'branch',
  number: string,
  title: string,
): GraphNode {
  return {
    id,
    topicId: 't_1',
    title,
    summary: title + ' 摘要',
    number,
    from,
    flow,
    important: false,
    revision: 1,
    ...(flow === 'branch' ? { side: 'right' as const, order: 10 } : {}),
  };
}

/** 01 -> 02, 02-01 -> 02-02, 02-03; 03 follows on the mainline. */
const tree: GraphNode[] = [
  node('n01', null, 'root', '01', '起点'),
  node('n02', 'n01', 'next', '02', '主线二'),
  node('n0201', 'n02', 'branch', '02-01', '分支甲'),
  node('n0202', 'n0201', 'next', '02-02', '分支甲续'),
  node('n0203', 'n02', 'branch', '02-03', '分支乙'),
  node('n03', 'n02', 'next', '03', '主线三'),
];

const topic: GraphTopic = {
  id: 't_1',
  key: '协作方式',
  title: '协作方式',
  nodeIds: tree.map((item) => item.id),
  revision: 2,
};

const graph: GraphResponse = {
  instanceId: 'inst',
  revision: 7,
  workspaceId: 'w_1',
  activeNode: null,
  stale: false,
  diagnostics: [],
  nodes: tree,
  topics: [topic],
};

const workspace: WorkspaceResponse = {
  ...graph,
  name: '示例库',
  rootPath: 'D:\\vault\\示例',
  agentEntry: { cliPath: 'D:/daily/dist/cli/index.js', skillPath: 'D:/daily/skills/SKILL.md' },
};

function offlineDocument(changes: ChangeBatchDetail | null = null): OfflineTopicDocument {
  const [first] = tree;
  return {
    format: 1,
    workspaceId: graph.workspaceId,
    workspaceName: '示例库',
    instanceId: graph.instanceId,
    revision: graph.revision,
    fingerprint: 'fp',
    generatedAt: '2026-01-01T00:00:00Z',
    topic,
    nodes: [{
      ...first!,
      body: '缺省正文',
    }],
    boundaryNodes: [],
    ...(changes !== null ? { changes } : {}),
    resources: {},
    resourceDiagnostics: [],
  };
}

function offlineChanges(): ChangeBatchDetail {
  return {
    requestId: 'req-offline',
    topicId: 't_1',
    at: '2026-01-01T01:00:00Z',
    counts: { added: 1, modified: 1, deleted: 1 },
    nodes: [
      {
        nodeId: 'n01',
        kind: 'modified',
        title: '起点',
        fields: ['title'],
        beforeRevision: 1,
        afterRevision: 2,
        fieldDiffs: [{ field: 'title', before: '旧起点', after: '起点' }],
        body: {
          patch: '@@ -1 +1 @@\n-旧正文\n+缺省正文',
          addedLines: 1,
          removedLines: 1,
          truncated: false,
        },
      },
      {
        nodeId: 'n_gone',
        kind: 'deleted',
        title: '已删除卡片',
        fields: [],
        beforeRevision: 3,
        afterRevision: null,
        fieldDiffs: [],
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shared detail width', () => {
  it('uses the exported bounds for defaults and saved state', () => {
    expect(DETAIL_WIDTH_DEFAULT).toBe(380);
    expect(DETAIL_WIDTH_MIN).toBe(300);
    expect(DETAIL_WIDTH_MAX).toBe(680);
    expect(emptyReadingState().detailWidth).toBe(DETAIL_WIDTH_DEFAULT);

    const narrow = parseReadingState(JSON.stringify({ detailWidth: 10 }));
    const wide = parseReadingState(JSON.stringify({ detailWidth: 9999 }));
    expect(narrow.detailWidth).toBe(DETAIL_WIDTH_MIN);
    expect(wide.detailWidth).toBe(DETAIL_WIDTH_MAX);
  });
});

describe('directory tree helpers', () => {
  it('derives rows, direct child counts and hidden counts from one projection', () => {
    expect(visibleTreeNodes(tree, new Set()).map((item) => item.id)).toEqual([
      'n01', 'n02', 'n0201', 'n0202', 'n0203', 'n03',
    ]);
    expect(treeChildCounts(tree).get('n02')).toBe(2);
    expect(treeChildCounts(tree).get('n0201')).toBeUndefined();
    expect(hiddenTreeCounts(tree, new Set(['n02'])).get('n02')).toBe(3);
    expect(visibleTreeNodes(tree, new Set(['n02'])).map((item) => item.id)).toEqual([
      'n01', 'n02', 'n03',
    ]);
  });
});

describe('requestJson transport', () => {
  it('returns a parsed body and keeps server error details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    await expect(getJson<{ ok: boolean }>('/api/graph', new AbortController().signal)).resolves.toEqual({ ok: true });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'STALE_SNAPSHOT', message: '旧快照', details: { revision: 2 } } }),
      { status: 412 },
    )));
    await expect(getJson('/api/nodes/n01', new AbortController().signal)).rejects.toMatchObject({
      name: 'ApiError',
      status: 412,
      code: 'STALE_SNAPSHOT',
      message: '旧快照',
      details: { revision: 2 },
    } satisfies Partial<ApiError>);
  });

  it('distinguishes malformed and empty successful bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    await expect(getJson('/api/graph', new AbortController().signal)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    await expect(getJson('/api/graph', new AbortController().signal)).rejects.toMatchObject({
      code: 'EMPTY_RESPONSE',
      message: '服务返回了空响应',
    });

    await expect(requestJson('/api/importance', {
      method: 'POST',
      write: true,
      body: { important: true },
      signal: new AbortController().signal,
      fallbackMessage: '设置重要性失败',
      emptyMessage: '服务没有返回更新后的卡片',
      malformedAsEmpty: true,
    })).rejects.toMatchObject({
      code: 'EMPTY_RESPONSE',
      message: '服务没有返回更新后的卡片',
    });
  });
});

describe('offline detail projection', () => {
  it('projects the topic tab with bodies from the frozen document', () => {
    const doc = offlineDocument();
    const bodies = new Map([['n01', '覆盖正文']]);
    const details = deriveOfflineDetails({
      graph,
      doc,
      bodies,
      tab: 'topic',
      node: tree[0]!,
      topic,
    });
    expect(details.nodeDetail).toBeNull();
    expect(details.topicDetail?.topic).toEqual(topic);
    expect(details.topicDetail?.nodes[0]?.body).toBe('覆盖正文');
    expect(details.detailVersion).toBe('inst:7');
  });

  it('projects the node tab and never invents a node', () => {
    const details = deriveOfflineDetails({
      graph,
      doc: offlineDocument(),
      bodies: new Map([['n01', '节点正文']]),
      tab: 'node',
      node: tree[0]!,
      topic,
    });
    expect(details.topicDetail).toBeNull();
    expect(details.nodeDetail?.body).toBe('节点正文');
    expect(details.nodeDetail?.resources).toEqual({});
    expect(details.nodeDetail?.node.id).toBe('n01');

    const missing = deriveOfflineDetails({
      graph,
      doc: offlineDocument(),
      bodies: new Map(),
      tab: 'node',
      node: null,
      topic,
    });
    expect(missing.nodeDetail).toBeNull();
    expect(missing.topicDetail).toBeNull();
    expect(missing.detailVersion).toBeNull();
  });

  it('carries the embedded batch and the selected node diff', () => {
    const doc = offlineDocument(offlineChanges());
    const graphFromDoc = toGraphResponse(doc);

    const topicView = deriveOfflineDetails({
      graph: graphFromDoc,
      doc,
      bodies: new Map(),
      tab: 'topic',
      node: tree[0]!,
      topic,
    });
    expect(topicView.batch?.requestId).toBe('req-offline');
    expect(topicView.batch?.nodes.map((item) => [item.nodeId, item.kind])).toEqual([
      ['n01', 'modified'],
      ['n_gone', 'deleted'],
    ]);
    expect(topicView.nodeChange).toBeNull();

    const nodeView = deriveOfflineDetails({
      graph: graphFromDoc,
      doc,
      bodies: new Map(),
      tab: 'node',
      node: tree[0]!,
      topic,
    });
    expect(nodeView.batch?.requestId).toBe('req-offline');
    expect(nodeView.nodeChange?.nodeId).toBe('n01');
    expect(nodeView.nodeChange?.fieldDiffs[0]?.after).toBe('起点');
  });
});

describe('frozen offline document', () => {
  it('projects the embedded document into the live GraphResponse shape', () => {
    const doc = offlineDocument();
    const response = toGraphResponse(doc);
    expect(response.instanceId).toBe('inst');
    expect(response.revision).toBe(7);
    expect(response.workspaceId).toBe('w_1');
    expect(response.topics).toEqual([topic]);
    expect(response.nodes).toHaveLength(1);
    expect(response.nodes[0]).not.toHaveProperty('body');
    expect(response.nodes[0]?.id).toBe('n01');
    expect(response.nodes[0]?.revision).toBe(1);
  });

  it('projects embedded changes into lastChanges, deletions included', () => {
    const doc = offlineDocument(offlineChanges());
    const response = toGraphResponse(doc);
    const batch = response.lastChanges?.['t_1'];
    expect(batch?.requestId).toBe('req-offline');
    expect(batch?.counts).toEqual({ added: 1, modified: 1, deleted: 1 });
    expect(batch?.nodes.map((item) => [item.nodeId, item.kind])).toEqual([
      ['n01', 'modified'],
      ['n_gone', 'deleted'],
    ]);
  });

  it('keeps an older export without changes readable and label-free', () => {
    const doc = offlineDocument();
    const response = toGraphResponse(doc);
    expect(response.lastChanges).toBeUndefined();
    const details = deriveOfflineDetails({
      graph: response,
      doc,
      bodies: new Map(),
      tab: 'node',
      node: tree[0]!,
      topic,
    });
    expect(details.batch).toBeNull();
    expect(details.nodeChange).toBeNull();
  });

  it('still reads an old export whose nodes carry the retired state field', () => {
    const doc = offlineDocument();
    const legacyRaw = {
      ...doc,
      nodes: doc.nodes.map((item) => ({ ...item, state: 'agreed' })),
    } as unknown;
    const parsed = parseOfflineDocument(legacyRaw);
    const response = toGraphResponse(parsed);
    expect(response.nodes).toHaveLength(1);
    expect(response.nodes[0]).not.toHaveProperty('state');
    expect(response.nodes[0]?.id).toBe('n01');
  });

  it('rejects a document that lost the frozen identity fields', () => {
    expect(() => parseOfflineDocument({ format: 1, topic: { id: 't1' }, nodes: [] }))
      .toThrow('导出数据缺少主题信息');
    expect(() => parseOfflineDocument({
      format: 1,
      workspaceId: 'w',
      topic: { id: 't1', key: 'k' },
      nodes: [],
      instanceId: 'i',
    })).toThrow('导出数据缺少快照版本信息');
  });
});

describe('continuation prompt identity', () => {
  it('carries stable ids and the actual CLI/Skill entries instead of file paths', () => {
    const text = buildContinuationPrompt({ workspace, graph, topic, node: tree[1]! });
    expect(text).toContain('workspaceId=w_1');
    expect(text).toContain('topicId=t_1');
    expect(text).toContain('nodeId=n02');
    expect(text).toContain('revision=1');
    expect(text).toContain('CLI 入口：D:/daily/dist/cli/index.js');
    expect(text).toContain('Skill 入口：D:/daily/skills/SKILL.md');
    expect(text).not.toContain('topics/');
    expect(text).not.toContain('topic.md');
    expect(text).not.toContain('源文件');
    // Node classification was removed from the product; the prompt has no state.
    expect(text).not.toContain('state=');
    expect(text).not.toContain('待确认');
    expect(text).not.toContain('已确认');
  });
});
