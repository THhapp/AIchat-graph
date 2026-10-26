/**
 * 在线 Agent 通道：GET /api/agent/nodes/:id 与 POST /api/agent/changes。
 *
 * 约定：
 * - 单节点详情（/api/agent/nodes/:id）仍返回 editRef，供 important --node 之类
 *   需要先读后写的诊断路径；渐进读取与写响应统一用顶层 refs（nodeId → token）。
 *   凭据由 CLI 原样回传，不自己补最新哈希、不按显示编号重定位；
 * - 外层 requestId 由 CLI 生成；同 requestId 重放由服务幂等处理；
 * - 结果不明时先查一次 status，再如实报告 unknown；不换 requestId 盲重发。
 * - fetch／超时／错误体映射统一在 transport，本模块只描述端点与响应形状。
 */
import { randomUUID } from "node:crypto";
import type {
  AgentBatchCheckResponse,
  AgentChangeAction,
  AgentChangeRequest,
  AgentChangeResponse,
  AgentNodeReadResponse,
  AgentReadRange,
  ReadViewKind,
  ReadViewResponse,
} from "../shared/protocol.js";
import { CliError, EXIT_CODES } from "./errors.js";
import { isRecord } from "../shared/guards.js";
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
  const outcome = await requestJson(
    url,
    { method: "GET", headers: { Accept: "application/json" } },
    { fetchImpl },
  );
  if (outcome.status < 200 || outcome.status >= 300) {
    // 读取端点的 404 + 标准 NOT_FOUND 才是“节点不存在”（退出码 11）。
    throw serviceErrorFromResponse(outcome, {
      endpoint: url,
      method: "GET",
      notFoundIsResource: true,
    });
  }
  const body = outcome.body;
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
 * GET /api/agent/read 的查询。cursor 已包含 view／scope／topic／meta，
 * 续读时只发送 cursor 与 budget；其他参数不重复注入。
 */
export interface AgentReadViewQuery {
  readonly budget: number;
  readonly cursor?: string | undefined;
  readonly view?: ReadViewKind | undefined;
  readonly topicId?: string | undefined;
  readonly from?: string | undefined;
  readonly nodeIds?: readonly string[] | undefined;
  readonly content?: AgentReadOptions | undefined;
}

function buildReadViewUrl(baseUrl: string, query: AgentReadViewQuery): string {
  const url = new URL("api/agent/read", baseUrl);
  url.searchParams.set("budget", String(query.budget));
  if (query.cursor !== undefined) {
    // 续读标记是完整的范围描述；调用方只可另带 budget。
    url.searchParams.set("cursor", query.cursor);
    return url.toString();
  }
  if (query.view !== undefined) url.searchParams.set("view", query.view);
  if (query.topicId !== undefined) url.searchParams.set("topic", query.topicId);
  if (query.from !== undefined) url.searchParams.set("from", query.from);
  for (const nodeId of query.nodeIds ?? []) url.searchParams.append("node", nodeId);
  const content = query.content;
  if (content !== undefined) {
    if (content.start !== undefined) url.searchParams.set("start", String(content.start));
    if (content.length !== undefined) url.searchParams.set("length", String(content.length));
    if (content.full === true) url.searchParams.set("full", "true");
    if (content.meta === true) url.searchParams.set("meta", "true");
    if (content.section !== undefined) url.searchParams.set("section", content.section);
    if (content.sectionIndex !== undefined) {
      url.searchParams.set("section-index", String(content.sectionIndex));
    }
  }
  return url.toString();
}

/**
 * GET /api/agent/read：返回完整 ReadViewResponse（overview／structure／content）。
 * 分页、预算与 scope 全部由服务端决定，CLI 不自行截断或拼接。
 */
export async function readAgentView(
  service: ResolvedService,
  query: AgentReadViewQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadViewResponse> {
  const url = buildReadViewUrl(service.baseUrl, query);
  const outcome = await requestJson(
    url,
    { method: "GET", headers: { Accept: "application/json" } },
    { fetchImpl },
  );
  if (outcome.status < 200 || outcome.status >= 300) {
    // 读取端点的 404 + 标准 NOT_FOUND 才是“主题／节点不存在”（退出码 11）。
    throw serviceErrorFromResponse(outcome, {
      endpoint: url,
      method: "GET",
      notFoundIsResource: true,
    });
  }
  const body = outcome.body;
  if (!isRecord(body)) throw invalidResponse(url, "响应必须是 JSON 对象");
  if (body["ok"] !== true) throw invalidResponse(url, "缺少 ok:true");
  if (!Array.isArray(body["items"])) throw invalidResponse(url, "items 必须是数组");
  return body as unknown as ReadViewResponse;
}

/**
 * 一次状态探测：GET /api/changes/:requestId 的薄调用。
 * 只读查询，不重放写请求；失败也如实返回原因，不据此推断提交结果。
 */
export async function probeRequestStatus(
  service: ResolvedService,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RequestStatusProbe> {
  try {
    const result = await queryRequestStatus(service.baseUrl, requestId, {
      fetchImpl,
      timeoutMs: 5000,
    });
    return { ok: true, httpStatus: result.httpStatus, state: result.state };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface AgentChangeResult<T = AgentChangeResponse> {
  readonly requestId: string;
  readonly httpStatus: number;
  readonly response: T;
}

export interface AgentSubmitOptions {
  /** 调用方已有 requestId 时复用（重试或测试）；默认生成 UUID。 */
  readonly requestId?: string | undefined;
  /** 仅 batch 支持：true 时服务只检查，不落盘、不写 agentLog。 */
  readonly dryRun?: boolean | undefined;
}

/**
 * 提交一次低摩擦动作。CLI 负责生成 requestId；同一调用重试时必须复用同一 ID。
 * 超时／断线不自动重放：抛出 RESULT_UNKNOWN，由调用方用 status 或重读决定。
 */
export async function submitAgentChange<
  T extends AgentChangeResponse | AgentBatchCheckResponse = AgentChangeResponse,
>(
  service: ResolvedService,
  action: AgentChangeAction,
  fetchImpl: typeof fetch = fetch,
  options: AgentSubmitOptions = {},
): Promise<AgentChangeResult<T>> {
  const requestId = options.requestId ?? randomUUID();
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
    ...(options.dryRun === true ? { dryRun: true } : {}),
    action,
  };
  const endpoint = new URL("api/agent/changes", service.baseUrl).toString();

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
        body: JSON.stringify(request),
      },
      { fetchImpl },
    );
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "SERVICE_UNREACHABLE") throw error;
    // 只探测一次原 requestId 的状态（不是重放写请求）：可能因服务短暂不可达而失败。
    const probe = await probeRequestStatus(service, requestId, fetchImpl);
    throw resultUnknownError(requestId, endpoint, error.message, probe);
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    // 写端点 404 是端点缺失，不能冒充“节点不存在”。
    throw serviceErrorFromResponse(outcome, {
      endpoint,
      method: "POST",
      requestId,
      notFoundIsResource: false,
    });
  }
  if (!isRecord(outcome.body) || outcome.body["ok"] !== true) {
    throw invalidResponse(endpoint, "缺少 ok:true");
  }
  return {
    requestId,
    httpStatus: outcome.status,
    response: outcome.body as unknown as T,
  };
}
