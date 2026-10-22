import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AtomicWriter } from "./atomic.js";
import { defaultAtomicWriter, syncDirectoryBestEffort, writeFileDurable } from "./atomic.js";
import { StorageError, isErrnoCode } from "./errors.js";
import { sha256Bytes, sha256File, isSha256Hex } from "./hash.js";
import {
  assertPathInsideWorkspace,
  ensureWorkspaceDirectory,
  normalizeRelativePath,
  resolveWritableContentPath,
  resolveWorkspaceRoot,
} from "./paths.js";

/** 事务目录固定在工作区 .aichat/runtime/transactions 下。 */
export const TRANSACTIONS_DIR = ".aichat/runtime/transactions";
const JOURNAL_FILE = "journal.json";
const JOURNAL_SCHEMA_VERSION = 1;

export type TransactionState = "staged" | "prepared" | "committed";

export interface TransactionFileRecord {
  /** 工作区相对路径（POSIX）。 */
  path: string;
  existedBefore: boolean;
  beforeSha256: string | null;
  beforeBytes: number;
  /** null 表示该操作显式删除此文件。 */
  afterSha256: string | null;
  afterBytes: number;
}

export interface TransactionJournal {
  schemaVersion: number;
  transactionId: string;
  state: TransactionState;
  createdAt: string;
  requestId?: string;
  files: TransactionFileRecord[];
}

export interface CommitFileInput {
  /** 工作区相对路径，只接受 workspace.json 与 topics 下的 Markdown。 */
  path: string;
  /** 完整新内容；storage 原样按 UTF-8 写入，不重排换行。null 表示显式删除。 */
  content: string | null;
  /** 读取该文件时的原始字节 SHA-256；新建文件必须是 null；删除必须是已有哈希。 */
  expectedSha256: string | null;
}

export interface CommitFilesOptions {
  root: string;
  files: CommitFileInput[];
  /** 调用方请求 ID，仅写入日志便于状态查询。 */
  requestId?: string;
  /** 原子写入实现，默认 write-file-atomic（新文件用独占创建）。 */
  writer?: AtomicWriter;
  /**
   * 默认 false：保留 committed 日志，调用方完成快照刷新后必须调用
   * completeTransaction 清理；刷新失败时保留日志并返回 COMMITTED_REFRESH_PENDING。
   */
  cleanupJournal?: boolean;
}

export interface CommittedFile {
  path: string;
  beforeSha256: string | null;
  /** null 表示本次提交删除了该文件。 */
  afterSha256: string | null;
  byteLength: number;
}

export interface CommitFilesResult {
  root: string;
  transactionId: string;
  touchedFiles: CommittedFile[];
  /** committed 标记已落盘，源文件已全部通过写后校验。 */
  committed: true;
  /** 事务日志是否已经清理；false 时由 completeTransaction 后续清理。 */
  journalCleaned: boolean;
}

export interface TransactionFileStatus {
  path: string;
  actualSha256: string | null;
  /** absent 仅表示"当前不存在"，需结合事务记录判断是 before 缺失还是 after 已删除。 */
  matches: "before" | "after" | "absent" | "unrelated";
}

export type RecoveryAction =
  | "rolled-back"
  | "kept-committed"
  | "discarded-staged"
  | "conflict"
  | "invalid";

export interface TransactionRecoveryReport {
  transactionId: string;
  state: TransactionState | "invalid";
  action: RecoveryAction;
  files: TransactionFileStatus[];
  message?: string;
}

export interface RecoverTransactionsResult {
  root: string;
  /** false 表示存在冲突或损坏日志，必须停用受控写入并保留日志。 */
  writable: boolean;
  reports: TransactionRecoveryReport[];
  /** 已提交且内容核对通过、等待调用方重建派生数据后再清理的事务。 */
  committedPendingRefresh: string[];
}

export interface RecoverTransactionsOptions {
  root: string;
  /** 默认 false：committed 事务保留，等调用方刷新快照后 completeTransaction。 */
  cleanupCommitted?: boolean;
  writer?: AtomicWriter;
}

function transactionTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function newTransactionId(): string {
  return `${transactionTimestamp()}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function segmentsOf(relativePath: string): string[] {
  return normalizeRelativePath(relativePath).split("/");
}

/**
 * 事务入口统一走这里：校验 .aichat、runtime、transactions 各级已存在分量
 * 不是符号链接／junction，且真实路径仍在工作区内。
 */
async function resolveTransactionsDir(rootReal: string): Promise<string> {
  return assertPathInsideWorkspace(rootReal, TRANSACTIONS_DIR);
}

async function resolveTransactionDir(rootReal: string, transactionId: string): Promise<string> {
  return assertPathInsideWorkspace(rootReal, `${TRANSACTIONS_DIR}/${transactionId}`);
}

function dataPath(transactionDir: string, area: "before" | "after", relativePath: string): string {
  return path.join(transactionDir, area, ...segmentsOf(relativePath));
}

async function writeJournal(transactionDir: string, journal: TransactionJournal): Promise<void> {
  const target = path.join(transactionDir, JOURNAL_FILE);
  await writeFileDurable(target, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8"));
}

async function readJournalAt(transactionDir: string): Promise<TransactionJournal> {
  const journalPath = path.join(transactionDir, JOURNAL_FILE);
  const stat = await fs.lstat(journalPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new StorageError("TRANSACTION_INVALID", "事务日志必须是普通文件");
  }
  const raw = await fs.readFile(journalPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StorageError("TRANSACTION_INVALID", `事务日志不是合法 JSON: ${transactionDir}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new StorageError("TRANSACTION_INVALID", `事务日志结构无效: ${transactionDir}`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new StorageError("TRANSACTION_INVALID", `未知事务日志版本: ${String(record.schemaVersion)}`);
  }
  if (typeof record.transactionId !== "string" || typeof record.createdAt !== "string") {
    throw new StorageError("TRANSACTION_INVALID", "事务日志缺少 transactionId／createdAt");
  }
  if (record.state !== "staged" && record.state !== "prepared" && record.state !== "committed") {
    throw new StorageError("TRANSACTION_INVALID", `未知事务状态: ${String(record.state)}`);
  }
  if (!Array.isArray(record.files)) {
    throw new StorageError("TRANSACTION_INVALID", "事务日志缺少 files");
  }
  const files: TransactionFileRecord[] = record.files.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      throw new StorageError("TRANSACTION_INVALID", "事务文件记录无效");
    }
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string") {
      throw new StorageError("TRANSACTION_INVALID", "事务文件记录缺少 path");
    }
    if (typeof file.existedBefore !== "boolean") {
      throw new StorageError("TRANSACTION_INVALID", `事务文件记录缺少 existedBefore: ${file.path}`);
    }
    if (
      file.afterSha256 !== null &&
      (typeof file.afterSha256 !== "string" || !isSha256Hex(file.afterSha256))
    ) {
      throw new StorageError("TRANSACTION_INVALID", `事务文件记录 after 无效: ${file.path}`);
    }
    if (typeof file.afterBytes !== "number" || file.afterBytes < 0) {
      throw new StorageError("TRANSACTION_INVALID", `事务文件记录 afterBytes 无效: ${file.path}`);
    }
    if (file.afterSha256 === null && file.afterBytes !== 0) {
      throw new StorageError("TRANSACTION_INVALID", `删除记录不应带 after 字节: ${file.path}`);
    }
    if (file.existedBefore) {
      if (
        typeof file.beforeSha256 !== "string" ||
        !isSha256Hex(file.beforeSha256) ||
        typeof file.beforeBytes !== "number"
      ) {
        throw new StorageError("TRANSACTION_INVALID", `事务文件记录 before 无效: ${file.path}`);
      }
    } else if (file.beforeSha256 !== null) {
      throw new StorageError("TRANSACTION_INVALID", `新文件不应记录 before 哈希: ${file.path}`);
    }
    normalizeRelativePath(file.path);
    return {
      path: file.path,
      existedBefore: file.existedBefore,
      beforeSha256: file.beforeSha256 as string | null,
      beforeBytes: typeof file.beforeBytes === "number" ? file.beforeBytes : 0,
      afterSha256: file.afterSha256 as string | null,
      afterBytes: file.afterBytes,
    };
  });
  const journal: TransactionJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    transactionId: record.transactionId,
    state: record.state,
    createdAt: record.createdAt,
    files,
  };
  if (typeof record.requestId === "string") journal.requestId = record.requestId;
  return journal;
}

interface TargetInspection {
  /** 路径分量中出现符号链接／越界，无法安全判断。 */
  unsafe: boolean;
  exists: boolean;
  sha256: string | null;
}

/** 只通过边界检查访问目标；符号链接与越界不当作"不存在"。 */
async function inspectTarget(rootReal: string, relativePath: string): Promise<TargetInspection> {
  let absolutePath: string;
  try {
    absolutePath = await assertPathInsideWorkspace(rootReal, relativePath);
  } catch (error) {
    if (error instanceof StorageError) return { unsafe: true, exists: true, sha256: null };
    throw error;
  }
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      return { unsafe: false, exists: false, sha256: null };
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { unsafe: true, exists: true, sha256: null };
  }
  return { unsafe: false, exists: true, sha256: await sha256File(absolutePath) };
}

function compareStatus(
  record: TransactionFileRecord,
  inspection: TargetInspection,
): TransactionFileStatus {
  if (inspection.unsafe) {
    return { path: record.path, actualSha256: null, matches: "unrelated" };
  }
  if (!inspection.exists) {
    // 显式删除的 after 就是"不存在"；新建文件的 before 也是"不存在"。
    if (record.afterSha256 === null || !record.existedBefore) {
      return { path: record.path, actualSha256: null, matches: "absent" };
    }
    return { path: record.path, actualSha256: null, matches: "unrelated" };
  }
  const actualSha256 = inspection.sha256 as string;
  if (record.existedBefore && actualSha256 === record.beforeSha256) {
    return { path: record.path, actualSha256, matches: "before" };
  }
  if (record.afterSha256 !== null && actualSha256 === record.afterSha256) {
    return { path: record.path, actualSha256, matches: "after" };
  }
  return { path: record.path, actualSha256, matches: "unrelated" };
}

/** 事务目录内的数据文件必须是普通文件，且真实路径仍在事务目录内。 */
async function readTransactionData(transactionDir: string, dataFile: string): Promise<Buffer> {
  const relative = path.relative(transactionDir, dataFile);
  if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new StorageError("TRANSACTION_INVALID", "事务数据路径越过事务目录");
  }
  const stat = await fs.lstat(dataFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new StorageError("TRANSACTION_INVALID", `事务数据不是普通文件: ${relative}`);
  }
  const real = await fs.realpath(dataFile);
  const fromDir = path.relative(await fs.realpath(transactionDir), real);
  if (fromDir.startsWith(".." + path.sep) || path.isAbsolute(fromDir)) {
    throw new StorageError("TRANSACTION_INVALID", "事务数据真实路径越界");
  }
  return fs.readFile(real);
}

/**
 * 用 before/<path> 的原始字节恢复一个 prepared 事务；任一文件与 before／after
 * 都不符时拒绝恢复，保留日志。
 */
async function restoreBefore(
  rootReal: string,
  transactionDir: string,
  journal: TransactionJournal,
  writer: AtomicWriter,
  statuses: readonly TransactionFileStatus[],
): Promise<void> {
  for (const [index, record] of journal.files.entries()) {
    const status = statuses[index];
    // 已经是 before，或本来就应不存在时不重写，避免无意义的 mtime 变化。
    if (status?.matches === "before") continue;
    if (status?.matches === "absent" && !record.existedBefore) continue;
    const absolutePath = await resolveWritableContentPath(rootReal, record.path);
    // 覆盖前重新读取实际状态：批量检查到真正写入之间存在外部编辑窗口。
    const current = await inspectTarget(rootReal, record.path);
    if (current.unsafe) {
      throw new StorageError("RECOVERY_CONFLICT", `恢复目标路径不安全: ${record.path}`, {
        path: record.path,
      });
    }
    if (record.existedBefore) {
      const compatible =
        (current.exists && record.beforeSha256 !== null && current.sha256 === record.beforeSha256) ||
        (current.exists && record.afterSha256 !== null && current.sha256 === record.afterSha256) ||
        // 本事务显式删除后，after 状态就是"不存在"
        (!current.exists && record.afterSha256 === null);
      if (!compatible) {
        throw new StorageError(
          "RECOVERY_CONFLICT",
          `恢复目标在写入前已偏离 before／after，停止覆盖: ${record.path}`,
          { path: record.path },
        );
      }
    } else if (current.exists && current.sha256 !== record.afterSha256) {
      throw new StorageError(
        "RECOVERY_CONFLICT",
        `待删除的新文件在写入前已出现无关字节: ${record.path}`,
        { path: record.path },
      );
    }
    if (record.existedBefore) {
      const beforePath = dataPath(transactionDir, "before", record.path);
      const beforeBytes = await readTransactionData(transactionDir, beforePath);
      if (sha256Bytes(beforeBytes) !== record.beforeSha256) {
        throw new StorageError(
          "RECOVERY_CONFLICT",
          `事务 before 数据哈希不符，停止自动恢复: ${record.path}`,
          { path: record.path },
        );
      }
      await ensureParentDirectories(rootReal, record.path);
      await writer(absolutePath, beforeBytes, "replace");
    } else if (current.exists) {
      // 仅当内容仍是本事务写入的 after 时才移除；上面已核过来源。
      await fs.rm(absolutePath);
      await syncDirectoryBestEffort(path.dirname(absolutePath));
    }
  }
}

/** 删除已处理的日志目录；符号链接绝不删除，失败时保留而不影响源文件事实。 */
async function removeTransactionDir(transactionDir: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(transactionDir);
    if (stat.isSymbolicLink()) return false;
    await fs.rm(transactionDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫描 .aichat/runtime/transactions：
 * - staged 且全部文件仍是 before／absent：源文件未被修改，直接清理暂存；
 * - staged 但任何目标偏离 before（即使恰好等于 after）：保留日志、停写，不恢复不覆盖；
 * - prepared 且全部文件等于 before／after：覆盖前再次核对，再按 before 回滚后清理；
 * - committed 且全部文件等于 after：保留给调用方重建派生数据；
 * - 其余情况：保留日志并置 writable=false，绝不覆盖无关字节。
 */
export async function recoverTransactions(
  options: RecoverTransactionsOptions,
): Promise<RecoverTransactionsResult> {
  const rootReal = await resolveWorkspaceRoot(options.root);
  const writer = options.writer ?? defaultAtomicWriter;
  const reports: TransactionRecoveryReport[] = [];
  let transactionsDir: string;
  try {
    transactionsDir = await resolveTransactionsDir(rootReal);
  } catch (error) {
    // 运行时目录被换为链接／越界：拒绝进入，保留现状并停写。
    return {
      root: rootReal,
      writable: false,
      reports: [
        {
          transactionId: "(runtime)",
          state: "invalid",
          action: "invalid",
          files: [],
          message:
            error instanceof Error
              ? `事务目录路径不安全，拒绝恢复: ${error.message}`
              : "事务目录路径不安全，拒绝恢复",
        },
      ],
      committedPendingRefresh: [],
    };
  }
  const committedPendingRefresh: string[] = [];
  let writable = true;

  let entries;
  try {
    entries = await fs.readdir(transactionsDir, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return { root: rootReal, writable: true, reports, committedPendingRefresh };
    }
    throw error;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (!writable) break;
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // junction／符号链接的 isDirectory=false，不能静默跳过；必须经路径守卫判断。
    let transactionDir: string;
    try {
      // 守卫会拒绝最终分量是 junction／符号链接或真实路径越界的情况。
      transactionDir = await resolveTransactionDir(rootReal, entry.name);
    } catch (error) {
      writable = false;
      reports.push({
        transactionId: entry.name,
        state: "invalid",
        action: "invalid",
        files: [],
        message:
          error instanceof Error
            ? `事务目录路径不安全，拒绝恢复: ${error.message}`
            : "事务目录路径不安全，拒绝恢复",
      });
      continue;
    }
    let journal: TransactionJournal;
    try {
      journal = await readJournalAt(transactionDir);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        // 缺日志无法区分"尚未 prepared"与"prepared 日志遗失／损坏"，
        // 不猜、不清理，保留潜在恢复证据并停用受控写入。
        writable = false;
        reports.push({
          transactionId: entry.name,
          state: "invalid",
          action: "invalid",
          files: [],
          message: "事务目录缺少 journal.json，无法判断提交状态；保留日志并停用受控写入",
        });
        continue;
      }
      writable = false;
      reports.push({
        transactionId: entry.name,
        state: "invalid",
        action: "invalid",
        files: [],
        message: error instanceof Error ? error.message : String(error),
      });
      break;
    }

    const files: TransactionFileStatus[] = [];
    for (const record of journal.files) {
      files.push(compareStatus(record, await inspectTarget(rootReal, record.path)));
    }
    const unrelated = files.filter((file) => file.matches === "unrelated");

    if (journal.state === "staged") {
      // prepared 落盘前本服务绝不改源文件：staged 下目标仍应全部停在 before。
      // 任何偏离（即使恰好等于 after）都可能是外部编辑，保留日志并停写，不恢复、不覆盖。
      const stillBefore = journal.files.every((record, index) => {
        const status = files[index];
        return status?.matches === "before" || (status?.matches === "absent" && !record.existedBefore);
      });
      if (!stillBefore) {
        writable = false;
        reports.push({
          transactionId: journal.transactionId,
          state: journal.state,
          action: "conflict",
          files,
          message: "暂存事务的目标文件已偏离 before，保留日志且不恢复，可能是外部编辑",
        });
        continue;
      }
      const removed = await removeTransactionDir(transactionDir);
      reports.push({
        transactionId: journal.transactionId,
        state: journal.state,
        action: removed ? "discarded-staged" : "invalid",
        files,
        ...(removed ? {} : { message: "暂存日志清理失败，源文件未被修改" }),
      });
      if (!removed) writable = false;
      continue;
    }

    if (journal.state === "committed") {
      const notAfter = journal.files.filter((record, index) => {
        const status = files[index];
        return record.afterSha256 === null
          ? status?.matches !== "absent"
          : status?.matches !== "after";
      });
      if (notAfter.length > 0) {
        writable = false;
        reports.push({
          transactionId: journal.transactionId,
          state: journal.state,
          action: "conflict",
          files,
          message: "已提交事务的目标文件与 after 不符（例如被外部删除或后建），保留日志且不回滚",
        });
        continue;
      }
      committedPendingRefresh.push(journal.transactionId);
      if (options.cleanupCommitted === true) {
        const removed = await removeTransactionDir(transactionDir);
        reports.push({
          transactionId: journal.transactionId,
          state: journal.state,
          action: removed ? "kept-committed" : "invalid",
          files,
          ...(removed ? {} : { message: "已提交事务日志清理失败，文件内容已保留" }),
        });
        if (!removed) writable = false;
      } else {
        reports.push({
          transactionId: journal.transactionId,
          state: journal.state,
          action: "kept-committed",
          files,
        });
      }
      continue;
    }

    // prepared：未提交，需要回滚或停在冲突。
    if (unrelated.length > 0) {
      writable = false;
      reports.push({
        transactionId: journal.transactionId,
        state: journal.state,
        action: "conflict",
        files,
        message: "目标文件既不是 before 也不是 after，停止自动恢复与受控写入",
      });
      continue;
    }
    try {
      // prepared 必须包含全部 before 数据；缺失时绝不猜测，保留日志。
      for (const record of journal.files) {
        if (!record.existedBefore) continue;
        const beforePath = dataPath(transactionDir, "before", record.path);
        await readTransactionData(transactionDir, beforePath);
      }
      await restoreBefore(rootReal, transactionDir, journal, writer, files);
    } catch (error) {
      writable = false;
      reports.push({
        transactionId: journal.transactionId,
        state: journal.state,
        action: "invalid",
        files,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const removed = await removeTransactionDir(transactionDir);
    reports.push({
      transactionId: journal.transactionId,
      state: journal.state,
      action: removed ? "rolled-back" : "invalid",
      files,
      ...(removed ? {} : { message: "回滚已完成，但事务日志清理失败" }),
    });
    if (!removed) writable = false;
  }

  return { root: rootReal, writable, reports, committedPendingRefresh };
}

async function ensureParentDirectories(rootReal: string, relativePath: string): Promise<void> {
  const segments = segmentsOf(relativePath);
  if (segments.length <= 1) return;
  await ensureWorkspaceDirectory(rootReal, segments.slice(0, -1).join("/"));
}

function validateCommitInputs(files: CommitFileInput[]): CommitFileInput[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new StorageError("INVALID_ARGUMENT", "提交至少需要一个文件");
  }
  const seen = new Set<string>();
  return files.map((file) => {
    if (typeof file.content !== "string" && file.content !== null) {
      throw new StorageError("INVALID_ARGUMENT", `文件内容必须是字符串或 null: ${file.path}`);
    }
    if (file.content === null && file.expectedSha256 === null) {
      throw new StorageError(
        "INVALID_ARGUMENT",
        `删除文件必须提供前置 SHA-256: ${file.path}`,
        { path: file.path },
      );
    }
    const normalized = normalizeRelativePath(file.path);
    if (file.content === null && normalized === "workspace.json") {
      throw new StorageError("INVALID_ARGUMENT", "不允许删除 workspace.json", {
        path: normalized,
      });
    }
    if (seen.has(normalized)) {
      throw new StorageError("DUPLICATE_PATH", `同一提交中重复声明文件: ${normalized}`, {
        path: normalized,
      });
    }
    seen.add(normalized);
    if (file.expectedSha256 !== null && !isSha256Hex(file.expectedSha256)) {
      throw new StorageError(
        "INVALID_ARGUMENT",
        `expectedSha256 必须是 64 位小写十六进制或 null: ${normalized}`,
        { path: normalized },
      );
    }
    return { ...file, path: normalized };
  });
}

interface PreparedFile {
  input: CommitFileInput;
  /** null 表示删除。 */
  bytes: Buffer | null;
  afterSha256: string | null;
  beforeSha256: string | null;
}

async function prepareFiles(
  rootReal: string,
  inputs: CommitFileInput[],
): Promise<PreparedFile[]> {
  const prepared: PreparedFile[] = [];
  for (const input of inputs) {
    const absolutePath = await resolveWritableContentPath(rootReal, input.path);
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT") && !isErrnoCode(error, "ENOTDIR")) throw error;
      stat = null;
    }
    const exists = stat !== null;
    if (stat !== null && !stat.isFile()) {
      throw new StorageError("PATH_NOT_ALLOWED", `目标不是普通文件: ${input.path}`, {
        path: input.path,
      });
    }
    if (input.expectedSha256 === null) {
      if (exists) {
        throw new StorageError("FILE_EXISTS", `新建文件已存在，拒绝覆盖: ${input.path}`, {
          path: input.path,
          details: { actualSha256: await sha256File(absolutePath) },
        });
      }
    } else {
      if (!exists) {
        throw new StorageError("VERSION_CONFLICT", `文件已不存在，可能被外部删除: ${input.path}`, {
          path: input.path,
          details: { actualSha256: null },
        });
      }
      const actualSha256 = await sha256File(absolutePath);
      if (actualSha256 !== input.expectedSha256) {
        throw new StorageError("VERSION_CONFLICT", `文件版本已变化: ${input.path}`, {
          path: input.path,
          details: { expectedSha256: input.expectedSha256, actualSha256 },
        });
      }
    }
    const bytes = input.content === null ? null : Buffer.from(input.content, "utf8");
    prepared.push({
      input,
      bytes,
      afterSha256: bytes === null ? null : sha256Bytes(bytes),
      beforeSha256: exists ? input.expectedSha256 : null,
    });
  }
  return prepared;
}

/**
 * 一次受控提交：前置哈希 → 暂存 before／after → prepared → 原子替换 →
 * 写前／写后校验 → committed 标记。新文件用独占创建，绝不覆盖。
 * 中途失败且所有目标仍是 before／after 时自动回滚；否则保留日志抛 RECOVERY_REQUIRED。
 */
export async function commitFiles(options: CommitFilesOptions): Promise<CommitFilesResult> {
  const rootReal = await resolveWorkspaceRoot(options.root);
  const writer = options.writer ?? defaultAtomicWriter;
  const inputs = validateCommitInputs(options.files);
  await ensureWorkspaceDirectory(rootReal, TRANSACTIONS_DIR);
  const existingTransactions = await fs
    .readdir(await resolveTransactionsDir(rootReal), { withFileTypes: true })
    .catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return [];
      throw error;
    });
  const unresolved: string[] = [];
  for (const entry of existingTransactions) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // junction／符号链接同样视为未解决事务，且先经路径守卫确认不越界。
    try {
      await resolveTransactionDir(rootReal, entry.name);
    } catch (error) {
      if (error instanceof StorageError) {
        throw new StorageError(
          "PATH_UNSAFE",
          `事务目录路径不安全，拒绝提交: ${entry.name}`,
          { path: entry.name, cause: error },
        );
      }
      throw error;
    }
    unresolved.push(entry.name);
  }
  if (unresolved.length > 0) {
    throw new StorageError(
      "PENDING_TRANSACTION",
      "存在未恢复的事务日志，先执行 recoverTransactions 再提交",
      { details: { transactionIds: unresolved } },
    );
  }
  const prepared = await prepareFiles(rootReal, inputs);
  const transactionId = newTransactionId();
  // 运行时目录已在上面逐级确认；这里经同一路径守卫解析事务目录。
  const transactionDir = await resolveTransactionDir(rootReal, transactionId);
  await fs.mkdir(transactionDir);

  const records: TransactionFileRecord[] = [];
  try {
    for (const file of prepared) {
      const beforePath = dataPath(transactionDir, "before", file.input.path);
      const afterPath = dataPath(transactionDir, "after", file.input.path);
      await fs.mkdir(path.dirname(beforePath), { recursive: true });
      await fs.mkdir(path.dirname(afterPath), { recursive: true });
      if (file.beforeSha256 !== null) {
        const absolutePath = await resolveWritableContentPath(rootReal, file.input.path);
        const beforeBytes = await fs.readFile(absolutePath);
        if (sha256Bytes(beforeBytes) !== file.beforeSha256) {
          throw new StorageError(
            "VERSION_CONFLICT",
            `文件在提交准备期间被修改: ${file.input.path}`,
            { path: file.input.path },
          );
        }
        await writeFileDurable(beforePath, beforeBytes);
        records.push({
          path: file.input.path,
          existedBefore: true,
          beforeSha256: file.beforeSha256,
          beforeBytes: beforeBytes.byteLength,
          afterSha256: file.afterSha256,
          afterBytes: file.bytes?.byteLength ?? 0,
        });
      } else {
        records.push({
          path: file.input.path,
          existedBefore: false,
          beforeSha256: null,
          beforeBytes: 0,
          afterSha256: file.afterSha256,
          afterBytes: file.bytes?.byteLength ?? 0,
        });
      }
      if (file.bytes !== null) {
        await writeFileDurable(afterPath, file.bytes);
      }
    }
  } catch (error) {
    // 尚未写 prepared 标记，源文件未被修改；暂存目录可直接清理。
    await removeTransactionDir(transactionDir);
    if (error instanceof StorageError) throw error;
    throw new StorageError("WRITE_FAILED", "事务暂存写入失败，未修改源文件", {
      cause: error,
    });
  }

  const journal: TransactionJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    transactionId,
    state: "staged",
    createdAt: new Date().toISOString(),
    files: records,
  };
  if (options.requestId !== undefined) journal.requestId = options.requestId;

  try {
    await writeJournal(transactionDir, journal);
    journal.state = "prepared";
    await writeJournal(transactionDir, journal);
  } catch (error) {
    await removeTransactionDir(transactionDir);
    throw new StorageError("WRITE_FAILED", "事务日志写入失败，未修改源文件", {
      cause: error,
    });
  }

  const failAndRollback = async (error: unknown): Promise<never> => {
    if (!modifiedAny) {
      // 尚未写任何源文件：日志可直接清理，不留下需恢复的事务。
      await removeTransactionDir(transactionDir);
      if (error instanceof StorageError) throw error;
      throw new StorageError("WRITE_FAILED", "提交写入失败，未修改源文件", { cause: error });
    }
    const statuses: TransactionFileStatus[] = [];
    for (const record of records) {
      statuses.push(compareStatus(record, await inspectTarget(rootReal, record.path)));
    }
    if (statuses.every((status) => status.matches !== "unrelated")) {
      try {
        await restoreBefore(rootReal, transactionDir, journal, writer, statuses);
        await removeTransactionDir(transactionDir);
      } catch {
        throw new StorageError(
          "RECOVERY_REQUIRED",
          "提交失败且自动回滚未完成，事务日志已保留",
          { details: { transactionId }, cause: error },
        );
      }
    } else {
      throw new StorageError(
        "RECOVERY_REQUIRED",
        "提交失败且目标文件出现无关字节，事务日志已保留，需人工核对",
        {
          details: {
            transactionId,
            files: statuses.filter((status) => status.matches === "unrelated"),
          },
          cause: error,
        },
      );
    }
    if (error instanceof StorageError) throw error;
    throw new StorageError("WRITE_FAILED", "提交写入失败，已回滚源文件", { cause: error });
  };

  // 写入阶段：逐个文件原子替换；新文件独占创建。
  let modifiedAny = false;
  for (const file of prepared) {
    const expected = file.input.expectedSha256;
    try {
      const absolutePath = await resolveWritableContentPath(rootReal, file.input.path);
      if (file.bytes !== null) {
        await ensureParentDirectories(rootReal, file.input.path);
      }
      const inspection = await inspectTarget(rootReal, file.input.path);
      if (inspection.unsafe) {
        throw new StorageError("PATH_UNSAFE", `目标路径不安全: ${file.input.path}`, {
          path: file.input.path,
        });
      }
      const actualSha256 = inspection.sha256;
      if (expected === null) {
        if (inspection.exists) {
          throw new StorageError("FILE_EXISTS", `新建文件已存在，拒绝覆盖: ${file.input.path}`, {
            path: file.input.path,
            details: { actualSha256 },
          });
        }
      } else if (!inspection.exists || actualSha256 !== expected) {
        throw new StorageError("VERSION_CONFLICT", `文件在写入前被修改: ${file.input.path}`, {
          path: file.input.path,
          details: { expectedSha256: expected, actualSha256 },
        });
      }
      if (file.bytes === null) {
        await assertPathInsideWorkspace(rootReal, file.input.path);
        await fs.rm(absolutePath);
        modifiedAny = true;
        await syncDirectoryBestEffort(path.dirname(absolutePath));
      } else {
        await writer(absolutePath, file.bytes, expected === null ? "create" : "replace");
        modifiedAny = true;
      }
    } catch (error) {
      if (file.input.expectedSha256 === null && isErrnoCode(error, "EEXIST")) {
        return failAndRollback(
          new StorageError("FILE_EXISTS", `新建文件已存在，拒绝覆盖: ${file.input.path}`, {
            path: file.input.path,
            cause: error,
          }),
        );
      }
      return failAndRollback(error);
    }
  }

  // 写后校验：每个目标必须等于 after；删除必须确实不存在。
  for (const file of prepared) {
    const inspection = await inspectTarget(rootReal, file.input.path);
    const actualSha256 = inspection.sha256;
    const expectsFile = file.afterSha256 !== null;
    if (
      inspection.unsafe ||
      inspection.exists !== expectsFile ||
      actualSha256 !== file.afterSha256
    ) {
      return failAndRollback(
        new StorageError("WRITE_VERIFICATION_FAILED", `写入后校验失败: ${file.input.path}`, {
          path: file.input.path,
          details: { expectedSha256: file.afterSha256, actualSha256 },
        }),
      );
    }
  }

  journal.state = "committed";
  try {
    await writeJournal(transactionDir, journal);
  } catch (error) {
    // 源文件已全部写入并核对；保留 prepared 日志，重启时会按 before 回滚，
    // 因此这里必须报告为需人工处理的中间态，而不是成功。
    throw new StorageError(
      "RECOVERY_REQUIRED",
      "源文件已写入但 committed 标记落盘失败，事务日志保留",
      { details: { transactionId }, cause: error },
    );
  }

  let journalCleaned = false;
  if (options.cleanupJournal === true) {
    journalCleaned = await removeTransactionDir(transactionDir);
  }

  return {
    root: rootReal,
    transactionId,
    touchedFiles: records.map((record) => ({
      path: record.path,
      beforeSha256: record.beforeSha256,
      afterSha256: record.afterSha256,
      byteLength: record.afterBytes,
    })),
    committed: true,
    journalCleaned,
  };
}

/**
 * 调用方已保存有效快照／完成通知后清理 committed 日志。
 * 已提交内容不回滚，也不因之后出现的外部修改而拒绝清理。
 */
export async function completeTransaction(
  root: string,
  transactionId: string,
): Promise<void> {
  const rootReal = await resolveWorkspaceRoot(root);
  if (!/^[A-Za-z0-9-]+$/.test(transactionId)) {
    throw new StorageError("INVALID_ARGUMENT", `事务 ID 无效: ${transactionId}`);
  }
  const transactionDir = await resolveTransactionDir(rootReal, transactionId);
  let journal: TransactionJournal;
  try {
    journal = await readJournalAt(transactionDir);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new StorageError("INVALID_ARGUMENT", `事务不存在或已清理: ${transactionId}`);
    }
    throw error;
  }
  if (journal.state !== "committed") {
    throw new StorageError(
      "TRANSACTION_INVALID",
      `只能清理已提交事务，当前状态: ${journal.state}`,
      { details: { transactionId } },
    );
  }
  for (const record of journal.files) {
    if (record.afterSha256 !== null) continue;
    const inspection = await inspectTarget(rootReal, record.path);
    if (inspection.unsafe || inspection.exists) {
      throw new StorageError(
        "RECOVERY_CONFLICT",
        `已提交删除的目标路径重新出现文件，保留日志: ${record.path}`,
        { path: record.path },
      );
    }
  }
  const removed = await removeTransactionDir(transactionDir);
  if (!removed) {
    throw new StorageError("WRITE_FAILED", `事务日志清理失败: ${transactionId}`);
  }
}

/** 读取单个事务日志（服务用于请求状态查询）。 */
export async function getTransaction(
  root: string,
  transactionId: string,
): Promise<TransactionJournal | null> {
  const rootReal = await resolveWorkspaceRoot(root);
  if (!/^[A-Za-z0-9-]+$/.test(transactionId)) return null;
  // 路径不安全时明确抛错，不能伪装成"不存在"。
  const transactionDir = await resolveTransactionDir(rootReal, transactionId);
  try {
    return await readJournalAt(transactionDir);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** 列出当前保留的事务日志，按创建时间升序。 */
export async function listTransactions(root: string): Promise<TransactionJournal[]> {
  const rootReal = await resolveWorkspaceRoot(root);
  const transactionsDir = await resolveTransactionsDir(rootReal);
  let entries;
  try {
    entries = await fs.readdir(transactionsDir, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }
  const journals: TransactionJournal[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    journals.push(await readJournalAt(path.join(transactionsDir, entry.name)));
  }
  return journals;
}