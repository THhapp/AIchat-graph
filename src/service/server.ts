/**
 * 本机 HTTP／SSE 传输层。
 *
 * 安全边界（ARCHITECTURE 10）：
 * - 只监听 127.0.0.1；Host 必须是当前 loopback 端口；
 * - Origin 若存在必须精确对应当前服务 origin，不返回宽泛 CORS 头；
 * - 写操作只接受 application/json 与固定头 X-AIchat-Client: cli；
 * - 限制请求体大小，拒绝原型键；路径只按 ID／受控相对路径解析。
 *
 * 传输层只做解析、版本核对与错误映射；业务语义全部委托协调器与候选模块。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { serveStatic } from "@hono/node-server/serve-static";
import { parseWorkspaceDocuments } from "../core/index.js";
import {
  anyChangeRequestSchema,
  flattenChangeRequestIssues,
  readWorkspaceFiles,
  sha256Bytes,
  StorageError,
  type AnyChangeRequest,
} from "../storage/index.js";
import { captureResources } from "../export/index.js";
import type {
  DiagnosticsResponse,
  GraphResponse,
  NodeDetailResponse,
  SearchResponse,
  SnapshotEvent,
  TopicDetailResponse,
  TopicNodeDetail,
  TopicsResponse,
  WorkspaceResponse,
  AgentChangeRequest,
  ExportsResponse,
  ExportTargetResponse,
  GraphNode,
  ExportEvent,
  NodeFlow as ThreadFlow,
  NodeState as ThreadState,
  Diagnostic,
} from "../shared/protocol.js";
import { applyChanges, applyAgentChange, checkChanges } from "./changes.js";
import { agentChangeRequestSchema, parseAgentReadQuery, readAgentNode } from "./agent.js";
import type { ExportCoordinator as ExportCoordinatorType } from "./export.js";
import {
  ServiceError,
  serviceErrorFromUnknown,
  toWireDiagnostic,
  toWireStorageDiagnostic,
  wireDiagnostic,
} from "./errors.js";
import { combinedHash, graphNodes, graphTopics, type SnapshotData } from "./snapshot.js";
import { searchIndex, SearchQueryError } from "../index/index.js";
import type { WorkspaceRuntime } from "./workspace.js";

/** 写请求的固定客户端标识；浏览器页面不会发送，也不应发送。 */
export const CLIENT_HEADER = "X-AIchat-Client";
export const CLIENT_HEADER_VALUE = "cli";
/** 变更请求体上限：足够一次多文件批量编辑，但远小于滥用规模。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;

/** 导出目标的唯一写入口：path 为绝对 html 路径或 null（解除绑定）。 */
const exportTargetRequestSchema = z.strictObject({
  path: z.string().min(1).nullable(),
});

export function errorBody(error: ServiceError): {
  error: { code: string; message: string; diagnostics?: Diagnostic[]; details?: unknown };
} {
  const body: {
    error: { code: string; message: string; diagnostics?: Diagnostic[]; details?: unknown };
  } = { error: { code: error.code, message: error.message } };
  if (error.diagnostics !== undefined && error.diagnostics.length > 0) {
    body.error.diagnostics = [...error.diagnostics];
  }
  if (error.details !== undefined) body.error.details = error.details;
  return body;
}

function jsonResponse(c: Context, body: unknown, status = 200): Response {
  return c.json(body as never, status as never);
}

function fail(c: Context, error: unknown): Response {
  const serviceError = serviceErrorFromUnknown(error);
  return jsonResponse(c, errorBody(serviceError), serviceError.status);
}

/** 对外错误：内部未知错误不回显栈。 */
function badRequest(message: string, details?: unknown): ServiceError {
  return new ServiceError(400, "BAD_REQUEST", message, details === undefined ? {} : { details });
}

function parseVersionQuery(c: Context): { instanceId: string; revision: number } | null {
  const instanceId = c.req.query("instanceId");
  const revisionRaw = c.req.query("revision");
  if (instanceId === undefined && revisionRaw === undefined) return null;
  if (instanceId === undefined || revisionRaw === undefined) {
    throw badRequest("instanceId 与 revision 必须同时提供");
  }
  if (!/^[0-9]+$/.test(revisionRaw)) throw badRequest("revision 必须是非负整数");
  return { instanceId, revision: Number(revisionRaw) };
}

function assertSnapshotVersion(
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

function runtimeAgentEntry(): { cliPath: string; skillPath: string } {
  const appRoot = fileURLToPath(new URL("../../", import.meta.url));
  return {
    cliPath: path.join(appRoot, "dist", "cli", "index.js"),
    skillPath: path.join(appRoot, "skills", "aichat-graph", "SKILL.md"),
  };
}

function workspaceResponse(runtime: WorkspaceRuntime): WorkspaceResponse {
  return {
    ...runtime.snapshotVersion(),
    workspaceId: runtime.workspaceId,
    name: runtime.current.data.name,
    rootPath: runtime.rootReal,
    topicMode: runtime.current.data.topicMode ?? "shared",
    agentEntry: runtimeAgentEntry(),
    activeNode: runtime.current.data.graph.activeNode,
    stale: runtime.stale,
    diagnostics: runtime.diagnostics,
  };
}

function graphResponse(runtime: WorkspaceRuntime): GraphResponse {
  return {
    topicMode: runtime.current.data.topicMode ?? "shared",
    ...runtime.snapshotVersion(),
    workspaceId: runtime.workspaceId,
    activeNode: runtime.current.data.graph.activeNode,
    stale: runtime.stale,
    diagnostics: runtime.diagnostics,
    nodes: graphNodes(runtime.current.data),
    topics: graphTopics(runtime.current.data),
  };
}

/** 图节点 → 传输 DTO；description 是格式 2 的来源说明，label 仅格式 1 兼容。 */
function toWireNode(node: SnapshotData["graph"]["nodes"][number]): GraphNode {
  return {
    id: node.id,
    topicId: node.topicId,
    title: node.title,
    summary: node.summary,
    number: node.number,
    from: node.from,
    flow: node.flow,
    state: node.state,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    ...(node.description === undefined && node.label !== undefined ? { label: node.label } : {}),
    sourcePath: node.sourcePath,
  };
}

/** 磁盘主题详情里出现、但当前快照没有的节点：number 留空，不借用别的节点编号。 */
function fallbackNode(node: {
  id: string;
  topicId: string;
  title: string;
  summary: string;
  state: ThreadState;
  flow: ThreadFlow;
  from: string | null;
  description?: string | undefined;
  side?: "left" | "right" | undefined;
  order?: number | undefined;
  label?: string | undefined;
  sourcePath?: string | undefined;
}): GraphNode {
  return {
    id: node.id,
    topicId: node.topicId,
    title: node.title,
    summary: node.summary,
    number: "",
    from: node.from,
    flow: node.flow,
    state: node.state,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    ...(node.description === undefined && node.label !== undefined ? { label: node.label } : {}),
    ...(node.sourcePath !== undefined ? { sourcePath: node.sourcePath } : {}),
  };
}

function nodeDetail(
  runtime: WorkspaceRuntime,
  snapshot: SnapshotData,
  nodeId: string,
): NodeDetailResponse {
  const node = snapshot.graph.nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) {
    throw new ServiceError(404, "NOT_FOUND", "当前快照中没有节点 " + nodeId, {
      details: { nodeId },
    });
  }
  const topic = snapshot.topics.find((entry) => entry.topicId === node.topicId);
  if (topic === undefined) {
    throw new ServiceError(404, "NOT_FOUND", "节点来源主题不在当前快照中", {
      details: { nodeId, topicId: node.topicId },
    });
  }
  const source = topic.files.find((file) => file.path === node.sourcePath);
  if (source === undefined) {
    throw new ServiceError(404, "NOT_FOUND", "节点真实源文件不在当前快照中", {
      details: { nodeId, sourcePath: node.sourcePath },
    });
  }
  return {
    ...runtime.snapshotVersion(),
    node: toWireNode(node),
    body: node.body,
    topicId: node.topicId,
    // 节点正文的版本是它自己的真实源文件，不是 topic.md 的哈希。
    path: source.path,
    fileHash: source.fileHash,
  };
}

function snapshotTopicDetail(
  runtime: WorkspaceRuntime,
  snapshot: SnapshotData,
  topicId: string,
): TopicDetailResponse {
  const topic = snapshot.topics.find((entry) => entry.topicId === topicId);
  if (topic === undefined) {
    throw new ServiceError(404, "NOT_FOUND", "当前快照中没有主题 " + topicId, {
      details: { topicId },
    });
  }
  const graphNodeById = new Map(snapshot.graph.nodes.map((node) => [node.id, node]));
  const fileHashByPath = new Map(topic.files.map((file) => [file.path, file.fileHash]));
  const nodes: TopicNodeDetail[] = topic.nodes.map((parsed) => {
    const view = graphNodeById.get(parsed.id);
    return {
      ...(view === undefined ? fallbackNode(parsed) : toWireNode(view)),
      body: parsed.body,
      path: parsed.sourcePath,
      fileHash: fileHashByPath.get(parsed.sourcePath) ?? "",
    };
  });
  const graphView = snapshot.graph.topics.find((entry) => entry.topicId === topicId);
  return {
    ...runtime.snapshotVersion(),
    source: "snapshot",
    valid: true,
    topic: {
      id: topic.topicId,
      title: topic.title,
      path: topic.path,
      nodeIds: graphView ? [...graphView.nodeIds] : topic.nodes.map((node) => node.id),
      fileHash: topic.fileHash,
      contentHash: topic.contentHash,
    },
    // V2 的 raw 只是主题入口（topic.md）；完整阅读按 nodes 里的真实文件。
    raw: topic.raw,
    fileHash: topic.fileHash,
    nodes,
    diagnostics: [...topic.resourceDiagnostics],
    resources: topic.resources,
  } as TopicDetailResponse;
}

/**
 * 不带宽度的主题详情：读取真实磁盘字节。
 * 成功时 raw、fileHash 与 nodes 都来自这一次读取；失败时 valid=false、
 * nodes 为空并给出解析诊断，绝不把旧快照正文配上新磁盘哈希。
 */
async function diskTopicDetail(
  runtime: WorkspaceRuntime,
  topicId: string,
): Promise<TopicDetailResponse> {
  const known = runtime.current.data.topics.find((entry) => entry.topicId === topicId);
  // 磁盘详情按一次完整扫描分组解析：V2 一个主题是多份真实文件，不能只读 topic.md。
  let scanned;
  try {
    scanned = await readWorkspaceFiles(runtime.rootReal);
  } catch (error) {
    if (error instanceof StorageError) {
      throw new ServiceError(422, "VALIDATION_FAILED", "无法读取工作区：" + error.message, {
        diagnostics: [wireDiagnostic(error.code, error.message, error.path)],
        details: { topicId },
      });
    }
    throw error;
  }
  const parsedWorkspace = parseWorkspaceDocuments({
    workspace: {
      schemaVersion: scanned.workspace.schemaVersion,
      ...(scanned.workspace.topicMode !== undefined ? { topicMode: scanned.workspace.topicMode } : {}),
      workspaceId: scanned.workspace.workspaceId,
      name: scanned.workspace.name,
      activeNode: scanned.workspace.activeNode,
    },
    documents: scanned.topics.map((file) => ({ path: file.path, text: file.text })),
  });
  const diagnostics: Diagnostic[] = [
    ...scanned.diagnostics.map((item) => toWireStorageDiagnostic(item, "warning")),
    ...parsedWorkspace.diagnostics.map(toWireDiagnostic),
  ];
  const parsedTopic = parsedWorkspace.topics.find((entry) => entry.topicId === topicId);
  const entryPath = known?.path ?? parsedTopic?.document.path;
  if (entryPath === undefined) {
    throw new ServiceError(404, "NOT_FOUND", "磁盘上找不到主题 " + topicId, {
      details: { topicId },
    });
  }
  const entryFile = scanned.topics.find((file) => file.path === entryPath);
  if (entryFile === undefined) {
    return {
      ...runtime.snapshotVersion(),
      source: "disk",
      valid: false,
      topic: { id: topicId, title: known?.title ?? "", path: entryPath, nodeIds: [], fileHash: "" },
      raw: "",
      fileHash: "",
      nodes: [],
      diagnostics: [
        ...diagnostics,
        wireDiagnostic("TOPIC_META_MISSING", "主题入口文件已不存在", entryPath),
      ],
    };
  }

  if (parsedTopic === undefined) {
    return {
      ...runtime.snapshotVersion(),
      source: "disk",
      valid: false,
      topic: {
        id: topicId,
        title: known?.title ?? "",
        path: entryPath,
        nodeIds: [],
        fileHash: entryFile.sha256,
      },
      raw: entryFile.text,
      fileHash: entryFile.sha256,
      nodes: [],
      diagnostics,
    };
  }

  if (parsedTopic.topicId !== topicId) {
    diagnostics.push(
      wireDiagnostic(
        "TOPIC_ID_CHANGED",
        "磁盘主题的 topicId 已变为 " + parsedTopic.topicId + "（请求的是 " + topicId + "）",
        entryPath,
        "warning",
      ),
    );
  }
  const graphNodeById = new Map(runtime.current.data.graph.nodes.map((node) => [node.id, node]));
  const fileHashByPath = new Map(
    scanned.topics.map((file) => [file.path, file.sha256] as const),
  );
  // 磁盘详情按图的派生结构顺序排列，而不是文件名顺序；同版本的完整阅读顺序才可比较。
  const orderedNodeIds: string[] = [];
  for (const view of runtime.current.data.graph.nodes) {
    if (view.topicId === topicId && parsedTopic.nodes.some((node) => node.id === view.id)) {
      orderedNodeIds.push(view.id);
    }
  }
  for (const node of parsedTopic.nodes) {
    if (!orderedNodeIds.includes(node.id)) orderedNodeIds.push(node.id);
  }
  const parsedById = new Map(parsedTopic.nodes.map((node) => [node.id, node]));
  const nodes: TopicNodeDetail[] = [];
  for (const nodeId of orderedNodeIds) {
    const node = parsedById.get(nodeId);
    if (node === undefined) continue;
    const view = graphNodeById.get(node.id);
    const wire =
      view === undefined
        ? fallbackNode(node)
        : { ...toWireNode(view), number: view.number };
    nodes.push({
      ...wire,
      number: wire.number,
      body: node.body,
      path: node.sourcePath,
      fileHash: fileHashByPath.get(node.sourcePath) ?? "",
    });
  }

  // 与快照路径保持一致：始终交给 export 的 AST 捕获（含引用式图片），
  // 不再用正则门控，避免 disk 详情与 snapshot 详情资源集合不同。
  const resources: Record<string, string> = {};
  const resourceDiagnostics: Diagnostic[] = [];
  try {
    const capture = await captureResources(
      runtime.rootReal,
      parsedTopic.nodes.map((node) => ({ id: node.id, path: node.sourcePath, body: node.body })),
    );
    Object.assign(resources, capture.resources);
    resourceDiagnostics.push(...capture.diagnostics);
  } catch (error) {
    resourceDiagnostics.push(
      wireDiagnostic(
        "RESOURCE_CAPTURE_FAILED",
        "捕获主题资源失败：" + (error instanceof Error ? error.message : String(error)),
        entryPath,
      ),
    );
  }
  diagnostics.push(...resourceDiagnostics);

  const contentHash = combinedHash(
    "topic:" + parsedTopic.topicId,
    [...fileHashByPath.entries()].filter(([path_]) => parsedTopic.sourcePaths.includes(path_)),
  );

  return {
    ...runtime.snapshotVersion(),
    source: "disk",
    valid: true,
    topic: {
      id: parsedTopic.topicId,
      title: parsedTopic.title,
      path: entryPath,
      nodeIds: parsedTopic.nodes.map((node) => node.id),
      fileHash: entryFile.sha256,
      contentHash,
    },
    raw: entryFile.text,
    fileHash: entryFile.sha256,
    nodes,
    diagnostics,
    resources,
  } as TopicDetailResponse;
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
async function readChangeRequest(
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
async function readAgentRequest(
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
async function readExportTargetRequest(c: Context): Promise<{ path: string | null }> {
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

/** 本机写客户端头；缺失或错误一律 403。 */
function assertClientHeader(c: Context): void {
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

export interface AppOptions {
  readonly runtime: WorkspaceRuntime;
  /** dist/web 的绝对路径；不存在时 API 仍可用，页面返回 404。 */
  readonly webRoot: string | null;
  /** 导出协调器；测试或只读场景可为 null（导出接口明确报不可用）。 */
  readonly exports?: ExportCoordinatorType | null | undefined;
}

export function createApp(options: AppOptions): Hono {
  const { runtime, webRoot } = options;
  const exports = options.exports ?? null;
  const app = new Hono();

  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").toLowerCase();
    // 服务只监听 127.0.0.1；Host 只接受当前端口的 loopback 名称，
    // 其它域名（含 DNS rebinding 的伪造域名）一律拒绝。
    const expected = ["127.0.0.1:" + String(runtime.port), "localhost:" + String(runtime.port)];
    if (!expected.includes(host)) {
      return jsonResponse(
        c,
        errorBody(
          new ServiceError(403, "FORBIDDEN", "Host 必须是当前 loopback 服务端口", {
            details: { host, expected },
          }),
        ),
        403,
      );
    }
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      // 服务只提供 http；Origin 必须精确等于本次请求自己的 loopback origin，
      // 避免 127.0.0.1 与 localhost 混用被当成同一来源。
      const expectedOrigin = "http://" + host;
      if (origin !== expectedOrigin) {
        return jsonResponse(
          c,
          errorBody(
            new ServiceError(403, "FORBIDDEN", "不接受跨站 Origin", {
              details: { origin, expected: expectedOrigin },
            }),
          ),
          403,
        );
      }
    }
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });

  app.onError((error, c) => fail(c, error));

  const api = new Hono();
  api.onError((error, c) => fail(c, error));
  api.notFound((c) =>
    jsonResponse(c, errorBody(new ServiceError(404, "NOT_FOUND", "未知 API 路径", {})), 404),
  );

  // 请求体上限：既认 Content-Length，也覆盖 chunked 传输；超限返回统一错误体。
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      jsonResponse(
        c,
        errorBody(
          new ServiceError(413, "PAYLOAD_TOO_LARGE", "请求体超过上限", {
            details: { maxBytes: MAX_BODY_BYTES },
          }),
        ),
        413,
      ),
  });

  api.get("/workspace", (c) => jsonResponse(c, workspaceResponse(runtime)));

  api.get("/graph", (c) => jsonResponse(c, graphResponse(runtime)));

  api.get("/topics", (c) => {
    const body: TopicsResponse = {
      ...runtime.snapshotVersion(),
      topics: graphTopics(runtime.current.data),
    };
    return jsonResponse(c, body);
  });

  api.get("/topics/:id", async (c) => {
    const topicId = c.req.param("id");
    const version = parseVersionQuery(c);
    if (version === null) {
      return jsonResponse(c, await diskTopicDetail(runtime, topicId));
    }
    assertSnapshotVersion(runtime, version);
    return jsonResponse(c, snapshotTopicDetail(runtime, runtime.current.data, topicId));
  });

  api.get("/nodes/:id", (c) => {
    const nodeId = c.req.param("id");
    const version = parseVersionQuery(c);
    assertSnapshotVersion(runtime, version);
    return jsonResponse(c, nodeDetail(runtime, runtime.current.data, nodeId));
  });

  api.get("/agent/nodes/:id", (c) => {
    const nodeId = c.req.param("id");
    const query = parseAgentReadQuery({
      start: c.req.query("start"),
      length: c.req.query("length"),
      full: c.req.query("full"),
    });
    const version = parseVersionQuery(c);
    assertSnapshotVersion(runtime, version);
    return jsonResponse(
      c,
      readAgentNode({ runtime, editRefs: runtime.editRefs, nodeId, query }),
    );
  });

  api.get("/search", (c) => {
    const query = c.req.query("q") ?? "";
    try {
      const topicId = c.req.query("topic");
      if (topicId !== undefined && !runtime.current.data.topics.some((topic) => topic.topicId === topicId)) {
        throw badRequest("搜索主题不存在：" + topicId);
      }
      const search = runtime.current.data.search;
      const outcome = searchIndex(topicId === undefined ? search : {
        ...search, documents: search.documents.filter((document) => document.topicId === topicId),
      }, query);
      const body: SearchResponse = {
        ...runtime.snapshotVersion(),
        query: query.trim(),
        hits: outcome.hits,
        truncated: outcome.truncated,
      };
      return jsonResponse(c, body);
    } catch (error) {
      if (error instanceof SearchQueryError) throw badRequest(error.message);
      throw error;
    }
  });

  api.get("/diagnostics", (c) => {
    const body: DiagnosticsResponse = {
      ...runtime.snapshotVersion(),
      stale: runtime.stale,
      diagnostics: runtime.diagnostics,
    };
    return jsonResponse(c, body);
  });

  api.get("/events", (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      let finish = (): void => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const send = (event: { event: "snapshot" | "diagnostics" | "export"; data: unknown }): void => {
        if (closed) return;
        void stream
          .writeSSE({ event: event.event, data: JSON.stringify(event.data) })
          .catch(() => undefined);
      };

      const heartbeat = setInterval(() => {
        if (closed) return;
        void stream.write(": ping\n\n").catch(() => undefined);
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref();

      const shutdown = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unregister();
        finish();
      };

      const unregister = runtime.registerSse({
        send,
        close: shutdown,
      });

      const initial: SnapshotEvent = {
        event: "snapshot",
        ...runtime.snapshotVersion(),
        changedTopicIds: [],
        changedNodeIds: [],
        stale: runtime.stale,
      };
      send({ event: "snapshot", data: initial });
      send({
        event: "diagnostics",
        data: {
          event: "diagnostics",
          ...runtime.snapshotVersion(),
          diagnostics: runtime.diagnostics,
        },
      });
      if (exports !== null) {
        for (const status of exports.allStatuses()) {
          const payload: ExportEvent = {
            event: "export",
            ...runtime.snapshotVersion(),
            status,
          };
          send({ event: "export", data: payload });
        }
      }

      stream.onAbort(shutdown);
      await done;
      await stream.close().catch(() => undefined);
    });
  });

  api.post("/agent/changes", limitBody, async (c) => {
    const { request, bodyHash } = await readAgentRequest(c);
    if (request.workspaceId !== runtime.workspaceId) {
      throw new ServiceError(409, "WORKSPACE_MISMATCH", "请求的 workspaceId 与服务不一致", {
        details: {
          requestWorkspaceId: request.workspaceId,
          serviceWorkspaceId: runtime.workspaceId,
        },
      });
    }
    return jsonResponse(c, await applyAgentChange(runtime, request, bodyHash));
  });

  api.post("/changes/check", limitBody, async (c) => {
    const { request } = await readChangeRequest(c);
    if (request.workspaceId !== runtime.workspaceId) {
      throw new ServiceError(409, "WORKSPACE_MISMATCH", "ChangeRequest.workspaceId 与服务不一致", {
        details: {
          requestWorkspaceId: request.workspaceId,
          serviceWorkspaceId: runtime.workspaceId,
        },
      });
    }
    return jsonResponse(c, await checkChanges(runtime, request));
  });

  api.post("/changes", limitBody, async (c) => {
    const { request, bodyHash } = await readChangeRequest(c);
    if (request.workspaceId !== runtime.workspaceId) {
      throw new ServiceError(409, "WORKSPACE_MISMATCH", "ChangeRequest.workspaceId 与服务不一致", {
        details: {
          requestWorkspaceId: request.workspaceId,
          serviceWorkspaceId: runtime.workspaceId,
        },
      });
    }
    return jsonResponse(c, await applyChanges(runtime, request, bodyHash));
  });

  /* ------------------------------ 导出 ------------------------------ */

  const requireExports = (): ExportCoordinatorType => {
    if (exports === null) {
      throw new ServiceError(503, "EXPORT_UNAVAILABLE", "本实例没有启用导出协调器", {});
    }
    return exports;
  };

  api.get("/exports", (c) => {
    const coordinator = requireExports();
    const body: ExportsResponse = {
      ...runtime.snapshotVersion(),
      topics: coordinator.allStatuses(),
    };
    return jsonResponse(c, body);
  });

  api.put("/exports/:topicId/target", limitBody, async (c) => {
    const coordinator = requireExports();
    const topicId = c.req.param("topicId");
    const body = await readExportTargetRequest(c);
    const status = await coordinator.setTarget(topicId, body.path);
    const response: ExportTargetResponse = { ...status, ok: true };
    return jsonResponse(c, response);
  });

  api.post("/exports/:topicId/retry", limitBody, async (c) => {
    const coordinator = requireExports();
    const topicId = c.req.param("topicId");
    // 重试既不是写内容也不是改配置：仍需本机客户端头，但不要求请求体。
    assertClientHeader(c);
    const status = await coordinator.retry(topicId);
    const response: ExportTargetResponse = { ...status, ok: true };
    return jsonResponse(c, response);
  });

  api.get("/changes/:requestId", async (c) => {
    const requestId = c.req.param("requestId");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
    ) {
      throw badRequest("requestId 必须是 UUID");
    }
    const status = await runtime.findChangeStatus(requestId);
    if (status === null) {
      throw new ServiceError(
        404,
        "UNKNOWN_CHANGE",
        "当前服务没有该 requestId 的记录（可能已重启或日志已清理）；请重读源文件，不要自动重放",
        { details: { requestId } },
      );
    }
    return jsonResponse(c, status);
  });

  app.route("/api", api);

  // 未匹配的 API 路径统一 JSON 404，不能落到前端 index.html。
  app.all("/api/*", (c) =>
    jsonResponse(c, errorBody(new ServiceError(404, "NOT_FOUND", "未知 API 路径", {})), 404),
  );

  // 静态页面：只服务 dist/web 下真实存在的文件，其余 GET 回落到 index.html。
  if (webRoot !== null) {
    const staticHandler = serveStatic({ root: webRoot });
    app.use("*", async (c, next) => {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
      if (c.req.path.startsWith("/api")) return next();
      let decoded: string;
      try {
        decoded = decodeURIComponent(c.req.path);
      } catch {
        return next();
      }
      if (decoded.includes("\u0000") || decoded.includes("\\")) return next();
      const relative = decoded.replace(/^\/+/, "");
      const absolute = path.resolve(webRoot, relative);
      const rootWithSep = webRoot.endsWith(path.sep) ? webRoot : webRoot + path.sep;
      if (absolute !== webRoot && !absolute.startsWith(rootWithSep)) return next();
      const stat = await fs.stat(absolute).catch(() => null);
      if (stat !== null && (stat.isDirectory() || stat.isFile())) {
        return staticHandler(c, next);
      }
      // 前端路由（如 /topic/xxx）由 index.html 接管；未知资源明确 404。
      if (path.extname(relative) !== "" && stat === null) {
        return jsonResponse(
          c,
          errorBody(new ServiceError(404, "NOT_FOUND", "静态资源不存在", {})),
          404,
        );
      }
      return next();
    });

    app.get("*", async (c) => {
      const indexHtml = path.join(webRoot, "index.html");
      const exists = await fs
        .stat(indexHtml)
        .then((stat) => stat.isFile())
        .catch(() => false);
      if (!exists) {
        return jsonResponse(
          c,
          errorBody(
            new ServiceError(404, "NOT_FOUND", "前端产物不存在（缺少 dist/web/index.html）", {}),
          ),
          404,
        );
      }
      const body = await fs.readFile(indexHtml);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    });
  } else {
    app.get("*", (c) =>
      jsonResponse(
        c,
        errorBody(new ServiceError(404, "NOT_FOUND", "未知路径", {})),
        404,
      ),
    );
  }

  app.notFound((c) =>
    jsonResponse(c, errorBody(new ServiceError(404, "NOT_FOUND", "未知路径", {})), 404),
  );

  return app;
}

export type { GraphNode };