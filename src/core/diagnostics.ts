/** 统一的源码范围：原始解码字符串的 UTF-16 offset，左闭右开，可直接用于 String.prototype.slice。 */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export type DiagnosticCode =
  | "FRONTMATTER_MISSING"
  | "FRONTMATTER_UNCLOSED"
  | "FRONTMATTER_EMPTY"
  | "FRONTMATTER_NOT_MAPPING"
  | "YAML_INVALID"
  | "YAML_DUPLICATE_KEY"
  | "YAML_CUSTOM_TAG"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "SCHEMA_INVALID"
  | "SCHEMA_UNKNOWN_FIELD"
  | "WORKSPACE_SCHEMA_INVALID"
  | "WORKSPACE_VERSION_UNSUPPORTED"
  | "FORMAT_MIXED"
  | "DOCUMENT_PATH_INVALID"
  | "DUPLICATE_DOCUMENT_PATH"
  | "V2_ORPHAN_DOCUMENT"
  | "V2_TOPIC_MISSING"
  | "V2_TOPIC_BODY_NOT_EMPTY"
  | "NODE_DESCRIPTION_REQUIRED"
  | "NODE_DESCRIPTION_FORBIDDEN"
  | "CARD_MISSING_NODE_COMMENT"
  | "CARD_INVALID_NODE_COMMENT"
  | "CARD_DUPLICATE_NODE_COMMENT"
  | "CARD_VISIBLE_TEXT_AFTER_COMMENT"
  | "CARD_TITLE_EMPTY"
  | "CARD_INTERNAL_HEADING_LEVEL"
  | "CONTENT_BEFORE_FIRST_CARD"
  | "TOPIC_EMPTY"
  | "MARKDOWN_INVALID"
  | "NODE_ID_DUPLICATED"
  | "TOPIC_ID_DUPLICATED"
  | "NODE_BLOCK_MISSING"
  | "NODE_META_MISSING"
  | "NODE_ROOT_INVALID"
  | "NODE_ROOT_MISSING"
  | "NODE_ROOT_MULTIPLE"
  | "NODE_FROM_MISSING"
  | "NODE_FROM_UNKNOWN"
  | "NODE_SELF_LINK"
  | "NODE_FLOW_FIELD_INVALID"
  | "NODE_NEXT_MULTIPLE"
  | "NODE_BRANCH_ORDER_DUPLICATED"
  | "NODE_UNREACHABLE"
  | "GRAPH_CYCLE"
  | "GRAPH_STRUCTURE_INCOMPLETE"
  | "FOCUS_NODE_UNKNOWN"
  | "SOURCE_POSITION_MISSING";

export interface DiagnosticContext {
  readonly topicPath?: string | undefined;
  readonly topicId?: string | undefined;
  readonly nodeId?: string | undefined;
}

export interface Diagnostic extends DiagnosticContext {
  readonly code: DiagnosticCode;
  /** 面向人的简短原因；不依赖 UI 文案。 */
  readonly message: string;
  /** 与错误直接对应的源码范围；文件级错误可能省略。 */
  readonly range?: SourceRange | undefined;
}

export function makeDiagnostic(
  code: DiagnosticCode,
  message: string,
  context: DiagnosticContext = {},
  range?: SourceRange | undefined,
): Diagnostic {
  return { code, message, ...context, ...(range ? { range } : {}) };
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.topicPath ?? diagnostic.topicId ?? "workspace";
  const node = diagnostic.nodeId ? " node=" + diagnostic.nodeId : "";
  const where = diagnostic.range ? " @" + diagnostic.range.start + "-" + diagnostic.range.end : "";
  return diagnostic.code + " " + location + node + where + ": " + diagnostic.message;
}