/**
 * read：渐进读取入口（overview / structure / content）。
 *
 * - 默认 read <topic> 是 overview；read --node 默认 content；--from 默认 structure。
 * - 在线优先：服务可用时原样返回服务响应（含真实 editRef）；只有退出码 7 的
 *   不可达才回退磁盘，其余服务错误（409／400 等）直接抛出。
 * - 离线使用同一引擎，但 editRef 一律为 null，并明确 online.available=false 的原因。
 * - cursor 已包含范围与 mode，续读只允许另带 budget／--offline／--workspace／输出选项。
 */
import type { ParsedArgs } from "./args.js";
import { parseOptions } from "./args.js";
import {
  readAgentView,
  type AgentReadViewQuery,
} from "./agent-client.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT_CODES, UsageError } from "./errors.js";
import { OUTPUT_OPTIONS, WORKSPACE_OPTION, parseIntegerOption } from "./options.js";
import { parseOutputMode } from "./output.js";
import {
  DEFAULT_READ_BUDGET,
  MAX_READ_BUDGET,
  type ReadContentOptions,
} from "../index/read-view.js";
import { MAX_READ_SEGMENT, normalizeLength } from "../core/index.js";
import { resolveServiceForWorkspace } from "./service-client.js";
import type { ResolvedService } from "./service-client.js";
import { buildOfflineReadView, emitReadViewText } from "./read-view.js";
import type { OfflineReadViewOptions } from "./read-view.js";
import type { ReadViewKind } from "../shared/protocol.js";
import {
  loadWorkspace,
  requireTopicEntry,
  workspaceRoot,
  type WorkspaceSnapshot,
} from "./workspace.js";
import { briefUsage } from "./usage.js";

const READ_OPTIONS = [
  WORKSPACE_OPTION,
  { name: "topic" },
  { name: "node", repeatable: true },
  { name: "view" },
  { name: "from" },
  { name: "budget" },
  { name: "cursor" },
  { name: "start" },
  { name: "length" },
  { name: "full", boolean: true },
  { name: "section" },
  { name: "section-index" },
  { name: "meta", boolean: true },
  { name: "offline", boolean: true },
  ...OUTPUT_OPTIONS,
] as const;

/** 与 service 的 agent bounded read 保持一致的上限。 */
const MAX_READ_START = 100_000_000;

const VIEW_VALUES: readonly ReadViewKind[] = ["overview", "structure", "content"];
const CURSOR_CONFLICT_OPTIONS = [
  "topic",
  "view",
  "from",
  "start",
  "length",
  "full",
  "section",
  "section-index",
  "meta",
] as const;

interface ReadRequest {
  readonly budget: number;
  readonly cursor?: string;
  readonly view?: ReadViewKind;
  /** 稳定 topicId 或相对入口路径；仅 overview／structure。 */
  readonly topic?: string;
  readonly from?: string;
  readonly nodeIds: readonly string[];
  readonly content?: ReadContentOptions;
}

function parseStart(raw: string | undefined): number | undefined {
  return parseIntegerOption(raw, "--start", { min: 0, max: MAX_READ_START });
}

/** 显式 length：与旧读取一致，超上限截到 MAX_READ_SEGMENT，非法值是用例错误。 */
function parseReadLength(raw: string | undefined): number | undefined {
  const value = parseIntegerOption(raw, "--length", { min: 1, max: MAX_READ_SEGMENT });
  return value === undefined ? undefined : normalizeLength(value);
}

function parseSectionIndex(raw: string | undefined): number | undefined {
  return parseIntegerOption(raw, "--section-index");
}

function parseBudget(raw: string | undefined): number {
  return (
    parseIntegerOption(raw, "--budget", { min: 1, max: MAX_READ_BUDGET }) ??
    DEFAULT_READ_BUDGET
  );
}

function parseView(raw: string | undefined): ReadViewKind | undefined {
  if (raw === undefined) return undefined;
  if (!VIEW_VALUES.includes(raw as ReadViewKind)) {
    throw new UsageError("--view 必须是 overview、structure 或 content: " + raw);
  }
  return raw as ReadViewKind;
}

function contentOptions(parsed: ParsedArgs): ReadContentOptions {
  const start = parseStart(parsed.values.get("start"));
  const length = parseReadLength(parsed.values.get("length"));
  const section = parsed.values.get("section");
  const sectionIndex =
    section === undefined ? undefined : parseSectionIndex(parsed.values.get("section-index"));
  return {
    ...(start !== undefined ? { start } : {}),
    ...(length !== undefined ? { length } : {}),
    ...(parsed.values.has("full") ? { full: true } : {}),
    ...(parsed.values.has("meta") ? { meta: true } : {}),
    ...(section !== undefined ? { section } : {}),
    ...(sectionIndex !== undefined ? { sectionIndex } : {}),
  };
}

/**
 * 解析并交叉校验一次 read 调用。所有范围／参数冲突都在联网或读盘前拒绝，
 * 保证在线与离线得到相同的用法错误（退出码 2）。
 */
function parseReadRequest(parsed: ParsedArgs): ReadRequest {
  const budget = parseBudget(parsed.values.get("budget"));
  const cursor = parsed.values.get("cursor");
  const positional = parsed.positional[0];
  const topicOption = parsed.values.get("topic");
  const nodeIds = parsed.lists.get("node") ?? [];
  const from = parsed.values.get("from");

  if (cursor !== undefined) {
    const conflicts: string[] = [];
    if (positional !== undefined) conflicts.push("<topicId>");
    if (nodeIds.length > 0) conflicts.push("--node");
    for (const name of CURSOR_CONFLICT_OPTIONS) {
      if (parsed.values.has(name)) conflicts.push("--" + name);
    }
    if (conflicts.length > 0) {
      throw new UsageError(
        "--cursor 不能与 " + conflicts.join("／") +
          " 同时使用；续读标记已包含 view／范围／主题，只可另带 --budget／--offline／--workspace／输出选项",
      );
    }
    return { budget, cursor, nodeIds: [] };
  }

  if (positional !== undefined && topicOption !== undefined) {
    throw new UsageError("read 的主题只能给出一次（位置参数或 --topic）");
  }
  if (nodeIds.length > 0 && (positional !== undefined || topicOption !== undefined)) {
    throw new UsageError("read 不能同时指定主题与 --node");
  }

  const locator = positional ?? topicOption;
  if (nodeIds.length === 0 && locator === undefined) {
    throw new UsageError("缺少要读取的主题或节点\n\n" + briefUsage("read"));
  }
  if (locator !== undefined && /^n_[0-9a-f]{32}$/.test(locator)) {
    throw new UsageError(`${locator} 是节点 ID，请使用 --node ${locator}`);
  }

  const section = parsed.values.get("section");
  if (parsed.values.has("section-index") && section === undefined) {
    throw new UsageError("--section-index 必须与 --section 一起使用");
  }

  const explicitView = parseView(parsed.values.get("view"));
  const view: ReadViewKind =
    explicitView ??
    (nodeIds.length > 0 ? "content" : from !== undefined ? "structure" : "overview");

  if (view !== "content" && nodeIds.length > 0) {
    throw new UsageError(
      "--view " + view + " 不接受 --node；读取卡片正文请用默认 content（read --node ...）",
    );
  }

  if (view === "content") {
    if (nodeIds.length === 0) {
      throw new UsageError("--view content（以及 read --node）至少需要一个 --node");
    }
    if (from !== undefined) {
      throw new UsageError("content 读取不接受 --from；content 的范围由 --node 给出");
    }
  }

  if (parsed.values.has("meta")) {
    if (view !== "content") {
      throw new UsageError("--meta 只能用于 content 读取（需要 --node）");
    }
    const conflicts = ["start", "length", "full", "section", "section-index"].filter((name) =>
      parsed.values.has(name),
    );
    if (conflicts.length > 0) {
      throw new UsageError(
        "--meta 不能与 " + conflicts.map((name) => "--" + name).join("／") +
          " 同时使用；meta 读取不含正文",
      );
    }
  }

  if (view === "overview" || view === "structure") {
    const forbidden = ["start", "length", "full", "section", "section-index"].filter((name) =>
      parsed.values.has(name),
    );
    if (forbidden.length > 0) {
      throw new UsageError(
        "--view " + view + " 不接受正文参数：" + forbidden.map((name) => "--" + name).join("／") +
          "；这些参数只用于 content",
      );
    }
    return {
      budget,
      view,
      topic: locator as string,
      ...(from !== undefined ? { from } : {}),
      nodeIds: [],
    };
  }

  const content = contentOptions(parsed);
  return {
    budget,
    view,
    nodeIds,
    ...(Object.keys(content).length > 0 ? { content } : {}),
  };
}

/** 在线查询：cursor 只发 cursor+budget；content 不重复发送主题。 */
function onlineQuery(snapshot: WorkspaceSnapshot, request: ReadRequest): AgentReadViewQuery {
  if (request.cursor !== undefined) {
    return { budget: request.budget, cursor: request.cursor };
  }
  if (request.view === "content") {
    return {
      budget: request.budget,
      view: "content",
      nodeIds: request.nodeIds,
      ...(request.content !== undefined ? { content: request.content } : {}),
    };
  }
  if (request.topic === undefined) {
    throw new CliError("INTERNAL", "missing topic for online read", EXIT_CODES.internal);
  }
  const topic = requireTopicEntry(snapshot, request.topic);
  return {
    budget: request.budget,
    view: request.view ?? "overview",
    topicId: topic.topic.topicId,
    ...(request.from !== undefined ? { from: request.from } : {}),
  };
}

function offlineOptions(
  request: ReadRequest,
  unavailable: { code: string; reason: string } | null,
): OfflineReadViewOptions {
  const online = unavailable ?? {
    code: "SERVICE_UNAVAILABLE",
    reason: "服务不可用，已读取磁盘",
  };
  if (request.cursor !== undefined) {
    return { budget: request.budget, cursor: request.cursor, online };
  }
  if (request.view === "content") {
    return {
      budget: request.budget,
      view: "content",
      nodeIds: request.nodeIds,
      ...(request.content !== undefined ? { content: request.content } : {}),
      online,
    };
  }
  return {
    budget: request.budget,
    view: request.view ?? "overview",
    ...(request.topic !== undefined ? { topic: request.topic } : {}),
    ...(request.from !== undefined ? { from: request.from } : {}),
    online,
  };
}

export async function runRead(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(args, READ_OPTIONS, 1);
  const mode = parseOutputMode(parsed);
  const request = parseReadRequest(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const snapshot = await loadWorkspace(root);
  const fetchImpl = ctx.fetchImpl ?? fetch;

  const forceOffline = parsed.values.has("offline");
  let service: ResolvedService | null = null;
  let unavailable: { code: string; reason: string } | null = forceOffline
    ? { code: "OFFLINE_REQUESTED", reason: "--offline 指定只读磁盘" }
    : null;

  if (!forceOffline) {
    try {
      service = await resolveServiceForWorkspace(snapshot.root, fetchImpl);
    } catch (error) {
      // 只有服务不可用（退出码 7）回退磁盘；其他错误照常抛出。
      if (error instanceof CliError && error.exitCode === EXIT_CODES.service) {
        unavailable = { code: error.code, reason: error.message };
      } else {
        throw error;
      }
    }
  }

  if (service !== null && unavailable === null) {
    // 先解析主题（11 类错误不进入磁盘回退），再请求服务。
    const query = onlineQuery(snapshot, request);
    try {
      const response = await readAgentView(service, query, fetchImpl);
      emitReadViewText(response, ctx, mode);
      return EXIT_CODES.ok;
    } catch (error) {
      // 请求中途服务变得不可达才回退；409／400 等业务错误直接抛出，不混用。
      if (error instanceof CliError && error.exitCode === EXIT_CODES.service) {
        unavailable = { code: error.code, reason: error.message };
      } else {
        throw error;
      }
    }
  }

  const response = buildOfflineReadView(snapshot, offlineOptions(request, unavailable), ctx);
  emitReadViewText(response, ctx, mode);
  return EXIT_CODES.ok;
}
