/** 格式 2 节点与主题文件的内存文本状态与原文保留；不执行工作区业务操作。 */
import { stringify as stringifyYaml } from "yaml";
import type { ParsedNode, ParsedTopic, V2NodeHeader } from "../../core/index.js";
import type { WorkspaceFile } from "../workspace.js";
import { nodeHeaderObject, normalizeNewlines, parseTopicPath, renderTopicMetaText } from "../format-v2.js";

/* ------------------------------------------------------------------ *
 * 候选模型：一份节点文件 = YAML 头 + 正文
 * ------------------------------------------------------------------ */

/**
 * 节点文件的候选状态。
 *
 * 头与正文分开保存：改标题／状态只重写 YAML 头，改正文只换 frontmatter 之后的正文，
 * 两者之间的分隔空行与尾随换行保持原样，因此中文、BOM、CRLF 不会被顺手重排。
 */
export interface NodeFileState {
  readonly nodeId: string;
  topicId: string;
  dir: string;
  path: string;
  header: V2NodeHeader;
  body: string;
  /** BOM（若有）与起始 --- 行（含其换行）。 */
  readonly headOpen: string;
  /** YAML 头之后的结束 --- 行到正文之前（含分隔空行）。 */
  readonly bodyPrefix: string;
  /** 扫描时原始的 YAML 头文本；未改头字段时原样写回，避免无谓重排。 */
  readonly originalHeaderYaml: string;
  /** 扫描时的头字段快照，用来判断本批是否真的改了头。 */
  readonly scannedHeader: V2NodeHeader;
  /** 正文 trim 结束之后到文件结尾的尾随空白。 */
  readonly bodyTail: string;
  readonly nl: string;
  readonly originalText: string | null;
  /** 本批新建、尚未落盘：被清空时无需输出删除。 */
  readonly created: boolean;
}

export interface TopicState {
  topicId: string;
  dir: string;
  title: string;
  metaPath: string;
  metaText: string;
  metaOriginal: string | null;
  readonly nl: string;
  readonly created: boolean;
}

function headerYaml(header: V2NodeHeader, nl: string): string {
  return normalizeNewlines(stringifyYaml(nodeHeaderObject(header), { lineWidth: 0 }), nl);
}

function headerEquals(left: V2NodeHeader, right: V2NodeHeader): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.title === right.title &&
    left.state === right.state &&
    left.from === right.from &&
    left.flow === right.flow &&
    left.description === right.description &&
    left.side === right.side &&
    left.order === right.order &&
    left.summary === right.summary
  );
}

/**
 * 重建整份节点文件。
 *
 * 头字段没变时沿用扫描到的原始 YAML 头（含原有字段顺序与引号风格），
 * 只有真正改动的文件才重新序列化，未改动的节点因此可以与原文逐字节相同。
 */
export function renderNodeText(state: NodeFileState): string {
  const normalized = normalizeNewlines(state.body, state.nl).replace(/\s+$/, "");
  const headerDiffers = !headerEquals(state.header, state.scannedHeader);
  const yaml = headerDiffers ? headerYaml(state.header, state.nl) : state.originalHeaderYaml;
  const head = state.headOpen + yaml + "---" + state.nl + state.bodyPrefix;
  const tail = state.bodyTail.length > 0 ? state.bodyTail : state.nl;
  if (normalized.length === 0) return head + tail;
  return head + normalized + tail;
}

function renderTopicMetaState(state: TopicState): string {
  return renderTopicMetaText({ topicId: state.topicId, title: state.title, nl: state.nl });
}

/**
 * 从原文切出头的三段与正文，保留原始换行与 BOM。
 *
 * 头部边界直接取 core 给出的 frontmatter 范围，因此注释、引号风格、字段顺序都不会被改写；
 * 只有真正改动头字段的文件才重新序列化 YAML。
 */
export function nodeStateFrom(options: {
  path: string;
  text: string;
  node: ParsedNode;
  header: V2NodeHeader;
  originalText: string | null;
  created: boolean;
}): NodeFileState {
  const { text } = options;
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const contentRange = options.node.ranges;
  const bodyStart = contentRange.body.start;
  const bodyEnd = contentRange.body.end;
  const openEnd = text.indexOf("\n");
  const headOpen = text.slice(0, openEnd === -1 ? text.length : openEnd + 1);
  const closingAt = findClosingFence(text, headOpen.length);
  const headerEnd = closingAt === -1 ? Math.min(bodyStart, text.length) : closingAt;
  const originalHeaderYaml = text.slice(headOpen.length, headerEnd);
  // 结束 --- 行本身（含其后的换行）；再接 bodyPrefix 就是正文之前的全部字节。
  const fenceEnd = closingAt === -1 ? headerEnd : text.indexOf("\n", closingAt);
  const afterFence = fenceEnd === -1 ? text.length : fenceEnd + 1;
  return {
    nodeId: options.node.id,
    topicId: options.node.topicId,
    dir: parseTopicPath(options.path)?.directory ?? "",
    path: options.path,
    header: options.header,
    body: options.node.body,
    headOpen,
    // 结束 --- 行之后到正文之前：保留原有的分隔空行。
    bodyPrefix: text.slice(afterFence, bodyStart),
    bodyTail: text.slice(bodyEnd),
    originalHeaderYaml,
    scannedHeader: options.header,
    nl,
    originalText: options.originalText,
    created: options.created,
  };
}

/** 结束 --- 行的起点位置；找不到时返回 -1（改用正文起点兜底）。 */
function findClosingFence(text: string, from: number): number {
  if (from >= text.length) return -1;
  const found = text.indexOf("\n---", from);
  return found === -1 ? -1 : found + 1;
}

/* ------------------------------------------------------------------ *
 * 载入：先用 core 解析整份工作区
 * ------------------------------------------------------------------ */

export function headerFromParsed(node: ParsedNode): V2NodeHeader {
  const header: V2NodeHeader = {
    nodeId: node.id,
    title: node.title,
    state: node.state,
    from: node.from,
    flow: node.flow,
  };
  if (node.description !== undefined) header.description = node.description;
  if (node.side !== undefined) header.side = node.side;
  if (node.order !== undefined) header.order = node.order;
  if (node.summaryExplicit) header.summary = node.summary;
  return header;
}

export function topicStateFrom(topic: ParsedTopic, file: WorkspaceFile | undefined): TopicState {
  const dir = topic.dir ?? "";
  const text = file?.text ?? topic.document.text;
  return {
    topicId: topic.topicId,
    dir,
    title: topic.title,
    metaPath: topic.document.path,
    metaText: text,
    metaOriginal: text,
    nl: text.includes("\r\n") ? "\r\n" : "\n",
    created: false,
  };
}
