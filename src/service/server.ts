/**
 * 本机 HTTP／SSE 传输层。
 *
 * 安全边界：
 * - 只监听 127.0.0.1；Host 必须是当前 loopback 端口；
 * - Origin 若存在必须精确对应当前服务 origin，不返回宽泛 CORS 头；
 * - 写操作只接受 application/json 与固定头 X-AIchat-Client: cli；
 * - 限制请求体大小，拒绝原型键；路径只按 ID／受控相对路径解析。
 *
 * 传输层只做解析、版本核对与错误映射；业务语义全部委托协调器与候选模块。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import type {
  DiagnosticsResponse,
  SearchResponse,
  SnapshotEvent,
  TopicsResponse,
  ExportsResponse,
  ExportTargetResponse,
  GraphNode,
  ExportEvent,
  Diagnostic,
} from "../shared/protocol.js";
import { applyChanges, applyAgentChange, checkChanges } from "./changes.js";
import { parseAgentReadQuery, readAgentNode } from "./agent/read.js";
import { readAgentView } from "./agent/read-view.js";
import { setNodeImportance } from "./importance.js";
import type { ExportCoordinator as ExportCoordinatorType } from "./export.js";
import { ServiceError, serviceErrorFromUnknown } from "./errors.js";
import { graphTopics } from "./snapshot.js";
import { searchIndex, SearchQueryError } from "../index/index.js";
import type { WorkspaceRuntime } from "./workspace.js";
import {
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  MAX_BODY_BYTES,
  assertClientHeader,
  assertSnapshotVersion,
  badRequest,
  parseVersionQuery,
  readAgentRequest,
  readChangeRequest,
  readExportTargetRequest,
  readImportanceRequest,
} from "./http/requests.js";
import {
  diskTopicDetail,
  graphResponse,
  nodeDetail,
  snapshotTopicDetail,
  workspaceResponse,
} from "./http/responses.js";

export { CLIENT_HEADER, CLIENT_HEADER_VALUE, MAX_BODY_BYTES };
const SSE_HEARTBEAT_MS = 15_000;

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
      meta: c.req.query("meta"),
      section: c.req.query("section"),
      "section-index": c.req.query("section-index"),
    });
    const version = parseVersionQuery(c);
    assertSnapshotVersion(runtime, version);
    return jsonResponse(
      c,
      readAgentNode({ runtime, editRefs: runtime.editRefs, nodeId, query }),
    );
  });

  // 渐进读取：overview / structure / content；cursor 续读只另带 budget。
  api.get("/agent/read", (c) =>
    jsonResponse(c, readAgentView({ runtime, editRefs: runtime.editRefs, query: c.req.queries() })),
  );

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

  /* ------------------------------ 重要标记 ------------------------------ */

  // 只改一项元数据；仍经候选层与事务提交，成功后发布快照。
  api.post("/importance", limitBody, async (c) => {
    const body = await readImportanceRequest(c);
    return jsonResponse(c, await setNodeImportance(runtime, body));
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