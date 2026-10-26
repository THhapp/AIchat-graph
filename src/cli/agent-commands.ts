/**
 * 低摩擦在线写入命令：edit／branch／next／connect／rearrange／important／create-*。
 *
 * 设计要点：
 * - 写入凭据只来自真实在线读取（read 顶层 refs[nodeId]），CLI 不伪造、不按编号重定位；
 * - 机械字段（requestId UUID、节点 ID、路径、branch order）由服务生成或按规则推导；
 * - 一次提交只做一个动作；复杂变更使用 batch，显式底层变更仍走 check／apply；
 * - 所有写命令共用 write-command 的顶层精简结果，--verbose 才输出文件与事务诊断；
 * - 超时／断线不换 requestId 重发：报告 RESULT_UNKNOWN，交给 status 或重读决定。
 * - 命令参数表来自 command-specs，不在本模块复制选项清单。
 */
import { parseCommandArgs, requireParameter } from "./command-specs.js";
import { parseEnumValue, readBodyFromParsed, readBodyPatchFromParsed } from "./body-options.js";
import { normalizeText } from "./body-input.js";
import type { CliContext } from "./context.js";
import { readAgentNode } from "./agent-client.js";
import { CliError, EXIT_CODES, UsageError, invalidArgument } from "./errors.js";
import { isRecord } from "../shared/guards.js";
import { parseIntegerOption } from "./options.js";
import { parseOutputMode } from "./output.js";
import { readJsonInputFile, parseJsonInput } from "./input-files.js";
import { resolveServiceForWorkspace } from "./service-client.js";
import type { ResolvedService } from "./service-client.js";
import { submitWriteAction } from "./write-command.js";
import { workspaceRoot } from "./workspace.js";
import type {
  AgentChangeAction,
  AgentRearrangeEdit,
} from "../shared/protocol.js";

const NODE_STATES = ["agreed", "proposed", "reference"] as const;
const SIDES = ["left", "right"] as const;
const CONNECT_FLOWS = ["next", "branch"] as const;

/* ---------------------------------- edit ---------------------------------- */

export async function runEdit(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("edit", args);
  const mode = parseOutputMode(parsed);
  const verbose = parsed.values.has("verbose");
  const root = await workspaceRoot(parsed, ctx);
  const ref = requireParameter(parsed, "edit", "ref");

  const title = parsed.values.get("title");
  const state = parseEnumValue(parsed.values.get("state"), NODE_STATES, "--state");
  const summary = parsed.values.get("summary");
  const bodyPatch = await readBodyPatchFromParsed(parsed, ctx);
  const hasBody =
    bodyPatch.body !== undefined ||
    bodyPatch.append !== undefined ||
    bodyPatch.replace !== undefined;
  if (title === undefined && state === undefined && summary === undefined && !hasBody) {
    throw new UsageError(
      "edit 至少需要一项修改：--title／--state／--summary／--body*／--append-file／--replace-file",
    );
  }

  const action: AgentChangeAction = {
    action: "patchNode",
    editRef: ref,
    ...(title !== undefined ? { title } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(bodyPatch.body !== undefined ? { body: bodyPatch.body } : {}),
    ...(bodyPatch.append !== undefined ? { append: bodyPatch.append } : {}),
    ...(bodyPatch.replace !== undefined ? { replace: [...bodyPatch.replace] } : {}),
  };
  return submitWriteAction("edit", action, root, ctx, mode, verbose);
}

/* --------------------------------- branch --------------------------------- */

export async function runBranch(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("branch", args);
  const mode = parseOutputMode(parsed);
  const verbose = parsed.values.has("verbose");
  const root = await workspaceRoot(parsed, ctx);
  const fromRef = requireParameter(parsed, "branch", "from-ref");
  const title = requireParameter(parsed, "branch", "title");
  const description = requireParameter(parsed, "branch", "description");
  const body = await readBodyFromParsed(parsed, ctx);
  if (body === undefined) {
    throw new UsageError("缺少正文：--body／--body-file／--body-stdin 三选一");
  }
  const state = parseEnumValue(parsed.values.get("state"), NODE_STATES, "--state");
  const side = parseEnumValue(parsed.values.get("side"), SIDES, "--side");
  const order = parseIntegerOption(parsed.values.get("order"), "--order");
  const summary = parsed.values.get("summary");
  const action: AgentChangeAction = {
    action: "createBranch",
    editRef: fromRef,
    title,
    body: normalizeText(body.text),
    description,
    ...(summary !== undefined ? { summary } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(side !== undefined ? { side } : {}),
    ...(order !== undefined ? { order } : {}),
  };
  return submitWriteAction("branch", action, root, ctx, mode, verbose);
}

/* ---------------------------------- next ---------------------------------- */

/**
 * 纵向后继：一样是"新建一张卡并接到来源"，只是 flow 为 next。
 *
 * 为什么不复用 branch ＋ connect：那需要两次提交，中间还会短暂存在一个分支；
 * 这里一次提交表达"沿这条线继续"。来源已有 next 时服务返回 409，CLI 不自动
 * 顶掉旧主线，也不替调用方决定插入位置（需要插入中间用 insert）。
 */
export async function runNext(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("next", args);
  const mode = parseOutputMode(parsed);
  const verbose = parsed.values.has("verbose");
  const root = await workspaceRoot(parsed, ctx);
  const fromRef = requireParameter(parsed, "next", "from-ref");
  const title = requireParameter(parsed, "next", "title");
  const description = requireParameter(parsed, "next", "description");
  const body = await readBodyFromParsed(parsed, ctx);
  if (body === undefined) {
    throw new UsageError("缺少正文：--body／--body-file／--body-stdin 三选一");
  }
  const state = parseEnumValue(parsed.values.get("state"), NODE_STATES, "--state");
  const topicId = parsed.values.get("topic-id");
  const summary = parsed.values.get("summary");
  // 直接使用共享 DTO：字段拼写与服务端校验同源，不在这里复制一份类型。
  const action: AgentChangeAction = {
    action: "createNext",
    editRef: fromRef,
    title,
    body: normalizeText(body.text),
    description,
    ...(summary !== undefined ? { summary } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(topicId !== undefined ? { topicId } : {}),
  };
  return submitWriteAction("next", action, root, ctx, mode, verbose);
}

/* --------------------------------- connect -------------------------------- */

export async function runConnect(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("connect", args);
  const mode = parseOutputMode(parsed);
  const verbose = parsed.values.has("verbose");
  const root = await workspaceRoot(parsed, ctx);
  const ref = requireParameter(parsed, "connect", "ref");
  const description = requireParameter(parsed, "connect", "description");
  const fromRef = parsed.values.get("from-ref");
  const flow = parseEnumValue(parsed.values.get("flow"), CONNECT_FLOWS, "--flow");
  const side = parseEnumValue(parsed.values.get("side"), SIDES, "--side");
  const order = parseIntegerOption(parsed.values.get("order"), "--order");
  // description 本身就是连接语义的一部分：改好一句说不清的"为什么接到这里"
  // 是常见的维护动作，不应被当成"没有可改字段"而拒绝。结构字段则全为可选。
  const action: AgentChangeAction = {
    action: "updateConnection",
    editRef: ref,
    description,
    ...(fromRef !== undefined ? { fromRef } : {}),
    ...(flow !== undefined ? { flow } : {}),
    ...(side !== undefined ? { side } : {}),
    ...(order !== undefined ? { order } : {}),
  };
  return submitWriteAction("connect", action, root, ctx, mode, verbose);
}

/* -------------------------------- rearrange ------------------------------- */

const REARRANGE_EDIT_FIELDS = new Set(["ref", "fromRef", "flow", "side", "order", "description"]);

function specString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidArgument(label + " 必须是非空字符串");
  }
  if (/[\r\n]/.test(value)) throw invalidArgument(label + " 必须是单行文本");
  return value;
}

/**
 * 解析 rearrange spec：调用方只写最终关系与说明，不写 requestId／expectedFiles。
 * 每个错误都指出具体条目与字段，退出码 2；不把半成品发给服务。
 */
function parseRearrangeSpec(rawText: string): AgentChangeAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch (error) {
    throw invalidArgument(
      "rearrange spec 不是合法 JSON：" +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!isRecord(parsed)) throw invalidArgument("rearrange spec 必须是 JSON 对象");
  for (const key of Object.keys(parsed)) {
    if (key !== "edits") throw invalidArgument("rearrange spec 未知字段：" + key);
  }
  const rawEdits = parsed["edits"];
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    throw invalidArgument("rearrange spec 的 edits 必须是非空数组");
  }

  const edits: AgentRearrangeEdit[] = [];
  for (const [index, entry] of rawEdits.entries()) {
    const label = "edits[" + String(index) + "]";
    if (!isRecord(entry)) throw invalidArgument(label + " 必须是对象");
    for (const key of Object.keys(entry)) {
      if (!REARRANGE_EDIT_FIELDS.has(key)) {
        throw invalidArgument(label + " 未知字段：" + key);
      }
    }
    const ref = specString(entry["ref"], label + ".ref");
    const fromRef = specString(entry["fromRef"], label + ".fromRef");
    const flow = entry["flow"];
    if (flow !== "next" && flow !== "branch") {
      throw invalidArgument(label + ".flow 只能是 next／branch，收到 " + String(flow));
    }
    const description = specString(entry["description"], label + ".description");
    let side: "left" | "right" | undefined;
    if (Object.prototype.hasOwnProperty.call(entry, "side")) {
      if (flow !== "branch") {
        throw invalidArgument(label + ".side 只允许在 flow=branch 时出现");
      }
      if (entry["side"] !== "left" && entry["side"] !== "right") {
        throw invalidArgument(label + ".side 只能是 left／right，收到 " + String(entry["side"]));
      }
      side = entry["side"];
    }
    let order: number | undefined;
    if (Object.prototype.hasOwnProperty.call(entry, "order")) {
      if (flow !== "branch") {
        throw invalidArgument(label + ".order 只允许在 flow=branch 时出现");
      }
      const value = entry["order"];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw invalidArgument(label + ".order 必须是非负整数");
      }
      order = value;
    }
    edits.push({
      editRef: ref,
      fromRef,
      flow,
      description,
      ...(side !== undefined ? { side } : {}),
      ...(order !== undefined ? { order } : {}),
    });
  }
  return { action: "rearrange", edits };
}

export async function runRearrange(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("rearrange", args);
  const mode = parseOutputMode(parsed);
  const verbose = parsed.values.has("verbose");
  const root = await workspaceRoot(parsed, ctx);
  const file = await readJsonInputFile("rearrange", parsed, ctx);
  // 先统一报告 JSON 语法错误（带文件路径），再由 parseRearrangeSpec 检查结构。
  parseJsonInput(file.text, file, "rearrange");
  const action = parseRearrangeSpec(file.text);
  return submitWriteAction("rearrange", action, root, ctx, mode, verbose);
}

/* -------------------------------- important ------------------------------- */

/**
 * 设置／取消重要标记。
 *
 * --ref 直接提交（凭据失效由服务返回 412，不自行刷新哈希）；
 * --node 先做一次真实在线 meta 读取取得 ref，离线不伪造凭据。
 */
export async function runImportant(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("important", args);
  const mode = parseOutputMode(parsed);
  const verbose = parsed.values.has("verbose");
  const root = await workspaceRoot(parsed, ctx);
  const ref = parsed.values.get("ref");
  const nodeId = parsed.values.get("node");
  if ((ref === undefined) === (nodeId === undefined)) {
    throw new UsageError("important 需要且只能给一个 --ref 或 --node");
  }
  const on = parsed.values.has("on");
  const off = parsed.values.has("off");
  if (on === off) {
    throw new UsageError("important 需要且只能给一个 --on 或 --off");
  }
  const important = on;

  let editRef: string;
  let service: ResolvedService | undefined;
  if (ref !== undefined) {
    editRef = ref;
  } else {
    service = await resolveServiceForWorkspace(root, ctx.fetchImpl ?? fetch);
    const read = await readAgentNode(
      service,
      nodeId as string,
      { meta: true },
      ctx.fetchImpl ?? fetch,
    );
    editRef = read.editRef.ref;
  }

  const action: AgentChangeAction = { action: "setImportance", editRef, important };
  return submitWriteAction("important", action, root, ctx, mode, verbose, {
    ...(service !== undefined ? { resolvedService: service } : {}),
  });
}

/* ------------------------------- create-root ------------------------------ */

export async function runCreateTopic(args: readonly string[], ctx: CliContext): Promise<number> {
  return runCreate("create-topic", args, ctx, true);
}

export async function runCreateRoot(args: readonly string[], ctx: CliContext): Promise<number> {
  return runCreate("create-root", args, ctx, false);
}

async function runCreate(
  command: "create-topic" | "create-root",
  args: readonly string[],
  ctx: CliContext,
  createTopic: boolean,
): Promise<number> {
  const parsed = parseCommandArgs(command, args);
  const mode = parseOutputMode(parsed);
  const verbose = parsed.values.has("verbose");
  const root = await workspaceRoot(parsed, ctx);
  const topicTitle = requireParameter(parsed, command, "topic-title");
  const title =
    parsed.values.get("title") ?? (createTopic ? topicTitle : undefined);
  if (title === undefined) throw new UsageError("缺少 --title");
  const body = await readBodyFromParsed(parsed, ctx);
  if (body === undefined) {
    throw new UsageError("缺少正文：--body／--body-file／--body-stdin 三选一");
  }
  const state = parseEnumValue(parsed.values.get("state"), NODE_STATES, "--state");
  const summary = parsed.values.get("summary");
  const action: AgentChangeAction = {
    action: createTopic ? "createTopic" : "createRoot",
    ...(createTopic && parsed.values.has("directory")
      ? { directory: parsed.values.get("directory") as string }
      : {}),
    topicTitle,
    title,
    body: normalizeText(body.text),
    ...(summary !== undefined ? { summary } : {}),
    ...(state !== undefined ? { state } : {}),
  };
  return submitWriteAction(command, action, root, ctx, mode, verbose);
}
