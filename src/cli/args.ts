/**
 * 极小的参数解析器：Node 24 内置 parseArgs 对重复选项、位置参数与未知标志的
 * 报错信息不统一，这里保留完全可控的严格行为，避免引入 commander。
 *
 * 规则：
 * - 支持 --name value、--name=value 与无值开关 --text／--json／--help；
 * - --name value 形式下值不能以 "--" 开头（需要此类值请用 --name=value）；
 * - 不接受位置参数，除非调用方显式声明上限；
 * - 未知选项、向开关传值、重复单值选项、缺值一律 UsageError。
 */
import { UsageError } from "./errors.js";

export interface OptionSpec {
  readonly name: string;
  /** 无值开关。 */
  readonly boolean?: boolean;
  /** 该值可重复出现（如多次 --node）。 */
  readonly repeatable?: boolean;
}

export interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>;
  readonly lists: ReadonlyMap<string, readonly string[]>;
  readonly positional: readonly string[];
}

interface MutableState {
  values: Map<string, string>;
  lists: Map<string, string[]>;
  positional: string[];
}

function splitOption(arg: string): { name: string; inlineValue?: string } {
  const equals = arg.indexOf("=");
  if (equals === -1) return { name: arg.slice(2) };
  return { name: arg.slice(2, equals), inlineValue: arg.slice(equals + 1) };
}

function recordValue(
  spec: OptionSpec,
  name: string,
  value: string,
  state: MutableState,
): void {
  if (spec.repeatable) {
    if (value.length === 0) throw new UsageError("选项 --" + name + " 的值不能为空");
    const bucket = state.lists.get(name);
    if (bucket) bucket.push(value);
    else state.lists.set(name, [value]);
    return;
  }
  if (state.values.has(name)) throw new UsageError("选项 --" + name + " 不能重复");
  if (value.length === 0) throw new UsageError("选项 --" + name + " 的值不能为空");
  state.values.set(name, value);
}

/**
 * @param args 去掉 node 与脚本路径后的 argv
 * @param options 允许的选项
 * @param maxPositional 允许的位置参数数量，默认 0
 */
export function parseOptions(
  args: readonly string[],
  options: readonly OptionSpec[],
  maxPositional = 0,
): ParsedArgs {
  const specByName = new Map(options.map((option) => [option.name, option]));
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
    if (name.length === 0) throw new UsageError("空选项名：--");
    const spec = specByName.get(name);
    if (!spec) throw new UsageError("未知选项 --" + name);
    if (spec.boolean) {
      if (inlineValue !== undefined) {
        throw new UsageError("选项 --" + name + " 不接受值");
      }
      state.values.set(name, "true");
      continue;
    }
    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      const next = args[index];
      if (next === undefined || next === "--" || next.startsWith("--")) {
        throw new UsageError("选项 --" + name + " 需要一个值");
      }
      value = next;
      index += 1;
    }
    recordValue(spec, name, value, state);
  }
  if (state.positional.length > maxPositional) {
    throw new UsageError("多余的参数：" + state.positional.slice(maxPositional).join(" "));
  }
  return { values: state.values, lists: state.lists, positional: state.positional };
}

export function flag(parsed: ParsedArgs, name: string): boolean {
  return parsed.values.has(name);
}

/** 可重复选项的出现顺序；仅用于 repeatable 选项。 */
export function repeated(parsed: ParsedArgs, name: string): readonly string[] {
  return parsed.lists.get(name) ?? [];
}