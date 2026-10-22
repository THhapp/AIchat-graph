/**
 * 主题自动导出：把有效快照冻结成单文件 HTML 并写到用户选定的本机目标。
 *
 * 约束（ARCHITECTURE 8／9）：
 * - 只用有效快照内容，不从不同 revision 拼正文；资源来自同一快照；
 * - 计算（文档组装＋HTML 渲染）可以在队列外，但"仍是最新任务 → 路径与哈希校验 →
 *   可靠替换 → 记录成功"必须在 WorkspaceRuntime.queue 内完成；
 * - 失败保留旧成品，不先 truncate，也不更新成功版本；
 * - 只允许明确指定的本机绝对 .html；拒绝工作区／应用根内部、链接、目录、
 *   UNC／设备／ADS 与无关已有文件；
 * - 运行时停写（未恢复事务、丢锁）时同样不允许导出写盘。
 */
import { existsSync, promises as fs, statSync } from "node:fs";
import path from "node:path";
import {
  isErrnoCode,
  sha256Bytes,
  StorageError,
  writeFileDurable,
} from "../storage/index.js";
import {
  computeContentFingerprint,
  computeExportFingerprints,
  readExportMarkers,
  readReaderAssets,
  renderTopicHtml,
  type ReaderAssets,
} from "../export/index.js";
import type {
  Diagnostic,
  ExportState,
  GraphNode,
  OfflineTopicDocument,
  TopicExportStatus,
} from "../shared/protocol.js";
import type { SnapshotData, TopicSnapshot } from "./snapshot.js";
import { graphTopic, toGraphNode } from "./snapshot.js";
import { ServiceError, wireDiagnostic } from "./errors.js";
import {
  loadExportConfig,
  saveExportConfig,
  type ExportConfigStore,
  type ExportPendingRecord,
  type ExportTargetRecord,
} from "./exportConfig.js";
import type { WorkspaceRuntime } from "./workspace.js";

interface PreparedExport {
  readonly topicId: string;
  readonly generation: number;
  readonly document: OfflineTopicDocument;
  readonly html: string;
  readonly contentFingerprint: string;
  readonly readerFingerprint: string;
  readonly exportFingerprint: string;
  readonly error: Diagnostic[] | null;
}

export interface ExportCoordinatorOptions {
  readonly runtime: WorkspaceRuntime;
  /** 应用根（package.json 所在目录），导出目标不得落在其中。 */
  readonly appRoot: string;
  /** dist/offline；由调用方按模块位置解析。 */
  readonly offlineDirectory: string;
}

function diagnostic(
  code: string,
  message: string,
  pathValue?: string,
  severity: Diagnostic["severity"] = "error",
): Diagnostic {
  return wireDiagnostic(code, message, pathValue, severity);
}

function isFileSync(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function hasErrorDiagnostics(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === "error" || item.severity === undefined);
}

function isAbsoluteHtml(value: string): boolean {
  if (!path.isAbsolute(value)) return false;
  if (value.startsWith("\\\\") || value.startsWith("//")) return false;
  // 目录名之外的冒号（NTFS ADS）一律拒绝；盘符后的冒号不算。
  const withoutDrive = /^[A-Za-z]:/.test(value) ? value.slice(2) : value;
  if (withoutDrive.includes(":")) return false;
  if (value.includes("\u0000")) return false;
  return path.extname(value).toLowerCase() === ".html";
}

interface TargetResolution {
  /** 用户给出的绝对路径（仅用于报告）。 */
  absolute: string;
  /** 规范化后的真实目标：父目录 realpath + 文件名；所有安全判断与写入都用它。 */
  canonical: string;
  /** 目标自身的真实路径（不存在时为 null）。 */
  canonicalExisting: string | null;
  exists: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

/**
 * 逐级检查用户给出的父路径链：任何一级是 symlink／junction 都不接受。
 *
 * 合同要求"拒绝链接"，不只是拒绝指向工作区／应用根的链接：否则授权后把父 alias
 * 改指别处，同一字面路径就会悄悄写到另一个真实位置。这里在授权与 finalize 共用，
 * 提示调用方改用真实路径。只检查真实存在的祖先，第一段不存在即止（其余更深的
 * 段也不可能存在）。
 */
async function assertNoLinkedParent(value: string): Promise<string> {
  const absolute = path.resolve(value);
  const parent = path.dirname(absolute);
  // 用相对 root 的段累加，避免把 "C:" 当成第一段拼出 "C:\C:"（Windows 下会
  // 立刻 ENOENT，等于整条检查被跳过）。
  const root = path.parse(parent).root;
  const segments = path.relative(root, parent).split(path.sep).filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return parent; // 更深的祖先不存在
      throw new ServiceError(
        422,
        "EXPORT_TARGET_INVALID",
        "无法检查导出目标路径：" + current,
        { details: { path: value }, cause: error },
      );
    }
    if (stat.isSymbolicLink()) {
      throw new ServiceError(
        422,
        "EXPORT_TARGET_UNSAFE",
        "导出目标的父路径含有符号链接或 junction：" + current + "；请改用真实目录路径",
        { details: { path: value, linkedAncestor: current } },
      );
    }
  }
  return parent;
}

/**
 * 外部绝对路径归一化。
 *
 * 1) 逐级拒绝父链中的 symlink／junction（不是只拒指向保护根的链接）；
 * 2) 用 realpath 解析父目录后再拼文件名，后续的工作区／应用根判断与写入
 *    都使用 canonical 路径；仅比较用户输入的字面路径会被目录 alias 绕过。
 */
async function resolveTarget(value: string): Promise<TargetResolution> {
  const absolute = path.resolve(value);
  const parent = await assertNoLinkedParent(absolute);
  let parentReal: string;
  try {
    parentReal = await fs.realpath(parent);
  } catch (error) {
    throw new ServiceError(
      422,
      "EXPORT_TARGET_INVALID",
      "导出目标的父目录不存在或不可访问：" + parent,
      { details: { path: value }, cause: error },
    );
  }
  const canonical = path.join(parentReal, path.basename(absolute));
  const stat = await fs.lstat(canonical).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  });
  if (stat === null) {
    return {
      absolute,
      canonical,
      canonicalExisting: null,
      exists: false,
      isFile: false,
      isSymlink: false,
    };
  }
  // 目标本身是符号链接／junction：拒绝（不跟随到别处写入）。
  let canonicalExisting: string | null = null;
  if (stat.isSymbolicLink()) {
    return {
      absolute,
      canonical,
      canonicalExisting: null,
      exists: true,
      isFile: false,
      isSymlink: true,
    };
  }
  canonicalExisting = await fs.realpath(canonical).catch(() => canonical);
  return {
    absolute,
    canonical,
    canonicalExisting,
    exists: true,
    isFile: stat.isFile(),
    isSymlink: false,
  };
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

/** 工作区与应用根的 canonical 形式；用于和真实目标比较。 */
async function canonicalRoots(runtime: WorkspaceRuntime, appRoot: string): Promise<{
  workspace: string;
  app: string;
}> {
  const workspace = await fs.realpath(runtime.rootReal).catch(() => runtime.rootReal);
  const app = await fs.realpath(appRoot).catch(() => appRoot);
  return { workspace, app };
}

/** 目标是否落在工作区或应用根内部（都按 canonical 比较）。 */
async function targetInsideRoots(
  runtime: WorkspaceRuntime,
  appRoot: string,
  resolution: TargetResolution,
): Promise<{ insideWorkspace: boolean; insideApp: boolean }> {
  const roots = await canonicalRoots(runtime, appRoot);
  const candidate = resolution.canonicalExisting ?? resolution.canonical;
  return {
    insideWorkspace: isInside(roots.workspace, candidate),
    insideApp: isInside(roots.app, candidate),
  };
}

export class ExportCoordinator {
  private readonly runtime: WorkspaceRuntime;
  private readonly appRoot: string;
  private readonly offlineDirectory: string;

  private config: ExportConfigStore | null = null;
  private readerAssets: ReaderAssets | null = null;
  private readerError: string | null = null;

  /** 每个主题的最新任务代号；旧任务发现代号变化就丢弃结果。 */
  private readonly generations = new Map<string, number>();
  private readonly preparing = new Map<string, Promise<void>>();
  private readonly writing = new Set<string>();
  private readonly lastStatus = new Map<string, TopicExportStatus>();
  private stopped = false;

  constructor(options: ExportCoordinatorOptions) {
    this.runtime = options.runtime;
    this.appRoot = options.appRoot;
    this.offlineDirectory = options.offlineDirectory;
  }

  async init(): Promise<void> {
    this.config = await loadExportConfig(this.runtime.rootReal, this.runtime.workspaceId);
    try {
      this.readerAssets = await readReaderAssets({ directory: this.offlineDirectory });
      this.readerError = null;
    } catch (error) {
      this.readerAssets = null;
      this.readerError =
        "离线读者资源不可用（" + this.offlineDirectory + "）：" +
        (error instanceof Error ? error.message : String(error));
    }
    // 启动时按当前内容补生成：失败只影响状态，不丢绑定。
    await this.scheduleAll("startup");
  }

  get configStore(): ExportConfigStore {
    if (this.config === null) {
      throw new ServiceError(500, "INTERNAL", "导出配置尚未加载", {});
    }
    return this.config;
  }

  /** 停止时取消尚未完成的准备工作；不留下继续写盘的进程。 */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.preparing.values()]);
  }

  /** 记录到本机配置；失败抛出，不静默丢绑定。 */
  private async persist(): Promise<void> {
    await saveExportConfig(this.configStore, this.runtime.rootReal);
  }

  /**
   * 队列身份只由调用链显式决定，不用实例级 boolean／上下文标记判断：
   * 公开入口（setTarget／retry）、调度器 finalize、异步错误记录各自直接
   * runtime.queue.run；它们内部调用的写函数（commitRecordInQueue）不再自己排队。
   * 这样 HTTP 请求永远不会因为"别处正在跑任务"就被误判成已在队列内。
   */

  /**
   * 配置写入前的守卫：受控写入被停用（丢锁、未恢复事务、快照刷新待确认）时
   * 一律不写 exports.json，与源文件写入保持同一安全状态。
   */
  private requireWritable(): void {
    if (!this.runtime.writable) {
      throw new ServiceError(
        409,
        "WRITE_DISABLED",
        "受控写入已停用（" +
          (this.runtime.writableReason ?? "UNKNOWN") +
          "）；不更新导出配置与成品",
        { details: { reason: this.runtime.writableReason } },
      );
    }
  }

  /** 当前有效快照中该主题的冻结文档；资源从同一快照取。 */
  buildDocument(topicId: string): OfflineTopicDocument {
    const snapshot = this.runtime.current.data;
    const topic = snapshot.topics.find((entry) => entry.topicId === topicId);
    if (topic === undefined) {
      throw new ServiceError(404, "NOT_FOUND", "当前快照中没有主题 " + topicId, {
        details: { topicId },
      });
    }
    const nodes = topic.nodes.map((node) => {
      const view = snapshot.graph.nodes.find((entry) => entry.id === node.id);
      const file = topic.files.find((entry) => entry.path === node.sourcePath);
      return {
        ...(view === undefined ? basicNode(node) : toGraphNode(view)),
        body: node.body,
        path: node.sourcePath,
        fileHash: file?.fileHash ?? "",
      };
    });
    // 边界：本主题节点所需的全部外部祖先（直至 root），只带元数据与来源主题信息。
    const boundary = externalAncestors(snapshot, topic);
    const document: OfflineTopicDocument = {
      format: 1,
      workspaceId: snapshot.workspaceId,
      workspaceName: snapshot.name,
      instanceId: this.runtime.instanceId,
      revision: this.runtime.current.revision,
      fingerprint: "",
      generatedAt: new Date().toISOString(),
      topic: graphTopic(snapshot, topic),
      nodes,
      boundaryNodes: boundary,
      resources: { ...topic.resources },
      resourceDiagnostics: [...topic.resourceDiagnostics],
    };
    const content = computeContentFingerprint(document);
    return { ...document, fingerprint: content };
  }

  /** 当前内容指纹（不含运行字段），供状态与比较使用。 */
  sourceFingerprint(topicId: string): string | null {
    try {
      return this.buildDocument(topicId).fingerprint;
    } catch {
      return null;
    }
  }

  /** 状态：未绑定 / 待生成 / 写入中 / 已同步 / 失败 / 源变化。 */
  statusOf(topicId: string): TopicExportStatus {
    const snapshot = this.runtime.current.data;
    const topic = snapshot.topics.find((entry) => entry.topicId === topicId);
    const record = this.config?.entries.get(topicId) ?? null;
    const error = record?.lastError ?? null;
    const sourceFingerprint =
      topic === undefined ? null : this.safeSourceFingerprint(topicId);
    const resourceDiagnostics = topic ? [...topic.resourceDiagnostics] : [];
    // targetPresent 以真实磁盘为准：文件被用户删除或改名后不能继续显示"已就绪"。
    const targetPresent =
      record === null ? false : existsSync(record.targetPath) && isFileSync(record.targetPath);

    let state: ExportState;
    if (record === null) state = "unset";
    else if (this.preparing.has(topicId)) state = "pending";
    else if (this.writing.has(topicId)) state = "writing";
    else if (error !== null) state = "error";
    else if (!targetPresent) state = "error";
    else if (
      sourceFingerprint !== null &&
      record.exportedContentFingerprint !== null &&
      sourceFingerprint !== record.exportedContentFingerprint
    ) {
      state = "stale";
    } else if (this.runtime.stale) {
      state = "stale";
    } else if (hasErrorDiagnostics(resourceDiagnostics)) {
      state = "error";
    } else if (record.pending !== null) {
      // 有未完成的替换记账：还没确认成功，不能显示 ready。
      state = "pending";
    } else if (record.exportedContentFingerprint === null) {
      state = "pending";
    } else state = "ready";

    const status: TopicExportStatus = {
      topicId,
      topicTitle: topic?.title ?? "",
      targetPath: record?.targetPath ?? null,
      state,
      sourceFingerprint,
      exportedFingerprint: record?.exportedContentFingerprint ?? null,
      exportedRevision: record?.exportedRevision ?? null,
      lastSuccessAt: record?.lastSuccessAt ?? null,
      error:
        error ??
        (state === "error" && !targetPresent && record !== null
          ? "目标文件不存在或已不可读"
          : this.runtime.stale
            ? "当前显示的是上一份有效内容；磁盘源无效，旧成品保留"
            : null),
      resourceDiagnostics,
      targetHash: record?.targetHash ?? null,
      targetPresent,
    };
    this.lastStatus.set(topicId, status);
    return status;
  }

  allStatuses(): TopicExportStatus[] {
    const ids = this.runtime.current.data.topics.map((topic) => topic.topicId);
    for (const topicId of this.config?.entries.keys() ?? []) {
      if (!ids.includes(topicId)) ids.push(topicId);
    }
    return ids.map((topicId) => this.statusOf(topicId));
  }

  private safeSourceFingerprint(topicId: string): string | null {
    try {
      return this.sourceFingerprint(topicId);
    } catch {
      return null;
    }
  }

  /* ------------------------------ 调度 ------------------------------ */

  /** 所有有效发布都调用这里；配置／缓存变化不调用，避免自循环。 */
  async scheduleAll(reason: string): Promise<void> {
    if (this.stopped) return;
    const topicIds = this.runtime.current.data.topics.map((topic) => topic.topicId);
    const bound = topicIds.filter((topicId) => this.config?.entries.has(topicId) === true);
    await Promise.all(bound.map((topicId) => this.schedule(topicId, reason)));
  }

  /**
   * 为单个主题排队一次导出。
   *
   * 文档组装与 HTML 渲染在队列外完成；只有最终校验／替换／记录进入
   * runtime.queue。旧任务发现 generation 变化就丢弃，不会覆盖更新的成品。
   */
  schedule(topicId: string, reason: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const record = this.config?.entries.get(topicId);
    if (record === undefined) return Promise.resolve();
    const generation = (this.generations.get(topicId) ?? 0) + 1;
    this.generations.set(topicId, generation);
    void reason;

    const prepare = (async (): Promise<void> => {
      let prepared: PreparedExport;
      try {
        prepared = await this.prepare(topicId, generation);
      } catch (error) {
        this.fail(topicId, errorMessageOf(error));
        return;
      }
      if (this.stopped) return;
      if (this.generations.get(topicId) !== generation) return;
      // 调度器 finalize：显式队列边界。
      await this.runtime.queue.run(async () => {
        if (this.stopped) return;
        if (this.generations.get(topicId) !== generation) return;
        await this.finalize(prepared);
      });
    })().finally(() => {
      if (this.preparing.get(topicId) === prepare) this.preparing.delete(topicId);
    });
    this.preparing.set(topicId, prepare);
    return prepare;
  }

  private async prepare(topicId: string, generation: number): Promise<PreparedExport> {
    const record = this.configStore.entries.get(topicId);
    if (record === undefined) {
      throw new ServiceError(409, "EXPORT_TARGET_UNSET", "该主题还没有导出目标", {
        details: { topicId },
      });
    }
    const document = this.buildDocument(topicId);
    const snapshot = this.runtime.current.data;
    const topic = snapshot.topics.find((entry) => entry.topicId === topicId);
    const diagnostics: Diagnostic[] = [];
    if (topic !== undefined && hasErrorDiagnostics(topic.resourceDiagnostics)) {
      diagnostics.push(...topic.resourceDiagnostics);
    }
    // 资源诊断已是 error 时仍渲染用于诊断，但不允许写成功：finalize 会拒绝。
    const assets = this.readerAssets;
    if (assets === null) {
      throw new ServiceError(503, "EXPORT_READER_UNAVAILABLE", this.readerError ?? "读者资源不可用", {
        details: { directory: this.offlineDirectory },
      });
    }
    const html = renderTopicHtml({
      document,
      readerScript: assets.script,
      readerStyles: assets.styles,
    });
    const fingerprints = computeExportFingerprints({
      document,
      readerScript: assets.script,
      readerStyles: assets.styles,
    });
    if (this.generations.get(topicId) !== generation) {
      throw new ServiceError(409, "EXPORT_SUPERSEDED", "已有更新的导出任务", {});
    }
    return {
      topicId,
      generation,
      document,
      html,
      contentFingerprint: fingerprints.contentFingerprint,
      readerFingerprint: fingerprints.readerFingerprint,
      exportFingerprint: fingerprints.exportFingerprint,
      error: diagnostics.length > 0 ? diagnostics : null,
    };
  }

  /**
   * 队列内最终步骤：核对上一次未完成的替换 → 校验 → 写前 pending 记账 →
   * 原子替换 → 完成记账。
   *
   * 顺序是契约：pending（只含哈希／指纹／版本／目标）先落盘，替换才发生；
   * 完成记账失败时 pending 保留，重启或 retry 用实际字节哈希判定"已替换／未替换"，
   * 不靠 marker、不偷补最新哈希，也不把 targetHash 置空。
   */
  private async finalize(prepared: PreparedExport): Promise<void> {
    const { topicId } = prepared;
    const record = this.configStore.entries.get(topicId);
    if (record === undefined) return;
    this.writing.add(topicId);
    try {
      if (!this.runtime.writable) {
        this.fail(
          topicId,
          "受控写入已停用（" + (this.runtime.writableReason ?? "UNKNOWN") + "）；导出未写盘，旧成品保留",
          null,
          false,
          true,
        );
        return;
      }
      if (prepared.error !== null) {
        this.fail(
          topicId,
          "资源或内容存在问题，未生成成品：" + summarize(prepared.error),
          prepared.error,
          false,
          true,
        );
        return;
      }
      // 内容已经变化（更新的发布）时不写旧内容。
      if (this.runtime.current.revision !== prepared.document.revision) {
        this.fail(topicId, "快照已更新，本次导出被取消", null, true, true);
        return;
      }
      // 先收尾上一次"已替换但完成记账失败"的记录，否则会被误判成外部冲突。
      await this.reconcilePending(topicId);
      const current = this.configStore.entries.get(topicId);
      if (current === undefined) return;
      const target = await this.validateTarget(topicId, current.targetPath, current);
      // 重启补齐判断：内容、读者构建、目标字节都未变时无需重写（保留用户文件时间戳）。
      if (await this.alreadyCurrent(target.absolute, current, prepared)) {
        this.lastStatus.set(topicId, { ...this.statusOf(topicId), targetPresent: true });
        return;
      }

      const htmlBytes = Buffer.from(prepared.html, "utf8");
      const nextHash = sha256Bytes(htmlBytes);
      const pending: ExportPendingRecord = {
        baseHash: target.baseHash,
        nextHash,
        contentFingerprint: prepared.contentFingerprint,
        readerFingerprint: prepared.readerFingerprint,
        exportFingerprint: prepared.exportFingerprint,
        revision: prepared.document.revision,
        recordedAt: new Date().toISOString(),
      };
      const withPending: ExportTargetRecord = { ...current, pending };
      // 记账失败就不碰旧 HTML：宁可这次不出成品，也不能让盘上配置与实际字节失配。
      await this.commitRecordInQueue(topicId, withPending, current);

      await writeFileDurable(target.absolute, htmlBytes);
      const written = await fs.readFile(target.absolute);
      if (sha256Bytes(written) !== nextHash) {
        throw new ServiceError(500, "INTERNAL", "写入后的成品字节与预期不一致；保留 pending 待核实", {});
      }

      const updated: ExportTargetRecord = {
        targetPath: current.targetPath,
        targetHash: nextHash,
        lastSuccessAt: pending.recordedAt,
        exportedContentFingerprint: pending.contentFingerprint,
        exportedReaderFingerprint: pending.readerFingerprint,
        exportedExportFingerprint: pending.exportFingerprint,
        exportedRevision: pending.revision,
        lastError: null,
        pending: null,
      };
      try {
        await this.commitRecordInQueue(topicId, updated, withPending);
      } catch (error) {
        // 成品已落盘但账没记上：保留 pending（内存与盘上都不丢），不假报成功。
        this.fail(
          topicId,
          "成品已写入但完成记账失败：" + errorMessageOf(error) + "；pending 已保留，重启或重试会按实际字节核实",
          null,
          false,
          true,
        );
        return;
      }
      this.lastStatus.set(topicId, {
        ...this.statusOf(topicId),
        targetPresent: true,
      });
      this.broadcast();
    } catch (error) {
      if (error instanceof ServiceError && error.code === "EXPORT_SUPERSEDED") return;
      this.fail(topicId, errorMessageOf(error), null, false, true);
    } finally {
      this.writing.delete(topicId);
    }
  }

  /**
   * 调用方必须已经持有队列（finalize 或公开入口的 queue.run 内）。
   *
   * 写入内存并原子持久化；持久化失败回滚内存，保证内存不会领先盘上记录。
   * 本函数不再自行排队：否则要么嵌套自锁，要么需要推断"我在不在队列里"。
   */
  private async commitRecordInQueue(
    topicId: string,
    updated: ExportTargetRecord,
    previous: ExportTargetRecord,
  ): Promise<void> {
    this.requireWritable();
    this.configStore.entries.set(topicId, updated);
    try {
      await this.persist();
    } catch (error) {
      this.configStore.entries.set(topicId, previous);
      throw error;
    }
  }

  /**
   * 记录错误信息到配置；不抛出、不阻断。写入同样排队并受守卫；
   * 写停用或持久化失败时只留内存诊断，不假装已落盘。
   */
  /** 调用方须已持有队列：只写内存＋尽力落盘，不自己排队。 */
  private async writeErrorInQueue(topicId: string, message: string): Promise<void> {
    const current = this.configStore.entries.get(topicId);
    if (current === undefined || current.lastError === message) return;
    if (!this.runtime.writable) return;
    this.configStore.entries.set(topicId, { ...current, lastError: message });
    try {
      await this.persist();
    } catch {
      // 保留内存里的 lastError 供诊断；下次成功持久化会带上它。
    }
  }

  /** 队列之外的异步错误入口：显式排队，绝不复用可跳队列的内部写函数。 */
  private async recordErrorAsync(topicId: string, message: string): Promise<void> {
    try {
      await this.runtime.queue.run(() => this.writeErrorInQueue(topicId, message));
    } catch {
      // 队列已关闭等情形：仍然只影响诊断，不影响调用方流程。
    }
  }

  /**
   * 按实际字节核对上一次未完成的替换（只在队列内调用）。
   *
   * - 等于 pending.nextHash：确实替换过 → 补完成记账；
   * - 等于 pending.baseHash：尚未替换 → 清除 pending，交回正常流程；
   * - 都不是：外部改动 → 409，绑定不变，也不改写 targetHash。
   */
  private async reconcilePending(topicId: string): Promise<void> {
    const record = this.configStore.entries.get(topicId);
    if (record === undefined || record.pending === null) return;
    const pending = record.pending;
    const absolute = path.resolve(record.targetPath);
    const bytes = await fs.readFile(absolute).catch((error: unknown) => {
      if (isErrnoCode(error, "ENOENT")) return null;
      throw error;
    });
    const actualHash = bytes === null ? null : sha256Bytes(bytes);

    if (actualHash === pending.nextHash) {
      await this.commitRecordInQueue(
        topicId,
        {
          ...record,
          targetHash: pending.nextHash,
          lastSuccessAt: pending.recordedAt,
          exportedContentFingerprint: pending.contentFingerprint,
          exportedReaderFingerprint: pending.readerFingerprint,
          exportedExportFingerprint: pending.exportFingerprint,
          exportedRevision: pending.revision,
          lastError: null,
          pending: null,
        },
        record,
      );
      return;
    }
    if (actualHash === pending.baseHash) {
      await this.commitRecordInQueue(topicId, { ...record, pending: null }, record);
      return;
    }
    // 目标既不是替换前也不是替换后的字节：外部改动，不能放宽成"看起来像成品就算数"。
    const message =
      "目标文件在导出过程中被外部改动（既不是替换前也不是替换后的完整字节）；已保留 pending 记录等待人工确认";
    await this.commitRecordInQueue(topicId, { ...record, pending: null, lastError: message }, record);
    throw new ServiceError(409, "EXPORT_TARGET_CONFLICT", message, {
      details: {
        path: record.targetPath,
        expectedBase: pending.baseHash,
        expectedNext: pending.nextHash,
        actual: actualHash,
      },
    });
  }

  /**
   * 目标是否已经是这份内容与这份读者构建的成品。
   * 记录里的内容／读者指纹都相同，且磁盘字节哈希与记录一致时才跳过重写。
   */
  private async alreadyCurrent(
    absolute: string,
    record: ExportTargetRecord,
    prepared: PreparedExport,
  ): Promise<boolean> {
    if (record.exportedContentFingerprint !== prepared.contentFingerprint) return false;
    if (record.exportedReaderFingerprint !== prepared.readerFingerprint) return false;
    if (record.targetHash === null) return false;
    const bytes = await fs.readFile(absolute).catch(() => null);
    if (bytes === null) return false;
    if (sha256Bytes(bytes) !== record.targetHash) return false;
    const markers = readExportMarkers(bytes.toString("utf8"));
    return markers !== null && markers.exportFingerprint === prepared.exportFingerprint;
  }

  /**
   * 记录失败。
   *
   * inQueue 由调用链显式给出：finalize 内传 true（已在队列任务中，直接写），
   * 队列外的异步失败传 false（显式排队再写）。不靠实例标志推断所在上下文。
   */
  private fail(
    topicId: string,
    message: string,
    diagnostics: readonly Diagnostic[] | null = null,
    quiet = false,
    inQueue = false,
  ): void {
    const record = this.configStore.entries.get(topicId);
    if (record !== undefined) {
      this.configStore.entries.set(topicId, { ...record, lastError: message });
      if (inQueue) void this.writeErrorInQueue(topicId, message);
      else void this.recordErrorAsync(topicId, message);
    }
    if (quiet) return;
    this.lastStatus.set(topicId, {
      ...this.statusOf(topicId),
      state: "error",
      error: message,
      ...(diagnostics === null ? {} : { resourceDiagnostics: [...diagnostics] }),
    });
    this.broadcast();
  }

  /** 路径与目标归属校验；在真正替换前重做（全部按 canonical 路径）。 */
  private async validateTarget(
    topicId: string,
    targetPath: string,
    record: ExportTargetRecord,
  ): Promise<{ absolute: string; baseHash: string | null }> {
    if (!isAbsoluteHtml(targetPath)) {
      throw new ServiceError(422, "EXPORT_TARGET_INVALID", "目标必须是本机绝对 .html 路径", {
        details: { path: targetPath },
      });
    }
    const resolution = await resolveTarget(targetPath);
    const roots = await targetInsideRoots(this.runtime, this.appRoot, resolution);
    if (roots.insideWorkspace) {
      throw new ServiceError(422, "EXPORT_TARGET_FORBIDDEN", "导出目标不能位于工作区内部", {
        details: { path: targetPath },
      });
    }
    if (roots.insideApp) {
      throw new ServiceError(422, "EXPORT_TARGET_FORBIDDEN", "导出目标不能位于应用源码或构建目录内", {
        details: { path: targetPath },
      });
    }
    if (resolution.isSymlink) {
      throw new ServiceError(422, "EXPORT_TARGET_UNSAFE", "导出目标不能是符号链接或 junction", {
        details: { path: targetPath },
      });
    }
    if (resolution.exists && !resolution.isFile) {
      throw new ServiceError(422, "EXPORT_TARGET_UNSAFE", "导出目标必须是普通文件", {
        details: { path: targetPath },
      });
    }
    if (!resolution.exists) {
      // 已绑定的路径当前不存在（用户删除了旧成品、或首次生成前）：没有可覆盖的字节，
      // 直接按同一 canonical 路径安全重建。绑定关系保留；若目录被换成链接或指向
      // 工作区／应用根，上面的守卫已经拒绝。
      return { absolute: resolution.canonical, baseHash: null };
    }
    const bytes = await fs.readFile(resolution.canonical);
    const hash = sha256Bytes(bytes);
    if (record.targetHash !== null && hash !== record.targetHash) {
      throw new ServiceError(409, "EXPORT_TARGET_CONFLICT", "目标文件已被外部改动；拒绝覆盖", {
        details: { path: targetPath, expected: record.targetHash, actual: hash },
      });
    }
    const markers = readExportMarkers(bytes.toString("utf8"));
    if (markers === null) {
      throw new ServiceError(
        422,
        "EXPORT_TARGET_OCCUPIED",
        "目标位置已存在无关文件；请选择新路径，不覆盖无关内容",
        { details: { path: targetPath } },
      );
    }
    if (markers.workspaceId !== this.runtime.workspaceId || markers.topicId !== topicId) {
      throw new ServiceError(
        422,
        "EXPORT_TARGET_OCCUPIED",
        "目标位置是其他工作区或主题的成品；不能把一个目标绑定给不同主题",
        { details: { path: targetPath, markers } },
      );
    }
    return { absolute: resolution.canonical, baseHash: hash };
  }

  /* ------------------------------ 操作 ------------------------------ */

  /**
   * 更换/解除导出绑定。
   *
   * 整个"读现有记录 → 校验 → 写配置"在同一个队列任务内完成；校验不能放在队列外，
   * 否则并发请求会基于过期记录互相覆盖。排队的身份来自这条调用链本身，
   * 不依赖任何实例级标志。
   */
  async setTarget(topicId: string, targetPath: string | null): Promise<TopicExportStatus> {
    this.requireWritable();
    const bound = await this.runtime.queue.run(async () => {
      this.requireWritable();
      const snapshot = this.runtime.current.data;
      const topic = snapshot.topics.find((entry) => entry.topicId === topicId);
      if (topic === undefined) {
        throw new ServiceError(404, "NOT_FOUND", "当前快照中没有主题 " + topicId, {
          details: { topicId },
        });
      }
      const existing = this.configStore.entries.get(topicId);
      if (targetPath === null) {
        // 取消绑定：保留已有成品，只清除本机记录。
        if (existing !== undefined) {
          this.requireWritable();
          this.configStore.entries.delete(topicId);
          try {
            await this.persist();
          } catch (error) {
            this.configStore.entries.set(topicId, existing);
            throw error;
          }
        }
        return false;
      }

      const normalized = await this.inspectTarget(topicId, targetPath);
      const updated: ExportTargetRecord = {
        // 记录 canonical 路径，重启后仍按真实位置判断。
        targetPath: normalized.canonical,
        targetHash: normalized.targetHash,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        exportedContentFingerprint: existing?.exportedContentFingerprint ?? null,
        exportedReaderFingerprint: existing?.exportedReaderFingerprint ?? null,
        exportedExportFingerprint: existing?.exportedExportFingerprint ?? null,
        exportedRevision: existing?.exportedRevision ?? null,
        lastError: null,
        // 换绑或重绑：旧 pending 的 base/next 都对应旧目标，不能带过来。
        pending: null,
      };
      this.requireWritable();
      this.configStore.entries.set(topicId, updated);
      try {
        await this.persist();
      } catch (error) {
        if (existing === undefined) this.configStore.entries.delete(topicId);
        else this.configStore.entries.set(topicId, existing);
        throw error;
      }
      return true;
    });

    if (!bound) {
      const unbound = this.statusOf(topicId);
      this.broadcast();
      return unbound;
    }
    // 先注册导出任务（generation + preparing）再取状态：新目标文件尚未生成是正常
    // 待生成状态，不是 error。这里不等整个渲染完成，任务在后台继续。
    const scheduled = this.schedule(topicId, "target");
    void scheduled.catch(() => undefined);
    return this.statusOf(topicId);
  }

  /** 目标路径校验与现有字节读取（只读；调用方须持有队列）。 */
  private async inspectTarget(
    topicId: string,
    targetPath: string,
  ): Promise<{ canonical: string; targetHash: string | null }> {
    if (!isAbsoluteHtml(targetPath)) {
      throw new ServiceError(422, "EXPORT_TARGET_INVALID", "目标必须是本机绝对 .html 路径", {
        details: { path: targetPath },
      });
    }
    const resolution = await resolveTarget(targetPath);
    const roots = await targetInsideRoots(this.runtime, this.appRoot, resolution);
    if (roots.insideWorkspace) {
      throw new ServiceError(422, "EXPORT_TARGET_FORBIDDEN", "导出目标不能位于工作区内部", {
        details: { path: targetPath },
      });
    }
    if (roots.insideApp) {
      throw new ServiceError(422, "EXPORT_TARGET_FORBIDDEN", "导出目标不能位于应用源码或构建目录内", {
        details: { path: targetPath },
      });
    }
    if (resolution.isSymlink || (resolution.exists && !resolution.isFile)) {
      throw new ServiceError(422, "EXPORT_TARGET_UNSAFE", "导出目标必须是非链接的普通文件路径", {
        details: { path: targetPath },
      });
    }
    let targetHash: string | null = null;
    if (resolution.exists) {
      const bytes = await fs.readFile(resolution.canonical);
      const markers = readExportMarkers(bytes.toString("utf8"));
      if (markers === null) {
        throw new ServiceError(422, "EXPORT_TARGET_OCCUPIED", "目标位置已存在无关文件；请选择新路径", {
          details: { path: targetPath },
        });
      }
      if (markers.workspaceId !== this.runtime.workspaceId || markers.topicId !== topicId) {
        throw new ServiceError(
          422,
          "EXPORT_TARGET_OCCUPIED",
          "目标位置是其他工作区或主题的成品；不能把一个目标绑定给不同主题",
          { details: { path: targetPath, markers } },
        );
      }
      targetHash = sha256Bytes(bytes);
    }
    return { canonical: resolution.canonical, targetHash };
  }

  /** 重新导出指定主题；清错误与排队同样是显式队列边界。 */
  async retry(topicId: string): Promise<TopicExportStatus> {
    this.requireWritable();
    await this.runtime.queue.run(async () => {
      this.requireWritable();
      const record = this.configStore.entries.get(topicId);
      if (record === undefined) {
        throw new ServiceError(409, "EXPORT_TARGET_UNSET", "该主题还没有导出目标", {
          details: { topicId },
        });
      }
      if (record.lastError !== null) {
        this.configStore.entries.set(topicId, { ...record, lastError: null });
        try {
          await this.persist();
        } catch (error) {
          this.configStore.entries.set(topicId, record);
          throw error;
        }
      }
    });
    // 与 setTarget 一致：先注册任务再取状态，避免把"待生成"报成 error。
    const scheduled = this.schedule(topicId, "retry");
    void scheduled.catch(() => undefined);
    return this.statusOf(topicId);
  }

  private broadcast(): void {
    const statuses = this.allStatuses();
    this.runtime.broadcastExport(statuses);
  }
}

function basicNode(node: TopicSnapshot["nodes"][number]): GraphNode {
  return {
    id: node.id,
    topicId: node.topicId,
    title: node.title,
    summary: node.summary,
    number: "",
    from: node.from,
    flow: node.flow,
    state: node.state,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    sourcePath: node.sourcePath,
  };
}

/**
 * 本主题节点需要的全部外部祖先（直至 root）：只带轻量元数据，
 * 不复制它们所在主题的正文或整个工作区。
 */
function externalAncestors(snapshot: SnapshotData, topic: TopicSnapshot): GraphNode[] {
  const localIds = new Set(topic.nodes.map((node) => node.id));
  const byId = new Map(snapshot.graph.nodes.map((node) => [node.id, node]));
  const boundary: GraphNode[] = [];
  const seen = new Set<string>();
  for (const node of topic.nodes) {
    let current: string | null = node.from;
    const guard = new Set<string>();
    while (current !== null && !guard.has(current)) {
      guard.add(current);
      const ancestor = byId.get(current);
      if (ancestor === undefined) break;
      if (!localIds.has(ancestor.id) && !seen.has(ancestor.id)) {
        seen.add(ancestor.id);
        boundary.push(toGraphNode(ancestor));
      }
      current = ancestor.from;
    }
  }
  // 稳定顺序：按图的派生顺序。
  const order = new Map(snapshot.graph.nodes.map((node, index) => [node.id, index]));
  return boundary.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
}

function errorMessageOf(error: unknown): string {
  if (error instanceof StorageError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function summarize(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .slice(0, 3)
    .map((item) => item.code + " " + item.message)
    .join("；");
}