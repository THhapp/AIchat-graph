/**
 * SQLite-backed service runtime.
 *
 * Owns the single GraphStore connection, instance identity, descriptor lifecycle,
 * event fan-out for SSE, and the publication side effects of a commit
 * (snapshot event + export scheduling). No filesystem graph scan or watcher.
 */
import { promises as fs, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { loadProgramInfo } from '../build-info.js';
import {
  assertPathInsideWorkspace,
  ensureWorkspaceDirectory,
  isErrnoCode,
  resolveWorkspaceRoot,
  writeFileDurable,
} from '../storage/index.js';
import type { ExportManagerLike } from './export-contract.js';
import { DomainError, findNode, publicNode } from './model.js';
import type { Snapshot } from './model.js';
import type {
  AgentChangeRequest,
  AgentChangeResponse,
  AgentCheckResponse,
  ExportEvent,
  GraphNode,
  ProgramInfo,
  SnapshotEvent,
  TopicExportStatus,
} from './protocol.js';
import { GraphStore } from './store.js';

export const RUNTIME_DIR = '.aichat/runtime';
export const DESCRIPTOR_RELATIVE_PATH = '.aichat/runtime/service.json';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4317;
/** 每库的稳定端口偏好；只在服务实际绑定端口后写入。 */
export const RUNTIME_LOCAL_DIR = '.aichat/local';
export const RUNTIME_PREFERENCES_RELATIVE_PATH = '.aichat/local/runtime.json';

export interface RuntimePreferences {
  /** 上次实际绑定的端口；缺失或非法时为 null。 */
  readonly preferredPort: number | null;
}

/** .aichat/runtime/service.json 的稳定形状；version 只标识描述文件格式。 */
export interface ServiceDescriptor {
  version: 1;
  url: string;
  workspaceId: string;
  instanceId: string;
  pid: number;
  rootPath: string;
  program: ProgramInfo;
}

export type GraphEvent = SnapshotEvent | ExportEvent;
type GraphEventListener = (event: GraphEvent) => void;

function newInstanceId(): string {
  return 'inst_' + randomUUID().replace(/-/g, '');
}

/** changedNodeIds 可能包含已删除节点：主题归属优先取提交后快照，找不到再回退提交前。 */
function changedTopicsOf(
  before: Snapshot,
  after: Snapshot,
  response: AgentChangeResponse,
): string[] {
  const beforeTopic = new Map(before.nodes.map((node) => [node.id, node.topicId] as const));
  const afterTopic = new Map(after.nodes.map((node) => [node.id, node.topicId] as const));
  const topicIds = new Set<string>();
  for (const nodeId of response.changedNodeIds) {
    const topicId = afterTopic.get(nodeId) ?? beforeTopic.get(nodeId);
    if (topicId !== undefined) topicIds.add(topicId);
  }
  if (response.created.topicId !== null) topicIds.add(response.created.topicId);
  for (const nodeId of response.created.nodeIds) {
    const topicId = afterTopic.get(nodeId);
    if (topicId !== undefined) topicIds.add(topicId);
  }
  return [...topicIds];
}

export class GraphRuntime {
  readonly root: string;
  readonly instanceId: string;
  readonly store: GraphStore;
  readonly workspaceId: string;

  private url = '';
  private readonly listeners = new Set<GraphEventListener>();
  private exports: ExportManagerLike | null = null;

  private constructor(
    root: string,
    instanceId: string,
    store: GraphStore,
    workspaceId: string,
  ) {
    this.root = root;
    this.instanceId = instanceId;
    this.store = store;
    this.workspaceId = workspaceId;
  }

  /** 打开已有 graph.sqlite；不存在时明确失败，不隐式创建或导入。 */
  static async open(root: string): Promise<GraphRuntime> {
    const rootReal = await resolveWorkspaceRoot(root);
    const instanceId = newInstanceId();
    const store = GraphStore.open(rootReal, { instanceId });
    try {
      const initial = store.snapshot();
      return new GraphRuntime(rootReal, instanceId, store, initial.workspaceId);
    } catch (error) {
      store.close();
      throw error;
    }
  }

  snapshot(): Snapshot {
    return this.store.snapshot();
  }

  /** 当前持久 revision（每次读取数据库可见的最新值）。 */
  revision(): number {
    return this.snapshot().revision;
  }

  get currentUrl(): string {
    return this.url;
  }

  setUrl(url: string): void {
    this.url = url;
  }

  attachExports(manager: ExportManagerLike | null): void {
    this.exports = manager;
  }

  subscribe(listener: GraphEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcast(event: GraphEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // SSE 客户端失败不能影响提交结果。
      }
    }
  }

  /** 导出状态变化：转成 export SSE 事件。 */
  publishExport(status: TopicExportStatus): void {
    this.broadcast({
      event: 'export',
      instanceId: this.instanceId,
      revision: this.snapshot().revision,
      status,
    });
  }

  /**
   * 唯一写入口：数据库事务提交后发布快照事件并按受影响主题调度导出。
   * 重放与 dry-run 不产生新事件。
   */
  commit(
    request: AgentChangeRequest,
    bodyHash: string,
  ): AgentChangeResponse | AgentCheckResponse {
    const before = this.store.snapshot();
    const response = this.store.commit(request, bodyHash);
    if ('dryRun' in response) return response;
    if (response.replayed === true) return response;
    if (response.state !== 'committed') return response;

    const after = this.store.snapshot();
    const changedTopicIds = changedTopicsOf(before, after, response);
    this.broadcast({
      event: 'snapshot',
      instanceId: this.instanceId,
      revision: response.revision,
      changedTopicIds,
      changedNodeIds: [...response.changedNodeIds],
      stale: false,
    });
    if (changedTopicIds.length > 0) this.exports?.schedule(changedTopicIds);
    return response;
  }

  /** 读取节点并转成传输投影；找不到时抛 DomainError。 */
  node(nodeId: string): GraphNode {
    return publicNode(findNode(this.snapshot(), nodeId));
  }

  close(): void {
    this.exports = null;
    this.listeners.clear();
    this.store.close();
  }
}

/** 校验工作区真实路径并返回 .aichat/runtime/service.json 的绝对路径。 */
export async function descriptorAbsolutePath(root: string): Promise<string> {
  return assertPathInsideWorkspace(root, DESCRIPTOR_RELATIVE_PATH);
}

/**
 * 写入 service.json：version 只描述描述文件格式，不冒充数据库或接口版本。
 * 使用原子持久写；目录逐级确认不是符号链接。
 */
export async function writeServiceDescriptor(
  runtime: GraphRuntime,
  url: string,
): Promise<string> {
  await ensureWorkspaceDirectory(runtime.root, RUNTIME_DIR);
  const absolute = await descriptorAbsolutePath(runtime.root);
  const descriptor: ServiceDescriptor = {
    version: 1,
    url,
    workspaceId: runtime.workspaceId,
    instanceId: runtime.instanceId,
    pid: process.pid,
    rootPath: runtime.root,
    program: loadProgramInfo() as ProgramInfo,
  };
  await writeFileDurable(
    absolute,
    Buffer.from(JSON.stringify(descriptor, null, 2) + '\n', 'utf8'),
  );
  return absolute;
}

/** 只删除仍属于本实例的描述文件；被其他实例覆盖时保留。 */
export async function removeOwnDescriptor(
  root: string,
  instanceId: string,
): Promise<boolean> {
  let absolute: string;
  try {
    absolute = await descriptorAbsolutePath(root);
  } catch {
    return false;
  }
  let text: string;
  try {
    text = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return false;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    if ((parsed as Record<string, unknown>)['instanceId'] !== instanceId) return false;
  } catch {
    return false;
  }
  try {
    await fs.rm(absolute, { force: true });
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) throw error;
  }
  return true;
}


/* ------------------------------------------------------------------ *
 * 稳定端口偏好与启动占位
 * ------------------------------------------------------------------ */

/** .aichat/local/runtime.json 的绝对路径（只做路径校验，不创建）。 */
export async function runtimePreferencesPath(root: string): Promise<string> {
  return assertPathInsideWorkspace(root, RUNTIME_PREFERENCES_RELATIVE_PATH);
}

/** 读取稳定端口偏好；缺失或损坏时返回 null，不阻断启动。 */
export async function readRuntimePreferences(root: string): Promise<RuntimePreferences | null> {
  let absolute: string;
  try {
    absolute = await runtimePreferencesPath(root);
  } catch {
    return null;
  }
  let text: string;
  try {
    text = await fs.readFile(absolute, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)['preferredPort'];
    const preferredPort =
      typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
        ? value
        : null;
    return { preferredPort };
  } catch {
    return null;
  }
}

/**
 * 记录实际绑定端口：合并已有字段，使用受控目录与原子持久写。
 * 调用方必须在 listen 成功之后调用；失败时不写。
 */
export async function writeRuntimePreferences(
  root: string,
  preferredPort: number,
): Promise<string> {
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
    throw new DomainError('INVALID_ARGUMENT', 'preferredPort 必须是 1-65535 的整数', 400, {
      preferredPort,
    });
  }
  await ensureWorkspaceDirectory(root, RUNTIME_LOCAL_DIR);
  const absolute = await runtimePreferencesPath(root);
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(absolute, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // 缺失或损坏时重建。
  }
  const record = { ...existing, preferredPort };
  await writeFileDurable(absolute, Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8'));
  return absolute;
}

export interface StartupPlaceholder {
  /** named pipe（Windows）或临时 socket 文件路径；仅用于互斥。 */
  readonly name: string;
  release(): Promise<void>;
}

function startupPlaceholderName(rootReal: string): string {
  const hash = createHash('sha256')
    .update(process.platform + ':' + rootReal.replace(/\\/g, '/').toLowerCase())
    .digest('hex')
    .slice(0, 32);
  if (process.platform === 'win32') return '\\\\.\\pipe\\aichat-graph-' + hash;
  return path.join(os.tmpdir(), 'aichat-graph-' + hash + '.sock');
}

function serviceAlreadyRunning(): DomainError {
  return new DomainError(
    'SERVICE_ALREADY_RUNNING',
    '该数据库已有服务在运行（启动占位被占用）；请复用现有服务，或先停止它再启动',
    409,
    {},
  );
}

/** 非 Windows：探测残留 socket 后面是否真有服务；没有则可清理陈旧文件重试。 */
function probeUnixSocket(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const socket = net.createConnection(name);
    socket.once('connect', () => {
      socket.destroy();
      finish(true);
    });
    socket.once('error', () => {
      socket.destroy();
      finish(false);
    });
    socket.setTimeout(300, () => {
      socket.destroy();
      finish(false);
    });
  });
}

function listenPlaceholder(server: net.Server, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(name);
  });
}

/**
 * 启动占位：Windows 用 named pipe，其他平台用临时目录 socket 文件。
 * 名称由工作区真实路径哈希得到；同一数据库目录只允许一个服务持有。
 * 任意连接立即断开：占位只承担互斥，不承担真实通信。
 */
export async function acquireStartupPlaceholder(
  rootReal: string,
): Promise<StartupPlaceholder> {
  const windows = process.platform === 'win32';
  const name = startupPlaceholderName(rootReal);
  const server = net.createServer((socket) => {
    socket.destroy();
  });
  try {
    await listenPlaceholder(server, name);
  } catch (error) {
    if (!windows && isErrnoCode(error, 'EADDRINUSE')) {
      const alive = await probeUnixSocket(name);
      if (!alive) {
        await fs.rm(name, { force: true }).catch(() => undefined);
        try {
          await listenPlaceholder(server, name);
        } catch {
          server.close(() => undefined);
          throw serviceAlreadyRunning();
        }
      } else {
        server.close(() => undefined);
        throw serviceAlreadyRunning();
      }
    } else if (isErrnoCode(error, 'EADDRINUSE')) {
      server.close(() => undefined);
      throw serviceAlreadyRunning();
    } else {
      server.close(() => undefined);
      throw error;
    }
  }
  let released = false;
  return {
    name,
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      if (!windows) await fs.rm(name, { force: true }).catch(() => undefined);
    },
  };
}

/** 从当前模块向上找到包根（含 package.json）；找不到时返回 null。 */
export function packageRoot(): string | null {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}
