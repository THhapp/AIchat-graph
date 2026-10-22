/**
 * 离线只读命令：init／serve／topics／search／read／validate。
 *
 * 所有读取都直接来自真实磁盘（storage 扫描 + core 分组解析），
 * 不使用缓存快照；默认返回有界片段，显式 --full 才取全文。
 */
import path from "node:path";
import { initWorkspace, resolveWorkspaceRoot } from "../storage/index.js";
import { parseOptions, type ParsedArgs } from "./args.js";
import type { CliContext, ServiceHandleLike, StartServiceLike } from "./context.js";
import { CliError, EXIT_CODES, UsageError } from "./errors.js";
import { emitJson, emitText } from "./output.js";
import { DEFAULT_PORT, resolveServiceForWorkspace } from "./service-client.js";
import { readAgentNode } from "./agent-client.js";
import { normalizeLength, sliceBody, locateSection } from "./text.js";
import { briefUsage } from "./usage.js";
import {
  describeNode,
  describeTopic,
  fileFacts,
  findNode,
  findTopicById,
  findTopicByPath,
  loadWorkspace,
  topicEntryFile,
  validateSnapshot,
  type NodeEntry,
  type TopicEntry,
  type WorkspaceSnapshot,
} from "./workspace.js";

export const OUTPUT_OPTIONS = [
  { name: "json", boolean: true },
  { name: "text", boolean: true },
] as const;

export function parseOutputMode(parsed: ParsedArgs): "json" | "text" {
  if (parsed.values.has("text") && parsed.values.has("json")) {
    throw new UsageError("--json 与 --text 不能同时使用");
  }
  return parsed.values.has("text") ? "text" : "json";
}

/**
 * 解析 --workspace；省略时使用当前目录，与生成的 AGENTS.md 里
 * "aichat read --topic <id>／aichat validate" 的简短写法一致。
 */
export async function workspaceRoot(parsed: ParsedArgs, ctx: CliContext): Promise<string> {
  const requested = parsed.values.get("workspace");
  const target = requested === undefined ? ctx.cwd : path.resolve(ctx.cwd, requested);
  return resolveWorkspaceRoot(target);
}

export function invalidArgument(message: string, details?: Record<string, unknown>): CliError {
  return new CliError("INVALID_ARGUMENT", message, EXIT_CODES.usage, {
    ...(details ? { details } : {}),
  });
}

/** 输出 JSON 或简短文本；不改变已计算的事实。 */
export function emit(ctx: CliContext, mode: "json" | "text", payload: unknown, lines: string[]): void {
  if (mode === "text") emitText(ctx, lines);
  else emitJson(ctx, payload);
}

/* ---------------------------------- init ---------------------------------- */

export async function runInit(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(
    args,
    [{ name: "name" }, { name: "workspace" }, { name: "format" }, ...OUTPUT_OPTIONS],
    1,
  );
  const mode = parseOutputMode(parsed);
  const positional = parsed.positional[0];
  const optionPath = parsed.values.get("workspace");
  if (positional !== undefined && optionPath !== undefined) {
    throw new UsageError("init 的路径只能给出一次（位置参数或 --workspace）");
  }
  const requested = positional ?? optionPath;
  if (requested === undefined) {
    throw new UsageError("缺少初始化路径\n\n" + briefUsage("init"));
  }
  const formatRaw = parsed.values.get("format");
  if (formatRaw !== undefined && formatRaw !== "2" && formatRaw !== "1") {
    throw invalidArgument(`--format 只接受 1 或 2: ${formatRaw}`);
  }
  const root = path.resolve(ctx.cwd, requested);
  const name = parsed.values.get("name");
  const result = await initWorkspace({
    root,
    ...(name !== undefined ? { name } : {}),
    ...(formatRaw === undefined ? {} : { schemaVersion: Number(formatRaw) as 1 | 2 }),
  });
  // 格式版本以写入磁盘的真实 workspace.json 为准，不在 CLI 里重复默认值。
  const created = await loadWorkspace(result.root);
  const payload = {
    ok: true,
    command: "init",
    root: result.root,
    workspaceId: result.workspaceId,
    schemaVersion: created.schemaVersion,
    topicMode: created.workspace?.topicMode ?? "shared",
    name: name ?? path.basename(result.root),
    files: result.files,
  };
  emit(ctx, mode, payload, [
    `initialized ${result.root} (schemaVersion ${created.schemaVersion ?? "?"})`,
    `workspaceId ${result.workspaceId}`,
    ...result.files.map((file) => `  ${file.path}  ${file.sha256}`),
  ]);
  return EXIT_CODES.ok;
}

/* ---------------------------------- serve --------------------------------- */

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw)) throw invalidArgument(`--port 必须是整数: ${raw}`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalidArgument(`--port 必须在 1-65535 之间: ${raw}`);
  }
  return port;
}

async function loadStartService(ctx: CliContext): Promise<StartServiceLike> {
  if (ctx.startService) return ctx.startService;
  const moduleSpecifier: string = "../service/index.js";
  let serviceModule: { startService?: StartServiceLike };
  try {
    serviceModule = (await import(moduleSpecifier)) as { startService?: StartServiceLike };
  } catch (error) {
    throw new CliError(
      "SERVICE_UNAVAILABLE",
      "本地服务模块不可用（无法加载 dist/service/index.js）；请先构建服务模块",
      EXIT_CODES.service,
      { details: { module: "dist/service/index.js" }, cause: error },
    );
  }
  if (typeof serviceModule.startService !== "function") {
    throw new CliError(
      "SERVICE_UNAVAILABLE",
      "无法加载本地服务模块（dist/service/index.js 未导出 startService）",
      EXIT_CODES.service,
    );
  }
  return serviceModule.startService;
}

function waitForShutdown(ctx: CliContext): Promise<void> {
  if (ctx.shutdownSignal) {
    if (ctx.shutdownSignal.aborted) return Promise.resolve();
    const signal = ctx.shutdownSignal;
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
  });
}

export async function runServe(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(
    args,
    [{ name: "workspace" }, { name: "port" }, ...OUTPUT_OPTIONS],
    0,
  );
  const mode = parseOutputMode(parsed);
  if (!parsed.values.has("workspace")) {
    throw new UsageError("serve 必须显式给出 --workspace\n\n" + briefUsage("serve"));
  }
  const root = await workspaceRoot(parsed, ctx);
  const port = parsePort(parsed.values.get("port"));
  const startService = await loadStartService(ctx);
  let handle: ServiceHandleLike;
  try {
    handle = await startService({ root, ...(port !== undefined ? { port } : {}) });
  } catch (error) {
    throw new CliError(
      "SERVICE_START_FAILED",
      `服务启动失败: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.service,
      { details: { root }, cause: error },
    );
  }
  const payload = {
    ok: true,
    command: "serve",
    url: handle.url,
    workspaceId: handle.workspaceId,
    instanceId: handle.instanceId,
    rootPath: handle.rootPath,
    port: Number(new URL(handle.url).port || DEFAULT_PORT),
    pid: process.pid,
    state: "serving",
  };
  emit(ctx, mode, payload, [
    `serving ${handle.url}`,
    `workspace ${handle.workspaceId} ${handle.rootPath}`,
    "press Ctrl+C to stop",
  ]);
  await waitForShutdown(ctx);
  try {
    await handle.stop();
  } catch (error) {
    throw new CliError(
      "SERVICE_STOP_FAILED",
      `服务停止失败: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.service,
      { details: { url: handle.url }, cause: error },
    );
  }
  if (mode === "text") emitText(ctx, ["stopped"]);
  return EXIT_CODES.ok;
}

/* --------------------------------- topics --------------------------------- */

export async function runTopics(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(args, [{ name: "workspace" }, ...OUTPUT_OPTIONS], 0);
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const snapshot = await loadWorkspace(root);
  const topics = snapshot.topics.map((entry) => describeTopic(snapshot, entry));
  const payload = {
    ok: snapshot.ok,
    command: "topics",
    source: "disk",
    root: snapshot.root,
    schemaVersion: snapshot.schemaVersion,
    topicMode: snapshot.workspace?.topicMode ?? "shared",
    workspace: snapshot.workspace,
    workspaceFile: fileFacts(snapshot.files.workspaceFile),
    topics,
    topicCount: topics.length,
    diagnostics: snapshot.diagnostics,
  };
  const lines = [
    `workspace ${snapshot.workspace?.workspaceId ?? "(unreadable)"} ${snapshot.workspace?.name ?? ""}`,
    `schemaVersion ${snapshot.schemaVersion ?? "unknown"}; topicMode ${payload.topicMode}; ${topics.length} topic(s)`,
  ];
  for (const topic of topics) {
    lines.push(`  ${topic.topicId}  ${topic.title}  dir=${topic.dir ?? "-"}  nodes=${topic.nodeCount}`);
    lines.push(`    entry ${topic.path}  ${topic.sha256 ?? ""}`);
  }
  for (const diagnostic of snapshot.diagnostics) {
    lines.push(`  [${diagnostic.code}] ${diagnostic.topicPath ?? ""} ${diagnostic.message}`);
  }
  emit(ctx, mode, payload, lines);
  return snapshot.ok ? EXIT_CODES.ok : EXIT_CODES.validation;
}

/* --------------------------------- search --------------------------------- */

const SNIPPET_RADIUS = 60;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;

function snippetAround(text: string, query: string): string {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index === -1) return "";
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + query.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

interface SearchHit {
  readonly nodeId: string;
  readonly topicId: string;
  readonly title: string;
  readonly path: string;
  readonly fileHash: string;
  readonly field: "title" | "summary" | "body";
  readonly snippet: string;
  readonly rank: number;
}

function isSafeInt(raw: string | undefined, label: string, min: number, max: number): number {
  if (raw === undefined) throw new UsageError("缺少 " + label);
  if (!/^[0-9]+$/.test(raw)) throw invalidArgument(`${label} 必须是非负整数: ${raw}`);
  const value = Number(raw);
  if (value < min || value > max) {
    throw invalidArgument(`${label} 必须在 ${min}-${max} 之间: ${raw}`);
  }
  return value;
}

export async function runSearch(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(
    args,
    [{ name: "workspace" }, { name: "topic" }, { name: "limit" }, { name: "page" }, ...OUTPUT_OPTIONS],
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
      : isSafeInt(parsed.values.get("limit"), "--limit", 1, MAX_SEARCH_LIMIT);
  const page =
    parsed.values.get("page") === undefined
      ? 0
      : isSafeInt(parsed.values.get("page"), "--page", 0, 10_000);

  const root = await workspaceRoot(parsed, ctx);
  const snapshot = await loadWorkspace(root);
  const topicId = parsed.values.get("topic");
  if (topicId !== undefined && !snapshot.topics.some((topic) => topic.topic.topicId === topicId)) {
    throw invalidArgument("--topic 必须是现有主题的稳定 topicId：" + topicId);
  }
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const topic of snapshot.topics) {
    if (topicId !== undefined && topic.topic.topicId !== topicId) continue;
    for (const entry of topic.nodes) {
      const node = entry.node;
      const titleLower = node.title.toLowerCase();
      const titleExact = titleLower === needle;
      const titleHit = !titleExact && titleLower.includes(needle);
      const summaryHit = !titleHit && !titleExact && node.summary.toLowerCase().includes(needle);
      const bodyHit =
        !titleHit && !titleExact && !summaryHit && node.body.toLowerCase().includes(needle);
      if (!titleExact && !titleHit && !summaryHit && !bodyHit) continue;
      const field = titleExact || titleHit ? "title" : summaryHit ? "summary" : "body";
      hits.push({
        nodeId: node.id,
        topicId: node.topicId,
        title: node.title,
        path: entry.path,
        fileHash: entry.file.sha256,
        field,
        snippet: field === "body" ? snippetAround(node.body, query) : node.summary,
        rank: titleExact ? 0 : titleHit ? 1 : summaryHit ? 2 : 3,
      });
    }
  }
  hits.sort((left, right) => {
    const byRank = left.rank - right.rank;
    if (byRank !== 0) return byRank;
    const byPath = left.path.localeCompare(right.path);
    return byPath !== 0 ? byPath : left.nodeId.localeCompare(right.nodeId);
  });
  const start = page * limit;
  const pageHits = hits.slice(start, start + limit);
  const payload = {
    ok: snapshot.ok,
    command: "search",
    source: "disk",
    root: snapshot.root,
    query,
    hits: pageHits.map(({ rank, ...hit }) => {
      void rank;
      return hit;
    }),
    page,
    limit,
    totalHits: hits.length,
    hasMore: start + pageHits.length < hits.length,
    truncated: start + pageHits.length < hits.length,
    diagnostics: snapshot.diagnostics,
  };
  const lines = [
    `${hits.length} hit(s) for "${query}" (page ${page}, limit ${limit})`,
  ];
  for (const hit of pageHits) {
    lines.push(`  ${hit.nodeId} ${hit.path} [${hit.field}] ${hit.title}`);
    if (hit.snippet) lines.push(`    ${hit.snippet}`);
  }
  if (payload.hasMore) lines.push(`  … use --page ${page + 1} for more`);
  emit(ctx, mode, payload, lines);
  return snapshot.ok ? EXIT_CODES.ok : EXIT_CODES.validation;
}

/* ---------------------------------- read ---------------------------------- */

const TOPIC_OPTION = [
  { name: "workspace" },
  { name: "topic" },
  { name: "node", repeatable: true },
  { name: "start" },
  { name: "length" },
  { name: "full", boolean: true },
  { name: "section" },
  { name: "section-index" },
  { name: "offline", boolean: true },
  ...OUTPUT_OPTIONS,
] as const;

function parseOffset(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw)) throw invalidArgument(`${label} 必须是非负整数: ${raw}`);
  return Number(raw);
}

interface ReadWindow {
  readonly text: string;
  readonly range: { start: number; end: number; total: number; unit: "utf16" };
  readonly truncated: boolean;
}

function windowForBody(body: string, parsed: ParsedArgs): ReadWindow {
  try {
    const sectionTitle = parsed.values.get("section");
    let start = parseOffset(parsed.values.get("start"), "--start");
    if (sectionTitle !== undefined) {
      const sectionIndex = parseOffset(parsed.values.get("section-index"), "--section-index");
      const section = locateSection(body, sectionTitle, sectionIndex);
      start = section.start;
    }
    const length =
      parsed.values.get("length") === undefined
        ? undefined
        : normalizeLength(parseOffset(parsed.values.get("length"), "--length"));
    return sliceBody(body, {
      ...(start !== undefined ? { start } : {}),
      ...(length !== undefined ? { length } : {}),
      full: parsed.values.has("full"),
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new CliError("INVALID_RANGE", error.message, EXIT_CODES.usage);
    }
    throw error;
  }
}

interface OnlineReadResult {
  readonly online: true;
  readonly payload: Record<string, unknown>;
}

/**
 * 尝试用在线服务读取节点（可获得 editRef）。服务不可用或凭据不适用时
 * 明确返回原因，由调用方决定是否回退到磁盘读取；绝不伪造在线凭据。
 */
async function tryOnlineNodeRead(
  root: string,
  nodeId: string,
  parsed: ParsedArgs,
  ctx: CliContext,
): Promise<OnlineReadResult | { online: false; reason: string; code: string }> {
  let service;
  try {
    service = await resolveServiceForWorkspace(root, ctx.fetchImpl ?? fetch);
  } catch (error) {
    if (error instanceof CliError) {
      return { online: false, reason: error.message, code: error.code };
    }
    throw error;
  }
  const start = parseOffset(parsed.values.get("start"), "--start");
  const length =
    parsed.values.get("length") === undefined
      ? undefined
      : normalizeLength(parseOffset(parsed.values.get("length"), "--length"));
  const response = await readAgentNode(
    service,
    nodeId,
    {
      ...(start !== undefined ? { start } : {}),
      ...(length !== undefined ? { length } : {}),
      full: parsed.values.has("full"),
    },
    ctx.fetchImpl ?? fetch,
  );
  return { online: true, payload: response as unknown as Record<string, unknown> };
}

function nodeReadPayload(
  topic: TopicEntry,
  entry: NodeEntry,
  window: ReadWindow,
) {
  return {
    ...describeNode(topic, entry),
    body: window.text,
    range: window.range,
    truncated: window.truncated,
  };
}

export async function runRead(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(args, TOPIC_OPTION, 1);
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const positional = parsed.positional[0];
  const topicOption = parsed.values.get("topic");
  const nodeIds = parsed.lists.get("node") ?? [];
  if (positional !== undefined && topicOption !== undefined) {
    throw new UsageError("read 的主题只能给出一次（位置参数或 --topic）");
  }
  if (nodeIds.length > 0 && (positional !== undefined || topicOption !== undefined)) {
    throw new UsageError("read 不能同时指定主题与 --node");
  }
  if (nodeIds.length === 0 && positional === undefined && topicOption === undefined) {
    throw new UsageError("缺少要读取的主题或节点\n\n" + briefUsage("read"));
  }

  const snapshot = await loadWorkspace(root);

  if (nodeIds.length > 0) {
    return readNodes(snapshot, nodeIds, parsed, ctx, mode);
  }

  const locator = (positional ?? topicOption) as string;
  const isTopicId = /^t_[0-9a-f]{32}$/.test(locator);
  if (/^n_[0-9a-f]{32}$/.test(locator)) {
    throw new UsageError(`${locator} 是节点 ID，请使用 --node ${locator}`);
  }
  const topic = isTopicId
    ? (findTopicById(snapshot, locator)[0] ?? undefined)
    : (findTopicByPath(snapshot, locator) ?? findTopicByPath(snapshot, `topics/${locator}`));
  if (!topic) {
    throw new CliError(
      isTopicId ? "TOPIC_NOT_FOUND" : "NOT_FOUND",
      `找不到主题: ${locator}`,
      EXIT_CODES.notFound,
      {
        details: {
          locator,
          schemaVersion: snapshot.schemaVersion,
          topicMode: snapshot.workspace?.topicMode ?? "shared",
          diagnostics: snapshot.diagnostics.slice(0, 20),
        },
      },
    );
  }
  const entryFile = topicEntryFile(snapshot, topic);
  // 默认只给提纲：节点清单（describeNode 不含正文）。V1 的 topic 文件里其实
  // 内嵌了全部卡片正文，若默认原样返回就绕过了有界读取；只有显式 --full
  // 或 --start/--length 才返回入口文件文本，并同样带 range 与 truncated。
  const wantsText =
    parsed.values.has("full") ||
    parsed.values.get("start") !== undefined ||
    parsed.values.get("length") !== undefined ||
    parsed.values.get("section") !== undefined;
  let textSegment: { text: string; range: unknown; truncated: boolean } | undefined;
  if (wantsText && entryFile) {
    const window = windowForBody(entryFile.text, parsed);
    textSegment = { text: window.text, range: window.range, truncated: window.truncated };
  }
  const payload = {
    ok: snapshot.ok,
    command: "read",
    source: "disk",
    root: snapshot.root,
    schemaVersion: snapshot.schemaVersion,
    topicMode: snapshot.workspace?.topicMode ?? "shared",
    topic: describeTopic(snapshot, topic),
    ...(entryFile ? { file: fileFacts(entryFile) } : {}),
    // 节点清单：标题、摘要、状态、连接与真实源文件，不含正文。
    nodes: topic.nodes.map((entry) => describeNode(topic, entry)),
    ...(textSegment
      ? { text: textSegment.text, range: textSegment.range, truncated: textSegment.truncated }
      : { textOmitted: "默认不返回主题文件正文；用 read --node 取卡片正文，或加 --full／--start／--length" }),
  };
  const lines = [
    `topic ${topic.topic.topicId} ${topic.topic.title} (schemaVersion ${topic.topic.schemaVersion})`,
    `entry ${topic.path}${entryFile ? "  sha256 " + entryFile.sha256 : ""}`,
    `${topic.nodes.length} node(s):`,
    ...topic.nodes.map((entry) => `  ${entry.node.id}  ${entry.path}  ${entry.node.title}`),
  ];
  if (textSegment) lines.push("", textSegment.text);
  emit(ctx, mode, payload, lines);
  return snapshot.ok ? EXIT_CODES.ok : EXIT_CODES.validation;
}

async function readNodes(
  snapshot: WorkspaceSnapshot,
  nodeIds: readonly string[],
  parsed: ParsedArgs,
  ctx: CliContext,
  mode: "json" | "text",
): Promise<number> {
  const results: Record<string, unknown>[] = [];
  const missing: string[] = [];
  const forceOffline = parsed.values.has("offline");
  for (const nodeId of nodeIds) {
    const online = forceOffline
      ? { online: false as const, code: "OFFLINE_REQUESTED", reason: "--offline 指定只读磁盘" }
      : await tryOnlineNodeRead(snapshot.root, nodeId, parsed, ctx).catch((error: unknown) => {
          // 服务端明确错误不该静默吞掉；只有“连不上／身份不匹配”才回退本地读。
          if (error instanceof CliError && error.exitCode === EXIT_CODES.service) {
            return { online: false as const, code: error.code, reason: error.message };
          }
          throw error;
        });
    if (online.online) {
      results.push({
        source: "online",
        ...online.payload,
      });
      continue;
    }
    const found = findNode(snapshot, nodeId);
    if (!found) {
      missing.push(nodeId);
      continue;
    }
    const window = windowForBody(found.entry.node.body, parsed);
    results.push({
      ...nodeReadPayload(found.topic, found.entry, window),
      source: "disk",
      schemaVersion: snapshot.schemaVersion,
      topicMode: snapshot.workspace?.topicMode ?? "shared",
      online: { available: false, code: online.code, reason: online.reason },
      file: fileFacts(found.entry.file),
    });
  }
  if (missing.length > 0) {
    throw new CliError("NODE_NOT_FOUND", `找不到节点: ${missing.join(", ")}`, EXIT_CODES.notFound, {
      details: { nodeIds: missing, diagnostics: snapshot.diagnostics.slice(0, 20) },
    });
  }
  const payload = {
    ok: true,
    command: "read",
    root: snapshot.root,
    nodes: results,
  };
  const lines: string[] = [];
  for (const item of results) {
    const node = item["node"] as Record<string, unknown> | undefined;
    const title = (node?.["title"] ?? item["title"]) as string | undefined;
    const id = (node?.["id"] ?? item["id"]) as string | undefined;
    const range = item["range"] as { start: number; end: number; total: number } | undefined;
    lines.push(
      `# ${title ?? ""} (${id ?? ""}) ${item["source"]} ${range ? `[${range.start},${range.end})/${range.total}` : ""}`,
    );
    lines.push(String(item["body"] ?? ""));
    lines.push("");
  }
  emit(ctx, mode, payload, lines);
  return EXIT_CODES.ok;
}

/* -------------------------------- validate -------------------------------- */

export async function runValidate(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(args, [{ name: "workspace" }, ...OUTPUT_OPTIONS], 0);
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const snapshot = await loadWorkspace(root);
  const validation = validateSnapshot(snapshot);
  const payload = {
    ok: validation.ok,
    command: "validate",
    source: "disk",
    root: snapshot.root,
    schemaVersion: snapshot.schemaVersion,
    topicMode: snapshot.workspace?.topicMode ?? "shared",
    workspace: snapshot.workspace,
    topics: snapshot.topics.map((entry) => describeTopic(snapshot, entry)),
    storageDiagnostics: snapshot.files.diagnostics,
    diagnostics: validation.diagnostics,
    graphSkipped: validation.graphSkipped,
    graph: validation.graph
      ? {
          workspaceId: validation.graph.workspaceId,
          name: validation.graph.name,
          activeNode: validation.graph.activeNode,
          rootId: validation.graph.rootId,
          rootIds: validation.graph.rootIds ?? [],
          topics: validation.graph.topics,
          nodes: validation.graph.nodes.map((node) => ({
            id: node.id,
            topicId: node.topicId,
            topicPath: node.topicPath,
            sourcePath: node.sourcePath,
            title: node.title,
            summary: node.summary,
            number: node.number,
            from: node.from,
            flow: node.flow,
            state: node.state,
            ...(node.description !== undefined ? { description: node.description } : {}),
            ...(node.side !== undefined ? { side: node.side } : {}),
            ...(node.order !== undefined ? { order: node.order } : {}),
            ...(node.label !== undefined ? { label: node.label } : {}),
            nextId: node.nextId,
            branchIds: node.branchIds,
          })),
        }
      : null,
  };
  const lines = [
    `${validation.ok ? "valid" : "INVALID"} ${snapshot.root} (schemaVersion ${snapshot.schemaVersion ?? "?"}, topicMode ${payload.topicMode})`,
    `${snapshot.topics.length} topic(s), ${snapshot.topics.reduce((sum, topic) => sum + topic.nodes.length, 0)} node(s)`,
  ];
  for (const diagnostic of validation.diagnostics) {
    lines.push(`  ${diagnostic.code} ${diagnostic.topicPath ?? ""} ${diagnostic.message}`);
  }
  for (const diagnostic of snapshot.files.diagnostics) {
    lines.push(`  storage ${diagnostic.code} ${diagnostic.path ?? ""} ${diagnostic.message}`);
  }
  if (payload.graph) {
    const roots = payload.graph.rootIds;
    lines.push(`graph ${payload.graph.nodes.length} node(s), ${roots.length} root(s)${roots.length > 0 ? ": " + roots.join(", ") : ""}`);
  }
  emit(ctx, mode, payload, lines);
  return validation.ok ? EXIT_CODES.ok : EXIT_CODES.validation;
}

export type { NodeEntry, TopicEntry, WorkspaceSnapshot };