/**
 * 低摩擦在线写入命令：edit／branch／connect／create-root。
 *
 * 设计要点：
 * - 写入凭据只来自真实在线读取（read --node 返回的 editRef.ref），CLI 不伪造、不按编号重定位；
 * - 机械字段（requestId UUID、节点 ID、路径、branch order）由服务生成或按规则推导，
 *   调用方不必手拼大量 JSON 转义；
 * - 一次提交只做一个动作；复杂变更仍走 check／apply 底层链路；
 * - 超时／断线不换 requestId 重发：报告 RESULT_UNKNOWN，交给 status 或重读决定。
 */
import type { AgentChangeAction, AgentChangeResponse } from "../shared/protocol.js";
import { parseOptions, type ParsedArgs } from "./args.js";
import { readAppendText, readReplacePairs, resolveBody } from "./body-input.js";
import { emit, invalidArgument, parseOutputMode, workspaceRoot } from "./commands.js";
import type { CliContext } from "./context.js";
import { submitAgentChange } from "./agent-client.js";
import { EXIT_CODES, UsageError } from "./errors.js";
import { resolveServiceForWorkspace } from "./service-client.js";

const NODE_STATES = ["agreed", "proposed", "reference"] as const;
const FLOWS = ["root", "next", "branch"] as const;
const SIDES = ["left", "right"] as const;

type NodeState = (typeof NODE_STATES)[number];
type NodeFlow = (typeof FLOWS)[number];
type BranchSide = (typeof SIDES)[number];

const OUTPUT = [
  { name: "json", boolean: true },
  { name: "text", boolean: true },
] as const;

const BODY_SOURCE = [
  { name: "body" },
  { name: "body-file" },
  { name: "body-stdin", boolean: true },
] as const;

function parseEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw invalidArgument(`${label} 只能是 ${allowed.join("／")}，收到 ${raw}`);
  }
  return raw as T;
}

function parseOrder(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw)) throw invalidArgument(`--order 必须是非负整数: ${raw}`);
  return Number(raw);
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function ioOf(ctx: CliContext) {
  return { cwd: ctx.cwd, stdin: ctx.stdin ?? (async () => "") };
}

async function readBodyInput(parsed: ParsedArgs, ctx: CliContext) {
  return resolveBody(
    {
      ...(parsed.values.get("body") !== undefined
        ? { body: parsed.values.get("body") as string }
        : {}),
      ...(parsed.values.get("body-file") !== undefined
        ? { bodyFile: parsed.values.get("body-file") as string }
        : {}),
      bodyStdin: parsed.values.has("body-stdin"),
    },
    ioOf(ctx),
  );
}

/** patchNode 的正文模式：整篇／追加／局部替换互斥，全部由调用方显式给出。 */
async function readBodyPatch(parsed: ParsedArgs, ctx: CliContext) {
  const body = await readBodyInput(parsed, ctx);
  const appendFile = await readAppendText(parsed.values.get("append-file"), ioOf(ctx));
  const replaceFile = parsed.values.get("replace-file");
  const replace = await readReplacePairs(
    { ...(replaceFile !== undefined ? { replaceFile } : {}) },
    ioOf(ctx),
  );
  const modes = [
    body !== undefined ? "body" : undefined,
    appendFile !== undefined ? "append" : undefined,
    replace !== undefined ? "replace" : undefined,
  ].filter((item): item is string => item !== undefined);
  if (modes.length > 1) {
    throw new UsageError(`正文修改模式互斥，最多给一个，收到 ${modes.join(" + ")}`);
  }
  if (body !== undefined) return { body: normalizeText(body.text) };
  if (appendFile !== undefined) {
    // 追加段之间留一个空行，读起来仍是一个自然段的分界；不猜原正文结尾。
    return { append: "\n\n" + normalizeText(appendFile.text).replace(/\n+$/, "") };
  }
  if (replace !== undefined) {
    // 共享 DTO 用可变数组；这里只做形状转换，不改内容。
    return { replace: replace.map((pair) => ({ old: pair.old, new: pair.new })) };
  }
  return {};
}

function summarize(command: string, response: AgentChangeResponse): string[] {
  const lines = [
    `${command} ${response.state}  revision ${response.revision}  requestId ${response.requestId}`,
  ];
  if (response.created.nodeIds.length > 0) {
    lines.push(`created nodes: ${response.created.nodeIds.join(", ")}`);
  }
  if (response.created.topicId) lines.push(`created topic: ${response.created.topicId}`);
  if (response.created.paths.length > 0) lines.push(`paths: ${response.created.paths.join(", ")}`);
  for (const file of response.touchedFiles) {
    lines.push(`  ${file.path}  ${file.beforeSha256 ?? "(new)"} → ${file.afterSha256 ?? "(deleted)"}`);
  }
  if (response.editRef) lines.push(`editRef ${response.editRef.ref}`);
  if (response.replayed) lines.push("replayed: true");
  for (const diagnostic of response.diagnostics) {
    lines.push(`  [${diagnostic.code}] ${diagnostic.message}`);
  }
  return lines;
}

async function submit(
  command: string,
  action: AgentChangeAction,
  args: readonly string[],
  ctx: CliContext,
  rootOverride: string | undefined,
): Promise<number> {
  const parsed = parseOptions(args, action === undefined ? [] : OPTIONS_FOR[command] ?? [], 0);
  void parsed;
  const mode = rootOverride === undefined ? "json" : "json";
  void mode;
  return EXIT_CODES.ok;
}

const OPTIONS_FOR: Record<string, never> = {};

/* ---------------------------------- edit ---------------------------------- */

const EDIT_OPTIONS = [
  { name: "workspace" },
  { name: "ref" },
  { name: "title" },
  { name: "state" },
  { name: "summary" },
  { name: "append-file" },
  { name: "replace-file" },
  ...BODY_SOURCE,
  ...OUTPUT,
] as const;

export async function runEdit(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(args, EDIT_OPTIONS, 0);
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const ref = parsed.values.get("ref");
  if (ref === undefined) throw new UsageError("缺少 --ref（来自 read --node 的 editRef.ref）");

  const title = parsed.values.get("title");
  const state = parseEnum(parsed.values.get("state"), NODE_STATES, "--state");
  const summary = parsed.values.get("summary");
  const bodyPatch = await readBodyPatch(parsed, ctx);
  const hasBody = bodyPatch.body !== undefined || bodyPatch.append !== undefined || bodyPatch.replace !== undefined;
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
    ...(bodyPatch.replace !== undefined ? { replace: bodyPatch.replace } : {}),
  };
  return submitAction("edit", action, root, ctx, mode);
}

/* --------------------------------- branch --------------------------------- */

export async function runBranch(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(
    args,
    [
      { name: "workspace" },
      { name: "from-ref" },
      { name: "title" },
      { name: "description" },
      { name: "state" },
      { name: "side" },
      { name: "order" },
      ...BODY_SOURCE,
      ...OUTPUT,
    ],
    0,
  );
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const fromRef = parsed.values.get("from-ref");
  if (fromRef === undefined) throw new UsageError("缺少 --from-ref（来源节点的 editRef.ref）");
  const title = parsed.values.get("title");
  if (title === undefined) throw new UsageError("缺少 --title");
  const body = await readBodyInput(parsed, ctx);
  if (body === undefined) {
    throw new UsageError("缺少正文：--body／--body-file／--body-stdin 之一");
  }
  const description = parsed.values.get("description");
  if (description === undefined) {
    throw new UsageError(
      "branch 必须给出 --description：解释这个旁支为什么接到来源（不能用空话占位）",
    );
  }
  const state = parseEnum(parsed.values.get("state"), NODE_STATES, "--state");
  const side = parseEnum(parsed.values.get("side"), SIDES, "--side");
  const order = parseOrder(parsed.values.get("order"));
  const action: AgentChangeAction = {
    action: "createBranch",
    editRef: fromRef,
    title,
    body: normalizeText(body.text),
    description,
    ...(state !== undefined ? { state } : {}),
    ...(side !== undefined ? { side } : {}),
    ...(order !== undefined ? { order } : {}),
  };
  return submitAction("branch", action, root, ctx, mode);
}

/* ---------------------------------- next ---------------------------------- */

/**
 * 纵向后继：一样是"新建一张卡并接到来源"，只是 flow 为 next。
 *
 * 为什么不复用 branch ＋ connect：那需要两次提交，中间还会短暂存在一个分支；
 * 这里一次提交表达"沿这条线继续"。来源已有 next 时服务返回 409，CLI 不自动
 * 顶掉旧主线，也不替调用方决定插入位置。
 */
export async function runNext(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(
    args,
    [
      { name: "workspace" },
      { name: "from-ref" },
      { name: "title" },
      { name: "description" },
      { name: "state" },
      { name: "topic-id" },
      ...BODY_SOURCE,
      ...OUTPUT,
    ],
    0,
  );
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const fromRef = parsed.values.get("from-ref");
  if (fromRef === undefined) throw new UsageError("缺少 --from-ref（前一张卡的 editRef.ref）");
  const title = parsed.values.get("title");
  if (title === undefined) throw new UsageError("缺少 --title");
  const body = await readBodyInput(parsed, ctx);
  if (body === undefined) {
    throw new UsageError("缺少正文：--body／--body-file／--body-stdin 之一");
  }
  const description = parsed.values.get("description");
  if (description === undefined) {
    throw new UsageError("next 必须给出 --description：解释为什么在这条线继续下去");
  }
  const state = parseEnum(parsed.values.get("state"), NODE_STATES, "--state");
  const topicId = parsed.values.get("topic-id");
  // 直接使用共享 DTO：字段拼写与服务端校验同源，不在这里复制一份类型。
  const action: AgentChangeAction = {
    action: "createNext",
    editRef: fromRef,
    title,
    body: normalizeText(body.text),
    description,
    ...(state !== undefined ? { state } : {}),
    ...(topicId !== undefined ? { topicId } : {}),
  };
  return submitAction("next", action, root, ctx, mode);
}

/* --------------------------------- connect -------------------------------- */

export async function runConnect(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(
    args,
    [
      { name: "workspace" },
      { name: "ref" },
      { name: "from-ref" },
      { name: "flow" },
      { name: "side" },
      { name: "order" },
      { name: "description" },
      ...OUTPUT,
    ],
    0,
  );
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const ref = parsed.values.get("ref");
  if (ref === undefined) throw new UsageError("缺少 --ref（目标节点的 editRef.ref）");
  const fromRef = parsed.values.get("from-ref");
  const flow = parseEnum(parsed.values.get("flow"), FLOWS, "--flow");
  const side = parseEnum(parsed.values.get("side"), SIDES, "--side");
  const order = parseOrder(parsed.values.get("order"));
  const description = parsed.values.get("description");
  if (description === undefined) {
    throw new UsageError("connect 必须给出 --description：解释为什么现在接到这个来源");
  }
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
  return submitAction("connect", action, root, ctx, mode);
}

/* ------------------------------- create-root ------------------------------ */

export async function runCreateTopic(args: readonly string[], ctx: CliContext): Promise<number> {
  return runCreateRoot(args, ctx, true);
}

export async function runCreateRoot(args: readonly string[], ctx: CliContext, createTopic = false): Promise<number> {
  const parsed = parseOptions(
    args,
    [
      { name: "workspace" },
      { name: "topic-title" },
      ...(createTopic ? [{ name: "directory" }] : []),
      { name: "title" },
      { name: "state" },
      ...BODY_SOURCE,
      ...OUTPUT,
    ],
    0,
  );
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const topicTitle = parsed.values.get("topic-title");
  if (topicTitle === undefined) throw new UsageError("缺少 --topic-title");
  const title = parsed.values.get("title") ?? (createTopic ? topicTitle : undefined);
  if (title === undefined) throw new UsageError("缺少 --title");
  const body = await readBodyInput(parsed, ctx);
  if (body === undefined) {
    throw new UsageError("缺少正文：--body／--body-file／--body-stdin 之一");
  }
  const state = parseEnum(parsed.values.get("state"), NODE_STATES, "--state");
  const action: AgentChangeAction = {
    action: createTopic ? "createTopic" : "createRoot",
    ...(createTopic && parsed.values.has("directory") ? { directory: parsed.values.get("directory")! } : {}),
    topicTitle,
    title,
    body: normalizeText(body.text),
    ...(state !== undefined ? { state } : {}),
  };
  return submitAction(createTopic ? "create-topic" : "create-root", action, root, ctx, mode);
}

/* --------------------------------- 共用提交 -------------------------------- */

async function submitAction(
  command: string,
  action: AgentChangeAction,
  root: string,
  ctx: CliContext,
  mode: "json" | "text",
): Promise<number> {
  const service = await resolveServiceForWorkspace(root, ctx.fetchImpl ?? fetch);
  const result = await submitAgentChange(service, action, ctx.fetchImpl ?? fetch);
  const payload = {
    ok: true,
    command,
    requestId: result.requestId,
    httpStatus: result.httpStatus,
    service: {
      url: service.baseUrl,
      workspaceId: service.identity.workspaceId,
      instanceId: service.identity.instanceId,
      rootPath: service.identity.rootPath,
    },
    result: result.response,
  };
  emit(ctx, mode, payload, summarize(command, result.response));
  return EXIT_CODES.ok;
}