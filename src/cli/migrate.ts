/**
 * 格式 1 → 格式 2 的隔离迁移入口。
 *
 * 转换本身完全由 storage.migrateWorkspace（A2）完成；CLI 只做参数、路径与
 * 有界输出：
 * - preview 只打印目标文件路径／字节数／哈希与缺失 description 的节点，
 *   绝不把目标文件正文倒进终端（正文可能很长，也不该经 CLI 泄露）；
 * - 目标目录必须不存在；CLI 不替调用方覆盖、不原位迁移；
 * - 缺失 description 时如实失败并列出 nodeId，由维护 Agent 读源后补齐。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { migrateWorkspace } from "../storage/index.js";
import { parseOptions } from "./args.js";
import { emit, parseOutputMode } from "./commands.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT_CODES, UsageError } from "./errors.js";
import { briefUsage } from "./usage.js";

const OUTPUT = [
  { name: "json", boolean: true },
  { name: "text", boolean: true },
] as const;

const MIGRATE_OPTIONS = [
  { name: "source" },
  { name: "destination" },
  { name: "descriptions" },
  { name: "preview", boolean: true },
  ...OUTPUT,
] as const;

async function readDescriptions(
  filePath: string | undefined,
  ctx: CliContext,
): Promise<Record<string, string> | undefined> {
  if (filePath === undefined) return undefined;
  const absolute = path.resolve(ctx.cwd, filePath);
  const { promises: fs } = await import("node:fs");
  let text: string;
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch (error) {
    throw new CliError("INPUT_UNREADABLE", `无法读取 --descriptions: ${absolute}`, EXIT_CODES.usage, {
      details: { path: absolute },
      cause: error,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError("INPUT_INVALID_JSON", `--descriptions 不是合法 JSON: ${absolute}`, EXIT_CODES.usage, {
      details: { path: absolute },
      cause: error,
    });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CliError(
      "INVALID_DESCRIPTIONS",
      "--descriptions 必须是 { nodeId: description } 对象",
      EXIT_CODES.usage,
    );
  }
  const result: Record<string, string> = {};
  for (const [nodeId, value] of Object.entries(raw)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new CliError(
        "INVALID_DESCRIPTIONS",
        `--descriptions 中 ${nodeId} 的描述必须是非空字符串`,
        EXIT_CODES.usage,
      );
    }
    result[nodeId] = value;
  }
  return result;
}

interface FileSummary {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

function summarizeFiles(files: readonly { path: string; content: string }[]): FileSummary[] {
  return files.map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.content, "utf8"),
    sha256: createHash("sha256").update(Buffer.from(file.content, "utf8")).digest("hex"),
  }));
}

export async function runMigrate(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(args, MIGRATE_OPTIONS, 0);
  const mode = parseOutputMode(parsed);
  const sourceRaw = parsed.values.get("source");
  const destinationRaw = parsed.values.get("destination");
  if (sourceRaw === undefined) {
    throw new UsageError("缺少 --source\n\n" + briefUsage("migrate"));
  }
  if (destinationRaw === undefined) {
    throw new UsageError("缺少 --destination\n\n" + briefUsage("migrate"));
  }
  if (sourceRaw.trim().length === 0 || destinationRaw.trim().length === 0) {
    throw new UsageError("--source 与 --destination 不能为空");
  }
  const source = path.resolve(ctx.cwd, sourceRaw);
  const destination = path.resolve(ctx.cwd, destinationRaw);
  const preview = parsed.values.has("preview");
  const descriptions = await readDescriptions(parsed.values.get("descriptions"), ctx);

  const result = await migrateWorkspace({
    source,
    destination,
    ...(descriptions !== undefined ? { descriptions } : {}),
    ...(preview ? { dryRun: true } : {}),
  });

  const fileSummaries = summarizeFiles(result.files);
  const payload = {
    ok: result.ok,
    command: "migrate",
    preview,
    source: result.source,
    destination: result.destination,
    published: result.published,
    counts: result.counts,
    missingDescriptions: result.missingDescriptions,
    // 只给路径／字节／哈希：预览不把目标正文倒进终端。
    files: fileSummaries,
    diagnostics: result.diagnostics,
  };
  const lines = [
    `${result.ok ? (preview ? "PREVIEW OK" : "MIGRATED") : "FAILED"} ${result.source} → ${result.destination}`,
    `published ${result.published}; topics ${result.counts.topics}; nodes ${result.counts.nodes}; preservedLabels ${result.counts.preservedLabels}`,
  ];
  if (result.missingDescriptions.length > 0) {
    lines.push("missing descriptions (nodeId → 需要由维护 Agent 补写):");
    for (const nodeId of result.missingDescriptions) lines.push(`  ${nodeId}`);
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(`  [${diagnostic.code}] ${diagnostic.topicPath ?? ""} ${diagnostic.message}`);
  }
  if (result.ok) {
    lines.push(`${fileSummaries.length} file(s):`);
    for (const file of fileSummaries) {
      lines.push(`  ${file.path}  ${file.bytes}B  ${file.sha256}`);
    }
  }
  emit(ctx, mode, payload, lines);
  return result.ok ? EXIT_CODES.ok : EXIT_CODES.validation;
}