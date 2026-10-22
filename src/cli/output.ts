/** CLI 的统一输出面：默认 JSON（便于 Agent 与管道），--text 为简短人类摘要。 */

import type { CliIo } from "./context.js";

export function emitJson(io: CliIo, value: unknown): void {
  io.stdout(JSON.stringify(value, null, 2) + "\n");
}

export function emitText(io: CliIo, lines: readonly string[]): void {
  io.stdout(lines.join("\n") + "\n");
}

export function emitErrorJson(io: CliIo, value: unknown): void {
  io.stderr(JSON.stringify(value, null, 2) + "\n");
}