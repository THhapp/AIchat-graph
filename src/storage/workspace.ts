import { promises as fs } from "node:fs";
import { TextDecoder } from "node:util";
import path from "node:path";
import { StorageError, isErrnoCode } from "./errors.js";
import type { StorageDiagnostic } from "./errors.js";
import { sha256Bytes } from "./hash.js";
import {
  assertPathInsideWorkspace,
  isWritableContentPath,
  normalizeRelativePath,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
} from "./paths.js";
import {
  TOPIC_META_FILENAME,
  TOPICS_DIR,
  isV2TopicFilePath,
  parseTopicPath,
} from "./format-v2.js";
import type { WorkspaceSchemaVersion } from "./format-v2.js";

export type LineEnding = "\n" | "\r\n";

/** 一次扫描得到的原始文件事实；哈希始终来自磁盘原始字节。 */
export interface WorkspaceFile {
  /** 工作区相对路径，POSIX 分隔符。 */
  path: string;
  absolutePath: string;
  sha256: string;
  byteLength: number;
  /** UTF-8 解码文本，保留 BOM 与原始换行。 */
  text: string;
  lineEnding: LineEnding;
  mtimeMs: number;
}

/**
 * workspace.json 的最小身份字段。业务层仍须用 core.workspaceMetaSchema
 * 对完整原始 JSON 做严格校验；这里只拒绝明显不合法或不支持的结构，
 * 不把未知字段当作可忽略的扩展。
 */
export interface WorkspaceInfo {
  /** 1 = 主题文件内多卡片；2 = 一节点一份 Markdown。扫描不改写版本。 */
  schemaVersion: WorkspaceSchemaVersion;
  topicMode?: "isolated" | "shared";
  workspaceId: string;
  name: string;
  activeNode: string | null;
}

export interface WorkspaceFiles {
  /** 规范化后的真实工作区根。 */
  root: string;
  workspacePath: string;
  workspaceFile: WorkspaceFile;
  workspace: WorkspaceInfo;
  topics: WorkspaceFile[];
  /** 路径级诊断（例如跳过的符号链接），不是内容 schema 校验。 */
  diagnostics: StorageDiagnostic[];
  scannedAt: string;
}

function detectLineEnding(text: string): LineEnding {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * 原始字节以 UTF-8 严格解码；无效序列直接报错，绝不用替换字符后写回冒充原字节。
 */
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeUtf8Strict(bytes: Uint8Array, relativePath: string): string {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch (error) {
    throw new StorageError("WORKSPACE_INVALID", `文件不是合法 UTF-8: ${relativePath}`, {
      path: relativePath,
      cause: error,
    });
  }
}

async function readWorkspaceFileAt(
  root: string,
  relativePath: string,
  absolutePath: string,
): Promise<WorkspaceFile> {
  const bytes = await fs.readFile(absolutePath);
  const stat = await fs.stat(absolutePath);
  const text = decodeUtf8Strict(bytes, relativePath);
  return {
    path: relativePath,
    absolutePath,
    sha256: sha256Bytes(bytes),
    byteLength: bytes.byteLength,
    text,
    lineEnding: detectLineEnding(text),
    mtimeMs: stat.mtimeMs,
  };
}

/** 读取工作区内的一个受控内容文件（workspace.json 或 topics 下的 Markdown）。 */
export async function readWorkspaceFile(
  root: string,
  relativePath: string,
): Promise<WorkspaceFile> {
  const rootReal = await resolveWorkspaceRoot(root);
  if (!isWritableContentPath(normalizeRelativePath(relativePath))) {
    throw new StorageError(
      "PATH_NOT_ALLOWED",
      `读取只允许 workspace.json 与 topics 下的 Markdown: ${relativePath}`,
      { path: relativePath },
    );
  }
  const absolutePath = await assertPathInsideWorkspace(rootReal, relativePath);
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new StorageError("INVALID_ARGUMENT", `文件不存在: ${relativePath}`, {
        path: relativePath,
      });
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new StorageError("INVALID_ARGUMENT", `不是普通文件: ${relativePath}`, {
      path: relativePath,
    });
  }
  return readWorkspaceFileAt(rootReal, relativePath, absolutePath);
}

const WORKSPACE_ALLOWED_KEYS = new Set(["schemaVersion", "workspaceId", "name", "activeNode", "topicMode"]);
const SUPPORTED_WORKSPACE_VERSIONS: readonly WorkspaceSchemaVersion[] = [1, 2];

export function parseWorkspaceInfo(text: string, workspacePath = "workspace.json"): WorkspaceInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StorageError("WORKSPACE_INVALID", "workspace.json 不是合法 JSON", {
      path: workspacePath,
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StorageError("WORKSPACE_INVALID", "workspace.json 必须是 JSON 对象", {
      path: workspacePath,
    });
  }
  const record = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !WORKSPACE_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new StorageError(
      "WORKSPACE_INVALID",
      `workspace.json 包含未知字段: ${unknownKeys.join(", ")}`,
      { path: workspacePath, details: { unknownKeys } },
    );
  }
  const declaredVersion = record.schemaVersion;
  if (declaredVersion !== 1 && declaredVersion !== 2) {
    throw new StorageError(
      "WORKSPACE_INVALID",
      `只支持 schemaVersion 1 或 2，收到 ${JSON.stringify(declaredVersion)}；更高版本需要显式迁移`,
      { path: workspacePath },
    );
  }
  const schemaVersion: WorkspaceSchemaVersion = declaredVersion;
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim() === "") {
    throw new StorageError("WORKSPACE_INVALID", "workspace.json 缺少 workspaceId", {
      path: workspacePath,
    });
  }
  if (typeof record.name !== "string" || record.name.trim() === "") {
    throw new StorageError("WORKSPACE_INVALID", "workspace.json 缺少 name", {
      path: workspacePath,
    });
  }
  if (!("activeNode" in record)) {
    throw new StorageError("WORKSPACE_INVALID", "workspace.json 缺少 activeNode", {
      path: workspacePath,
    });
  }
  if (record.activeNode !== null && typeof record.activeNode !== "string") {
    throw new StorageError("WORKSPACE_INVALID", "workspace.json 的 activeNode 必须是字符串或 null", {
      path: workspacePath,
    });
  }
  if (record.topicMode !== undefined && record.topicMode !== "shared" && record.topicMode !== "isolated") {
    throw new StorageError("WORKSPACE_INVALID", "topicMode 必须是 isolated 或 shared", { path: workspacePath });
  }
  if (schemaVersion === 1 && record.topicMode === "isolated") {
    throw new StorageError("WORKSPACE_INVALID", "格式 1 只支持 shared 主题模式", { path: workspacePath });
  }
  return {
    schemaVersion,
    ...(record.topicMode !== undefined ? { topicMode: record.topicMode } : {}),
    workspaceId: record.workspaceId,
    name: record.name,
    activeNode: record.activeNode as string | null,
  };
}

async function collectTopicFiles(
  root: string,
  relativeDirectory: string,
  files: WorkspaceFile[],
  diagnostics: StorageDiagnostic[],
): Promise<void> {
  const absoluteDirectory = resolveWorkspacePath(root, relativeDirectory);
  let directoryStat;
  try {
    directoryStat = await fs.lstat(absoluteDirectory);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      diagnostics.push({
        code: "TOPICS_DIR_MISSING",
        message: "topics 目录不存在，按空主题集合读取",
        path: relativeDirectory,
      });
      return;
    }
    throw error;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    diagnostics.push({
      code: "PATH_SYMLINK_SKIPPED",
      message: "topics 不是真实目录（可能是符号链接），已跳过",
      path: relativeDirectory,
    });
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      diagnostics.push({
        code: "TOPICS_DIR_MISSING",
        message: "topics 目录不存在，按空主题集合读取",
        path: "topics",
      });
      return;
    }
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      diagnostics.push({
        code: "PATH_SYMLINK_SKIPPED",
        message: "跳过 topics 下的符号链接，避免越过工作区",
        path: relativePath,
      });
      continue;
    }
    if (entry.isDirectory()) {
      await collectTopicFiles(root, relativePath, files, diagnostics);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    // 逐级确认没有符号链接与越界后再读取。
    const absolutePath = await assertPathInsideWorkspace(root, relativePath);
    files.push(await readWorkspaceFileAt(root, relativePath, absolutePath));
  }
}

/**
 * 扫描 workspace.json 与 topics 下的全部 Markdown。
 * 只返回磁盘事实；语法与图校验由 core 负责。
 * 调用方应先通过 resolveWorkspaceRoot 规范化根目录。
 */
export async function readWorkspaceFiles(root: string): Promise<WorkspaceFiles> {
  const rootReal = await resolveWorkspaceRoot(root);
  const workspacePath = resolveWorkspacePath(rootReal, "workspace.json");
  let stat;
  try {
    stat = await fs.lstat(workspacePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new StorageError("WORKSPACE_INVALID", "工作区缺少 workspace.json", {
        path: "workspace.json",
      });
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new StorageError("WORKSPACE_INVALID", "workspace.json 不是普通文件", {
      path: "workspace.json",
    });
  }
  const workspaceFile = await readWorkspaceFileAt(rootReal, "workspace.json", workspacePath);
  const workspace = parseWorkspaceInfo(workspaceFile.text, "workspace.json");
  const topics: WorkspaceFile[] = [];
  const diagnostics: StorageDiagnostic[] = [];
  // 扫描事实与格式版本无关：一律列出 topics 下全部 Markdown，由调用方按版本分组。
  await collectTopicFiles(rootReal, "topics", topics, diagnostics);
  return {
    root: rootReal,
    workspacePath,
    workspaceFile,
    workspace,
    topics,
    diagnostics,
    scannedAt: new Date().toISOString(),
  };
}

/** 便利方法：扫描后按文件路径查找主题。 */
export function findTopicFile(files: WorkspaceFiles, relativePath: string): WorkspaceFile | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  return files.topics.find((file) => file.path === normalized);
}

/**
 * 按主题目录分组的扫描事实。
 *
 * 这里只按路径布局分类，不判断文件内容是否合法：谁是 topic.md、谁是节点文件由路径决定，
 * 内容解析与图校验归 core。V1 的文件全部落在 loose 里，因为 V1 没有主题目录概念。
 */
export interface TopicGroup {
  /** 主题目录（topics 下一层；V1 为空字符串）。 */
  readonly directory: string;
  /** V2 主题元数据文件（topics/<dir>/topic.md）。 */
  readonly meta: WorkspaceFile | null;
  /** 该目录下的其余 Markdown（V2 即节点文件）。 */
  readonly files: readonly WorkspaceFile[];
  /** 本组全部真实源路径，含 topic.md。 */
  readonly sourcePaths: readonly string[];
}

export interface GroupedWorkspaceFiles {
  /** topics 根下直接的 Markdown：V1 的主题文件。 */
  readonly loose: readonly WorkspaceFile[];
  readonly groups: readonly TopicGroup[];
  /** 不符合 topics/<dir>/<file> 层级的路径（诊断用，不参与解析）。 */
  readonly misplaced: readonly string[];
}

/** 扫描结果的复用入口：按 V2 目录布局分组，V1 归入 loose。 */
export function groupWorkspaceFiles(files: WorkspaceFiles): GroupedWorkspaceFiles {
  if (files.workspace.schemaVersion !== 2) {
    return {
      loose: files.topics,
      groups: [],
      misplaced: [],
    };
  }
  const byDirectory = new Map<string, { meta: WorkspaceFile | null; files: WorkspaceFile[] }>();
  const misplaced: string[] = [];
  for (const file of files.topics) {
    // 主题目录固定 topics 下一层：更深或更浅都属于错误归属，交给诊断，不猜。
    if (!isV2TopicFilePath(file.path)) {
      misplaced.push(file.path);
      continue;
    }
    const parsed = parseTopicPath(file.path);
    if (!parsed) {
      misplaced.push(file.path);
      continue;
    }
    const bucket = byDirectory.get(parsed.directory) ?? { meta: null, files: [] };
    if (parsed.isTopicMeta) bucket.meta = file;
    else bucket.files.push(file);
    byDirectory.set(parsed.directory, bucket);
  }
  const groups: TopicGroup[] = [];
  for (const [directory, bucket] of [...byDirectory.entries()].sort((left, right) =>
    left[0].localeCompare(right[0], "en"),
  )) {
    const sourcePaths: string[] = [];
    if (bucket.meta) sourcePaths.push(bucket.meta.path);
    for (const file of bucket.files) sourcePaths.push(file.path);
    groups.push({
      directory,
      meta: bucket.meta,
      files: [...bucket.files].sort((left, right) => left.path.localeCompare(right.path, "en")),
      sourcePaths,
    });
  }
  return { loose: [], groups, misplaced };
}

/** 该工作区期望的主题入口文件名（V2 固定 topic.md）。 */
export function expectedTopicMetaPath(directory: string): string {
  return TOPICS_DIR + "/" + directory + "/" + TOPIC_META_FILENAME;
}

/** 工作区内的绝对路径（不做存在性检查）。 */
export function workspaceFilePath(rootReal: string, relativePath: string): string {
  return resolveWorkspacePath(rootReal, relativePath);
}