/**
 * SQLite 服务运行时的端到端契约：
 * 临时数据库 + 随机端口，覆盖 workspace／graph／detail／read／search、Agent 写入、
 * importance、资源、状态查询、导出注入与 service.json 生命周期。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GraphStore } from '../../src/next/store.js';
import type {
  AgentChangeRequest,
  AgentChangeResponse,
  AgentCheckResponse,
  GraphResponse,
  ReadViewResponse,
  SearchResponse,
  TopicExportStatus,
  TopicDetailResponse,
  WorkspaceResponse,
} from '../../src/next/protocol.js';
import { GraphRuntime, type GraphEvent } from '../../src/next/runtime.js';
import { startGraphService, createGraphApp, type GraphServiceHandle } from '../../src/next/server.js';
import type { ExportManagerLike } from '../../src/next/export-contract.js';

const temporaryRoots: string[] = [];
const running: GraphServiceHandle[] = [];

afterEach(async () => {
  for (const handle of running.splice(0)) {
    await handle.stop().catch(() => undefined);
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

interface SeededWorkspace {
  parent: string;
  root: string;
  workspaceId: string;
  topicId: string;
  rootNodeId: string;
}

/** 建库并写入一个主题＋根节点；返回真实根路径与稳定 ID。 */
async function seedWorkspace(name = '服务测试'): Promise<SeededWorkspace> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-next-server-'));
  temporaryRoots.push(parent);
  const root = path.join(parent, 'workspace');
  const store = GraphStore.create(root, name);
  try {
    const workspaceId = store.snapshot().workspaceId;
    const request: AgentChangeRequest = {
      workspaceId,
      requestId: randomUUID(),
      action: {
        action: 'createTopic',
        topicTitle: '主线',
        node: {
          title: '起点',
          body:
            '起点正文，用于检索。\n\n![示意图](resources/pic.png)\n\n' +
            '![相对图](../../resources/other%20pic.png)',
        },
      },
    };
    const response = store.commit(request, 'seed-hash');
    if ('dryRun' in response) throw new Error('seed commit 不应是 dry-run');
    const topicId = response.created.topicId;
    const rootNodeId = response.created.nodeIds[0];
    if (topicId === null || rootNodeId === undefined) throw new Error('seed 未创建主题');
    return { parent, root: await fs.realpath(root), workspaceId, topicId, rootNodeId };
  } finally {
    store.close();
  }
}

async function start(seeded: SeededWorkspace): Promise<GraphServiceHandle> {
  const handle = await startGraphService({
    root: seeded.root,
    port: 0,
    webRoot: null,
    appRoot: seeded.parent,
  });
  running.push(handle);
  return handle;
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as T };
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

function requestId(): string {
  return randomUUID();
}

describe('next service：读取与描述', () => {
  it('workspace／graph／node／topic 返回数据库投影与实例信息', async () => {
    const seeded = await seedWorkspace();
    const handle = await start(seeded);

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.workspaceId).toBe(seeded.workspaceId);
    expect(handle.instanceId).toMatch(/^inst_[0-9a-f]{32}$/);
    expect(handle.revision).toBeGreaterThanOrEqual(1);

    const workspace = await getJson<WorkspaceResponse>(handle.url + '/api/workspace');
    expect(workspace.status).toBe(200);
    expect(workspace.body).toMatchObject({
      instanceId: handle.instanceId,
      workspaceId: seeded.workspaceId,
      name: '服务测试',
      rootPath: seeded.root,
      stale: false,
      diagnostics: [],
    });
    expect(workspace.body.program?.program).toBe('aichat-graph');

    const graph = await getJson<GraphResponse>(handle.url + '/api/graph');
    expect(graph.status).toBe(200);
    expect(graph.body.workspaceId).toBe(seeded.workspaceId);
    expect(graph.body.nodes).toHaveLength(1);
    expect(graph.body.nodes[0]).toMatchObject({
      id: seeded.rootNodeId,
      topicId: seeded.topicId,
      flow: 'root',
      number: '01',
      revision: 1,
    });
    expect(graph.body.nodes[0]).not.toHaveProperty('sourcePath');
    expect(graph.body.topics[0]).toMatchObject({ id: seeded.topicId, key: '主线' });
    expect(graph.body.lastChanges?.[seeded.topicId]?.nodeIds).toContain(seeded.rootNodeId);

    const detail = await getJson<{
      node: { id: string };
      body: string;
      instanceId: string;
      resources?: Record<string, string>;
    }>(handle.url + '/api/nodes/' + seeded.rootNodeId);
    expect(detail.status).toBe(200);
    expect(detail.body.node.id).toBe(seeded.rootNodeId);
    expect(detail.body.body).toContain('起点正文');
    // 正文里的 resources/ 引用映射成同源 URL；../ 前缀与百分号编码都归一到同一 key。
    expect(detail.body.resources).toMatchObject({
      'resources/pic.png': '/api/resources/pic.png',
      'resources/other pic.png': '/api/resources/other%20pic.png',
    });

    const topic = await getJson<TopicDetailResponse>(handle.url + '/api/topics/' + seeded.topicId);
    expect(topic.status).toBe(200);
    expect(topic.body).toMatchObject({ source: 'database', valid: true });
    expect(topic.body.topic.id).toBe(seeded.topicId);
    expect(topic.body.nodes[0]?.body).toContain('起点正文');
    expect(topic.body.resources).toMatchObject({
      'resources/pic.png': '/api/resources/pic.png',
      'resources/other pic.png': '/api/resources/other%20pic.png',
    });

    const missing = await getJson<{ ok: boolean; error: { code: string } }>(
      handle.url + '/api/nodes/n_' + 'a'.repeat(32),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NODE_NOT_FOUND');
  });

  it('search 做 Unicode 子串匹配并分页；read 视图与预算可直接使用', async () => {
    const seeded = await seedWorkspace();
    const handle = await start(seeded);

    const search = await getJson<SearchResponse>(
      handle.url + '/api/search?q=' + encodeURIComponent('起点正文') + '&page=0&limit=10',
    );
    expect(search.status).toBe(200);
    expect(search.body).toMatchObject({ ok: true, command: 'search', source: 'database' });
    expect(search.body.totalHits).toBe(1);
    expect(search.body.hits[0]).toMatchObject({
      nodeId: seeded.rootNodeId,
      topicId: seeded.topicId,
    });
    // 命中字段按 title → 显式/派生 summary → body 的优先级报告。
    expect(['summary', 'body']).toContain(search.body.hits[0]?.field);
    expect(search.body.hasMore).toBe(false);

    const emptyQuery = await getJson<{ error: { code: string } }>(handle.url + '/api/search?q=');
    expect(emptyQuery.status).toBe(400);

    const overview = await getJson<ReadViewResponse>(
      handle.url + '/api/agent/read?view=overview&topic=' + seeded.topicId,
    );
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ ok: true, command: 'read', source: 'online', view: 'overview' });
    expect(overview.body.items[0]?.node.id).toBe(seeded.rootNodeId);
    expect(overview.body.budget.unit).toBe('utf16');
    expect(overview.body.budget.used).toBeGreaterThan(0);
    expect(JSON.stringify(overview.body).length + 1).toBeLessThanOrEqual(
      overview.body.budget.limit,
    );

    const content = await getJson<ReadViewResponse>(
      handle.url +
        '/api/agent/read?view=content&topic=' +
        seeded.topicId +
        '&node=' +
        seeded.rootNodeId,
    );
    expect(content.status).toBe(200);
    expect(content.body.items[0]?.body).toContain('起点正文');

    const meta = await getJson<ReadViewResponse>(
      handle.url +
        '/api/agent/read?view=content&topic=' +
        seeded.topicId +
        '&node=' +
        seeded.rootNodeId +
        '&meta=true',
    );
    expect(meta.status).toBe(200);
    expect(meta.body.items[0]?.body).toBe('');
    expect(meta.body.items[0]?.omitted).toBe(true);

    const resume = await getJson<ReadViewResponse>(
      handle.url +
        '/api/agent/read?view=resume&topic=' +
        seeded.topicId +
        '&node=' +
        seeded.rootNodeId +
        '&anchor=' +
        seeded.rootNodeId,
    );
    expect(resume.status).toBe(200);
    expect(resume.body.items[0]?.role ?? 'anchor').toBe('anchor');
    expect(resume.body.items[0]?.body).toContain('起点正文');

    // CLI 简写：view=resume 只给一个 node 时自动把它当 anchor。
    const resumeShorthand = await getJson<ReadViewResponse>(
      handle.url + '/api/agent/read?view=resume&topic=' + seeded.topicId + '&node=' + seeded.rootNodeId,
    );
    expect(resumeShorthand.status).toBe(200);
    expect(resumeShorthand.body.items[0]?.node.id).toBe(seeded.rootNodeId);
    expect(resumeShorthand.body.items[0]?.role).toBe('anchor');

    const invalidView = await getJson<{ error: { code: string } }>(
      handle.url + '/api/agent/read?view=nope&topic=' + seeded.topicId,
    );
    expect(invalidView.status).toBe(400);
  });
});

describe('next service：Agent 写入与重要性', () => {
  it('createTopic／batch edit 一次提交，版本冲突 412，status 可查', async () => {
    const seeded = await seedWorkspace();
    const handle = await start(seeded);
    const workspaceId = seeded.workspaceId;

    const created = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
      workspaceId,
      requestId: requestId(),
      action: {
        action: 'createTopic',
        topicTitle: '第二主题',
        node: { title: '第二起点', body: '第二主题正文。' },
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.state).toBe('committed');
    expect(created.body.created.topicId).toMatch(/^t_[0-9a-f]{32}$/);
    expect(created.body.revision).toBeGreaterThan(handle.revision);

    const graph = await getJson<GraphResponse>(handle.url + '/api/graph');
    expect(graph.body.topics).toHaveLength(2);
    expect(graph.body.revision).toBe(created.body.revision);

    const editRequestId = requestId();
    const edited = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
      workspaceId,
      requestId: editRequestId,
      action: {
        action: 'batch',
        topicId: seeded.topicId,
        ops: [
          {
            op: 'edit',
            target: { id: seeded.rootNodeId, revision: 1 },
            patch: { title: '新标题', append: '追加段落。' },
          },
        ],
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.state).toBe('committed');
    expect(edited.body.changedNodeIds).toContain(seeded.rootNodeId);

    const node = await getJson<{ node: { title: string; revision: number }; body: string }>(
      handle.url + '/api/nodes/' + seeded.rootNodeId,
    );
    expect(node.body.node.title).toBe('新标题');
    expect(node.body.node.revision).toBe(2);
    expect(node.body.body).toContain('追加段落。');

    const status = await getJson<{ status: string; source: string; requestId: string }>(
      handle.url + '/api/changes/' + editRequestId,
    );
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      requestId: editRequestId,
      status: 'committed',
      source: 'database',
    });

    const unknown = await getJson<{ status: string; source: string }>(
      handle.url + '/api/changes/' + requestId(),
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ status: 'unknown', source: 'unknown' });

    // 旧版本写回 → 412，不覆盖新内容。
    const stale = await postJson<{ ok: boolean; error: { code: string } }>(
      handle.url + '/api/agent/changes',
      {
        workspaceId,
        requestId: requestId(),
        action: {
          action: 'batch',
          topicId: seeded.topicId,
          ops: [
            {
              op: 'edit',
              target: { id: seeded.rootNodeId, revision: 1 },
              patch: { append: '旧版本追加。' },
            },
          ],
        },
      },
    );
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.ok).toBe(false);

    // dry-run：校验但不写库，也不留下请求记录。
    const dryId = requestId();
    const dry = await postJson<AgentCheckResponse>(handle.url + '/api/agent/changes', {
      workspaceId,
      requestId: dryId,
      dryRun: true,
      action: {
        action: 'batch',
        topicId: seeded.topicId,
        ops: [
          {
            op: 'edit',
            target: { id: seeded.rootNodeId, revision: 2 },
            patch: { append: 'dry-run 不应写入。' },
          },
        ],
      },
    });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, state: 'checked', requestId: dryId });
    const afterDry = await getJson<{ body: string }>(
      handle.url + '/api/nodes/' + seeded.rootNodeId,
    );
    expect(afterDry.body.body).not.toContain('dry-run 不应写入。');
    const dryStatus = await getJson<{ status: string }>(handle.url + '/api/changes/' + dryId);
    expect(dryStatus.body.status).toBe('unknown');
  });

  it('workspaceId 不一致 409；importance 更新节点但不替换最近内容更新', async () => {
    const seeded = await seedWorkspace();
    const handle = await start(seeded);

    const mismatch = await postJson<{ error: { code: string } }>(handle.url + '/api/agent/changes', {
      workspaceId: 'w_' + 'f'.repeat(32),
      requestId: requestId(),
      action: { action: 'setImportance', nodeId: seeded.rootNodeId, important: true },
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('WORKSPACE_MISMATCH');

    const before = await getJson<GraphResponse>(handle.url + '/api/graph');
    const lastChangeBefore = before.body.lastChanges?.[seeded.topicId];

    const importance = await postJson<{
      ok: boolean;
      revision: number;
      node: { id: string; important: boolean; revision: number };
    }>(handle.url + '/api/importance', {
      topicId: seeded.topicId,
      nodeId: seeded.rootNodeId,
      important: true,
    });
    expect(importance.status).toBe(200);
    expect(importance.body.ok).toBe(true);
    expect(importance.body.node.important).toBe(true);
    expect(importance.body.node.revision).toBe(2);
    expect(importance.body.revision).toBe(before.body.revision + 1);

    const after = await getJson<GraphResponse>(handle.url + '/api/graph');
    expect(after.body.nodes[0]?.important).toBe(true);
    expect(after.body.lastChanges?.[seeded.topicId]).toEqual(lastChangeBefore);

    const wrongRevision = await postJson<{ error: { code: string } }>(handle.url + '/api/importance', {
      topicId: seeded.topicId,
      nodeId: seeded.rootNodeId,
      important: false,
      revision: 1,
    });
    expect(wrongRevision.status).toBe(412);
    expect(wrongRevision.body.error.code).toBe('VERSION_CONFLICT');
  });
});

async function firstSseChunk(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE 没有响应体');
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    return text;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

describe('next service：资源、静态与错误边界', () => {
  it('SSE 首次连接立即给出当前快照事件', async () => {
    const seeded = await seedWorkspace();
    const handle = await start(seeded);
    const chunk = await firstSseChunk(handle.url + '/api/events');
    expect(chunk).toContain('event: snapshot');
    expect(chunk).toContain(handle.instanceId);
    expect(chunk).toContain('"stale":false');
  });

  it('resources 只提供工作区 resources 下的文件；未知 API 是 JSON 404', async () => {
    const seeded = await seedWorkspace();
    const handle = await start(seeded);

    const resources = path.join(seeded.root, 'resources');
    await fs.mkdir(resources, { recursive: true });
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    await fs.writeFile(path.join(resources, 'pic.png'), image);
    const spaced = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
    await fs.writeFile(path.join(resources, 'other pic.png'), spaced);

    const response = await fetch(handle.url + '/api/resources/pic.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image);

    // 节点详情给出的 URL 可以直接作为图片源：编码后的空格也要能取回文件。
    const detail = await getJson<{ resources?: Record<string, string> }>(
      handle.url + '/api/nodes/' + seeded.rootNodeId,
    );
    const spacedUrl = detail.body.resources?.['resources/other pic.png'];
    expect(spacedUrl).toBe('/api/resources/other%20pic.png');
    const spacedResponse = await fetch(handle.url + String(spacedUrl));
    expect(spacedResponse.status).toBe(200);
    expect(spacedResponse.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await spacedResponse.arrayBuffer())).toEqual(spaced);

    const traversal = await fetch(handle.url + '/api/resources/..%2Fgraph.sqlite');
    expect(traversal.status).toBe(404);

    const missing = await fetch(handle.url + '/api/resources/missing.png');
    expect(missing.status).toBe(404);

    const unknown = await getJson<{ ok: boolean; error: { code: string } }>(
      handle.url + '/api/nope',
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: expect.any(String) } });

    const rootPage = await fetch(handle.url + '/');
    expect(rootPage.status).toBe(404);

    const diagnostics = await getJson<{ ok: boolean; diagnostics: unknown[] }>(
      handle.url + '/api/diagnostics',
    );
    expect(diagnostics.body).toEqual({ ok: true, diagnostics: [] });
  });
});

describe('next service：service.json 生命周期', () => {
  it('port 0 写实际端口；stop 只删除自己的描述文件', async () => {
    const seeded = await seedWorkspace();
    const handle = await start(seeded);
    const descriptorPath = path.join(seeded.root, '.aichat', 'runtime', 'service.json');

    const raw = await fs.readFile(descriptorPath, 'utf8');
    const descriptor = JSON.parse(raw) as {
      version: number;
      url: string;
      workspaceId: string;
      instanceId: string;
      pid: number;
      rootPath: string;
      program?: { program: string };
    };
    expect(descriptor.version).toBe(1);
    expect(descriptor.url).toBe(handle.url);
    expect(descriptor.workspaceId).toBe(seeded.workspaceId);
    expect(descriptor.instanceId).toBe(handle.instanceId);
    expect(descriptor.pid).toBe(process.pid);
    expect(descriptor.rootPath).toBe(seeded.root);
    expect(descriptor.program?.program).toBe('aichat-graph');
    const port = Number(new URL(handle.url).port);
    expect(port).toBeGreaterThan(0);

    // 启动后核对：descriptor 的 url 能直接取到一致身份的 /api/workspace。
    const viaDescriptor = await getJson<WorkspaceResponse>(descriptor.url + '/api/workspace');
    expect(viaDescriptor.status).toBe(200);
    expect(viaDescriptor.body).toMatchObject({
      instanceId: handle.instanceId,
      workspaceId: seeded.workspaceId,
      revision: handle.revision,
      rootPath: seeded.root,
      stale: false,
    });
    expect(viaDescriptor.body.program?.interfaceVersion).toBe(4);

    await handle.stop();
    await expect(fs.readFile(descriptorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // 被其他实例覆盖的描述文件不能在 stop 时删除。
    const seededTwo = await seedWorkspace('第二库');
    const second = await startGraphService({
      root: seededTwo.root,
      port: 0,
      webRoot: null,
      appRoot: seededTwo.parent,
    });
    try {
      const secondPath = path.join(seededTwo.root, '.aichat', 'runtime', 'service.json');
      const foreign = {
        version: 1,
        url: 'http://127.0.0.1:1',
        workspaceId: seededTwo.workspaceId,
        instanceId: 'inst_' + 'a'.repeat(32),
        pid: process.pid,
        rootPath: seededTwo.root,
      };
      await fs.writeFile(secondPath, JSON.stringify(foreign), 'utf8');
      await second.stop();
      const kept = JSON.parse(await fs.readFile(secondPath, 'utf8')) as { instanceId: string };
      expect(kept.instanceId).toBe('inst_' + 'a'.repeat(32));
    } finally {
      await fs.rm(path.join(seededTwo.root, '.aichat'), { recursive: true, force: true });
    }
  });

  it('没有 graph.sqlite 时明确失败，不隐式建库', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-next-server-empty-'));
    temporaryRoots.push(parent);
    const root = path.join(parent, 'workspace');
    await fs.mkdir(root, { recursive: true });
    await expect(
      startGraphService({ root, port: 0, webRoot: null, appRoot: parent }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe('next service：导出接口注入', () => {
  const statusOf = (topicId: string): TopicExportStatus => ({
    topicId,
    topicTitle: '主线',
    targetPath: null,
    state: 'unset',
    sourceFingerprint: null,
    exportedFingerprint: null,
    exportedRevision: null,
    lastSuccessAt: null,
    error: null,
    resourceDiagnostics: [],
    targetHash: null,
    targetPresent: false,
  });

  function fakeExports(topicId: string): {
    manager: ExportManagerLike;
    calls: string[];
  } {
    const calls: string[] = [];
    const manager: ExportManagerLike = {
      async init() {
        calls.push('init');
      },
      statuses: () => [statusOf(topicId)],
      status: (id) => statusOf(id),
      async bindTarget(id, target) {
        calls.push('bind:' + id + ':' + String(target));
        return { ...statusOf(id), targetPath: target, state: target === null ? 'unset' : 'pending' };
      },
      async retry(id) {
        calls.push('retry:' + id);
        return statusOf(id);
      },
      schedule(topicIds) {
        calls.push('schedule:' + topicIds.join(','));
      },
      close() {
        calls.push('close');
      },
    };
    return { manager, calls };
  }

  it('commit 后发布快照事件并调度受影响主题；replay 不重复发布', async () => {
    const seeded = await seedWorkspace();
    const runtime = await GraphRuntime.open(seeded.root);
    try {
      const fake = fakeExports(seeded.topicId);
      runtime.attachExports(fake.manager);
      const events: GraphEvent[] = [];
      const unsubscribe = runtime.subscribe((event) => events.push(event));
      const request: AgentChangeRequest = {
        workspaceId: seeded.workspaceId,
        requestId: requestId(),
        action: {
          action: 'batch',
          topicId: seeded.topicId,
          ops: [
            {
              op: 'edit',
              target: { id: seeded.rootNodeId, revision: 1 },
              patch: { append: 'runtime 事件追加。' },
            },
          ],
        },
      };
      const response = runtime.commit(request, 'commit-hash-1');
      expect('dryRun' in response).toBe(false);
      if (!('dryRun' in response)) expect(response.state).toBe('committed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'snapshot',
        instanceId: runtime.instanceId,
        changedNodeIds: [seeded.rootNodeId],
        changedTopicIds: [seeded.topicId],
        stale: false,
      });
      expect(fake.calls).toContain('schedule:' + seeded.topicId);

      const replay = runtime.commit(request, 'commit-hash-1');
      if ('dryRun' in replay) throw new Error('replay 不应是 dry-run');
      expect(replay.replayed).toBe(true);
      expect(events).toHaveLength(1);

      runtime.publishExport(statusOf(seeded.topicId));
      expect(events[1]).toMatchObject({ event: 'export', instanceId: runtime.instanceId });
      unsubscribe();
    } finally {
      runtime.close();
    }
  });

  it('createGraphApp 可注入导出管理器；缺省时导出接口 503', async () => {
    const seeded = await seedWorkspace();
    const runtime = await GraphRuntime.open(seeded.root);
    try {
      const fake = fakeExports(seeded.topicId);
      const app = createGraphApp({ runtime, webRoot: null, exports: fake.manager });
      const exportsResponse = await app.fetch(new Request('http://127.0.0.1/api/exports'));
      expect(exportsResponse.status).toBe(200);
      const exportsBody = (await exportsResponse.json()) as { topics: TopicExportStatus[] };
      expect(exportsBody.topics[0]?.topicId).toBe(seeded.topicId);

      const bind = await app.fetch(
        new Request('http://127.0.0.1/api/exports/' + seeded.topicId + '/target', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'C:/tmp/out.html' }),
        }),
      );
      expect(bind.status).toBe(200);
      expect(fake.calls).toContain('bind:' + seeded.topicId + ':C:/tmp/out.html');

      const retry = await app.fetch(
        new Request('http://127.0.0.1/api/exports/' + seeded.topicId + '/retry', {
          method: 'POST',
        }),
      );
      expect(retry.status).toBe(200);

      const disabled = createGraphApp({ runtime, webRoot: null, exports: null });
      const unavailable = await disabled.fetch(new Request('http://127.0.0.1/api/exports'));
      expect(unavailable.status).toBe(503);
      expect(((await unavailable.json()) as { error: { code: string } }).error.code).toBe(
        'EXPORT_UNAVAILABLE',
      );
    } finally {
      runtime.close();
    }
  });
});
