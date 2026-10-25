import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Heading, Root, RootContent } from "mdast";
import type { Position } from "unist";
import { topicFrontmatterSchema, TOPIC_SCHEMA_VERSION } from "./schema.js";
import type { NodeMeta, SupportedSchemaVersion, TopicFrontmatter } from "./schema.js";
import { makeDiagnostic } from "./diagnostics.js";
import type { Diagnostic, SourceRange } from "./diagnostics.js";
import { contentRange, detectNewlineStyle } from "./newlines.js";
import type { NewlineStyle } from "./newlines.js";
import { splitFrontmatter, readFrontmatter } from "./frontmatter.js";
import { deriveSummary } from "./summary.js";

export interface TopicDocument {
  /** 调用方给出的定位标签（通常是工作区相对路径）；解析器本身不读取文件系统。 */
  readonly path: string;
  /** UTF-8 解码后的原始字符串；解析不归一化换行，所有范围都相对于它。 */
  readonly text: string;
  readonly bom: boolean;
  readonly newline: NewlineStyle;
  readonly frontmatterRange?: SourceRange | undefined;
  readonly frontmatterContentRange?: SourceRange | undefined;
  readonly bodyRange?: SourceRange | undefined;
}

export interface NodeRanges {
  /** 可整块替换的节点范围（相对 text）：V1 为 H2 到下一张卡 H2（含尾部空白），V2 为整个节点文件。 */
  readonly node: SourceRange;
  /** 去掉首尾空白的正文；V2 为 frontmatter 结束之后的正文。 */
  readonly body: SourceRange;
  /** 格式 1 的 H2 标题范围；格式 2 没有 H2，缺省。 */
  readonly heading?: SourceRange | undefined;
  readonly title?: SourceRange | undefined;
  /** 格式 1 的 node 注释范围；格式 2 没有注释，缺省。 */
  readonly comment?: SourceRange | undefined;
}

export interface ParsedNode {
  readonly id: string;
  readonly topicId: string;
  /** 主题入口路径：V1 为该主题文件，V2 为 topic.md。 */
  readonly topicPath: string;
  /** 节点真实来源文件：V1 与 topicPath 相同，V2 为该节点自己的文件。 */
  readonly sourcePath: string;
  readonly title: string;
  readonly body: string;
  readonly summary: string;
  readonly summaryExplicit: boolean;
  readonly state: NodeMeta["state"];
  readonly flow: NodeMeta["flow"];
  readonly from: string | null;
  /** 格式 2 的来源说明；解释为什么接到 from。格式 1 无此字段。 */
  readonly description?: string | undefined;
  readonly side?: NodeMeta["side"] | undefined;
  readonly order?: number | undefined;
  /** 重要标记；格式 1 没有该字段的写入口，读侧恒为 false。 */
  readonly important: boolean;
  /** 仅格式 1 的兼容字段；格式 2 用 description。 */
  readonly label?: string | undefined;
  /** 均为原始字符串的 UTF-16 offset，左闭右开，可直接 text.slice。 */
  readonly ranges: NodeRanges;
}

export interface ParsedTopic {
  /** 主题入口文件：V1 为该主题文件，V2 为 topic.md。 */
  readonly document: TopicDocument;
  readonly schemaVersion: SupportedSchemaVersion;
  readonly topicId: string;
  readonly title: string;
  /** 格式 2 的主题目录（topics/<dir>）；格式 1 缺省。 */
  readonly dir?: string | undefined;
  /** 该主题全部真实源文件（含入口）；格式 1 只有入口文件。 */
  readonly sourcePaths: readonly string[];
  readonly nodes: readonly ParsedNode[];
}

export interface ParseTopicResult {
  readonly ok: boolean;
  readonly document: TopicDocument;
  readonly topic?: ParsedTopic | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ParseTopicOptions {
  readonly path?: string | undefined;
}

const NODE_COMMENT = /^<!--\s*node:(n_[0-9a-f]{32})\s*-->$/;
const MARKDOWN_PARSER = unified().use(remarkParse).use(remarkGfm);

function absoluteRange(position: Position | undefined, base: number): SourceRange | undefined {
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return { start: base + start, end: base + end };
}

function trimRange(text: string, range: SourceRange): SourceRange {
  let { start, end } = range;
  while (start < end && /\s/.test(text[start] ?? "")) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
  return { start, end };
}

function inlineText(node: RootContent | Heading["children"][number]): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "break":
      return " ";
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "html":
    case "footnoteReference":
      return "";
    default:
      if ("children" in node && Array.isArray(node.children)) {
        return node.children.map((child) => inlineText(child)).join("");
      }
      return "";
  }
}

/**
 * 首卡前只允许空白与完整的 HTML 注释。
 * 注释之后仍带文字或 HTML 节点（例如 "<!-- x --> 正文"）属于可见内容，必须拒绝；
 * 连续、跨行的完整注释之间允许空白。
 */
function isFormatComment(node: RootContent): boolean {
  if (node.type !== "html") return false;
  let rest = node.value;
  while (rest.length > 0) {
    const trimmed = rest.trimStart();
    if (trimmed.length === 0) return true;
    if (!trimmed.startsWith("<!--")) return false;
    const end = trimmed.indexOf("-->");
    if (end === -1) return false;
    rest = trimmed.slice(end + 3);
  }
  return true;
}

interface CardHeading {
  readonly id: string;
  readonly title: string;
  readonly headingRange: SourceRange;
  readonly commentRange: SourceRange;
  readonly titleRange?: SourceRange | undefined;
}

function parseCardHeading(
  heading: Heading,
  text: string,
  base: number,
  path: string,
  diagnostics: Diagnostic[],
): CardHeading | undefined {
  const headingRange = absoluteRange(heading.position, base);
  if (!headingRange) {
    diagnostics.push(makeDiagnostic("SOURCE_POSITION_MISSING", "无法取得标题的源码范围", { topicPath: path }));
    return undefined;
  }

  const children = heading.children;
  let commentIndex = -1;
  let nodeId: string | undefined;
  let mentionedNode = false;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child || child.type !== "html") continue;
    const value = child.value.trim();
    const match = NODE_COMMENT.exec(value);
    if (!match) {
      if (value.includes("node:")) mentionedNode = true;
      continue;
    }
    if (commentIndex !== -1) {
      diagnostics.push(
        makeDiagnostic("CARD_DUPLICATE_NODE_COMMENT", "同一个标题只能有一个 node 注释", { topicPath: path }, headingRange),
      );
      return undefined;
    }
    commentIndex = index;
    nodeId = match[1];
  }

  if (mentionedNode && commentIndex === -1) {
    diagnostics.push(
      makeDiagnostic(
        "CARD_INVALID_NODE_COMMENT",
        "节点注释必须写成 <!-- node:n_<32 位小写十六进制> -->",
        { topicPath: path },
        headingRange,
      ),
    );
    return undefined;
  }
  if (commentIndex === -1 || !nodeId) {
    diagnostics.push(
      makeDiagnostic("CARD_MISSING_NODE_COMMENT", "顶层二级标题必须带唯一的 node 注释", { topicPath: path }, headingRange),
    );
    return undefined;
  }

  const commentNode = children[commentIndex];
  const commentRange = commentNode ? absoluteRange(commentNode.position, base) : undefined;
  if (!commentRange) {
    diagnostics.push(makeDiagnostic("SOURCE_POSITION_MISSING", "无法取得节点注释的源码范围", { topicPath: path }, headingRange));
    return undefined;
  }

  const visibleAfter = children.slice(commentIndex + 1).some((child) =>
    child.type === "html" ? !child.value.trim().startsWith("<!--") : inlineText(child).trim().length > 0,
  );
  if (visibleAfter) {
    diagnostics.push(
      makeDiagnostic("CARD_VISIBLE_TEXT_AFTER_COMMENT", "node 注释之后不能再放可见标题文字", { topicPath: path }, headingRange),
    );
    return undefined;
  }

  const title = children
    .slice(0, commentIndex)
    .map((child) => inlineText(child))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length === 0) {
    diagnostics.push(makeDiagnostic("CARD_TITLE_EMPTY", "卡片标题不能为空", { topicPath: path }, headingRange));
    return undefined;
  }

  let titleRange: SourceRange | undefined;
  const positioned = children.slice(0, commentIndex).filter((child) => child.position);
  const first = positioned[0]?.position;
  const last = positioned[positioned.length - 1]?.position;
  if (first && last) {
    titleRange = trimRange(text, {
      start: base + (first.start.offset ?? 0),
      end: base + (last.end.offset ?? 0),
    });
  }

  return {
    id: nodeId,
    title,
    headingRange,
    commentRange,
    ...(titleRange ? { titleRange } : {}),
  };
}

/**
 * 解析一段 Markdown 正文并派生摘要（首段，最多 120 个 Unicode 码点）。
 * 格式 2 的单节点正文没有 H2 卡片结构，但摘要规则与格式 1 相同。
 */
export function deriveBodySummary(bodyText: string): string {
  if (bodyText.trim().length === 0) return "";
  const root = MARKDOWN_PARSER.parse(bodyText) as Root;
  return deriveSummary(root.children);
}

function topicContext(path: string): { topicPath: string } {
  return { topicPath: path };
}

/**
 * 解析一份主题 Markdown。输入必须是 UTF-8 解码后的原始字符串（可含 BOM）。
 * 本函数不读取文件、不归一化换行，返回范围可直接用于 text.slice(start, end)。
 */
export function parseTopicDocument(text: string, options: ParseTopicOptions = {}): ParseTopicResult {
  const path = options.path ?? "(inline)";
  const split = splitFrontmatter(text);
  const document: TopicDocument = {
    path,
    text,
    bom: split.bom,
    newline: detectNewlineStyle(text),
    ...(split.frontmatterRange ? { frontmatterRange: split.frontmatterRange } : {}),
    ...(split.contentRange ? { frontmatterContentRange: split.contentRange } : {}),
    ...(split.bodyRange ? { bodyRange: split.bodyRange } : {}),
  };

  if (split.status === "missing") {
    return {
      ok: false,
      document,
      diagnostics: [makeDiagnostic("FRONTMATTER_MISSING", "文件必须以 UTF-8 frontmatter 的 --- 行开头")],
    };
  }
  if (split.status === "unclosed") {
    return {
      ok: false,
      document,
      diagnostics: [makeDiagnostic("FRONTMATTER_UNCLOSED", "frontmatter 缺少结束的 --- 行")],
    };
  }
  if (split.yamlText === undefined || !split.contentRange || !split.bodyRange) {
    return { ok: false, document, diagnostics: [makeDiagnostic("FRONTMATTER_MISSING", "frontmatter 不完整")] };
  }

  const diagnostics: Diagnostic[] = [];
  const frontmatterRead = readFrontmatter(split.yamlText, split.contentRange.start);
  const raw = frontmatterRead.data;

  // 格式 1 的工作区里混入格式 2 文件时直接说清，而不是报成一连串字段错误。
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if ("nodeId" in record) {
      return {
        ok: false,
        document,
        diagnostics: [
          makeDiagnostic(
            "FORMAT_MIXED",
            "这是格式 2 的单节点文件，不能放进格式 1 工作区；请按工作区格式选择解析方式",
            topicContext(path),
            split.frontmatterRange,
          ),
        ],
      };
    }
    if (!("schemaVersion" in record) && !("nodes" in record) && "topicId" in record) {
      return {
        ok: false,
        document,
        diagnostics: [
          makeDiagnostic(
            "FORMAT_MIXED",
            "这是格式 2 的主题入口，缺少格式 1 的 schemaVersion 与节点清单",
            topicContext(path),
            split.frontmatterRange,
          ),
        ],
      };
    }
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const declaredVersion = (raw as Record<string, unknown>)["schemaVersion"];
    if (declaredVersion !== undefined && declaredVersion !== TOPIC_SCHEMA_VERSION) {
      diagnostics.push(
        makeDiagnostic(
          "SCHEMA_VERSION_UNSUPPORTED",
          "只支持 schemaVersion " + TOPIC_SCHEMA_VERSION + "，收到 " + JSON.stringify(declaredVersion) + "；更高或未知版本需要显式迁移",
          topicContext(path),
          split.frontmatterRange,
        ),
      );
    }
  }
  for (const diagnostic of frontmatterRead.diagnostics) {
    diagnostics.push({ ...diagnostic, topicPath: path });
  }
  if (diagnostics.length > 0) return { ok: false, document, diagnostics };

  const parsed = topicFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const unknownKeys = (issue as { keys?: readonly string[] }).keys;
      const code = issue.code === "unrecognized_keys" ? "SCHEMA_UNKNOWN_FIELD" : "SCHEMA_INVALID";
      const detail = code === "SCHEMA_UNKNOWN_FIELD" && unknownKeys ? "未知字段 " + unknownKeys.join(", ") : issue.message;
      diagnostics.push(
        makeDiagnostic(
          code,
          (issue.path.length > 0 ? issue.path.map(String).join(".") : "(根)") + ": " + detail,
          topicContext(path),
          split.frontmatterRange,
        ),
      );
    }
    return { ok: false, document, diagnostics };
  }
  const frontmatter: TopicFrontmatter = parsed.data;

  const bodyBase = split.bodyRange.start;
  const bodyText = text.slice(bodyBase);
  let root: Root;
  try {
    root = MARKDOWN_PARSER.parse(bodyText) as Root;
  } catch (error) {
    return {
      ok: false,
      document,
      diagnostics: [makeDiagnostic("MARKDOWN_INVALID", "Markdown 无法解析：" + String(error), topicContext(path))],
    };
  }

  const headingIndexes: number[] = [];
  root.children.forEach((node, index) => {
    if (node.type === "heading" && node.depth === 2) headingIndexes.push(index);
  });

  const firstHeadingIndex = headingIndexes[0] ?? root.children.length;
  for (const node of root.children.slice(0, firstHeadingIndex)) {
    if (isFormatComment(node)) continue;
    diagnostics.push(
      makeDiagnostic(
        "CONTENT_BEFORE_FIRST_CARD",
        "首个卡片之前只允许空白和格式注释",
        topicContext(path),
        absoluteRange(node.position, bodyBase),
      ),
    );
  }

  if (headingIndexes.length === 0) {
    diagnostics.push(makeDiagnostic("TOPIC_EMPTY", "主题至少需要一张卡片", topicContext(path)));
    return { ok: false, document, diagnostics };
  }

  interface CardBlock {
    readonly heading: CardHeading;
    readonly blocks: readonly RootContent[];
    readonly nodeRange: SourceRange;
    readonly bodyRange: SourceRange;
  }

  const cards: CardBlock[] = [];
  headingIndexes.forEach((headingIndex, position) => {
    const heading = root.children[headingIndex] as Heading;
    const nextHeadingIndex = headingIndexes[position + 1];
    const headingEnd = bodyBase + (heading.position?.end.offset ?? bodyText.length);
    const nextStart =
      nextHeadingIndex === undefined
        ? text.length
        : bodyBase + (root.children[nextHeadingIndex]?.position?.start.offset ?? bodyText.length);
    const innerBlocks =
      nextHeadingIndex === undefined
        ? root.children.slice(headingIndex + 1)
        : root.children.slice(headingIndex + 1, nextHeadingIndex);

    for (const block of innerBlocks) {
      if (block.type !== "heading" || block.depth > 2) continue;
      diagnostics.push(
        makeDiagnostic(
          "CARD_INTERNAL_HEADING_LEVEL",
          "卡片内部标题只能使用三级及以下标题",
          topicContext(path),
          absoluteRange(block.position, bodyBase),
        ),
      );
    }

    const cardHeading = parseCardHeading(heading, text, bodyBase, path, diagnostics);
    if (!cardHeading) return;
    cards.push({
      heading: cardHeading,
      blocks: innerBlocks,
      nodeRange: { start: cardHeading.headingRange.start, end: nextStart },
      bodyRange: contentRange(text, headingEnd, nextStart),
    });
  });

  if (diagnostics.length > 0) return { ok: false, document, diagnostics };

  const bodyIds = new Set<string>();
  for (const card of cards) {
    if (bodyIds.has(card.heading.id)) {
      diagnostics.push(
        makeDiagnostic(
          "NODE_ID_DUPLICATED",
          "主题内重复出现节点 ID " + card.heading.id,
          { topicPath: path, nodeId: card.heading.id },
          card.heading.headingRange,
        ),
      );
    }
    bodyIds.add(card.heading.id);
  }
  for (const card of cards) {
    if (!(card.heading.id in frontmatter.nodes)) {
      diagnostics.push(
        makeDiagnostic(
          "NODE_META_MISSING",
          "frontmatter 缺少节点 " + card.heading.id + " 的元数据",
          { topicPath: path, nodeId: card.heading.id },
          card.heading.headingRange,
        ),
      );
    }
  }
  for (const id of Object.keys(frontmatter.nodes)) {
    if (bodyIds.has(id)) continue;
    diagnostics.push(
      makeDiagnostic(
        "NODE_BLOCK_MISSING",
        "frontmatter 中的节点 " + id + " 没有对应正文卡片",
        { topicPath: path, topicId: frontmatter.topicId, nodeId: id },
        split.frontmatterRange,
      ),
    );
  }
  if (diagnostics.length > 0) return { ok: false, document, diagnostics };

  const nodes: ParsedNode[] = cards.map((card) => {
    const meta = frontmatter.nodes[card.heading.id];
    if (!meta) throw new Error("节点元数据缺少 " + card.heading.id);
    return {
      id: card.heading.id,
      topicId: frontmatter.topicId,
      topicPath: path,
      sourcePath: path,
      title: card.heading.title,
      body: text.slice(card.bodyRange.start, card.bodyRange.end),
      summary: meta.summary ?? deriveSummary(card.blocks),
      summaryExplicit: meta.summary !== undefined,
      state: meta.state,
      flow: meta.flow,
      from: meta.from,
      ...(meta.side !== undefined ? { side: meta.side } : {}),
      ...(meta.order !== undefined ? { order: meta.order } : {}),
      ...(meta.label !== undefined ? { label: meta.label } : {}),
      important: false,
      ranges: {
        node: card.nodeRange,
        heading: card.heading.headingRange,
        ...(card.heading.titleRange ? { title: card.heading.titleRange } : {}),
        comment: card.heading.commentRange,
        body: card.bodyRange,
      },
    };
  });

  return {
    ok: true,
    document,
    topic: {
      document,
      schemaVersion: TOPIC_SCHEMA_VERSION,
      topicId: frontmatter.topicId,
      title: frontmatter.title,
      sourcePaths: [path],
      nodes,
    },
    diagnostics: [],
  };
}