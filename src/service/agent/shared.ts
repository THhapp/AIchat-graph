/** 读取与编译共用的快照查找工具；不读取磁盘。 */
import type { ParsedNode } from "../../core/index.js";
import type { SnapshotData, TopicSnapshot } from "../snapshot.js";

/** 在有效快照里按节点 ID 找到解析节点、其主题、图视图与真实源文件哈希。 */
export function findParsedNode(snapshot: SnapshotData, nodeId: string): {
  node: ParsedNode;
  topic: TopicSnapshot;
  view: SnapshotData["graph"]["nodes"][number];
  fileHash: string;
} | null {
  const view = snapshot.graph.nodes.find((entry) => entry.id === nodeId);
  if (view === undefined) return null;
  const topic = snapshot.topics.find((entry) => entry.topicId === view.topicId);
  if (topic === undefined) return null;
  const node = topic.nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) return null;
  const file = topic.files.find((entry) => entry.path === node.sourcePath);
  return { node, topic, view, fileHash: file?.fileHash ?? "" };
}
