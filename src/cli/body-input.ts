/**
 * 正文输入解析：长正文走文件或 stdin，避免 Windows 命令行长度限制，
 * 也不要求 Agent 手写大量 JSON 转义。
 *
 * 一次只允许一个正文来源；同时给出多个来源即用法错误，不静默选一个。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { CliError, EXIT_CODES, UsageError } from "./errors.js";

export interface IoContext {
  readonly cwd: string;
  readonly stdin: () => Promise<string>;
}

export interface BodySourceFlags {
  /** 直接写在内联文本里（短正文）。 */
  readonly body?: string | undefined;
  readonly bodyFile?: string | undefined;
  readonly bodyStdin?: boolean | undefined;
}

export async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readFileText(
  absolutePath: string,
  label: string,
): Promise<{ text: string; path: string }> {
  try {
    const text = await fs.readFile(absolutePath, "utf8");
    return { text, path: absolutePath };
  } catch (error) {
    throw new CliError(
      "INPUT_UNREADABLE",
      `无法读取 ${label}: ${absolutePath}`,
      EXIT_CODES.usage,
      { details: { path: absolutePath }, cause: error },
    );
  }
}

/** 解析唯一正文来源；未给出任何来源时返回 undefined。 */
export async function resolveBody(
  flags: BodySourceFlags,
  io: IoContext,
): Promise<{ text: string; source: "inline" | "file" | "stdin"; path?: string } | undefined> {
  const provided = [
    flags.body !== undefined ? "--body" : undefined,
    flags.bodyFile !== undefined ? "--body-file" : undefined,
    flags.bodyStdin ? "--body-stdin" : undefined,
  ].filter((item): item is string => item !== undefined);
  if (provided.length > 1) {
    throw new UsageError(`正文来源只能给一个，收到 ${provided.join(" + ")}`);
  }
  if (flags.body !== undefined) {
    return { text: flags.body, source: "inline" };
  }
  if (flags.bodyFile !== undefined) {
    const absolutePath = path.resolve(io.cwd, flags.bodyFile);
    const file = await readFileText(absolutePath, "--body-file");
    return { text: file.text, source: "file", path: file.path };
  }
  if (flags.bodyStdin) {
    return { text: await io.stdin(), source: "stdin" };
  }
  return undefined;
}

export interface ReplacePair {
  readonly old: string;
  readonly new: string;
}

export interface ReplaceFlags {
  /** 小型 JSON 文件：[{old,new}] 或 {replace:[{old,new}]}。 */
  readonly replaceFile?: string | undefined;
}

/** 读取局部替换对；空 old 或空列表直接拒绝（不能靠全局替换）。 */
export async function readReplacePairs(
  flags: ReplaceFlags,
  io: IoContext,
): Promise<readonly ReplacePair[] | undefined> {
  if (flags.replaceFile === undefined) return undefined;
  const absolutePath = path.resolve(io.cwd, flags.replaceFile);
  const file = await readFileText(absolutePath, "--replace-file");
  let raw: unknown;
  try {
    raw = JSON.parse(file.text) as unknown;
  } catch (error) {
    throw new CliError(
      "INPUT_INVALID_JSON",
      `--replace-file 不是合法 JSON: ${absolutePath}`,
      EXIT_CODES.usage,
      { details: { path: absolutePath }, cause: error },
    );
  }
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? ((raw as { replace?: unknown }).replace ?? undefined)
      : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    throw new CliError(
      "INVALID_REPLACE",
      "--replace-file 必须是 [{old,new}] 或 {replace:[{old,new}]} 且非空",
      EXIT_CODES.usage,
      { details: { path: absolutePath } },
    );
  }
  const pairs: ReplacePair[] = [];
  for (const [index, item] of list.entries()) {
    if (typeof item !== "object" || item === null) {
      throw new CliError("INVALID_REPLACE", `replace[${index}] 必须是对象`, EXIT_CODES.usage);
    }
    const { old, new: replacement } = item as { old?: unknown; new?: unknown };
    if (typeof old !== "string" || old.length === 0) {
      throw new CliError(
        "INVALID_REPLACE",
        `replace[${index}].old 必须是非空字符串`,
        EXIT_CODES.usage,
      );
    }
    if (typeof replacement !== "string") {
      throw new CliError("INVALID_REPLACE", `replace[${index}].new 必须是字符串`, EXIT_CODES.usage);
    }
    pairs.push({ old, new: replacement });
  }
  return pairs;
}

/** 读取追加片段文件；--append-file 只追加，不替换。 */
export async function readAppendText(
  appendFile: string | undefined,
  io: IoContext,
): Promise<{ text: string; path: string } | undefined> {
  if (appendFile === undefined) return undefined;
  const absolutePath = path.resolve(io.cwd, appendFile);
  const file = await readFileText(absolutePath, "--append-file");
  if (file.text.length === 0) {
    throw new CliError(
      "INVALID_APPEND",
      `--append-file 内容为空: ${absolutePath}`,
      EXIT_CODES.usage,
      { details: { path: absolutePath } },
    );
  }
  return { text: file.text, path: file.path };
}
