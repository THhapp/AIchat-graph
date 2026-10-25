/** 快照与真实磁盘详情的传输组装；不改变发布版本或源文件。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkspaceDocuments } from "../../core/index.js";
import { readWorkspaceFiles, StorageError } from "../../storage/index.js";
import { captureResources } from "../../export/index.js";
import type {
  Diagnostic,
  GraphNode,
  GraphResponse,
  NodeDetailResponse,
  TopicDetailResponse,
  TopicNodeDetail,
  WorkspaceResponse,
  NodeFlow as ThreadFlow,
  NodeState as ThreadState,
} from "../../shared/protocol.js";
import {
  ServiceError,
  toWireDiagnostic,
  toWireStorageDiagnostic,
  wireDiagnostic,
} from "../errors.js";
import { combinedHash, graphNodes, graphTopics, type SnapshotData } from "../snapshot.js";
import type { WorkspaceRuntime } from "../workspace.js";

function runtimeAgentEntry(): { cliPath: string; skillPath: string } {
  const appRoot = fileURLToPath(new URL("../../../", import.meta.url));
  return {
    cliPath: path.join(appRoot, "dist", "cli", "index.js"),
    skillPath: path.join(appRoot, "skills", "aichat-graph", "SKILL.md"),
  };
}

export function workspaceResponse(runtime: WorkspaceRuntime): WorkspaceResponse {
  return {
    ...runtime.snapshotVersion(),
    workspaceId: runtime.workspaceId,
    name: runtime.current.data.name,
    rootPath: runtime.rootReal,
    topicMode: runtime.current.data.topicMode ?? "shared",
    agentEntry: runtimeAgentEntry(),
    activeNode: runtime.current.data.graph.activeNode,
    stale: runtime.stale,
    diagnostics: runtime.diagnostics,
  };
}

export function graphResponse(runtime: WorkspaceRuntime): GraphResponse {
  return {
    topicMode: runtime.current.data.topicMode ?? "shared",
    ...runtime.snapshotVersion(),
    workspaceId: runtime.workspaceId,
    activeNode: runtime.current.data.graph.activeNode,
    stale: runtime.stale,
    diagnostics: runtime.diagnostics,
    nodes: graphNodes(runtime.current.data),
    topics: graphTopics(runtime.current.data),
    ...(Object.keys(runtime.lastChanges).length === 0
      ? {}
      : { lastChanges: runtime.lastChanges }),
  };
}

/** 图节点 → 传输 DTO；description 是格式 2 的来源说明，label 仅格式 1 兼容。 */
function toWireNode(node: SnapshotData["graph"]["nodes"][number]): GraphNode {
  return {
    id: node.id,
    topicId: node.topicId,
    title: node.title,
    summary: node.summary,
    number: node.number,
    from: node.from,
    flow: node.flow,
    state: node.state,
    important: node.important,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    ...(node.description === undefined && node.label !== undefined ? { label: node.label } : {}),
    sourcePath: node.sourcePath,
  };
}

/** 磁盘主题详情里出现、但当前快照没有的节点：number 留空，不借用别的节点编号。 */
function fallbackNode(node: {
  id: string;
  topicId: string;
  title: string;
  summary: string;
  state: ThreadState;
  flow: ThreadFlow;
  from: string | null;
  important: boolean;
  description?: string | undefined;
  side?: "left" | "right" | undefined;
  order?: number | undefined;
  label?: string | undefined;
  sourcePath?: string | undefined;
}): GraphNode {
  return {
    id: node.id,
    topicId: node.topicId,
    title: node.title,
    summary: node.summary,
    number: "",
    from: node.from,
    flow: node.flow,
    state: node.state,
    important: node.important,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    ...(node.description === undefined && node.label !== undefined ? { label: node.label } : {}),
    ...(node.sourcePath !== undefined ? { sourcePath: node.sourcePath } : {}),
  };
}

export function nodeDetail(
  runtime: WorkspaceRuntime,
  snapshot: SnapshotData,
  nodeId: string,
): NodeDetailResponse {
  const node = snapshot.graph.nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) {
    throw new ServiceError(404, "NOT_FOUND", "当前快照中没有节点 " + nodeId, {
      details: { nodeId },
    });
  }
  const topic = snapshot.topics.find((entry) => entry.topicId === node.topicId);
  if (topic === undefined) {
    throw new ServiceError(404, "NOT_FOUND", "节点来源主题不在当前快照中", {
      details: { nodeId, topicId: node.topicId },
    });
  }
  const source = topic.files.find((file) => file.path === node.sourcePath);
  if (source === undefined) {
    throw new ServiceError(404, "NOT_FOUND", "节点真实源文件不在当前快照中", {
      details: { nodeId, sourcePath: node.sourcePath },
    });
  }
  return {
    ...runtime.snapshotVersion(),
    node: toWireNode(node),
    body: node.body,
    topicId: node.topicId,
    // 节点正文的版本是它自己的真实源文件，不是 topic.md 的哈希。
    path: source.path,
    fileHash: source.fileHash,
  };
}

export function snapshotTopicDetail(
  runtime: WorkspaceRuntime,
  snapshot: SnapshotData,
  topicId: string,
): TopicDetailResponse {
  const topic = snapshot.topics.find((entry) => entry.topicId === topicId);
  if (topic === undefined) {
    throw new ServiceError(404, "NOT_FOUND", "当前快照中没有主题 " + topicId, {
      details: { topicId },
    });
  }
  const graphNodeById = new Map(snapshot.graph.nodes.map((node) => [node.id, node]));
  const fileHashByPath = new Map(topic.files.map((file) => [file.path, file.fileHash]));
  const nodes: TopicNodeDetail[] = topic.nodes.map((parsed) => {
    const view = graphNodeById.get(parsed.id);
    return {
      ...(view === undefined ? fallbackNode(parsed) : toWireNode(view)),
      body: parsed.body,
      path: parsed.sourcePath,
      fileHash: fileHashByPath.get(parsed.sourcePath) ?? "",
    };
  });
  const graphView = snapshot.graph.topics.find((entry) => entry.topicId === topicId);
  return {
    ...runtime.snapshotVersion(),
    source: "snapshot",
    valid: true,
    topic: {
      id: topic.topicId,
      title: topic.title,
      path: topic.path,
      nodeIds: graphView ? [...graphView.nodeIds] : topic.nodes.map((node) => node.id),
      fileHash: topic.fileHash,
      contentHash: topic.contentHash,
    },
    // V2 的 raw 只是主题入口（topic.md）；完整阅读按 nodes 里的真实文件。
    raw: topic.raw,
    fileHash: topic.fileHash,
    nodes,
    diagnostics: [...topic.resourceDiagnostics],
    resources: topic.resources,
  } as TopicDetailResponse;
}

/**
 * 不带宽度的主题详情：读取真实磁盘字节。
 * 成功时 raw、fileHash 与 nodes 都来自这一次读取；失败时 valid=false、
 * nodes 为空并给出解析诊断，绝不把旧快照正文配上新磁盘哈希。
 */
export async function diskTopicDetail(
  runtime: WorkspaceRuntime,
  topicId: string,
): Promise<TopicDetailResponse> {
  const known = runtime.current.data.topics.find((entry) => entry.topicId === topicId);
  // 磁盘详情按一次完整扫描分组解析：V2 一个主题是多份真实文件，不能只读 topic.md。
  let scanned;
  try {
    scanned = await readWorkspaceFiles(runtime.rootReal);
  } catch (error) {
    if (error instanceof StorageError) {
      throw new ServiceError(422, "VALIDATION_FAILED", "无法读取工作区：" + error.message, {
        diagnostics: [wireDiagnostic(error.code, error.message, error.path)],
        details: { topicId },
      });
    }
    throw error;
  }
  const parsedWorkspace = parseWorkspaceDocuments({
    workspace: {
      schemaVersion: scanned.workspace.schemaVersion,
      ...(scanned.workspace.topicMode !== undefined ? { topicMode: scanned.workspace.topicMode } : {}),
      workspaceId: scanned.workspace.workspaceId,
      name: scanned.workspace.name,
      activeNode: scanned.workspace.activeNode,
    },
    documents: scanned.topics.map((file) => ({ path: file.path, text: file.text })),
  });
  const diagnostics: Diagnostic[] = [
    ...scanned.diagnostics.map((item) => toWireStorageDiagnostic(item, "warning")),
    ...parsedWorkspace.diagnostics.map(toWireDiagnostic),
  ];
  const parsedTopic = parsedWorkspace.topics.find((entry) => entry.topicId === topicId);
  const entryPath = known?.path ?? parsedTopic?.document.path;
  if (entryPath === undefined) {
    throw new ServiceError(404, "NOT_FOUND", "磁盘上找不到主题 " + topicId, {
      details: { topicId },
    });
  }
  const entryFile = scanned.topics.find((file) => file.path === entryPath);
  if (entryFile === undefined) {
    return {
      ...runtime.snapshotVersion(),
      source: "disk",
      valid: false,
      topic: { id: topicId, title: known?.title ?? "", path: entryPath, nodeIds: [], fileHash: "" },
      raw: "",
      fileHash: "",
      nodes: [],
      diagnostics: [
        ...diagnostics,
        wireDiagnostic("TOPIC_META_MISSING", "主题入口文件已不存在", entryPath),
      ],
    };
  }

  if (parsedTopic === undefined) {
    return {
      ...runtime.snapshotVersion(),
      source: "disk",
      valid: false,
      topic: {
        id: topicId,
        title: known?.title ?? "",
        path: entryPath,
        nodeIds: [],
        fileHash: entryFile.sha256,
      },
      raw: entryFile.text,
      fileHash: entryFile.sha256,
      nodes: [],
      diagnostics,
    };
  }

  if (parsedTopic.topicId !== topicId) {
    diagnostics.push(
      wireDiagnostic(
        "TOPIC_ID_CHANGED",
        "磁盘主题的 topicId 已变为 " + parsedTopic.topicId + "（请求的是 " + topicId + "）",
        entryPath,
        "warning",
      ),
    );
  }
  const graphNodeById = new Map(runtime.current.data.graph.nodes.map((node) => [node.id, node]));
  const fileHashByPath = new Map(
    scanned.topics.map((file) => [file.path, file.sha256] as const),
  );
  // 磁盘详情按图的派生结构顺序排列，而不是文件名顺序；同版本的完整阅读顺序才可比较。
  const orderedNodeIds: string[] = [];
  for (const view of runtime.current.data.graph.nodes) {
    if (view.topicId === topicId && parsedTopic.nodes.some((node) => node.id === view.id)) {
      orderedNodeIds.push(view.id);
    }
  }
  for (const node of parsedTopic.nodes) {
    if (!orderedNodeIds.includes(node.id)) orderedNodeIds.push(node.id);
  }
  const parsedById = new Map(parsedTopic.nodes.map((node) => [node.id, node]));
  const nodes: TopicNodeDetail[] = [];
  for (const nodeId of orderedNodeIds) {
    const node = parsedById.get(nodeId);
    if (node === undefined) continue;
    const view = graphNodeById.get(node.id);
    const wire =
      view === undefined
        ? fallbackNode(node)
        : { ...toWireNode(view), number: view.number };
    nodes.push({
      ...wire,
      number: wire.number,
      body: node.body,
      path: node.sourcePath,
      fileHash: fileHashByPath.get(node.sourcePath) ?? "",
    });
  }

  // 与快照路径保持一致：始终交给 export 的 AST 捕获（含引用式图片），
  // 不再用正则门控，避免 disk 详情与 snapshot 详情资源集合不同。
  const resources: Record<string, string> = {};
  const resourceDiagnostics: Diagnostic[] = [];
  try {
    const capture = await captureResources(
      runtime.rootReal,
      parsedTopic.nodes.map((node) => ({ id: node.id, path: node.sourcePath, body: node.body })),
    );
    Object.assign(resources, capture.resources);
    resourceDiagnostics.push(...capture.diagnostics);
  } catch (error) {
    resourceDiagnostics.push(
      wireDiagnostic(
        "RESOURCE_CAPTURE_FAILED",
        "捕获主题资源失败：" + (error instanceof Error ? error.message : String(error)),
        entryPath,
      ),
    );
  }
  diagnostics.push(...resourceDiagnostics);

  const contentHash = combinedHash(
    "topic:" + parsedTopic.topicId,
    [...fileHashByPath.entries()].filter(([path_]) => parsedTopic.sourcePaths.includes(path_)),
  );

  return {
    ...runtime.snapshotVersion(),
    source: "disk",
    valid: true,
    topic: {
      id: parsedTopic.topicId,
      title: parsedTopic.title,
      path: entryPath,
      nodeIds: parsedTopic.nodes.map((node) => node.id),
      fileHash: entryFile.sha256,
      contentHash,
    },
    raw: entryFile.text,
    fileHash: entryFile.sha256,
    nodes,
    diagnostics,
    resources,
  } as TopicDetailResponse;
}
