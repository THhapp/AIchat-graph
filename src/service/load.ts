/**
 * 工作区加载：扫描磁盘、分组解析、全图校验、资源捕获，产出有效快照或诊断。
 *
 * 本模块只做"读 + 解析 + 捕获 + 构造快照"，不取锁、不写盘、不发布。
 * 目录分组一律由 core.parseWorkspaceDocuments 完成，这里不按文件逐个猜格式。
 */
import {
  parseWorkspaceDocuments,
  workspaceMetaSchema,
  type SupportedSchemaVersion,
  type WorkspaceMeta,
} from "../core/index.js";
import {
  readWorkspaceFiles,
  StorageError,
  type WorkspaceFiles,
} from "../storage/index.js";
import { captureResources, type ExportResourceNode } from "../export/index.js";
import type { Diagnostic } from "../shared/protocol.js";
import { toWireDiagnostic, toWireStorageDiagnostic, wireDiagnostic } from "./errors.js";
import {
  buildSnapshot,
  type SnapshotData,
  type SnapshotResourceFile,
  type TopicInput,
} from "./snapshot.js";

export interface LoadSuccess {
  readonly ok: true;
  readonly snapshot: SnapshotData;
  readonly diagnostics: Diagnostic[];
}

export interface LoadFailure {
  readonly ok: false;
  readonly diagnostics: Diagnostic[];
}

export type LoadOutcome = LoadSuccess | LoadFailure;

export interface LoadResult {
  /** 读取失败时为 null（例如 workspace.json 不可读）。 */
  readonly files: WorkspaceFiles | null;
  readonly outcome: LoadOutcome;
}

function workspaceMetaFromRaw(files: WorkspaceFiles): { meta?: WorkspaceMeta; diagnostics: Diagnostic[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(files.workspaceFile.text);
  } catch (error) {
    return {
      diagnostics: [
        wireDiagnostic(
          "WORKSPACE_JSON_INVALID",
          "workspace.json 不是合法 JSON" + (error instanceof Error ? error.message : ""),
          "workspace.json",
        ),
      ],
    };
  }
  // 必须校验原始 JSON 的全部字段：不先剥掉未知字段再通过。
  const parsed = workspaceMetaSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      diagnostics: parsed.error.issues.map((issue) =>
        wireDiagnostic(
          "WORKSPACE_SCHEMA_INVALID",
          "workspace.json: " + issue.message + " (" + issue.path.join(".") + ")",
          "workspace.json",
        ),
      ),
    };
  }
  return { meta: parsed.data, diagnostics: [] };
}

export interface CaptureContext {
  /** 供测试与调用方注入；默认调用 export.captureResources。 */
  readonly capture?: typeof captureResources;
}

async function captureTopicResources(
  root: string,
  topicNodes: readonly ExportResourceNode[],
  capture: typeof captureResources,
): Promise<{
  resources: Record<string, string>;
  files: SnapshotResourceFile[];
  diagnostics: Diagnostic[];
}> {
  // 始终交给 export 的 AST 捕获：引用式图片（![alt][ref]）与 <img> 都不能靠
  // 简单正则判断；没有引用时它会快速返回空结果。
  const result = await capture(root, topicNodes);
  return {
    resources: result.resources,
    files: result.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      mediaType: file.mediaType,
      byteLength: file.byteLength,
    })),
    diagnostics: result.diagnostics,
  };
}

/** 用一次已完成的磁盘扫描构造候选快照；失败只返回诊断。 */
export async function evaluateFiles(
  files: WorkspaceFiles,
  context: CaptureContext = {},
): Promise<LoadOutcome> {
  const diagnostics: Diagnostic[] = files.diagnostics.map((diagnostic) =>
    toWireStorageDiagnostic(diagnostic, "warning"),
  );
  const workspaceResult = workspaceMetaFromRaw(files);
  diagnostics.push(...workspaceResult.diagnostics);
  if (workspaceResult.meta === undefined) {
    return { ok: false, diagnostics };
  }
  const workspace = workspaceResult.meta;

  const parsed = parseWorkspaceDocuments({
    workspace,
    documents: files.topics.map((file) => ({ path: file.path, text: file.text })),
  });
  diagnostics.push(...parsed.diagnostics.map(toWireDiagnostic));
  if (!parsed.ok || parsed.graph === undefined) {
    return { ok: false, diagnostics };
  }

  const byPath = new Map(files.topics.map((file) => [file.path, file]));
  const capture = context.capture ?? captureResources;
  const topicInputs: TopicInput[] = [];
  for (const topic of parsed.topics) {
    const topicFiles = topic.sourcePaths
      .map((sourcePath) => byPath.get(sourcePath))
      .filter((file): file is NonNullable<typeof file> => file !== undefined);
    if (topicFiles.length !== topic.sourcePaths.length) {
      const missing = topic.sourcePaths.filter((sourcePath) => !byPath.has(sourcePath));
      diagnostics.push(
        wireDiagnostic(
          "SOURCE_FILE_MISSING",
          "主题 " + topic.topicId + " 的扫描结果缺少源文件：" + missing.join(", "),
          topic.document.path,
        ),
      );
      return { ok: false, diagnostics };
    }
    let captured;
    try {
      captured = await captureTopicResources(
        files.root,
        topic.nodes.map((node) => ({ id: node.id, path: node.sourcePath, body: node.body })),
        capture,
      );
    } catch (error) {
      // 资源捕获抛错不静默产出残缺内容：整份加载失败，保留上一有效快照。
      diagnostics.push(
        wireDiagnostic(
          "RESOURCE_CAPTURE_FAILED",
          "捕获主题资源失败：" + (error instanceof Error ? error.message : String(error)),
          topic.document.path,
        ),
      );
      return { ok: false, diagnostics };
    }
    diagnostics.push(...captured.diagnostics);
    topicInputs.push({
      parsed: topic,
      files: topicFiles,
      resources: captured.resources,
      resourceFiles: captured.files,
      resourceDiagnostics: captured.diagnostics,
    });
  }

  const snapshot = buildSnapshot({
    workspace,
    workspaceHash: files.workspaceFile.sha256,
    topics: topicInputs,
    graph: parsed.graph,
  });
  return { ok: true, snapshot, diagnostics };
}

/**
 * 读取并校验磁盘。读取失败（workspace.json 缺失／非法）与校验失败都返回诊断，
 * 由协调器决定保留上一份有效快照还是显示空内容。
 */
export async function readSnapshot(
  root: string,
  context: CaptureContext = {},
): Promise<LoadResult> {
  let files: WorkspaceFiles;
  try {
    files = await readWorkspaceFiles(root);
  } catch (error) {
    const diagnostics =
      error instanceof StorageError
        ? [wireDiagnostic(error.code, error.message, error.path)]
        : [wireDiagnostic("FILE_READ_FAILED", error instanceof Error ? error.message : String(error))];
    return { files: null, outcome: { ok: false, diagnostics } };
  }
  return { files, outcome: await evaluateFiles(files, context) };
}

export type { SupportedSchemaVersion };