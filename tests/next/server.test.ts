/**
 * SQLite 服务运行时的端到端契约：
 * 临时数据库 + 随机端口，覆盖 workspace／graph／detail／read／search、Agent 写入、
 * importance、资源、状态查询、导出注入与 service.json 生命周期。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
const networkServers: net.Server[] = [];

afterEach(async () => {
  for (const handle of running.splice(0)) {
    await handle.stop().catch(() => undefined);
  }
  await Promise.all(
    networkServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          try {
            server.close(() => resolve());
          } catch {
            resolve();
          }
        }),
    ),
  );
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

function runtimePreferencesPathOf(root: string): string {
  return path.join(root, '.aichat', 'local', 'runtime.json');
}

/** 读取 .aichat/local/runtime.json 的 preferredPort；没有/损坏时 null。 */
async function preferredPortOf(root: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(runtimePreferencesPathOf(root), 'utf8'),
    ) as { preferredPort?: unknown };
    return typeof parsed.preferredPort === 'number' ? parsed.preferredPort : null;
  } catch {
    return null;
  }
}

function listenNet(server: net.Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function occupyTcpPort(port = 0): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  const address = await listenNet(server, port);
  networkServers.push(server);
  return { server, port: address.port };
}

async function releaseTcp(blocker: { server: net.Server }): Promise<void> {
  const index = networkServers.indexOf(blocker.server);
  if (index >= 0) networkServers.splice(index, 1);
  await new Promise<void>((resolve) => {
    try {
      blocker.server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** 探测某端口当前是否可绑定；可绑定时返回 true 并立即释放。 */
async function portIsFree(port: number): Promise<boolean> {
  const server = net.createServer();
  try {
    await listenNet(server, port);
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待条件超时');
}

async function serviceReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url + '/api/workspace');
    return response.ok;
  } catch {
    return false;
  }
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

describe('next service：nodeRevisions 与差异落库', () => {
  interface NodeRevisionBody {
    node: { revision: number };
  }

  it('新建/真实修改给可用版本，noop 给目标版本，删除省略，replay 原样，dry-run 不伪造', async () => {
    const seeded = await seedWorkspace();
    const handle = await start(seeded);
    const workspaceId = seeded.workspaceId;

    // 新建主题：新节点 revision 1。
    const created = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
      workspaceId,
      requestId: requestId(),
      action: {
        action: 'createTopic',
        topicTitle: '版本主题',
        node: { title: '版本起点', body: '版本正文。' },
      },
    });
    expect(created.status).toBe(200);
    const nodeId = created.body.created.nodeIds[0] as string;
    expect(created.body.nodeRevisions).toEqual({ [nodeId]: 1 });

    // 直接用返回的 revision 继续编辑，无需额外读。
    const firstEdit = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
      workspaceId,
      requestId: requestId(),
      action: {
        action: 'batch',
        topicId: created.body.created.topicId,
        ops: [
          {
            op: 'edit',
            target: { id: nodeId, revision: created.body.nodeRevisions[nodeId] as number },
            patch: { title: '版本标题' },
          },
        ],
      },
    });
    expect(firstEdit.status).toBe(200);
    expect(firstEdit.body.state).toBe('committed');
    expect(firstEdit.body.nodeRevisions).toEqual({ [nodeId]: 2 });

    const secondRequest = {
      workspaceId,
      requestId: requestId(),
      action: {
        action: 'batch',
        topicId: created.body.created.topicId,
        ops: [
          {
            op: 'edit',
            target: { id: nodeId, revision: firstEdit.body.nodeRevisions[nodeId] as number },
            patch: { append: '用映射版本追加。' },
          },
        ],
      },
    };
    const secondEdit = await postJson<AgentChangeResponse>(
      handle.url + '/api/agent/changes',
      secondRequest,
    );
    expect(secondEdit.status).toBe(200);
    expect(secondEdit.body.nodeRevisions).toEqual({ [nodeId]: 3 });

    // 同一请求体重放：原样返回当时的映射，不按现在重新计算。
    const replay = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', secondRequest);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.nodeRevisions).toEqual({ [nodeId]: 3 });

    // noop：标题没变时也给目标实际版本，changedNodeIds 为空。
    const noop = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
      workspaceId,
      requestId: requestId(),
      action: {
        action: 'batch',
        topicId: created.body.created.topicId,
        ops: [
          { op: 'edit', target: { id: nodeId, revision: 3 }, patch: { title: '版本标题' } },
        ],
      },
    });
    expect(noop.body.state).toBe('noop');
    expect(noop.body.changedNodeIds).toEqual([]);
    expect(noop.body.nodeRevisions).toEqual({ [nodeId]: 3 });

    // 新节点给 1；删除后同一次响应里不出现被删节点。
    const branch = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
      workspaceId,
      requestId: requestId(),
      action: {
        action: 'createNext',
        from: { id: nodeId, revision: 3 },
        description: '挂一张临时卡',
        node: { title: '临时卡', body: '临时正文。' },
      },
    });
    expect(branch.status).toBe(200);
    const branchId = branch.body.created.nodeIds[0] as string;
    expect(branch.body.nodeRevisions).toEqual({ [branchId]: 1 });

    const removed = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
      workspaceId,
      requestId: requestId(),
      action: { action: 'delete', target: { id: branchId, revision: 1 } },
    });
    expect(removed.status).toBe(200);
    expect(removed.body.state).toBe('committed');
    expect(removed.body.changedNodeIds).toContain(branchId);
    expect(removed.body.nodeRevisions).toEqual({});

    // dry-run：不返回、也不伪造提交后版本。
    const dry = await postJson<AgentCheckResponse>(handle.url + '/api/agent/changes', {
      workspaceId,
      requestId: requestId(),
      dryRun: true,
      action: {
        action: 'batch',
        topicId: created.body.created.topicId,
        ops: [{ op: 'edit', target: { id: nodeId, revision: 3 }, patch: { title: 'dry' } }],
      },
    });
    expect(dry.status).toBe(200);
    expect(dry.body).not.toHaveProperty('nodeRevisions');
    const afterDry = await getJson<NodeRevisionBody>(handle.url + '/api/nodes/' + nodeId);
    expect(afterDry.body.node.revision).toBe(3);
  });

  it('rearrange 最终无差异 → noop，节点/工作区 revision 不增长', async () => {
    const seeded = await seedWorkspace();
    const handle = await start(seeded);

    const branch = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
      workspaceId: seeded.workspaceId,
      requestId: requestId(),
      action: {
        action: 'createBranch',
        from: { id: seeded.rootNodeId, revision: 1 },
        description: '普通侧枝',
        node: { title: '侧枝', body: '侧枝正文。', side: 'right', order: 10 },
      },
    });
    expect(branch.status).toBe(200);
    const branchId = branch.body.created.nodeIds[0] as string;
    const revisionBefore = (await getJson<GraphResponse>(handle.url + '/api/graph')).body.revision;

    const rearranged = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
      workspaceId: seeded.workspaceId,
      requestId: requestId(),
      action: {
        action: 'rearrange',
        edits: [
          {
            target: { id: branchId, revision: 1 },
            from: { id: seeded.rootNodeId, revision: 1 },
            flow: 'branch',
            description: '普通侧枝',
            order: 10,
          },
        ],
      },
    });
    expect(rearranged.status).toBe(200);
    expect(rearranged.body.state).toBe('noop');
    expect(rearranged.body.revision).toBe(revisionBefore);
    expect(rearranged.body.nodeRevisions).toEqual({ [branchId]: 1 });
    expect(rearranged.body.changedNodeIds).toEqual([]);
    const graph = await getJson<GraphResponse>(handle.url + '/api/graph');
    expect(graph.body.revision).toBe(revisionBefore);
  });

  it('commit 只写真实变化的节点/主题行；noop 不写业务表', async () => {
    const seeded = await seedWorkspace();
    const handle = await start(seeded);
    const observer = new DatabaseSync(path.join(seeded.root, 'graph.sqlite'));
    try {
      observer.exec(`
        CREATE TABLE _writes(kind TEXT, id TEXT);
        CREATE TRIGGER w_nodes_ins AFTER INSERT ON nodes BEGIN INSERT INTO _writes VALUES('node_insert', NEW.id); END;
        CREATE TRIGGER w_nodes_upd AFTER UPDATE ON nodes BEGIN INSERT INTO _writes VALUES('node_update', NEW.id); END;
        CREATE TRIGGER w_nodes_del AFTER DELETE ON nodes BEGIN INSERT INTO _writes VALUES('node_delete', OLD.id); END;
        CREATE TRIGGER w_topics_ins AFTER INSERT ON topics BEGIN INSERT INTO _writes VALUES('topic_insert', NEW.id); END;
        CREATE TRIGGER w_topics_upd AFTER UPDATE ON topics BEGIN INSERT INTO _writes VALUES('topic_update', NEW.id); END;
        CREATE TRIGGER w_topics_del AFTER DELETE ON topics BEGIN INSERT INTO _writes VALUES('topic_delete', OLD.id); END;
        CREATE TRIGGER w_workspace_upd AFTER UPDATE ON workspace BEGIN INSERT INTO _writes VALUES('workspace_update', NEW.id); END;
        CREATE TRIGGER w_requests_ins AFTER INSERT ON requests BEGIN INSERT INTO _writes VALUES('request_insert', NEW.request_id); END;
      `);

      const edit = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
        workspaceId: seeded.workspaceId,
        requestId: requestId(),
        action: {
          action: 'batch',
          topicId: seeded.topicId,
          ops: [
            { op: 'edit', target: { id: seeded.rootNodeId, revision: 1 }, patch: { title: '只改这一行' } },
          ],
        },
      });
      expect(edit.status).toBe(200);
      const writes = observer
        .prepare('SELECT kind, id FROM _writes ORDER BY kind, id')
        .all() as Array<{ kind: string; id: string }>;
      const idsOf = (kind: string): string[] =>
        writes.filter((row) => row.kind === kind).map((row) => row.id);
      expect(idsOf('node_insert')).toEqual([]);
      expect(idsOf('node_delete')).toEqual([]);
      // 只有目标节点被 UPDATE，其他节点不写。
      expect(idsOf('node_update')).toEqual([seeded.rootNodeId]);
      expect(idsOf('topic_update')).toEqual([seeded.topicId]);
      expect(idsOf('workspace_update')).toHaveLength(1);
      expect(idsOf('request_insert')).toHaveLength(1);

      observer.exec('DELETE FROM _writes');
      const current = await getJson<NodeRevisionBody>(handle.url + '/api/nodes/' + seeded.rootNodeId);
      const noop = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
        workspaceId: seeded.workspaceId,
        requestId: requestId(),
        action: {
          action: 'batch',
          topicId: seeded.topicId,
          ops: [
            {
              op: 'edit',
              target: { id: seeded.rootNodeId, revision: current.body.node.revision },
              patch: { title: '只改这一行' },
            },
          ],
        },
      });
      expect(noop.body.state).toBe('noop');
      const noopWrites = observer
        .prepare('SELECT kind FROM _writes')
        .all() as Array<{ kind: string }>;
      // 幂等记录仍写入，但节点/主题/工作区都不写。
      expect(noopWrites.filter((row) => row.kind !== 'request_insert')).toEqual([]);
      expect(noopWrites.filter((row) => row.kind === 'request_insert')).toHaveLength(1);

      // 新建：只 INSERT 新节点行，不重建其他节点/主题。
      observer.exec('DELETE FROM _writes');
      const branch = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
        workspaceId: seeded.workspaceId,
        requestId: requestId(),
        action: {
          action: 'createNext',
          from: { id: seeded.rootNodeId, revision: current.body.node.revision },
          description: '插入一行',
          node: { title: '新行', body: '新行正文。' },
        },
      });
      expect(branch.status).toBe(200);
      const branchId = branch.body.created.nodeIds[0] as string;
      const createWrites = observer
        .prepare('SELECT kind, id FROM _writes ORDER BY kind, id')
        .all() as Array<{ kind: string; id: string }>;
      const createdIdsOf = (kind: string): string[] =>
        createWrites.filter((row) => row.kind === kind).map((row) => row.id);
      expect(createdIdsOf('node_insert')).toEqual([branchId]);
      expect(createdIdsOf('node_update')).toEqual([]);
      expect(createdIdsOf('node_delete')).toEqual([]);
      expect(createdIdsOf('topic_insert')).toEqual([]);
      // 主题 lastChange 更新仍是单独 UPDATE，不会全表重建。
      expect(createdIdsOf('topic_update')).toEqual([seeded.topicId]);
      expect(createdIdsOf('request_insert')).toHaveLength(1);

      // 删除：只 DELETE 目标节点行。
      observer.exec('DELETE FROM _writes');
      const deleted = await postJson<AgentChangeResponse>(handle.url + '/api/agent/changes', {
        workspaceId: seeded.workspaceId,
        requestId: requestId(),
        action: { action: 'delete', target: { id: branchId, revision: 1 } },
      });
      expect(deleted.body.state).toBe('committed');
      const deleteWrites = observer
        .prepare('SELECT kind, id FROM _writes ORDER BY kind, id')
        .all() as Array<{ kind: string; id: string }>;
      const deletedIdsOf = (kind: string): string[] =>
        deleteWrites.filter((row) => row.kind === kind).map((row) => row.id);
      expect(deletedIdsOf('node_delete')).toEqual([branchId]);
      expect(deletedIdsOf('node_insert')).toEqual([]);
      expect(deletedIdsOf('node_update')).toEqual([]);
    } finally {
      observer.close();
    }
  });
});

describe('next service：稳定端口、启动占位与运行控制', () => {
  it('省略 port 时 remembered → 4317 → 空闲，并在实际绑定后记录 preferredPort', async () => {
    const seeded = await seedWorkspace();
    // 4317 可能被本机日用服务占用：能绑定时首个服务应恰好选 4317。
    const free4317 = await portIsFree(4317);

    const first = await startGraphService({
      root: seeded.root,
      webRoot: null,
      appRoot: seeded.parent,
    });
    running.push(first);
    const firstPort = Number(new URL(first.url).port);
    expect(firstPort).toBeGreaterThan(0);
    if (free4317) expect(firstPort).toBe(4317);
    // 只有实际绑定成功后才写入稳定端口。
    expect(await preferredPortOf(seeded.root)).toBe(firstPort);

    await first.stop();
    const second = await startGraphService({
      root: seeded.root,
      webRoot: null,
      appRoot: seeded.parent,
    });
    running.push(second);
    expect(Number(new URL(second.url).port)).toBe(firstPort);
  });

  it('remembered 端口被占用时改用空闲端口并更新记录', async () => {
    const seeded = await seedWorkspace();
    const first = await startGraphService({
      root: seeded.root,
      webRoot: null,
      appRoot: seeded.parent,
    });
    running.push(first);
    const preferred = Number(new URL(first.url).port);
    await first.stop();

    const blocker = await occupyTcpPort(preferred);
    try {
      const second = await startGraphService({
        root: seeded.root,
        webRoot: null,
        appRoot: seeded.parent,
      });
      running.push(second);
      const secondPort = Number(new URL(second.url).port);
      expect(secondPort).not.toBe(preferred);
      expect(await preferredPortOf(seeded.root)).toBe(secondPort);
    } finally {
      await releaseTcp(blocker);
    }
  });

  it('同一数据库不能并发启动；失败与 stop 都会释放占位且不写偏好', async () => {
    const seeded = await seedWorkspace();
    const first = await startGraphService({
      root: seeded.root,
      port: 0,
      webRoot: null,
      appRoot: seeded.parent,
    });
    running.push(first);
    await expect(
      startGraphService({ root: seeded.root, port: 0, webRoot: null, appRoot: seeded.parent }),
    ).rejects.toMatchObject({ code: 'SERVICE_ALREADY_RUNNING' });

    await first.stop();
    const second = await startGraphService({
      root: seeded.root,
      port: 0,
      webRoot: null,
      appRoot: seeded.parent,
    });
    running.push(second);
    await second.stop();

    // 端口绑定失败：启动占位必须释放，且没有实际绑定就不写 preferredPort。
    const fresh = await seedWorkspace();
    const blocker = await occupyTcpPort();
    let failure: unknown = null;
    try {
      await startGraphService({
        root: fresh.root,
        port: blocker.port,
        webRoot: null,
        appRoot: fresh.parent,
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as { code?: string }).code).toBe('EADDRINUSE');
    expect(await preferredPortOf(fresh.root)).toBeNull();
    await releaseTcp(blocker);

    const recovered = await startGraphService({
      root: fresh.root,
      port: 0,
      webRoot: null,
      appRoot: fresh.parent,
    });
    running.push(recovered);
    expect(recovered.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('runtimeControl 注入：端点校验 workspaceId／instanceId，缺失控制时 501', async () => {
    const seeded = await seedWorkspace();
    const runtime = await GraphRuntime.open(seeded.root);
    try {
      const calls: string[] = [];
      const app = createGraphApp({
        runtime,
        webRoot: null,
        runtimeControl: {
          requestStop: () => {
            calls.push('stop');
          },
          openWorkspace: () => {
            calls.push('open');
          },
        },
      });
      const post = async (pathName: string, body: unknown): Promise<Response> =>
        app.fetch(
          new Request('http://127.0.0.1' + pathName, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );
      const good = { workspaceId: runtime.workspaceId, instanceId: runtime.instanceId };

      const wrongWorkspace = await post('/api/runtime/stop', {
        ...good,
        workspaceId: 'w_' + 'f'.repeat(32),
      });
      expect(wrongWorkspace.status).toBe(409);
      expect((await wrongWorkspace.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'RUNTIME_IDENTITY_MISMATCH' },
      });

      const wrongInstance = await post('/api/runtime/stop', {
        ...good,
        instanceId: 'inst_' + '0'.repeat(32),
      });
      expect(wrongInstance.status).toBe(409);
      expect((await wrongInstance.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'RUNTIME_INSTANCE_MISMATCH' },
      });
      expect(calls).toEqual([]);

      const stopped = await post('/api/runtime/stop', good);
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toEqual({ ok: true, state: 'stopping' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toEqual(['stop']);

      const opened = await post('/api/runtime/open-workspace', good);
      expect(opened.status).toBe(200);
      expect(await opened.json()).toEqual({ ok: true, state: 'started' });
      expect(calls).toEqual(['stop', 'open']);

      const withoutControl = createGraphApp({ runtime, webRoot: null });
      const unavailable = await withoutControl.fetch(
        new Request('http://127.0.0.1/api/runtime/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(good),
        }),
      );
      expect(unavailable.status).toBe(501);
      expect((await unavailable.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'RUNTIME_CONTROL_UNAVAILABLE' },
      });
    } finally {
      runtime.close();
    }
  });

  it('POST /api/runtime/stop 先响应 stopping，再由 startGraphService 停止服务', async () => {
    const seeded = await seedWorkspace();
    const handle = await startGraphService({
      root: seeded.root,
      port: 0,
      webRoot: null,
      appRoot: seeded.parent,
    });
    running.push(handle);
    const good = { workspaceId: handle.workspaceId, instanceId: handle.instanceId };

    const wrong = await postJson(handle.url + '/api/runtime/stop', {
      ...good,
      instanceId: 'inst_' + '0'.repeat(32),
    });
    expect(wrong.status).toBe(409);
    expect(await serviceReachable(handle.url)).toBe(true);

    const stopped = await postJson(handle.url + '/api/runtime/stop', good);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ ok: true, state: 'stopping' });
    await waitFor(async () => !(await serviceReachable(handle.url)));
    await expect(
      fs.readFile(path.join(seeded.root, '.aichat', 'runtime', 'service.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('launcher 缺失时 open-workspace 501，服务继续可用', async () => {
    const seeded = await seedWorkspace();
    const handle = await startGraphService({
      root: seeded.root,
      port: 0,
      webRoot: null,
      appRoot: seeded.parent,
      launcherPath: path.join(seeded.parent, 'missing-launcher.exe'),
    });
    running.push(handle);

    const response = await postJson(handle.url + '/api/runtime/open-workspace', {
      workspaceId: handle.workspaceId,
      instanceId: handle.instanceId,
    });
    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({ error: { code: 'LAUNCHER_UNAVAILABLE' } });
    expect(await serviceReachable(handle.url)).toBe(true);
  });

  it('launcher 存在时 open-workspace 返回 started（--choose-workspace 交给原生入口）', async () => {
    const seeded = await seedWorkspace();
    // 用可执行的 node 本身当 launcher：只验证 spawn 成功路径与响应契约。
    const handle = await startGraphService({
      root: seeded.root,
      port: 0,
      webRoot: null,
      appRoot: seeded.parent,
      launcherPath: process.execPath,
    });
    running.push(handle);

    const response = await postJson(handle.url + '/api/runtime/open-workspace', {
      workspaceId: handle.workspaceId,
      instanceId: handle.instanceId,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, state: 'started' });
    expect(await serviceReachable(handle.url)).toBe(true);
  });

  it('agentEntry 使用 installation.aichatCmdPath 与 skills/SKILL.md', async () => {
    const seeded = await seedWorkspace();
    const handle = await startGraphService({
      root: seeded.root,
      port: 0,
      webRoot: null,
      appRoot: seeded.parent,
    });
    running.push(handle);
    const workspace = await getJson<WorkspaceResponse>(handle.url + '/api/workspace');
    expect(workspace.body.agentEntry).toEqual({
      cliPath: path.join(seeded.parent, 'aichat.cmd'),
      skillPath: path.join(seeded.parent, 'skills', 'aichat-graph', 'SKILL.md'),
    });
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
