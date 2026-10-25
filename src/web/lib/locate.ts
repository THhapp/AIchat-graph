import type { GraphNode, GraphResponse, GraphTopic, WorkspaceResponse } from '../../shared/protocol.js';

export interface LocateContext {
  workspace: WorkspaceResponse | null;
  graph: GraphResponse;
  topic: GraphTopic | null;
  node: GraphNode;
}

/**
 * Joins a workspace-relative path onto the real root. The separator follows the
 * root, so a Windows root keeps backslashes and a POSIX root keeps slashes; no
 * separator is invented and no path is guessed.
 */
export function absoluteWorkspacePath(rootPath: string, relativePath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, '');
  const windows = trimmed.includes('\\') && !trimmed.includes('/');
  const rest = (windows ? relativePath.replace(/\//g, '\\') : relativePath.replace(/\\/g, '/')).replace(/^[\\/]+/, '');
  return trimmed + (windows ? '\\' : '/') + rest;
}

/**
 * Stable locator for the card on screen. It carries IDs, real file paths and the
 * service entry paths only: no body text, no credentials, nothing from another
 * topic. Anything the service does not actually provide is stated as missing
 * instead of being filled in.
 */
export function buildLocateText(context: LocateContext): string {
  const { workspace, graph, topic, node } = context;
  const name = workspace?.name ?? graph.workspaceId;
  const root = workspace?.rootPath ?? null;
  const lines: string[] = [];

  lines.push('工作区：' + name + (root === null ? '' : '（' + root + '）') + '  workspaceId=' + graph.workspaceId);
  lines.push('topicId=' + node.topicId + '  nodeId=' + node.id);

  const topicPath = (topic?.id === node.topicId ? topic.path : null) ?? topic?.path ?? null;
  const sourcePath = node.sourcePath ?? null;
  if (sourcePath !== null && root !== null) {
    lines.push('源文件：' + absoluteWorkspacePath(root, sourcePath));
  } else if (sourcePath !== null) {
    // The service did not report a workspace root, so only the relative path is a fact.
    lines.push('源文件：' + sourcePath + '（服务未提供工作区绝对路径）');
  } else if (topicPath !== null && root !== null) {
    lines.push('源文件：未提供该节点的独立源文件；主题文件 ' + absoluteWorkspacePath(root, topicPath));
  } else if (topicPath !== null) {
    lines.push('源文件：未提供该节点的独立源文件；主题文件 ' + topicPath);
  } else {
    lines.push('源文件：未提供（服务未返回该节点的源文件路径）');
  }

  const entry = workspace?.agentEntry;
  if (entry !== undefined) {
    lines.push('CLI：' + entry.cliPath + '   Skill：' + entry.skillPath);
  } else {
    // No path is invented: the reader can only say which version to use.
    lines.push('CLI：使用与本服务同版本的入口   Skill：使用与本服务同版本的入口');
  }

  lines.push('当前：' + node.number + ' ' + node.title);
  return lines.join('\n');
}
