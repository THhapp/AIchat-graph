import type { GraphNode, GraphResponse, GraphTopic, WorkspaceResponse } from '../../next/protocol.js';

export interface ContinuationContext {
  workspace: WorkspaceResponse | null;
  graph: GraphResponse;
  topic: GraphTopic | null;
  node: GraphNode | null;
}

/**
 * Builds a copyable instruction for a new Agent conversation.
 *
 * It carries only the stable domain identity (workspaceId / topicId / nodeId),
 * the persistent revision and the CLI / Skill entries the service actually
 * reports. It never invents source file paths, hashes or absolute directories and
 * never claims that a write already happened.
 */
export function buildContinuationPrompt(context: ContinuationContext): string {
  const { workspace, graph, topic } = context;
  const node = context.node?.topicId === topic?.id ? context.node : null;
  const lines: string[] = [];
  lines.push('继续讨论《' + (topic?.title ?? '当前主题') + '》' + (node ? ' · ' + node.number + ' ' + node.title : ''));
  lines.push('');
  lines.push('工作区：' + (workspace?.name ?? graph.workspaceId) + '  workspaceId=' + graph.workspaceId);
  const entry = workspace?.agentEntry;
  if (entry !== undefined) {
    lines.push('CLI 入口：' + entry.cliPath);
    lines.push('Skill 入口：' + entry.skillPath);
  } else {
    lines.push('CLI／Skill：请使用此服务同版本的实际入口，先核对启动配置或向用户确认；不要猜测开发目录。');
  }
  lines.push('当前快照：' + graph.instanceId + ' / r' + String(graph.revision));
  if (graph.activeNode !== null && graph.nodes.some((candidate) => candidate.id === graph.activeNode && candidate.topicId === topic?.id)) {
    const active = graph.nodes.find((candidate) => candidate.id === graph.activeNode);
    lines.push('activeNode：' + graph.activeNode + (active ? '（' + active.number + ' ' + active.title + '）' : ''));
  } else {
    lines.push('本主题讨论焦点：（未设置，不使用其他主题的 activeNode）');
  }
  if (topic) {
    lines.push('主题：' + topic.title + ' · topicId=' + topic.id + ' · r' + String(topic.revision));
  }
  if (node) {
    lines.push(
      '节点：' + node.number + ' ' + node.title +
        ' · nodeId=' + node.id + ' · revision=' + String(node.revision) +
        ' · flow=' + node.flow +
        (node.from !== null ? ' · from=' + node.from : '') +
        ((node.description ?? '').trim() !== '' ? ' · 入边说明=' + node.description : ''),
    );
  }
  lines.push('');
  lines.push('读取指引：');
  lines.push('1. 读取同版本 Skill，核对 workspaceId 与上面列出的实际入口。本对话绑定上述 topicId；之后前端切换主题不会自动改变本对话的记录目标。');
  lines.push('2. 读取正文：用实际 CLI 入口执行 read <topicId> --view resume --node <nodeId> --workspace-id <workspaceId>；需要结构或按范围正文时改用 structure／content。');
  lines.push('3. 修改使用读取得到的 nodeId 与 revision（--node <nodeId> --if-revision <revision>），一次表达完整修改意图；版本冲突时重新读取，不直接覆盖。');
  lines.push('4. 新增与修改保持在绑定主题内；无实质变化不必写入，也不要求每轮操作汇报。');
  return lines.join('\n');
}
