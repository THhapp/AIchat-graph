import type { GraphNode, GraphResponse, GraphTopic, WorkspaceResponse } from '../../next/protocol.js';

export interface LocateContext {
  workspace: WorkspaceResponse | null;
  graph: GraphResponse;
  topic: GraphTopic | null;
  node: GraphNode;
}

/**
 * Stable locator for the card on screen. It carries the persistent domain IDs,
 * the node/topic revisions and the service entry paths only: no body text, no
 * source file path or hash, nothing from another topic. Anything the service does
 * not actually provide is stated as missing instead of being filled in.
 */
export function buildLocateText(context: LocateContext): string {
  const { workspace, graph, topic, node } = context;
  const activeTopic = topic?.id === node.topicId ? topic : null;
  const lines: string[] = [];
  lines.push('工作区：' + (workspace?.name ?? graph.workspaceId) + '  workspaceId=' + graph.workspaceId);
  lines.push('主题：' + (activeTopic?.title ?? node.topicId) + '  topicId=' + node.topicId + (activeTopic !== null ? '  r' + String(activeTopic.revision) : ''));
  lines.push('节点：' + node.number + ' ' + node.title + '  nodeId=' + node.id + '  revision=' + String(node.revision));
  lines.push('快照：' + graph.instanceId + ' / r' + String(graph.revision));
  const entry = workspace?.agentEntry;
  if (entry !== undefined) {
    lines.push('CLI：' + entry.cliPath + '   Skill：' + entry.skillPath);
  } else {
    // No path is invented: the reader can only say which version to use.
    lines.push('CLI：使用与本服务同版本的入口   Skill：使用与本服务同版本的入口');
  }
  lines.push('当前：' + node.number + ' ' + node.title + (node.important ? ' · 重要' : ''));
  return lines.join('\n');
}
