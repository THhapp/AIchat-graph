/**
 * 在线 Agent 通道：GET /api/agent/nodes/:id 与 POST /api/agent/changes。
 *
 * 约定：
 * - editRef 是服务实例内的短凭据，绑定工作区／节点／真实源路径／读取时哈希；
 *   CLI 原样回传，不自己补最新哈希、不按显示编号重定位；
 * - 外层 requestId 由 CLI 生成；同 requestId 重放由服务幂等处理；
 * - 结果不明时先查 status，再如实报告 unknown；不换 requestId 盲重发。
 */
import { randomUUID } from "node:crypto";
import type {
  AgentChangeAction,
  AgentChangeRequest,
  AgentChangeResponse,
  AgentNodeReadResponse,
  AgentReadRange,
} from "../shared/protocol.js";
import { CliError, EXIT_CODES } from "./errors.js";
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, REQUEST_TIMEOUT_MS } from "./service-client.js";
import type { ResolvedService } from "./service-client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AgentReadOptions {
  readonly start?: number | undefined;
  readonly length?: number | undefined;
  readonly full?: boolean | undefined;
  /** 只取元数据与 editRef；服务端不返回正文。 */
  readonly meta?: boolean | undefined;
  /** 按标题定位章节；与离线读取共用 core 的 locateSection。 */
  readonly section?: string | undefined;
  /** 同名标题中的第几个（0 起）；必须与 section 一起使用。 */
  readonly sectionIndex?: number | undefined;
}

function buildReadUrl(baseUrl: string, nodeId: string, options: AgentReadOptions): string {
  const url = new URL(`api/agent/nodes/${encodeURIComponent(nodeId)}`, baseUrl);
  if (options.start !== undefined) url.searchParams.set("start", String(options.start));
  if (options.length !== undefined) url.searchParams.set("length", String(options.length));
  if (options.full) url.searchParams.set("full", "true");
  if (options.meta) url.searchParams.set("meta", "true");
  if (options.section !== undefined) url.searchParams.set("section", options.section);
  if (options.sectionIndex !== undefined) {
    url.searchParams.set("section-index", String(options.sectionIndex));
  }
  return url.toString();
}

function unreachable(url: string, error: unknown): CliError {
  return new CliError(
    "SERVICE_UNREACHABLE",
    `无法连接服务 ${url}：${error instanceof Error ? error.message : String(error)}`,
    EXIT_CODES.service,
    { details: { url }, cause: error },
  );
}

function invalidResponse(url: string, detail: string): CliError {
  return new CliError("SERVICE_RESPONSE_INVALID", `${url} 返回的响应不合法：${detail}`, EXIT_CODES.service, {
    details: { url },
  });
}

function assertRange(value: unknown, url: string): AgentReadRange {
  if (!isRecord(value)) throw invalidResponse(url, "缺少 range");
  const { start, end, total, unit } = value;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    typeof total !== "number" ||
    unit !== "utf16"
  ) {
    throw invalidResponse(url, "range 必须是 {start,end,total,unit:'utf16'}");
  }
  return { start, end, total, unit: "utf16" };
}

/** GET /api/agent/nodes/:id；返回片段、版本与 editRef。 */
export async function readAgentNode(
  service: ResolvedService,
  nodeId: string,
  options: AgentReadOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentNodeReadResponse> {
  const url = buildReadUrl(service.baseUrl, nodeId, options);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw unreachable(url, error);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    throw httpError(url, response.status, body, text, null);
  }
  if (!isRecord(body)) throw invalidResponse(url, "响应必须是 JSON 对象");
  if (typeof body["node"] !== "object" || body["node"] === null) {
    throw invalidResponse(url, "缺少 node");
  }
  if (typeof body["body"] !== "string") throw invalidResponse(url, "缺少 body 文本");
  if (typeof body["path"] !== "string" || typeof body["fileHash"] !== "string") {
    throw invalidResponse(url, "缺少真实源的 path／fileHash");
  }
  const editRef = body["editRef"];
  if (
    !isRecord(editRef) ||
    typeof editRef["ref"] !== "string" ||
    editRef["ref"].length === 0
  ) {
    throw invalidResponse(url, "缺少可用的 editRef.ref");
  }
  const node = body["node"] as Record<string, unknown>;
  if (typeof node["id"] !== "string") throw invalidResponse(url, "node.id 缺失");
  return {
    instanceId: String(body["instanceId"] ?? ""),
    revision: Number(body["revision"] ?? 0),
    workspaceId: String(body["workspaceId"] ?? ""),
    node: node as unknown as AgentNodeReadResponse["node"],
    body: body["body"],
    ...(body["bodyOmitted"] === true ? { bodyOmitted: true } : {}),
    range: assertRange(body["range"], url),
    truncated: body["truncated"] === true,
    path: body["path"],
    fileHash: body["fileHash"],
    topicPath: typeof body["topicPath"] === "string" ? body["topicPath"] : "",
    editRef: {
      ref: editRef["ref"],
      workspaceId: String(editRef["workspaceId"] ?? ""),
      topicId: String(editRef["topicId"] ?? ""),
      nodeId: String(editRef["nodeId"] ?? ""),
      path: String(editRef["path"] ?? ""),
      fileHash: String(editRef["fileHash"] ?? ""),
      instanceId: String(editRef["instanceId"] ?? ""),
      revision: Number(editRef["revision"] ?? 0),
      issuedAt: String(editRef["issuedAt"] ?? ""),
    },
    section: isRecord(body["section"])
      ? (body["section"] as unknown as AgentNodeReadResponse["section"])
      : null,
  };
}

/**
 * 一次状态探测：GET /api/changes/:requestId。
 * 只读查询，不重放写请求；失败也如实返回原因，不据此推断提交结果。
 */
export async function probeRequestStatus(
  service: ResolvedService,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { readonly ok: true; readonly httpStatus: number; readonly state: string }
  | { readonly ok: false; readonly reason: string }
> {
  const url = new URL(`api/changes/${encodeURIComponent(requestId)}`, service.baseUrl).toString();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      body = undefined;
    }
    if (response.status === 404) {
      return { ok: true, httpStatus: 404, state: "unknown" };
    }
    if (!response.ok) {
      return { ok: false, reason: `状态探测返回 HTTP ${response.status}` };
    }
    const state =
      isRecord(body) && typeof body["state"] === "string" ? body["state"] : "unknown";
    return { ok: true, httpStatus: response.status, state };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 服务统一错误体 → CLI 错误；退出码按 HTTP 状态映射。 */
function httpError(
  url: string,
  status: number,
  body: unknown,
  rawText: string,
  requestId: string | null,
): CliError {
  const exitCode =
    status === 412
      ? EXIT_CODES.versionConflict
      : status === 409
        ? EXIT_CODES.operationConflict
        : status === 422
          ? EXIT_CODES.validation
          : status === 404
            ? EXIT_CODES.notFound
            : status === 400
              ? EXIT_CODES.usage
              : EXIT_CODES.http;
  const errorValue = isRecord(body) ? body["error"] : undefined;
  if (isRecord(errorValue) && typeof errorValue["code"] === "string") {
    const diagnostics = Array.isArray(errorValue["diagnostics"])
      ? (errorValue["diagnostics"] as readonly unknown[])
      : undefined;
    return new CliError(
      errorValue["code"],
      typeof errorValue["message"] === "string" ? errorValue["message"] : "服务拒绝了请求",
      exitCode,
      {
        ...(isRecord(errorValue["details"]) ? { details: errorValue["details"] } : {}),
        ...(diagnostics ? { diagnostics } : {}),
        extras: {
          httpStatus: status,
          ...(requestId ? { requestId } : {}),
          endpoint: url,
        },
      },
    );
  }
  return new CliError("SERVICE_HTTP_ERROR", `服务返回 HTTP ${status} 且无标准错误体`, exitCode, {
    details: { endpoint: url, body: rawText.slice(0, 2000) },
    extras: { httpStatus: status, ...(requestId ? { requestId } : {}), endpoint: url },
  });
}

export interface AgentChangeResult {
  readonly requestId: string;
  readonly httpStatus: number;
  readonly response: AgentChangeResponse;
}

async function postAgentChange(
  service: ResolvedService,
  request: AgentChangeRequest,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: unknown; text: string }> {
  const url = new URL("api/agent/changes", service.baseUrl).toString();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
        Accept: "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw unreachable(url, error);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
}

/**
 * 提交一次低摩擦动作。CLI 负责生成 requestId；同一调用重试时必须复用同一 ID。
 * 超时／断线不自动重放：抛出 RESULT_UNKNOWN，由调用方用 status 或重读决定。
 */
export async function submitAgentChange(
  service: ResolvedService,
  action: AgentChangeAction,
  fetchImpl: typeof fetch = fetch,
  requestId: string = randomUUID(),
): Promise<AgentChangeResult> {
  if (service.identity.workspaceId !== service.diskWorkspaceId) {
    throw new CliError(
      "SERVICE_IDENTITY_MISMATCH",
      "服务身份与当前磁盘 workspace.json 不一致；拒绝提交",
      EXIT_CODES.service,
      {
        details: {
          serviceWorkspaceId: service.identity.workspaceId,
          diskWorkspaceId: service.diskWorkspaceId,
        },
      },
    );
  }
  const request: AgentChangeRequest = {
    workspaceId: service.identity.workspaceId,
    requestId,
    action,
  };

  let outcome: { status: number; body: unknown; text: string };
  try {
    outcome = await postAgentChange(service, request, fetchImpl);
  } catch (error) {
    const cli = error instanceof CliError ? error : undefined;
    if (cli?.code !== "SERVICE_UNREACHABLE") throw error;
    // 只探测一次原 requestId 的状态（不是重放写请求）：可能因服务短暂不可达而失败。
    const probe = await probeRequestStatus(service, requestId, fetchImpl);
    throw new CliError(
      "RESULT_UNKNOWN",
      `提交结果未知：请求可能已提交也可能未提交。原 requestId ${requestId}；` +
        `先运行 aichat status ${requestId} 或重读源文件，不要换 requestId 重发。`,
      EXIT_CODES.resultUnknown,
      {
        details: {
          requestId,
          endpoint: new URL("api/agent/changes", service.baseUrl).toString(),
          cause: cli.message,
          statusProbe: probe,
        },
        extras: { requestId, status: "unknown", statusProbe: probe },
      },
    );
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    throw httpError(
      new URL("api/agent/changes", service.baseUrl).toString(),
      outcome.status,
      outcome.body,
      outcome.text,
      requestId,
    );
  }
  if (!isRecord(outcome.body) || outcome.body["ok"] !== true) {
    throw invalidResponse(
      new URL("api/agent/changes", service.baseUrl).toString(),
      "缺少 ok:true",
    );
  }
  return {
    requestId,
    httpStatus: outcome.status,
    response: outcome.body as unknown as AgentChangeResponse,
  };
}