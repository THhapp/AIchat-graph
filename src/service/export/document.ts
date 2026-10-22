/** 从一份有效快照组装主题成品数据，不读盘、不改配置或发布状态。 */
import { computeContentFingerprint } from "../../export/index.js";
import type { GraphNode, OfflineTopicDocument } from "../../shared/protocol.js";
import { graphTopic, toGraphNode, type SnapshotData, type TopicSnapshot } from "../snapshot.js";
import { ServiceError } from "../errors.js";

export function buildTopicDocument(
  snapshot: SnapshotData,
  topicId: string,
  instanceId: string,
  revision: number,
): OfflineTopicDocument {
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
    instanceId: instanceId,
    revision: revision,
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
