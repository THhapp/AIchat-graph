/**
 * SQLite-backed service runtime.
 *
 * Owns the single GraphStore connection, instance identity, descriptor lifecycle,
 * event fan-out for SSE, and the publication side effects of a commit
 * (snapshot event + export scheduling). No filesystem graph scan or watcher.
 */
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadProgramInfo } from '../build-info.js';
import {
  assertPathInsideWorkspace,
  ensureWorkspaceDirectory,
  isErrnoCode,
  resolveWorkspaceRoot,
  writeFileDurable,
} from '../storage/index.js';
import type { ExportManagerLike } from './export-contract.js';
import { findNode, publicNode } from './model.js';
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
