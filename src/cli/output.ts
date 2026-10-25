/** CLI 的统一输出面：默认 JSON（便于 Agent 与管道），--text 为简短人类摘要。 */
import type { ParsedArgs } from "./args.js";
import type { CliContext, CliIo } from "./context.js";
import { UsageError } from "./errors.js";

export function emitJson(io: CliIo, value: unknown): void {
  io.stdout(JSON.stringify(value, null, 2) + "\n");
}

export function emitText(io: CliIo, lines: readonly string[]): void {
  io.stdout(lines.join("\n") + "\n");
}

export function emitErrorJson(io: CliIo, value: unknown): void {
  io.stderr(JSON.stringify(value, null, 2) + "\n");
}

export function parseOutputMode(parsed: ParsedArgs): "json" | "text" {
  if (parsed.values.has("text") && parsed.values.has("json")) {
    throw new UsageError("--json 与 --text 不能同时使用");
  }
  return parsed.values.has("text") ? "text" : "json";
}

/** 输出 JSON 或简短文本；不改变已计算的事实。 */
export function emit(
  ctx: CliContext,
  mode: "json" | "text",
  payload: unknown,
  lines: string[],
): void {
  if (mode === "text") emitText(ctx, lines);
  else emitJson(ctx, payload);
}
