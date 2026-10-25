/** 离线工作区命令：init／serve／topics／validate。 */
import path from "node:path";
import { initWorkspace } from "../storage/index.js";
import { parseOptions } from "./args.js";
import type { CliContext, ServiceHandleLike, StartServiceLike } from "./context.js";
import { CliError, EXIT_CODES, UsageError } from "./errors.js";
import { OUTPUT_OPTIONS, WORKSPACE_OPTION, parseIntegerOption } from "./options.js";
import { emit, emitText, parseOutputMode } from "./output.js";
import { DEFAULT_PORT } from "./service-client.js";
import { briefUsage } from "./usage.js";
import {
  describeTopic,
  loadWorkspace,
  validateSnapshot,
  workspaceRoot,
} from "./workspace.js";

/* ---------------------------------- init ---------------------------------- */

export async function runInit(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(
    args,
    [{ name: "name" }, WORKSPACE_OPTION, ...OUTPUT_OPTIONS],
    1,
  );
  const mode = parseOutputMode(parsed);
  const positional = parsed.positional[0];
  const optionPath = parsed.values.get("workspace");
  if (positional !== undefined && optionPath !== undefined) {
    throw new UsageError("init 的路径只能给出一次（位置参数或 --workspace）");
  }
  const requested = positional ?? optionPath;
  if (requested === undefined) {
    throw new UsageError("缺少初始化路径\n\n" + briefUsage("init"));
  }
  const root = path.resolve(ctx.cwd, requested);
  const name = parsed.values.get("name");
  const result = await initWorkspace({
    root,
    ...(name !== undefined ? { name } : {}),
  });
  // 格式版本以写入磁盘的真实 workspace.json 为准，不在 CLI 里重复默认值。
  const created = await loadWorkspace(result.root);
  const payload = {
    ok: true,
    command: "init",
    root: result.root,
    workspaceId: result.workspaceId,
    schemaVersion: created.schemaVersion,
    name: name ?? path.basename(result.root),
    files: result.files,
  };
  emit(ctx, mode, payload, [
    `initialized ${result.root} (schemaVersion ${created.schemaVersion ?? "?"})`,
    `workspaceId ${result.workspaceId}`,
    ...result.files.map((file) => `  ${file.path}  ${file.sha256}`),
  ]);
  return EXIT_CODES.ok;
}

/* ---------------------------------- serve --------------------------------- */

async function loadStartService(ctx: CliContext): Promise<StartServiceLike> {
  if (ctx.startService) return ctx.startService;
  const moduleSpecifier: string = "../service/index.js";
  let serviceModule: { startService?: StartServiceLike };
  try {
    serviceModule = (await import(moduleSpecifier)) as { startService?: StartServiceLike };
  } catch (error) {
    throw new CliError(
      "SERVICE_UNAVAILABLE",
      "本地服务模块不可用（无法加载 dist/service/index.js）；请先构建服务模块",
      EXIT_CODES.service,
      { details: { module: "dist/service/index.js" }, cause: error },
    );
  }
  if (typeof serviceModule.startService !== "function") {
    throw new CliError(
      "SERVICE_UNAVAILABLE",
      "无法加载本地服务模块（dist/service/index.js 未导出 startService）",
      EXIT_CODES.service,
    );
  }
  return serviceModule.startService;
}

function waitForShutdown(ctx: CliContext): Promise<void> {
  if (ctx.shutdownSignal) {
    if (ctx.shutdownSignal.aborted) return Promise.resolve();
    const signal = ctx.shutdownSignal;
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
  });
}

export async function runServe(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(
    args,
    [WORKSPACE_OPTION, { name: "port" }, ...OUTPUT_OPTIONS],
    0,
  );
  const mode = parseOutputMode(parsed);
  if (!parsed.values.has("workspace")) {
    throw new UsageError("serve 必须显式给出 --workspace\n\n" + briefUsage("serve"));
  }
  const root = await workspaceRoot(parsed, ctx);
  const port = parseIntegerOption(parsed.values.get("port"), "--port", {
    min: 1,
    max: 65535,
    integerMessage: "必须是整数",
  });
  const startService = await loadStartService(ctx);
  let handle: ServiceHandleLike;
  try {
    handle = await startService({ root, ...(port !== undefined ? { port } : {}) });
  } catch (error) {
    throw new CliError(
      "SERVICE_START_FAILED",
      `服务启动失败: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.service,
      { details: { root }, cause: error },
    );
  }
  const payload = {
    ok: true,
    command: "serve",
    url: handle.url,
    workspaceId: handle.workspaceId,
    instanceId: handle.instanceId,
    rootPath: handle.rootPath,
    port: Number(new URL(handle.url).port || DEFAULT_PORT),
    pid: process.pid,
    state: "serving",
  };
  emit(ctx, mode, payload, [
    `serving ${handle.url}`,
    `workspace ${handle.workspaceId} ${handle.rootPath}`,
    "press Ctrl+C to stop",
  ]);
  await waitForShutdown(ctx);
  try {
    await handle.stop();
  } catch (error) {
    throw new CliError(
      "SERVICE_STOP_FAILED",
      `服务停止失败: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.service,
      { details: { url: handle.url }, cause: error },
    );
  }
  if (mode === "text") emitText(ctx, ["stopped"]);
  return EXIT_CODES.ok;
}

/* --------------------------------- topics --------------------------------- */

export async function runTopics(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(args, [WORKSPACE_OPTION, ...OUTPUT_OPTIONS], 0);
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const snapshot = await loadWorkspace(root);
  const topics = snapshot.topics.map((entry) => describeTopic(entry));
  const payload = {
    ok: snapshot.ok,
    command: "topics",
    source: "disk",
    root: snapshot.root,
    schemaVersion: snapshot.schemaVersion,
    workspace: snapshot.workspace,
    topics,
    topicCount: topics.length,
    diagnostics: snapshot.diagnostics,
  };
  const lines = [
    `workspace ${snapshot.workspace?.workspaceId ?? "(unreadable)"} ${snapshot.workspace?.name ?? ""}`,
    `schemaVersion ${snapshot.schemaVersion ?? "unknown"}; ${topics.length} topic(s)`,
  ];
  for (const topic of topics) {
    lines.push(`  ${topic.topicId}  ${topic.title}  dir=${topic.dir ?? "-"}  nodes=${topic.nodeCount}`);
    lines.push(`    entry ${topic.path}`);
  }
  for (const diagnostic of snapshot.diagnostics) {
    lines.push(`  [${diagnostic.code}] ${diagnostic.topicPath ?? ""} ${diagnostic.message}`);
  }
  emit(ctx, mode, payload, lines);
  return snapshot.ok ? EXIT_CODES.ok : EXIT_CODES.validation;
}

/* -------------------------------- validate -------------------------------- */

export async function runValidate(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseOptions(args, [WORKSPACE_OPTION, ...OUTPUT_OPTIONS], 0);
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const snapshot = await loadWorkspace(root);
  const validation = validateSnapshot(snapshot);
  const payload = {
    ok: validation.ok,
    command: "validate",
    source: "disk",
    root: snapshot.root,
    schemaVersion: snapshot.schemaVersion,
    workspace: snapshot.workspace,
    topics: snapshot.topics.map((entry) => describeTopic(entry)),
    storageDiagnostics: snapshot.files.diagnostics,
    diagnostics: validation.diagnostics,
    graphSkipped: validation.graphSkipped,
    graph: validation.graph
      ? {
          workspaceId: validation.graph.workspaceId,
          name: validation.graph.name,
          activeNode: validation.graph.activeNode,
          rootIds: validation.graph.rootIds,
          topics: validation.graph.topics,
          nodes: validation.graph.nodes.map((node) => ({
            id: node.id,
            topicId: node.topicId,
            topicPath: node.topicPath,
            sourcePath: node.sourcePath,
            title: node.title,
            summary: node.summary,
            number: node.number,
            from: node.from,
            flow: node.flow,
            state: node.state,
            important: node.important,
            ...(node.description !== undefined ? { description: node.description } : {}),
            ...(node.side !== undefined ? { side: node.side } : {}),
            ...(node.order !== undefined ? { order: node.order } : {}),
            nextId: node.nextId,
            branchIds: node.branchIds,
          })),
        }
      : null,
  };
  const lines = [
    `${validation.ok ? "valid" : "INVALID"} ${snapshot.root} (schemaVersion ${snapshot.schemaVersion ?? "?"})`,
    `${snapshot.topics.length} topic(s), ${snapshot.topics.reduce((sum, topic) => sum + topic.nodes.length, 0)} node(s)`,
  ];
  for (const diagnostic of validation.diagnostics) {
    lines.push(`  ${diagnostic.code} ${diagnostic.topicPath ?? ""} ${diagnostic.message}`);
  }
  for (const diagnostic of snapshot.files.diagnostics) {
    lines.push(`  storage ${diagnostic.code} ${diagnostic.path ?? ""} ${diagnostic.message}`);
  }
  if (payload.graph) {
    const roots = payload.graph.rootIds;
    lines.push(`graph ${payload.graph.nodes.length} node(s), ${roots.length} root(s)${roots.length > 0 ? ": " + roots.join(", ") : ""}`);
  }
  emit(ctx, mode, payload, lines);
  return validation.ok ? EXIT_CODES.ok : EXIT_CODES.validation;
}
