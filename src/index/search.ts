/**
 * 进程内 Unicode 子串检索，不依赖分词与数据库。
 *
 * 排序：标题精确 > 标题包含 > 摘要包含 > 正文命中；同档次按图的稳定编号顺序。
 * 查询与命中数都有上限，避免一次搜索把整库塞给调用方。
 */
import type { SearchField, SearchHit } from "../shared/protocol.js";
import type { SearchIndex, SearchOutcome, SearchDocument } from "./types.js";

/** 查询最多保留的码点数；超出直接拒绝，由调用方报 400。 */
export const MAX_QUERY_LENGTH = 128;
/** 单次返回的命中上限。 */
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

/**
 * 检索一份索引。空查询返回空结果（调用方仍可返回 200），
 * 结果按 rank、图的稳定顺序排序；超过上限时 truncated=true。
 */
export function searchIndex(index: SearchIndex, rawQuery: string): SearchOutcome {
  const query = normalizeQuery(rawQuery);
  if (query.length === 0) return { hits: [], truncated: false };

  const ranked: RankedHit[] = [];
  index.documents.forEach((document, position) => {
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
  const hits = ranked.slice(0, MAX_SEARCH_RESULTS).map((entry) => entry.hit);
  return { hits, truncated: ranked.length > hits.length };
}
