#!/usr/bin/env node
/**
 * aichat CLI 主入口（bin → dist/cli/index.js，npm start 同）。
 *
 * - main(argv, ctx) 可注入 stdout/stderr/cwd/关停信号与 startService，
 *   因此测试不会因导入而启动服务；
 * - 只有作为可执行脚本运行时才注册进程级 SIGINT/SIGTERM 并设置退出码；
 * - 默认输出 JSON；--text 为人类摘要。未知命令／标志：stderr 用法 + 非零退出。
 */
import { pathToFileURL } from "node:url";
import { runInit, runRead, runSearch, runServe, runTopics, runValidate } from "./commands.js";
import {
  runBranch,
  runConnect,
  runCreateRoot,
  runCreateTopic,
  runEdit,
  runImportant,
  runNext,
  runRearrange,
} from "./agent-commands.js";
import { runCheckOrApply, runStatus, runWhoami } from "./changes-commands.js";
import { runMigrate } from "./migrate.js";
import { defaultIo, type CliContext } from "./context.js";
import { CliError, errorEnvelope, EXIT_CODES, UsageError } from "./errors.js";
import { emitErrorJson, emitText } from "./output.js";
import { briefUsage, usageFor } from "./usage.js";

export type { CliContext, CliIo, ServiceHandleLike, StartServiceLike } from "./context.js";
export { CliError } from "./errors.js";
export { EXIT_CODES } from "./errors.js";
export { parseOptions } from "./args.js";
export {
  assertIdentity,
  assertLoopbackUrl,
  parseServiceDescriptor,
  resolveServiceForWorkspace,
  SERVICE_DESCRIPTOR_PATH,
  DEFAULT_PORT,
} from "./service-client.js";
export { validateChangeRequestShape, readChangeRequestFile } from "./changes.js";

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 运行一次 CLI。不调用 process.exit；把结果（退出码与输出）交给调用方，
 * 可执行脚本入口再据此设置 process.exitCode。
 */
export async function main(
  argv: readonly string[],
  context: Partial<Pick<CliContext, "cwd" | "startService" | "shutdownSignal" | "fetchImpl">> = {},
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const io = defaultIo();
  const ctx: CliContext = {
    ...io,
    stdout: (text) => {
      stdout += text;
      io.stdout(text);
    },
    stderr: (text) => {
      stderr += text;
      io.stderr(text);
    },
    cwd: context.cwd ?? process.cwd(),
    ...(context.startService ? { startService: context.startService } : {}),
    ...(context.shutdownSignal ? { shutdownSignal: context.shutdownSignal } : {}),
    ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
  };

  const command = argv[0];
  const rest = argv.slice(1);
  if (command === "--help" || command === "-h" || command === "help") {
    // 帮助是显式请求，输出到 stdout 且成功退出。
    emitText(ctx, [usageFor(rest[0])]);
    return { exitCode: EXIT_CODES.ok, stdout, stderr };
  }
  if (command === undefined) {
    ctx.stderr("缺少命令\n\n" + usageFor(undefined) + "\n");
    return { exitCode: EXIT_CODES.usage, stdout, stderr };
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    emitText(ctx, [usageFor(command)]);
    return { exitCode: EXIT_CODES.ok, stdout, stderr };
  }

  try {
    let exitCode: number;
    switch (command) {
      case "init":
        exitCode = await runInit(rest, ctx);
        break;
      case "serve":
        exitCode = await runServe(rest, ctx);
        break;
      case "topics":
        exitCode = await runTopics(rest, ctx);
        break;
      case "search":
        exitCode = await runSearch(rest, ctx);
        break;
      case "read":
        exitCode = await runRead(rest, ctx);
        break;
      case "validate":
        exitCode = await runValidate(rest, ctx);
        break;
      case "check":
      case "apply":
        exitCode = await runCheckOrApply(command, rest, ctx);
        break;
      case "status":
        exitCode = await runStatus(rest, ctx);
        break;
      case "whoami":
        exitCode = await runWhoami(rest, ctx);
        break;
      case "edit":
        exitCode = await runEdit(rest, ctx);
        break;
      case "branch":
        exitCode = await runBranch(rest, ctx);
        break;
      case "next":
        exitCode = await runNext(rest, ctx);
        break;
      case "connect":
        exitCode = await runConnect(rest, ctx);
        break;
      case "rearrange":
        exitCode = await runRearrange(rest, ctx);
        break;
      case "important":
        exitCode = await runImportant(rest, ctx);
        break;
      case "create-topic":
        exitCode = await runCreateTopic(rest, ctx);
        break;
      case "create-root":
        exitCode = await runCreateRoot(rest, ctx);
        break;
      case "migrate":
        exitCode = await runMigrate(rest, ctx);
        break;
      default:
        throw new UsageError(`未知命令 ${command}`);
    }
    return { exitCode, stdout, stderr };
  } catch (error) {
    // JSON 模式（默认）stderr 只输出一个 JSON 错误体，便于程序解析；
    // 用法错误把 usage 放进 error.usage，人类可读文本仅在 --text 模式输出。
    // --text 模式输出单行人类可读消息（用法错误附简短用法）；
    // JSON 模式（默认）stderr 只有一个 JSON 错误体，用法错误另带 error.usage。
    const usageError = error instanceof UsageError;
    const wantsText = argv.includes("--text");
    const { envelope, exitCode } = errorEnvelope(error);
    const message = error instanceof CliError ? error.message : String(error);
    if (wantsText) {
      ctx.stderr(message + (usageError ? "\n" + briefUsage(command) : "") + "\n");
      return { exitCode, stdout, stderr };
    }
    const payload = usageError
      ? { ...envelope, error: { ...envelope.error, usage: briefUsage(command) } }
      : envelope;
    emitErrorJson(ctx, payload);
    return { exitCode, stdout, stderr };
  }
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

const direct = isExecutedDirectly();
if (direct) {
  const controller = new AbortController();
  const handleSignal = (): void => {
    controller.abort();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  const result = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    shutdownSignal: controller.signal,
  });
  process.off("SIGINT", handleSignal);
  process.off("SIGTERM", handleSignal);
  process.exitCode = result.exitCode;
}