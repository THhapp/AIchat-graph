/** CLI 共享选项与数值解析；完整命令参数表在 command-specs（单一来源）。 */
import type { OptionSpec } from "./args.js";
import { UsageError, invalidArgument } from "./errors.js";

/** 默认 JSON；--text 为人类摘要。全 CLI 只保留这一份。 */
export const OUTPUT_OPTIONS = [
  { name: "json", boolean: true },
  { name: "text", boolean: true },
] as const satisfies readonly OptionSpec[];

/** 省略 --workspace 时使用当前目录（serve 除外，由命令自行要求显式给出）。 */
export const WORKSPACE_OPTION = { name: "workspace" } as const satisfies OptionSpec;

export interface IntegerOptionOptions {
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  /** 缺值时抛用法错误“缺少 <label>”；默认返回 undefined。 */
  readonly required?: boolean | undefined;
  /** 非十进制整数时的说明，默认“必须是非负整数”（--port 沿用“必须是整数”）。 */
  readonly integerMessage?: string | undefined;
}

/**
 * 解析一个可选的非负十进制整数并检查范围。
 * 错误码固定为 usage（INVALID_ARGUMENT）；范围错误在 details 带 min／max。
 */
export function parseIntegerOption(
  raw: string | undefined,
  label: string,
  options: IntegerOptionOptions & { required: true },
): number;
export function parseIntegerOption(
  raw: string | undefined,
  label: string,
  options?: IntegerOptionOptions,
): number | undefined;
export function parseIntegerOption(
  raw: string | undefined,
  label: string,
  options: IntegerOptionOptions = {},
): number | undefined {
  if (raw === undefined) {
    if (options.required) throw new UsageError("缺少 " + label);
    return undefined;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw invalidArgument(
      `${label} ${options.integerMessage ?? "必须是非负整数"}: ${raw}`,
    );
  }
  const value = Number(raw);
  const { min, max } = options;
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    const bounds =
      min !== undefined && max !== undefined
        ? `${min}-${max}`
        : min !== undefined
          ? `>=${min}`
          : `<=${max}`;
    throw invalidArgument(
      `${label} 必须在 ${bounds} 之间: ${raw}`,
      {
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
      },
    );
  }
  return value;
}
