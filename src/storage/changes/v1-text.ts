/** 格式 1 卡片区块的内存文本状态与原文保留；不执行工作区业务操作。 */
import { parseDocument, stringify as stringifyYaml } from "yaml";
import type { Document, ParsedNode as YamlParsedNode } from "yaml";
import { parseTopicDocument, type NodeMeta, type ParsedNode, type ParsedTopic } from "../../core/index.js";
import { validationError } from "../changes-shared.js";


export function normalizeNewlines(value: string, nl: string): string {
  const lf = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return nl === "\n" ? lf : lf.replace(/\n/g, nl);
}

export function detectNewline(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function metaToPlain(meta: NodeMeta): Record<string, unknown> {
  const plain: Record<string, unknown> = {
    from: meta.from,
    flow: meta.flow,
    state: meta.state,
  };
  if (meta.side !== undefined) plain["side"] = meta.side;
  if (meta.order !== undefined) plain["order"] = meta.order;
  if (meta.label !== undefined) plain["label"] = meta.label;
  if (meta.summary !== undefined) plain["summary"] = meta.summary;
  return plain;
}

function metaFromParsed(node: ParsedNode): NodeMeta {
  const meta: NodeMeta = { from: node.from, flow: node.flow, state: node.state };
  if (node.side !== undefined) meta.side = node.side;
  if (node.order !== undefined) meta.order = node.order;
  if (node.label !== undefined) meta.label = node.label;
  if (node.summaryExplicit) meta.summary = node.summary;
  return meta;
}

/* ------------------------------------------------------------------ *
 * 候选模型
 * ------------------------------------------------------------------ */

export interface NodeView {
  readonly id: string;
  title: string;
  body: string;
  meta: NodeMeta;
  /** 以下偏移都相对该卡片区块（ranges.node 切片）起点，用于局部替换。 */
  readonly headingStart: number;
  readonly headingEnd: number;
  readonly titleRange: { readonly start: number; readonly end: number } | null;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

type YamlDocument = Document.Parsed<YamlParsedNode, true>;

export interface TopicState {
  topicId: string;
  path: string;
  title: string;
  nl: string;
  /** 文件开头至 frontmatter YAML 内容之前（含可选 BOM 与起始 --- 行）。 */
  yamlLeading: string;
  /** YAML 内容之后至第一张卡片之前（含结束 --- 行）。 */
  yamlTrailing: string;
  yamlText: string;
  yamlDoc: YamlDocument;
  order: string[];
  nodes: Map<string, NodeView>;
  blocks: Map<string, string>;
  text: string;
  /** 扫描时是否已存在于磁盘。 */
  existing: boolean;
  originalText: string | null;
  everHadNode: boolean;
}

/** 标题里的 Markdown 控制字符必须转义，否则写回后 H2 的可见文字会变。 */
const TITLE_SPECIAL = /([\\\x60*_\[\]<>~|&])/g;

/** 卡片标题的单行转义：只处理 Markdown 会吃掉或改变语义的字符。 */
function escapeCardTitle(title: string): string {
  return title.replace(TITLE_SPECIAL, "\\$1");
}

function headingLine(nodeId: string, title: string): string {
  return "## " + escapeCardTitle(title) + " <!-- node:" + nodeId + " -->";
}

/** 新建卡片区块；正文里的三级以下标题原样保留。 */
export function renderNewBlock(
  nodeId: string,
  title: string,
  body: string,
  nl: string,
  tail: string,
): string {
  const heading = headingLine(nodeId, title);
  const normalized = normalizeNewlines(body, nl).replace(/\s+$/, "");
  if (normalized.length === 0) return heading + tail;
  return heading + nl + nl + normalized + tail;
}

/**
 * 只替换标题或正文，保留原区块的其余字节。
 *
 * ranges.node 是"H2 到下一张卡 H2"的整块范围，ranges.body 只是 trim 后的展示范围，
 * 都不能直接当作替换边界；这里用相对偏移定位标题文字与正文，分隔空白、尾随空白、
 * BOM 与 CRLF 全部原样保留。
 */
export function patchBlock(
  block: string,
  node: NodeView,
  options: { title?: string | undefined; body?: string | undefined; nl: string },
): string {
  // 先替换正文（更靠后），再替换标题；否则标题长度变化会让正文偏移失效。
  let next = block;
  if (options.body !== undefined) {
    const normalized = normalizeNewlines(options.body, options.nl).replace(/\s+$/, "");
    const trailing = next.slice(node.bodyEnd);
    if (normalized.length === 0) {
      // 正文清空：保留卡片本身与尾随空白（末卡可能没有结尾换行）。
      next = next.slice(0, node.headingEnd) + (trailing.length > 0 ? trailing : options.nl);
    } else {
      const gap = next.slice(node.headingEnd, node.bodyStart);
      const separator = /\r?\n/.test(gap) ? gap : options.nl + options.nl;
      next = next.slice(0, node.headingEnd) + separator + normalized + trailing;
    }
  }
  if (options.title === undefined || options.title === node.title) return next;

  const escaped = escapeCardTitle(options.title);
  if (node.titleRange) {
    return next.slice(0, node.titleRange.start) + escaped + next.slice(node.titleRange.end);
  }
  const heading = next.slice(node.headingStart, node.headingEnd);
  const prefixEnd = heading.indexOf("##") + 2;
  const commentAt = heading.indexOf("<!--");
  const comment = commentAt >= 0 ? heading.slice(commentAt) : "<!-- node:" + node.id + " -->";
  return (
    next.slice(0, node.headingStart) +
    heading.slice(0, prefixEnd) +
    " " +
    escaped +
    " " +
    comment +
    next.slice(node.headingEnd)
  );
}

export function renderText(state: TopicState): string {
  let blocks = "";
  for (const id of state.order) blocks += state.blocks.get(id) ?? "";
  return state.yamlLeading + state.yamlText + state.yamlTrailing + blocks;
}

function parseYamlDoc(yamlText: string, path: string): YamlDocument {
  const doc = parseDocument(yamlText, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
    customTags: [],
    version: "1.2",
  });
  if (doc.errors.length > 0) {
    const message = doc.errors.map((error) => error.message).join("; ");
    throw validationError("frontmatter 无法解析：" + path + "：" + message);
  }
  return doc as YamlDocument;
}

export function setNodeMeta(state: TopicState, nodeId: string, meta: NodeMeta | null): void {
  const doc = state.yamlDoc;
  if (meta === null) doc.deleteIn(["nodes", nodeId]);
  else doc.setIn(["nodes", nodeId], metaToPlain(meta));
  if (doc.errors.length > 0) {
    const message = doc.errors.map((error) => error.message).join("; ");
    throw validationError("frontmatter 元数据更新失败：" + state.path + "：" + message);
  }
  state.yamlText = normalizeNewlines(doc.toString({ lineWidth: 0 }), state.nl);
}

function makeState(options: {
  topicId: string;
  path: string;
  title: string;
  nl: string;
  yamlLeading: string;
  yamlTrailing: string;
  yamlText: string;
  yamlDoc: YamlDocument;
  originalText: string | null;
  existing: boolean;
}): TopicState {
  return {
    topicId: options.topicId,
    path: options.path,
    title: options.title,
    nl: options.nl,
    yamlLeading: options.yamlLeading,
    yamlTrailing: options.yamlTrailing,
    yamlText: options.yamlText,
    yamlDoc: options.yamlDoc,
    order: [],
    nodes: new Map(),
    blocks: new Map(),
    text: "",
    existing: options.existing,
    originalText: options.originalText,
    everHadNode: false,
  };
}

function nodeViewFrom(
  node: ParsedNode,
  text: string,
  blockStart: number,
  blockLength: number,
  path: string,
): { node: ParsedNode; block: string; view: NodeView } {
  const block = text.slice(blockStart, blockStart + blockLength);
  const rel = (range: { start: number; end: number }) => ({
    start: range.start - blockStart,
    end: range.end - blockStart,
  });
  // 格式 1 一定有 H2 标题范围；缺省说明不是本模块该处理的格式 2 节点。
  const headingRange = node.ranges.heading;
  if (!headingRange) {
    throw validationError("格式 1 卡片缺少标题范围：" + node.id + "（" + path + "）");
  }
  const heading = rel(headingRange);
  const body = rel(node.ranges.body);
  if (
    heading.start < 0 ||
    heading.end > block.length ||
    body.start < heading.end ||
    body.end > block.length
  ) {
    throw validationError("卡片源码范围异常：" + node.id + "（" + path + "）");
  }
  return {
    node,
    block,
    view: {
      id: node.id,
      title: node.title,
      body: node.body,
      meta: metaFromParsed(node),
      headingStart: heading.start,
      headingEnd: heading.end,
      titleRange: node.ranges.title ? rel(node.ranges.title) : null,
      bodyStart: body.start,
      bodyEnd: body.end,
    },
  };
}

/** 从一次成功的解析构造候选状态；未修改区块的原文切片保持逐字节一致。 */
export function stateFromParsed(
  topic: ParsedTopic,
  options: { path: string; text: string; originalText: string | null; existing: boolean },
): TopicState {
  const text = options.text;
  const contentRange = topic.document.frontmatterContentRange;
  if (!contentRange) throw validationError("主题缺少 frontmatter 内容范围：" + options.path);
  const sorted = [...topic.nodes].sort(
    (left, right) => left.ranges.node.start - right.ranges.node.start,
  );
  const firstStart = sorted.length > 0 ? (sorted[0] as ParsedNode).ranges.node.start : text.length;
  const nl = detectNewline(text);
  const yamlText = text.slice(contentRange.start, contentRange.end);
  const state = makeState({
    topicId: topic.topicId,
    path: options.path,
    title: topic.title,
    nl,
    yamlLeading: text.slice(0, contentRange.start),
    yamlTrailing: text.slice(contentRange.end, firstStart),
    yamlText,
    yamlDoc: parseYamlDoc(yamlText, options.path),
    originalText: options.originalText,
    existing: options.existing,
  });
  for (const node of sorted) {
    const start = node.ranges.node.start;
    const built = nodeViewFrom(node, text, start, node.ranges.node.end - start, options.path);
    state.order.push(node.id);
    state.blocks.set(node.id, built.block);
    state.nodes.set(node.id, built.view);
  }
  state.everHadNode = state.order.length > 0;
  state.text = renderText(state);
  return state;
}

/** 新主题：frontmatter 从空 nodes 开始，首卡必须由同批 createNode 提供。 */
export function newTopicState(topicId: string, path: string, title: string): TopicState {
  const nl = "\n";
  const yamlText = normalizeNewlines(
    stringifyYaml({ schemaVersion: 1, topicId, title, nodes: {} }, { lineWidth: 0 }),
    nl,
  );
  const state = makeState({
    topicId,
    path,
    title,
    nl,
    yamlLeading: "---" + nl,
    yamlTrailing: "---" + nl + nl,
    yamlText,
    yamlDoc: parseYamlDoc(yamlText, path),
    originalText: null,
    existing: false,
  });
  state.text = renderText(state);
  return state;
}

/**
 * 用当前候选文本重新解析并回填相对偏移。
 *
 * - verify=true（操作结束时）额外核对标题与元数据是否按预期落到源码里；
 * - verify=false（批量重算偏移）只刷新位置，供后续局部替换使用；
 * - 新主题在首卡落盘前允许暂时没有卡片。
 */
export function resync(state: TopicState, verify: boolean): void {
  state.text = renderText(state);
  if (state.order.length === 0) return;
  const result = parseTopicDocument(state.text, { path: state.path });
  if (!result.ok || !result.topic) {
    throw validationError("候选主题无法通过解析：" + state.path, result.diagnostics, {
      path: state.path,
    });
  }
  const parsed = result.topic;
  if (parsed.topicId !== state.topicId) {
    throw validationError("候选主题的 topicId 发生变化：" + state.path);
  }
  const seen = new Set(parsed.nodes.map((node) => node.id));
  for (const id of state.order) {
    if (!seen.has(id)) throw validationError("候选主题缺少卡片：" + id + "（" + state.path + "）");
  }
  if (seen.size !== state.order.length) {
    throw validationError("候选主题出现未预期的卡片：" + state.path, result.diagnostics);
  }
  state.title = parsed.title;
  for (const node of parsed.nodes) {
    const index = state.order.indexOf(node.id);
    const block = state.blocks.get(node.id) ?? "";
    if (index >= 0) {
      const built = nodeViewFrom(node, state.text, startOfBlock(state, index), block.length, state.path);
      const previous = state.nodes.get(node.id);
      if (verify && previous) {
        if (node.title !== previous.title) {
          throw validationError(
            "标题无法在 Markdown 中稳定呈现：" + previous.title + " → " + node.title,
            [],
            { path: state.path, nodeId: node.id },
          );
        }
        const expected = previous.meta;
        const actual = metaFromParsed(node);
        if (
          expected.from !== actual.from ||
          expected.flow !== actual.flow ||
          expected.state !== actual.state ||
          expected.side !== actual.side ||
          expected.order !== actual.order ||
          expected.label !== actual.label ||
          expected.summary !== actual.summary
        ) {
          throw validationError("frontmatter 与卡片元数据不一致：" + node.id, [], {
            path: state.path,
            nodeId: node.id,
          });
        }
      }
      state.blocks.set(node.id, built.block);
      state.nodes.set(node.id, {
        ...built.view,
        // 尚未确认的新值在 verify=false 时由操作方自己维持，这里只刷新位置。
        title: previous && !verify ? previous.title : built.view.title,
        body: previous && !verify ? previous.body : built.view.body,
        meta: previous && !verify ? previous.meta : built.view.meta,
      });
    }
  }
}

/** 第 index 张卡片在 state.text 中的起点。 */
function startOfBlock(state: TopicState, index: number): number {
  let offset = state.yamlLeading.length + state.yamlText.length + state.yamlTrailing.length;
  for (let i = 0; i < index; i += 1) {
    offset += (state.blocks.get(state.order[i] as string) ?? "").length;
  }
  return offset;
}

function endsWithBlankLine(block: string): boolean {
  const trimmed = block.trimEnd();
  const tail = block.slice(trimmed.length);
  return tail.includes("\n\n") || tail.includes("\r\n\r\n");
}

function withBlankLine(block: string, nl: string): string {
  return endsWithBlankLine(block) ? block : block + nl;
}

export function appendBlock(state: TopicState, nodeId: string, block: string): void {
  const lastId = state.order.length > 0 ? state.order[state.order.length - 1] : undefined;
  if (lastId !== undefined) {
    const lastBlock = state.blocks.get(lastId) ?? "";
    if (!endsWithBlankLine(lastBlock)) state.blocks.set(lastId, lastBlock + state.nl);
  }
  state.blocks.set(nodeId, block);
  state.order.push(nodeId);
}

export function insertBlockAfter(
  state: TopicState,
  afterId: string,
  nodeId: string,
  block: string,
): void {
  state.blocks.set(nodeId, withBlankLine(block, state.nl));
  const index = state.order.indexOf(afterId);
  if (index < 0) state.order.push(nodeId);
  else state.order.splice(index + 1, 0, nodeId);
}

export function removeBlock(state: TopicState, nodeId: string): NodeView | undefined {
  const node = state.nodes.get(nodeId);
  if (!node) return undefined;
  const index = state.order.indexOf(nodeId);
  if (index >= 0) state.order.splice(index, 1);
  state.blocks.delete(nodeId);
  state.nodes.delete(nodeId);
  setNodeMeta(state, nodeId, null);
  return node;
}
