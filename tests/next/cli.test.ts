/**
 * Interface 4 CLI 测试：临时 SQLite 工作区 + 进程内 HTTP 服务替身。
 *
 * 写路径严格按 CLI→POST /api/agent/changes；替身用 GraphStore.commit 真正落库，
 * 因此 edit／batch／read／resume／status 可以在同一临时库上串起来验证。
 * 读取／检索／validate／status 不需要 HTTP，直接读 SQLite。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { main, type RunProcess, type RunResult } from '../../src/next/cli.js';
import type { SpawnLike } from '../../src/next/client.js';
import type { InstallationPaths } from '../../src/next/installation.js';
import { INTERFACE_VERSION } from '../../src/next/protocol.js';
import { GraphStore } from '../../src/next/store.js';
import { DomainError } from '../../src/next/model.js';
import type { ProgramInfo } from '../../src/next/protocol.js';
import { loadProgramInfo } from '../../src/build-info.js';

const temporaryRoots: string[] = [];
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function jsonOf<T = Record<string, unknown>>(text: string): T {
  return JSON.parse(text) as T;
}

async function newParent(prefix = 'aichat-next-cli-'): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(parent);
  return parent;
}

async function initWorkspace(): Promise<{ parent: string; root: string; workspaceId: string; schemaVersion: number }> {
  const parent = await newParent();
  const root = path.join(parent, 'db');
  const result = await main(['init', root], { cwd: parent });
  expect(result.exitCode, result.stderr).toBe(0);
  const payload = jsonOf(result.stdout);
  return {
    parent,
    root,
    workspaceId: payload['workspaceId'] as string,
    schemaVersion: payload['schemaVersion'] as number,
  };
}

function testProgram(): ProgramInfo {
  return {
    program: 'aichat-graph',
    version: loadProgramInfo().version,
    interfaceVersion: INTERFACE_VERSION,
    buildId: loadProgramInfo().buildId,
    commit: null,
    builtAt: null,
    manifest: 'dev',
  };
}

interface MockService {
  readonly url: string;
  readonly root: string;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly requests: Array<{ method: string; url: string; body: string }>;
  readonly stopRequests: Array<{ workspaceId: string; instanceId: string }>;
  writeDescriptor: () => Promise<void>;
  removeDescriptor: () => Promise<void>;
  /** 只关 HTTP 端口，保留 descriptor 与 store（模拟进程死掉但描述文件残留）。 */
  closeServerKeepDescriptor: () => Promise<void>;
  setFailPost: (value: boolean) => void;
  close: () => Promise<void>;
}

/** 假安装布局：config/logs/launcher 都落在临时目录，不碰真实仓库配置。 */
function fakeInstallation(parent: string, overrides: Partial<InstallationPaths> = {}): InstallationPaths {
  const distributionRoot = path.join(parent, 'install');
  const appRoot = path.join(distributionRoot, 'app');
  return {
    kind: 'repo',
    appRoot,
    distributionRoot,
    configPath: path.join(distributionRoot, '.aichat', 'default.json'),
    logsDirectory: path.join(distributionRoot, '.aichat', 'logs'),
    startupLogPath: path.join(distributionRoot, '.aichat', 'logs', 'startup.log'),
    nodePath: process.execPath,
    cliJsPath: path.join(appRoot, 'dist', 'next', 'cli.js'),
    aichatCmdPath: path.join(appRoot, 'aichat.cmd'),
    launcherPath: path.join(distributionRoot, 'AIchat-graph.exe'),
    skillsDirectory: path.join(appRoot, 'skills', 'aichat-graph'),
    toolsDirectory: path.join(appRoot, 'tools'),
    updateScriptPath: path.join(appRoot, 'dist', 'portable', 'update.js'),
    manifestPath: null,
    manifest: null,
    portable: false,
    ...overrides,
  };
}

interface ProcessCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly detached: boolean;
  readonly windowsHide: boolean;
}

function fakeRunProcess(
  handler?: (call: ProcessCall) => { code: number; stdout?: string; stderr?: string },
): { runProcess: RunProcess; calls: ProcessCall[] } {
  const calls: ProcessCall[] = [];
  const runProcess: RunProcess = async (command, args, options = {}) => {
    const call = {
      command,
      args,
      detached: options.detached === true,
      windowsHide: options.windowsHide ?? true,
    };
    calls.push(call);
    const result = handler?.(call) ?? { code: 0, stdout: '', stderr: '' };
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { runProcess, calls };
}

async function startMockService(options: {
  root: string;
  workspaceId: string;
  instanceId?: string;
  /** support: 提供 POST /api/runtime/stop；legacy-404: 模拟旧服务没有该端点。 */
  stopMode?: 'support' | 'legacy-404';
}): Promise<MockService> {
  const instanceId = options.instanceId ?? 'inst-test-1';
  const stopMode = options.stopMode ?? 'support';
  const store = GraphStore.open(options.root, { instanceId });
  const descriptorPath = path.join(options.root, '.aichat', 'runtime', 'service.json');
  const stopRequests: Array<{ workspaceId: string; instanceId: string }> = [];
  let closed = false;
  let serverClosed = false;
  let storeClosed = false;
  let failPost = false;
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const shutdownServer = async (removeDescriptor: boolean): Promise<void> => {
    if (serverClosed) return;
    serverClosed = true;
    if (removeDescriptor) await fs.rm(descriptorPath, { force: true });
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const server: Server = createServer(async (request, response) => {
    const url = request.url ?? '/';
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: request.method ?? 'GET', url, body: raw });
    const json = (status: number, body: unknown): void => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && url === '/api/workspace') {
      const snapshot = store.snapshot();
      json(200, {
        program: testProgram(),
        workspaceId: snapshot.workspaceId,
        instanceId,
        revision: snapshot.revision,
        rootPath: store.root,
        name: snapshot.name,
        activeNode: snapshot.activeNode,
        stale: false,
        diagnostics: [],
      });
      return;
    }
    if (request.method === 'POST' && url === '/api/agent/changes') {
      if (failPost) {
        request.socket.destroy();
        return;
      }
      try {
        const parsed = JSON.parse(raw) as Parameters<GraphStore['commit']>[0];
        const bodyHash = createHash('sha256').update(raw).digest('hex');
        const committed = store.commit(parsed, bodyHash);
        json(200, { ...committed, instanceId });
      } catch (error) {
        if (error instanceof DomainError) {
          json(error.status, {
            ok: false,
            error: { code: error.code, message: error.message, details: error.details },
          });
          return;
        }
        json(500, { ok: false, error: { code: 'INTERNAL', message: String(error) } });
      }
      return;
    }
    if (request.method === 'POST' && url === '/api/runtime/stop') {
      if (stopMode === 'legacy-404') {
        json(404, { ok: false, error: { code: 'NOT_FOUND', message: '旧服务没有运行控制端点' } });
        return;
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      stopRequests.push({
        workspaceId: typeof parsed['workspaceId'] === 'string' ? (parsed['workspaceId'] as string) : '',
        instanceId: typeof parsed['instanceId'] === 'string' ? (parsed['instanceId'] as string) : '',
      });
      json(200, { ok: true, state: 'stopping' });
      setTimeout(() => {
        void shutdownServer(true);
      }, 25);
      return;
    }
    json(404, { ok: false, error: { code: 'NOT_FOUND', message: 'no route' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = 'http://127.0.0.1:' + String(port);
  const service: MockService = {
    url,
    root: options.root,
    workspaceId: options.workspaceId,
    instanceId,
    requests,
    stopRequests,
    writeDescriptor: async () => {
      const file = descriptorPath;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        JSON.stringify(
          {
            version: 1,
            url,
            workspaceId: options.workspaceId,
            instanceId,
            pid: process.pid,
            rootPath: options.root,
            program: testProgram(),
          },
          null,
          2,
        ),
        'utf8',
      );
    },
    removeDescriptor: async () => {
      await fs.rm(descriptorPath, { force: true });
    },
    closeServerKeepDescriptor: async () => {
      await shutdownServer(false);
    },
    setFailPost: (value: boolean) => {
      failPost = value;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await shutdownServer(false);
      if (!storeClosed) {
        storeClosed = true;
        store.close();
      }
    },
  };
  return service;
}

async function cli(args: readonly string[], context: Parameters<typeof main>[1] = {}): Promise<RunResult> {
  return main([...args], context);
}

function writePayloadOf(result: RunResult): Record<string, unknown> {
  expect(result.exitCode, result.stderr).toBe(0);
  return jsonOf(result.stdout);
}

async function readOf(args: readonly string[], context: Parameters<typeof main>[1] = {}) {
  const result = await cli(['read', ...args], context);
  expect(result.exitCode, result.stderr).toBe(0);
  return { payload: jsonOf<{ items: Array<{ node: { id: string; revision: number }; body: string; range: { start: number; end: number; total: number } }>; refs?: unknown; budget: { used: number }; page: { hasMore: boolean; next?: string } }>(result.stdout), stdout: result.stdout };
}

describe('Interface 4 CLI', () => {
  it('init／topics／validate／version／help 不依赖服务', async () => {
    const { parent, root, workspaceId, schemaVersion } = await initWorkspace();
    expect(workspaceId.startsWith('w_')).toBe(true);
    // 节点状态删除后新库 schemaVersion=2。
    expect(schemaVersion).toBe(2);

    const topics = writePayloadOf(await cli(['topics', '--workspace', root], { cwd: parent }));
    expect(topics).toMatchObject({ ok: true, command: 'topics', workspaceId, revision: 1, topics: [] });

    // GraphStore.create 只建库文件；.aichat 由服务（descriptor／端口偏好）创建。
    expect(await fs.access(path.join(root, '.aichat')).then(() => true).catch(() => false)).toBe(false);

    const validate = writePayloadOf(await cli(['validate', '--workspace', root], { cwd: parent }));
    expect(validate).toMatchObject({ ok: true, command: 'validate', topics: 0, nodes: 0 });

    const version = writePayloadOf(await cli(['version'], { cwd: parent }));
    expect(version['interfaceVersion']).toBe(INTERFACE_VERSION);
    const program = version['program'] as ProgramInfo;
    expect(program.interfaceVersion).toBe(INTERFACE_VERSION);

    const help = writePayloadOf(await cli(['help', '--json'], { cwd: parent }));
    expect(help['interfaceVersion']).toBe(INTERFACE_VERSION);
    const commandNames = (help['commands'] as Array<{ name: string }>).map((entry) => entry.name);
    for (const name of ['init', 'import', 'serve', 'config', 'topics', 'validate', 'search', 'read', 'resume', 'edit', 'important', 'next', 'branch', 'batch', 'insert', 'rearrange', 'delete', 'create-topic', 'status', 'whoami', 'version', 'help']) {
      expect(commandNames).toContain(name);
    }

    const single = await cli(['edit', '--help'], { cwd: parent });
    expect(single.exitCode).toBe(0);
    expect(single.stdout).toContain('aichat edit — ');
    expect(single.stdout).toContain('--from-node');
    expect(single.stdout).not.toContain('aichat bulk');

    const unknown = await cli(['nope'], { cwd: parent });
    expect(unknown.exitCode).toBe(2);
    expect(jsonOf<{ error: { code: string } }>(unknown.stderr).error.code).toBe('USAGE');
  });

  it('工作区解析：--workspace／AICHAT_WORKSPACE／默认配置／--workspace-id', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const topicsByEnv = writePayloadOf(
      await cli(['topics'], { cwd: parent, env: { AICHAT_WORKSPACE: root } }),
    );
    expect(topicsByEnv['workspaceId']).toBe(workspaceId);

    const configPath = path.join(parent, 'repo', '.aichat', 'default.json');
    const saved = writePayloadOf(
      await cli(['config', '--workspace', root], { cwd: parent, configPath }),
    );
    expect(saved).toMatchObject({ ok: true, command: 'config', workspaceId });
    const savedConfig = jsonOf<{ workspace: string; workspaceId: string }>(
      await fs.readFile(configPath, 'utf8'),
    );
    expect(await fs.realpath(savedConfig.workspace)).toBe(await fs.realpath(root));
    expect(savedConfig.workspaceId).toBe(workspaceId);

    const shown = writePayloadOf(await cli(['config', '--show'], { cwd: parent, configPath }));
    expect(shown['exists']).toBe(true);
    expect(await fs.realpath(shown['workspace'] as string)).toBe(await fs.realpath(root));
    const topicsByConfig = writePayloadOf(
      await cli(['topics'], { cwd: parent, configPath, env: { AICHAT_WORKSPACE: '' } }),
    );
    expect(topicsByConfig['workspaceId']).toBe(workspaceId);

    const mismatch = await cli(['topics', '--workspace', root, '--workspace-id', 'w_wrong'], {
      cwd: parent,
    });
    expect(mismatch.exitCode).toBe(3);
    expect(jsonOf<{ error: { code: string } }>(mismatch.stderr).error.code).toBe('WORKSPACE_ID_MISMATCH');

    const missing = await cli(['topics'], {
      cwd: parent,
      configPath: path.join(parent, 'missing', 'default.json'),
      env: { AICHAT_WORKSPACE: '' },
    });
    expect(missing.exitCode).toBe(3);
    expect(jsonOf<{ error: { code: string } }>(missing.stderr).error.code).toBe('WORKSPACE_NOT_CONFIGURED');
  });

  it('create-topic→edit→branch→read/resume→status 全链路（HTTP 替身真实落库）', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const context = { cwd: parent };

    const created = writePayloadOf(
      await cli(
        ['create-topic', '--title', '测试主题', '--body', '起点正文。', '--workspace', root],
        context,
      ),
    );
    expect(created['state']).toBe('committed');
    const topicId = created['topicId'] as string;
    const createdIds = (created['created'] as { nodeIds: string[] }).nodeIds;
    expect(createdIds).toHaveLength(1);
    const rootNodeId = createdIds[0] as string;

    const overview = await readOf(['--topic', topicId, '--workspace', root], context);
    expect(overview.payload.items).toHaveLength(1);
    expect(overview.payload.items[0]?.node.id).toBe(rootNodeId);
    // budget.used 与真实 stdout 长度一致。
    expect(overview.payload.budget.used).toBe(overview.stdout.length);

    const rootRevision = overview.payload.items[0]?.node.revision as number;
    const editResult = writePayloadOf(
      await cli(
        ['edit', '--node', rootNodeId, '--if-revision', String(rootRevision), '--title', '改过的标题', '--important', 'true', '--workspace', root],
        context,
      ),
    );
    expect(editResult['state']).toBe('committed');
    const editRequestId = editResult['requestId'] as string;
    expect((editResult['created'] as { nodeIds: string[] }).nodeIds).toEqual([]);

    const content = await readOf(['--node', rootNodeId, '--workspace', root], context);
    expect((content.payload.items[0]?.node as unknown as { title: string }).title).toBe('改过的标题');
    expect((content.payload.items[0]?.node as unknown as { important: boolean }).important).toBe(true);
    const editedRevision = content.payload.items[0]?.node.revision as number;

    const branch = writePayloadOf(
      await cli(
        ['branch', '--from-node', rootNodeId, '--from-revision', String(editedRevision), '--title', '旁支', '--description', '另一个方向', '--body', '旁支正文。', '--workspace', root],
        context,
      ),
    );
    const branchId = (branch['created'] as { nodeIds: string[] }).nodeIds[0] as string;
    expect(branchId).toEqual(expect.any(String));

    const structure = await readOf(['--topic', topicId, '--view', 'structure', '--workspace', root], context);
    const structureIds = structure.payload.items.map((item) => item.node.id);
    expect(structureIds).toContain(rootNodeId);
    expect(structureIds).toContain(branchId);

    const resumeResult = await cli(['resume', topicId, '--node', rootNodeId, '--workspace', root], context);
    expect(resumeResult.exitCode, resumeResult.stderr).toBe(0);
    expect(jsonOf<{ view: string }>(resumeResult.stdout).view).toBe('resume');

    const status = writePayloadOf(await cli(['status', editRequestId, '--workspace', root], context));
    expect(status).toMatchObject({ ok: true, requestId: editRequestId, status: 'committed', source: 'database' });

    const topics = writePayloadOf(await cli(['topics', '--workspace', root], context));
    expect((topics['topics'] as Array<{ topicId: string }>)[0]?.topicId).toBe(topicId);
  });

  it('edit metadata-only 不读 stdin；--clear-summary 只删显式摘要', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const created = writePayloadOf(
      await cli(['create-topic', '--title', 'T', '--body', 'B', '--workspace', root], { cwd: parent }),
    );
    const nodeId = (created['created'] as { nodeIds: string[] }).nodeIds[0] as string;

    let stdinReads = 0;
    const trap = async (): Promise<string> => {
      stdinReads += 1;
      return '不应被读取';
    };
    const important = writePayloadOf(
      await cli(['edit', '--node', nodeId, '--important', 'true', '--workspace', root], {
        cwd: parent,
        stdin: trap,
      }),
    );
    expect(important['state']).toBe('committed');
    expect(stdinReads).toBe(0);

    const summarized = writePayloadOf(
      await cli(['edit', '--node', nodeId, '--summary', '显式摘要', '--workspace', root], { cwd: parent }),
    );
    expect(summarized['state']).toBe('committed');
    const cleared = writePayloadOf(
      await cli(['edit', '--node', nodeId, '--clear-summary', '--workspace', root], { cwd: parent }),
    );
    expect(cleared['state']).toBe('committed');
    const node = (await readOf(['--node', nodeId, '--workspace', root], { cwd: parent })).payload.items[0]?.node as unknown as { summary: string };
    expect(node.summary).not.toBe('显式摘要');
  });

  it('next／insert／batch／delete／rearrange 通过单次请求提交', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const context = { cwd: parent };
    const created = writePayloadOf(
      await cli(['create-topic', '--title', '链', '--body', 'A', '--workspace', root], context),
    );
    const topicId = created['topicId'] as string;
    let rootId = (created['created'] as { nodeIds: string[] }).nodeIds[0] as string;

    const readRoot = async () =>
      (await readOf(['--node', rootId, '--workspace', root], context)).payload.items[0]?.node as unknown as { revision: number };
    const next = writePayloadOf(
      await cli(
        ['next', '--from-node', rootId, '--from-revision', String((await readRoot()).revision), '--title', 'B', '--description', '继续', '--body', 'B', '--workspace', root],
        context,
      ),
    );
    const nextId = (next['created'] as { nodeIds: string[] }).nodeIds[0] as string;

    const rootRevision = (await readRoot()).revision;
    const nextRevision = ((await readOf(['--node', nextId, '--workspace', root], context)).payload.items[0]?.node as unknown as { revision: number }).revision;
    const inserted = writePayloadOf(
      await cli(
        [
          'insert',
          '--after-node', rootId,
          '--after-revision', String(rootRevision),
          '--before-node', nextId,
          '--before-revision', String(nextRevision),
          '--title', '插入卡',
          '--description', 'A 到插入卡',
          '--next-description', '插入卡到 B',
          '--body', '插入卡正文',
          '--workspace', root,
        ],
        context,
      ),
    );
    const insertedId = (inserted['created'] as { nodeIds: string[] }).nodeIds[0] as string;
    expect(insertedId).toEqual(expect.any(String));

    // batch：编辑插入卡标题 + 新建旁支（bodyFile 相对输入文件目录）+ 删除旁支
    const inputDir = path.join(parent, 'input');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, 'body.md'), '批量旁支正文。', 'utf8');
    const insertedNode = (await readOf(['--node', insertedId, '--workspace', root], context)).payload.items[0]?.node as unknown as { revision: number };
    const batchFile = path.join(inputDir, 'batch.json');
    await fs.writeFile(
      batchFile,
      JSON.stringify({
        topicId,
        ops: [
          { op: 'edit', target: { id: insertedId, revision: insertedNode.revision }, patch: { title: '插入卡（批量）' } },
          { op: 'create', as: '批旁支', from: { id: insertedId, revision: insertedNode.revision }, flow: 'branch', description: '批量旁支', node: { title: '批量旁支', bodyFile: 'body.md' } },
        ],
      }),
      'utf8',
    );
    const batch = writePayloadOf(await cli(['batch', '--input', batchFile, '--workspace', root], context));
    expect(batch['state']).toBe('committed');
    const batchIds = (batch['created'] as { nodeIds: string[] }).nodeIds;
    expect(batchIds).toHaveLength(1);
    const batchBranchId = batchIds[0] as string;

    const branchText = await readOf(['--node', batchBranchId, '--workspace', root], context);
    expect((branchText.payload.items[0] as unknown as { body: string }).body).toBe('批量旁支正文。');

    const batchBranchNode = branchText.payload.items[0]?.node as unknown as { revision: number };
    const removed = writePayloadOf(
      await cli(['delete', '--node', batchBranchId, '--if-revision', String(batchBranchNode.revision), '--workspace', root], context),
    );
    expect(removed['state']).toBe('committed');

    // rearrange：把批旁支已删除后的插入卡改挂到根节点（同主题 next/branch 关系调整）。
    const insertNodeNow = (await readOf(['--node', insertedId, '--workspace', root], context)).payload.items[0]?.node as unknown as { revision: number; from: string | null };
    const rootNodeNow = (await readOf(['--node', rootId, '--workspace', root], context)).payload.items[0]?.node as unknown as { revision: number };
    const rearrangeFile = path.join(inputDir, 'rearrange.json');
    await fs.writeFile(
      rearrangeFile,
      JSON.stringify({
        edits: [
          { target: { id: insertedId, revision: insertNodeNow.revision }, from: { id: rootId, revision: rootNodeNow.revision }, flow: 'branch', description: '改挂到根', order: 2 },
        ],
      }),
      'utf8',
    );
    const rearranged = writePayloadOf(await cli(['rearrange', '--input', rearrangeFile, '--workspace', root], context));
    expect(rearranged['state']).toBe('committed');
    const after = (await readOf(['--node', insertedId, '--workspace', root], context)).payload.items[0]?.node as unknown as { from: string; flow: string };
    expect(after.from).toBe(rootId);
    expect(after.flow).toBe('branch');
  });

  it('写命令默认输出 nodeRevisions，可直接作为下一次写入版本', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const context = { cwd: parent };

    const created = writePayloadOf(
      await cli(['create-topic', '--title', '版本', '--body', '版本正文', '--workspace', root], context),
    );
    const topicId = created['topicId'] as string;
    const nodeId = (created['created'] as { nodeIds: string[] }).nodeIds[0] as string;
    const createdRevisions = created['nodeRevisions'] as Record<string, number>;
    expect(createdRevisions).toEqual({ [nodeId]: 1 });

    // 默认 JSON（非 --verbose）就能拿到 revision，并直接用于下一次 edit。
    const first = writePayloadOf(
      await cli(
        [
          'edit', '--node', nodeId, '--if-revision', String(createdRevisions[nodeId]),
          '--title', '版本标题', '--workspace', root,
        ],
        context,
      ),
    );
    expect(first['state']).toBe('committed');
    const firstRevisions = first['nodeRevisions'] as Record<string, number>;
    expect(firstRevisions).toEqual({ [nodeId]: 2 });

    const appendFile = path.join(parent, 'append.md');
    await fs.writeFile(appendFile, '映射版本追加。', 'utf8');
    const second = writePayloadOf(
      await cli(
        [
          'edit', '--node', nodeId, '--if-revision', String(firstRevisions[nodeId]),
          '--append-file', appendFile, '--workspace', root,
        ],
        context,
      ),
    );
    expect(second['state']).toBe('committed');
    const secondRevisions = second['nodeRevisions'] as Record<string, number>;
    expect(secondRevisions).toEqual({ [nodeId]: 3 });

    // noop 也给目标实际版本，changedNodeIds 为空。
    const noop = writePayloadOf(
      await cli(
        [
          'edit', '--node', nodeId, '--if-revision', String(secondRevisions[nodeId]),
          '--title', '版本标题', '--workspace', root,
        ],
        context,
      ),
    );
    expect(noop['state']).toBe('noop');
    expect(noop['changedNodeIds']).toEqual([]);
    expect(noop['nodeRevisions']).toEqual({ [nodeId]: 3 });

    // batch：编辑目标与新建节点都在映射里，新建节点版本为 1。
    const batchFile = path.join(parent, 'versions-batch.json');
    await fs.writeFile(
      batchFile,
      JSON.stringify({
        topicId,
        ops: [
          { op: 'edit', target: { id: nodeId, revision: 3 }, patch: { title: '批量标题' } },
          {
            op: 'create', as: '新卡', from: { id: nodeId, revision: 3 }, flow: 'branch',
            description: '批量新卡', node: { title: '新卡', body: '新卡正文' },
          },
        ],
      }),
      'utf8',
    );
    const batch = writePayloadOf(await cli(['batch', '--input', batchFile, '--workspace', root], context));
    const batchBranchId = (batch['created'] as { nodeIds: string[] }).nodeIds[0] as string;
    const batchRevisions = batch['nodeRevisions'] as Record<string, number>;
    expect(batchRevisions[nodeId]).toBe(4);
    expect(batchRevisions[batchBranchId]).toBe(1);

    // 删除后同一响应不保留被删节点。
    const removed = writePayloadOf(
      await cli(['delete', '--node', batchBranchId, '--if-revision', '1', '--workspace', root], context),
    );
    expect(removed['state']).toBe('committed');
    expect(removed['nodeRevisions']).toEqual({});
    expect(removed['changedNodeIds']).toContain(batchBranchId);

    // dry-run 不伪造提交后版本。
    const dryFile = path.join(parent, 'versions-dry.json');
    await fs.writeFile(
      dryFile,
      JSON.stringify({
        topicId,
        ops: [{ op: 'edit', target: { id: nodeId, revision: 4 }, patch: { title: 'dry' } }],
      }),
      'utf8',
    );
    const dry = writePayloadOf(await cli(['batch', '--input', dryFile, '--dry-run', '--workspace', root], context));
    expect(dry['dryRun']).toBe(true);
    expect(dry['nodeRevisions']).toBeUndefined();
  });

  it('节点状态已删除：--state 旧参数失败、batch state 被拒绝、无 state 的 edit/create 成功', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const context = { cwd: parent };

    // help 不再暴露节点状态。
    for (const command of ['edit', 'next', 'branch', 'insert']) {
      const help = await cli([command, '--help'], context);
      expect(help.exitCode, help.stderr).toBe(0);
      expect(help.stdout).not.toContain('--state');
      expect(help.stdout).not.toContain('节点状态');
    }

    // 无状态创建：接口 5 的节点对象没有 state 字段，但响应 state=committed 保留。
    const created = writePayloadOf(
      await cli(['create-topic', '--title', '无状态', '--body', '正文', '--workspace', root], context),
    );
    expect(created['state']).toBe('committed');
    const topicId = created['topicId'] as string;
    const nodeId = (created['created'] as { nodeIds: string[] }).nodeIds[0] as string;
    const freshNode = (await readOf(['--node', nodeId, '--workspace', root], context)).payload.items[0]
      ?.node as unknown as Record<string, unknown>;
    expect(freshNode).not.toHaveProperty('state');

    // 旧的合法值也不接受：--state 已是未知选项。
    const legacyEdit = await cli(['edit', '--node', nodeId, '--state', 'agreed', '--workspace', root], context);
    expect(legacyEdit.exitCode).toBe(2);
    expect(jsonOf<{ error: { message: string } }>(legacyEdit.stderr).error.message).toContain('--state');
    const revision = freshNode['revision'] as number;
    const legacyNext = await cli(
      ['next', '--from-node', nodeId, '--from-revision', String(revision), '--title', '旧参数', '--description', '继续', '--body', '正文', '--state', 'agreed', '--workspace', root],
      context,
    );
    expect(legacyNext.exitCode).toBe(2);
    expect(jsonOf<{ error: { message: string } }>(legacyNext.stderr).error.message).toContain('--state');

    // 无 state 的 edit 与 next/create 成功。
    const edited = writePayloadOf(
      await cli(['edit', '--node', nodeId, '--title', '无状态标题', '--workspace', root], context),
    );
    expect(edited['state']).toBe('committed');
    expect(edited['nodeRevisions']).toEqual({ [nodeId]: 2 });
    const next = writePayloadOf(
      await cli(
        ['next', '--from-node', nodeId, '--from-revision', '2', '--title', '下一步', '--description', '继续', '--body', '正文', '--workspace', root],
        context,
      ),
    );
    expect(next['state']).toBe('committed');
    const nextNode = (await readOf(['--node', (next['created'] as { nodeIds: string[] }).nodeIds[0] as string, '--workspace', root], context)).payload.items[0]
      ?.node as unknown as Record<string, unknown>;
    expect(nextNode).not.toHaveProperty('state');

    // batch edit.patch.state 与 create.node.state 都按未知字段拒绝，不能静默吞。
    const batchEditFile = path.join(parent, 'state-edit.json');
    await fs.writeFile(
      batchEditFile,
      JSON.stringify({
        topicId,
        ops: [{ op: 'edit', target: { id: nodeId, revision: 2 }, patch: { title: '批量', state: 'agreed' } }],
      }),
      'utf8',
    );
    const batchEdit = await cli(['batch', '--input', batchEditFile, '--workspace', root], context);
    expect(batchEdit.exitCode).toBe(2);
    const batchEditError = jsonOf<{ error: { message: string; details?: Record<string, unknown> } }>(batchEdit.stderr).error;
    expect(batchEditError.message).toContain('未知字段');
    expect(batchEditError.message).toContain('state');

    const batchCreateFile = path.join(parent, 'state-create.json');
    await fs.writeFile(
      batchCreateFile,
      JSON.stringify({
        topicId,
        ops: [{
          op: 'create', as: '新卡', from: { id: nodeId, revision: 2 }, flow: 'branch', description: '旁支',
          node: { title: '卡', body: '正文', state: 'agreed' },
        }],
      }),
      'utf8',
    );
    const batchCreate = await cli(['batch', '--input', batchCreateFile, '--workspace', root], context);
    expect(batchCreate.exitCode).toBe(2);
    expect(jsonOf<{ error: { message: string } }>(batchCreate.stderr).error.message).toContain('state');

    // 无 state 的 batch 仍成功。
    const batchOkFile = path.join(parent, 'state-ok.json');
    await fs.writeFile(
      batchOkFile,
      JSON.stringify({ topicId, ops: [{ op: 'edit', target: { id: nodeId, revision: 2 }, patch: { title: '批量无状态' } }] }),
      'utf8',
    );
    const batchOk = writePayloadOf(await cli(['batch', '--input', batchOkFile, '--workspace', root], context));
    expect(batchOk['state']).toBe('committed');
  });

  it('错误映射：过期 revision 412→4、422→6、服务不可达结果未知→8', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const context = { cwd: parent };
    const created = writePayloadOf(
      await cli(['create-topic', '--title', 'E', '--body', 'body', '--workspace', root], context),
    );
    const nodeId = (created['created'] as { nodeIds: string[] }).nodeIds[0] as string;

    const stale = await cli(
      ['edit', '--node', nodeId, '--if-revision', '999', '--title', 'x', '--workspace', root],
      context,
    );
    expect(stale.exitCode).toBe(4);
    expect(jsonOf<{ error: { code: string } }>(stale.stderr).error.code).toBe('VERSION_CONFLICT');

    const legacyState = await cli(['edit', '--node', nodeId, '--state', 'bogus', '--workspace', root], context);
    expect(legacyState.exitCode).toBe(2);
    expect(jsonOf<{ error: { message: string } }>(legacyState.stderr).error.message).toContain('--state');

    // 422：非 root 节点改接到自己（自连）→ 结构校验失败。
    const rootNode = (await readOf(['--node', nodeId, '--workspace', root], context)).payload.items[0]?.node as unknown as { revision: number };
    const nextResult = writePayloadOf(
      await cli(
        ['next', '--from-node', nodeId, '--from-revision', String(rootNode.revision), '--title', '自连目标', '--description', '继续', '--body', 'body', '--workspace', root],
        context,
      ),
    );
    const nextId = (nextResult['created'] as { nodeIds: string[] }).nodeIds[0] as string;
    const nextNode = (await readOf(['--node', nextId, '--workspace', root], context)).payload.items[0]?.node as unknown as { revision: number };
    const self = await cli(
      ['edit', '--node', nextId, '--from-node', nextId, '--from-revision', String(nextNode.revision), '--flow', 'next', '--description', '自连', '--workspace', root],
      context,
    );
    expect(self.exitCode).toBe(6);
    const selfError = jsonOf<{ error: { code: string; details?: Record<string, unknown> } }>(self.stderr).error;
    expect(['NODE_SELF_LINK', 'VALIDATION_FAILED']).toContain(selfError.code);

    service.setFailPost(true);
    const unknown = await cli(['edit', '--node', nodeId, '--title', '断线', '--workspace', root], context);
    expect(unknown.exitCode).toBe(8);
    expect(jsonOf<{ error: { code: string } }>(unknown.stderr).error.code).toBe('RESULT_UNKNOWN');
  });

  it('descriptor 缺失时按约定自启动 serve 并轮询', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    const spawnImpl: SpawnLike = (command, args) => {
      spawns.push({ command, args });
      setTimeout(() => {
        void service.writeDescriptor();
      }, 30);
      return { pid: 1234, unref: () => undefined };
    };
    const result = await cli(['create-topic', '--title', '自启动', '--body', 'body', '--workspace', root], {
      cwd: parent,
      spawnImpl,
      startTimeoutMs: 3_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(spawns).toHaveLength(1);
    const spawned = spawns[0] as { command: string; args: readonly string[] };
    expect(spawned.command).toBe(process.execPath);
    const spawnedArgs = spawned.args.slice(1);
    expect(spawnedArgs.slice(0, 2)).toEqual(['serve', '--workspace']);
    expect(await fs.realpath(spawnedArgs[2] as string)).toBe(await fs.realpath(root));
    expect(spawnedArgs.slice(3)).toEqual(['--no-browser']); // 不再传 --port 0：由服务使用端口偏好
    // 第二次写入复用已有 descriptor，不再自启动。
    const again = await cli(['create-topic', '--title', '自启动2', '--body', 'body', '--workspace', root], {
      cwd: parent,
      spawnImpl,
    });
    expect(again.exitCode, again.stderr).toBe(0);
    expect(spawns).toHaveLength(1);
  });

  it('read 预算分页与 cursor：budget.used 等于 stdout 长度', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const longBody = '长正文。'.repeat(1_200);
    const created = writePayloadOf(
      await cli(['create-topic', '--title', '分页', '--body', longBody, '--workspace', root], { cwd: parent }),
    );
    const nodeId = (created['created'] as { nodeIds: string[] }).nodeIds[0] as string;
    const topicId = created['topicId'] as string;

    const first = await readOf(['--node', nodeId, '--budget', '1500', '--workspace', root], { cwd: parent });
    expect(first.payload.page.hasMore).toBe(true);
    expect(first.payload.page.next).toBeTruthy();
    let total = first.payload.items[0]?.body.length ?? 0;
    let next: string | undefined = first.payload.page.next;
    let pages = 1;
    while (next !== undefined) {
      const page = await readOf(['--cursor', next, '--budget', '1500', '--workspace', root], { cwd: parent });
      expect(page.payload.budget.used).toBe(page.stdout.length);
      total += page.payload.items[0]?.body.length ?? 0;
      next = page.payload.page.next;
      pages += 1;
      expect(pages).toBeLessThan(60);
    }
    expect(total).toBe(longBody.length);
    expect(pages).toBeGreaterThan(1);
    expect(topicId).toEqual(expect.any(String));
  });

  it('dry-run batch 不落库，whoami 报告接口版本', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const context = { cwd: parent };
    const created = writePayloadOf(
      await cli(['create-topic', '--title', 'D', '--body', 'body', '--workspace', root], context),
    );
    const topicId = created['topicId'] as string;
    const nodeId = (created['created'] as { nodeIds: string[] }).nodeIds[0] as string;
    const node = (await readOf(['--node', nodeId, '--workspace', root], context)).payload.items[0]?.node as unknown as { revision: number };
    const inputFile = path.join(parent, 'dry.json');
    await fs.writeFile(
      inputFile,
      JSON.stringify({ topicId, ops: [{ op: 'edit', target: { id: nodeId, revision: node.revision }, patch: { title: 'dry' } }] }),
      'utf8',
    );
    const dry = writePayloadOf(await cli(['batch', '--input', inputFile, '--dry-run', '--workspace', root], context));
    expect(dry).toMatchObject({ ok: true, command: 'batch', dryRun: true, state: 'checked' });
    expect(dry['changes']).toBeTruthy();
    const afterDry = (await readOf(['--node', nodeId, '--workspace', root], context)).payload.items[0]?.node as unknown as { revision: number; title: string };
    expect(afterDry.revision).toBe(node.revision);
    expect(afterDry.title).toBe('D');

    const who = writePayloadOf(await cli(['whoami', '--workspace', root], context));
    expect(who).toMatchObject({ ok: true, command: 'whoami', interfaceVersion: INTERFACE_VERSION, workspaceId });
    expect((who['service'] as { available: boolean }).available).toBe(true);
  });

  it('未配置服务且不允许自启动时写命令明确 SERVICE_NOT_RUNNING', async () => {
    const { parent, root } = await initWorkspace();
    const result = await cli(
      ['create-topic', '--title', '无服务', '--body', 'body', '--no-start-service', '--workspace', root],
      { cwd: parent },
    );
    expect(result.exitCode).toBe(7);
    expect(jsonOf<{ error: { code: string } }>(result.stderr).error.code).toBe('SERVICE_NOT_RUNNING');
  });

  it('open：复用服务、保存默认库并通过 launcher --open-url 打开浏览器', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const installation = fakeInstallation(parent);
    await fs.mkdir(path.dirname(installation.launcherPath), { recursive: true });
    await fs.writeFile(installation.launcherPath, '', 'utf8');
    const { runProcess, calls } = fakeRunProcess();
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    const spawnImpl: SpawnLike = (command, args) => {
      spawns.push({ command, args });
      return { pid: 1001, unref: () => undefined };
    };

    const serviceUrl = new URL(service.url).toString();
    const result = await cli(['open', '--workspace', root], { cwd: parent, installation, runProcess, spawnImpl });
    const payload = writePayloadOf(result);
    expect(payload).toMatchObject({
      ok: true,
      command: 'open',
      state: 'opened',
      workspaceId,
      workspace: await fs.realpath(root),
      url: serviceUrl,
      instanceId: service.instanceId,
      reused: true,
    });
    expect((payload['program'] as ProgramInfo).interfaceVersion).toBe(INTERFACE_VERSION);
    expect(spawns).toHaveLength(0);
    const config = jsonOf<{ workspace: string; workspaceId: string }>(
      await fs.readFile(installation.configPath, 'utf8'),
    );
    expect(await fs.realpath(config.workspace)).toBe(await fs.realpath(root));
    expect(config.workspaceId).toBe(workspaceId);
    const browserCall = calls.find((call) => call.command === installation.launcherPath);
    expect(browserCall).toBeTruthy();
    expect(browserCall?.args).toEqual(['--open-url', serviceUrl]);
    expect(browserCall?.detached).toBe(true);

    // 默认库保存后，不带 --workspace 的 open 复用同一服务。
    const second = writePayloadOf(
      await cli(['open', '--no-browser'], { cwd: parent, installation, runProcess, spawnImpl }),
    );
    expect(second['workspaceId']).toBe(workspaceId);
    expect(second['reused']).toBe(true);
    expect(spawns).toHaveLength(0);
  });

  it('open --choose-workspace --interactive：空目录 init、自启动不带 --port 0，取消 state=cancelled', async () => {
    const parent = await newParent();
    const emptyDir = path.join(parent, '新库');
    await fs.mkdir(emptyDir, { recursive: true });
    const installation = fakeInstallation(parent);
    const { runProcess, calls } = fakeRunProcess((call) =>
      call.args[0] === '--pick-workspace' ? { code: 0, stdout: emptyDir + '\n' } : { code: 0 },
    );
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    let started: MockService | null = null;
    const spawnImpl: SpawnLike = (command, args) => {
      spawns.push({ command, args });
      void (async () => {
        const index = args.indexOf('--workspace');
        const pickedRoot = args[index + 1] as string;
        const reader = GraphStore.open(pickedRoot, { readonly: true });
        const pickedWorkspaceId = reader.snapshot().workspaceId;
        reader.close();
        started = await startMockService({ root: pickedRoot, workspaceId: pickedWorkspaceId });
        cleanup.push(() => started?.close());
        await started.writeDescriptor();
      })();
      return { pid: 1002, unref: () => undefined };
    };

    const result = await cli(['open', '--choose-workspace', '--interactive', '--no-browser'], {
      cwd: parent,
      installation,
      runProcess,
      spawnImpl,
      startTimeoutMs: 5_000,
    });
    const payload = writePayloadOf(result);
    expect(calls.find((call) => call.args[0] === '--pick-workspace')).toMatchObject({ windowsHide: false });
    expect(payload['state']).toBe('opened');
    expect(payload['reused']).toBe(false);
    expect(await fs.realpath(emptyDir)).toBe(await fs.realpath(payload['workspace'] as string));
    expect(spawns).toHaveLength(1);
    const spawnArgs = (spawns[0] as { args: readonly string[] }).args;
    expect(spawnArgs).not.toContain('--port');
    await expect(fs.stat(path.join(emptyDir, 'graph.sqlite'))).resolves.toBeTruthy();
    // 交互 init 只建库；descriptor 由服务写入（本次为替身）。
    await expect(fs.stat(path.join(emptyDir, '.aichat', 'runtime', 'service.json'))).resolves.toBeTruthy();
    const config = jsonOf<{ workspace: string }>(await fs.readFile(installation.configPath, 'utf8'));
    expect(await fs.realpath(config.workspace)).toBe(await fs.realpath(emptyDir));

    // 取消：原生选择器 exit 2，不写默认库。
    const cancelParent = await newParent();
    const cancelInstallation = fakeInstallation(cancelParent);
    const cancelRun = fakeRunProcess(() => ({ code: 2 }));
    const cancelled = writePayloadOf(
      await cli(['open', '--choose-workspace', '--interactive'], {
        cwd: cancelParent,
        installation: cancelInstallation,
        runProcess: cancelRun.runProcess,
      }),
    );
    expect(cancelled).toMatchObject({ ok: true, command: 'open', state: 'cancelled' });
    expect(await fs.access(cancelInstallation.configPath).then(() => true).catch(() => false)).toBe(false);
  });

  it('open 用法与失败：--choose-workspace 缺 --interactive、显式空目录不 init 且写 startup log', async () => {
    const parent = await newParent();
    const emptyDir = path.join(parent, '空目录');
    await fs.mkdir(emptyDir, { recursive: true });
    const installation = fakeInstallation(parent);
    const { runProcess } = fakeRunProcess();

    const usage = await cli(['open', '--choose-workspace'], { cwd: parent, installation, runProcess });
    expect(usage.exitCode).toBe(2);
    expect(jsonOf<{ error: { message: string } }>(usage.stderr).error.message).toContain('--interactive');

    const noConfig = await cli(['open'], { cwd: parent, installation, runProcess });
    expect(noConfig.exitCode).toBe(3);
    expect(jsonOf<{ error: { code: string } }>(noConfig.stderr).error.code).toBe('WORKSPACE_NOT_CONFIGURED');

    // 程序目录（distributionRoot/app/...）不能作为讨论库；picker 选中同样拒绝。
    const programWorkspace = path.join(installation.distributionRoot, 'app', '库');
    await fs.mkdir(programWorkspace, { recursive: true });
    const forbidden = await cli(['open', '--workspace', programWorkspace, '--no-browser'], {
      cwd: parent,
      installation,
      runProcess,
    });
    expect(forbidden.exitCode).toBe(3);
    const forbiddenError = jsonOf<{ error: { code: string; message: string } }>(forbidden.stderr).error;
    expect(forbiddenError.code).toBe('WORKSPACE_FORBIDDEN');
    expect(forbiddenError.message).toContain('程序目录');
    expect(
      await fs.access(path.join(programWorkspace, 'graph.sqlite')).then(() => true).catch(() => false),
    ).toBe(false);

    const pickForbiddenRun = fakeRunProcess(() => ({ code: 0, stdout: programWorkspace + '\n' }));
    const pickerForbidden = await cli(['open', '--choose-workspace', '--interactive', '--no-browser'], {
      cwd: parent,
      installation,
      runProcess: pickForbiddenRun.runProcess,
    });
    expect(pickerForbidden.exitCode).toBe(3);
    expect(jsonOf<{ error: { code: string } }>(pickerForbidden.stderr).error.code).toBe('WORKSPACE_FORBIDDEN');

    const explicit = await cli(['open', '--workspace', emptyDir, '--no-browser'], {
      cwd: parent,
      installation,
      runProcess,
    });
    expect(explicit.exitCode).toBe(3);
    expect(jsonOf<{ error: { code: string } }>(explicit.stderr).error.code).toBe('WORKSPACE_NOT_FOUND');
    expect(await fs.access(path.join(emptyDir, 'graph.sqlite')).then(() => true).catch(() => false)).toBe(false);
    const log = await fs.readFile(installation.startupLogPath, 'utf8');
    expect(log).toContain('WORKSPACE_NOT_FOUND');
    expect(log).toContain('"command":"open"');
  });

  it('stop：POST 运行控制端点并等待关闭；缺失／拒绝连接＝not-running，不自启动', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const installation = fakeInstallation(parent);
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    const spawnImpl: SpawnLike = (command, args) => {
      spawns.push({ command, args });
      return { pid: 1003, unref: () => undefined };
    };

    const result = await cli(['stop', '--workspace', root], { cwd: parent, installation, spawnImpl });
    const payload = writePayloadOf(result);
    expect(payload).toMatchObject({
      ok: true,
      command: 'stop',
      state: 'stopped',
      workspaceId,
      instanceId: service.instanceId,
    });
    expect(service.stopRequests).toHaveLength(1);
    expect(service.stopRequests[0]).toMatchObject({ workspaceId, instanceId: service.instanceId });
    expect(
      await fs.access(path.join(root, '.aichat', 'runtime', 'service.json')).then(() => true).catch(() => false),
    ).toBe(false);
    expect(spawns).toHaveLength(0);

    const again = writePayloadOf(await cli(['stop', '--workspace', root], { cwd: parent, installation, spawnImpl }));
    expect(again['state']).toBe('not-running');

    // 从未启动服务的库：not-running，且不会自启动。
    const other = await initWorkspace();
    const otherInstallation = fakeInstallation(other.parent);
    const none = writePayloadOf(
      await cli(['stop', '--workspace', other.root], {
        cwd: other.parent,
        installation: otherInstallation,
        spawnImpl,
      }),
    );
    expect(none['state']).toBe('not-running');
    expect(spawns).toHaveLength(0);
  });

  it('stop：旧服务 404 返回具体错误并写 startup log，不按 PID 杀', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId, stopMode: 'legacy-404' });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    const installation = fakeInstallation(parent);
    const result = await cli(['stop', '--workspace', root], { cwd: parent, installation });
    expect(result.exitCode).toBe(7);
    const error = jsonOf<{ error: { code: string; message: string } }>(result.stderr).error;
    expect(error.code).toBe('SERVICE_STOP_UNSUPPORTED');
    expect(error.message).toContain('404');
    expect(await fs.access(service.root + '/.aichat/runtime/service.json').then(() => true).catch(() => false)).toBe(true);
    const log = await fs.readFile(installation.startupLogPath, 'utf8');
    expect(log).toContain('SERVICE_STOP_UNSUPPORTED');
    expect(log).toContain('"command":"stop"');
  });

  it('stop：descriptor 残留但端口拒绝连接＝not-running', async () => {
    const { parent, root, workspaceId } = await initWorkspace();
    const service = await startMockService({ root, workspaceId });
    cleanup.push(() => service.close());
    await service.writeDescriptor();
    await service.closeServerKeepDescriptor();
    const installation = fakeInstallation(parent);
    const result = await cli(['stop', '--workspace', root], { cwd: parent, installation });
    const payload = writePayloadOf(result);
    expect(payload['state']).toBe('not-running');
  });
});
