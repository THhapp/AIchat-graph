/**
 * 进程内 Unicode 子串检索，不依赖分词与数据库。
 *
 * 排序：标题精确 > 标题包含 > 摘要包含 > 正文命中；同档次按文档顺序。
 * searchIndex 是服务端索引的薄包装，CLI 等其他调用方直接传文档数组，
 * 共用同一套匹配、排序与 snippet 规则。
 */
import type { SearchField, SearchHit } from "../shared/protocol.js";
import type {
  SearchIndex,
  SearchOutcome,
  SearchDocument,
  SearchDocumentsOptions,
} from "./types.js";

/** 查询最多保留的码点数；超出直接拒绝，由调用方报 400。 */
export const MAX_QUERY_LENGTH = 128;
/** 服务端索引单次返回的命中上限。 */
export const MAX_SEARCH_RESULTS = 50;
/** 摘要片段在命中位置前后各保留的码点数。 */
const SNIPPET_RADIUS = 40;

export class SearchQueryError extends Error {
  readonly code = "BAD_REQUEST";
  constructor(message: string) {
    super(message);
    this.name = "SearchQueryError";
  }
}

export type SearchMatchField = SearchField;

interface RankedHit {
  readonly rank: number;
  readonly index: number;
  readonly hit: SearchHit;
}

function normalizeQuery(raw: string): string {
  const trimmed = raw.trim();
  if (Array.from(trimmed).length > MAX_QUERY_LENGTH) {
    throw new SearchQueryError("搜索关键词过长，最多 " + MAX_QUERY_LENGTH + " 个字符");
  }
  return trimmed;
}

function locate(haystack: string, needle: string): number {
  return haystack.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
}

/** 以码点安全的方式截取命中附近的片段，避免拆开代理对。 */
function snippetAround(text: string, matchOffset: number, length: number): string {
  const codePoints = Array.from(text);
  const codePointIndex = Array.from(text.slice(0, matchOffset)).length;
  const total = length > 0 ? Array.from(text.slice(matchOffset, matchOffset + length)).length : 0;
  const start = Math.max(0, codePointIndex - SNIPPET_RADIUS);
  const end = Math.min(codePoints.length, codePointIndex + total + SNIPPET_RADIUS);
  const slice = codePoints.slice(start, end).join("").replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + slice + (end < codePoints.length ? "…" : "");
}

function matchField(document: SearchDocument, query: string): { field: SearchField; rank: number; offset: number; length: number } | null {
  const lowered = query.toLocaleLowerCase();
  const titleLower = document.title.toLocaleLowerCase();
  if (titleLower === lowered) {
    return { field: "title", rank: 0, offset: 0, length: document.title.length };
  }
  const titleIndex = titleLower.indexOf(lowered);
  if (titleIndex >= 0) {
    return { field: "title", rank: 1, offset: titleIndex, length: query.length };
  }
  const summaryIndex = locate(document.summary, query);
  if (summaryIndex >= 0) {
    return { field: "summary", rank: 2, offset: summaryIndex, length: query.length };
  }
  const bodyIndex = locate(document.body, query);
  if (bodyIndex >= 0) {
    return { field: "body", rank: 3, offset: bodyIndex, length: query.length };
  }
  return null;
}

function normalizeBound(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(name + " 必须是非负整数");
  }
  return value;
}

/**
 * 检索一组文档。空查询返回空结果（调用方仍可返回 200）。
 * 命中先按 rank、再按文档顺序排序；offset/limit 切出返回窗口，
 * totalHits 是全部命中数，truncated 表示窗口之后仍有命中。
 */
export function searchDocuments(
  documents: readonly SearchDocument[],
  rawQuery: string,
  options: SearchDocumentsOptions = {},
): SearchOutcome {
  const query = normalizeQuery(rawQuery);
  if (query.length === 0) return { hits: [], totalHits: 0, truncated: false };

  const ranked: RankedHit[] = [];
  documents.forEach((document, position) => {
    const match = matchField(document, query);
    if (match === null) return;
    const source = match.field === "title" ? document.title : match.field === "summary" ? document.summary : document.body;
    ranked.push({
      rank: match.rank,
      index: position,
      hit: {
        nodeId: document.id,
        topicId: document.topicId,
        title: document.title,
        path: document.path,
        snippet: snippetAround(source, match.offset, match.length),
        field: match.field,
      },
    });
  });

  ranked.sort((left, right) => (left.rank !== right.rank ? left.rank - right.rank : left.index - right.index));
  const offset = normalizeBound(options.offset, "offset") ?? 0;
  const limit = normalizeBound(options.limit, "limit");
  const end = limit === undefined ? ranked.length : offset + limit;
  const hits = ranked.slice(offset, end).map((entry) => entry.hit);
  return { hits, totalHits: ranked.length, truncated: offset + hits.length < ranked.length };
}

/** 服务端索引检索：默认最多返回 50 条。 */
export function searchIndex(index: SearchIndex, rawQuery: string): SearchOutcome {
  return searchDocuments(index.documents, rawQuery, { limit: MAX_SEARCH_RESULTS });
}
