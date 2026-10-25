/**
 * 有效快照的数据结构、构建与差异计算。
 *
 * 快照保存与图同一版本的源原文、节点正文、真实源文件哈希与主题级 contentHash；
 * 详情、agent read、检索与导出都从这里取数，不能把旧正文配上新磁盘哈希。
 * 本模块不读文件、不发布事件；资源捕获由调用方（load.ts）完成并传入。
 */
import { sha256Bytes } from "../storage/index.js";
import { buildIndex } from "../index/index.js";
import type { BuiltIndex, IndexTopicSource, SearchIndex } from "../index/index.js";
import type {
  Diagnostic,
  GraphNode,
  GraphTopic,
  NodeState,
  BranchSide,
  NodeFlow,
} from "../shared/protocol.js";
import type {
  ParsedNode,
  ParsedTopic,
  SupportedSchemaVersion,
  WorkspaceGraph,
  WorkspaceMeta,
} from "../core/index.js";
import type { WorkspaceFile } from "../storage/index.js";

/** 一份真实源文件在快照中的冻结副本；raw 与该 fileHash 必须来自同一次扫描。 */
export interface SnapshotSourceFile {
  readonly path: string;
  readonly fileHash: string;
  readonly raw: string;
}

/** 已捕获的资源文件事实（供指纹与导出核对；dataUri 只放 resources）。 */
export interface SnapshotResourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

export interface TopicSnapshot {
  readonly topicId: string;
  readonly title: string;
  /** 主题入口文件（V2 为 topic.md；V1 为该主题文件）。 */
  readonly path: string;
  /** 与 raw 对应的磁盘原始字节 SHA-256。 */
  readonly fileHash: string;
  readonly raw: string;
  /** 该主题全部真实源文件（含入口），按路径稳定排序。 */
  readonly files: readonly SnapshotSourceFile[];
  /** 该主题全部源文件的合并哈希；任何节点文件变化都会改变它。 */
  readonly contentHash: string;
  /** 按源文件顺序（V2 按目录＋路径，V1 按正文顺序）。 */
  readonly nodes: readonly ParsedNode[];
  /** 已解析资源键（Markdown 中出现的引用）→ data URI。 */
  readonly resources: Record<string, string>;
  readonly resourceFiles: readonly SnapshotResourceFile[];
  readonly resourceDiagnostics: readonly Diagnostic[];
}

/** 一份已验证、可发布的图与内容。 */
export interface SnapshotData {
  readonly workspaceId: string;
  readonly name: string;
  readonly schemaVersion: SupportedSchemaVersion;
  readonly topicMode?: "isolated" | "shared";
  readonly activeNode: string | null;
  readonly workspaceHash: string;
  readonly graph: WorkspaceGraph;
  readonly topics: readonly TopicSnapshot[];
  readonly manifest: BuiltIndex["manifest"];
  readonly search: SearchIndex;
  /** workspace.json、全部源文件与资源的哈希；用于识别"内容未变"。 */
  readonly fingerprint: string;
  readonly generatedAt: string;
}

export interface TopicInput {
  readonly parsed: ParsedTopic;
  /** 该主题的全部扫描文件（含 entry）。 */
  readonly files: readonly WorkspaceFile[];
  readonly resources: Record<string, string>;
  readonly resourceFiles: readonly SnapshotResourceFile[];
  readonly resourceDiagnostics: readonly Diagnostic[];
}

/** 合并一组 (path, hash) 事实；顺序无关，任何字节变化都会改变结果。 */
export function combinedHash(prefix: string, entries: readonly (readonly [string, string])[]): string {
  const lines = entries
    .map(([path, hash]) => path + ":" + hash)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return sha256Bytes(prefix + "\n" + lines.join("\n"));
}

export function fingerprintOf(input: {
  workspaceHash: string;
  files: readonly (readonly [string, string])[];
  resources: readonly (readonly [string, string])[];
}): string {
  return combinedHash("workspace.json:" + input.workspaceHash, [
    ...input.files,
    ...input.resources.map(([path, hash]) => ["resource:" + path, hash] as const),
  ]);
}

/** 构造主题的源文件事实（按路径排序，入口在首位以保证稳定）。 */
function topicFiles(parsed: ParsedTopic, files: readonly WorkspaceFile[]): SnapshotSourceFile[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const entry = byPath.get(parsed.document.path);
  const ordered: SnapshotSourceFile[] = [];
  if (entry !== undefined) {
    ordered.push({ path: entry.path, fileHash: entry.sha256, raw: entry.text });
  }
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    if (file.path === parsed.document.path) continue;
    ordered.push({ path: file.path, fileHash: file.sha256, raw: file.text });
  }
  return ordered;
}

export function buildSnapshot(input: {
  workspace: WorkspaceMeta;
  workspaceHash: string;
  topics: readonly TopicInput[];
  graph: WorkspaceGraph;
}): SnapshotData {
  const topicSnapshots: TopicSnapshot[] = input.topics.map((entry) => {
    const files = topicFiles(entry.parsed, entry.files);
    return {
      topicId: entry.parsed.topicId,
      title: entry.parsed.title,
      path: entry.parsed.document.path,
      fileHash: files[0]?.fileHash ?? "",
      raw: files[0]?.raw ?? entry.parsed.document.text,
      files,
      contentHash: combinedHash("topic:" + entry.parsed.topicId, files.map((file) => [file.path, file.fileHash] as const)),
      nodes: entry.parsed.nodes,
      resources: entry.resources,
      resourceFiles: entry.resourceFiles,
      resourceDiagnostics: entry.resourceDiagnostics,
    };
  });

  const indexTopics: IndexTopicSource[] = topicSnapshots.map((topic) => {
    const source: IndexTopicSource & {
      fileHashes?: Record<string, string>;
      sourcePaths?: readonly string[];
      schemaVersion?: SupportedSchemaVersion;
    } = {
      topicId: topic.topicId,
      title: topic.title,
      path: topic.path,
      fileHash: topic.fileHash,
      raw: topic.raw,
      nodes: topic.nodes,
      fileHashes: Object.fromEntries(topic.files.map((file) => [file.path, file.fileHash])),
      sourcePaths: topic.files.map((file) => file.path),
      schemaVersion: input.workspace.schemaVersion,
    };
    return source;
  });

  const built = buildIndex({
    workspaceId: input.workspace.workspaceId,
    graph: input.graph,
    topics: indexTopics,
  });

  const allFiles: Array<readonly [string, string]> = [];
  for (const topic of topicSnapshots) {
    for (const file of topic.files) allFiles.push([file.path, file.fileHash]);
  }
  const allResources: Array<readonly [string, string]> = [];
  for (const topic of topicSnapshots) {
    for (const file of topic.resourceFiles) allResources.push([file.path, file.sha256]);
  }

  return {
    workspaceId: input.workspace.workspaceId,
    name: input.workspace.name,
    schemaVersion: input.workspace.schemaVersion,
    topicMode: input.workspace.topicMode ?? "shared",
    activeNode: input.workspace.activeNode,
    workspaceHash: input.workspaceHash,
    graph: input.graph,
    topics: topicSnapshots,
    manifest: built.manifest,
    search: built.search,
    fingerprint: fingerprintOf({
      workspaceHash: input.workspaceHash,
      files: allFiles,
      resources: allResources,
    }),
    generatedAt: new Date().toISOString(),
  };
}

/** 首次启动且没有任何有效内容时的空展示；它不是"有效快照"，由调用方标 stale。 */
export function emptySnapshot(
  workspaceId: string,
  name: string,
  schemaVersion: SupportedSchemaVersion = 2,
  topicMode: "isolated" | "shared" = "shared",
): SnapshotData {
  const graph: WorkspaceGraph = {
    workspaceId,
    name,
    activeNode: null,
    rootId: null,
    rootIds: [],
    topics: [],
    nodes: [],
  };
  const built = buildIndex({ workspaceId, graph, topics: [] });
  return {
    workspaceId,
    name,
    schemaVersion,
    topicMode,
    activeNode: null,
    workspaceHash: "",
    graph,
    topics: [],
    manifest: built.manifest,
    search: built.search,
    fingerprint: "",
    generatedAt: new Date().toISOString(),
  };
}

export function findTopic(snapshot: SnapshotData, topicId: string): TopicSnapshot | undefined {
  return snapshot.topics.find((topic) => topic.topicId === topicId);
}

/** 节点真实源文件的冻结副本；V1 与主题入口相同。 */
export function sourceFileOf(snapshot: SnapshotData, nodeId: string): SnapshotSourceFile | undefined {
  const node = snapshot.graph.nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) return undefined;
  const topic = snapshot.topics.find((entry) => entry.topicId === node.topicId);
  return topic?.files.find((file) => file.path === node.sourcePath);
}

export function toGraphNode(node: WorkspaceGraph["nodes"][number]): GraphNode {
  const described = node.description !== undefined ? { description: node.description } : {};
  return {
    id: node.id,
    topicId: node.topicId,
    title: node.title,
    summary: node.summary,
    number: node.number,
    from: node.from,
    flow: node.flow as NodeFlow,
    state: node.state as NodeState,
    important: node.important,
    ...described,
    ...(node.side !== undefined ? { side: node.side as BranchSide } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    // label 仅格式 1 兼容；格式 2 的来源说明走 description。
    ...(node.description === undefined && node.label !== undefined ? { label: node.label } : {}),
    sourcePath: node.sourcePath,
  };
}

export function graphTopic(snapshot: SnapshotData, topic: TopicSnapshot): GraphTopic {
  const view = snapshot.graph.topics.find((entry) => entry.topicId === topic.topicId);
  return {
    id: topic.topicId,
    title: topic.title,
    path: topic.path,
    nodeIds: view ? [...view.nodeIds] : topic.nodes.map((node) => node.id),
    fileHash: topic.fileHash,
    contentHash: topic.contentHash,
  };
}

export function graphNodes(snapshot: SnapshotData): GraphNode[] {
  return snapshot.graph.nodes.map(toGraphNode);
}

export function graphTopics(snapshot: SnapshotData): GraphTopic[] {
  return snapshot.topics.map((topic) => graphTopic(snapshot, topic));
}

function nodeSignature(node: ParsedNode): string {
  return JSON.stringify([
    node.topicId,
    node.sourcePath,
    node.title,
    node.body,
    node.summary,
    node.state,
    node.from,
    node.flow,
    node.description ?? null,
    node.side ?? null,
    node.order ?? null,
    node.important,
    node.label ?? null,
  ]);
}

export function diffSnapshots(
  previous: SnapshotData,
  next: SnapshotData,
): { changedTopicIds: string[]; changedNodeIds: string[] } {
  const changedTopicIds: string[] = [];
  const previousTopics = new Map(previous.topics.map((topic) => [topic.topicId, topic]));
  const nextTopics = new Map(next.topics.map((topic) => [topic.topicId, topic]));
  for (const topic of next.topics) {
    const before = previousTopics.get(topic.topicId);
    if (
      !before ||
      before.contentHash !== topic.contentHash ||
      before.contentHash.length === 0 ||
      before.resourceFiles.length !== topic.resourceFiles.length ||
      before.files.some((file, index) => topic.files[index]?.fileHash !== file.fileHash)
    ) {
      changedTopicIds.push(topic.topicId);
    }
  }
  for (const topic of previous.topics) {
    if (!nextTopics.has(topic.topicId)) changedTopicIds.push(topic.topicId);
  }

  const previousNodes = new Map(previous.graph.nodes.map((node) => [node.id, nodeSignature(node)]));
  const nextNodes = new Map(next.graph.nodes.map((node) => [node.id, nodeSignature(node)]));
  const changedNodeIds: string[] = [];
  for (const node of next.graph.nodes) {
    const before = previousNodes.get(node.id);
    if (before === undefined || before !== nextNodes.get(node.id)) changedNodeIds.push(node.id);
  }
  for (const nodeId of previousNodes.keys()) {
    if (!nextNodes.has(nodeId)) changedNodeIds.push(nodeId);
  }
  return { changedTopicIds, changedNodeIds };
}