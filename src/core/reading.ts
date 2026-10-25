/**
 * 有界正文读取与章节定位的纯 helper（core，无 IO）。
 *
 * 与 CLI 现有的 text helper 接口一致，但章节由 Markdown AST 识别：
 * 代码围栏里的 "# 标题" 不会被当成章节；缩进 0–3 格的 ATX 标题也能识别。
 * 单位固定为 UTF-16 code unit，与源码范围一致；绝不切断代理对。
 * truncated 统一为 start > 0 || end < total，避免把"从中间读到底"误当成全文。
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Heading, Root, RootContent } from "mdast";

export const DEFAULT_READ_LENGTH = 4000;
export const MAX_READ_SEGMENT = 16000;

export interface BodyRange {
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly unit: "utf16";
}

export interface BodySegment {
  readonly text: string;
  readonly range: BodyRange;
  readonly truncated: boolean;
}

export interface SliceOptions {
  readonly start?: number | undefined;
  readonly length?: number | undefined;
  /** 忽略 length，返回全文。 */
  readonly full?: boolean | undefined;
}

export interface SectionLocation {
  /** 该章节标题在正文中的起始偏移（标题行首）。 */
  readonly start: number;
  readonly title: string;
  readonly level: number;
  /** 第几个匹配（0 起）；重名时必须靠它或显式偏移消歧。 */
  readonly index: number;
}

const MARKDOWN_PARSER = unified().use(remarkParse).use(remarkGfm);

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 若 start 落在代理对中间，向前退一格。 */
function alignStart(text: string, start: number): number {
  if (start <= 0) return 0;
  if (start >= text.length) return text.length;
  return isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))
    ? start - 1
    : start;
}

/** 若 end 落在代理对中间，向后收一格（宁可多含一个码点，也不切开它）。 */
function alignEnd(text: string, end: number): number {
  if (end >= text.length) return text.length;
  if (end <= 0) return 0;
  return isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))
    ? end + 1
    : end;
}

/** 把请求长度规范到 1..MAX_READ_SEGMENT；--full 由调用方另行处理。 */
export function normalizeLength(length: number | undefined): number {
  if (length === undefined) return DEFAULT_READ_LENGTH;
  if (!Number.isInteger(length) || length < 1) {
    // 非法长度是参数错误，不是内部错误：消息里给出有效范围，调用方无需猜。
    throw new RangeError(
      "length 必须是 1-" + String(MAX_READ_SEGMENT) + " 之间的整数，收到 " + String(length),
    );
  }
  return Math.min(length, MAX_READ_SEGMENT);
}

function truncatedBetween(total: number, start: number, end: number): boolean {
  return start > 0 || end < total;
}

/** 按 UTF-16 偏移截取正文片段，并给出 range/truncated。 */
export function sliceBody(text: string, options: SliceOptions = {}): BodySegment {
  const total = text.length;
  const requestedStart = options.start ?? 0;
  if (!Number.isInteger(requestedStart) || requestedStart < 0) {
    throw new RangeError("start 必须是非负整数: " + String(requestedStart));
  }
  const start = alignStart(text, Math.min(requestedStart, total));
  if (options.full) {
    return {
      text: text.slice(start),
      range: { start, end: total, total, unit: "utf16" },
      truncated: truncatedBetween(total, start, total),
    };
  }
  const length = normalizeLength(options.length);
  const end = alignEnd(text, Math.min(start + length, total));
  return {
    text: text.slice(start, end),
    range: { start, end, total, unit: "utf16" },
    truncated: truncatedBetween(total, start, end),
  };
}

function headingTitle(heading: Heading): string {
  const pieces: string[] = [];
  const walk = (node: RootContent | Heading["children"][number]): void => {
    if (node.type === "text" || node.type === "inlineCode") {
      pieces.push(node.value);
      return;
    }
    if (node.type === "html" || node.type === "image" || node.type === "imageReference") {
      if (node.type === "image" || node.type === "imageReference") pieces.push(node.alt ?? "");
      return;
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) walk(child as Heading["children"][number]);
    }
  };
  for (const child of heading.children) walk(child);
  return pieces.join("").replace(/\s+/g, " ").trim();
}

interface RawSection {
  readonly offset: number;
  readonly level: number;
  readonly title: string;
}

/**
 * 用 AST 找正文顶层标题。只取 root 的直接 heading 子节点：
 * 围栏代码块内的 "#" 属于 code 节点，天然不会被计入。
 */
function sectionsOf(text: string): RawSection[] {
  if (text.length === 0) return [];
  let root: Root;
  try {
    root = MARKDOWN_PARSER.parse(text) as Root;
  } catch {
    return [];
  }
  const sections: RawSection[] = [];
  for (const node of root.children) {
    if (node.type !== "heading") continue;
    const offset = node.position?.start?.offset;
    if (typeof offset !== "number") continue;
    sections.push({ offset, level: node.depth, title: headingTitle(node) });
  }
  return sections;
}

/**
 * 按标题定位章节：默认要求唯一匹配；重名时用 index 明确选第几个，
 * 不猜测"大概就是这个"。找不到时抛出 RangeError，由调用方转成明确错误。
 */
export function locateSection(text: string, title: string, index?: number): SectionLocation {
  const wanted = title.trim();
  const matches = sectionsOf(text).filter((section) => section.title === wanted);
  if (matches.length === 0) {
    throw new RangeError("正文里没有标题为「" + wanted + "」的章节");
  }
  if (index === undefined) {
    if (matches.length > 1) {
      throw new RangeError(
        "标题「" + wanted + "」出现 " + String(matches.length) + " 次；请用 --section-index 指定第几个（0 起）",
      );
    }
    const only = matches[0] as RawSection;
    return { start: only.offset, title: wanted, level: only.level, index: 0 };
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError("--section-index 必须是非负整数: " + String(index));
  }
  // index 指"同名标题中的第几个"，不是全文标题的序号。
  const chosen = matches[index];
  if (!chosen) {
    throw new RangeError(
      "--section-index " + String(index) + " 超出范围；标题「" + wanted + "」共出现 " + String(matches.length) + " 次",
    );
  }
  return { start: chosen.offset, title: wanted, level: chosen.level, index };
}
