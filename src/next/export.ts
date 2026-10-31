/**
 * 主题自动导出（SQLite 领域版）。
 *
 * 把同一已提交的主题冻结成现有单文件 HTML：
 * - 文档只由 GraphStore 快照组装，不读、不写任何主题 Markdown 文件；
 * - 资源只从同一工作区的 resources/ 读取并内联成 data URI；
 * - 目标位置记录在 .aichat/local/exports.json（本机位置，不属于内容真源）；
 * - 同一路径原子替换，失败保留旧成品；目标被外部改动时拒绝覆盖；
 * - 状态变化通过 onStatus 回调交给服务端 SSE。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import {
  captureResources,
  computeContentFingerprint,
  computeExportFingerprints,
  readExportMarkers,
  readReaderAssets,
  renderTopicHtml,
  type ReaderAssets,
} from '../export/index.js';
import { writeFileDurable } from '../storage/atomic.js';
import { sha256Bytes } from '../storage/hash.js';
import {
  loadExportConfig,
  saveExportConfig,
  type ExportConfigStore,
  type ExportPendingRecord,
  type ExportTargetRecord,
} from '../service/export-config.js';
import type { CreateExportManagerOptions, ExportManagerLike } from './export-contract.js';
import {
  DomainError,
  findTopic,
  publicNode,
  publicTopic,
  type NodeView,
  type Snapshot,
  type TopicView,
} from './model.js';
import type {
  Diagnostic,
  ExportState,
  OfflineNode,
  OfflineTopicDocument,
  TopicExportStatus,
} from './protocol.js';
import { GraphStore } from './store.js';

interface PreparedExport {
  readonly topicId: string;
  readonly generation: number;
  /** 嵌入成品的冻结文档（fingerprint 已填充）。 */
  readonly document: OfflineTopicDocument;
  readonly html: string;
  /** 快照内容身份：主题版本 + 节点版本，用于状态与跳过重写。 */
  readonly sourceFingerprint: string;
  readonly readerFingerprint: string;
  readonly exportFingerprint: string;
  readonly resourceDiagnostics: Diagnostic[];
  /** 非 null 表示资源有 error，必须保留旧成品。 */
  readonly resourceError: string | null;
  readonly snapshotRevision: number;
}

interface TargetResolution {
  absolute: string;
  canonical: string;
  canonicalExisting: string | null;
  exists: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

/**
 * 导出管理器工厂，供服务端创建。实现 ExportManagerLike，不额外暴露内部类型。
 */
export function createExportManager(options: CreateExportManagerOptions): ExportManagerLike {
  return new SqliteExportManager(options);
}

class SqliteExportManager implements ExportManagerLike {
  private readonly root: string;
  private readonly appRoot: string;
  private readonly offlineDirectory: string;
  private readonly expectedWorkspaceId: string;
  private readonly instanceId: string;
  private readonly onStatus: ((status: TopicExportStatus) => void) | undefined;

  private store: GraphStore | null = null;
  private rootReal: string | null = null;
  private config: ExportConfigStore | null = null;
  private assets: ReaderAssets | null = null;
  private assetsError: string | null = null;

  /** 每个主题的最新任务代号；旧任务发现代号变化就不再写盘。 */
  private readonly generations = new Map<string, number>();
  /** 正在准备（计算文档／渲染 HTML）的任务，按主题；用于 pending 状态。 */
  private readonly preparing = new Map<string, Promise<unknown>>();
  private readonly writing = new Set<string>();
  private readonly lastStatus = new Map<string, TopicExportStatus>();
  private readonly emitted = new Map<string, string>();
  private readonly resourceDiagnostics = new Map<string, Diagnostic[]>();

  /** 串行化配置写入与成品替换；计算在队列外完成。 */
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private initialized = false;

  constructor(options: CreateExportManagerOptions) {
    if (typeof options.root !== 'string' || options.root.trim().length === 0) {
      throw new DomainError('EXPORT_OPTIONS_INVALID', '导出管理器缺少工作区根目录', 422);
    }
    if (typeof options.appRoot !== 'string' || options.appRoot.trim().length === 0) {
      throw new DomainError('EXPORT_OPTIONS_INVALID', '导出管理器缺少应用根目录', 422);
    }
    if (typeof options.offlineDirectory !== 'string' || options.offlineDirectory.trim().length === 0) {
      throw new DomainError('EXPORT_OPTIONS_INVALID', '导出管理器缺少离线读者资源目录', 422);
    }
    if (typeof options.workspaceId !== 'string' || options.workspaceId.length === 0) {
      throw new DomainError('EXPORT_OPTIONS_INVALID', '导出管理器缺少 workspaceId', 422);
    }
    this.root = path.resolve(options.root);
    this.appRoot = path.resolve(options.appRoot);
    this.offlineDirectory = path.resolve(options.offlineDirectory);
    this.expectedWorkspaceId = options.workspaceId;
    this.instanceId = 'inst_' + randomUUID().replace(/-/g, '');
    this.onStatus = options.onStatus;
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.stopped) throw new DomainError('EXPORT_STOPPED', '导出管理器已关闭', 409);

    let rootReal: string;
    try {
      rootReal = await fs.realpath(this.root);
      const stat = await fs.stat(rootReal);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new DomainError('WORKSPACE_ROOT_INVALID', '无法解析工作区根目录：' + this.root, 422, {
        cause: messageOf(error),
      });
    }
    this.rootReal = rootReal;

    let store: GraphStore;
    try {
      store = GraphStore.open(this.root, { readonly: true, instanceId: this.instanceId });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('WORKSPACE_OPEN_FAILED', '无法打开 graph.sqlite：' + messageOf(error), 500);
    }
    let workspaceId: string;
    try {
      workspaceId = store.snapshot().workspaceId;
    } catch (error) {
      store.close();
      throw error;
    }
    if (workspaceId !== this.expectedWorkspaceId) {
      store.close();
      throw new DomainError(
        'WORKSPACE_MISMATCH',
        '导出管理器与数据库工作区不一致',
        409,
        { expected: this.expectedWorkspaceId, actual: workspaceId },
      );
    }
    this.store = store;
    this.config = await loadExportConfig(rootReal, this.expectedWorkspaceId);

    try {
      this.assets = await readReaderAssets({ directory: this.offlineDirectory });
      this.assetsError = null;
    } catch (error) {
      this.assets = null;
      this.assetsError =
        '离线读者资源不可用（' + this.offlineDirectory + '）：' + messageOf(error);
    }

    this.initialized = true;
    // 启动补齐：只处理已绑定主题；失败只影响状态，不丢绑定。
    const bound = this.boundTopicIds();
    await Promise.all(bound.map((topicId) => this.requestExport(topicId, 'startup')));
  }

  /** 停止新任务并等待队列排空后关闭只读数据库连接。 */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    const store = this.store;
    const drain = this.queue;
    void drain
      .then(() => {
        if (store !== null) store.close();
      })
      .catch(() => {
        if (store !== null) {
          try {
            store.close();
          } catch {
            // 关闭失败不影响调用方；连接随进程退出释放。
          }
        }
      })
      .finally(() => {
        this.store = null;
        this.config = null;
        this.assets = null;
      });
  }

  /* ------------------------------ 状态 ------------------------------ */

  statuses(): TopicExportStatus[] {
    const config = this.config;
    const ids: string[] = [];
    const snapshot = this.snapshotOrNull();
    if (snapshot !== null) {
      for (const topic of snapshot.topics) ids.push(topic.id);
    }
    if (config !== null) {
      for (const topicId of config.entries.keys()) {
        if (!ids.includes(topicId)) ids.push(topicId);
      }
    }
    return ids.map((topicId) => this.status(topicId));
  }

  status(topicId: string): TopicExportStatus {
    const cached = this.lastStatus.get(topicId);
    // 关闭后连接已释放：返回最后一次算出的状态，而不是把已导出主题说成 unset。
    if (this.stopped) return cached ?? this.emptyStatus(topicId);
    const config = this.config;
    const record = config?.entries.get(topicId) ?? null;
    const snapshot = this.snapshotOrNull();
    const topic = snapshot?.topics.find((entry) => entry.id === topicId) ?? null;
    const nodes = snapshot === null ? [] : snapshot.nodes.filter((node) => node.topicId === topicId);
    const sourceFingerprint = topic === null ? null : sourceFingerprintOf(topic, nodes);
    const resourceDiagnostics = this.resourceDiagnostics.get(topicId) ?? [];
    const targetPresent = record !== null && isFileSync(record.targetPath);
    const lastError = record?.lastError ?? null;

    let state: ExportState;
    if (record === null) state = 'unset';
    else if (this.preparing.has(topicId)) state = this.writing.has(topicId) ? 'writing' : 'pending';
    else if (lastError !== null) state = 'error';
    else if (!targetPresent) state = 'error';
    else if (
      sourceFingerprint !== null &&
      record.exportedContentFingerprint !== null &&
      sourceFingerprint !== record.exportedContentFingerprint
    ) {
      state = 'stale';
    } else if (hasErrorDiagnostics(resourceDiagnostics)) state = 'error';
    else if (record.pending !== null) state = 'pending';
    else if (record.exportedContentFingerprint === null) state = 'pending';
    else state = 'ready';

    let error: string | null = lastError;
    if (error === null && state === 'error') {
      if (record !== null && !targetPresent) error = '目标文件不存在或已不可读';
      else if (hasErrorDiagnostics(resourceDiagnostics)) error = summarizeDiagnostics(resourceDiagnostics);
    }
    if (state === 'stale' && error === null) error = '源内容已更新，旧成品保留';

    const status: TopicExportStatus = {
      topicId,
      topicTitle: topic?.title ?? cached?.topicTitle ?? '',
      targetPath: record?.targetPath ?? null,
      state,
      sourceFingerprint,
      exportedFingerprint: record?.exportedContentFingerprint ?? null,
      exportedRevision: record?.exportedRevision ?? null,
      lastSuccessAt: record?.lastSuccessAt ?? null,
      error,
      resourceDiagnostics,
      targetHash: record?.targetHash ?? null,
      targetPresent,
    };
    this.lastStatus.set(topicId, status);
    return status;
  }

  /* ------------------------------ 操作 ------------------------------ */

  async bindTarget(topicId: string, targetPath: string | null): Promise<TopicExportStatus> {
    this.requireReady();
    const bound = await this.runExclusive(async (): Promise<boolean> => {
      const config = this.config as ExportConfigStore;
      const store = this.store as GraphStore;
      const topic = findTopic(store.snapshot(), topicId);
      const existing = config.entries.get(topicId);
      if (targetPath === null) {
        // 取消绑定：不删除已有成品，只清本机记录。
        if (existing !== undefined) {
          config.entries.delete(topicId);
          try {
            await this.persistConfig();
          } catch (error) {
            config.entries.set(topicId, existing);
            throw error;
          }
        }
        return false;
      }
      const inspected = await this.inspectTarget(topicId, targetPath);
      const updated: ExportTargetRecord = {
        targetPath: inspected.canonical,
        targetHash: inspected.targetHash,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        exportedContentFingerprint: existing?.exportedContentFingerprint ?? null,
        exportedReaderFingerprint: existing?.exportedReaderFingerprint ?? null,
        exportedExportFingerprint: existing?.exportedExportFingerprint ?? null,
        exportedRevision: existing?.exportedRevision ?? null,
        lastError: null,
        // 换绑/重绑：旧 pending 的 base/next 都对应旧目标，不能带过来。
        pending: null,
      };
      config.entries.set(topicId, updated);
      try {
        await this.persistConfig();
      } catch (error) {
        if (existing === undefined) config.entries.delete(topicId);
        else config.entries.set(topicId, existing);
        throw error;
      }
      this.resourceDiagnostics.delete(topicId);
      return true;
    });
    if (!bound) {
      this.emitStatus(topicId, true);
      return this.status(topicId);
    }
    return this.requestExport(topicId, 'target');
  }

  async retry(topicId: string): Promise<TopicExportStatus> {
    this.requireReady();
    await this.runExclusive(async () => {
      const config = this.config as ExportConfigStore;
      const record = config.entries.get(topicId);
      if (record === undefined) {
        throw new DomainError('EXPORT_TARGET_UNSET', '该主题还没有导出目标', 409, { topicId });
      }
      if (record.lastError === null && record.pending === null) return;
      const cleared: ExportTargetRecord = { ...record, lastError: null };
      config.entries.set(topicId, cleared);
      try {
        await this.persistConfig();
      } catch (error) {
        config.entries.set(topicId, record);
        throw error;
      }
    });
    return this.requestExport(topicId, 'retry');
  }

  /** 提交后调用：为受影响且已绑定的主题安排一次导出，不等待完成。 */
  schedule(topicIds: readonly string[]): void {
    if (this.stopped) return;
    for (const topicId of topicIds) {
      if (this.config?.entries.has(topicId) !== true) continue;
      void this.requestExport(topicId, 'schedule').catch(() => undefined);
    }
  }

  /* ------------------------------ 导出任务 ------------------------------ */

  private requestExport(topicId: string, reason: string): Promise<TopicExportStatus> {
    // Startup/schedule may preserve an already-current old-reader HTML; an explicit
    // bind or retry is a new export request and may use the current reader.
    const force = reason === 'target' || reason === 'retry';
    if (this.stopped || this.config?.entries.has(topicId) !== true) {
      return Promise.resolve(this.status(topicId));
    }
    const generation = (this.generations.get(topicId) ?? 0) + 1;
    this.generations.set(topicId, generation);

    const work = (async (): Promise<void> => {
      try {
        const prepared = await this.prepare(topicId, generation);
        await this.runExclusive(async () => {
          if (this.stopped || this.generations.get(topicId) !== generation) return;
          await this.finalize(prepared, force);
        });
      } catch (error) {
        if (this.stopped) return;
        if (
          error instanceof DomainError &&
          (error.code === 'EXPORT_SUPERSEDED' ||
            error.code === 'EXPORT_STOPPED' ||
            error.code === 'EXPORT_TARGET_UNSET')
        ) {
          return;
        }
        await this.recordFailure(topicId, messageOf(error));
      }
    })();

    this.preparing.set(topicId, work);
    this.emitStatus(topicId);
    // 任务结束后先撤掉 pending 标记，再返回最终状态（否则调用方只会看到 pending）。
    return work
      .finally(() => {
        if (this.preparing.get(topicId) === work) this.preparing.delete(topicId);
        this.emitStatus(topicId);
      })
      .then(() => this.status(topicId));
  }

  private async prepare(topicId: string, generation: number): Promise<PreparedExport> {
    const store = this.store;
    const rootReal = this.rootReal;
    const config = this.config;
    if (store === null || rootReal === null || config === null) {
      throw new DomainError('EXPORT_NOT_READY', '导出管理器尚未初始化', 503);
    }
    if (config.entries.get(topicId) === undefined) {
      throw new DomainError('EXPORT_TARGET_UNSET', '该主题还没有导出目标', 409, { topicId });
    }
    const assets = this.assets;
    if (assets === null) {
      throw new DomainError(
        'EXPORT_READER_UNAVAILABLE',
        this.assetsError ?? '离线读者资源不可用',
        503,
        { directory: this.offlineDirectory },
      );
    }

    const snapshot = store.snapshot();
    const topic = findTopic(snapshot, topicId);
    const topicNodes: NodeView[] = snapshot.nodes.filter((node) => node.topicId === topicId);
    const nodes: OfflineNode[] = topicNodes.map((node) => ({ ...publicNode(node), body: node.body }));

    // 资源只从同一工作区 resources/ 读取；正文中的 data 图片保持内联。
    const capture = await captureResources(
      rootReal,
      nodes.map((node) => ({ id: node.id, path: '', body: node.body })),
    );
    if (this.stopped) throw new DomainError('EXPORT_STOPPED', '导出管理器已关闭', 409);
    if (this.generations.get(topicId) !== generation) {
      throw new DomainError('EXPORT_SUPERSEDED', '已有更新的导出任务', 409);
    }

    const document: OfflineTopicDocument = {
      format: 1,
      workspaceId: snapshot.workspaceId,
      workspaceName: snapshot.name,
      instanceId: this.instanceId,
      revision: snapshot.revision,
      fingerprint: '',
      generatedAt: new Date().toISOString(),
      topic: publicTopic(topic),
      nodes,
      // SQLite 领域不允许跨主题父边，因此没有跨主题边界节点。
      boundaryNodes: [],
      changes: store.latestChangeDetail(topicId),
      resources: capture.resources,
      resourceDiagnostics: capture.diagnostics as Diagnostic[],
    };
    const fingerprint = computeContentFingerprint(document);
    const frozen: OfflineTopicDocument = { ...document, fingerprint };
    const html = renderTopicHtml({
      document: frozen,
      readerScript: assets.script,
      readerStyles: assets.styles,
    });
    const fingerprints = computeExportFingerprints({
      document: frozen,
      readerScript: assets.script,
      readerStyles: assets.styles,
    });
    const resourceDiagnostics = capture.diagnostics as Diagnostic[];
    const resourceError = capture.ok && !hasErrorDiagnostics(resourceDiagnostics)
      ? null
      : summarizeDiagnostics(resourceDiagnostics);

    return {
      topicId,
      generation,
      document: frozen,
      html,
      sourceFingerprint: sourceFingerprintOf(topic, topicNodes),
      readerFingerprint: fingerprints.readerFingerprint,
      exportFingerprint: fingerprints.exportFingerprint,
      resourceDiagnostics,
      resourceError,
      snapshotRevision: snapshot.revision,
    };
  }

  private async finalize(prepared: PreparedExport, force: boolean): Promise<void> {
    const topicId = prepared.topicId;
    const config = this.config;
    if (config === null) return;
    const record = config.entries.get(topicId);
    if (record === undefined) return;
    this.resourceDiagnostics.set(topicId, prepared.resourceDiagnostics);
    this.writing.add(topicId);
    this.emitStatus(topicId);
    try {
      if (this.stopped) return;
      if (prepared.resourceError !== null) {
        await this.fail(topicId, '资源或内容存在问题，未生成成品：' + prepared.resourceError);
        return;
      }
      const store = this.store;
      if (store === null) return;
      if (store.snapshot().revision !== prepared.snapshotRevision) {
        await this.fail(topicId, '快照已更新，本次导出被取消；旧成品保留');
        return;
      }
      // 先收尾上一次"已替换但完成记账失败"的记录，避免被误判成外部冲突。
      await this.reconcilePending(topicId);
      const current = this.config?.entries.get(topicId);
      if (current === undefined) return;
      const target = await this.validateTarget(topicId, current.targetPath, current);
      if (!force && await this.alreadyCurrent(target.absolute, current, prepared)) {
        this.emitStatus(topicId, true);
        return;
      }

      const htmlBytes = Buffer.from(prepared.html, 'utf8');
      const nextHash = sha256Bytes(htmlBytes);
      const pending: ExportPendingRecord = {
        baseHash: target.baseHash,
        nextHash,
        contentFingerprint: prepared.sourceFingerprint,
        readerFingerprint: prepared.readerFingerprint,
        exportFingerprint: prepared.exportFingerprint,
        revision: prepared.snapshotRevision,
        recordedAt: new Date().toISOString(),
      };
      const withPending: ExportTargetRecord = { ...current, lastError: null, pending };
      // 记账失败就不碰旧 HTML：宁可这次不出成品，也不能让盘上配置与实际字节失配。
      await this.commitRecord(topicId, withPending, current);

      await writeFileDurable(target.absolute, htmlBytes);
      const written = await fs.readFile(target.absolute);
      if (sha256Bytes(written) !== nextHash) {
        throw new DomainError('INTERNAL', '写入后的成品字节与预期不一致；保留 pending 待核实', 500);
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
      await this.commitRecord(topicId, updated, withPending);
      this.emitStatus(topicId, true);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'EXPORT_SUPERSEDED') return;
      await this.fail(topicId, messageOf(error));
    } finally {
      this.writing.delete(topicId);
      this.emitStatus(topicId);
    }
  }

  /* ------------------------------ 写盘与目标 ------------------------------ */

  private async reconcilePending(topicId: string): Promise<void> {
    const config = this.config;
    if (config === null) return;
    const record = config.entries.get(topicId);
    if (record === undefined || record.pending === null) return;
    const pending = record.pending;
    const absolute = path.resolve(record.targetPath);
    const bytes = await fs.readFile(absolute).catch((error: unknown) => {
      if (isErrnoCode(error, 'ENOENT')) return null;
      throw error;
    });
    const actualHash = bytes === null ? null : sha256Bytes(bytes);

    if (actualHash === pending.nextHash) {
      await this.commitRecord(
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
      await this.commitRecord(topicId, { ...record, pending: null }, record);
      return;
    }
    const message =
      '目标文件在导出过程中被外部改动（既不是替换前也不是替换后的完整字节）；已保留 pending 记录等待人工确认';
    await this.commitRecord(topicId, { ...record, pending: null, lastError: message }, record);
    throw new DomainError('EXPORT_TARGET_CONFLICT', message, 409, {
      path: record.targetPath,
      expectedBase: pending.baseHash,
      expectedNext: pending.nextHash,
      actual: actualHash,
    });
  }

  private async alreadyCurrent(
    absolute: string,
    record: ExportTargetRecord,
    prepared: PreparedExport,
  ): Promise<boolean> {
    // A reader/build upgrade alone must not rewrite a previously exported HTML.
    // Existing files are refreshed only when their source content changed (or the
    // user binds/regenerates with a changed content fingerprint). New exports
    // always use the current reader and model.
    if (record.exportedContentFingerprint !== prepared.sourceFingerprint) return false;
    if (record.targetHash === null) return false;
    const bytes = await fs.readFile(absolute).catch(() => null);
    if (bytes === null) return false;
    if (sha256Bytes(bytes) !== record.targetHash) return false;
    const markers = readExportMarkers(bytes.toString('utf8'));
    if (markers === null) return false;
    return markers.workspaceId === this.expectedWorkspaceId && markers.topicId === prepared.topicId;
  }

  /** 绑定时校验：目标必须是外部普通 .html，已存在时必须是同一主题的成品。 */
  private async inspectTarget(
    topicId: string,
    targetPath: string,
  ): Promise<{ canonical: string; targetHash: string | null }> {
    if (!isAbsoluteHtml(targetPath)) {
      throw new DomainError('EXPORT_TARGET_INVALID', '目标必须是本机绝对 .html 路径', 422, {
        path: targetPath,
      });
    }
    const resolution = await resolveTargetPath(targetPath);
    const roots = await this.canonicalRoots();
    if (insideRoot(roots.workspace, resolution) || insideRoot(roots.app, resolution)) {
      throw new DomainError('EXPORT_TARGET_FORBIDDEN', '导出目标不能位于工作区或应用目录内部', 422, {
        path: targetPath,
      });
    }
    if (resolution.isSymlink) {
      throw new DomainError('EXPORT_TARGET_UNSAFE', '导出目标不能是符号链接或 junction', 422, {
        path: targetPath,
      });
    }
    if (resolution.exists && !resolution.isFile) {
      throw new DomainError('EXPORT_TARGET_UNSAFE', '导出目标必须是普通文件', 422, {
        path: targetPath,
      });
    }
    if (!resolution.exists) return { canonical: resolution.canonical, targetHash: null };
    const bytes = await fs.readFile(resolution.canonical);
    const markers = readExportMarkers(bytes.toString('utf8'));
    if (markers === null) {
      throw new DomainError('EXPORT_TARGET_OCCUPIED', '目标位置已存在无关文件；请选择新路径，不覆盖无关内容', 422, {
        path: targetPath,
      });
    }
    assertOwnMarkers(markers, this.expectedWorkspaceId, topicId, targetPath);
    return { canonical: resolution.canonical, targetHash: sha256Bytes(bytes) };
  }

  /** 写盘前复核：绑定路径未被外部改动，目标仍是本工作区本主题的成品。 */
  private async validateTarget(
    topicId: string,
    targetPath: string,
    record: ExportTargetRecord,
  ): Promise<{ absolute: string; baseHash: string | null }> {
    if (!isAbsoluteHtml(targetPath)) {
      throw new DomainError('EXPORT_TARGET_INVALID', '目标必须是本机绝对 .html 路径', 422, {
        path: targetPath,
      });
    }
    const resolution = await resolveTargetPath(targetPath);
    const roots = await this.canonicalRoots();
    if (insideRoot(roots.workspace, resolution) || insideRoot(roots.app, resolution)) {
      throw new DomainError('EXPORT_TARGET_FORBIDDEN', '导出目标不能位于工作区或应用目录内部', 422, {
        path: targetPath,
      });
    }
    if (resolution.isSymlink) {
      throw new DomainError('EXPORT_TARGET_UNSAFE', '导出目标不能是符号链接或 junction', 422, {
        path: targetPath,
      });
    }
    if (resolution.exists && !resolution.isFile) {
      throw new DomainError('EXPORT_TARGET_UNSAFE', '导出目标必须是普通文件', 422, {
        path: targetPath,
      });
    }
    if (!resolution.exists) return { absolute: resolution.canonical, baseHash: null };
    const bytes = await fs.readFile(resolution.canonical);
    const hash = sha256Bytes(bytes);
    if (record.targetHash !== null && hash !== record.targetHash) {
      throw new DomainError('EXPORT_TARGET_CONFLICT', '目标文件已被外部改动；拒绝覆盖', 409, {
        path: targetPath,
        expected: record.targetHash,
        actual: hash,
      });
    }
    const markers = readExportMarkers(bytes.toString('utf8'));
    if (markers === null) {
      throw new DomainError('EXPORT_TARGET_OCCUPIED', '目标位置已存在无关文件；请选择新路径，不覆盖无关内容', 422, {
        path: targetPath,
      });
    }
    assertOwnMarkers(markers, this.expectedWorkspaceId, topicId, targetPath);
    return { absolute: resolution.canonical, baseHash: hash };
  }

  private async canonicalRoots(): Promise<{ workspace: string; app: string }> {
    if (this.rootReal === null) {
      throw new DomainError('EXPORT_NOT_READY', '导出管理器尚未初始化', 503);
    }
    const app = await fs.realpath(this.appRoot).catch(() => this.appRoot);
    return { workspace: this.rootReal, app };
  }

  /* ------------------------------ 配置与状态 ------------------------------ */

  private async commitRecord(
    topicId: string,
    updated: ExportTargetRecord,
    previous: ExportTargetRecord,
  ): Promise<void> {
    const config = this.config;
    if (config === null) throw new DomainError('EXPORT_NOT_READY', '导出管理器尚未初始化', 503);
    config.entries.set(topicId, updated);
    try {
      await this.persistConfig();
    } catch (error) {
      config.entries.set(topicId, previous);
      throw error;
    }
  }

  private async persistConfig(): Promise<void> {
    const config = this.config;
    const rootReal = this.rootReal;
    if (config === null || rootReal === null) {
      throw new DomainError('EXPORT_NOT_READY', '导出管理器尚未初始化', 503);
    }
    try {
      await saveExportConfig(config, rootReal);
    } catch (error) {
      throw new DomainError('EXPORT_CONFIG_WRITE_FAILED', '无法保存导出配置：' + messageOf(error), 500);
    }
  }

  private async fail(topicId: string, message: string): Promise<void> {
    const config = this.config;
    const record = config?.entries.get(topicId);
    if (config !== null && record !== undefined && record.lastError !== message) {
      config.entries.set(topicId, { ...record, lastError: message });
      await this.persistConfig().catch(() => undefined);
    }
    this.emitStatus(topicId, true);
  }

  private async recordFailure(topicId: string, message: string): Promise<void> {
    try {
      await this.runExclusive(() => this.fail(topicId, message));
    } catch {
      // 队列已关闭等情形只影响诊断，不影响调用方流程。
    }
  }

  private emitStatus(topicId: string, force = false): void {
    if (this.onStatus === undefined || this.stopped) return;
    const status = this.status(topicId);
    const signature = JSON.stringify(status);
    if (!force && this.emitted.get(topicId) === signature) return;
    this.emitted.set(topicId, signature);
    this.onStatus(status);
  }

  private boundTopicIds(): string[] {
    const config = this.config;
    const snapshot = this.snapshotOrNull();
    if (config === null) return [];
    const ids = snapshot?.topics.map((topic) => topic.id) ?? [];
    return ids.filter((topicId) => config.entries.has(topicId));
  }

  private emptyStatus(topicId: string): TopicExportStatus {
    return {
      topicId,
      topicTitle: '',
      targetPath: null,
      state: 'unset',
      sourceFingerprint: null,
      exportedFingerprint: null,
      exportedRevision: null,
      lastSuccessAt: null,
      error: null,
      resourceDiagnostics: [],
      targetHash: null,
      targetPresent: false,
    };
  }

  private snapshotOrNull(): Snapshot | null {
    try {
      return this.store?.snapshot() ?? null;
    } catch {
      return null;
    }
  }

  private requireReady(): void {
    if (this.stopped) throw new DomainError('EXPORT_STOPPED', '导出管理器已关闭', 409);
    if (!this.initialized || this.store === null || this.config === null) {
      throw new DomainError('EXPORT_NOT_READY', '导出管理器尚未初始化', 503);
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/* ------------------------------ 纯函数 ------------------------------ */

/** 快照内容身份：主题版本 + 本主题节点版本。内容或重要性变化都会改变它。 */
function sourceFingerprintOf(topic: TopicView, nodes: readonly NodeView[]): string {
  const parts = nodes.map((node) => node.id + ':' + String(node.revision)).sort();
  return sha256Bytes(JSON.stringify({ topic: topic.id + ':' + String(topic.revision), nodes: parts }));
}

function hasErrorDiagnostics(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === 'error' || item.severity === undefined);
}

function summarizeDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .slice(0, 3)
    .map((item) => item.code + ' ' + item.message)
    .join('；');
}

function isFileSync(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

/* ------------------------------ 目标路径防护 ------------------------------ */

/** 本机绝对 .html；拒绝 UNC/设备名、ADS 冒号、空字节。 */
function isAbsoluteHtml(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!path.isAbsolute(value)) return false;
  if (value.startsWith('\\') || value.startsWith('//')) return false;
  if (value.includes('\u0000')) return false;
  const withoutDrive = /^[A-Za-z]:/.test(value) ? value.slice(2) : value;
  if (withoutDrive.includes(':')) return false;
  return path.extname(value).toLowerCase() === '.html';
}

/**
 * 逐级拒绝父路径中的符号链接／junction，再用父目录 realpath 拼文件名；
 * 后续的工作区／应用根判断和写入都使用 canonical 路径。
 */
async function resolveTargetPath(value: string): Promise<TargetResolution> {
  const absolute = path.resolve(value);
  const parent = await assertNoLinkedParent(absolute);
  let parentReal: string;
  try {
    parentReal = await fs.realpath(parent);
  } catch (error) {
    throw new DomainError('EXPORT_TARGET_INVALID', '导出目标的父目录不存在或不可访问：' + parent, 422, {
      path: value,
      cause: messageOf(error),
    });
  }
  const canonical = path.join(parentReal, path.basename(absolute));
  const stat = await fs.lstat(canonical).catch((error: unknown) => {
    if (isErrnoCode(error, 'ENOENT')) return null;
    throw new DomainError('EXPORT_TARGET_INVALID', '无法检查导出目标：' + canonical, 422, {
      path: value,
      cause: messageOf(error),
    });
  });
  if (stat === null) {
    return { absolute, canonical, canonicalExisting: null, exists: false, isFile: false, isSymlink: false };
  }
  if (stat.isSymbolicLink()) {
    return { absolute, canonical, canonicalExisting: null, exists: true, isFile: false, isSymlink: true };
  }
  const canonicalExisting = await fs.realpath(canonical).catch(() => canonical);
  return {
    absolute,
    canonical,
    canonicalExisting,
    exists: true,
    isFile: stat.isFile(),
    isSymlink: false,
  };
}

async function assertNoLinkedParent(absolute: string): Promise<string> {
  const parent = path.dirname(absolute);
  const root = path.parse(parent).root;
  const segments = path.relative(root, parent).split(path.sep).filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return parent;
      throw new DomainError('EXPORT_TARGET_INVALID', '无法检查导出目标路径：' + current, 422, {
        cause: messageOf(error),
      });
    }
    if (stat.isSymbolicLink()) {
      throw new DomainError(
        'EXPORT_TARGET_UNSAFE',
        '导出目标的父路径含有符号链接或 junction：' + current + '；请改用真实目录路径',
        422,
        { linkedAncestor: current },
      );
    }
  }
  return parent;
}

function insideRoot(root: string, resolution: TargetResolution): boolean {
  const candidate = resolution.canonicalExisting ?? resolution.canonical;
  if (isInside(root, candidate)) return true;
  return resolution.canonicalExisting !== null && isInside(root, resolution.canonical);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function assertOwnMarkers(
  markers: { workspaceId: string; topicId: string },
  workspaceId: string,
  topicId: string,
  targetPath: string,
): void {
  if (markers.workspaceId === workspaceId && markers.topicId === topicId) return;
  throw new DomainError(
    'EXPORT_TARGET_OCCUPIED',
    '目标位置是其他工作区或主题的成品；不能把一个目标绑定给不同主题',
    422,
    { path: targetPath, markers },
  );
}
