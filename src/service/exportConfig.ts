/**
 * 本机导出目标的持久化配置（.aichat/local/exports.json）。
 *
 * 与宿主机绑定，不进入源内容；取消绑定不删除已有成品。
 * 配置只记录目标、授权时的目标字节哈希与最后成功指纹，重建失败不会悄悄改写绑定。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertPathInsideWorkspace,
  ensureWorkspaceDirectory,
  isErrnoCode,
  writeFileDurable,
} from "../storage/index.js";

export const LOCAL_DIR = ".aichat/local";
export const EXPORT_CONFIG_PATH = ".aichat/local/exports.json";
const CONFIG_FORMAT = 1;

/**
 * 写前待确认记录（最小记账）：只放哈希／指纹／版本／目标，
 * 绝不含 HTML 正文。它让"已替换但完成记账失败"可在重启后按实际字节核实。
 */
export interface ExportPendingRecord {
  /** 替换前的目标字节哈希；null 表示此前不存在。 */
  baseHash: string | null;
  /** 本次写入的完整 HTML 字节哈希。 */
  nextHash: string;
  contentFingerprint: string;
  readerFingerprint: string;
  exportFingerprint: string;
  revision: number;
  recordedAt: string;
}

export interface ExportTargetRecord {
  /** 用户明确选择的绝对 .html 路径。 */
  targetPath: string;
  /** 绑定/上次成功写入后的目标字节哈希；替换前必须仍一致。 */
  targetHash: string | null;
  lastSuccessAt: string | null;
 /** 最后成功的内容指纹（= OfflineTopicDocument.fingerprint）。 */
  exportedContentFingerprint: string | null;
  /** 最后成功的读者构建指纹。 */
  exportedReaderFingerprint: string | null;
  /** 最后成功的成品指纹（内容+读者+格式）。 */
  exportedExportFingerprint: string | null;
  exportedRevision: number | null;
  lastError: string | null;
  /** 写前记账；null 表示没有未完成的替换。 */
  pending: ExportPendingRecord | null;
}

interface ExportConfigFile {
  format: number;
  workspaceId: string;
  topics: Record<string, ExportTargetRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parsePending(raw: unknown): ExportPendingRecord | null {
  if (!isRecord(raw)) return null;
  const baseHash = raw["baseHash"];
  if (!isStringOrNull(baseHash)) return null;
  const nextHash = raw["nextHash"];
  if (typeof nextHash !== "string" || !/^[0-9a-f]{64}$/.test(nextHash)) return null;
  const content = raw["contentFingerprint"];
  const reader = raw["readerFingerprint"];
  const exportFp = raw["exportFingerprint"];
  if (typeof content !== "string" || typeof reader !== "string" || typeof exportFp !== "string") {
    return null;
  }
  const revision = raw["revision"];
  if (typeof revision !== "number") return null;
  const recordedAt = raw["recordedAt"];
  if (typeof recordedAt !== "string") return null;
  return { baseHash, nextHash, contentFingerprint: content, readerFingerprint: reader, exportFingerprint: exportFp, revision, recordedAt };
}

function parseRecord(topicId: string, raw: unknown): ExportTargetRecord | null {
  if (!isRecord(raw)) return null;
  const targetPath = raw["targetPath"];
  if (typeof targetPath !== "string" || targetPath.length === 0) return null;
  if (!isStringOrNull(raw["targetHash"])) return null;
  if (!isStringOrNull(raw["lastSuccessAt"])) return null;
  if (!isStringOrNull(raw["exportedContentFingerprint"])) return null;
  if (!isStringOrNull(raw["exportedReaderFingerprint"])) return null;
  if (!isStringOrNull(raw["exportedExportFingerprint"])) return null;
  if (!isStringOrNull(raw["lastError"])) return null;
  const revision = raw["exportedRevision"];
  if (revision !== null && typeof revision !== "number") return null;
  // pending 缺失视为没有未完成替换（旧配置文件可直接读取）。
  const pending = raw["pending"] === undefined || raw["pending"] === null ? null : parsePending(raw["pending"]);
  if (raw["pending"] !== undefined && raw["pending"] !== null && pending === null) return null;
  return {
    targetPath,
    targetHash: raw["targetHash"] as string | null,
    lastSuccessAt: raw["lastSuccessAt"] as string | null,
    exportedContentFingerprint: raw["exportedContentFingerprint"] as string | null,
    exportedReaderFingerprint: raw["exportedReaderFingerprint"] as string | null,
    exportedExportFingerprint: raw["exportedExportFingerprint"] as string | null,
    exportedRevision: revision as number | null,
    lastError: raw["lastError"] as string | null,
    pending,
  };
}

export interface ExportConfigStore {
  readonly workspaceId: string;
  entries: Map<string, ExportTargetRecord>;
}

/** 读取配置；损坏或跨工作区整份忽略（不删除文件，也不丢绑定到别的工作区）。 */
export async function loadExportConfig(
  rootReal: string,
  workspaceId: string,
): Promise<ExportConfigStore> {
  const store: ExportConfigStore = { workspaceId, entries: new Map() };
  let text: string;
  try {
    const absolute = await assertPathInsideWorkspace(rootReal, EXPORT_CONFIG_PATH);
    text = await fs.readFile(absolute, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return store;
    return store;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed["format"] !== CONFIG_FORMAT) return store;
    if (parsed["workspaceId"] !== workspaceId) return store;
    const topics = parsed["topics"];
    if (!isRecord(topics)) return store;
    for (const [topicId, raw] of Object.entries(topics)) {
      const record = parseRecord(topicId, raw);
      if (record !== null) store.entries.set(topicId, record);
    }
  } catch {
    return store;
  }
  return store;
}

/** 原子保存配置；失败抛出具体错误（不静默丢绑定）。 */
export async function saveExportConfig(store: ExportConfigStore, rootReal: string): Promise<void> {
  const payload: ExportConfigFile = {
    format: CONFIG_FORMAT,
    workspaceId: store.workspaceId,
    topics: Object.fromEntries(
      [...store.entries.entries()].sort((left, right) => left[0].localeCompare(right[0], "en")),
    ),
  };
  await ensureWorkspaceDirectory(rootReal, LOCAL_DIR);
  const absolute = await assertPathInsideWorkspace(rootReal, EXPORT_CONFIG_PATH);
  await writeFileDurable(absolute, Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf8"));
}

export function exportConfigPath(rootReal: string): string {
  return path.join(rootReal, ...EXPORT_CONFIG_PATH.split("/"));
}