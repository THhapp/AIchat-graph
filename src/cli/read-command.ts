/** read：磁盘为默认来源，有服务时按节点复用同一服务实例读取在线片段。 */
import type { ParsedArgs } from "./args.js";
import { parseOptions } from "./args.js";
import { readAgentNode, type AgentReadOptions } from "./agent-client.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT_CODES, UsageError } from "./errors.js";
import { OUTPUT_OPTIONS, WORKSPACE_OPTION, parseIntegerOption } from "./options.js";
import { emit, parseOutputMode } from "./output.js";
import { resolveServiceForWorkspace } from "./service-client.js";
import type { ResolvedService } from "./service-client.js";
import {
  DEFAULT_READ_LENGTH,
  MAX_READ_SEGMENT,
  locateSection,
  normalizeLength,
  sliceBody,
} from "../core/index.js";
import { briefUsage } from "./usage.js";
import {
  describeNode,
  describeTopic,
  findNode,
  findTopicById,
  findTopicByPath,
  loadWorkspace,
  topicEntryFile,
  workspaceRoot,
  type NodeEntry,
  type WorkspaceSnapshot,
} from "./workspace.js";
import type { AgentEditRef, AgentNodeReadResponse } from "../shared/protocol.js";

const TOPIC_OPTION = [
  WORKSPACE_OPTION,
  { name: "topic" },
  { name: "node", repeatable: true },
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

function parseOffset(raw: string | undefined, label: string): number | undefined {
  return parseIntegerOption(raw, label);
}

function parseStart(raw: string | undefined): number | undefined {
  return parseIntegerOption(raw, "--start", { min: 0, max: MAX_READ_START });
}

/**
 * 读取片段长度：0 与超上限都是参数错误，并在错误里给出有效范围。
 * 在线与离线共用这一处，避免 normalizeLength 的 RangeError 漏成 INTERNAL。
 */
function parseReadLength(raw: string | undefined): number | undefined {
  const value = parseIntegerOption(raw, "--length", { min: 1, max: MAX_READ_SEGMENT });
  return value === undefined ? undefined : normalizeLength(value);
}

interface ReadWindow {
  readonly text: string;
  readonly range: { start: number; end: number; total: number; unit: "utf16" };
  readonly truncated: boolean;
}

/** 多卡默认预算：整次正文总量与单卡默认上限（UTF-16）。 */
const READ_TOTAL_BUDGET = 12_000;

function windowForBody(
  body: string,
  parsed: ParsedArgs,
  defaultLength?: number,
): ReadWindow {
  try {
    const sectionTitle = parsed.values.get("section");
    let start = parseStart(parsed.values.get("start"));
    if (sectionTitle !== undefined) {
      const sectionIndex = parseOffset(parsed.values.get("section-index"), "--section-index");
      const section = locateSection(body, sectionTitle, sectionIndex);
      start = section.start;
    }
    // 多卡预算时把每卡默认长度作为 --length 的缺省值；显式 --length 优先。
    const length = parseReadLength(parsed.values.get("length")) ?? defaultLength;
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

/**
 * 把一次 read 的切片参数整理成在线请求参数，只解析一次。
 * meta 与切片／章节参数的冲突已在 runRead 层拒绝。
 */
function nodeReadOptions(parsed: ParsedArgs, defaultLength?: number): AgentReadOptions {
  const start = parseStart(parsed.values.get("start"));
  const explicitLength = parseReadLength(parsed.values.get("length"));
  const length = explicitLength ?? defaultLength;
  const section = parsed.values.get("section");
  const sectionIndex =
    section === undefined
      ? undefined
      : parseOffset(parsed.values.get("section-index"), "--section-index");
  return {
    ...(start !== undefined ? { start } : {}),
    ...(length !== undefined ? { length } : {}),
    ...(parsed.values.has("full") ? { full: true } : {}),
    ...(parsed.values.has("meta") ? { meta: true } : {}),
    ...(section !== undefined ? { section } : {}),
    ...(sectionIndex !== undefined ? { sectionIndex } : {}),
  };
}

/** 每个节点项：在线与离线完全同一形状，不再摊平节点字段。 */
interface ReadItem {
  readonly source: "online" | "disk";
  readonly node: Record<string, unknown>;
  readonly body: string;
  readonly bodyOmitted?: true;
  readonly range: ReadWindow["range"];
  readonly truncated: boolean;
  readonly path: string;
  readonly fileHash: string;
  readonly editRef: AgentEditRef | null;
}

function onlineReadItem(response: AgentNodeReadResponse): ReadItem {
  return {
    source: "online",
    node: response.node as unknown as Record<string, unknown>,
    body: response.body,
    ...(response.bodyOmitted === true ? { bodyOmitted: true as const } : {}),
    range: response.range,
    truncated: response.truncated,
    path: response.path,
    fileHash: response.fileHash,
    editRef: response.editRef,
  };
}

/** 离线节点：number 来自有效图的 id→编号映射；图无效时为 null。 */
export function offlineNodeView(
  entry: NodeEntry,
  numberById: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const { node } = entry;
  return {
    id: node.id,
    topicId: node.topicId,
    title: node.title,
    summary: node.summary,
    number: numberById.get(node.id) ?? null,
    from: node.from,
    flow: node.flow,
    state: node.state,
    important: node.important,
    // 与服务端 toGraphNode 一致：连接文字只读 description。
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    sourcePath: entry.path,
  };
}

function offlineReadItem(
  entry: NodeEntry,
  parsed: ParsedArgs,
  numberById: ReadonlyMap<string, string>,
  defaultLength: number | undefined,
): ReadItem {
  const node = offlineNodeView(entry, numberById);
  const body = entry.node.body;
  if (parsed.values.has("meta")) {
    return {
      source: "disk",
      node,
      body: "",
      bodyOmitted: true,
      range: { start: 0, end: 0, total: body.length, unit: "utf16" },
      truncated: false,
      path: entry.path,
      fileHash: entry.file.sha256,
      editRef: null,
    };
  }
  const window = windowForBody(body, parsed, defaultLength);
  return {
    source: "disk",
    node,
    body: window.text,
    range: window.range,
    truncated: window.truncated,
    path: entry.path,
    fileHash: entry.file.sha256,
    editRef: null,
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
  if (parsed.values.has("meta")) {
    const conflicts = ["start", "length", "full", "section", "section-index"].filter((name) =>
      parsed.values.has(name),
    );
    if (conflicts.length > 0) {
      throw new UsageError(
        "--meta 不能与 " + conflicts.map((name) => "--" + name).join("／") +
          " 同时使用；meta 读取不含正文",
      );
    }
    if (nodeIds.length === 0) {
      throw new UsageError("--meta 只能与 --node 一起使用");
    }
  }
  // 在线服务会拒绝单独出现的 section-index；CLI 在发请求前统一拒绝，
  // 保证 --node 与主题读取、在线与离线的行为一致。
  if (parsed.values.has("section-index") && parsed.values.get("section") === undefined) {
    throw new UsageError("--section-index 必须与 --section 一起使用");
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
          diagnostics: snapshot.diagnostics.slice(0, 20),
        },
      },
    );
  }
  const entryFile = topicEntryFile(snapshot, topic);
  // 默认只给提纲：节点清单（describeNode 不含正文）。主题入口文件是
  // topic.md，若默认原样返回就绕过了有界读取；只有显式 --full
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
    topic: describeTopic(topic),
    // 节点清单：标题、摘要、状态、连接与真实源文件，不含正文。
    nodes: topic.nodes.map((entry) => describeNode(entry, snapshot.nodeNumbers)),
    ...(textSegment
      ? { text: textSegment.text, range: textSegment.range, truncated: textSegment.truncated }
      : { textOmitted: "默认不返回主题文件正文；用 read --node 取卡片正文，或加 --full／--start／--length" }),
  };
  const lines = [
    `topic ${topic.topic.topicId} ${topic.topic.title} (schemaVersion ${topic.topic.schemaVersion})`,
    `entry ${topic.path}`,
    `${topic.nodes.length} node(s):`,
    ...topic.nodes.map((entry) => {
      const view = describeNode(entry, snapshot.nodeNumbers);
      return `  ${view.number ?? "-"}  ${view.id}  ${view.path}  ${view.title}`;
    }),
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
  // 多卡预算只在“未显式选择切片方式”时生效；单卡仍用默认 4000。
  const budgetApplies =
    nodeIds.length > 1 &&
    !parsed.values.has("length") &&
    !parsed.values.has("full") &&
    !parsed.values.has("meta") &&
    !parsed.values.has("section");
  const perNodeLength = budgetApplies
    ? Math.max(1, Math.min(DEFAULT_READ_LENGTH, Math.floor(READ_TOTAL_BUDGET / nodeIds.length)))
    : undefined;
  const readOptions = nodeReadOptions(parsed, perNodeLength);
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const numberById = snapshot.nodeNumbers;

  const forceOffline = parsed.values.has("offline");
  let service: ResolvedService | null = null;
  let unavailable: { code: string; reason: string } | null = forceOffline
    ? { code: "OFFLINE_REQUESTED", reason: "--offline 指定只读磁盘" }
    : null;
  if (!forceOffline) {
    try {
      // 服务只解析并核对一次身份，后续节点复用同一实例。
      service = await resolveServiceForWorkspace(snapshot.root, fetchImpl);
    } catch (error) {
      // 不可达／未运行／身份不适用（退出码 7）才整次回退磁盘；
      // 其他错误照常抛出，不静默改写为离线结果。
      if (error instanceof CliError && error.exitCode === EXIT_CODES.service) {
        unavailable = { code: error.code, reason: error.message };
      } else {
        throw error;
      }
    }
  }

  const results: ReadItem[] = [];
  const missing: string[] = [];
  let revision: number | undefined;
  for (const nodeId of nodeIds) {
    let online: AgentNodeReadResponse | undefined;
    if (service !== null && unavailable === null) {
      try {
        online = await readAgentNode(service, nodeId, readOptions, fetchImpl);
      } catch (error) {
        // 循环中途服务变得不可达：剩余节点读磁盘，已读到的在线项保持原样。
        if (error instanceof CliError && error.code === "SERVICE_UNREACHABLE") {
          unavailable = { code: error.code, reason: error.message };
        } else {
          throw error;
        }
      }
    }
    if (online !== undefined) {
      revision ??= online.revision;
      results.push(onlineReadItem(online));
      continue;
    }
    const found = findNode(snapshot, nodeId);
    if (!found) {
      missing.push(nodeId);
      continue;
    }
    results.push(offlineReadItem(found.entry, parsed, numberById, perNodeLength));
  }
  if (missing.length > 0) {
    throw new CliError("NODE_NOT_FOUND", `找不到节点: ${missing.join(", ")}`, EXIT_CODES.notFound, {
      details: { nodeIds: missing, diagnostics: snapshot.diagnostics.slice(0, 20) },
    });
  }
  const online =
    service !== null && unavailable === null && revision !== undefined
      ? {
          available: true as const,
          instanceId: service.identity.instanceId,
          revision,
          workspaceId: service.identity.workspaceId,
        }
      : {
          available: false as const,
          code: unavailable?.code ?? "SERVICE_UNAVAILABLE",
          reason: unavailable?.reason ?? "服务不可用，已全部读取磁盘",
        };
  const payload = {
    ok: true,
    command: "read",
    root: snapshot.root,
    online,
    ...(budgetApplies
      ? { budget: { total: READ_TOTAL_BUDGET, perNode: perNodeLength, nodes: nodeIds.length } }
      : {}),
    nodes: results,
  };
  const lines: string[] = [];
  if (budgetApplies) {
    lines.push(
      `budget ${READ_TOTAL_BUDGET} chars / ${nodeIds.length} nodes, ${perNodeLength} per node`,
    );
  }
  for (const item of results) {
    const node = item.node;
    const range = item.range;
    lines.push(
      `# ${String(node["title"] ?? "")} (${String(node["id"] ?? "")}) ${item.source} [${range.start},${range.end})/${range.total}`,
    );
    if (item.bodyOmitted) lines.push(`（仅元数据，总长 ${range.total}）`);
    else lines.push(item.body);
    lines.push("");
  }
  emit(ctx, mode, payload, lines);
  return EXIT_CODES.ok;
}
