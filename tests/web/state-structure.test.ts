import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GraphNode,
  GraphResponse,
  GraphTopic,
  OfflineTopicDocument,
  WorkspaceResponse,
} from '../../src/shared/protocol.js';
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
    state: 'agreed',
    important: false,
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
  title: '协作方式',
  path: 'topics/协作方式/topic.md',
  nodeIds: tree.map((item) => item.id),
  fileHash: 'topic-hash',
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

function offlineDocument(): OfflineTopicDocument {
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
      path: 'topics/协作方式/n_01.md',
      fileHash: 'node-hash',
    }],
    boundaryNodes: [],
    resources: {},
    resourceDiagnostics: [],
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
    expect(details.nodeDetail?.path).toBe(topic.path);
    expect(details.nodeDetail?.fileHash).toBe(topic.fileHash);

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
});

describe('continuation prompt paths', () => {
  it('joins the topic directory with the workspace root separator', () => {
    const text = buildContinuationPrompt({ workspace, graph, topic, node: null });
    expect(text).toContain('主题目录：D:\\vault\\示例\\topics\\协作方式');
  });
});
