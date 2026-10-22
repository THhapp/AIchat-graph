import { isMap, isPair, isSeq, parseDocument } from "yaml";
import type { Node as YamlNode } from "yaml";
import { makeDiagnostic } from "./diagnostics.js";
import type { Diagnostic, SourceRange } from "./diagnostics.js";
import { lineBounds } from "./newlines.js";

const FRONTMATTER_FENCE = "---";
const STANDARD_YAML_TAG_PREFIX = "tag:yaml.org,2002:";

export type FrontmatterStatus = "ok" | "missing" | "unclosed";

export interface FrontmatterSplit {
  readonly bom: boolean;
  readonly status: FrontmatterStatus;
  readonly frontmatterRange?: SourceRange | undefined;
  readonly contentRange?: SourceRange | undefined;
  readonly bodyRange?: SourceRange | undefined;
  readonly yamlText?: string | undefined;
}

/** 只识别文件头部的 frontmatter；正文中的 --- 不会被当作分隔符。 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const bom = text.startsWith("\uFEFF");
  const start = bom ? 1 : 0;
  const firstLine = lineBounds(text, start);
  if (text.slice(start, firstLine.end).trimEnd() !== FRONTMATTER_FENCE) {
    return { bom, status: "missing" };
  }

  let cursor = firstLine.next;
  while (cursor < text.length) {
    const line = lineBounds(text, cursor);
    if (text.slice(cursor, line.end).trimEnd() === FRONTMATTER_FENCE) {
      const contentRange = { start: firstLine.next, end: cursor };
      return {
        bom,
        status: "ok",
        frontmatterRange: { start, end: line.end },
        contentRange,
        bodyRange: { start: line.next, end: text.length },
        yamlText: text.slice(contentRange.start, contentRange.end),
      };
    }
    cursor = line.next;
  }
  return { bom, status: "unclosed" };
}

function offsetFromLineColumn(text: string, line: number, column: number): number {
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) return text.length;
    offset = newline + 1;
    currentLine += 1;
  }
  return Math.min(offset + Math.max(column - 1, 0), text.length);
}

function yamlErrorRange(yamlText: string, yamlBase: number, linePos: unknown): SourceRange | undefined {
  if (!Array.isArray(linePos)) return undefined;
  const first = linePos[0] as { line?: unknown; col?: unknown } | undefined;
  if (!first || typeof first.line !== "number" || typeof first.col !== "number") return undefined;
  const start = yamlBase + offsetFromLineColumn(yamlText, first.line, first.col);
  return { start, end: Math.min(start + 1, yamlBase + yamlText.length) };
}

function findCustomTag(node: YamlNode): string | undefined {
  const tag = (node as { tag?: unknown }).tag;
  if (typeof tag === "string" && !tag.startsWith(STANDARD_YAML_TAG_PREFIX)) return tag;
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isPair(pair)) continue;
      const keyTag = findCustomTag(pair.key as YamlNode);
      if (keyTag) return keyTag;
      if (pair.value) {
        const valueTag = findCustomTag(pair.value as YamlNode);
        if (valueTag) return valueTag;
      }
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      if (!item) continue;
      const found = findCustomTag(item as YamlNode);
      if (found) return found;
    }
  }
  return undefined;
}

export interface YamlReadResult {
  readonly data?: unknown;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * 受限 YAML：core schema、唯一键、严格模式、不接受自定义标签。
 * 只返回普通数据，字段白名单交给 zod schema。
 */
export function readFrontmatter(yamlText: string, yamlBase: number): YamlReadResult {
  if (yamlText.trim().length === 0) {
    return { diagnostics: [makeDiagnostic("FRONTMATTER_EMPTY", "frontmatter 不能为空")] };
  }

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(yamlText, {
      schema: "core",
      uniqueKeys: true,
      strict: true,
      customTags: [],
      version: "1.2",
    });
  } catch (error) {
    return { diagnostics: [makeDiagnostic("YAML_INVALID", "frontmatter 无法解析：" + String(error))] };
  }

  const diagnostics: Diagnostic[] = [];
  for (const error of document.errors) {
    const code =
      (error as { code?: string }).code === "DUPLICATE_KEY" ? "YAML_DUPLICATE_KEY" : "YAML_INVALID";
    diagnostics.push(
      makeDiagnostic(
        code,
        error.message.split("\n")[0] ?? "frontmatter YAML 解析失败",
        {},
        yamlErrorRange(yamlText, yamlBase, (error as { linePos?: unknown }).linePos),
      ),
    );
  }
  for (const warning of document.warnings) {
    if ((warning as { code?: string }).code !== "TAG_RESOLVE_FAILED") continue;
    diagnostics.push(
      makeDiagnostic(
        "YAML_CUSTOM_TAG",
        warning.message.split("\n")[0] ?? "frontmatter 使用了不支持的自定义标签",
        {},
        yamlErrorRange(yamlText, yamlBase, (warning as { linePos?: unknown }).linePos),
      ),
    );
  }
  if (diagnostics.length > 0) return { diagnostics };
  if (!document.contents) {
    return { diagnostics: [makeDiagnostic("FRONTMATTER_EMPTY", "frontmatter 不能为空")] };
  }

  const customTag = findCustomTag(document.contents);
  if (customTag) {
    return { diagnostics: [makeDiagnostic("YAML_CUSTOM_TAG", "frontmatter 不接受自定义标签 " + customTag)] };
  }

  let data: unknown;
  try {
    data = document.toJS({ maxAliasCount: 20 });
  } catch (error) {
    return { diagnostics: [makeDiagnostic("YAML_INVALID", "frontmatter 无法转为普通数据：" + String(error))] };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { diagnostics: [makeDiagnostic("FRONTMATTER_NOT_MAPPING", "frontmatter 必须是键值映射")] };
  }
  return { data, diagnostics: [] };
}
