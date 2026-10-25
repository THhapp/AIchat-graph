/**
 * 从已验证的图与主题原文构建 manifest 与进程内检索索引。
 * 本模块只处理内存数据：不读文件、不写缓存、不发布快照。
 */
import type { WorkspaceGraph } from "../core/index.js";
import {
  INDEX_FORMAT,
  type BuiltIndex,
  type IndexManifest,
  type IndexSource,
  type ManifestLink,
  type ManifestNode,
  type ManifestTopic,
  type SearchDocument,
  type SearchIndex,
} from "./types.js";

function manifestNodeOf(graph: WorkspaceGraph): ManifestNode[] {
  return graph.nodes.map((node) => ({
    id: node.id,
    topicId: node.topicId,
    topicPath: node.topicPath,
    sourcePath: node.sourcePath,
    title: node.title,
    summary: node.summary,
    ...(node.description !== undefined ? { description: node.description } : {}),
    state: node.state,
    flow: node.flow,
    from: node.from,
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    number: node.number,
    nextId: node.nextId,
    branchIds: node.branchIds,
  }));
}

/**
 * 构建 manifest。fileHash 与 raw 都由调用方从同一次扫描传入，
 * 索引不自行读取磁盘，也不把正文写入 manifest。
 */
export function buildIndex(source: IndexSource): BuiltIndex {
  const { graph } = source;
  const topicHash = new Map<string, string>();
  const documents: SearchDocument[] = [];
  const fileHashes: Record<string, string> = {};
  const topicByPath = new Map<string, string>();

  const topicHashes = new Map<string, Readonly<Record<string, string>>>();
  const topicPaths = new Map<string, readonly string[]>();

  for (const topic of source.topics) {
    topicHash.set(topic.topicId, topic.fileHash);
    topicByPath.set(topic.path, topic.topicId);
    const hashes: Record<string, string> = { ...(topic.fileHashes ?? {}) };
    // 入口文件的真实哈希优先于调用方给的映射，避免两个来源不一致。
    hashes[topic.path] = topic.fileHash;
    topicHashes.set(topic.topicId, hashes);
    topicPaths.set(topic.topicId, topic.sourcePaths ?? [topic.path]);
    for (const [path, hash] of Object.entries(hashes)) fileHashes[path] = hash;
    for (const node of topic.nodes) {
      documents.push({
        id: node.id,
        topicId: topic.topicId,
        title: node.title,
        summary: node.summary,
        number: graph.nodes.find((entry) => entry.id === node.id)?.number ?? "",
        path: node.sourcePath,
        body: node.body,
      });
    }
  }

  const nodeOrder = new Map<string, number>();
  graph.nodes.forEach((node, index) => nodeOrder.set(node.id, index));
  // 主题原文顺序可能包含重复或未知节点；按图节点顺序稳定排列检索文档。
  documents.sort(
    (left, right) => (nodeOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (nodeOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );

  const topics: ManifestTopic[] = graph.topics.map((topic) => ({
    topicId: topic.topicId,
    title: topic.title,
    path: topic.path,
    fileHash: topicHash.get(topic.topicId) ?? "",
    sourcePaths: topicPaths.get(topic.topicId) ?? [topic.path],
    fileHashes: topicHashes.get(topic.topicId) ?? { [topic.path]: topicHash.get(topic.topicId) ?? "" },
    nodeIds: [...topic.nodeIds],
  }));

  const links: ManifestLink[] = [];
  const backlinks: Record<string, string[]> = {};
  for (const node of graph.nodes) {
    if (node.from === null) continue;
    links.push({ from: node.from, to: node.id, flow: node.flow === "branch" ? "branch" : "next" });
    const children = backlinks[node.from];
    if (children) children.push(node.id);
    else backlinks[node.from] = [node.id];
  }

  const manifest: IndexManifest = {
    format: INDEX_FORMAT,
    workspaceId: source.workspaceId,
    generatedAt: source.generatedAt ?? new Date().toISOString(),
    fileHashes,
    topics,
    nodes: manifestNodeOf(graph),
    links,
    backlinks,
    roots: [...graph.rootIds],
  };

  const search: SearchIndex = {
    format: INDEX_FORMAT,
    workspaceId: source.workspaceId,
    documents,
  };

  return { manifest, search };
}