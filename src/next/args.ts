/**
 * Interface 4 CLI: 参数解析、命令表类型与错误模型。
 *
 * 命令表（cli.ts 的 COMMANDS）同时驱动解析与 help，避免帮助与实际参数漂移。
 * 错误统一为 CliFailure：退出码 2/3/4/5/6/7/8 对应 usage/workspace/version/
 * operation/validation/service/result-unknown；错误体由 cli.ts 序列化为
 * { ok:false, error:{ code, message, details?, usage? } }。
 */

export const EXIT_CODES = {
  ok: 0,
  usage: 2,
  workspace: 3,
  versionConflict: 4,
  operationConflict: 5,
  validation: 6,
  service: 7,
  resultUnknown: 8,
  http: 9,
  internal: 10,
  notFound: 11,
} as const;

export type CliExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface CliFailureOptions {
  readonly details?: Record<string, unknown> | undefined;
  readonly diagnostics?: readonly unknown[] | undefined;
  readonly extras?: Record<string, unknown> | undefined;
  readonly usage?: string | undefined;
  readonly cause?: unknown;
}

export class CliFailure extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: Record<string, unknown> | undefined;
  readonly diagnostics: readonly unknown[] | undefined;
  readonly extras: Record<string, unknown> | undefined;
  readonly usage: string | undefined;

  constructor(code: string, message: string, exitCode: number, options: CliFailureOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliFailure";
    this.code = code;
    this.exitCode = exitCode;
    this.details = options.details;
    this.diagnostics = options.diagnostics;
    this.extras = options.extras;
    this.usage = options.usage;
  }
}

export function usageFailure(
  message: string,
  options: { details?: Record<string, unknown> | undefined; usage?: string | undefined } = {},
): CliFailure {
  return new CliFailure("USAGE", message, EXIT_CODES.usage, {
    ...(options.details !== undefined ? { details: options.details } : {}),
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
  });
}

export function workspaceFailure(
  code: string,
  message: string,
  details?: Record<string, unknown> | undefined,
): CliFailure {
  return new CliFailure(code, message, EXIT_CODES.workspace, {
    ...(details !== undefined ? { details } : {}),
  });
}

export function versionConflictFailure(
  message: string,
  details?: Record<string, unknown> | undefined,
): CliFailure {
  return new CliFailure("VERSION_CONFLICT", message, EXIT_CODES.versionConflict, {
    ...(details !== undefined ? { details } : {}),
  });
}

export function operationConflictFailure(
  code: string,
  message: string,
  details?: Record<string, unknown> | undefined,
): CliFailure {
  return new CliFailure(code, message, EXIT_CODES.operationConflict, {
    ...(details !== undefined ? { details } : {}),
  });
}

export function validationFailure(
  code: string,
  message: string,
  details?: Record<string, unknown> | undefined,
  diagnostics?: readonly unknown[] | undefined,
): CliFailure {
  return new CliFailure(code, message, EXIT_CODES.validation, {
    ...(details !== undefined ? { details } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  });
}

export function serviceFailure(
  code: string,
  message: string,
  details?: Record<string, unknown> | undefined,
): CliFailure {
  return new CliFailure(code, message, EXIT_CODES.service, {
    ...(details !== undefined ? { details } : {}),
  });
}

export function notFoundFailure(
  code: string,
  message: string,
  details?: Record<string, unknown> | undefined,
): CliFailure {
  return new CliFailure(code, message, EXIT_CODES.notFound, {
    ...(details !== undefined ? { details } : {}),
  });
}

export function internalFailure(message: string, cause?: unknown): CliFailure {
  return new CliFailure("INTERNAL", message, EXIT_CODES.internal, {
    ...(cause !== undefined ? { cause } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * 命令表与参数
 * ------------------------------------------------------------------ */

export type OptionType = "string" | "path" | "integer" | "enum" | "flag";

export interface OptionSpec {
  /** 不含 -- 的选项名。 */
  readonly name: string;
  readonly type?: OptionType;
  readonly boolean?: boolean;
  readonly repeatable?: boolean;
  readonly required?: boolean;
  readonly allowEmpty?: boolean;
  readonly valueName?: string;
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly defaultValue?: string | number;
  readonly description: string;
}

export interface PositionalSpec {
  readonly name: string;
  readonly required?: boolean;
  readonly description: string;
}

export type CommandGroup = "read" | "write" | "workspace" | "meta";

export interface CommandSpec {
  readonly name: string;
  readonly group: CommandGroup;
  readonly summary: string;
  readonly usage: readonly string[];
  readonly positionals?: readonly PositionalSpec[];
  readonly options: readonly OptionSpec[];
  readonly constraints?: readonly string[];
  readonly examples?: readonly string[];
  readonly resultFields?: readonly string[];
}

export interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>;
  readonly lists: ReadonlyMap<string, readonly string[]>;
  readonly positional: readonly string[];
}

interface MutableState {
  readonly values: Map<string, string>;
  readonly lists: Map<string, string[]>;
  readonly positional: string[];
}

function specByName(spec: CommandSpec): Map<string, OptionSpec> {
  return new Map(spec.options.map((option) => [option.name, option]));
}

function splitOption(arg: string): { name: string; inlineValue?: string } {
  const equals = arg.indexOf("=");
  if (equals === -1) return { name: arg.slice(2) };
  return { name: arg.slice(2, equals), inlineValue: arg.slice(equals + 1) };
}

function validateValue(option: OptionSpec, name: string, raw: string, usage: string | undefined): string {
  if (option.type === "integer") {
    if (!/^[0-9]+$/.test(raw)) {
      throw usageFailure("--" + name + " 必须是非负整数，收到 " + raw, {
        details: { field: name, value: raw },
        usage,
      });
    }
    const value = Number(raw);
    const min = option.min;
    const max = option.max;
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      const bounds =
        min !== undefined && max !== undefined
          ? min + "-" + String(max)
          : min !== undefined
            ? ">=" + String(min)
            : "<=" + String(max);
      throw usageFailure("--" + name + " 必须在 " + bounds + " 之间，收到 " + raw, {
        details: { field: name, value, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) },
        usage,
      });
    }
    return raw;
  }
  if (option.type === "enum" && option.values !== undefined) {
    if (!option.values.includes(raw)) {
      throw usageFailure(
        "--" + name + " 只能是 " + option.values.join("／") + "，收到 " + raw,
        { details: { field: name, value: raw, values: [...option.values] }, usage },
      );
    }
  }
  if (raw.length === 0 && option.allowEmpty !== true) {
    throw usageFailure("--" + name + " 的值不能为空", { details: { field: name }, usage });
  }
  return raw;
}

function recordValue(
  option: OptionSpec,
  name: string,
  raw: string,
  state: MutableState,
  usage: string | undefined,
): void {
  const value = validateValue(option, name, raw, usage);
  if (option.repeatable === true) {
    const bucket = state.lists.get(name);
    if (bucket) bucket.push(value);
    else state.lists.set(name, [value]);
    return;
  }
  if (state.values.has(name)) {
    throw usageFailure("选项 --" + name + " 不能重复", { details: { field: name }, usage });
  }
  state.values.set(name, value);
}

/** 按命令表解析参数；未知选项／类型错误／多余位置参数都是 usage 失败。 */
export function parseCommandArgs(spec: CommandSpec, args: readonly string[]): ParsedArgs {
  const usage = spec.usage[0];
  const options = specByName(spec);
  const state: MutableState = { values: new Map(), lists: new Map(), positional: [] };
  let index = 0;
  let endOfOptions = false;
  while (index < args.length) {
    const arg = args[index];
    index += 1;
    if (arg === undefined) continue;
    if (endOfOptions) {
      state.positional.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      state.positional.push(arg);
      continue;
    }
    const { name, inlineValue } = splitOption(arg);
    if (name.length === 0) throw usageFailure("空选项名：--", { usage });
    const option = options.get(name);
    if (option === undefined) {
      throw usageFailure("未知选项 --" + name, { details: { field: name }, usage });
    }
    if (option.boolean === true) {
      if (inlineValue !== undefined) throw usageFailure("选项 --" + name + " 不接受值", { usage });
      state.values.set(name, "true");
      continue;
    }
    let raw: string;
    if (inlineValue !== undefined) {
      raw = inlineValue;
    } else {
      const next = args[index];
      if (next === undefined || next === "--" || next.startsWith("--")) {
        throw usageFailure("选项 --" + name + " 需要一个值", {
          details: { field: name },
          usage,
        });
      }
      raw = next;
      index += 1;
    }
    recordValue(option, name, raw, state, usage);
  }
  const maxPositional = spec.positionals?.length ?? 0;
  if (state.positional.length > maxPositional) {
    throw usageFailure("多余的参数：" + state.positional.slice(maxPositional).join(" "), { usage });
  }
  for (const positional of (spec.positionals ?? []).slice(state.positional.length)) {
    if (positional.required === true) {
      throw usageFailure("缺少参数 " + positional.name + "：" + positional.description, {
        details: { field: positional.name },
        usage,
      });
    }
  }
  return { values: state.values, lists: state.lists, positional: state.positional };
}

export function flag(parsed: ParsedArgs, name: string): boolean {
  return parsed.values.has(name);
}

export function repeated(parsed: ParsedArgs, name: string): readonly string[] {
  return parsed.lists.get(name) ?? [];
}

export function requireValue(parsed: ParsedArgs, spec: CommandSpec, name: string): string {
  const value = parsed.values.get(name);
  if (value !== undefined) return value;
  const option = spec.options.find((entry) => entry.name === name);
  throw usageFailure(
    "缺少 --" + name + (option !== undefined ? "：" + option.description : ""),
    { details: { field: name }, usage: spec.usage[0] },
  );
}

export interface IntegerOptions {
  readonly min?: number;
  readonly max?: number;
  readonly required?: boolean;
}

/** 解析已通过表校验的整数选项；未给出且 required 时报 usage 失败。 */
export function integerOption(
  parsed: ParsedArgs,
  spec: CommandSpec,
  name: string,
  options: IntegerOptions = {},
): number | undefined {
  const raw = parsed.values.get(name);
  if (raw === undefined) {
    if (options.required === true) {
      throw usageFailure("缺少 --" + name, { details: { field: name }, usage: spec.usage[0] });
    }
    return undefined;
  }
  const value = Number(raw);
  if (options.min !== undefined && value < options.min) {
    throw usageFailure("--" + name + " 必须大于等于 " + String(options.min), {
      details: { field: name, value, min: options.min },
      usage: spec.usage[0],
    });
  }
  if (options.max !== undefined && value > options.max) {
    throw usageFailure("--" + name + " 必须小于等于 " + String(options.max), {
      details: { field: name, value, max: options.max },
      usage: spec.usage[0],
    });
  }
  return value;
}
