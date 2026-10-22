/**
 * 变更集合的 HTTP 传输。只做传输与错误映射，不解释 operations 语义。
 *
 * - 写请求固定 Content-Type: application/json 与 X-AIchat-Client: cli；
 * - 服务错误体为 { error: { code, message, details?, diagnostics? } }；
 * - 超时/断线时不盲目重放：先 GET /api/changes/:requestId 查询，仍未知则显式
 *   返回 UNKNOWN，并要求调用方重读源文件；绝不断言“一定未写入”。
 */
import { CliError, EXIT_CODES } from "./errors.js";
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, REQUEST_TIMEOUT_MS } from "./service-client.js";
import type { ResolvedService } from "./service-client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 依 HTTP 状态码区分退出码：412/409/422 分别对应版本冲突、操作冲突与校验失败。 */
export function exitCodeForHttpStatus(status: number): number {
  if (status === 412) return EXIT_CODES.versionConflict;
  if (status === 409) return EXIT_CODES.operationConflict;
  if (status === 422) return EXIT_CODES.validation;
  if (status === 400) return EXIT_CODES.usage;
  if (status === 404) return EXIT_CODES.http;
  return EXIT_CODES.http;
}

interface HttpOutcome {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<HttpOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
    // 响应头已到但连接在正文中途断开：对写请求同样属于“结果未知”，
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

function serviceError(
  endpoint: string,
  outcome: HttpOutcome,
  requestId: string,
): CliError {
  const errorValue = isRecord(outcome.body) ? outcome.body["error"] : undefined;
  if (isRecord(errorValue) && typeof errorValue["code"] === "string") {
    const code = errorValue["code"];
    const message =
      typeof errorValue["message"] === "string" ? errorValue["message"] : "服务拒绝了请求";
    const details = isRecord(errorValue["details"]) ? errorValue["details"] : undefined;
    const diagnostics = Array.isArray(errorValue["diagnostics"])
      ? (errorValue["diagnostics"] as readonly unknown[])
      : undefined;
    return new CliError(code, message, exitCodeForHttpStatus(outcome.status), {
      ...(details ? { details } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      extras: { httpStatus: outcome.status, requestId, endpoint },
    });
  }
  return new CliError(
    "SERVICE_HTTP_ERROR",
    `服务返回 HTTP ${outcome.status} 且无标准错误体`,
    exitCodeForHttpStatus(outcome.status),
    {
      details: {
        endpoint,
        httpStatus: outcome.status,
        body: outcome.text.length > 2000 ? outcome.text.slice(0, 2000) + "…" : outcome.text,
      },
      extras: { httpStatus: outcome.status, requestId, endpoint },
    },
  );
}

export interface ChangeSubmission {
  readonly httpStatus: number;
  readonly requestId: string;
  readonly result: unknown;
}

/** POST /api/changes/check：不写文件。 */
export async function checkChanges(
  service: ResolvedService,
  rawBody: string,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChangeSubmission> {
  const endpoint = new URL("api/changes/check", service.baseUrl).toString();
  const outcome = await requestJson(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
        Accept: "application/json",
      },
      body: rawBody,
    },
    fetchImpl,
  );
  if (outcome.status < 200 || outcome.status >= 300) {
    throw serviceError(endpoint, outcome, requestId);
  }
  return { httpStatus: outcome.status, requestId, result: outcome.body };
}

/**
 * POST /api/changes：写入。仅“连接失败／超时”时转入 unknown 判定；
 * 服务端明确返回的错误体（包括 409/412/422）直接抛出，不重放。
 */
export async function applyChanges(
  service: ResolvedService,
  rawBody: string,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChangeSubmission> {
  const endpoint = new URL("api/changes", service.baseUrl).toString();
  let outcome: HttpOutcome;
  try {
    outcome = await requestJson(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
          Accept: "application/json",
        },
        body: rawBody,
      },
      fetchImpl,
    );
  } catch (error) {
    const cli = error instanceof CliError ? error : undefined;
    if (cli?.code !== "SERVICE_UNREACHABLE") throw error;
    const status = await queryChangeStatus(service, requestId, fetchImpl).catch(() => null);
    throw unknownOutcomeError(requestId, endpoint, cli.message, status);
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    throw serviceError(endpoint, outcome, requestId);
  }
  return { httpStatus: outcome.status, requestId, result: outcome.body };
}

export function unknownOutcomeError(
  requestId: string,
  endpoint: string,
  cause: string,
  status: unknown,
): CliError {
  return new CliError(
    "RESULT_UNKNOWN",
    "写入结果未知：请求可能已提交也可能未提交。请用 aichat status 查询，或重读源文件后再决定；不会自动重放。",
    EXIT_CODES.resultUnknown,
    {
      details: { requestId, endpoint, cause, status: status ?? "unavailable" },
      extras: { requestId, status: "unknown" },
    },
  );
}

export interface ChangeStatusResult {
  readonly httpStatus: number;
  readonly requestId: string;
  readonly status: unknown;
}

/** GET /api/changes/:requestId；404 或未知状态都如实反映，不猜测。 */
export async function queryChangeStatus(
  service: ResolvedService,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChangeStatusResult> {
  const endpoint = new URL(
    `api/changes/${encodeURIComponent(requestId)}`,
    service.baseUrl,
  ).toString();
  const outcome = await requestJson(
    endpoint,
    { method: "GET", headers: { Accept: "application/json" } },
    fetchImpl,
  );
  if (outcome.status === 404) {
    return {
      httpStatus: 404,
      requestId,
      status: {
        requestId,
        state: "unknown",
        reason: "服务没有该 requestId 的记录（可能重启或记录已清理）；请重读源文件，不要自动重放",
      },
    };
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    throw serviceError(endpoint, outcome, requestId);
  }
  if (!isRecord(outcome.body)) {
    return {
      httpStatus: outcome.status,
      requestId,
      status: { requestId, state: "unknown", reason: "服务返回的不是 JSON 对象" },
    };
  }
  const state = typeof outcome.body["state"] === "string" ? outcome.body["state"] : "unknown";
  return { httpStatus: outcome.status, requestId, status: { ...outcome.body, state } };
}