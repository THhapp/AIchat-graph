/**
 * 变更集合的检查与提交。
 *
 * - check 与 apply 都排在协调器队列里，都从磁盘重新读取，不复用上次 check；
 * - 候选语义全部委托 storage.prepareChanges，这里只做队列、幂等与提交编排；
 * - 低层 apply 与 Agent 动作共用同一条提交链路（commitPreparedChanges）：
 *   commitFiles 负责 prepared／原子写／committed，提交后重建并发布快照；
 * - 确认刷新成功才 completeTransaction；刷新失败保留日志并报
 *   COMMITTED_REFRESH_PENDING，绝不回滚已提交源文件。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ChangeError,
  commitFiles,
  completeTransaction,
  prepareChanges,
  readWorkspaceFiles,
  sha256Bytes,
  type ChangeRequest,
  type CommitFileInput,
  type PreparedChanges,
} from "../storage/index.js";
import type {
  AgentBatchAction,
  AgentBatchCheckResponse,
  AgentChangeRequest,
  AgentChangeResponse,
} from "../shared/protocol.js";
import { compileAgentAction, issueRefForNode } from "./agent/compile.js";
import type { Diagnostic } from "../shared/protocol.js";
import type { StorageDiagnostic } from "../storage/index.js";
import { serviceErrorFromChange, ServiceError, wireDiagnostic } from "./errors.js";
import type { WorkspaceRuntime } from "./workspace.js";

export interface CheckedFile {
  readonly path: string;
  readonly expectedSha256: string | null;
  readonly nextSha256: string | null;
  readonly deleted: boolean;
}

export interface CheckResult {
  readonly ok: true;
  readonly dryRun: true;
  readonly requestId: string;
  readonly instanceId: string;
  readonly revision: number;
  readonly changedNodeIds: string[];
  readonly summary: string;
  readonly files: CheckedFile[];
  readonly diagnostics: Diagnostic[];
  readonly noop: boolean;
}

export interface CommittedFileView {
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly byteLength: number;
}

export interface ApplyResult {
  readonly ok: true;
  readonly requestId: string;
  readonly state: "committed" | "noop" | "committed_refresh_pending";
  readonly instanceId: string;
  readonly revision: number;
  readonly transactionId: string | null;
  readonly touchedFiles: CommittedFileView[];
  readonly changedNodeIds: string[];
  readonly summary: string;
  readonly diagnostics: Diagnostic[];
  readonly committed: boolean;
  readonly journalCleaned: boolean;
  readonly replayed?: boolean;
}

/**
 * 共用提交链路的结果。两个入口只把它映射成各自响应，不再复制提交后的
 * reload／日志清理／最近变更记录逻辑。
 */
interface CommitOutcome {
  readonly state: ApplyResult["state"];
  readonly transactionId: string | null;
  readonly touchedFiles: CommittedFileView[];
  readonly revision: number;
  readonly diagnostics: Diagnostic[];
  readonly journalCleaned: boolean;
  readonly committed: boolean;
}

/** 幂等日志中的最小共同形状：低层 requestLog 与 agentLog 都满足。 */
interface StoredWrite {
  readonly bodyHash: string;
  readonly body: unknown;
  readonly recordedAt: string;
  readonly state?: string;
}

const REPLAY_CONFLICT_MESSAGE = "requestId 已被另一份请求体使用；请换新的 requestId，不重放旧请求";
const QUEUED_CONFLICT_MESSAGE = "requestId 已被另一份请求体使用";

function diagnoseChange(error: unknown): never {
  if (error instanceof ChangeError) throw serviceErrorFromChange(error);
  throw error;
}

/** 队列内拒绝一切写请求；只读诊断不受影响。 */
function assertWritable(runtime: WorkspaceRuntime): void {
  if (runtime.writable) return;
  throw new ServiceError(
    409,
    "WRITE_DISABLED",
    "受控写入已停用（" + (runtime.writableReason ?? "UNKNOWN") + "）；可继续只读诊断，修好后重启服务",
    { details: { reason: runtime.writableReason } },
  );
}

/**
 * 相同 requestId + 相同请求体返回原结果；相同 requestId + 不同请求体 409。
 * 返回 null 表示尚无记录，可以继续执行。
 */
function replayOrConflict<T>(
  stored: StoredWrite | null | undefined,
  rawBodyHash: string,
  conflict: (stored: StoredWrite) => ServiceError,
): T | null {
  if (stored === null || stored === undefined) return null;
  if (stored.bodyHash === rawBodyHash) {
    return { ...(stored.body as Record<string, unknown>), replayed: true } as unknown as T;
  }
  throw conflict(stored);
}

/**
 * 写请求的统一入口段：请求前幂等预检 → 入队 → 队内再次核对 → writable 检查
 * → 入口自己的读取／编译／提交。两个入口的差异只在 work 与冲突错误详情。
 */
function runQueuedWrite<T>(
  runtime: WorkspaceRuntime,
  rawBodyHash: string,
  lookup: () => StoredWrite | null | undefined,
  conflict: (stored: StoredWrite, queued: boolean) => ServiceError,
  work: () => Promise<T>,
): Promise<T> {
  const replayed = replayOrConflict<T>(lookup(), rawBodyHash, (stored) =>
    conflict(stored, false),
  );
  if (replayed !== null) return Promise.resolve(replayed);

  return runtime.queue.run(async () => {
    // 排队期间可能已有同 requestId 的结果；再次核对，保证"只执行一次"。
    const queuedReplay = replayOrConflict<T>(lookup(), rawBodyHash, (stored) =>
      conflict(stored, true),
    );
    if (queuedReplay !== null) return queuedReplay;
    assertWritable(runtime);
    return work();
  });
}

/**
 * 本次提交真正改写了源文件的节点。
 * 候选层会排除删除与仅改重要性的节点；缺省时按改动节点理解。
 */
function contentNodeIdsOf(prepared: PreparedChanges): string[] {
  return [...(prepared.contentNodeIds ?? prepared.changedNodeIds)];
}

/** changedNodeIds 中仍在快照里的节点各签发一份刷新后不透明凭据。 */
function refsOf(
  runtime: WorkspaceRuntime,
  nodeIds: readonly string[],
): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const nodeId of nodeIds) {
    const issued = issueRefForNode(runtime, runtime.editRefs, nodeId);
    if (issued !== null) refs[nodeId] = issued.ref;
  }
  return refs;
}

function fileViews(files: readonly CommitFileInput[]): CheckedFile[] {
  return files.map((file) => ({
    path: file.path,
    expectedSha256: file.expectedSha256,
    nextSha256: file.content === null ? null : sha256Bytes(file.content),
    deleted: file.content === null,
  }));
}

function preparedDiagnostics(prepared: PreparedChanges): Diagnostic[] {
  return prepared.diagnostics.map((diagnostic: StorageDiagnostic) =>
    wireDiagnostic(diagnostic.code, diagnostic.message, diagnostic.path, "info"),
  );
}

/** 从磁盘重读并计算候选；失败时统一转成服务错误（保留 details 与诊断）。 */
async function readPrepared(
  runtime: WorkspaceRuntime,
  request: ChangeRequest,
): Promise<PreparedChanges> {
  const files = await readWorkspaceFiles(runtime.rootReal);
  try {
    return prepareChanges(files, request);
  } catch (error) {
    diagnoseChange(error);
  }
}

/** 只验证，不写文件；失败时磁盘内容完全不变。 */
export async function checkChanges(
  runtime: WorkspaceRuntime,
  request: ChangeRequest,
): Promise<CheckResult> {
  return runtime.queue.run(async () => {
    const prepared = await readPrepared(runtime, request);
    return {
      ok: true as const,
      dryRun: true as const,
      requestId: request.requestId,
      instanceId: runtime.instanceId,
      revision: runtime.revision,
      changedNodeIds: prepared.changedNodeIds,
      summary: prepared.summary,
      files: fileViews(prepared.files),
      diagnostics: preparedDiagnostics(prepared),
      noop: prepared.files.length === 0,
    };
  });
}

/**
 * 两个写入口共用的提交事务。必须在 runtime.queue 内调用。
 *
 * - noop：不调用 commitFiles，也不递增 revision；
 * - 成功：刷新快照后记录最近变更，再清理事务日志；
 * - 刷新失败：不回滚、保留事务日志、停用写入，并返回
 *   committed_refresh_pending（含明确的 COMMITTED_REFRESH_PENDING 诊断）；
 * - 日志清理失败：快照已刷新，停用写入并返回 JOURNAL_CLEANUP_FAILED 诊断。
 */
async function commitPreparedChanges(
  runtime: WorkspaceRuntime,
  options: { requestId: string; prepared: PreparedChanges },
): Promise<CommitOutcome> {
  const { requestId, prepared } = options;
  const diagnostics = preparedDiagnostics(prepared);

  if (prepared.files.length === 0) {
    // no-op：不调用 commitFiles，也不递增 revision。
    return {
      state: "noop",
      transactionId: null,
      touchedFiles: [],
      revision: runtime.revision,
      diagnostics,
      journalCleaned: true,
      committed: false,
    };
  }

  let committed;
  try {
    committed = await commitFiles({
      root: runtime.rootReal,
      files: prepared.files,
      requestId,
    });
  } catch (error) {
    diagnoseChange(error);
  }

  const touchedFiles: CommittedFileView[] = committed.touchedFiles.map((file) => ({
    path: file.path,
    beforeSha256: file.beforeSha256,
    afterSha256: file.afterSha256,
    byteLength: file.byteLength,
  }));

  // 源文件已提交：必须重建有效快照。失败时保留日志、不回滚，并如实报告。
  const reload = await runtime.reloadFromDisk().catch((error: unknown) => {
    return {
      ok: false as const,
      diagnostics: [
        wireDiagnostic(
          "COMMITTED_REFRESH_PENDING",
          "已提交但刷新快照失败：" + (error instanceof Error ? error.message : String(error)),
        ),
      ],
      snapshot: null,
      revision: runtime.revision,
      published: false,
    };
  });

  if (!reload.ok) {
    runtime.disableWrites(
      "COMMITTED_REFRESH_PENDING",
      "已提交事务 " + committed.transactionId + " 的源文件已落盘，但当前磁盘无法重建有效快照；保留事务日志，修复后重启服务",
    );
    // 源文件确实已提交：标记仍按本次内容节点记录，重启后与磁盘一致。
    await runtime.recordLastChange(contentNodeIdsOf(prepared));
    return {
      state: "committed_refresh_pending",
      transactionId: committed.transactionId,
      touchedFiles,
      revision: runtime.revision,
      diagnostics: [
        ...diagnostics,
        ...reload.diagnostics,
        wireDiagnostic(
          "COMMITTED_REFRESH_PENDING",
          "源文件已提交并保留事务日志；当前磁盘无法重建有效快照，需修复后重启服务",
        ),
      ],
      journalCleaned: false,
      committed: true,
    };
  }

  // 快照已刷新：本次提交真实改写的节点成为"最近一次内容更新"。
  await runtime.recordLastChange(contentNodeIdsOf(prepared));

  let journalCleaned = false;
  let cleanupDiagnostic: Diagnostic | null = null;
  try {
    await completeTransaction(runtime.rootReal, committed.transactionId);
    journalCleaned = true;
  } catch (error) {
    cleanupDiagnostic = wireDiagnostic(
      "JOURNAL_CLEANUP_FAILED",
      "快照已刷新，但事务日志清理失败；下次启动会核对后清理：" +
        (error instanceof Error ? error.message : String(error)),
    );
    runtime.addSystemDiagnostic(cleanupDiagnostic);
    runtime.disableWrites(
      "JOURNAL_CLEANUP_FAILED",
      "已提交事务 " + committed.transactionId + " 的快照已刷新，但事务日志清理失败；受控写入停用，重启后核对再清理",
    );
  }

  return {
    state: "committed",
    transactionId: committed.transactionId,
    touchedFiles,
    revision: reload.revision,
    diagnostics:
      cleanupDiagnostic === null ? diagnostics : [...diagnostics, cleanupDiagnostic],
    journalCleaned,
    committed: true,
  };
}

/**
 * 提交一次变更集合。
 *
 * 幂等：相同 requestId 与相同请求体直接返回原结果；相同 requestId 不同请求体
 * 返回 409 OPERATION_CONFLICT，绝不把它当成新请求执行。
 */
export async function applyChanges(
  runtime: WorkspaceRuntime,
  request: ChangeRequest,
  rawBodyHash: string,
): Promise<ApplyResult> {
  return runQueuedWrite<ApplyResult>(
    runtime,
    rawBodyHash,
    () => runtime.requestLog.get(request.requestId),
    (stored, queued) =>
      new ServiceError(
        409,
        "OPERATION_CONFLICT",
        queued ? QUEUED_CONFLICT_MESSAGE : REPLAY_CONFLICT_MESSAGE,
        {
          details: queued
            ? { requestId: request.requestId }
            : {
                requestId: request.requestId,
                recordedAt: stored.recordedAt,
                state: stored.state,
              },
        },
      ),
    async () => {
      const prepared = await readPrepared(runtime, request);
      const outcome = await commitPreparedChanges(runtime, {
        requestId: request.requestId,
        prepared,
      });
      const result: ApplyResult = {
        ok: true,
        requestId: request.requestId,
        state: outcome.state,
        instanceId: runtime.instanceId,
        revision: outcome.revision,
        transactionId: outcome.transactionId,
        touchedFiles: outcome.touchedFiles,
        changedNodeIds: prepared.changedNodeIds,
        summary: prepared.summary,
        diagnostics: outcome.diagnostics,
        committed: outcome.committed,
        journalCleaned: outcome.journalCleaned,
      };
      runtime.recordChange({
        requestId: request.requestId,
        bodyHash: rawBodyHash,
        httpStatus: 200,
        state: outcome.state,
        body: result,
        recordedAt: new Date().toISOString(),
      });
      return result;
    },
  );
}

/* ------------------------------------------------------------------ *
 * 低摩擦 Agent 动作：编译到同一 apply 链路
 * ------------------------------------------------------------------ */

interface AgentRecord {
  readonly requestId: string;
  readonly bodyHash: string;
  readonly httpStatus: number;
  readonly state: string;
  readonly body: unknown;
  readonly recordedAt: string;
  /** 同一 requestId 重放必须复用这些生成值，不能重新生成 ID。 */
  readonly generated: { topicId: string; nodeId: string; dir: string } | null;
}

function agentRecordOf(record: unknown): AgentRecord | null {
  if (typeof record !== "object" || record === null) return null;
  const candidate = record as { generated?: unknown };
  if (!("generated" in candidate)) return null;
  return candidate as AgentRecord;
}

/** 把共用提交结果映射成 Agent 响应；两个入口只在响应字段上不同。 */
function agentResponseOf(
  runtime: WorkspaceRuntime,
  request: AgentChangeRequest,
  compiled: ReturnType<typeof compileAgentAction>,
  prepared: PreparedChanges,
  outcome: CommitOutcome,
): AgentChangeResponse {
  const base: AgentChangeResponse = {
    ...runtime.snapshotVersion(),
    ok: true,
    requestId: request.requestId,
    action: request.action.action,
    workspaceId: runtime.workspaceId,
    topicId: compiled.topicId,
    state: outcome.state,
    created: compiled.created,
    changedNodeIds: prepared.changedNodeIds,
    // 刷新待完成时旧凭据不可继续使用：只有本次已经能读到新快照才签发。
    refs: {},
    touchedFiles: outcome.touchedFiles,
    summary: prepared.summary,
    diagnostics: outcome.diagnostics,
    transactionId: outcome.transactionId,
    journalCleaned: outcome.journalCleaned,
  };

  if (outcome.state === "committed_refresh_pending") return base;
  return { ...base, refs: refsOf(runtime, prepared.changedNodeIds) };
}

/** dry-run：只编译与检查，不写盘、不写 agentLog、不更新最近更新。 */
async function checkAgentBatch(
  runtime: WorkspaceRuntime,
  request: AgentChangeRequest,
  action: AgentBatchAction,
): Promise<AgentBatchCheckResponse> {
  return runtime.queue.run(async () => {
    const files = await readWorkspaceFiles(runtime.rootReal);
    const compiled = compileAgentAction(
      { runtime, editRefs: runtime.editRefs, requestId: request.requestId, generated: null },
      action,
    );
    let prepared: PreparedChanges;
    try {
      prepared = prepareChanges(files, {
        workspaceId: request.workspaceId,
        requestId: request.requestId,
        expectedFiles: compiled.expectedFiles,
        operations: compiled.operations,
      });
    } catch (error) {
      diagnoseChange(error);
    }
    return {
      ok: true as const,
      command: "batch" as const,
      dryRun: true as const,
      state: "checked" as const,
      requestId: request.requestId,
      workspaceId: runtime.workspaceId,
      topicId: compiled.topicId,
      summary: prepared.summary,
      diagnostics: preparedDiagnostics(prepared),
      files: prepared.files.map((file) => ({
        path: file.path,
        beforeSha256: file.expectedSha256,
        nextSha256: file.content === null ? null : sha256Bytes(file.content),
        deleted: file.content === null,
      })),
    };
  });
}

/**
 * 编译并提交一个 Agent 动作。
 *
 * 幂等：同一 requestId 与同一请求体直接返回原结果（含相同的生成 ID）；
 * 不同请求体复用 ID 返回 409。编译与提交都在 runtime.queue 内完成，
 * 不重复排队，不会自死锁。
 */
export async function applyAgentChange(
  runtime: WorkspaceRuntime,
  request: AgentChangeRequest,
  rawBodyHash: string,
): Promise<AgentChangeResponse | AgentBatchCheckResponse> {
  // dry-run 只在 batch 上存在（schema 已限制）；只检查，不进入幂等日志。
  if (request.action.action === "batch" && request.dryRun === true) {
    return checkAgentBatch(runtime, request, request.action);
  }
  return runQueuedWrite<AgentChangeResponse>(
    runtime,
    rawBodyHash,
    () => agentRecordOf(runtime.agentLog.get(request.requestId)),
    (stored, queued) =>
      new ServiceError(
        409,
        "OPERATION_CONFLICT",
        queued ? QUEUED_CONFLICT_MESSAGE : REPLAY_CONFLICT_MESSAGE,
        {
          details: queued
            ? { requestId: request.requestId }
            : { requestId: request.requestId, recordedAt: stored.recordedAt },
        },
      ),
    async () => {
      const files = await readWorkspaceFiles(runtime.rootReal);
      const compiled = compileAgentAction(
        { runtime, editRefs: runtime.editRefs, requestId: request.requestId, generated: null },
        request.action,
      );
      // A user-named topic must never reuse even an empty or non-Markdown directory.
      // This check is inside the writer queue, before candidate creation/transaction.
      if (request.action.action === "createTopic" && compiled.created.topicPath !== null) {
        const directory = path.dirname(
          path.join(runtime.rootReal, ...compiled.created.topicPath.split("/")),
        );
        const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (stat !== null) {
          throw new ServiceError(
            409,
            "OPERATION_CONFLICT",
            "主题目录已存在，拒绝覆盖：" + path.basename(directory),
            {},
          );
        }
      }
      const generated =
        compiled.created.nodeIds.length > 0 || compiled.created.topicId !== null
          ? {
              topicId: compiled.created.topicId ?? "",
              nodeId: compiled.created.nodeIds[0] ?? "",
              dir: compiled.created.paths[0]?.split("/")[1] ?? "",
            }
          : null;

      const changeRequest: ChangeRequest = {
        workspaceId: request.workspaceId,
        requestId: request.requestId,
        expectedFiles: compiled.expectedFiles,
        operations: compiled.operations,
      };

      let prepared: PreparedChanges;
      try {
        prepared = prepareChanges(files, changeRequest);
      } catch (error) {
        diagnoseChange(error);
      }

      const outcome = await commitPreparedChanges(runtime, {
        requestId: request.requestId,
        prepared,
      });
      const response = agentResponseOf(runtime, request, compiled, prepared, outcome);
      runtime.recordAgentChange({
        requestId: request.requestId,
        bodyHash: rawBodyHash,
        httpStatus: 200,
        state: outcome.state,
        body: response,
        recordedAt: new Date().toISOString(),
        generated,
      });
      return response;
    },
  );
}
