/**
 * 格式 2（一节点一份 Markdown）的纯格式事实：路径布局与文本生成。
 *
 * 字段 schema 与解析一律来自 core（v2TopicHeaderSchema／v2NodeHeaderSchema／
 * parseWorkspaceDocuments）；这里不再定义第二套重复 schema，避免两边规则漂移。
 * 本模块不读文件、不校验图、不写盘。
 */
import { stringify as stringifyYaml } from "yaml";
import type { SupportedSchemaVersion, V2NodeHeader, V2TopicHeader } from "../core/index.js";

/** 主题元数据文件的保留名；它同时是主题入口，改名等于更换身份文件。 */
export const TOPIC_META_FILENAME = "topic.md";
export const TOPICS_DIR = "topics";
export const WORKSPACE_FILENAME = "workspace.json";

/** 支持读取的工作区格式；新 init 只写 2。 */
export type WorkspaceSchemaVersion = SupportedSchemaVersion;
export const DEFAULT_WORKSPACE_SCHEMA_VERSION: WorkspaceSchemaVersion = 2;

/** 路径层级：topics/<主题目录>/<文件名>（主题目录固定下一层）。 */
export interface TopicPathParts {
  readonly directory: string;
  readonly filename: string;
  readonly path: string;
  readonly isTopicMeta: boolean;
}

/**
 * 拆解 topics 下的路径。只按布局分类，不判断内容合法性：
 * 谁是 topic.md、谁是节点文件由文件名决定，内容与图由 core 校验。
 */
export function parseTopicPath(relativePath: string): TopicPathParts | null {
  const segments = relativePath.split("/");
  if (segments[0] !== TOPICS_DIR || segments.length < 2) return null;
  const filename = segments[segments.length - 1] as string;
  const directory = segments.slice(1, -1).join("/");
  return { directory, filename, path: relativePath, isTopicMeta: filename === TOPIC_META_FILENAME };
}

/** topics 下一层且正好 topic.md／<file>.md 的路径才是合法 V2 归属。 */
export function isV2TopicFilePath(relativePath: string): boolean {
  const parts = parseTopicPath(relativePath);
  return parts !== null && parts.directory.length > 0 && parts.directory.includes("/") === false;
}

/** 节点文件名默认用稳定 ID；身份来自 nodeId，不来自文件名。 */
export function nodeFileName(nodeId: string): string {
  return nodeId + ".md";
}

export function topicMetaPath(directory: string): string {
  return TOPICS_DIR + "/" + directory + "/" + TOPIC_META_FILENAME;
}

export function nodePath(directory: string, nodeId: string): string {
  return TOPICS_DIR + "/" + directory + "/" + nodeFileName(nodeId);
}

/** topic.md 的文本；与节点文件共用同一套 YAML 序列化，不手写转义。 */
export function renderTopicMetaText(options: {
  topicId: string;
  title: string;
  nl: string;
  bom?: boolean | undefined;
  /** 仅为显式标注调用意图；输出与现有文件一致。 */
  created?: boolean | undefined;
}): string {
  const nl = options.nl;
  const yamlText = normalizeNewlines(
    stringifyYaml({ topicId: options.topicId, title: options.title }, { lineWidth: 0 }),
    nl,
  );
  return (options.bom === true ? "\uFEFF" : "") + "---" + nl + yamlText + "---" + nl;
}

export function normalizeNewlines(value: string, nl: string): string {
  const lf = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return nl === "\n" ? lf : lf.replace(/\n/g, nl);
}

/** 头字段按固定顺序输出，读者与 diff 都稳定。 */
export function nodeHeaderObject(header: V2NodeHeader): Record<string, unknown> {
  const record: Record<string, unknown> = {
    nodeId: header.nodeId,
    title: header.title,
    state: header.state,
    from: header.from,
    flow: header.flow,
  };
  if (header.description !== undefined) record["description"] = header.description;
  if (header.side !== undefined) record["side"] = header.side;
  if (header.order !== undefined) record["order"] = header.order;
  if (header.summary !== undefined) record["summary"] = header.summary;
  return record;
}

/**
 * 生成一份节点文件：YAML 头 + 原样 Markdown 正文。
 * 不在正文里合成 H2 卡片标题，也不写入旧格式的 node 注释。
 */
export function renderNodeFile(options: {
  header: V2NodeHeader;
  body: string;
  nl: string;
  bom?: boolean | undefined;
}): string {
  const nl = options.nl;
  const yamlText = normalizeNewlines(
    stringifyYaml(nodeHeaderObject(options.header), { lineWidth: 0 }),
    nl,
  );
  const body = normalizeNewlines(options.body, nl).replace(/\s+$/, "");
  const head = (options.bom === true ? "\uFEFF" : "") + "---" + nl + yamlText + "---" + nl;
  return body.length === 0 ? head + nl : head + nl + body + nl;
}

/** 生成 topic.md：只有 topicId 与 title，正文保持空白。 */
export function renderTopicMetaFile(options: {
  header: V2TopicHeader;
  nl: string;
  bom?: boolean | undefined;
}): string {
  const nl = options.nl;
  const yamlText = normalizeNewlines(
    stringifyYaml({ topicId: options.header.topicId, title: options.header.title }, { lineWidth: 0 }),
    nl,
  );
  return (options.bom === true ? "\uFEFF" : "") + "---" + nl + yamlText + "---" + nl;
}
