import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphStore } from '../../src/next/store.js';
import { MAX_BODY_PATCH_CHARS } from '../../src/next/changes.js';
import type {
  AgentChangeAction,
  AgentChangeRequest,
  AgentChangeResponse,
  AgentCheckResponse,
  ChangeBatchDetail,
} from '../../src/next/protocol.js';

const roots: string[] = [];
const stores: GraphStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  while (roots.length > 0) {
    const root = roots.pop() as string;
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function newStore(): Promise<GraphStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-changes-'));
  roots.push(root);
  const store = GraphStore.create(root, '变化测试');
  stores.push(store);
  return store;
}

function request(
  workspaceId: string,
  action: AgentChangeAction,
  options: { requestId?: string; dryRun?: boolean; includeDiff?: boolean } = {},
): AgentChangeRequest {
  return {
    workspaceId,
    requestId: options.requestId ?? randomUUID(),
    action,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.includeDiff === undefined ? {} : { includeDiff: options.includeDiff }),
  };
}

function commit(store: GraphStore, input: AgentChangeRequest): AgentChangeResponse {
  const response = store.commit(input, 'hash:' + input.requestId);
  if ('dryRun' in response) throw new Error('expected committed response, got dry-run');
  return response;
}

function check(store: GraphStore, input: AgentChangeRequest): AgentCheckResponse {
  const response = store.commit(input, 'hash:' + input.requestId);
  if (!('dryRun' in response)) throw new Error('expected dry-run response');
  return response;
}

function workspaceOf(store: GraphStore): string {
  return store.snapshot().workspaceId;
}

function nodeOf(store: GraphStore, nodeId: string) {
  const node = store.snapshot().nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) throw new Error('node not found: ' + nodeId);
  return node;
}

function topicOf(store: GraphStore, topicId: string) {
  const topic = store.snapshot().topics.find((entry) => entry.id === topicId);
  if (topic === undefined) throw new Error('topic not found: ' + topicId);
  return topic;
}

function createTopic(
  store: GraphStore,
  key: string,
  title: string,
  nodeTitle = '根卡',
  body = '根正文。',
): { topicId: string; nodeId: string; response: AgentChangeResponse } {
  const response = commit(
    store,
    request(workspaceOf(store), {
      action: 'createTopic',
      key,
      topicTitle: title,
      node: { title: nodeTitle, body },
    }),
  );
  const topicId = response.created.topicId;
  const nodeId = response.created.nodeIds[0];
  if (topicId === null || nodeId === undefined) throw new Error('createTopic returned no ids');
  return { topicId, nodeId, response };
}

function editPatch(
  store: GraphStore,
  topicId: string,
  nodeId: string,
  patch: Record<string, unknown>,
  requestId?: string,
): AgentChangeResponse {
  const revision = nodeOf(store, nodeId).revision;
  return commit(
    store,
    request(
      workspaceOf(store),
      {
        action: 'batch',
        topicId,
        ops: [{ op: 'edit', target: { id: nodeId, revision }, patch: patch as never }],
      },
      requestId === undefined ? {} : { requestId },
    ),
  );
}

function createBranch(
  store: GraphStore,
  topicId: string,
  fromId: string,
  title = '分支卡',
): { nodeId: string; response: AgentChangeResponse } {
  const from = nodeOf(store, fromId);
  const response = commit(
    store,
    request(workspaceOf(store), {
      action: 'createBranch',
      from: { id: fromId, revision: from.revision },
      description: '从根分出的方向',
      node: { title, body: '分支正文。', side: 'right', order: 10 },
    }),
  );
  const nodeId = response.created.nodeIds[0];
  if (nodeId === undefined) throw new Error('createBranch returned no node id');
  void topicId;
  return { nodeId, response };
}

describe('change batches: persistence and diff', () => {
  it('createTopic stores an added batch with a matching response summary', async () => {
    const store = await newStore();
    const { topicId, nodeId, response } = createTopic(store, 'alpha', '主题一', '根卡', '根正文。');

    const detail = store.latestChangeDetail(topicId);
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      requestId: response.requestId,
      topicId,
      counts: { added: 1, modified: 0, deleted: 0 },
    });
    expect(detail?.nodes).toHaveLength(1);
    expect(detail?.nodes[0]).toMatchObject({
      nodeId,
      kind: 'added',
      title: '根卡',
      fields: [],
      fieldDiffs: [],
      beforeRevision: null,
      afterRevision: 1,
    });
    // Added nodes still expose a unified body patch (empty -> body).
    expect(detail?.nodes[0]?.body).toMatchObject({ truncated: false, removedLines: 0 });
    expect(detail?.nodes[0]?.body?.addedLines).toBeGreaterThan(0);
    expect(detail?.nodes[0]?.body?.patch).toContain('+根正文。');
    expect(response.change).toMatchObject({
      requestId: response.requestId,
      topicId,
      counts: { added: 1, modified: 0, deleted: 0 },
    });
    expect(store.changeBatchRequestId(topicId)).toBe(response.requestId);
    expect(store.latestChangeSummary(topicId)).toEqual(response.change);
  });

  it('modified nodes expose field diffs plus a context-limited body patch and replace the old batch', async () => {
    const store = await newStore();
    const created = createTopic(store, 'alpha', '主题一', '旧标题', '第一行。\n\n第二行。\n');

    const editRequestId = 'req-edit-1';
    const edited = editPatch(store, created.topicId, created.nodeId, {
      title: '新标题',
      append: '追加段落。',
    }, editRequestId);
    expect(edited.change?.requestId).toBe(editRequestId);

    const detail = store.latestChangeDetail(created.topicId) as ChangeBatchDetail;
    expect(detail.requestId).toBe(editRequestId);
    expect(detail.counts).toEqual({ added: 0, modified: 1, deleted: 0 });
    // Added batch is replaced, not appended.
    expect(detail.nodes).toHaveLength(1);
    const node = detail.nodes[0] as ChangeBatchDetail['nodes'][number];
    expect(node).toMatchObject({
      nodeId: created.nodeId,
      kind: 'modified',
      title: '新标题',
      fields: ['title'],
      beforeRevision: 1,
      afterRevision: 2,
    });
    expect(node.fieldDiffs).toEqual([{ field: 'title', before: '旧标题', after: '新标题' }]);
    expect(node.body).toBeDefined();
    expect(node.body?.truncated).toBe(false);
    expect(node.body?.addedLines).toBeGreaterThan(0);
    expect(node.body?.removedLines).toBe(0);
    expect(node.body?.patch).toContain('@@');
    expect(node.body?.patch).toContain('+追加段落。');
  });

  it('body-only edits are modified with no field diffs; fields keep protocol order', async () => {
    const store = await newStore();
    const created = createTopic(store, 'alpha', '主题一', '标题', '原始正文。');
    editPatch(store, created.topicId, created.nodeId, { body: '替换后的正文。' });
    let node = store.latestChangeDetail(created.topicId)?.nodes[0];
    expect(node?.kind).toBe('modified');
    expect(node?.fields).toEqual([]);
    expect(node?.fieldDiffs).toEqual([]);
    expect(node?.body?.patch).toContain('@@');

    editPatch(store, created.topicId, created.nodeId, { title: '标题二', summary: '显式摘要' });
    node = store.latestChangeDetail(created.topicId)?.nodes[0];
    expect(node?.fields).toEqual(['title', 'summary']);
    expect(node?.fieldDiffs).toEqual([
      { field: 'title', before: '标题', after: '标题二' },
      { field: 'summary', before: null, after: '显式摘要' },
    ]);
  });

  it('restored values are noop: latest batch and revisions stay unchanged', async () => {
    const store = await newStore();
    const created = createTopic(store, 'alpha', '主题一', '原标题', '正文。');
    const contentEdit = editPatch(store, created.topicId, created.nodeId, { title: '改过的标题' });
    const afterEditTopic = topicOf(store, created.topicId);
    const afterEditWorkspace = store.snapshot().revision;

    // 把字段改成与当前最终值相同：最终值无差异，不提交、不替换批次。
    const restored = editPatch(store, created.topicId, created.nodeId, { title: '改过的标题' });
    expect(restored.state).toBe('noop');
    expect(restored.change).toBeUndefined();
    expect(store.latestChangeDetail(created.topicId)?.requestId).toBe(contentEdit.requestId);
    expect(store.latestChangeDetail(created.topicId)?.nodes[0]?.kind).toBe('modified');
    expect(topicOf(store, created.topicId).revision).toBe(afterEditTopic.revision);
    expect(store.snapshot().revision).toBe(afterEditWorkspace);
  });

  it('important-only commits never replace the latest content batch', async () => {
    const store = await newStore();
    const created = createTopic(store, 'alpha', '主题一');
    const contentEdit = editPatch(store, created.topicId, created.nodeId, { title: '内容标题' });
    const topicBefore = topicOf(store, created.topicId);
    const workspaceBefore = store.snapshot().revision;

    const important = commit(
      store,
      request(workspaceOf(store), {
        action: 'setImportance',
        nodeId: created.nodeId,
        important: true,
      }),
    );
    expect(important.state).toBe('committed');
    expect(important.change).toBeUndefined();
    expect(store.latestChangeDetail(created.topicId)?.requestId).toBe(contentEdit.requestId);
    expect(store.latestChangeDetail(created.topicId)?.nodes).toHaveLength(1);
    expect(store.latestChangeDetail(created.topicId)?.nodes[0]?.fields).toEqual(['title']);
    // The importance write still bumps node/topic/workspace revisions.
    expect(nodeOf(store, created.nodeId).important).toBe(true);
    expect(topicOf(store, created.topicId).revision).toBe(topicBefore.revision + 1);
    expect(store.snapshot().revision).toBe(workspaceBefore + 1);
  });

  it('pure deletion replaces the batch and updates lastChangeAt with empty recent ids', async () => {
    const store = await newStore();
    const created = createTopic(store, 'alpha', '主题一');
    const branch = createBranch(store, created.topicId, created.nodeId);
    const topicBeforeDelete = topicOf(store, created.topicId);
    const workspaceBeforeDelete = store.snapshot().revision;
    const branchRevision = nodeOf(store, branch.nodeId).revision;

    const deleted = commit(
      store,
      request(workspaceOf(store), {
        action: 'delete',
        target: { id: branch.nodeId, revision: branchRevision },
      }),
    );
    expect(deleted.state).toBe('committed');
    expect(deleted.change?.counts).toEqual({ added: 0, modified: 0, deleted: 1 });

    const detail = store.latestChangeDetail(created.topicId) as ChangeBatchDetail;
    expect(detail.counts).toEqual({ added: 0, modified: 0, deleted: 1 });
    expect(detail.nodes).toHaveLength(1);
    expect(detail.nodes[0]).toMatchObject({
      nodeId: branch.nodeId,
      kind: 'deleted',
      beforeRevision: branchRevision,
      afterRevision: null,
      fields: [],
      fieldDiffs: [],
    });
    // Deleted nodes keep their content as a removal-only body patch.
    expect(detail.nodes[0]?.body).toMatchObject({ truncated: false, addedLines: 0 });
    expect(detail.nodes[0]?.body?.removedLines).toBeGreaterThan(0);
    expect(detail.nodes[0]?.body?.patch).toContain('-分支正文。');
    expect(store.nodeChange(created.topicId, branch.nodeId)?.kind).toBe('deleted');
    expect(store.nodeChange(created.topicId, created.nodeId)).toBeNull();

    const topicAfter = topicOf(store, created.topicId);
    expect(topicAfter.revision).toBe(topicBeforeDelete.revision + 1);
    expect(topicAfter.lastChangeAt).toBe(detail.at);
    expect(topicAfter.lastChangeIds).toEqual([]);
    expect(store.snapshot().revision).toBe(workspaceBeforeDelete + 1);
  });

  it('created-then-deleted nodes leave only the final deletion batch', async () => {
    const store = await newStore();
    const created = createTopic(store, 'alpha', '主题一');
    const branch = createBranch(store, created.topicId, created.nodeId, '临时分支');
    expect(store.latestChangeDetail(created.topicId)?.nodes[0]).toMatchObject({
      nodeId: branch.nodeId,
      kind: 'added',
    });

    commit(
      store,
      request(workspaceOf(store), {
        action: 'delete',
        target: { id: branch.nodeId, revision: 1 },
      }),
    );
    const detail = store.latestChangeDetail(created.topicId) as ChangeBatchDetail;
    expect(detail.nodes).toHaveLength(1);
    expect(detail.nodes[0]).toMatchObject({ nodeId: branch.nodeId, kind: 'deleted' });
    // The earlier "added" batch is fully replaced, never merged.
    expect(detail.nodes.some((node) => node.kind === 'added')).toBe(false);
    expect(store.changeSummaries()[created.topicId]?.counts).toEqual({
      added: 0,
      modified: 0,
      deleted: 1,
    });
  });

  it('two topics keep independent latest batches', async () => {
    const store = await newStore();
    const topicA = createTopic(store, 'alpha', '主题甲', '甲根');
    const createB = createTopic(store, 'beta', '主题乙', '乙根');
    expect(store.changeSummaries()).toMatchObject({
      [topicA.topicId]: { requestId: topicA.response.requestId },
      [createB.topicId]: { requestId: createB.response.requestId },
    });

    const editA = editPatch(store, topicA.topicId, topicA.nodeId, { title: '甲改' });
    expect(store.latestChangeDetail(topicA.topicId)?.requestId).toBe(editA.requestId);
    expect(store.latestChangeDetail(createB.topicId)?.requestId).toBe(createB.response.requestId);
    expect(store.changeSummaries()[createB.topicId]?.nodes[0]).toMatchObject({
      kind: 'added',
      title: '乙根',
    });

    const editB = editPatch(store, createB.topicId, createB.nodeId, { title: '乙改' });
    expect(store.latestChangeDetail(createB.topicId)?.requestId).toBe(editB.requestId);
    expect(store.latestChangeDetail(topicA.topicId)?.requestId).toBe(editA.requestId);
  });

  it('replays the stored response without replacing the newer batch', async () => {
    const store = await newStore();
    const created = createTopic(store, 'alpha', '主题一');
    const originalRequest = request(workspaceOf(store), {
      action: 'batch',
      topicId: created.topicId,
      ops: [{
        op: 'edit',
        target: { id: created.nodeId, revision: 1 },
        patch: { title: '第一次改' },
      }],
    }, { requestId: 'req-replay' });
    const original = commit(store, originalRequest);

    const newer = editPatch(store, created.topicId, created.nodeId, { title: '第二次改' });
    const replay = store.commit(originalRequest, 'hash:' + originalRequest.requestId);
    expect('dryRun' in replay).toBe(false);
    if ('dryRun' in replay) throw new Error('unreachable');
    expect(replay.replayed).toBe(true);
    expect(replay.change?.requestId).toBe(original.requestId);
    expect(store.latestChangeDetail(created.topicId)?.requestId).toBe(newer.requestId);
    expect(store.changeBatchRequestId(created.topicId)).toBe(newer.requestId);
    expect(store.getRequest(originalRequest.requestId)?.response).toMatchObject({
      requestId: originalRequest.requestId,
    });
    expect(store.getRequest('req-does-not-exist')).toBeNull();
  });

  it('dry-run with includeDiff previews the next candidate and writes nothing', async () => {
    const store = await newStore();
    const created = createTopic(store, 'alpha', '主题一', '原题', '原正文。');
    const batchRequestId = store.latestChangeDetail(created.topicId)?.requestId;
    const nodeBefore = nodeOf(store, created.nodeId);
    const workspaceBefore = store.snapshot().revision;

    const dryRequest = request(workspaceOf(store), {
      action: 'batch',
      topicId: created.topicId,
      ops: [{
        op: 'edit',
        target: { id: created.nodeId, revision: nodeBefore.revision },
        patch: { title: '预览标题', append: '预览追加。' },
      }],
    }, { dryRun: true, includeDiff: true });
    const preview = check(store, dryRequest);
    expect(preview.state).toBe('checked');
    expect(preview.preview).toMatchObject({
      requestId: dryRequest.requestId,
      topicId: created.topicId,
      counts: { added: 0, modified: 1, deleted: 0 },
    });
    expect(preview.preview?.nodes[0]).toMatchObject({
      nodeId: created.nodeId,
      kind: 'modified',
      beforeRevision: nodeBefore.revision,
      afterRevision: nodeBefore.revision + 1,
      fields: ['title'],
    });
    expect(preview.preview?.nodes[0]?.body?.patch).toContain('+预览追加。');

    // No DB writes, versions or batch replacement.
    expect(store.latestChangeDetail(created.topicId)?.requestId).toBe(batchRequestId);
    expect(nodeOf(store, created.nodeId).revision).toBe(nodeBefore.revision);
    expect(nodeOf(store, created.nodeId).title).toBe('原题');
    expect(store.snapshot().revision).toBe(workspaceBefore);
    expect(store.getRequest(dryRequest.requestId)).toBeNull();

    // includeDiff=false keeps the old check-response shape (no preview).
    const plainDry = check(store, request(workspaceOf(store), {
      action: 'batch',
      topicId: created.topicId,
      ops: [{
        op: 'edit',
        target: { id: created.nodeId, revision: nodeBefore.revision },
        patch: { title: '另一个预览' },
      }],
    }, { dryRun: true }));
    expect(plainDry.preview).toBeUndefined();
  });

  it('survives a store restart with the same batches and node lookup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-changes-restart-'));
    roots.push(root);
    const first = GraphStore.create(root, '变化测试');
    const created = createTopic(first, 'alpha', '主题一');
    editPatch(first, created.topicId, created.nodeId, { title: '重启前' });
    const detail = first.latestChangeDetail(created.topicId);
    const summaries = first.changeSummaries();
    first.close();

    const second = GraphStore.open(root);
    stores.push(second);
    expect(second.schemaVersion()).toBe(3);
    expect(second.latestChangeDetail(created.topicId)).toEqual(detail);
    expect(second.changeSummaries()).toEqual(summaries);
    expect(second.nodeChange(created.topicId, created.nodeId)?.kind).toBe('modified');
    expect(second.changeBatchRequestId(created.topicId)).toBe(detail?.requestId);
  });

  it('truncates very large body patches and reports it', async () => {
    const store = await newStore();
    const created = createTopic(store, 'alpha', '主题一', '标题', '原始正文。');
    editPatch(store, created.topicId, created.nodeId, { body: '新增内容。'.repeat(8_000) });
    const body = store.latestChangeDetail(created.topicId)?.nodes[0]?.body;
    expect(body).toBeDefined();
    expect(body?.truncated).toBe(true);
    expect(body?.patch.length).toBeLessThanOrEqual(MAX_BODY_PATCH_CHARS);
    expect(body?.addedLines).toBeGreaterThan(0);
  });
});
