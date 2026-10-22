import type { GraphNode, GraphResponse, GraphTopic, WorkspaceResponse } from '../../shared/protocol.js';

export interface ContinuationContext {
  workspace: WorkspaceResponse | null;
  graph: GraphResponse;
  topic: GraphTopic | null;
  node: GraphNode | null;
}

/**
 * Builds a copyable instruction. It deliberately points at source files and IDs
 * instead of pasting rendered body text, and never claims a write happened.
 */
export function buildContinuationPrompt(context: ContinuationContext): string {
  const { workspace, graph, topic, node } = context;
  const lines: string[] = [];
  const name = workspace?.name ?? graph.workspaceId;
  lines.push('继续讨论《' + (topic?.title ?? '当前主题') + '》' + (node ? ' · ' + node.number + ' ' + node.title : ''));
  lines.push('');
  lines.push('工作区：' + name + (workspace ? '（' + workspace.rootPath + '）' : ''));
  lines.push('当前快照：' + graph.instanceId + ' / r' + String(graph.revision) + (graph.stale ? '（磁盘内容当前无效，阅读的是上一份有效内容）' : ''));
  if (graph.activeNode !== null) {
    const active = graph.nodes.find((candidate) => candidate.id === graph.activeNode);
    lines.push('activeNode：' + graph.activeNode + (active ? '（' + active.number + ' ' + active.title + '）' : ''));
  } else {
    lines.push('activeNode：（未设置）');
  }
  if (topic) {
    lines.push('主题：' + topic.title + ' · ' + topic.id + ' · 文件 ' + topic.path + ' · fileHash ' + topic.fileHash);
  }
  if (node) {
    lines.push(
      '节点：' + node.number + ' ' + node.title + ' · ' + node.id +
        ' · state=' + node.state + ' · flow=' + node.flow + (node.from ? ' · from=' + node.from : ''),
    );
  }
  lines.push('');
  lines.push('读取指引：');
  lines.push('1. 直接读取上述主题文件与工作区 workspace.json，并以文件真实字节哈希为准；界面快照可能来自上一份有效内容。');
  lines.push('2. 需要完整上下文时按主题读取整份文件，按文件顺序阅读所有卡片；结构顺序以 from／flow 为准。');
  lines.push('3. 回答先说明你是从源文件还是快照读取，再继续讨论；需要修改时走受控变更流程，不手动覆盖未核对哈希的文件。');
  return lines.join('\n');
}
