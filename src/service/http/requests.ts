/** HTTP 请求解析与边界校验；不注册路由，也不执行内容变更。 */
import type { Context } from "hono";
import { z } from "zod";
import {
  anyChangeRequestSchema,
  flattenChangeRequestIssues,
  sha256Bytes,
  type AnyChangeRequest,
} from "../../storage/index.js";
import type { AgentChangeRequest } from "../../shared/protocol.js";
import { agentChangeRequestSchema } from "../agent.js";
import { ServiceError, wireDiagnostic } from "../errors.js";
import type { WorkspaceRuntime } from "../workspace.js";

/** 写请求的固定客户端标识，包含 Agent 写入与前端导出配置。 */
export const CLIENT_HEADER = "X-AIchat-Client";
export const CLIENT_HEADER_VALUE = "cli";
/** 变更请求体上限：足够一次多文件批量编辑，但远小于滥用规模。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** 导出目标的唯一写入口：path 为绝对 html 路径或 null（解除绑定）。 */
const exportTargetRequestSchema = z.strictObject({
  path: z.string().min(1).nullable(),
});
/**
 * 重要标记：只允许 id 与这一项元数据；expectedHash 可选，给出时按旧哈希校验。
 * 未知字段一律拒绝，避免这里被当成第二个正文编辑器。
 */
const importanceRequestSchema = z.strictObject({
  topicId: z.string().regex(/^t_[0-9a-f]{32}$/),
  nodeId: z.string().regex(/^n_[0-9a-f]{32}$/),
  important: z.boolean(),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

/** 对外错误：内部未知错误不回显栈。 */
export function badRequest(message: string, details?: unknown): ServiceError {
  return new ServiceError(400, "BAD_REQUEST", message, details === undefined ? {} : { details });
}

export function parseVersionQuery(c: Context): { instanceId: string; revision: number } | null {
  const instanceId = c.req.query("instanceId");
  const revisionRaw = c.req.query("revision");
  if (instanceId === undefined && revisionRaw === undefined) return null;
  if (instanceId === undefined || revisionRaw === undefined) {
    throw badRequest("instanceId 与 revision 必须同时提供");
  }
  if (!/^[0-9]+$/.test(revisionRaw)) throw badRequest("revision 必须是非负整数");
  return { instanceId, revision: Number(revisionRaw) };
}

export function assertSnapshotVersion(
  runtime: WorkspaceRuntime,
  query: { instanceId: string; revision: number } | null,
): void {
  if (query === null) return;
  if (query.instanceId !== runtime.instanceId || query.revision !== runtime.revision) {
    throw new ServiceError(
      409,
      "STALE_SNAPSHOT",
      "请求的快照版本已失效；请重新获取 graph 后重试",
      {
        details: {
          requested: query,
          current: runtime.snapshotVersion(),
        },
      },
    );
  }
}

function assertNoPrototypeKeys(value: unknown, depth = 0): void {
  if (depth > 32) throw badRequest("请求体嵌套过深");
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrototypeKeys(item, depth + 1);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw badRequest("请求体包含不允许的原型键: " + key);
    }
    assertNoPrototypeKeys((value as Record<string, unknown>)[key], depth + 1);
  }
}

/** 读取并严格校验写请求体；返回原文（用于幂等比对）与解析后的请求。 */
export async function readChangeRequest(
  c: Context,
): Promise<{ rawText: string; request: AnyChangeRequest; bodyHash: string }> {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new ServiceError(415, "UNSUPPORTED_MEDIA_TYPE", "写请求必须使用 application/json", {});
  }
  const clientHeader = c.req.header(CLIENT_HEADER) ?? c.req.header(CLIENT_HEADER.toLowerCase());
  if (clientHeader !== CLIENT_HEADER_VALUE) {
    throw new ServiceError(
      403,
      "FORBIDDEN",
      "写请求必须携带 " + CLIENT_HEADER + ": " + CLIENT_HEADER_VALUE,
      {},
    );
  }
  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined) {
    const size = Number(contentLength);
    if (!Number.isFinite(size) || size > MAX_BODY_BYTES) {
      throw new ServiceError(413, "PAYLOAD_TOO_LARGE", "请求体超过上限", {
        details: { maxBytes: MAX_BODY_BYTES },
      });
    }
  }
  const rawText = await c.req.text();
  if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) {
    throw new ServiceError(413, "PAYLOAD_TOO_LARGE", "请求体超过上限", {
      details: { maxBytes: MAX_BODY_BYTES },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw badRequest(
      "请求体不是合法 JSON: " + (error instanceof Error ? error.message : String(error)),
    );
  }
  assertNoPrototypeKeys(parsed);
  // 低层入口接受两版请求：具体操作形状由 storage 的严格联合 schema 判断，
  // 再由 prepareChangesForWorkspace 按当前工作区格式分派，不在传输层复制联合规则。
  const validated = anyChangeRequestSchema.safeParse(parsed);
  if (!validated.success) {
    // 联合 schema 的原生 issue 路径常为空；用 storage 的展开器保留
    // "operations.0.op" 这类具体位置，错误可读性与接受/拒绝判定都沿用原 schema。
    const issues = flattenChangeRequestIssues(validated.error);
    throw new ServiceError(400, "BAD_REQUEST", "ChangeRequest 结构不合法", {
      diagnostics: issues.map((issue) =>
        wireDiagnostic(
          "CHANGE_REQUEST_INVALID",
          issue.path.map(String).join(".") + ": " + issue.message,
        ),
      ),
      details: {
        issues: issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
    });
  }
  return {
    rawText,
    request: validated.data as AnyChangeRequest,
    bodyHash: sha256Bytes(rawText),
  };
}

/** 读取并严格校验 agent 写请求体（引用头与本机安全检查与低层写一致）。 */
export async function readAgentRequest(
  c: Context,
): Promise<{ rawText: string; request: AgentChangeRequest; bodyHash: string }> {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new ServiceError(415, "UNSUPPORTED_MEDIA_TYPE", "写请求必须使用 application/json", {});
  }
  const clientHeader = c.req.header(CLIENT_HEADER) ?? c.req.header(CLIENT_HEADER.toLowerCase());
  if (clientHeader !== CLIENT_HEADER_VALUE) {
    throw new ServiceError(403, "FORBIDDEN", "写请求必须携带 " + CLIENT_HEADER + ": " + CLIENT_HEADER_VALUE, {});
  }
  const rawText = await c.req.text();
  if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) {
    throw new ServiceError(413, "PAYLOAD_TOO_LARGE", "请求体超过上限", {
      details: { maxBytes: MAX_BODY_BYTES },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw badRequest("请求体不是合法 JSON: " + (error instanceof Error ? error.message : String(error)));
  }
  assertNoPrototypeKeys(parsed);
  const validated = agentChangeRequestSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ServiceError(400, "BAD_REQUEST", "AgentChangeRequest 结构不合法", {
      diagnostics: validated.error.issues.map((issue) =>
        wireDiagnostic("AGENT_REQUEST_INVALID", issue.path.join(".") + ": " + issue.message),
      ),
      details: { issues: validated.error.issues.map((issue) => issue.path.join(".")) },
    });
  }
  return {
    rawText,
    request: validated.data as unknown as AgentChangeRequest,
    bodyHash: sha256Bytes(rawText),
  };
}

/** 导出目标请求：只接受 application/json、本机客户端头与已知字段。 */
export async function readExportTargetRequest(c: Context): Promise<{ path: string | null }> {
  assertClientHeader(c);
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new ServiceError(415, "UNSUPPORTED_MEDIA_TYPE", "写请求必须使用 application/json", {});
  }
  const rawText = await c.req.text();
  if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) {
    throw new ServiceError(413, "PAYLOAD_TOO_LARGE", "请求体超过上限", {
      details: { maxBytes: MAX_BODY_BYTES },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw badRequest("请求体不是合法 JSON: " + (error instanceof Error ? error.message : String(error)));
  }
  assertNoPrototypeKeys(parsed);
  const validated = exportTargetRequestSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ServiceError(400, "BAD_REQUEST", "导出目标请求结构不合法", {
      diagnostics: validated.error.issues.map((issue) =>
        wireDiagnostic("EXPORT_REQUEST_INVALID", issue.path.join(".") + ": " + issue.message),
      ),
    });
  }
  return validated.data;
}

/**
 * 重要标记请求：本机客户端头 + application/json + 严格字段。
 * 只翻转一项元数据；任何其他字段（尤其正文）都会在这一层被拒绝。
 */
export async function readImportanceRequest(
  c: Context,
): Promise<{ topicId: string; nodeId: string; important: boolean; expectedHash?: string | undefined }> {
  assertClientHeader(c);
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new ServiceError(415, "UNSUPPORTED_MEDIA_TYPE", "写请求必须使用 application/json", {});
  }
  const rawText = await c.req.text();
  if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) {
    throw new ServiceError(413, "PAYLOAD_TOO_LARGE", "请求体超过上限", {
      details: { maxBytes: MAX_BODY_BYTES },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw badRequest("请求体不是合法 JSON: " + (error instanceof Error ? error.message : String(error)));
  }
  assertNoPrototypeKeys(parsed);
  const validated = importanceRequestSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ServiceError(400, "BAD_REQUEST", "重要标记请求结构不合法", {
      diagnostics: validated.error.issues.map((issue) =>
        wireDiagnostic("IMPORTANCE_REQUEST_INVALID", issue.path.join(".") + ": " + issue.message),
      ),
      details: {
        issues: validated.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return validated.data;
}

/** 本机写客户端头；缺失或错误一律 403。 */
export function assertClientHeader(c: Context): void {
  const value = c.req.header(CLIENT_HEADER) ?? c.req.header(CLIENT_HEADER.toLowerCase());
  if (value !== CLIENT_HEADER_VALUE) {
    throw new ServiceError(
      403,
      "FORBIDDEN",
      "写请求必须携带 " + CLIENT_HEADER + ": " + CLIENT_HEADER_VALUE,
      {},
    );
  }
}
