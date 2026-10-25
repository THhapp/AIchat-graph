/**
 * 格式解析：一节点一份 Markdown。
 *
 * - topic.md 只保存主题身份（topicId、title），正文必须为空白。
 * - 其余 .md 各含一张真实节点；身份来自 nodeId，不取文件名。
 * - 标题只在节点头中维护；正文不要求 H2 卡片标记，内部标题是普通内容。
 * - 所有范围都是该文件原始字符串的 UTF-16 offset，左闭右开；没有注释或 H2 时不伪造。
 */
import { z } from "zod";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root } from "mdast";
import { nodeHeaderSchema, topicHeaderSchema } from "./schema.js";
import type { NodeHeader, TopicHeader } from "./schema.js";
import { makeDiagnostic } from "./diagnostics.js";
import type { Diagnostic } from "./diagnostics.js";
import { contentRange, detectNewlineStyle } from "./newlines.js";
import { readFrontmatter, splitFrontmatter } from "./frontmatter.js";
import { deriveSummary } from "./summary.js";
import type { NodeRanges, ParsedNode, TopicDocument } from "./model.js";

const MARKDOWN_PARSER = unified().use(remarkParse).use(remarkGfm);

export interface TopicParseResult {
  readonly document: TopicDocument;
  readonly header?: TopicHeader | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

export interface NodeParseResult {
  readonly document: TopicDocument;
  readonly header?: NodeHeader | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

interface FrontmatterData {
  readonly document: TopicDocument;
  readonly data?: unknown;
  readonly diagnostics: readonly Diagnostic[];
}

function readDocument(text: string, path: string): FrontmatterData {
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
      document,
      diagnostics: [makeDiagnostic("FRONTMATTER_MISSING", "文件必须以 UTF-8 frontmatter 的 --- 行开头", { topicPath: path })],
    };
  }
  if (split.status === "unclosed") {
    return {
      document,
      diagnostics: [makeDiagnostic("FRONTMATTER_UNCLOSED", "frontmatter 缺少结束的 --- 行", { topicPath: path })],
    };
  }
  if (split.yamlText === undefined || !split.contentRange) {
    return { document, diagnostics: [makeDiagnostic("FRONTMATTER_MISSING", "frontmatter 不完整", { topicPath: path })] };
  }
  const read = readFrontmatter(split.yamlText, split.contentRange.start);
  const diagnostics = read.diagnostics.map((diagnostic) => ({ ...diagnostic, topicPath: path }));
  if (diagnostics.length > 0) return { document, diagnostics };
  return { document, data: read.data, diagnostics: [] };
}

type SafeParseFailure = { success: false; error: { issues: readonly z.core.$ZodIssue[] } };

function schemaIssues(path: string, result: SafeParseFailure): Diagnostic[] {
  return result.error.issues.map((issue) => {
    const code = issue.code === "unrecognized_keys" ? "SCHEMA_UNKNOWN_FIELD" : "SCHEMA_INVALID";
    const unknownKeys = (issue as { keys?: readonly string[] }).keys;
    const detail =
      code === "SCHEMA_UNKNOWN_FIELD" && unknownKeys ? "未知字段 " + unknownKeys.join(", ") : issue.message;
    const where = issue.path.length > 0 ? issue.path.map(String).join(".") : "(根)";
    return makeDiagnostic(code, where + ": " + detail, { topicPath: path });
  });
}

/** 主题入口：只允许 topicId 与 title，正文必须为空白。 */
export function parseTopicDocument(text: string, path: string): TopicParseResult {
  const front = readDocument(text, path);
  if (front.diagnostics.length > 0 || front.data === undefined) {
    return { document: front.document, diagnostics: front.diagnostics };
  }
  const diagnostics: Diagnostic[] = [];
  const record = front.data as Record<string, unknown>;
  if ("schemaVersion" in record || "nodes" in record) {
    diagnostics.push(
      makeDiagnostic("FORMAT_MIXED", "主题入口不得包含 schemaVersion 或 nodes（那是旧格式的写法）", { topicPath: path }),
    );
    return { document: front.document, diagnostics };
  }
  const parsed = topicHeaderSchema.safeParse(front.data);
  if (!parsed.success) {
    return { document: front.document, diagnostics: schemaIssues(path, parsed) };
  }

  const bodyStart = front.document.bodyRange?.start ?? text.length;
  if (text.slice(bodyStart).trim().length > 0) {
    diagnostics.push(
      makeDiagnostic("TOPIC_BODY_NOT_EMPTY", "主题入口文件只保存身份元数据，正文必须留空", { topicPath: path }, {
        start: bodyStart,
        end: text.length,
      }),
    );
  }
  if (diagnostics.length > 0) return { document: front.document, diagnostics };
  return { document: front.document, header: parsed.data, diagnostics: [] };
}

export interface NodeParseContext {
  readonly topicId: string;
  /** 主题入口路径（topic.md），写入 topicPath，便于上层定位主题。 */
  readonly topicPath: string;
  readonly dir: string;
}

/** 单节点：身份与标题来自头，正文是头之后的全部 Markdown。 */
export function parseNodeDocument(text: string, path: string, context: NodeParseContext): NodeParseResult {
  const front = readDocument(text, path);
  if (front.diagnostics.length > 0 || front.data === undefined) {
    return { document: front.document, diagnostics: front.diagnostics };
  }
  const record = front.data as Record<string, unknown>;
  if ("schemaVersion" in record || "nodes" in record || "topicId" in record) {
    return {
      document: front.document,
      diagnostics: [
        makeDiagnostic("FORMAT_MIXED", "节点文件只使用 nodeId/title/state/from/flow 等字段，不含主题头", {
          topicPath: path,
        }),
      ],
    };
  }
  const parsed = nodeHeaderSchema.safeParse(front.data);
  if (!parsed.success) {
    return { document: front.document, diagnostics: schemaIssues(path, parsed) };
  }
  const header = parsed.data;
  const diagnostics: Diagnostic[] = [];
  const isRoot = header.flow === "root";
  if (isRoot) {
    if (header.from !== null) {
      diagnostics.push(
        makeDiagnostic("NODE_ROOT_INVALID", "root 节点的 from 必须为空", { topicPath: path, topicId: context.topicId, nodeId: header.nodeId }),
      );
    }
    if (header.description !== undefined) {
      diagnostics.push(
        makeDiagnostic("NODE_DESCRIPTION_FORBIDDEN", "root 节点不写 description（它没有来源可解释）", {
          topicPath: path,
          topicId: context.topicId,
          nodeId: header.nodeId,
        }),
      );
    }
  } else if (header.description === undefined) {
    diagnostics.push(
      makeDiagnostic("NODE_DESCRIPTION_REQUIRED", "非 root 节点必须写 description，解释为什么接到来源", {
        topicPath: path,
        topicId: context.topicId,
        nodeId: header.nodeId,
      }),
    );
  }
  if (diagnostics.length > 0) return { document: front.document, diagnostics };
  void context.dir;
  return { document: front.document, header, diagnostics: [] };
}

/**
 * 把已通过校验的节点头组装成 ParsedNode。
 * 没有 H2／注释，因此 ranges 只有整文件和正文；node 范围为整个文件。
 */
export function nodeFromDocument(
  document: TopicDocument,
  header: NodeHeader,
  context: NodeParseContext,
): ParsedNode {
  const bodyStart = document.bodyRange?.start ?? document.text.length;
  const body = contentRange(document.text, bodyStart, document.text.length);
  const bodyText = document.text.slice(body.start, body.end);
  const root = MARKDOWN_PARSER.parse(bodyText) as Root;
  const ranges: NodeRanges = {
    node: { start: 0, end: document.text.length },
    body,
  };
  const base: Omit<ParsedNode, "summary" | "summaryExplicit"> = {
    id: header.nodeId,
    topicId: context.topicId,
    topicPath: context.topicPath,
    sourcePath: document.path,
    title: header.title,
    body: bodyText,
    state: header.state,
    flow: header.flow,
    from: header.from,
    ...(header.description !== undefined ? { description: header.description } : {}),
    ...(header.side !== undefined ? { side: header.side } : {}),
    ...(header.order !== undefined ? { order: header.order } : {}),
    important: header.important === true,
    ranges,
  };
  if (header.summary !== undefined) {
    return { ...base, summary: header.summary, summaryExplicit: true };
  }
  return { ...base, summary: deriveSummary(root.children), summaryExplicit: false };
}
