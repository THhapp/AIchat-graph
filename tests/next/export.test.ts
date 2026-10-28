import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeContentFingerprint,
  EXPORT_DATA_ELEMENT_ID,
} from '../../src/export/index.js';
import type { ExportManagerLike } from '../../src/next/export-contract.js';
import { createExportManager } from '../../src/next/export.js';
import type { AgentChangeResponse, OfflineTopicDocument, TopicExportStatus } from '../../src/next/protocol.js';
import { GraphStore } from '../../src/next/store.js';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const READER_SCRIPT = '(()=>{const e=document.getElementById("root");if(e)e.textContent="reader";})();';
const READER_STYLES = 'body{margin:0}';

const roots: string[] = [];
const managers: ExportManagerLike[] = [];
const stores: GraphStore[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  // close() 在队列排空后再关只读连接；给一个事件循环让 Windows 释放文件句柄。
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // 已关闭的连接忽略。
    }
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Fixture {
  base: string;
  root: string;
  appRoot: string;
  offline: string;
  output: string;
  store: GraphStore;
  workspaceId: string;
  topicId: string;
  rootNodeId: string;
  nextNodeId: string;
}

async function newFixture(): Promise<Fixture> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-next-export-'));
  roots.push(base);
  const root = path.join(base, 'workspace');
  const appRoot = path.join(base, 'app');
  const offline = path.join(base, 'offline');
  const output = path.join(base, 'output');
  await fs.mkdir(appRoot, { recursive: true });
  await fs.mkdir(offline, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(offline, 'reader.js'), READER_SCRIPT);
  await fs.writeFile(path.join(offline, 'reader.css'), READER_STYLES);

  const store = GraphStore.create(root, '测试讨论库');
  stores.push(store);
  const workspaceId = store.snapshot().workspaceId;
  const created = store.commit(
    {
      workspaceId,
      requestId: 'req-create-topic',
      action: {
        action: 'createTopic',
        key: 'topic-a',
        topicTitle: '讨论主题',
        node: { title: '根卡', body: '根卡正文。', state: 'agreed' },
      },
    },
    'hash-create-topic',
  ) as AgentChangeResponse;
  if (created.topicId === null || created.created.nodeIds[0] === undefined) {
    throw new Error('fixture: createTopic did not return ids');
  }
  const topicId = created.topicId;
  const rootNodeId = created.created.nodeIds[0];
  const next = store.commit(
    {
      workspaceId,
      requestId: 'req-create-next',
      action: {
        action: 'createNext',
        from: { id: rootNodeId, revision: 1 },
        description: '据此继续讨论下一步',
        node: {
          title: '续卡',
          summary: '续卡的显式摘要',
          body: '续卡正文。\n\n![图片](resources/pic.png)',
          state: 'proposed',
        },
      },
    },
    'hash-create-next',
  ) as AgentChangeResponse;
  const nextNodeId = next.created.nodeIds[0];
  if (nextNodeId === undefined) throw new Error('fixture: createNext did not return a node id');

  await fs.mkdir(path.join(root, 'resources'), { recursive: true });
  await fs.writeFile(path.join(root, 'resources', 'pic.png'), PNG_HEAD);
  return { base, root, appRoot, offline, output, store, workspaceId, topicId, rootNodeId, nextNodeId };
}

function managerFor(fixture: Fixture, onStatus?: (status: TopicExportStatus) => void): ExportManagerLike {
  const manager = createExportManager({
    root: fixture.root,
    appRoot: fixture.appRoot,
    offlineDirectory: fixture.offline,
    workspaceId: fixture.workspaceId,
    workspaceName: '测试讨论库',
    ...(onStatus === undefined ? {} : { onStatus }),
  });
  managers.push(manager);
  return manager;
}

function editBody(
  fixture: Fixture,
  requestId: string,
  nodeId: string,
  revision: number,
  patch: { append?: string; replace?: Array<{ old: string; new: string }> },
): AgentChangeResponse {
  return fixture.store.commit(
    {
      workspaceId: fixture.workspaceId,
      requestId,
      action: {
        action: 'batch',
        topicId: fixture.topicId,
        ops: [{ op: 'edit', target: { id: nodeId, revision }, patch }],
      },
    },
    'hash-' + requestId,
  ) as AgentChangeResponse;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timeout');
}

function embeddedDocument(html: string): OfflineTopicDocument {
  const marker = '<script id="' + EXPORT_DATA_ELEMENT_ID + '" type="application/json">';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('embedded document marker not found');
  const jsonStart = html.indexOf('>', start) + 1;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  if (jsonEnd < 0) throw new Error('embedded document end not found');
  return JSON.parse(html.slice(jsonStart, jsonEnd)) as OfflineTopicDocument;
}

describe('SQLite topic export manager', () => {
  it('freezes one topic from the database into the existing single-file HTML', async () => {
    const fixture = await newFixture();
    const statuses: TopicExportStatus[] = [];
    const manager = managerFor(fixture, (status) => statuses.push(status));
    await manager.init();

    const before = manager.statuses().find((status) => status.topicId === fixture.topicId);
    expect(before?.state).toBe('unset');
    expect(before?.targetPath).toBeNull();

    const target = path.join(fixture.output, 'topic.html');
    const bound = await manager.bindTarget(fixture.topicId, target);
    expect(bound.state).toBe('ready');
    expect(bound.targetPath).toBe(await fs.realpath(target).catch(() => target));
    expect(bound.targetPresent).toBe(true);
    expect(bound.exportedRevision).toBe(fixture.store.snapshot().revision);
    expect(bound.sourceFingerprint).toBe(bound.exportedFingerprint);

    const html = await fs.readFile(target, 'utf8');
    expect(html).toContain(EXPORT_DATA_ELEMENT_ID);
    const document = embeddedDocument(html);
    expect(document.format).toBe(1);
    expect(document.workspaceId).toBe(fixture.workspaceId);
    expect(document.topic.id).toBe(fixture.topicId);
    expect(document.topic.title).toBe('讨论主题');
    expect(document.nodes).toHaveLength(2);
    expect(document.boundaryNodes).toEqual([]);
    expect(document.fingerprint).toBe(computeContentFingerprint(document));
    expect(document.nodes.map((node) => node.body).join('\n')).toContain('续卡正文。');
    expect(document.nodes.map((node) => node.body).join('\n')).toContain('根卡正文。');
    expect(document.resources['resources/pic.png']).toMatch(/^data:image\/png;base64,/);
    for (const node of document.nodes) {
      // 领域节点只带真实字段：不应伪造 Markdown 文件路径或文件哈希。
      expect(node).not.toHaveProperty('path');
      expect(node).not.toHaveProperty('fileHash');
      expect(typeof node.important).toBe('boolean');
      expect(typeof node.revision).toBe('number');
      expect(node.revision).toBeGreaterThan(0);
    }

    const configText = await fs.readFile(
      path.join(fixture.root, '.aichat', 'local', 'exports.json'),
      'utf8',
    );
    const config = JSON.parse(configText) as {
      format: number;
      workspaceId: string;
      topics: Record<string, { targetPath: string }>;
    };
    expect(config.format).toBe(1);
    expect(config.workspaceId).toBe(fixture.workspaceId);
    expect(config.topics[fixture.topicId]?.targetPath).toBe(bound.targetPath);

    // 状态回调覆盖 pending → ready，服务端据此发 SSE。
    expect(statuses.some((status) => status.state === 'pending' || status.state === 'writing')).toBe(true);
    expect(statuses.some((status) => status.state === 'ready')).toBe(true);
  });

  it('updates the same path after a content change without touching other topics', async () => {
    const fixture = await newFixture();
    const manager = managerFor(fixture);
    await manager.init();
    const target = path.join(fixture.output, 'topic.html');
    const first = await manager.bindTarget(fixture.topicId, target);
    expect(first.state).toBe('ready');
    const firstHtml = await fs.readFile(target, 'utf8');

    editBody(fixture, 'req-append', fixture.rootNodeId, 1, { append: '补充：再想想这个问题。' });
    expect(manager.status(fixture.topicId).state).toBe('stale');
    const retried = await manager.retry(fixture.topicId);
    expect(retried.state).toBe('ready');
    expect(retried.targetPath).toBe(first.targetPath);
    expect(retried.exportedRevision).toBeGreaterThan(first.exportedRevision ?? 0);

    const secondHtml = await fs.readFile(target, 'utf8');
    expect(secondHtml).not.toBe(firstHtml);
    expect(embeddedDocument(secondHtml).nodes.map((node) => node.body).join('\n')).toContain(
      '补充：再想想这个问题。',
    );
  });

  it('keeps the old product when a resource is missing and recovers on a later retry', async () => {
    const fixture = await newFixture();
    const manager = managerFor(fixture);
    await manager.init();
    const target = path.join(fixture.output, 'topic.html');
    await manager.bindTarget(fixture.topicId, target);
    const goodHtml = await fs.readFile(target);

    editBody(fixture, 'req-bad-image', fixture.nextNodeId, 1, {
      append: '![坏图](resources/missing.png)',
    });
    const failed = await manager.retry(fixture.topicId);
    expect(failed.state).toBe('error');
    expect(failed.error).not.toBeNull();
    expect(failed.resourceDiagnostics.length).toBeGreaterThan(0);
    // 失败保留旧成品：字节完全不变。
    const afterFailure = await fs.readFile(target);
    expect(afterFailure.equals(goodHtml)).toBe(true);

    editBody(fixture, 'req-fix-image', fixture.nextNodeId, 2, {
      replace: [{ old: 'resources/missing.png', new: 'resources/pic.png' }],
    });
    const recovered = await manager.retry(fixture.topicId);
    expect(recovered.state).toBe('ready');
    const recoveredHtml = await fs.readFile(target);
    expect(recoveredHtml.equals(goodHtml)).toBe(false);
    expect(embeddedDocument(recoveredHtml.toString('utf8')).nodes.map((node) => node.body).join('\n')).toContain(
      '![图片](resources/pic.png)',
    );
  });

  it('rejects targets inside the workspace, foreign files and non-html paths', async () => {
    const fixture = await newFixture();
    const manager = managerFor(fixture);
    await manager.init();

    await expect(manager.bindTarget(fixture.topicId, 'relative.html')).rejects.toMatchObject({
      code: 'EXPORT_TARGET_INVALID',
    });
    await expect(
      manager.bindTarget(fixture.topicId, path.join(fixture.root, 'inside.html')),
    ).rejects.toMatchObject({ code: 'EXPORT_TARGET_FORBIDDEN' });
    await expect(
      manager.bindTarget(fixture.topicId, path.join(fixture.output, 'missing-dir', 'x.html')),
    ).rejects.toMatchObject({ code: 'EXPORT_TARGET_INVALID' });

    const occupied = path.join(fixture.output, 'occupied.html');
    await fs.writeFile(occupied, '<html>别人的文件</html>');
    await expect(manager.bindTarget(fixture.topicId, occupied)).rejects.toMatchObject({
      code: 'EXPORT_TARGET_OCCUPIED',
    });
    expect(await fs.readFile(occupied, 'utf8')).toBe('<html>别人的文件</html>');

    // 失败绑定不产生配置、成品。
    expect(manager.status(fixture.topicId).state).toBe('unset');
  });

  it('refuses to overwrite an externally modified target until it is rebound', async () => {
    const fixture = await newFixture();
    const manager = managerFor(fixture);
    await manager.init();
    const target = path.join(fixture.output, 'topic.html');
    await manager.bindTarget(fixture.topicId, target);

    await fs.appendFile(target, '\n<!-- 外部改动 -->\n');
    editBody(fixture, 'req-external', fixture.rootNodeId, 1, { append: '外部改动后的内容。' });
    const conflicted = await manager.retry(fixture.topicId);
    expect(conflicted.state).toBe('error');
    expect(conflicted.error).toContain('外部改动');
    expect((await fs.readFile(target, 'utf8')).endsWith('<!-- 外部改动 -->\n')).toBe(true);

    // 用户重新选同一个位置＝明确授权覆盖；重新绑定后恢复为最新成品。
    const rebound = await manager.bindTarget(fixture.topicId, target);
    expect(rebound.state).toBe('ready');
    expect((await fs.readFile(target, 'utf8')).endsWith('<!-- 外部改动 -->\n')).toBe(false);
  });

  it('schedules an export after a commit without blocking the caller', async () => {
    const fixture = await newFixture();
    const manager = managerFor(fixture);
    await manager.init();
    const target = path.join(fixture.output, 'topic.html');
    await manager.bindTarget(fixture.topicId, target);

    editBody(fixture, 'req-schedule', fixture.rootNodeId, 1, { append: '提交后按计划重导出的内容。' });
    expect(manager.status(fixture.topicId).state).toBe('stale');

    manager.schedule([fixture.topicId, 't_does_not_exist']);
    await waitFor(() => manager.status(fixture.topicId).state === 'ready');
    const document = embeddedDocument(await fs.readFile(target, 'utf8'));
    expect(document.nodes.map((node) => node.body).join('\n')).toContain('提交后按计划重导出的内容。');
  });

  it('startup fills in a stale product and unbinding keeps the file', async () => {
    const fixture = await newFixture();
    const first = managerFor(fixture);
    await first.init();
    const target = path.join(fixture.output, 'topic.html');
    await first.bindTarget(fixture.topicId, target);
    const staleHtml = await fs.readFile(target);
    first.close();

    editBody(fixture, 'req-later', fixture.rootNodeId, 1, { append: '停机期间新增的内容。' });
    const second = managerFor(fixture);
    await second.init();
    const refreshed = second.status(fixture.topicId);
    expect(refreshed.state).toBe('ready');
    expect((await fs.readFile(target)).equals(staleHtml)).toBe(false);
    expect(embeddedDocument(await fs.readFile(target, 'utf8')).nodes.map((node) => node.body).join('\n')).toContain(
      '停机期间新增的内容。',
    );

    const unbound = await second.bindTarget(fixture.topicId, null);
    expect(unbound.state).toBe('unset');
    expect(unbound.targetPath).toBeNull();
    expect(await fs.readFile(target)).not.toHaveLength(0);
  });
});
