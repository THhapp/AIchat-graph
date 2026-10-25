/**
 * CLI 的只读工作区视图：真实磁盘扫描 + core 统一分组解析。
 *
 * - 主题分组只经 core.parseWorkspaceDocuments（当前格式：一节点一份 Markdown），
 *   CLI 不按目录自行猜测，也不维护第二套解析器；
 * - 文件哈希、字节数与文本都取自 storage 的同一次扫描，不把合成文本配真实哈希；
 * - 节点正文版本是节点自己的文件哈希，不是 topic.md 的哈希。
 */
import path from "node:path";
import {
  parseWorkspaceDocuments,
  type Diagnostic,
  type ParsedNode,
  type ParsedTopic,
  type WorkspaceGraph,
  type WorkspaceMeta,
} from "../core/index.js";
import {
  readWorkspaceFiles,
  resolveWorkspaceRoot,
  type WorkspaceFile,
  type WorkspaceFiles,
} from "../storage/index.js";
import type { ParsedArgs } from "./args.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT_CODES } from "./errors.js";

/**
 * 解析 --workspace；省略时使用当前目录，与生成的 AGENTS.md 里
 * "aichat read --topic <id>／aichat validate" 的简短写法一致。
 */
export async function workspaceRoot(parsed: ParsedArgs, ctx: CliContext): Promise<string> {
  const requested = parsed.values.get("workspace");
  const target = requested === undefined ? ctx.cwd : path.resolve(ctx.cwd, requested);
  return resolveWorkspaceRoot(target);
}

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly files: WorkspaceFiles;
  /** workspace.json 的严格解析结果；不合法时为 null。 */
  readonly workspace: WorkspaceMeta | null;
  readonly schemaVersion: 2 | null;
  readonly ok: boolean;
  readonly topics: readonly TopicEntry[];
  readonly graph: WorkspaceGraph | null;
  /** 有效图的 id→派生编号映射；图无效时为空，读侧显示 null。 */
  readonly nodeNumbers: ReadonlyMap<string, string>;
  readonly diagnostics: readonly Diagnostic[];
  readonly filesByPath: ReadonlyMap<string, WorkspaceFile>;
  /** workspace.json 不是合法 JSON 时的原因；与 schema 错误分开报告。 */
  readonly workspaceJsonError: string | undefined;
}

export interface NodeEntry {
  readonly node: ParsedNode;
  /** 节点真实源文件（节点自己的 Markdown 文件）。 */
  readonly path: string;
  readonly file: WorkspaceFile;
}

export interface TopicEntry {
  readonly topic: ParsedTopic;
  /** 主题入口文件：topic.md。 */
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

  // 编号只来自有效图；离线读取与主题清单共用同一映射。
  const nodeNumbers = new Map<string, string>();
  if (parse.ok) {
    for (const node of parse.graph?.nodes ?? []) nodeNumbers.set(node.id, node.number);
  }

  return {
    root: rootReal,
    files,
    // core 已用 workspaceMetaSchema 校验过；只有 ok 时才保留可用的身份对象。
    workspace: parse.ok ? (raw as WorkspaceMeta) : null,
    schemaVersion: parse.schemaVersion,
    ok: parse.ok,
    topics,
    graph: parse.ok ? (parse.graph ?? null) : null,
    nodeNumbers,
    diagnostics: parse.diagnostics,
    filesByPath,
    workspaceJsonError,
  };
}

export function findTopicById(snapshot: WorkspaceSnapshot, topicId: string): TopicEntry[] {
  return snapshot.topics.filter((entry) => entry.topic.topicId === topicId);
}

/** 主题定位符：稳定 topicId 或相对入口路径（也接受省略 topics/ 前缀）。 */
export function resolveTopicEntry(
  snapshot: WorkspaceSnapshot,
  locator: string,
): TopicEntry | undefined {
  if (/^t_[0-9a-f]{32}$/.test(locator)) return findTopicById(snapshot, locator)[0];
  return findTopicByPath(snapshot, locator) ?? findTopicByPath(snapshot, `topics/${locator}`);
}

/** 找不到主题时沿用 CLI 既有退出码 11，并带磁盘诊断。 */
export function requireTopicEntry(
  snapshot: WorkspaceSnapshot,
  locator: string,
): TopicEntry {
  const topic = resolveTopicEntry(snapshot, locator);
  if (topic !== undefined) return topic;
  const isTopicId = /^t_[0-9a-f]{32}$/.test(locator);
  throw new CliError(
    isTopicId ? "TOPIC_NOT_FOUND" : "NOT_FOUND",
    `找不到主题: ${locator}`,
    EXIT_CODES.notFound,
    {
      details: {
        locator,
        schemaVersion: snapshot.schemaVersion,
        diagnostics: snapshot.diagnostics.slice(0, 20),
      },
    },
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

/** 按路径找到主题入口（topic.md）。 */
export function findTopicByPath(
  snapshot: WorkspaceSnapshot,
  requested: string,
): TopicEntry | undefined {
  const normalized = normalizePath(requested);
  return snapshot.topics.find((entry) => entry.path === normalized);
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

/** 主题摘要：身份、入口路径与节点数；文件事实与节点清单不在此重复。 */
export function describeTopic(entry: TopicEntry) {
  return {
    topicId: entry.topic.topicId,
    title: entry.topic.title,
    schemaVersion: entry.topic.schemaVersion,
    path: entry.path,
    dir: entry.dir,
    nodeCount: entry.nodes.length,
  };
}

/**
 * 主题概览里的节点清单：只保留清单需要的字段。
 * 主题身份与入口文件在主题对象里，不在每个节点上重复。
 */
export function describeNode(
  entry: NodeEntry,
  nodeNumbers: ReadonlyMap<string, string>,
) {
  const { node } = entry;
  return {
    id: node.id,
    number: nodeNumbers.get(node.id) ?? null,
    title: node.title,
    summary: node.summary,
    state: node.state,
    flow: node.flow,
    from: node.from,
    important: node.important,
    // 连接文字只读 description；没有就省略。
    ...(node.description !== undefined ? { description: node.description } : {}),
    path: entry.path,
    fileHash: entry.file.sha256,
  };
}
