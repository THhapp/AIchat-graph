/**
 * search：从磁盘快照构造检索文档，复用 index 模块的匹配、排序与 snippet。
 *
 * 快照只负责提供当前版本的真实节点文件与正文；检索规则（字段优先级、
 * Unicode 码点、片段半径）统一以 index/search 为准，CLI 不再维护第二套实现。
 */
import { searchDocuments, SearchQueryError } from "../index/index.js";
import type { SearchDocument } from "../index/index.js";
import { parseOptions } from "./args.js";
import type { CliContext } from "./context.js";
import { EXIT_CODES, UsageError, invalidArgument } from "./errors.js";
import { OUTPUT_OPTIONS, WORKSPACE_OPTION, parseIntegerOption } from "./options.js";
import { emit, parseOutputMode } from "./output.js";
import { briefUsage } from "./usage.js";
import { loadWorkspace, workspaceRoot } from "./workspace.js";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

export async function runSearch(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(
    args,
    [
      WORKSPACE_OPTION,
      { name: "topic" },
      { name: "limit" },
      { name: "page" },
      ...OUTPUT_OPTIONS,
    ],
    1,
  );
  const mode = parseOutputMode(parsed);
  const query = parsed.positional[0]?.trim();
  if (query === undefined || query.length === 0) {
    throw new UsageError("缺少搜索词\n\n" + briefUsage("search"));
  }
  const limit =
    parsed.values.get("limit") === undefined
      ? DEFAULT_SEARCH_LIMIT
      : parseIntegerOption(parsed.values.get("limit"), "--limit", {
          min: 1,
          max: MAX_SEARCH_LIMIT,
          required: true,
        });
  const page =
    parsed.values.get("page") === undefined
      ? 0
      : parseIntegerOption(parsed.values.get("page"), "--page", {
          min: 0,
          max: 10_000,
          required: true,
        });

  const root = await workspaceRoot(parsed, ctx);
  const snapshot = await loadWorkspace(root);
  const topicId = parsed.values.get("topic");
  if (topicId !== undefined && !snapshot.topics.some((topic) => topic.topic.topicId === topicId)) {
    throw invalidArgument("--topic 必须是现有主题的稳定 topicId：" + topicId);
  }

  const documents: SearchDocument[] = [];
  const fileHashes = new Map<string, string>();
  for (const topic of snapshot.topics) {
    if (topicId !== undefined && topic.topic.topicId !== topicId) continue;
    for (const entry of topic.nodes) {
      const node = entry.node;
      documents.push({
        id: node.id,
        topicId: node.topicId,
        title: node.title,
        summary: node.summary,
        number: snapshot.nodeNumbers.get(node.id) ?? "",
        path: entry.path,
        body: node.body,
      });
      fileHashes.set(node.id, entry.file.sha256);
    }
  }

  let outcome;
  try {
    outcome = searchDocuments(documents, query, { limit, offset: page * limit });
  } catch (error) {
    // 查询长度等规则由 index 模块统一裁决；CLI 用法错误保持退出码 2。
    if (error instanceof SearchQueryError) throw new UsageError(error.message);
    throw error;
  }

  const pageHits = outcome.hits.map((hit) => ({
    ...hit,
    fileHash: fileHashes.get(hit.nodeId) ?? "",
  }));
  const payload = {
    ok: snapshot.ok,
    command: "search",
    source: "disk",
    root: snapshot.root,
    query,
    hits: pageHits,
    page,
    limit,
    totalHits: outcome.totalHits,
    hasMore: outcome.truncated,
    truncated: outcome.truncated,
    diagnostics: snapshot.diagnostics,
  };
  const lines = [
    `${outcome.totalHits} hit(s) for "${query}" (page ${page}, limit ${limit})`,
  ];
  for (const hit of pageHits) {
    lines.push(`  ${hit.nodeId} ${hit.path} [${hit.field}] ${hit.title}`);
    if (hit.snippet) lines.push(`    ${hit.snippet}`);
  }
  if (payload.hasMore) lines.push(`  … use --page ${page + 1} for more`);
  emit(ctx, mode, payload, lines);
  return snapshot.ok ? EXIT_CODES.ok : EXIT_CODES.validation;
}
