/**
 * .aichat/cache 的可重建派生缓存。
 *
 * 存储边界：
 * - 这里只放轻量派生信息：workspace 身份、文件路径与字节哈希、manifest；
 * - 绝不保存节点正文／主题原文副本——完整有效内容只在内存 SnapshotData；
 * - 因此缓存不能冒充有效图：启动总是按真实源文件重建，缓存仅用于
 *   "workspace.json 暂时不可读时"给出身份提示与清理诊断路径。
 *
 * 缓存写入失败不影响已发布的内存快照；读取只接受与当前 workspaceId 匹配、
 * 格式正确的记录，任何不一致都当作 miss。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ensureWorkspaceDirectory,
  isErrnoCode,
  writeFileDurable,
} from "../storage/index.js";
import type { SupportedSchemaVersion } from "../core/index.js";
import type { SnapshotData } from "./snapshot.js";

export const CACHE_DIR = ".aichat/cache";
const SNAPSHOT_FILE = "snapshot.json";
const MANIFEST_FILE = "manifest.json";
const CACHE_FORMAT = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface CacheIdentity {
  readonly workspaceId: string;
  readonly name: string;
  readonly schemaVersion: SupportedSchemaVersion;
  readonly topicMode?: "isolated" | "shared";
}

interface CachedSnapshot {
  schemaVersion: number;
  workspaceId: string;
  schemaFormat: 1 | 2;
  topicMode: "isolated" | "shared";
  name: string;
  activeNode: string | null;
  workspaceHash: string;
  fingerprint: string;
  savedAt: string;
  /** 文件路径 → 原始字节哈希；不含任何正文。 */
  fileHashes: Record<string, string>;
  resourceHashes: Record<string, string>;
}

function cacheDir(rootReal: string): string {
  return path.join(rootReal, ...CACHE_DIR.split("/"));
}

/**
 * 保存轻量派生信息。
 * 显式不写 raw／body：谁想从缓存复原正文，都只能回到真实源文件。
 */
export async function saveCache(rootReal: string, data: SnapshotData): Promise<boolean> {
  if (data.fingerprint === "") return false;
  const fileHashes: Record<string, string> = {};
  const resourceHashes: Record<string, string> = {};
  for (const topic of data.topics) {
    for (const file of topic.files) fileHashes[file.path] = file.fileHash;
    for (const resource of topic.resourceFiles) resourceHashes[resource.path] = resource.sha256;
  }
  const payload: CachedSnapshot = {
    schemaVersion: CACHE_FORMAT,
    workspaceId: data.workspaceId,
    schemaFormat: data.schemaVersion,
    topicMode: data.topicMode ?? "shared",
    name: data.name,
    activeNode: data.activeNode,
    workspaceHash: data.workspaceHash,
    fingerprint: data.fingerprint,
    savedAt: new Date().toISOString(),
    fileHashes,
    resourceHashes,
  };
  try {
    await ensureWorkspaceDirectory(rootReal, CACHE_DIR);
    const dir = cacheDir(rootReal);
    await writeFileDurable(
      path.join(dir, SNAPSHOT_FILE),
      Buffer.from(JSON.stringify(payload), "utf8"),
    );
    await writeFileDurable(
      path.join(dir, MANIFEST_FILE),
      Buffer.from(JSON.stringify(data.manifest, null, 2), "utf8"),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 只读取工作区身份与格式。workspace.json 暂时不可读时用于继续提供只读诊断；
 * 不是"有效内容"，也不能据此构造图。
 */
export async function loadCacheIdentity(rootReal: string): Promise<CacheIdentity | null> {
  const file = path.join(cacheDir(rootReal), SNAPSHOT_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed["schemaVersion"] !== CACHE_FORMAT) return null;
    const workspaceId = parsed["workspaceId"];
    const name = parsed["name"];
    const schemaVersion = parsed["schemaFormat"];
    if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;
    if (typeof name !== "string" || name.length === 0) return null;
    if (schemaVersion !== 1 && schemaVersion !== 2) return null;
    const topicMode = parsed["topicMode"] ?? "shared";
    if (topicMode !== "isolated" && topicMode !== "shared") return null;
    if (schemaVersion === 1 && topicMode === "isolated") return null;
    return { workspaceId, name, schemaVersion, topicMode };
  } catch {
    return null;
  }
}

/** 缓存记录的源文件哈希；仅用于诊断"磁盘是否仍与上次有效发布一致"。 */
export async function loadCachedFileHashes(
  rootReal: string,
  workspaceId: string,
): Promise<Record<string, string> | null> {
  const file = path.join(cacheDir(rootReal), SNAPSHOT_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed["schemaVersion"] !== CACHE_FORMAT) return null;
    if (parsed["workspaceId"] !== workspaceId) return null;
    const hashes = parsed["fileHashes"];
    if (!isRecord(hashes)) return null;
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(hashes)) {
      if (typeof value === "string") output[key] = value;
    }
    return output;
  } catch {
    return null;
  }
}
