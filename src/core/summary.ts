import type { RootContent } from "mdast";

/** 派生摘要的上限，按 Unicode 码点计数，避免拆开代理对。 */
export const SUMMARY_MAX_CODE_POINTS = 120;

interface TextNodeLike {
  readonly type: string;
  readonly value?: unknown;
  readonly children?: readonly TextNodeLike[];
}

function nodeText(node: TextNodeLike): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
    case "math":
      return typeof node.value === "string" ? node.value : "";
    case "break":
      return " ";
    case "html":
    case "image":
    case "imageReference":
    case "footnoteReference":
    case "definition":
      return "";
    default:
      return node.children?.map(nodeText).join("") ?? "";
  }
}

/** 提取 Markdown 节点中的可读文字，不生成新结论。 */
export function plainText(node: unknown): string {
  return nodeText(node as TextNodeLike);
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateSummary(value: string, maxCodePoints = SUMMARY_MAX_CODE_POINTS): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maxCodePoints) return value;
  return codePoints.slice(0, maxCodePoints).join("");
}

/**
 * 未显式提供 meta.summary 时，取正文首个段落并截断到 120 个 Unicode 码点。
 * 只复用正文自身，不补充正文没有的判断。
 */
export function deriveSummary(blocks: readonly RootContent[]): string {
  const firstParagraph = blocks.find((block) => block.type === "paragraph");
  const fallback = blocks.find(
    (block) => block.type !== "heading" && block.type !== "thematicBreak",
  );
  const candidate = firstParagraph ?? fallback;
  if (!candidate) return "";
  return truncateSummary(collapseWhitespace(plainText(candidate)));
}
