/**
 * 变更集合 `/api/changes` 的业务包装。传输、超时与错误映射统一在 transport。
 *
 * - 写请求固定 Content-Type: application/json 与 X-AIchat-Client: cli；
 * - 超时/断线时不盲目重放：先 GET /api/changes/:requestId 查询一次，仍未知则显式
 *   返回 RESULT_UNKNOWN；绝不断言“一定未写入”；写端点 404 不当作资源不存在。
 */
import { CliError } from "./errors.js";
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from "./service-client.js";
import type { ResolvedService } from "./service-client.js";
import {
  queryRequestStatus,
  requestJson,
  resultUnknownError,
  serviceErrorFromResponse,
  type HttpOutcome,
  type RequestStatusProbe,
} from "./transport.js";

export interface ChangeSubmission {
  readonly httpStatus: number;
  readonly requestId: string;
  readonly result: unknown;
}

const WRITE_HEADERS = {
  "Content-Type": "application/json",
  [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
  Accept: "application/json",
} as const;

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
    { method: "POST", headers: WRITE_HEADERS, body: rawBody },
    { fetchImpl },
  );
  if (outcome.status < 200 || outcome.status >= 300) {
    throw serviceErrorFromResponse(outcome, {
      endpoint,
      method: "POST",
      requestId,
      notFoundIsResource: false,
    });
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
      { method: "POST", headers: WRITE_HEADERS, body: rawBody },
      { fetchImpl },
    );
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "SERVICE_UNREACHABLE") throw error;
    // 只做一次只读状态探测，不重放写请求。
    let probe: RequestStatusProbe | null;
    try {
      const status = await queryRequestStatus(service.baseUrl, requestId, { fetchImpl });
      probe = { ok: true, httpStatus: status.httpStatus, state: status.state };
    } catch (probeError) {
      probe = {
        ok: false,
        reason: probeError instanceof Error ? probeError.message : String(probeError),
      };
    }
    throw resultUnknownError(requestId, endpoint, error.message, probe);
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    throw serviceErrorFromResponse(outcome, {
      endpoint,
      method: "POST",
      requestId,
      notFoundIsResource: false,
    });
  }
  return { httpStatus: outcome.status, requestId, result: outcome.body };
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
  const result = await queryRequestStatus(service.baseUrl, requestId, { fetchImpl });
  return { httpStatus: result.httpStatus, requestId: result.requestId, status: result.status };
}
