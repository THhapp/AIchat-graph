/**
 * 有效快照的内存状态与发布。
 *
 * 协调器（workspace.ts）持有唯一一份 Current，所有读取都从它取；
 * revision 只在新快照被接受时递增，同 instanceId 内单调。
 */
import type { Diagnostic } from "../shared/protocol.js";
import type { SnapshotData } from "./snapshot.js";

export interface CurrentSnapshot {
  readonly instanceId: string;
  readonly revision: number;
  /** 当前有效内容；首次启动无有效内容时为空展示。 */
  readonly data: SnapshotData;
  /** true：磁盘上有无法解析／未读到的内容，展示的是上一份有效内容。 */
  readonly stale: boolean;
  /** 当前有效内容对应的诊断（stale 时包含磁盘错误）。 */
  readonly diagnostics: readonly Diagnostic[];
  /** 磁盘上最近一次看到的错误诊断；stale=false 时为空。 */
  readonly diskDiagnostics: readonly Diagnostic[];
}

export interface PublishInput {
  readonly data: SnapshotData;
  readonly diagnostics: readonly Diagnostic[];
  readonly diskDiagnostics: readonly Diagnostic[];
  readonly stale: boolean;
}

/** 内容指纹没变时不递增 revision，也不重复发布。 */
export function nextRevision(
  current: CurrentSnapshot | null,
  data: SnapshotData,
  force = false,
): number {
  if (current === null) return 1;
  if (!force && current.data.fingerprint === data.fingerprint && data.fingerprint !== "") {
    return current.revision;
  }
  return current.revision + 1;
}

export function makeCurrent(
  instanceId: string,
  revision: number,
  input: PublishInput,
): CurrentSnapshot {
  return {
    instanceId,
    revision,
    data: input.data,
    stale: input.stale,
    diagnostics: input.diagnostics,
    diskDiagnostics: input.diskDiagnostics,
  };
}
