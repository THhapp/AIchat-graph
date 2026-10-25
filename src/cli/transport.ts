/**
 * CLI 的统一 HTTP 传输与错误映射。
 *
 * 所有在线命令都经这里发请求：一次 fetch、一次超时、一次响应文本／JSON 解析，
 * 服务错误体也只在这里转成 CliError。业务模块只描述端点与请求体。
 *
 * 安全语义：
 * - 超时／断线统一报 SERVICE_UNREACHABLE，调用方不得据此重放写请求；
 * - 写入结果不明时只做一次只读状态查询，再报告 RESULT_UNKNOWN；
 * - 404 只有在标准错误体明确表示“资源不存在”时才映射为 notFound；
 *   写端点（POST /api/changes*）的 404 一律视为端点缺失，不冒充节点不存在。
 */
import { CliError, EXIT_CODES } from "./errors.js";
import { isRecord } from "../shared/guards.js";
import { REQUEST_TIMEOUT_MS } from "./service-client.js";

export interface HttpOutcome {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

export interface RequestJsonOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function truncateBody(text: string): string {
  return text.length > 2000 ? text.slice(0, 2000) + "…" : text;
}

/** 唯一的 fetch 入口：超时、连接失败与响应中断都在这里归一。 */
export async function requestJson(
  url: string,
  init: RequestInit,
  options: RequestJsonOptions = {},
): Promise<HttpOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CliError(
      "SERVICE_UNREACHABLE",
      `请求 ${url} 失败：${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.service,
      { details: { url }, cause: error },
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // 响应头已到但正文中途断开：对写请求同样属于“结果未知”，
    // 统一按不可达上报，由调用方决定是否查询 requestId 状态。
    throw new CliError(
      "SERVICE_UNREACHABLE",
      `读取 ${url} 的响应失败（连接中断）：${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.service,
      { details: { url }, cause: error },
    );
  }
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, body, text };
}

export interface ServiceErrorContext {
  readonly endpoint: string;
  readonly method?: string | undefined;
  readonly requestId?: string | null | undefined;
  /**
   * 404 是否可以按错误体 code 解释为“资源不存在”。
   * 写端点传 false：端点缺失不能被静默当成节点不存在。
   */
  readonly notFoundIsResource?: boolean | undefined;
}

/** 服务端明确返回的 workspace 身份错误：统一走 workspace 退出码。 */
const WORKSPACE_IDENTITY_CODES = new Set([
  "WORKSPACE_MISMATCH",
  "WORKSPACE_ID_MISMATCH",
  "WORKSPACE_ID_CHANGED",
  "SERVICE_IDENTITY_MISMATCH",
]);

/** 表示“请求的资源不存在”的标准错误码。 */
const RESOURCE_NOT_FOUND_CODES = new Set([
  "NOT_FOUND",
  "NODE_NOT_FOUND",
  "TOPIC_NOT_FOUND",
  "FILE_NOT_FOUND",
  "RESOURCE_NOT_FOUND",
]);

function exitCodeForServiceError(
  status: number,
  code: string | undefined,
  notFoundIsResource: boolean,
): number {
  if (code !== undefined && WORKSPACE_IDENTITY_CODES.has(code)) return EXIT_CODES.workspace;
  if (status === 412) return EXIT_CODES.versionConflict;
  if (status === 409) return EXIT_CODES.operationConflict;
  if (status === 422) return EXIT_CODES.validation;
  if (status === 400) return EXIT_CODES.usage;
  if (status === 404) {
    return notFoundIsResource && code !== undefined && RESOURCE_NOT_FOUND_CODES.has(code)
      ? EXIT_CODES.notFound
      : EXIT_CODES.http;
  }
  return EXIT_CODES.http;
}

/**
 * 服务错误体 `{ error: { code, message, details?, diagnostics? } }` → CliError。
 * 无标准错误体时保留 HTTP 状态、方法与端点，而不是猜测业务含义。
 */
export function serviceErrorFromResponse(
  outcome: HttpOutcome,
  context: ServiceErrorContext,
): CliError {
  const endpoint = context.endpoint;
  const method = context.method ?? "GET";
  const notFoundIsResource = context.notFoundIsResource !== false;
  const errorValue = isRecord(outcome.body) ? outcome.body["error"] : undefined;
  const standard = isRecord(errorValue) && typeof errorValue["code"] === "string";
  const standardCode = standard ? (errorValue["code"] as string) : undefined;
  const standardMessage = standard
    ? typeof errorValue["message"] === "string"
      ? errorValue["message"]
      : "服务拒绝了请求"
    : undefined;
  const requestExtras = {
    httpStatus: outcome.status,
    ...(context.requestId ? { requestId: context.requestId } : {}),
    endpoint,
  };

  if (outcome.status === 404 && !notFoundIsResource) {
    // 写端点没有“资源不存在”这一业务语义：缺路由就是部署／兼容问题，
    // 明确报 SERVICE_HTTP_ERROR，不把 404 静默翻译成节点不存在。
    return new CliError(
      "SERVICE_HTTP_ERROR",
      standardMessage !== undefined
        ? `服务返回 HTTP 404（${method} ${endpoint}）：${standardMessage}`
        : `服务返回 HTTP 404 且无标准错误体（${method} ${endpoint}）`,
      EXIT_CODES.http,
      {
        details: {
          endpoint,
          httpStatus: 404,
          method,
          ...(standardCode !== undefined ? { serviceCode: standardCode } : {}),
          body: truncateBody(outcome.text),
        },
        extras: requestExtras,
      },
    );
  }

  if (standard) {
    const details = isRecord(errorValue["details"]) ? errorValue["details"] : undefined;
    const diagnostics = Array.isArray(errorValue["diagnostics"])
      ? (errorValue["diagnostics"] as readonly unknown[])
      : undefined;
    return new CliError(standardCode as string, standardMessage as string, exitCodeForServiceError(outcome.status, standardCode, notFoundIsResource), {
      ...(details ? { details } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      extras: requestExtras,
    });
  }

  return new CliError(
    "SERVICE_HTTP_ERROR",
    `服务返回 HTTP ${outcome.status} 且无标准错误体（${method} ${endpoint}）`,
    exitCodeForServiceError(outcome.status, undefined, notFoundIsResource),
    {
      details: {
        endpoint,
        httpStatus: outcome.status,
        method,
        body: truncateBody(outcome.text),
      },
      extras: requestExtras,
    },
  );
}

export interface RequestStatusProbe {
  readonly ok: boolean;
  readonly httpStatus?: number | undefined;
  readonly state?: string | undefined;
  readonly reason?: string | undefined;
}

export interface RequestStatusResult {
  readonly httpStatus: number;
  readonly requestId: string;
  readonly state: string;
  /** 服务原样状态对象；404 时是合成的 unknown 说明。 */
  readonly status: unknown;
}

function unknownStatus(requestId: string, reason: string): Record<string, unknown> {
  return { requestId, state: "unknown", reason };
}

/**
 * 一次只读状态查询：GET /api/changes/:requestId。
 * 404 与未知状态都如实反映为 unknown，不猜测写入是否发生，也不重放写请求。
 */
export async function queryRequestStatus(
  baseUrl: string,
  requestId: string,
  options: RequestJsonOptions = {},
): Promise<RequestStatusResult> {
  const endpoint = new URL(
    `api/changes/${encodeURIComponent(requestId)}`,
    baseUrl,
  ).toString();
  const outcome = await requestJson(
    endpoint,
    { method: "GET", headers: { Accept: "application/json" } },
    options,
  );
  if (outcome.status === 404) {
    const status = unknownStatus(
      requestId,
      "服务没有该 requestId 的记录（可能重启或记录已清理）；请重读源文件，不要自动重放",
    );
    return { httpStatus: 404, requestId, state: "unknown", status };
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    throw serviceErrorFromResponse(outcome, {
      endpoint,
      method: "GET",
      requestId,
      notFoundIsResource: false,
    });
  }
  if (!isRecord(outcome.body)) {
    const status = unknownStatus(requestId, "服务返回的不是 JSON 对象");
    return { httpStatus: outcome.status, requestId, state: "unknown", status };
  }
  const state =
    typeof outcome.body["state"] === "string" ? (outcome.body["state"] as string) : "unknown";
  return {
    httpStatus: outcome.status,
    requestId,
    state,
    status: { ...outcome.body, state },
  };
}

/** 写入结果不明：只报告 unknown 与一次状态探测，绝不自动重放。 */
export function resultUnknownError(
  requestId: string,
  endpoint: string,
  cause: string,
  probe: RequestStatusProbe | null,
): CliError {
  const state = probe?.state ?? "unavailable";
  return new CliError(
    "RESULT_UNKNOWN",
    `提交结果未知：请求可能已提交也可能未提交。requestId ${requestId}；` +
      "请用 aichat status 查询，或重读源文件后决定；不会自动重放。",
    EXIT_CODES.resultUnknown,
    {
      details: { requestId, endpoint, cause, status: state, statusProbe: probe },
      extras: { requestId, status: "unknown", statusProbe: probe },
    },
  );
}
