/**
 * 单个工作区的运行时协调器。
 *
 * 启动顺序（ARCHITECTURE 8.2／10）：
 *   root realpath → 安全 runtime 目录 → 根级 writer 锁 → recover
 *   → 全量加载并验证 → 启动 HTTP → 启动 watcher → 发布 service.json。
 *
 * 所有 watcher 重读、check、apply 与快照发布都经同一 SerialQueue；
 * 版本只在验证通过后递增，同内容指纹不重复发布托管写结果。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lock as acquireLock } from "proper-lockfile";
import type { ServerType } from "@hono/node-server";
import {
  completeTransaction,
  listTransactions,
  readWorkspaceFiles,
  recoverTransactions,
  resolveWorkspaceRoot,
} from "../storage/index.js";
import type { Diagnostic, TopicExportStatus } from "../shared/protocol.js";
import { loadCacheIdentity, saveCache } from "./cache.js";
import { ServiceError, serviceErrorFromUnknown, wireDiagnostic } from "./errors.js";
import { readSnapshot } from "./load.js";
import { SerialQueue } from "./queue.js";
import {
  ensureRuntimeDirectory,
  removeOwnDescriptor,
  writeServiceDescriptor,
  WRITER_LOCK_PATH,
} from "./runtime.js";
import { diffSnapshots, emptySnapshot, type SnapshotData } from "./snapshot.js";
import { makeCurrent, nextRevision, type CurrentSnapshot } from "./state.js";
import { startWatcher, type WorkspaceWatcher } from "./watcher.js";
import { EditRefStore } from "./editref.js";

export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = "127.0.0.1";

/** 变更请求的会话内幂等记录；只记录已落盘或结果不确定的请求。 */
export interface ChangeRecord {
  readonly requestId: string;
  readonly bodyHash: string;
  readonly httpStatus: number;
  readonly state: string;
  readonly body: unknown;
  readonly recordedAt: string;
}

export interface SseConnection {
  /** 写一条 snapshot／diagnostics／export 事件；失败由实现自行忽略。 */
  send(event: { event: "snapshot" | "diagnostics" | "export"; data: unknown }): void;
  /** 停止时由协调器调用，解除 SSE 请求的等待。 */
  close(): void;
}

export interface WorkspaceHandle {
  readonly url: string;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly rootPath: string;
  stop(): Promise<void>;
}

export interface ReloadResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly snapshot: SnapshotData | null;
  readonly revision: number;
  readonly published: boolean;
}

export class WorkspaceRuntime {
  readonly instanceId: string;
  readonly queue = new SerialQueue();
  readonly requestLog = new Map<string, ChangeRecord>();
  /** Agent 动作的会话幂等记录；含生成 ID，供重放复用。 */
  readonly agentLog = new Map<string, unknown>();
  readonly rootReal: string;
  readonly workspaceId: string;

  current: CurrentSnapshot;
  writable: boolean;
  writableReason: string | null;
  port = 0;
  url = "";
  /** 实例内写入凭据；随实例销毁，重启后旧凭据一律失效。 */
  readonly editRefs: EditRefStore;
  /** 有效发布后的统一导出通知点；由 startService 注入，避免循环依赖。 */
  onPublished: ((reason: string) => Promise<void>) | null = null;

  private readonly systemDiagnostics: Diagnostic[] = [];
  private readonly sseClients = new Set<SseConnection>();
  private watcher: WorkspaceWatcher | null = null;
  private server: ServerType | null = null;
  private releaseLock: (() => Promise<void>) | null = null;
  private descriptorWritten = false;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;

  private constructor(options: {
    rootReal: string;
    workspaceId: string;
    instanceId: string;
    current: CurrentSnapshot;
    writable: boolean;
    writableReason: string | null;
  }) {
    this.rootReal = options.rootReal;
    this.workspaceId = options.workspaceId;
    this.instanceId = options.instanceId;
    this.current = options.current;
    this.writable = options.writable;
    this.writableReason = options.writableReason;
    this.editRefs = new EditRefStore(options.instanceId);
  }

  /** 启动前的完整准备；失败时由调用方调用 stop 清理已获取的资源。 */
  static async create(root: string): Promise<WorkspaceRuntime> {
    const rootReal = await resolveWorkspaceRoot(root);
    await ensureRuntimeDirectory(rootReal);

    const instanceId = "inst_" + randomUUID().replace(/-/g, "");
    const lockPath = path.join(rootReal, ...WRITER_LOCK_PATH.split("/"));
    let releaseLock: (() => Promise<void>) | null = null;
    const lockState: { compromised: Error | null; runtime: WorkspaceRuntime | null } = {
      compromised: null,
      runtime: null,
    };

    try {
      releaseLock = await acquireLock(rootReal, {
        lockfilePath: lockPath,
        stale: 10_000,
        update: 5_000,
        retries: 0,
        realpath: true,
        onCompromised: (error: Error) => {
          lockState.compromised = error;
          lockState.runtime?.disableWrites(
            "WRITER_LOCK_COMPROMISED",
            "写锁已失效（可能被外部删除或抢占），受控写入停用：" + error.message,
          );
        },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw new ServiceError(
        409,
        "WRITER_LOCKED",
        code === "ELOCKED"
          ? "该工作区已有正在写入的服务实例（writer.lock 被占用），拒绝重复启动"
          : "无法获取工作区写锁: " + (error instanceof Error ? error.message : String(error)),
        { details: { lock: WRITER_LOCK_PATH, lockCode: code ?? null }, cause: error },
      );
    }

    try {
      const recovery = await recoverTransactions({ root: rootReal });
      const systemDiagnostics: Diagnostic[] = [];
      for (const report of recovery.reports) {
        if (report.action === "conflict" || report.action === "invalid") {
          systemDiagnostics.push(
            wireDiagnostic(
              "RECOVERY_CONFLICT",
              "未恢复的事务 " + report.transactionId + "：" + (report.message ?? report.action),
              undefined,
            ),
          );
        }
      }
      let writable = recovery.writable;
      let writableReason: string | null = recovery.writable ? null : "RECOVERY_CONFLICT";
      if (lockState.compromised !== null) {
        writable = false;
        writableReason = "WRITER_LOCK_COMPROMISED";
      }

      // 冷启动总是按真实源文件重建有效内容，缓存只提供轻量身份提示。
      // 没有可验证的磁盘源时给出明确空展示 + stale + 诊断，绝不从缓存冒充有效图。
      const loaded = await readSnapshot(rootReal);
      let workspaceId: string;
      let name: string;
      let schemaVersion: 1 | 2 = 2;
      let topicMode: "isolated" | "shared" = "shared";
      let data: SnapshotData;
      let stale: boolean;
      let diagnostics: readonly Diagnostic[];
      let identityFromCache = false;

      if (loaded.files !== null) {
        workspaceId = loaded.files.workspace.workspaceId;
        name = loaded.files.workspace.name;
        schemaVersion = loaded.files.workspace.schemaVersion;
        topicMode = loaded.files.workspace.topicMode ?? "shared";
      } else {
        const cachedIdentity = await loadCacheIdentity(rootReal);
        if (cachedIdentity === null) {
          throw new ServiceError(
            422,
            "WORKSPACE_INVALID",
            loaded.outcome.diagnostics[0]?.message ?? "无法读取 workspace.json",
            { diagnostics: loaded.outcome.diagnostics },
          );
        }
        workspaceId = cachedIdentity.workspaceId;
        name = cachedIdentity.name;
        schemaVersion = cachedIdentity.schemaVersion;
        topicMode = cachedIdentity.topicMode ?? "shared";
        identityFromCache = true;
      }

      if (loaded.outcome.ok) {
        data = loaded.outcome.snapshot;
        stale = false;
        diagnostics = loaded.outcome.diagnostics;
      } else {
        diagnostics = loaded.outcome.diagnostics;
        data = emptySnapshot(workspaceId, name, schemaVersion, topicMode);
        stale = true;
      }

      const current = makeCurrent(instanceId, 1, {
        data,
        diagnostics,
        diskDiagnostics: loaded.outcome.ok ? [] : diagnostics,
        stale,
      });

      const runtime = new WorkspaceRuntime({
        rootReal,
        workspaceId,
        instanceId,
        current,
        writable: writable && lockState.compromised === null,
        writableReason,
      });
      runtime.releaseLock = releaseLock;
      lockState.runtime = runtime;
      runtime.systemDiagnostics.push(...systemDiagnostics);
      if (identityFromCache) {
        // 身份都来自缓存时不能安全写入：没有可核对的工作区身份源文件。
        runtime.writable = false;
        runtime.writableReason = "WORKSPACE_JSON_UNREADABLE";
        runtime.addSystemDiagnostic(
          wireDiagnostic(
            "WORKSPACE_JSON_UNREADABLE",
            "workspace.json 当前无法读取；身份取自轻量缓存，只提供只读诊断，不展示或伪造有效内容",
            "workspace.json",
          ),
        );
      }
      if (lockState.compromised !== null) {
        runtime.systemDiagnostics.push(
          wireDiagnostic(
            "WRITER_LOCK_COMPROMISED",
            "写锁已失效，受控写入停用：" + lockState.compromised.message,
          ),
        );
      }

      if (loaded.outcome.ok) {
        await saveCache(rootReal, data);
      }

      // committed 日志：内容已落盘，先确认当前磁盘能重建有效快照，再清理日志。
      if (recovery.committedPendingRefresh.length > 0) {
        if (!loaded.outcome.ok) {
          runtime.writable = false;
          runtime.writableReason = "COMMITTED_REFRESH_PENDING";
          runtime.systemDiagnostics.push(
            wireDiagnostic(
              "COMMITTED_REFRESH_PENDING",
              "存在已提交事务，但当前磁盘无法重建有效快照；保留事务日志并停用受控写入",
            ),
          );
        } else {
          for (const transactionId of recovery.committedPendingRefresh) {
            try {
              await completeTransaction(rootReal, transactionId);
            } catch (error) {
              runtime.writable = false;
              runtime.writableReason = "COMMITTED_REFRESH_PENDING";
              runtime.systemDiagnostics.push(
                wireDiagnostic(
                  "COMMITTED_REFRESH_PENDING",
                  "已提交事务 " + transactionId + " 的日志清理失败：" +
                    (error instanceof Error ? error.message : String(error)),
                ),
              );
            }
          }
        }
      }

      return runtime;
    } catch (error) {
      await releaseLock().catch(() => undefined);
      throw serviceErrorFromUnknown(error);
    }
  }

  get revision(): number {
    return this.current.revision;
  }

  get stale(): boolean {
    return this.current.stale;
  }

  /** 对外诊断 = 系统级（恢复／锁／刷新） + 当前磁盘或上一份有效内容的诊断。 */
  get diagnostics(): Diagnostic[] {
    return [...this.systemDiagnostics, ...this.current.diagnostics];
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  snapshotVersion(): { instanceId: string; revision: number } {
    return { instanceId: this.instanceId, revision: this.current.revision };
  }

  addSystemDiagnostic(diagnostic: Diagnostic): void {
    const exists = this.systemDiagnostics.some(
      (item) => item.code === diagnostic.code && item.message === diagnostic.message,
    );
    if (exists) return;
    this.systemDiagnostics.push(diagnostic);
  }

  disableWrites(reason: string, message: string): void {
    if (!this.writable && this.writableReason === reason) return;
    this.writable = false;
    this.writableReason = reason;
    this.addSystemDiagnostic(wireDiagnostic(reason, message));
    this.broadcastDiagnostics();
  }

  /** 记录会话内的请求结果；只保留最近若干条，更早的记录按"未知"处理。 */
  /** 记录 Agent 动作结果（含生成 ID）；上限与会话记录一致。 */
  recordAgentChange(record: unknown): void {
    const requestId = (record as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string") return;
    this.agentLog.set(requestId, record);
    while (this.agentLog.size > 200) {
      const oldest = this.agentLog.keys().next();
      if (oldest.done === true) break;
      this.agentLog.delete(oldest.value);
    }
  }

  recordChange(record: ChangeRecord): void {
    this.requestLog.set(record.requestId, record);
    while (this.requestLog.size > 200) {
      const oldest = this.requestLog.keys().next();
      if (oldest.done === true) break;
      this.requestLog.delete(oldest.value);
    }
  }

  getChangeRecord(requestId: string): ChangeRecord | undefined {
    return this.requestLog.get(requestId);
  }

  /** 查询当前会话与未清理事务日志中的请求状态；未知返回 null。 */
  async findChangeStatus(requestId: string): Promise<Record<string, unknown> | null> {
    const record = this.requestLog.get(requestId);
    if (record !== undefined) {
      // 记录里的 state 是更细的会话状态（committed_refresh_pending 等）；
      // 结果正文里的 state 只是粗粒度结果，不能覆盖它。
      const { state: _ignoredState, ...rest } =
        typeof record.body === "object" && record.body !== null
          ? (record.body as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      void _ignoredState;
      return {
        ...rest,
        requestId,
        state: record.state,
        httpStatus: record.httpStatus,
        recordedAt: record.recordedAt,
        source: "session",
      };
    }
    let journals;
    try {
      journals = await listTransactions(this.rootReal);
    } catch {
      return null;
    }
    const journal = journals.find((entry) => entry.requestId === requestId);
    if (journal === undefined) return null;
    return {
      requestId,
      state: journal.state === "committed" ? "committed_pending_refresh" : "pending",
      transactionId: journal.transactionId,
      transactionState: journal.state,
      createdAt: journal.createdAt,
      files: journal.files.map((file) => file.path),
      source: "journal",
    };
  }

  registerSse(connection: SseConnection): () => void {
    this.sseClients.add(connection);
    return () => {
      this.sseClients.delete(connection);
    };
  }

  private broadcast(event: { event: "snapshot" | "diagnostics" | "export"; data: unknown }): void {
    for (const client of [...this.sseClients]) {
      try {
        client.send(event);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  /**
   * 有效发布的统一通知点。导出任务自己不再触发这里，避免"导出写盘 → 监听 →
   * 再导出"的循环；配置或 .aichat 缓存变化也不会进到这里。
   */
  private notifyPublished(reason: string): void {
    const hook = this.onPublished;
    if (hook === null) return;
    void hook(reason).catch((error: unknown) => {
      this.addSystemDiagnostic(
        wireDiagnostic(
          "EXPORT_SCHEDULE_FAILED",
          "排入主题导出失败：" + (error instanceof Error ? error.message : String(error)),
        ),
      );
    });
  }

  /** 导出状态变化：只发状态，不发正文。 */
  broadcastExport(statuses: readonly TopicExportStatus[]): void {
    if (this.sseClients.size === 0) return;
    for (const status of statuses) {
      this.broadcast({
        event: "export",
        data: { event: "export", ...this.snapshotVersion(), status },
      });
    }
  }

  private broadcastDiagnostics(): void {
    if (this.sseClients.size === 0) return;
    this.broadcast({
      event: "diagnostics",
      data: {
        event: "diagnostics",
        ...this.snapshotVersion(),
        diagnostics: this.diagnostics,
      },
    });
  }

  /**
   * 重新读取并验证整个工作区。
   * - 成功且内容指纹变化：revision+1，发布 snapshot；
   * - 成功但内容相同：不递增，不重复发布（诊断变化时只发 diagnostics）；
   * - 失败：保留上一份有效内容并标 stale，绝不拿旧结构覆盖坏源。
   */
  async reloadFromDisk(options: { force?: boolean } = {}): Promise<ReloadResult> {
    const result = await readSnapshot(this.rootReal);
    const previous = this.current;
    // 工作区身份一经启动就固定：workspace.json 被改成另一个 workspaceId 时，
    // 不能把这个服务悄悄变成另一个工作区，按无效磁盘内容处理并保留旧快照。
    if (result.outcome.ok && result.outcome.snapshot.workspaceId !== this.workspaceId) {
      const diagnostics: Diagnostic[] = [
        ...result.outcome.diagnostics,
        wireDiagnostic(
          "WORKSPACE_ID_CHANGED",
          "workspace.json 的 workspaceId 已变为 " +
            result.outcome.snapshot.workspaceId +
            "（本服务启动时是 " +
            this.workspaceId +
            "）；拒绝切换工作区，展示上一份有效内容",
          "workspace.json",
        ),
      ];
      const changed = JSON.stringify(diagnostics) !== JSON.stringify(previous.diskDiagnostics);
      this.current = { ...previous, stale: true, diagnostics, diskDiagnostics: diagnostics };
      if (changed) this.broadcastDiagnostics();
      return { ok: false, diagnostics, snapshot: null, revision: previous.revision, published: false };
    }
    if (result.outcome.ok) {
      const snapshot = result.outcome.snapshot;
      const sameContent =
        previous.data.fingerprint !== "" && previous.data.fingerprint === snapshot.fingerprint;
      const diagnostics = result.outcome.diagnostics;
      const force = options.force === true;

      if (sameContent && !previous.stale && !force) {
        const diagnosticsChanged = JSON.stringify(diagnostics) !== JSON.stringify(previous.diagnostics);
        this.current = { ...previous, diagnostics, diskDiagnostics: [] };
        if (diagnosticsChanged) this.broadcastDiagnostics();
        return {
          ok: true,
          diagnostics,
          snapshot,
          revision: this.current.revision,
          published: false,
        };
      }

      const changed = sameContent ? { changedTopicIds: [], changedNodeIds: [] } : diffSnapshots(previous.data, snapshot);
      const revision = nextRevision(previous, snapshot, force || (sameContent && previous.stale));
      this.current = makeCurrent(this.instanceId, revision, {
        data: snapshot,
        diagnostics,
        diskDiagnostics: [],
        stale: false,
      });
      await saveCache(this.rootReal, snapshot);
      this.notifyPublished("snapshot");
      this.broadcast({
        event: "snapshot",
        data: {
          event: "snapshot",
          instanceId: this.instanceId,
          revision,
          changedTopicIds: changed.changedTopicIds,
          changedNodeIds: changed.changedNodeIds,
          stale: false,
        },
      });
      if (diagnostics.some((item) => item.severity === "warning" || item.severity === "error")) {
        this.broadcastDiagnostics();
      }
      return { ok: true, diagnostics, snapshot, revision, published: true };
    }

    const diagnostics = result.outcome.diagnostics;
    const changed = JSON.stringify(diagnostics) !== JSON.stringify(previous.diskDiagnostics);
    this.current = {
      ...previous,
      stale: true,
      diagnostics,
      diskDiagnostics: diagnostics,
    };
    if (changed) this.broadcastDiagnostics();
    return { ok: false, diagnostics, snapshot: null, revision: previous.revision, published: false };
  }

  /** 启动 HTTP；端口冲突直接失败，不静默换端口。 */
  async listen(port: number, fetchHandler: Parameters<typeof import("@hono/node-server").serve>[0]["fetch"]): Promise<void> {
    const { serve } = await import("@hono/node-server");
    this.port = port;
    this.server = await new Promise<ServerType>((resolve, reject) => {
      let settled = false;
      const server = serve(
        {
          fetch: fetchHandler,
          hostname: DEFAULT_HOST,
          port,
        },
        (info) => {
          if (settled) return;
          settled = true;
          this.port = info.port;
          this.url = "http://" + DEFAULT_HOST + ":" + String(info.port);
          resolve(server);
        },
      );
      server.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(
          new ServiceError(
            409,
            "PORT_UNAVAILABLE",
            "无法监听 " + DEFAULT_HOST + ":" + String(port) + "：" +
              (error instanceof Error ? error.message : String(error)),
            { details: { port }, cause: error },
          ),
        );
      });
    });
  }

  /** 监听成功、快照已就绪之后才开始关注文件变化。 */
  async startWatching(): Promise<void> {
    this.watcher = await startWatcher({
      rootReal: this.rootReal,
      onChange: () => {
        void this.queue
          .run(() => this.reloadFromDisk())
          .catch((error: unknown) => {
            if (this.stopping) return;
            const serviceError = serviceErrorFromUnknown(error);
            this.addSystemDiagnostic(
              wireDiagnostic(serviceError.code, serviceError.message, undefined),
            );
            this.broadcastDiagnostics();
          });
      },
      onError: (error) => {
        this.addSystemDiagnostic(
          wireDiagnostic(
            "WATCHER_ERROR",
            "文件监听出错：" + (error instanceof Error ? error.message : String(error)),
          ),
        );
        this.broadcastDiagnostics();
      },
    });
  }

  async publishDescriptor(): Promise<void> {
    await writeServiceDescriptor(this.rootReal, {
      url: this.url,
      rootPath: this.rootReal,
      workspaceId: this.workspaceId,
      instanceId: this.instanceId,
      pid: process.pid,
    });
    this.descriptorWritten = true;
  }

  /** 幂等停止：watcher、SSE、HTTP、descriptor、锁依次释放。 */
  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.queue.close();
      await this.queue.whenIdle().catch(() => undefined);
      if (this.watcher !== null) {
        const watcher = this.watcher;
        this.watcher = null;
        await watcher.close().catch(() => undefined);
      }
      for (const client of [...this.sseClients]) {
        this.sseClients.delete(client);
        try {
          client.close();
        } catch {
          // 断开单个事件流失败不影响停止流程。
        }
      }
      if (this.server !== null) {
        const server = this.server;
        this.server = null;
        await new Promise<void>((resolve) => {
          const connections = server as unknown as {
            closeIdleConnections?: () => void;
            closeAllConnections?: () => void;
          };
          // SSE 客户端已在上一步关闭；先回收 keep-alive 空闲连接，
          // 再等待 server.close；超时则强制断开，stop 不无限挂起。
          connections.closeIdleConnections?.();
          const force = setTimeout(() => {
            connections.closeAllConnections?.();
            resolve();
          }, 1500);
          server.close(() => {
            clearTimeout(force);
            resolve();
          });
          connections.closeIdleConnections?.();
        });
      }
      if (this.descriptorWritten) {
        await removeOwnDescriptor(this.rootReal, this.instanceId).catch(() => undefined);
        this.descriptorWritten = false;
      }
      if (this.releaseLock !== null) {
        const release = this.releaseLock;
        this.releaseLock = null;
        await release().catch(() => undefined);
      }
    })();
    return this.stopPromise;
  }
}