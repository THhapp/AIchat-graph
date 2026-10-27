/**
 * batch：CLI 输入层把批次 JSON 转成共享 AgentBatchAction。
 *
 * 职责边界：
 * - CLI 只做文件字段（bodyFile／appendFile／replaceFile）的读取与形状转换，
 *   顺带给出结构化用法错误；业务语义（local 依赖、唯一 next、成环、占位）由
 *   服务端一次编译裁决。
 * - 相对正文文件路径以 --input 文件所在目录为基准；--input-stdin 用调用 cwd。
 * - HTTP 只发送已解析的 body／append／replace，服务端不读本机路径。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentBatchAction,
  AgentBatchCheckResponse,
  AgentBatchConnectOp,
  AgentBatchCreateOp,
  AgentBatchEditOp,
  AgentBatchEditPatch,
  AgentBatchImportantOp,
  AgentBatchOp,
  AgentNodeSelector,
  AgentReplace,
  BranchSide,
  NodeState,
} from "../shared/protocol.js";
import { isRecord } from "../shared/guards.js";
import { parseCommandArgs } from "./command-specs.js";
import { normalizeText, readReplacePairs, readStdinText, type IoContext } from "./body-input.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT_CODES, UsageError } from "./errors.js";
import { readJsonInputFile, parseJsonInput, type JsonInputFile } from "./input-files.js";
import { emit, parseOutputMode } from "./output.js";
import { submitAgentChange } from "./agent-client.js";
import { resolveServiceForWorkspace } from "./service-client.js";
import { submitWriteAction } from "./write-command.js";
import { workspaceRoot } from "./workspace.js";

const NODE_STATES = ["agreed", "proposed", "reference"] as const;
const FLOWS = ["next", "branch"] as const;
const SIDES = ["left", "right"] as const;

const EDIT_PATCH_FIELDS = new Set([
  "title",
  "state",
  "summary",
  "body",
  "append",
  "replace",
  "bodyFile",
  "appendFile",
  "replaceFile",
]);
const CREATE_FIELDS = new Set([
  "op",
  "as",
  "from",
  "flow",
  "title",
  "body",
  "bodyFile",
  "description",
  "summary",
  "state",
  "important",
  "side",
  "order",
]);
const CONNECT_FIELDS = new Set([
  "op",
  "target",
  "from",
  "flow",
  "description",
  "side",
  "order",
]);
const IMPORTANT_FIELDS = new Set(["op", "target", "important"]);

function batchError(message: string, details?: Record<string, unknown>): CliError {
  return new CliError("INVALID_BATCH_INPUT", message, EXIT_CODES.usage, {
    ...(details !== undefined ? { details } : {}),
  });
}

/** 已知字段放错位置：单行消息 + 字段路径／hint／help，不静默改写后提交。 */
function batchMisplacedError(
  fieldPath: string,
  hint: string,
  help = "aichat help batch --op edit --json",
): CliError {
  return batchError(fieldPath + " 不属于该操作；" + hint, { field: fieldPath, hint, help });
}

interface MisplacedHint {
  readonly hint: string;
}

/** 单卡 edit 的字段被误放进 batch edit.patch。 */
const EDIT_PATCH_MISPLACED: Readonly<Record<string, MisplacedHint>> = {
  important: {
    hint: '应放到 op=important：{"op":"important","target":{"ref":"..."},"important":true}；单卡也可 aichat edit --important true',
  },
  description: {
    hint: "应放到 op=connect.description；单卡也可 aichat edit --description <why>",
  },
  fromRef: {
    hint: "应放到 op=connect.from（同时给 flow 与 description）；单卡也可 aichat edit --from-ref <ref> --flow next|branch --description <why>",
  },
  flow: {
    hint: "应放到 op=connect.flow（同时给 description）；单卡也可 aichat edit --flow next|branch --description <why>",
  },
};

/** 单卡 edit 的入边／重要性字段被误放在 edit op 顶层。 */
const EDIT_OP_MISPLACED: Readonly<Record<string, MisplacedHint>> = {
  important: EDIT_PATCH_MISPLACED["important"] as MisplacedHint,
  description: EDIT_PATCH_MISPLACED["description"] as MisplacedHint,
  fromRef: EDIT_PATCH_MISPLACED["fromRef"] as MisplacedHint,
  flow: EDIT_PATCH_MISPLACED["flow"] as MisplacedHint,
};

function assertFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw batchError(label + " 未知字段: " + key, {
        field: label + "." + key,
        help: "aichat help batch --json",
      });
    }
  }
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw batchError(label + "." + key + " 必须是非空字符串", { field: key });
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value !== "string") throw batchError(label + "." + key + " 必须是字符串", { field: key });
  return value;
}

function optionalEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  label: string,
): T | undefined {
  const value = optionalString(record, key, label);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw batchError(label + "." + key + " 只能是 " + allowed.join("／") + "，收到 " + value, {
      field: key,
    });
  }
  return value as T;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value !== "boolean") throw batchError(label + "." + key + " 必须是布尔值", { field: key });
  return value;
}

function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw batchError(label + "." + key + " 必须是非负整数", { field: key });
  }
  return value;
}

async function readRelativeText(io: IoContext, relative: string, label: string): Promise<string> {
  const absolute = path.resolve(io.cwd, relative);
  try {
    return await fs.readFile(absolute, "utf8");
  } catch (error) {
    throw new CliError("INPUT_UNREADABLE", "无法读取 " + label + ": " + absolute, EXIT_CODES.usage, {
      details: { path: absolute },
      cause: error,
    });
  }
}

/** 来源选择：{ref} 或 {local}，二选一。 */
function selectorFrom(raw: unknown, label: string): AgentNodeSelector {
  if (!isRecord(raw)) throw batchError(label + " 必须是对象");
  assertFields(raw, new Set(["ref", "local"]), label);
  const ref = optionalString(raw, "ref", label);
  const local = optionalString(raw, "local", label);
  if ((ref === undefined) === (local === undefined)) {
    throw batchError(label + " 必须且只能给 ref 或 local 之一");
  }
  return { ...(ref !== undefined ? { ref } : {}), ...(local !== undefined ? { local } : {}) };
}

/** 已有节点目标：协议只允许 {ref}；local 只用于 create.from／connect.from。 */
function existingTarget(raw: unknown, label: string): { ref: string } {
  if (!isRecord(raw)) throw batchError(label + " 必须是对象");
  if ("local" in raw) {
    throw batchError(
      label + " 不能使用 local；target 只能是 {ref}（local 只用于 create.from／connect.from）",
      { field: label + ".local", help: "aichat help batch --op edit --json" },
    );
  }
  assertFields(raw, new Set(["ref"]), label);
  return { ref: requiredString(raw, "ref", label) };
}

async function inlineReplace(raw: unknown, label: string): Promise<AgentReplace[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw batchError(label + " 必须是非空数组");
  }
  return raw.map((item, index) => {
    const itemLabel = label + "[" + String(index) + "]";
    if (!isRecord(item)) throw batchError(itemLabel + " 必须是对象");
    assertFields(item, new Set(["old", "new"]), itemLabel);
    const old = requiredString(item, "old", itemLabel);
    const replacement = item["new"];
    if (typeof replacement !== "string") {
      throw batchError(itemLabel + ".new 必须是字符串");
    }
    return { old, new: replacement };
  });
}

/** edit.patch：三种正文模式互斥，每个模式最多一个来源。 */
async function patchFrom(raw: unknown, index: number, io: IoContext): Promise<AgentBatchEditPatch> {
  const label = "ops[" + String(index) + "].patch";
  if (!isRecord(raw)) throw batchError(label + " 必须是对象");
  for (const key of Object.keys(raw)) {
    if (EDIT_PATCH_FIELDS.has(key)) continue;
    const misplaced = EDIT_PATCH_MISPLACED[key];
    if (misplaced !== undefined) {
      throw batchMisplacedError(label + "." + key, misplaced.hint);
    }
  }
  assertFields(raw, EDIT_PATCH_FIELDS, label);

  const body = optionalString(raw, "body", label);
  const bodyFile = optionalString(raw, "bodyFile", label);
  const append = optionalString(raw, "append", label);
  const appendFile = optionalString(raw, "appendFile", label);
  const replace = raw["replace"];
  const replaceFile = optionalString(raw, "replaceFile", label);

  const bodyMode = body !== undefined || bodyFile !== undefined;
  const appendMode = append !== undefined || appendFile !== undefined;
  const replaceMode = replace !== undefined || replaceFile !== undefined;
  if ([bodyMode, appendMode, replaceMode].filter(Boolean).length > 1) {
    throw batchError(label + " body／append／replace 三种正文修改模式互斥", {
      field: label + ".patch",
    });
  }
  if (body !== undefined && bodyFile !== undefined) {
    throw batchError(label + " body 与 bodyFile 互斥", { field: label + ".body" });
  }
  if (append !== undefined && appendFile !== undefined) {
    throw batchError(label + " append 与 appendFile 互斥", { field: label + ".append" });
  }
  if (replace !== undefined && replaceFile !== undefined) {
    throw batchError(label + " replace 与 replaceFile 互斥", { field: label + ".replace" });
  }

  const title = optionalString(raw, "title", label);
  const state = optionalEnum(raw, "state", NODE_STATES, label);
  let summary: string | null | undefined;
  if ("summary" in raw) {
    const value = raw["summary"];
    if (value !== null && typeof value !== "string") {
      throw batchError(label + ".summary 必须是字符串或 null", { field: "summary" });
    }
    summary = value as string | null;
  }

  let resolvedBody: string | undefined;
  if (body !== undefined) resolvedBody = normalizeText(body);
  else if (bodyFile !== undefined) {
    resolvedBody = normalizeText(await readRelativeText(io, bodyFile, label + ".bodyFile"));
  }

  let resolvedAppend: string | undefined;
  if (append !== undefined) resolvedAppend = normalizeText(append);
  else if (appendFile !== undefined) {
    const text = await readRelativeText(io, appendFile, label + ".appendFile");
    if (text.length === 0) throw batchError(label + ".appendFile 内容为空", { field: "appendFile" });
    resolvedAppend = normalizeText(text);
  }

  let resolvedReplace: AgentReplace[] | undefined;
  if (replace !== undefined) resolvedReplace = await inlineReplace(replace, label + ".replace");
  else if (replaceFile !== undefined) {
    const pairs = await readReplacePairs({ replaceFile }, io);
    resolvedReplace = (pairs ?? []).map((pair) => ({ old: pair.old, new: pair.new }));
  }

  return {
    ...(title !== undefined ? { title } : {}),
    ...(state !== undefined ? { state: state as NodeState } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(resolvedBody !== undefined ? { body: resolvedBody } : {}),
    ...(resolvedAppend !== undefined ? { append: resolvedAppend } : {}),
    ...(resolvedReplace !== undefined ? { replace: resolvedReplace } : {}),
  };
}

async function editOp(raw: Record<string, unknown>, index: number, io: IoContext): Promise<AgentBatchEditOp> {
  const label = "ops[" + String(index) + "]";
  for (const key of Object.keys(raw)) {
    const misplaced = EDIT_OP_MISPLACED[key];
    if (misplaced !== undefined) {
      throw batchMisplacedError(label + "." + key, misplaced.hint);
    }
  }
  assertFields(raw, new Set(["op", "target", "patch"]), label);
  const target = existingTarget(raw["target"], label + ".target");
  const patch = await patchFrom(raw["patch"], index, io);
  return { op: "edit", target, patch };
}

async function createOp(raw: Record<string, unknown>, index: number, io: IoContext): Promise<AgentBatchCreateOp> {
  const label = "ops[" + String(index) + "]";
  if ("patch" in raw) {
    throw batchMisplacedError(
      label + ".patch",
      "内容修改请用 op=edit 的 patch；create 只创建新卡片",
    );
  }
  assertFields(raw, CREATE_FIELDS, label);
  const asName = requiredString(raw, "as", label);
  const from = selectorFrom(raw["from"], label + ".from");
  const flow = requiredString(raw, "flow", label);
  if (flow !== "next" && flow !== "branch") {
    throw batchError(label + ".flow 只能是 next／branch，收到 " + flow, { field: "flow" });
  }
  const title = requiredString(raw, "title", label);
  const description = requiredString(raw, "description", label);

  const body = optionalString(raw, "body", label);
  const bodyFile = optionalString(raw, "bodyFile", label);
  if ((body === undefined) === (bodyFile === undefined)) {
    throw batchError(label + " body 与 bodyFile 互斥且必须给一个", { field: "body" });
  }
  const resolvedBody =
    body !== undefined
      ? normalizeText(body)
      : normalizeText(await readRelativeText(io, bodyFile as string, label + ".bodyFile"));

  const summary = optionalString(raw, "summary", label);
  const state = optionalEnum(raw, "state", NODE_STATES, label);
  const important = optionalBoolean(raw, "important", label);
  const side = optionalEnum(raw, "side", SIDES, label);
  const order = optionalNonNegativeInteger(raw, "order", label);
  if (flow === "next" && (side !== undefined || order !== undefined)) {
    throw batchError(label + " flow=next 不能带 side／order", {
      field: label + ".flow",
      hint: "side／order 只在 flow=branch 时允许",
      help: "aichat help batch --op create --json",
    });
  }
  return {
    op: "create",
    as: asName,
    from,
    flow,
    title,
    body: resolvedBody,
    description,
    ...(summary !== undefined ? { summary } : {}),
    ...(state !== undefined ? { state: state as NodeState } : {}),
    ...(important !== undefined ? { important } : {}),
    ...(side !== undefined ? { side: side as BranchSide } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

function connectOp(raw: Record<string, unknown>, index: number): AgentBatchConnectOp {
  const label = "ops[" + String(index) + "]";
  if ("patch" in raw) {
    throw batchMisplacedError(
      label + ".patch",
      "内容修改请用 op=edit 的 patch；connect 只改最终入边",
    );
  }
  assertFields(raw, CONNECT_FIELDS, label);
  const target = existingTarget(raw["target"], label + ".target");
  const rawFrom = raw["from"];
  const from = rawFrom === undefined ? undefined : selectorFrom(rawFrom, label + ".from");
  const flow = optionalEnum(raw, "flow", FLOWS, label);
  const description = requiredString(raw, "description", label);
  const side = optionalEnum(raw, "side", SIDES, label);
  const order = optionalNonNegativeInteger(raw, "order", label);
  if (flow === "next" && (side !== undefined || order !== undefined)) {
    throw batchError(label + " flow=next 不能带 side／order", {
      field: label + ".flow",
      hint: "side／order 只在最终 flow=branch 时允许",
      help: "aichat help batch --op connect --json",
    });
  }
  return {
    op: "connect",
    target,
    description,
    ...(from !== undefined ? { from } : {}),
    ...(flow !== undefined ? { flow } : {}),
    ...(side !== undefined ? { side: side as BranchSide } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

function importantOp(raw: Record<string, unknown>, index: number): AgentBatchImportantOp {
  const label = "ops[" + String(index) + "]";
  assertFields(raw, IMPORTANT_FIELDS, label);
  const target = existingTarget(raw["target"], label + ".target");
  const important = raw["important"];
  if (typeof important !== "boolean") {
    throw batchError(label + ".important 必须是布尔值", { field: "important" });
  }
  return { op: "important", target, important };
}

/** 解析并转换整份批次输入；所有文件读取发生在这里。 */
export async function parseBatchInput(
  file: JsonInputFile,
  ctx: CliContext,
): Promise<AgentBatchAction> {
  const io: IoContext = { cwd: file.baseDir, stdin: ctx.stdin ?? readStdinText };
  const raw = parseJsonInput(file.text, file, "batch");
  if (!isRecord(raw)) throw batchError("batch 输入必须是 JSON 对象");
  assertFields(raw, new Set(["topicId", "ops"]), "batch 输入");
  const topicId = requiredString(raw, "topicId", "batch 输入");
  const rawOps = raw["ops"];
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    throw batchError("batch 输入的 ops 必须是非空数组", { field: "ops" });
  }
  const ops: AgentBatchOp[] = [];
  for (const [index, entry] of rawOps.entries()) {
    const label = "ops[" + String(index) + "]";
    if (!isRecord(entry)) throw batchError(label + " 必须是对象");
    const op = entry["op"];
    if (op === "edit") ops.push(await editOp(entry, index, io));
    else if (op === "create") ops.push(await createOp(entry, index, io));
    else if (op === "connect") ops.push(connectOp(entry, index));
    else if (op === "important") ops.push(importantOp(entry, index));
    else {
      throw batchError(label + ".op 只能是 edit／create／connect／important，收到 " + String(op), {
        field: "op",
      });
    }
  }
  return { action: "batch", topicId, ops };
}

/** dry-run 输出：只报告将改动的文件，不返回 created／refs。 */
function emitDryRun(
  ctx: CliContext,
  mode: "json" | "text",
  response: AgentBatchCheckResponse,
  httpStatus: number,
  service: Awaited<ReturnType<typeof resolveServiceForWorkspace>>,
  verbose: boolean,
): void {
  const diagnostics = Array.isArray(response.diagnostics) ? response.diagnostics : [];
  const files = Array.isArray(response.files) ? response.files : [];
  const payload = {
    ok: true,
    command: "batch",
    dryRun: true,
    state: response.state,
    requestId: response.requestId,
    workspaceId: response.workspaceId,
    topicId: response.topicId,
    summary: response.summary,
    files: files.map((entry) => ({ ...entry })),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(verbose
      ? {
          httpStatus,
          service: {
            url: service.baseUrl,
            workspaceId: service.identity.workspaceId,
            instanceId: service.identity.instanceId,
            rootPath: service.identity.rootPath,
          },
        }
      : {}),
  };
  const lines = [
    "batch dry-run checked  topic " +
      response.topicId +
      "  requestId " +
      response.requestId +
      "  files " +
      String(files.length),
    "summary: " + response.summary,
  ];
  for (const entry of files) {
    lines.push(
      "  " +
        entry.path +
        "  " +
        (entry.beforeSha256 ?? "(new)") +
        " -> " +
        (entry.nextSha256 ?? "(deleted)") +
        (entry.deleted ? "  deleted" : ""),
    );
  }
  for (const diagnostic of diagnostics) lines.push("  [" + diagnostic.code + "] " + diagnostic.message);
  if (verbose) lines.push("service " + service.baseUrl + "  HTTP " + String(httpStatus));
  emit(ctx, mode, payload, lines);
}

export async function runBatch(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("batch", args);
  const mode = parseOutputMode(parsed);
  const verbose = parsed.values.has("verbose");
  if (parsed.positional.length > 0) {
    throw new UsageError("batch 不接受位置参数，请用 --input 或 --input-stdin");
  }
  const root = await workspaceRoot(parsed, ctx);
  const file = await readJsonInputFile("batch", parsed, ctx);
  const action = await parseBatchInput(file, ctx);
  if (!parsed.values.has("dry-run")) {
    return submitWriteAction("batch", action, root, ctx, mode, verbose);
  }
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const service = await resolveServiceForWorkspace(root, fetchImpl);
  const result = await submitAgentChange<AgentBatchCheckResponse>(service, action, fetchImpl, {
    dryRun: true,
  });
  emitDryRun(ctx, mode, result.response, result.httpStatus, service, verbose);
  return EXIT_CODES.ok;
}
