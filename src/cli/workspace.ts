/**
 * CLI 的只读工作区视图：真实磁盘扫描 + core 统一分组解析。
 *
 * - 格式判断与主题分组只经 core.parseWorkspaceDocuments（V1 单文件主题／V2 一节点一份），
 *   CLI 不按目录自行猜测，也不维护第二套解析器；
 * - 文件哈希、字节数与文本都取自 storage 的同一次扫描，不把合成文本配真实哈希；
 * - V2 的节点正文版本是节点自己的文件哈希，不是 topic.md 的哈希。
 */
import {
  parseWorkspaceDocuments,
  type Diagnostic,
  type ParsedNode,
  type ParsedTopic,
  type WorkspaceGraph,
  type WorkspaceMeta,
} from "../core/index.js";
import {
  readWorkspaceFile,
  readWorkspaceFiles,
  resolveWorkspaceRoot,
  StorageError,
  type WorkspaceFile,
  type WorkspaceFiles,
} from "../storage/index.js";
import { CliError, EXIT_CODES } from "./errors.js";

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly files: WorkspaceFiles;
  /** workspace.json 的严格解析结果；不合法时为 null。 */
  readonly workspace: WorkspaceMeta | null;
  readonly schemaVersion: 1 | 2 | null;
  readonly ok: boolean;
  readonly topics: readonly TopicEntry[];
  readonly graph: WorkspaceGraph | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly filesByPath: ReadonlyMap<string, WorkspaceFile>;
  /** workspace.json 不是合法 JSON 时的原因；与 schema 错误分开报告。 */
  readonly workspaceJsonError: string | undefined;
}

export interface NodeEntry {
  readonly node: ParsedNode;
  /** 节点真实源文件：V2 为节点文件，V1 为所属主题文件。 */
  readonly path: string;
  readonly file: WorkspaceFile;
}

export interface TopicEntry {
  readonly topic: ParsedTopic;
  /** 主题入口文件：V2 的 topic.md／V1 的主题文件。 */
  readonly path: string;
  readonly dir: string | null;
  readonly sourcePaths: readonly string[];
  readonly nodes: readonly NodeEntry[];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** 真实磁盘扫描并做一次分组解析；不做缓存、不读快照。 */
export async function loadWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const rootReal = await resolveWorkspaceRoot(root);
  const files = await readWorkspaceFiles(rootReal);
  const filesByPath = new Map<string, WorkspaceFile>();
  for (const file of files.topics) filesByPath.set(file.path, file);
  filesByPath.set(files.workspaceFile.path, files.workspaceFile);

  let workspaceJsonError: string | undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(files.workspaceFile.text) as unknown;
  } catch (error) {
    workspaceJsonError = error instanceof Error ? error.message : String(error);
    raw = null;
  }

  const parse = parseWorkspaceDocuments({
    workspace: raw as WorkspaceMeta,
    documents: files.topics.map((file) => ({ path: file.path, text: file.text })),
  });

  // 主题内阅读顺序按全图派生结构顺序（core 已给出），不按文件名排序。
  const structureOrder = new Map<string, number>();
  for (const [index, node] of (parse.graph?.nodes ?? []).entries()) {
    structureOrder.set(node.id, index);
  }

  const topics: TopicEntry[] = parse.topics.map((topic) => {
    const ordered = [...topic.nodes].sort((left, right) => {
      const a = structureOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const b = structureOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (a !== b) return a - b;
      return left.id.localeCompare(right.id);
    });
    const nodes: NodeEntry[] = ordered.map((node) => {
      const path = normalizePath(node.sourcePath);
      const file = filesByPath.get(path);
      if (!file) {
        throw new CliError(
          "SOURCE_FILE_MISSING",
          `节点 ${node.id} 的源文件不在本次扫描结果中: ${path}`,
          EXIT_CODES.internal,
          { details: { nodeId: node.id, path, topicPath: node.topicPath } },
        );
      }
      return { node, path, file };
    });
    return {
      topic,
      path: normalizePath(topic.document.path),
      dir: topic.dir ?? null,
      sourcePaths: topic.sourcePaths.map(normalizePath),
      nodes,
    };
  });

  return {
    root: rootReal,
    files,
    // core 已用 workspaceMetaSchema 校验过；只有 ok 时才保留可用的身份对象。
    workspace: parse.ok ? (raw as WorkspaceMeta) : null,
    schemaVersion: parse.schemaVersion,
    ok: parse.ok,
    topics,
    graph: parse.ok ? (parse.graph ?? null) : null,
    diagnostics: parse.diagnostics,
    filesByPath,
    workspaceJsonError,
  };
}

export function findTopicById(snapshot: WorkspaceSnapshot, topicId: string): TopicEntry[] {
  return snapshot.topics.filter((entry) => entry.topic.topicId === topicId);
}

export function findTopicByDir(snapshot: WorkspaceSnapshot, dir: string): TopicEntry | undefined {
  const normalized = normalizePath(dir).replace(/^topics\//, "").replace(/\/$/, "");
  return snapshot.topics.find(
    (entry) => entry.dir === normalized || entry.path === normalizePath(dir),
  );
}

export function findNode(
  snapshot: WorkspaceSnapshot,
  nodeId: string,
): { topic: TopicEntry; entry: NodeEntry } | undefined {
  for (const topic of snapshot.topics) {
    const entry = topic.nodes.find((item) => item.node.id === nodeId);
    if (entry) return { topic, entry };
  }
  return undefined;
}

/** 按真实源路径找到节点（V2 节点文件／V1 主题文件内的节点）。 */
export function findNodeBySourcePath(
  snapshot: WorkspaceSnapshot,
  requested: string,
): { topic: TopicEntry; entry: NodeEntry } | undefined {
  const normalized = normalizePath(requested);
  for (const topic of snapshot.topics) {
    const entry = topic.nodes.find((item) => item.path === normalized);
    if (entry) return { topic, entry };
  }
  return undefined;
}

/** 按路径找到主题入口（topic.md／V1 主题文件）。 */
export function findTopicByPath(
  snapshot: WorkspaceSnapshot,
  requested: string,
): TopicEntry | undefined {
  const normalized = normalizePath(requested);
  return snapshot.topics.find((entry) => entry.path === normalized);
}

/** 读取一个真实磁盘文件；路径必须是工作区相对 POSIX 路径。 */
export async function readDiskFile(root: string, relativePath: string): Promise<WorkspaceFile> {
  if (
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new CliError(
      "PATH_OUTSIDE_WORKSPACE",
      `只接受工作区相对路径: ${relativePath}`,
      EXIT_CODES.usage,
      { details: { path: relativePath } },
    );
  }
  try {
    return await readWorkspaceFile(root, relativePath);
  } catch (error) {
    if (error instanceof StorageError && error.code === "INVALID_ARGUMENT") {
      throw new CliError("NOT_FOUND", `文件不存在: ${relativePath}`, EXIT_CODES.notFound, {
        details: { path: relativePath },
        cause: error,
      });
    }
    throw error;
  }
}

export function fileFacts(file: WorkspaceFile) {
  return {
    path: file.path,
    absolutePath: file.absolutePath,
    sha256: file.sha256,
    byteLength: file.byteLength,
  };
}

/** 主题入口文件（不是节点文件）。 */
export function topicEntryFile(
  snapshot: WorkspaceSnapshot,
  entry: TopicEntry,
): WorkspaceFile | undefined {
  return snapshot.filesByPath.get(entry.path);
}

export interface ValidationView {
  readonly ok: boolean;
  readonly graph: WorkspaceGraph | null;
  readonly diagnostics: readonly Diagnostic[];
  /** 解析失败时不返回“过滤坏文件后的全图”，避免虚报有效。 */
  readonly graphSkipped: boolean;
}

/** 离线校验完全依赖 core 的分组解析与全图校验。 */
export function validateSnapshot(snapshot: WorkspaceSnapshot): ValidationView {
  if (snapshot.workspaceJsonError !== undefined) {
    return { ok: false, graph: null, diagnostics: snapshot.diagnostics, graphSkipped: true };
  }
  if (!snapshot.ok || snapshot.graph === null) {
    return { ok: false, graph: null, diagnostics: snapshot.diagnostics, graphSkipped: true };
  }
  return {
    ok: true,
    graph: snapshot.graph,
    diagnostics: snapshot.diagnostics,
    graphSkipped: false,
  };
}

/** 主题摘要：真实文件事实 + 解析状态。 */
export function describeTopic(snapshot: WorkspaceSnapshot, entry: TopicEntry) {
  const file = topicEntryFile(snapshot, entry);
  return {
    topicId: entry.topic.topicId,
    title: entry.topic.title,
    schemaVersion: entry.topic.schemaVersion,
    path: entry.path,
    dir: entry.dir,
    ...(file
      ? { absolutePath: file.absolutePath, sha256: file.sha256, byteLength: file.byteLength }
      : {}),
    nodeCount: entry.nodes.length,
    sourcePaths: entry.sourcePaths,
    files: entry.sourcePaths.map((path) => {
      const source = snapshot.filesByPath.get(path);
      return source ? fileFacts(source) : { path, missing: true };
    }),
  };
}

/** 节点摘要：含真实源文件与哈希，正文不在列表里重复。 */
export function describeNode(topic: TopicEntry, entry: NodeEntry) {
  const { node } = entry;
  return {
    id: node.id,
    topicId: node.topicId,
    topicPath: node.topicPath,
    path: entry.path,
    title: node.title,
    summary: node.summary,
    summaryExplicit: node.summaryExplicit,
    state: node.state,
    flow: node.flow,
    from: node.from,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    ...(node.label !== undefined ? { label: node.label } : {}),
    schemaVersion: topic.topic.schemaVersion,
    fileHash: entry.file.sha256,
    byteLength: entry.file.byteLength,
  };
}