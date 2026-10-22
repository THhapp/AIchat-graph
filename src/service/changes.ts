/**
 * 变更集合的检查与提交。
 *
 * - check 与 apply 都排在协调器队列里，都从磁盘重新读取，不复用上次 check；
 * - 候选语义全部委托 storage.prepareChanges，这里只做队列、幂等与提交编排；
 * - apply 在队列内独立重读，commitFiles 负责 prepared／原子写／committed；
 * - 提交后重建并发布快照，确认成功才 completeTransaction；刷新失败保留日志并报
 *   COMMITTED_REFRESH_PENDING，绝不回滚已提交源文件。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ChangeError,
  commitFiles,
  completeTransaction,
  prepareChangesForWorkspace,
  readWorkspaceFiles,
  sha256Bytes,
  type AnyChangeRequest,
  type CommitFileInput,
  type PreparedChanges,
  type V2ChangeRequest,
} from "../storage/index.js";
import type { AgentChangeRequest, AgentChangeResponse } from "../shared/protocol.js";
import { compileAgentAction, issueRefForNode } from "./agent.js";
import type { Diagnostic } from "../shared/protocol.js";
import type { StorageDiagnostic } from "../storage/index.js";
import { serviceErrorFromChange, ServiceError, wireDiagnostic } from "./errors.js";
import type { ChangeRecord, WorkspaceRuntime } from "./workspace.js";

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
  /** revision 的显式别名：变更结果使用 snapshotRevision 命名。 */
  readonly snapshotRevision: number;
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
  readonly snapshotRevision: number;
  readonly transactionId: string | null;
  readonly touchedFiles: CommittedFileView[];
  readonly changedNodeIds: string[];
  readonly summary: string;
  readonly diagnostics: Diagnostic[];
  readonly committed: boolean;
  readonly journalCleaned: boolean;
  readonly replayed?: boolean;
}

function diagnoseChange(error: unknown): never {
  if (error instanceof ChangeError) throw serviceErrorFromChange(error);
  throw error;
}

function fileViews(files: readonly CommitFileInput[]): CheckedFile[] {
  return files.map((file) => ({
    path: file.path,
    expectedSha256: file.expectedSha256,
    nextSha256: file.content === null ? null : sha256Bytes(file.content),
    deleted: file.content === null,
  }));
}

/** 只验证，不写文件；失败时磁盘内容完全不变。 */
export async function checkChanges(
  runtime: WorkspaceRuntime,
  request: AnyChangeRequest,
): Promise<CheckResult> {
  return runtime.queue.run(async () => {
    const files = await readWorkspaceFiles(runtime.rootReal);
    let prepared;
    try {
      prepared = prepareChangesForWorkspace(files, request);
    } catch (error) {
      diagnoseChange(error);
    }
    return {
      ok: true as const,
      dryRun: true as const,
      requestId: request.requestId,
      instanceId: runtime.instanceId,
      revision: runtime.revision,
      snapshotRevision: runtime.revision,
      changedNodeIds: prepared.changedNodeIds,
      summary: prepared.summary,
      files: fileViews(prepared.files),
      diagnostics: prepared.diagnostics.map((diagnostic: StorageDiagnostic) =>
        wireDiagnostic(
          diagnostic.code,
          diagnostic.message,
          diagnostic.path,
          "info",
        ),
      ),
      noop: prepared.files.length === 0,
    };
  });
}

function replayOf(record: ChangeRecord): ApplyResult {
  const body = record.body as ApplyResult;
  return { ...body, replayed: true };
}

/**
 * 提交一次变更集合。
 *
 * 幂等：相同 requestId 与相同请求体直接返回原结果；相同 requestId 不同请求体
 * 返回 409 OPERATION_CONFLICT，绝不把它当成新请求执行。
 */
export async function applyChanges(
  runtime: WorkspaceRuntime,
  request: AnyChangeRequest,
  rawBodyHash: string,
): Promise<ApplyResult> {
  const existing = runtime.requestLog.get(request.requestId);
  if (existing !== undefined) {
    if (existing.bodyHash === rawBodyHash) return replayOf(existing);
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "requestId 已被另一份请求体使用；请换新的 requestId，不重放旧请求",
      {
        details: {
          requestId: request.requestId,
          recordedAt: existing.recordedAt,
          state: existing.state,
        },
      },
    );
  }

  return runtime.queue.run(async () => {
    // 排队期间可能已有同 requestId 的结果；再次核对，保证"只执行一次"。
    const queued = runtime.requestLog.get(request.requestId);
    if (queued !== undefined) {
      if (queued.bodyHash === rawBodyHash) return replayOf(queued);
      throw new ServiceError(409, "OPERATION_CONFLICT", "requestId 已被另一份请求体使用", {
        details: { requestId: request.requestId },
      });
    }
    if (!runtime.writable) {
      throw new ServiceError(
        409,
        "WRITE_DISABLED",
        "受控写入已停用（" + (runtime.writableReason ?? "UNKNOWN") + "）；可继续只读诊断，修好后重启服务",
        { details: { reason: runtime.writableReason } },
      );
    }

    const files = await readWorkspaceFiles(runtime.rootReal);
    let prepared;
    try {
      prepared = prepareChangesForWorkspace(files, request);
    } catch (error) {
      diagnoseChange(error);
    }

    if (prepared.files.length === 0) {
      // no-op：不调用 commitFiles，也不递增 revision。
      const result: ApplyResult = {
        ok: true,
        requestId: request.requestId,
        state: "noop",
        instanceId: runtime.instanceId,
        revision: runtime.revision,
        snapshotRevision: runtime.revision,
        transactionId: null,
        touchedFiles: [],
        changedNodeIds: prepared.changedNodeIds,
        summary: prepared.summary,
        diagnostics: prepared.diagnostics.map((diagnostic: StorageDiagnostic) =>
          wireDiagnostic(diagnostic.code, diagnostic.message, diagnostic.path, "info"),
        ),
        committed: false,
        journalCleaned: true,
      };
      runtime.recordChange({
        requestId: request.requestId,
        bodyHash: rawBodyHash,
        httpStatus: 200,
        state: "noop",
        body: result,
        recordedAt: new Date().toISOString(),
      });
      return result;
    }

    let committed;
    try {
      committed = await commitFiles({
        root: runtime.rootReal,
        files: prepared.files,
        requestId: request.requestId,
      });
    } catch (error) {
      diagnoseChange(error);
    }

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
      const pending: ApplyResult = {
        ok: true,
        requestId: request.requestId,
        state: "committed_refresh_pending",
        instanceId: runtime.instanceId,
        revision: runtime.revision,
        snapshotRevision: runtime.revision,
        transactionId: committed.transactionId,
        touchedFiles: committed.touchedFiles.map((file) => ({
          path: file.path,
          beforeSha256: file.beforeSha256,
          afterSha256: file.afterSha256,
          byteLength: file.byteLength,
        })),
        changedNodeIds: prepared.changedNodeIds,
        summary: prepared.summary,
        diagnostics: [
          ...prepared.diagnostics.map((diagnostic: StorageDiagnostic) =>
            wireDiagnostic(diagnostic.code, diagnostic.message, diagnostic.path, "info"),
          ),
          ...reload.diagnostics,
          wireDiagnostic(
            "COMMITTED_REFRESH_PENDING",
            "源文件已提交并保留事务日志；当前磁盘无法重建有效快照，需修复后重启服务",
          ),
        ],
        committed: true,
        journalCleaned: false,
      };
      runtime.recordChange({
        requestId: request.requestId,
        bodyHash: rawBodyHash,
        httpStatus: 200,
        state: "committed_refresh_pending",
        body: pending,
        recordedAt: new Date().toISOString(),
      });
      return pending;
    }

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

    const result: ApplyResult = {
      ok: true,
      requestId: request.requestId,
      state: "committed",
      instanceId: runtime.instanceId,
      revision: reload.revision,
      snapshotRevision: reload.revision,
      transactionId: committed.transactionId,
      touchedFiles: committed.touchedFiles.map((file) => ({
        path: file.path,
        beforeSha256: file.beforeSha256,
        afterSha256: file.afterSha256,
        byteLength: file.byteLength,
      })),
      changedNodeIds: prepared.changedNodeIds,
      summary: prepared.summary,
      diagnostics: [
        ...prepared.diagnostics.map((diagnostic: StorageDiagnostic) =>
          wireDiagnostic(diagnostic.code, diagnostic.message, diagnostic.path, "info"),
        ),
        ...(cleanupDiagnostic === null ? [] : [cleanupDiagnostic]),
      ],
      committed: true,
      journalCleaned,
    };
    runtime.recordChange({
      requestId: request.requestId,
      bodyHash: rawBodyHash,
      httpStatus: 200,
      state: "committed",
      body: result,
      recordedAt: new Date().toISOString(),
    });
    return result;
  });
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
): Promise<AgentChangeResponse> {
  const existing = agentRecordOf(runtime.agentLog.get(request.requestId));
  if (existing !== undefined && existing !== null) {
    if (existing.bodyHash === rawBodyHash) {
      return { ...(existing.body as AgentChangeResponse), replayed: true };
    }
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "requestId 已被另一份请求体使用；请换新的 requestId，不重放旧请求",
      { details: { requestId: request.requestId, recordedAt: existing.recordedAt } },
    );
  }

  return runtime.queue.run(async () => {
    const queued = agentRecordOf(runtime.agentLog.get(request.requestId));
    if (queued !== null && queued !== undefined) {
      if (queued.bodyHash === rawBodyHash) {
        return { ...(queued.body as AgentChangeResponse), replayed: true };
      }
      throw new ServiceError(409, "OPERATION_CONFLICT", "requestId 已被另一份请求体使用", {
        details: { requestId: request.requestId },
      });
    }
    if (!runtime.writable) {
      throw new ServiceError(
        409,
        "WRITE_DISABLED",
        "受控写入已停用（" + (runtime.writableReason ?? "UNKNOWN") + "）；可继续只读诊断，修好后重启服务",
        { details: { reason: runtime.writableReason } },
      );
    }

    const files = await readWorkspaceFiles(runtime.rootReal);
    const compiled = compileAgentAction(
      { runtime, editRefs: runtime.editRefs, requestId: request.requestId, generated: null },
      request.action,
    );
    // A user-named topic must never reuse even an empty or non-Markdown directory.
    // This check is inside the writer queue, before candidate creation/transaction.
    if (request.action.action === "createTopic" && compiled.created.topicPath !== null) {
      const directory = path.dirname(path.join(runtime.rootReal, ...compiled.created.topicPath.split("/")));
      const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat !== null) throw new ServiceError(409, "OPERATION_CONFLICT", "主题目录已存在，拒绝覆盖：" + path.basename(directory), {});
    }
    const generated =
      compiled.created.nodeIds.length > 0 || compiled.created.topicId !== null
        ? {
            topicId: compiled.created.topicId ?? "",
            nodeId: compiled.created.nodeIds[0] ?? "",
            dir: compiled.created.paths[0]?.split("/")[1] ?? "",
          }
        : null;

    const changeRequest: AnyChangeRequest = {
      workspaceId: request.workspaceId,
      requestId: request.requestId,
      expectedFiles: compiled.expectedFiles,
      operations: compiled.operations,
    } as AnyChangeRequest;

    const prepared = prepareAgentChanges(files, changeRequest);

    if (prepared.files.length === 0) {
      const noop: AgentChangeResponse = {
        ...runtime.snapshotVersion(),
        ok: true,
        requestId: request.requestId,
        action: request.action.action,
        state: "noop",
        created: compiled.created,
        affectedNodeIds: prepared.changedNodeIds,
        changedNodeIds: prepared.changedNodeIds,
        touchedFiles: [],
        editRef: issueRefForNode(runtime, runtime.editRefs, compiled.primaryNodeId ?? ""),
        summary: prepared.summary,
        diagnostics: prepared.diagnostics.map((diagnostic) =>
          wireDiagnostic(diagnostic.code, diagnostic.message, diagnostic.path, "info"),
        ),
        transactionId: null,
        journalCleaned: true,
      };
      runtime.recordAgentChange({
        requestId: request.requestId,
        bodyHash: rawBodyHash,
        httpStatus: 200,
        state: "noop",
        body: noop,
        recordedAt: new Date().toISOString(),
        generated,
      });
      return noop;
    }

    let committed;
    try {
      committed = await commitFiles({
        root: runtime.rootReal,
        files: prepared.files,
        requestId: request.requestId,
      });
    } catch (error) {
      diagnoseChange(error);
    }

    const reload = await runtime.reloadFromDisk().catch((error: unknown) => ({
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
    }));

    if (!reload.ok) {
      runtime.disableWrites(
        "COMMITTED_REFRESH_PENDING",
        "已提交事务 " + committed.transactionId + " 的源文件已落盘，但当前磁盘无法重建有效快照；保留事务日志，修复后重启服务",
      );
      const pending: AgentChangeResponse = {
        ...runtime.snapshotVersion(),
        ok: true,
        requestId: request.requestId,
        action: request.action.action,
        state: "committed_refresh_pending",
        created: compiled.created,
        affectedNodeIds: prepared.changedNodeIds,
        changedNodeIds: prepared.changedNodeIds,
        touchedFiles: committed.touchedFiles.map((file) => ({
          path: file.path,
          beforeSha256: file.beforeSha256,
          afterSha256: file.afterSha256,
          byteLength: file.byteLength,
        })),
        editRef: null,
        summary: prepared.summary,
        diagnostics: [
          ...prepared.diagnostics.map((diagnostic) =>
            wireDiagnostic(diagnostic.code, diagnostic.message, diagnostic.path, "info"),
          ),
          ...reload.diagnostics,
        ],
        transactionId: committed.transactionId,
        journalCleaned: false,
      };
      runtime.recordAgentChange({
        requestId: request.requestId,
        bodyHash: rawBodyHash,
        httpStatus: 200,
        state: "committed_refresh_pending",
        body: pending,
        recordedAt: new Date().toISOString(),
        generated,
      });
      return pending;
    }

    let journalCleaned = false;
    try {
      await completeTransaction(runtime.rootReal, committed.transactionId);
      journalCleaned = true;
    } catch (error) {
      runtime.disableWrites(
        "JOURNAL_CLEANUP_FAILED",
        "已提交事务 " + committed.transactionId + " 的快照已刷新，但日志清理失败；受控写入停用，重启后核对再清理",
      );
      runtime.addSystemDiagnostic(
        wireDiagnostic(
          "JOURNAL_CLEANUP_FAILED",
          "事务日志清理失败：" + (error instanceof Error ? error.message : String(error)),
        ),
      );
    }

    const result: AgentChangeResponse = {
      ...runtime.snapshotVersion(),
      ok: true,
      requestId: request.requestId,
      action: request.action.action,
      state: "committed",
      created: compiled.created,
      affectedNodeIds: prepared.changedNodeIds,
      changedNodeIds: prepared.changedNodeIds,
      touchedFiles: committed.touchedFiles.map((file) => ({
        path: file.path,
        beforeSha256: file.beforeSha256,
        afterSha256: file.afterSha256,
        byteLength: file.byteLength,
      })),
      editRef:
        compiled.primaryNodeId === null
          ? null
          : issueRefForNode(runtime, runtime.editRefs, compiled.primaryNodeId),
      summary: prepared.summary,
      diagnostics: prepared.diagnostics.map((diagnostic) =>
        wireDiagnostic(diagnostic.code, diagnostic.message, diagnostic.path, "info"),
      ),
      transactionId: committed.transactionId,
      journalCleaned,
    };
    runtime.recordAgentChange({
      requestId: request.requestId,
      bodyHash: rawBodyHash,
      httpStatus: 200,
      state: "committed",
      body: result,
      recordedAt: new Date().toISOString(),
      generated,
    });
    return result;
  });
}

/** 候选计算失败时统一转成服务错误（保留 details 与诊断）。 */
function prepareAgentChanges(files: Awaited<ReturnType<typeof readWorkspaceFiles>>, request: AnyChangeRequest): PreparedChanges {
  try {
    return prepareChangesForWorkspace(files, request);
  } catch (error) {
    diagnoseChange(error);
  }
}

export type { V2ChangeRequest };