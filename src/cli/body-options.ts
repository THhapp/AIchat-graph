/**
 * 正文与枚举参数的共享解析：命令模块只声明参数，不各写一份互斥逻辑。
 *
 * append 只做换行规范化，不再由 CLI 前置空行：首部空行／末尾空白与 base 后的
 * 恰好一个空行统一由 storage 处理，保证 JSON 字符串、--append-file 与 batch
 * appendFile 结果一致。
 */
import type { ParsedArgs } from "./args.js";
import type { CliContext } from "./context.js";
import { UsageError, invalidArgument } from "./errors.js";
import {
  normalizeText,
  readAppendText,
  readReplacePairs,
  readStdinText,
  resolveBody,
  type IoContext,
} from "./body-input.js";

export function ioOf(ctx: CliContext): IoContext {
  return { cwd: ctx.cwd, stdin: ctx.stdin ?? readStdinText };
}

export function parseEnumValue<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw invalidArgument(label + " 只能是 " + allowed.join("／") + "，收到 " + raw);
  }
  return raw as T;
}

export type BodyInput = { text: string; source: "inline" | "file" | "stdin"; path?: string };

/** 从 --body／--body-file／--body-stdin 解析唯一正文来源；未给出时 undefined。 */
export async function readBodyFromParsed(
  parsed: ParsedArgs,
  ctx: CliContext,
): Promise<BodyInput | undefined> {
  const body = parsed.values.get("body");
  const bodyFile = parsed.values.get("body-file");
  return resolveBody(
    {
      ...(body !== undefined ? { body } : {}),
      ...(bodyFile !== undefined ? { bodyFile } : {}),
      bodyStdin: parsed.values.has("body-stdin"),
    },
    ioOf(ctx),
  );
}

export interface BodyPatch {
  readonly body?: string;
  readonly append?: string;
  readonly replace?: ReadonlyArray<{ old: string; new: string }>;
}

/** patchNode 的正文模式：整篇／追加／局部替换互斥，全部由调用方显式给出。 */
export async function readBodyPatchFromParsed(
  parsed: ParsedArgs,
  ctx: CliContext,
): Promise<BodyPatch> {
  const body = await readBodyFromParsed(parsed, ctx);
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
    throw new UsageError("正文修改模式互斥，最多给一个，收到 " + modes.join(" + "));
  }
  if (body !== undefined) return { body: normalizeText(body.text) };
  if (appendFile !== undefined) {
    // 空白规范化由 storage 统一处理；CLI 不再自行前置两个换行。
    return { append: normalizeText(appendFile.text) };
  }
  if (replace !== undefined) {
    return { replace: replace.map((pair) => ({ old: pair.old, new: pair.new })) };
  }
  return {};
}
