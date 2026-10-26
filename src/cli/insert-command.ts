/** insert：在 after 与 before 的当前真实相邻 next 之间插入一张新卡片。 */
import type { AgentInsertAction } from "../shared/protocol.js";
import { parseCommandArgs, requireParameter } from "./command-specs.js";
import { parseEnumValue, readBodyFromParsed } from "./body-options.js";
import { normalizeText } from "./body-input.js";
import type { CliContext } from "./context.js";
import { EXIT_CODES, UsageError } from "./errors.js";
import { parseOutputMode } from "./output.js";
import { submitWriteAction } from "./write-command.js";
import { workspaceRoot } from "./workspace.js";

const NODE_STATES = ["agreed", "proposed", "reference"] as const;

export async function runInsert(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("insert", args);
  const mode = parseOutputMode(parsed);
  const verbose = parsed.values.has("verbose");
  const root = await workspaceRoot(parsed, ctx);

  const afterRef = requireParameter(parsed, "insert", "after-ref");
  const beforeRef = requireParameter(parsed, "insert", "before-ref");
  const title = requireParameter(parsed, "insert", "title");
  const description = requireParameter(parsed, "insert", "description");
  const nextDescription = requireParameter(parsed, "insert", "next-description");
  const body = await readBodyFromParsed(parsed, ctx);
  if (body === undefined) {
    throw new UsageError("缺少正文：--body／--body-file／--body-stdin 三选一");
  }
  const state = parseEnumValue(parsed.values.get("state"), NODE_STATES, "--state");
  const summary = parsed.values.get("summary");

  const action: AgentInsertAction = {
    action: "insert",
    afterRef,
    beforeRef,
    title,
    body: normalizeText(body.text),
    description,
    nextDescription,
    ...(summary !== undefined ? { summary } : {}),
    ...(state !== undefined ? { state } : {}),
  };
  return submitWriteAction("insert", action, root, ctx, mode, verbose);
}
