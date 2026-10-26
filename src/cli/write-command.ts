/**
 * 写命令的统一结果：默认顶层精简结果，--verbose 才输出文件与事务诊断。
 *
 * 所有写命令（edit／branch／next／connect／insert／batch／rearrange／important／
 * create-*）共用同一提取位置：不再套 result，也不再要求读取 editRef／editRefs。
 * 服务仍保留 touchedFiles 等字段，CLI 默认不重复。
 */
import type { AgentChangeAction, AgentChangeResponse } from "../shared/protocol.js";
import { submitAgentChange } from "./agent-client.js";
import type { CliContext } from "./context.js";
import { EXIT_CODES, UsageError } from "./errors.js";
import { emit } from "./output.js";
import { resolveServiceForWorkspace } from "./service-client.js";
import type { ResolvedService } from "./service-client.js";

export interface WriteOutcomeOptions {
  readonly command: string;
  readonly httpStatus: number;
  readonly service: ResolvedService;
  readonly verbose: boolean;
}

export interface CreatedSummary {
  readonly topicId: string | null;
  readonly nodeIds: readonly string[];
  readonly aliases: Record<string, string>;
}

function serviceJson(service: ResolvedService): Record<string, unknown> {
  return {
    url: service.baseUrl,
    workspaceId: service.identity.workspaceId,
    instanceId: service.identity.instanceId,
    rootPath: service.identity.rootPath,
  };
}

/** 默认结果（含顶层 refs）；verbose 才追加 touchedFiles／paths／事务与服务细节。 */
export function writeResultPayload(
  command: string,
  response: AgentChangeResponse,
  options: WriteOutcomeOptions,
): Record<string, unknown> {
  const created = response.created;
  const createdJson: Record<string, unknown> = {
    topicId: created.topicId,
    nodeIds: [...created.nodeIds],
    aliases: { ...(created.aliases ?? {}) },
    ...(options.verbose
      ? { topicPath: created.topicPath, paths: [...created.paths] }
      : {}),
  };
  const diagnostics = Array.isArray(response.diagnostics) ? response.diagnostics : [];
  return {
    ok: true,
    command,
    workspaceId: response.workspaceId,
    topicId: response.topicId,
    requestId: response.requestId,
    state: response.state,
    revision: response.revision,
    changedNodeIds: [...(response.changedNodeIds ?? [])],
    created: createdJson,
    refs: { ...(response.refs ?? {}) },
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(response.replayed === true ? { replayed: true } : {}),
    ...(typeof response.summary === "string" && response.summary.length > 0
      ? { summary: response.summary }
      : {}),
    ...(options.verbose
      ? {
          httpStatus: options.httpStatus,
          service: serviceJson(options.service),
          transactionId: response.transactionId,
          journalCleaned: response.journalCleaned,
          touchedFiles: (response.touchedFiles ?? []).map((file) => ({ ...file })),
        }
      : {}),
  };
}

/** 人类可读摘要：默认只给结论与凭据入口；verbose 才逐文件。 */
export function writeResultLines(
  command: string,
  response: AgentChangeResponse,
  options: WriteOutcomeOptions,
): string[] {
  const lines: string[] = [
    command +
      " " +
      response.state +
      "  topic " +
      response.topicId +
      "  revision " +
      String(response.revision) +
      "  requestId " +
      response.requestId,
  ];
  const created = response.created;
  if (created.topicId !== null) lines.push("created topic: " + created.topicId);
  if (created.nodeIds.length > 0) lines.push("created nodes: " + created.nodeIds.join(", "));
  const aliases = Object.entries(created.aliases ?? {});
  if (aliases.length > 0) {
    lines.push("aliases: " + aliases.map(([local, id]) => local + "=" + id).join(", "));
  }
  const refs = Object.keys(response.refs ?? {});
  if (refs.length > 0) lines.push("refs: " + refs.join(", "));
  if (response.changedNodeIds.length > 0) {
    lines.push("changed: " + response.changedNodeIds.join(", "));
  }
  if (typeof response.summary === "string" && response.summary.length > 0) {
    lines.push("summary: " + response.summary);
  }
  if (response.replayed === true) lines.push("replayed: true");
  for (const diagnostic of response.diagnostics ?? []) {
    lines.push("  [" + diagnostic.code + "] " + diagnostic.message);
  }
  if (options.verbose) {
    lines.push("service " + options.service.baseUrl + "  HTTP " + String(options.httpStatus));
    lines.push(
      "transaction " +
        (response.transactionId ?? "-") +
        "  journalCleaned " +
        String(response.journalCleaned),
    );
    for (const file of response.touchedFiles ?? []) {
      lines.push(
        "  " +
          file.path +
          "  " +
          (file.beforeSha256 ?? "(new)") +
          " -> " +
          (file.afterSha256 ?? "(deleted)"),
      );
    }
    for (const path of created.paths) lines.push("  " + path);
  }
  return lines;
}

export interface SubmitWriteOptions {
  readonly dryRun?: boolean | undefined;
  /** 已解析过服务身份时复用，避免同一命令重复 GET /api/workspace。 */
  readonly resolvedService?: ResolvedService | undefined;
}

/**
 * 提交一次写动作并输出统一结果。命令名只影响输出 envelope，不参与请求编译。
 */
export async function submitWriteAction(
  command: string,
  action: AgentChangeAction,
  root: string,
  ctx: CliContext,
  mode: "json" | "text",
  verbose: boolean,
  options: SubmitWriteOptions = {},
): Promise<number> {
  if (options.dryRun === true && action.action !== "batch") {
    throw new UsageError("--dry-run 只用于 batch");
  }
  const service =
    options.resolvedService ??
    (await resolveServiceForWorkspace(root, ctx.fetchImpl ?? fetch));
  const result = await submitAgentChange(
    service,
    action,
    ctx.fetchImpl ?? fetch,
    options.dryRun === true ? { dryRun: true } : {},
  );
  const payload = writeResultPayload(command, result.response, {
    command,
    httpStatus: result.httpStatus,
    service,
    verbose,
  });
  emit(ctx, mode, payload, writeResultLines(command, result.response, {
    command,
    httpStatus: result.httpStatus,
    service,
    verbose,
  }));
  return EXIT_CODES.ok;
}
