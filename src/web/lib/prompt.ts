import type { GraphNode, GraphResponse, GraphTopic, WorkspaceResponse } from '../../shared/protocol.js';
import { absoluteWorkspacePath } from './locate.js';

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
  const { workspace, graph, topic } = context;
  const node = context.node?.topicId === topic?.id ? context.node : null;
  const lines: string[] = [];
  const name = workspace?.name ?? graph.workspaceId;
  lines.push('继续讨论《' + (topic?.title ?? '当前主题') + '》' + (node ? ' · ' + node.number + ' ' + node.title : ''));
  lines.push('');
  lines.push('工作区：' + name + (workspace ? '（' + workspace.rootPath + '）' : ''));
  lines.push('workspaceId：' + graph.workspaceId);
  const entry = workspace?.agentEntry;
  if (entry !== undefined) {
    lines.push('CLI 入口：' + entry.cliPath);
    lines.push('Skill 入口：' + entry.skillPath);
  } else {
    lines.push('CLI／Skill：请使用此服务对应版本的实际入口，先核对启动配置或向用户确认；不要猜测开发目录。');
  }
  lines.push('当前快照：' + graph.instanceId + ' / r' + String(graph.revision) + (graph.stale ? '（磁盘内容当前无效，阅读的是上一份有效内容）' : ''));
  if (graph.activeNode !== null && graph.nodes.some((candidate) => candidate.id === graph.activeNode && candidate.topicId === topic?.id)) {
    const active = graph.nodes.find((candidate) => candidate.id === graph.activeNode);
    lines.push('activeNode：' + graph.activeNode + (active ? '（' + active.number + ' ' + active.title + '）' : ''));
  } else {
    lines.push('本主题讨论焦点：（未设置，不使用其他主题的 activeNode）');
  }
  if (topic) {
    const directory = topic.path.replace(/\/?[^/]+$/, '');
    const absolute = workspace === null ? directory : absoluteWorkspacePath(workspace.rootPath, directory);
    lines.push('主题：' + topic.title + ' · topicId=' + topic.id);
    lines.push('主题目录：' + absolute);
    lines.push('主题元数据：' + topic.path + ' · fileHash ' + topic.fileHash);
  }
  if (node) {
    lines.push(
      '节点：' + node.number + ' ' + node.title + ' · ' + node.id +
        ' · state=' + node.state + ' · flow=' + node.flow + (node.from ? ' · from=' + node.from : ''),
    );
  }
  lines.push('');
  lines.push('读取指引：');
  lines.push('1. 读取同版本 Skill，核对 workspace.json 和上述工作区身份。本对话绑定上述 topicId／主题目录；之后前端切换主题不会自动改变本对话的记录目标。');
  lines.push('2. 读取本主题相关源 Markdown，按需使用 CLI 定位、分段读取和受控修改。topic.md 是元数据，每节点有独立 Markdown。结构顺序由 from／flow 决定，不按文件名或聊天轮次推断。');
  lines.push('3. 新增与修改保持在绑定主题内，不把全库 activeNode 当作其他主题的默认写入目标。需要切换记录主题时先取得用户明确指示。');
  lines.push('4. 正常继续讨论并按需整理，无实质变化不必写入，也不要求每轮操作汇报。修改须依据实际读取凭据，冲突重新读取，不直接覆盖。');
  return lines.join('\n');
}
