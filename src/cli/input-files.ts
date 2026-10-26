/**
 * --input <file>／--input-stdin 的统一来源解析。
 *
 * 返回原文与相对路径基准：文件模式以输入文件所在目录为基准，stdin 模式用调用
 * 时的 cwd。batch 的 bodyFile／appendFile／replaceFile 与 rearrange 的输入都
 * 复用这里的基准，避免各命令各自解释相对路径。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ParsedArgs } from "./args.js";
import { readStdinText } from "./body-input.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT_CODES, UsageError } from "./errors.js";

export interface JsonInputFile {
  readonly text: string;
  /** 解析相对正文文件路径的基准目录。 */
  readonly baseDir: string;
  /** --input 文件的绝对路径；stdin 为 null。 */
  readonly sourcePath: string | null;
}

export async function readJsonInputFile(
  command: string,
  parsed: ParsedArgs,
  ctx: CliContext,
): Promise<JsonInputFile> {
  const input = parsed.values.get("input");
  const fromStdin = parsed.values.has("input-stdin");
  if (input !== undefined && fromStdin) {
    throw new UsageError("--input 与 --input-stdin 互斥，只能给一个");
  }
  if (input === undefined && !fromStdin) {
    throw new UsageError(command + " 需要 --input <file.json> 或 --input-stdin");
  }
  if (fromStdin) {
    return { text: await (ctx.stdin ?? readStdinText)(), baseDir: ctx.cwd, sourcePath: null };
  }
  const absolute = path.resolve(ctx.cwd, input as string);
  let text: string;
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch (error) {
    throw new CliError("INPUT_UNREADABLE", "无法读取 --input 文件: " + absolute, EXIT_CODES.usage, {
      details: { path: absolute },
      cause: error,
    });
  }
  return { text, baseDir: path.dirname(absolute), sourcePath: absolute };
}

/** 输入 JSON 解析失败：区分文件与 stdin，便于调用方定位。 */
export function parseJsonInput(text: string, input: JsonInputFile, command: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const label = input.sourcePath ?? "stdin";
    throw new CliError(
      "INPUT_INVALID_JSON",
      command + " 的 JSON 输入不是合法 JSON: " + label,
      EXIT_CODES.usage,
      { details: { path: label }, cause: error },
    );
  }
}
