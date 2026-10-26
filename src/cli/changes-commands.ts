/**
 * 底层变更命令：check／apply／status／whoami。
 *
 * 与低摩擦 edit／branch 的关系：低摩擦命令由服务端编译到同一 prepareChanges／commitFiles
 * 链路；这里的 check／apply 仍用于显式复杂变更或排查。请求体是 --input 文件的原文，
 * CLI 不补哈希、不改写 workspaceId。
 */
import path from "node:path";
import { parseCommandArgs } from "./command-specs.js";
import { readChangeRequestFile, type ChangeRequest } from "./change-input.js";
import { INTERFACE_VERSION, loadProgramInfo } from "../build-info.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT_CODES, UsageError, invalidArgument } from "./errors.js";
import { applyChanges, checkChanges, queryChangeStatus } from "./changes-transport.js";
import { emit, parseOutputMode } from "./output.js";
import { resolveServiceForWorkspace } from "./service-client.js";
import { briefUsage } from "./usage.js";
import { workspaceRoot } from "./workspace.js";

function assertRequestWorkspace(
  request: ChangeRequest,
  workspaceId: string,
  root: string,
): void {
  if (request.workspaceId !== workspaceId) {
    throw new CliError(
      "WORKSPACE_ID_MISMATCH",
      `ChangeRequest.workspaceId 与 --workspace 的服务不一致（request=${request.workspaceId} service=${workspaceId}）；CLI 不会自动改写`,
      EXIT_CODES.workspace,
      { details: { requestWorkspaceId: request.workspaceId, serviceWorkspaceId: workspaceId, root } },
    );
  }
}

export async function runCheckOrApply(
  command: "check" | "apply",
  args: readonly string[],
  ctx: CliContext,
): Promise<number> {
  const parsed = parseCommandArgs(command, args);
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  const inputRaw = parsed.values.get("input");
  if (inputRaw === undefined) {
    throw new UsageError("缺少 --input\n\n" + briefUsage(command));
  }
  const inputPath = path.resolve(ctx.cwd, inputRaw);
  const { text, request } = await readChangeRequestFile(inputPath);
  const service = await resolveServiceForWorkspace(root, ctx.fetchImpl ?? fetch);
  assertRequestWorkspace(request, service.identity.workspaceId, service.root);
  const submission =
    command === "check"
      ? await checkChanges(service, text, request.requestId, ctx.fetchImpl ?? fetch)
      : await applyChanges(service, text, request.requestId, ctx.fetchImpl ?? fetch);
  const payload = {
    ok: true,
    command,
    requestId: request.requestId,
    httpStatus: submission.httpStatus,
    service: {
      url: service.baseUrl,
      workspaceId: service.identity.workspaceId,
      instanceId: service.identity.instanceId,
      rootPath: service.identity.rootPath,
    },
    result: submission.result,
  };
  emit(ctx, mode, payload, [
    `${command} ok  requestId ${request.requestId}  HTTP ${submission.httpStatus}`,
    JSON.stringify(submission.result, null, 2),
  ]);
  return EXIT_CODES.ok;
}

export async function runStatus(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("status", args);
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  let requestId = parsed.positional[0] ?? parsed.values.get("request-id");
  const inputPath = parsed.values.get("input");
  if (requestId !== undefined && inputPath !== undefined) {
    throw new UsageError("status 的 requestId 只能给出一次（位置参数或 --input）");
  }
  if (requestId === undefined && inputPath === undefined) {
    throw new UsageError("缺少 requestId\n\n" + briefUsage("status"));
  }
  if (inputPath !== undefined) {
    const { request } = await readChangeRequestFile(path.resolve(ctx.cwd, inputPath));
    requestId = request.requestId;
  }
  const id = requestId as string;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw invalidArgument(`requestId 必须是 UUID: ${id}`);
  }
  const service = await resolveServiceForWorkspace(root, ctx.fetchImpl ?? fetch);
  const status = await queryChangeStatus(service, id, ctx.fetchImpl ?? fetch);
  const state =
    typeof (status.status as { state?: unknown }).state === "string"
      ? (status.status as { state: string }).state
      : "unknown";
  const payload = {
    ok: true,
    command: "status",
    requestId: id,
    // unknown 是明确结论：不要据此推断写入一定成功或一定失败。
    state,
    known: state !== "unknown",
    httpStatus: status.httpStatus,
    status: status.status,
    service: {
      url: service.baseUrl,
      workspaceId: service.identity.workspaceId,
      instanceId: service.identity.instanceId,
      rootPath: service.identity.rootPath,
    },
  };
  emit(ctx, mode, payload, [
    `requestId ${id}`,
    `state ${state}`,
    JSON.stringify(status.status, null, 2),
  ]);
  return EXIT_CODES.ok;
}

/**
 * 身份诊断：即使服务接口缺失或不匹配也完成报告，不因不匹配而无法排查。
 *
 * 旧字段（ok／url／descriptor／identity／diskWorkspaceId）保持不变，便于现有脚本
 * 读取 .ok／.url／.identity.instanceId／.identity.workspaceId；版本信息放在
 * cli／service／interface／build 额外字段。
 */
export async function runWhoami(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("whoami", args);
  const mode = parseOutputMode(parsed);
  const root = await workspaceRoot(parsed, ctx);
  // whoami 是诊断命令：允许接口不匹配，仍要报告双方身份。
  const service = await resolveServiceForWorkspace(root, ctx.fetchImpl ?? fetch, {
    requireInterface: false,
  });
  const cliProgram = loadProgramInfo();
  const serviceProgram = service.identity.program;
  const interfaceCompatible = service.interfaceCompatible;
  const buildSame =
    serviceProgram !== null && serviceProgram.buildId === cliProgram.buildId;
  const payload = {
    ok: true,
    command: "whoami",
    root: service.root,
    url: service.baseUrl,
    cli: cliProgram,
    service: serviceProgram,
    interface: {
      expected: INTERFACE_VERSION,
      actual: serviceProgram?.interfaceVersion ?? null,
      compatible: interfaceCompatible,
    },
    build: {
      same: buildSame,
      cli: cliProgram.buildId,
      service: serviceProgram?.buildId ?? null,
    },
    descriptor: service.descriptor,
    identity: service.identity,
    diskWorkspaceId: service.diskWorkspaceId,
  };
  const lines = [
    `url ${service.baseUrl}`,
    `workspaceId ${service.identity.workspaceId}`,
    `instanceId ${service.identity.instanceId}`,
    `rootPath ${service.identity.rootPath}`,
    `cli ${cliProgram.program} ${cliProgram.version} interface ${String(cliProgram.interfaceVersion)} build ${cliProgram.buildId}`,
    serviceProgram === null
      ? "service (未声明 program：可能是旧版服务)"
      : `service ${serviceProgram.program} ${serviceProgram.version} interface ${String(serviceProgram.interfaceVersion)} build ${serviceProgram.buildId}`,
    `interface ${interfaceCompatible ? "compatible" : "INCOMPATIBLE"}` +
      (serviceProgram === null ? "" : ` (expected ${String(INTERFACE_VERSION)}, actual ${String(serviceProgram.interfaceVersion)})`),
    `build ${buildSame ? "same" : "different"}`,
  ];
  emit(ctx, mode, payload, lines);
  return EXIT_CODES.ok;
}
