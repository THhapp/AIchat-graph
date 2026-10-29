/**
 * HTTP / SSE transport for the SQLite-backed graph service.
 *
 * Only transport concerns live here: JSON bodies, compact errors, SSE fan-out,
 * static reader assets and a safe resources/ file route. All domain decisions
 * stay in store.ts / read.ts; the service process owns the single database
 * connection and publishes a descriptor for local clients.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve, type ServerType } from '@hono/node-server';
import { isErrnoCode, resolveWorkspaceRoot, sha256Bytes } from '../storage/index.js';
import { loadProgramInfo } from '../build-info.js';
import { agentEntryOf, resolveInstallation } from './installation.js';
import {
  derivedSummary,
  DomainError,
  findNode,
  findTopic,
  publicNode,
  publicTopic,
} from './model.js';
import { readView, DEFAULT_READ_BUDGET, MAX_READ_BUDGET, type ReadRequest } from './read.js';
import type { CreateExportManagerOptions, ExportManagerLike } from './export-contract.js';
import {
  acquireStartupPlaceholder,
  DEFAULT_HOST,
  DEFAULT_PORT,
  GraphRuntime,
  packageRoot,
  readRuntimePreferences,
  removeOwnDescriptor,
  writeRuntimePreferences,
  writeServiceDescriptor,
  type GraphEvent,
} from './runtime.js';
import type {
  AgentChangeRequest,
  AgentChangeResponse,
  AgentCheckResponse,
  Diagnostic,
  NodeDetailResponse,
  GraphResponse,
  ImportanceResponse,
  ReadViewKind,
  ReadViewResponse,
  RuntimeOpenWorkspaceResponse,
  RuntimeStopResponse,
  SearchField,
  SearchHit,
  SearchResponse,
  SnapshotEvent,
  TopicDetailResponse,
  TopicExportStatus,
  WorkspaceResponse,
} from './protocol.js';

/** 写请求体上限：一次多节点批量编辑足够，远小于滥用规模。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const READ_VIEWS: readonly ReadViewKind[] = ['overview', 'structure', 'content', 'resume'];

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonResponse(c: Context, body: unknown, status = 200): Response {
  return c.json(body as never, status as never);
}

interface ApiErrorShape {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function toApiError(error: unknown): ApiErrorShape {
  if (error instanceof DomainError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, code: 'BAD_REQUEST', message: '请求体不是合法 JSON' };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { status: 499, code: 'ABORTED', message: '请求已取消' };
  }
  return {
    status: 500,
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : '内部错误',
  };
}

function fail(c: Context, error: unknown): Response {
  const mapped = toApiError(error);
  return jsonResponse(
    c,
    {
      ok: false,
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details !== undefined ? { details: mapped.details } : {}),
      },
    },
    mapped.status,
  );
}

function badRequest(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError('BAD_REQUEST', message, 400, details ?? {});
}

function notFound(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError('NOT_FOUND', message, 404, details ?? {});
}

function assertNoPrototypeKeys(value: unknown, depth = 0): void {
  if (depth > 32) throw badRequest('请求体嵌套过深');
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrototypeKeys(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw badRequest('请求体包含不允许的原型键: ' + key);
    }
    assertNoPrototypeKeys(value[key], depth + 1);
  }
}

async function readRawBody(c: Context): Promise<string> {
  const contentLength = c.req.header('content-length');
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
      throw new DomainError('PAYLOAD_TOO_LARGE', '请求体超过上限', 413, {
        maxBytes: MAX_BODY_BYTES,
      });
    }
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw new DomainError('PAYLOAD_TOO_LARGE', '请求体超过上限', 413, {
      maxBytes: MAX_BODY_BYTES,
    });
  }
  return raw;
}

function parseJsonBody(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DomainError(
      'BAD_REQUEST',
      '请求体不是合法 JSON: ' + (error instanceof Error ? error.message : String(error)),
      400,
      {},
    );
  }
  assertNoPrototypeKeys(parsed);
  return parsed;
}

function queryInteger(
  c: Context,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new DomainError('INVALID_ARGUMENT', name + ' 必须是非负整数', 400, { field: name });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      name + ' 必须是 ' + String(min) + '-' + String(max) + ' 之间的整数',
      400,
      { field: name, min, max },
    );
  }
  return value;
}

function queryBoolean(c: Context, name: string): boolean | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new DomainError('INVALID_ARGUMENT', name + ' 只接受 true 或 false', 400, { field: name });
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError('BAD_REQUEST', field + ' 必须是非空字符串', 400, { field });
  }
  return value;
}

function optionalInteger(
  body: Record<string, unknown>,
  field: string,
  min: number,
): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new DomainError('BAD_REQUEST', field + ' 必须是不小于 ' + String(min) + ' 的整数', 400, {
      field,
    });
  }
  return value as number;
}

/* ------------------------------------------------------------------ *
 * SSE 事件
 * ------------------------------------------------------------------ */

function initialSnapshotEvent(runtime: GraphRuntime): SnapshotEvent {
  const snapshot = runtime.snapshot();
  return {
    event: 'snapshot',
    instanceId: runtime.instanceId,
    revision: snapshot.revision,
    changedTopicIds: [],
    changedNodeIds: [],
    stale: false,
  };
}

/* ------------------------------------------------------------------ *
 * 应用
 * ------------------------------------------------------------------ */

/**
 * 本机运行控制回调：由 startGraphService 注入，HTTP 层只负责校验身份与返回约定形状。
 * 缺失时两个控制端点统一 501，测试/嵌入场景也可注入 spy。
 */
export interface RuntimeControl {
  /** 请求停止；实现方负责在响应写出之后调用真正的 stop。 */
  requestStop(): void;
  /** 打开/切换工作区（native launcher --choose-workspace）；launcher 缺失抛 501。 */
  openWorkspace(): Promise<void> | void;
}

export interface GraphAppOptions {
  readonly runtime: GraphRuntime;
  readonly webRoot: string | null;
  readonly exports?: ExportManagerLike | null | undefined;
  readonly agentEntry?: { cliPath: string; skillPath: string } | undefined;
  readonly runtimeControl?: RuntimeControl | undefined;
}

export function createGraphApp(options: GraphAppOptions): Hono {
  const { runtime, webRoot } = options;
  const manager = options.exports ?? null;
  const app = new Hono();

  const requireExports = (): ExportManagerLike => {
    if (manager === null) {
      throw new DomainError(
        'EXPORT_UNAVAILABLE',
        '本实例没有启用导出协调器（缺少 src/next/export.js 或初始化失败）',
        503,
        {},
      );
    }
    return manager;
  };

  const requireRuntimeControl = (): RuntimeControl => {
    if (options.runtimeControl === undefined) {
      throw new DomainError(
        'RUNTIME_CONTROL_UNAVAILABLE',
        '本实例没有启用运行时控制（缺少启动上下文）',
        501,
        {},
      );
    }
    return options.runtimeControl;
  };

  /** 控制请求必须携带本实例身份；跨实例请求一律拒绝，不误停/误开别的服务。 */
  const assertRuntimeIdentity = (value: unknown): { workspaceId: string; instanceId: string } => {
    if (!isRecord(value)) throw badRequest('运行时控制请求体必须是 JSON 对象');
    const workspaceId = requireString(value, 'workspaceId');
    const instanceId = requireString(value, 'instanceId');
    if (workspaceId !== runtime.workspaceId) {
      throw new DomainError('RUNTIME_IDENTITY_MISMATCH', 'workspaceId 与服务实例不一致', 409, {
        expectedWorkspaceId: runtime.workspaceId,
        workspaceId,
      });
    }
    if (instanceId !== runtime.instanceId) {
      throw new DomainError(
        'RUNTIME_INSTANCE_MISMATCH',
        'instanceId 与服务实例不一致（服务可能已重启）；请重新读取 workspace 后重试',
        409,
        { expectedInstanceId: runtime.instanceId, instanceId },
      );
    }
    return { workspaceId, instanceId };
  };

  app.onError((error, c) => fail(c, error));

  const api = new Hono();
  api.onError((error, c) => fail(c, error));
  api.notFound((c) =>
    jsonResponse(c, { ok: false, error: { code: 'NOT_FOUND', message: '未知 API 路径' } }, 404),
  );

  api.get('/workspace', (c) => {
    const snapshot = runtime.snapshot();
    const body: WorkspaceResponse = {
      program: loadProgramInfo(),
      instanceId: runtime.instanceId,
      revision: snapshot.revision,
      workspaceId: snapshot.workspaceId,
      name: snapshot.name,
      rootPath: runtime.root,
      activeNode: snapshot.activeNode,
      stale: false,
      diagnostics: [],
      ...(options.agentEntry !== undefined ? { agentEntry: options.agentEntry } : {}),
    };
    return jsonResponse(c, body);
  });

  api.get('/graph', (c) => {
    const snapshot = runtime.snapshot();
    const lastChanges: Record<string, { at: string; nodeIds: string[] }> = {};
    for (const topic of snapshot.topics) {
      if (topic.lastChangeAt === null) continue;
      lastChanges[topic.id] = { at: topic.lastChangeAt, nodeIds: [...topic.lastChangeIds] };
    }
    const body: GraphResponse = {
      instanceId: runtime.instanceId,
      revision: snapshot.revision,
      workspaceId: snapshot.workspaceId,
      activeNode: snapshot.activeNode,
      stale: false,
      diagnostics: [],
      nodes: snapshot.nodes.map(publicNode),
      topics: snapshot.topics.map(publicTopic),
      ...(Object.keys(lastChanges).length > 0 ? { lastChanges } : {}),
    };
    return jsonResponse(c, body);
  });

  api.get('/nodes/:id', (c) => {
    const nodeId = c.req.param('id');
    const snapshot = runtime.snapshot();
    const node = findNode(snapshot, nodeId);
    const body: NodeDetailResponse = {
      instanceId: runtime.instanceId,
      revision: snapshot.revision,
      node: publicNode(node),
      body: node.body,
      resources: collectBodyResources(node.body),
    };
    return jsonResponse(c, body);
  });

  api.get('/topics/:id', (c) => {
    const topicId = c.req.param('id');
    const snapshot = runtime.snapshot();
    const topic = findTopic(snapshot, topicId);
    const topicNodes = snapshot.nodes.filter((node) => node.topicId === topicId);
    const nodes = topicNodes.map((node) => ({ ...publicNode(node), body: node.body }));
    const resources: Record<string, string> = {};
    for (const node of topicNodes) Object.assign(resources, collectBodyResources(node.body));
    const body: TopicDetailResponse = {
      instanceId: runtime.instanceId,
      revision: snapshot.revision,
      source: 'database',
      valid: true,
      topic: publicTopic(topic),
      nodes,
      diagnostics: [],
      resources,
    };
    return jsonResponse(c, body);
  });

  api.get('/search', (c) => {
    const snapshot = runtime.snapshot();
    const query = (c.req.query('q') ?? '').trim();
    if (query.length === 0) {
      throw new DomainError('INVALID_ARGUMENT', 'search 需要非空 q', 400, { field: 'q' });
    }
    const topicId = c.req.query('topicId') ?? c.req.query('topic');
    if (topicId !== undefined) findTopic(snapshot, topicId);
    const page = queryInteger(c, 'page', 0, 0, 1_000_000);
    const limit = queryInteger(c, 'limit', 20, 1, 100);
    const needle = query.toLocaleLowerCase();
    const hits: SearchHit[] = [];
    for (const node of snapshot.nodes) {
      if (topicId !== undefined && node.topicId !== topicId) continue;
      const candidates: Array<[SearchField, string]> = [
        ['title', node.title],
        ['summary', node.summary ?? derivedSummary(node.body)],
        ['body', node.body],
      ];
      for (const [field, text] of candidates) {
        const at = text.toLocaleLowerCase().indexOf(needle);
        if (at < 0) continue;
        hits.push({
          nodeId: node.id,
          topicId: node.topicId,
          title: node.title,
          snippet: snippetAround(text, at, query.length),
          field,
          revision: node.revision,
        });
        break;
      }
    }
    const start = page * limit;
    const pageHits = hits.slice(start, start + limit);
    const body: SearchResponse = {
      ok: true,
      command: 'search',
      source: 'database',
      workspaceId: snapshot.workspaceId,
      query,
      hits: pageHits,
      page,
      limit,
      totalHits: hits.length,
      hasMore: start + pageHits.length < hits.length,
      truncated: false,
      diagnostics: [],
    };
    return jsonResponse(c, body);
  });

  api.get('/agent/read', (c) => {
    const viewRaw = c.req.query('view');
    const view: ReadViewKind =
      viewRaw === undefined
        ? 'overview'
        : READ_VIEWS.includes(viewRaw as ReadViewKind)
          ? (viewRaw as ReadViewKind)
          : (() => {
              throw new DomainError('INVALID_ARGUMENT', 'view 只接受 overview／structure／content／resume', 400, {
                field: 'view',
                values: [...READ_VIEWS],
              });
            })();
    const topicId = c.req.query('topic') ?? c.req.query('topicId');
    const from = c.req.query('from');
    const nodeIds = c.req.queries('node') ?? c.req.queries('nodeId') ?? [];
    for (const nodeId of nodeIds) {
      if (nodeId.length === 0) {
        throw new DomainError('INVALID_ARGUMENT', 'node 必须是非空节点 ID', 400, { field: 'node' });
      }
    }
    // 兼容 CLI 的 resume 简写：view=resume 且只给一个 node 时，该 node 就是 anchor。
    let anchor = c.req.query('anchor');
    if (view === 'resume' && anchor === undefined && nodeIds.length === 1) {
      anchor = nodeIds[0];
    }
    const section = c.req.query('section') ?? c.req.query('from-heading');
    const sectionIndexRaw = c.req.query('section-index') ?? c.req.query('occurrence');
    let sectionIndex: number | undefined;
    if (sectionIndexRaw !== undefined) {
      if (!/^[0-9]+$/.test(sectionIndexRaw)) {
        throw new DomainError('INVALID_ARGUMENT', 'section-index 必须是非负整数', 400, {
          field: 'section-index',
        });
      }
      sectionIndex = Number(sectionIndexRaw);
    }
    const start = c.req.query('start');
    const length = c.req.query('length');
    const full = queryBoolean(c, 'full');
    const meta = queryBoolean(c, 'meta');
    const cursor = c.req.query('cursor');
    const budget = queryInteger(c, 'budget', DEFAULT_READ_BUDGET, 1, MAX_READ_BUDGET);
    const request: ReadRequest = {
      view,
      budget,
      ...(topicId !== undefined ? { topicId } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
      ...(nodeIds.length > 0 ? { nodeIds: [...nodeIds] } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(start !== undefined ? { start: parseNonNegative(start, 'start') } : {}),
      ...(length !== undefined ? { length: parsePositive(length, 'length') } : {}),
      ...(full !== undefined ? { full } : {}),
      ...(section !== undefined ? { section } : {}),
      ...(sectionIndex !== undefined ? { sectionIndex } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
    const body: ReadViewResponse = readView(runtime.snapshot(), request, 'online');
    return jsonResponse(c, body);
  });

  api.post('/agent/changes', async (c) => {
    const raw = await readRawBody(c);
    const parsed = parseJsonBody(raw);
    const request = asChangeRequest(parsed);
    const snapshot = runtime.snapshot();
    if (request.workspaceId !== snapshot.workspaceId) {
      throw new DomainError('WORKSPACE_MISMATCH', '请求的 workspaceId 与服务不一致', 409, {
        requestWorkspaceId: request.workspaceId,
        serviceWorkspaceId: snapshot.workspaceId,
      });
    }
    const response: AgentChangeResponse | AgentCheckResponse = runtime.commit(
      request,
      sha256Bytes(raw),
    );
    return jsonResponse(c, response);
  });

  api.get('/changes/:requestId', (c) => {
    const requestId = c.req.param('requestId');
    return jsonResponse(c, runtime.store.status(requestId));
  });

  api.post('/importance', async (c) => {
    const raw = await readRawBody(c);
    const parsed = parseJsonBody(raw);
    if (!isRecord(parsed)) throw badRequest('importance 请求体必须是 JSON 对象');
    const topicId = requireString(parsed, 'topicId');
    const nodeId = requireString(parsed, 'nodeId');
    if (typeof parsed['important'] !== 'boolean') {
      throw new DomainError('BAD_REQUEST', 'important 必须是 true 或 false', 400, {
        field: 'important',
      });
    }
    const important = parsed['important'];
    const revision = optionalInteger(parsed, 'revision', 1);
    const before = runtime.snapshot();
    const node = findNode(before, nodeId);
    if (node.topicId !== topicId) {
      throw badRequest('nodeId 不属于给定 topicId', { topicId, nodeId });
    }
    const request: AgentChangeRequest = {
      workspaceId: runtime.workspaceId,
      requestId: randomUUID(),
      action: {
        action: 'setImportance',
        nodeId,
        important,
        ...(revision !== undefined ? { revision } : {}),
      },
    };
    runtime.commit(request, sha256Bytes(raw));
    const after = runtime.snapshot();
    const body: ImportanceResponse = {
      instanceId: runtime.instanceId,
      revision: after.revision,
      ok: true,
      node: publicNode(findNode(after, nodeId)),
    };
    return jsonResponse(c, body);
  });


  /* --------------------------- 运行控制 ---------------------------- */

  api.post('/runtime/stop', async (c) => {
    const raw = await readRawBody(c);
    assertRuntimeIdentity(parseJsonBody(raw));
    const control = requireRuntimeControl();
    const response: RuntimeStopResponse = { ok: true, state: 'stopping' };
    // 先让 HTTP 响应出站；真正停止由 startGraphService 的 requestStop 调 handle.stop。
    setTimeout(() => {
      try {
        control.requestStop();
      } catch {
        // 停止请求失败不影响已经返回的响应。
      }
    }, 0);
    return jsonResponse(c, response);
  });

  api.post('/runtime/open-workspace', async (c) => {
    const raw = await readRawBody(c);
    assertRuntimeIdentity(parseJsonBody(raw));
    const control = requireRuntimeControl();
    await control.openWorkspace();
    const response: RuntimeOpenWorkspaceResponse = { ok: true, state: 'started' };
    return jsonResponse(c, response);
  });

  /* ------------------------------ 导出 ------------------------------ */

  api.get('/exports', (c) => {
    const exported = requireExports();
    return jsonResponse(c, {
      instanceId: runtime.instanceId,
      revision: runtime.snapshot().revision,
      topics: exported.statuses(),
    });
  });

  api.put('/exports/:topicId/target', async (c) => {
    const exported = requireExports();
    const raw = await readRawBody(c);
    const parsed = parseJsonBody(raw);
    if (!isRecord(parsed) || !('path' in parsed)) {
      throw badRequest('导出目标请求必须给出 path（字符串或 null）');
    }
    const target = parsed['path'];
    if (target !== null && (typeof target !== 'string' || target.length === 0)) {
      throw badRequest('path 必须是非空字符串或 null', { field: 'path' });
    }
    const status: TopicExportStatus = await exported.bindTarget(
      c.req.param('topicId'),
      target,
    );
    return jsonResponse(c, { ...status, ok: true });
  });

  api.post('/exports/:topicId/retry', async (c) => {
    const exported = requireExports();
    const status = await exported.retry(c.req.param('topicId'));
    return jsonResponse(c, { ...status, ok: true });
  });

  /* ------------------------------ SSE ------------------------------ */

  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      let finish = (): void => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const send = (event: GraphEvent): void => {
        if (closed) return;
        void stream
          .writeSSE({ event: event.event, data: JSON.stringify(event) })
          .catch(() => undefined);
      };
      const unsubscribe = runtime.subscribe(send);
      const heartbeat = setInterval(() => {
        if (closed) return;
        void stream.write(': ping\n\n').catch(() => undefined);
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref();

      send(initialSnapshotEvent(runtime));

      const shutdown = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        finish();
      };
      stream.onAbort(shutdown);
      await done;
      await stream.close().catch(() => undefined);
    }),
  );

  /* ------------------------------ 资源 ------------------------------ */

  api.get('/resources/*', async (c) => {
    const prefix = '/api/resources/';
    const rawPath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
    let relative: string;
    try {
      relative = decodeURIComponent(rawPath);
    } catch {
      throw notFound('资源路径不合法');
    }
    if (relative.length === 0 || relative.includes('\u0000') || relative.includes('\\')) {
      throw notFound('资源不存在');
    }
    const segments = relative.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw notFound('资源不存在');
    }
    const resourcesRoot = path.join(runtime.root, 'resources');
    const absolute = path.resolve(resourcesRoot, ...segments);
    const inside = path.relative(resourcesRoot, absolute);
    if (inside === '' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) {
      throw notFound('资源不存在');
    }
    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch {
      throw notFound('资源不存在');
    }
    let realRoot: string;
    try {
      realRoot = await fs.realpath(resourcesRoot);
    } catch {
      realRoot = resourcesRoot;
    }
    const realInside = path.relative(realRoot, real);
    if (realInside === '' || realInside.startsWith('..' + path.sep) || path.isAbsolute(realInside)) {
      throw notFound('资源不存在');
    }
    const stat = await fs.stat(real).catch(() => null);
    if (stat === null || !stat.isFile()) throw notFound('资源不存在');
    const data = await fs.readFile(real);
    return new Response(data, {
      status: 200,
      headers: {
        'content-type': contentTypeOf(real),
        'content-length': String(data.byteLength),
        'cache-control': 'no-cache',
      },
    });
  });

  api.get('/diagnostics', (c) =>
    jsonResponse(c, { ok: true, diagnostics: [] as Diagnostic[] }),
  );

  app.route('/api', api);
  app.all('/api/*', (c) =>
    jsonResponse(c, { ok: false, error: { code: 'NOT_FOUND', message: '未知 API 路径' } }, 404),
  );

  /* ------------------------------ 静态页面 ------------------------------ */

  if (webRoot !== null) {
    const staticHandler = serveStatic({ root: webRoot });
    app.use('*', async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
      if (c.req.path.startsWith('/api')) return next();
      let decoded: string;
      try {
        decoded = decodeURIComponent(c.req.path);
      } catch {
        return next();
      }
      if (decoded.includes('\u0000') || decoded.includes('\\')) return next();
      const relative = decoded.replace(/^\/+/, '');
      const absolute = path.resolve(webRoot, relative);
      const rootWithSep = webRoot.endsWith(path.sep) ? webRoot : webRoot + path.sep;
      if (absolute !== webRoot && !absolute.startsWith(rootWithSep)) return next();
      const stat = await fs.stat(absolute).catch(() => null);
      if (stat !== null && (stat.isDirectory() || stat.isFile())) {
        return staticHandler(c, next);
      }
      if (path.extname(relative) !== '' && stat === null) {
        return jsonResponse(
          c,
          { ok: false, error: { code: 'NOT_FOUND', message: '静态资源不存在' } },
          404,
        );
      }
      return next();
    });

    app.get('*', async (c) => {
      const indexHtml = path.join(webRoot, 'index.html');
      const exists = await fs
        .stat(indexHtml)
        .then((stat) => stat.isFile())
        .catch(() => false);
      if (!exists) {
        return jsonResponse(
          c,
          { ok: false, error: { code: 'NOT_FOUND', message: '前端产物不存在' } },
          404,
        );
      }
      const data = await fs.readFile(indexHtml);
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    });
  } else {
    app.get('*', (c) =>
      jsonResponse(c, { ok: false, error: { code: 'NOT_FOUND', message: '未知路径' } }, 404),
    );
  }

  app.notFound((c) =>
    jsonResponse(c, { ok: false, error: { code: 'NOT_FOUND', message: '未知路径' } }, 404),
  );

  return app;
}

/* ------------------------------------------------------------------ *
 * 请求解析辅助
 * ------------------------------------------------------------------ */

function parseNonNegative(raw: string, field: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new DomainError('INVALID_ARGUMENT', field + ' 必须是非负整数', 400, { field });
  }
  return Number(raw);
}

function parsePositive(raw: string, field: string): number {
  const value = parseNonNegative(raw, field);
  if (value < 1) {
    throw new DomainError('INVALID_ARGUMENT', field + ' 必须是正整数', 400, { field });
  }
  return value;
}

function asChangeRequest(value: unknown): AgentChangeRequest {
  if (!isRecord(value)) throw badRequest('AgentChangeRequest 必须是 JSON 对象');
  if (typeof value['workspaceId'] !== 'string' || value['workspaceId'].length === 0) {
    throw badRequest('workspaceId 必须是非空字符串', { field: 'workspaceId' });
  }
  if (typeof value['requestId'] !== 'string' || value['requestId'].length === 0) {
    throw badRequest('requestId 必须是非空字符串', { field: 'requestId' });
  }
  if (value['dryRun'] !== undefined && typeof value['dryRun'] !== 'boolean') {
    throw badRequest('dryRun 必须是布尔值', { field: 'dryRun' });
  }
  const action = value['action'];
  if (!isRecord(action) || typeof action['action'] !== 'string') {
    throw badRequest('action.action 必须是非空字符串', { field: 'action.action' });
  }
  return value as unknown as AgentChangeRequest;
}

/**
 * 扫描节点正文里的 resources/ 引用，返回 resource key -> 同源 URL。
 *
 * key 保持正文引用形态（如 resources/x.png），并容忍 ../、./ 前缀与百分号编码；
 * URL 去掉引用前缀后按路径段安全编码，交给 GET /api/resources/* 提供。
 */
function collectBodyResources(body: string): Record<string, string> {
  const resources: Record<string, string> = {};
  for (const match of body.matchAll(RESOURCE_REFERENCE)) {
    const literal = match[0]
      .replace(/\\/g, '/')
      .replace(/[.,;:!?，。；：！？、》】"'\u0060]+$/, '');
    const index = literal.indexOf('resources/');
    if (index < 0) continue;
    const rawTail = literal.slice(index + 'resources/'.length);
    const cleanTail = rawTail.split(/[?#]/)[0] ?? '';
    if (cleanTail.length === 0) continue;
    let decodedTail: string;
    try {
      decodedTail = decodeURIComponent(cleanTail);
    } catch {
      decodedTail = cleanTail;
    }
    const segments = decodedTail.split('/');
    if (
      segments.length === 0 ||
      segments.some(
        (segment) => segment.length === 0 || segment === '.' || segment === '..',
      )
    ) {
      continue;
    }
    const url =
      '/api/resources/' + segments.map((segment) => encodeURIComponent(segment)).join('/');
    resources['resources/' + decodedTail] = url;
    if (cleanTail !== decodedTail || literal !== 'resources/' + cleanTail) {
      resources['resources/' + cleanTail] = url;
    }
    // 原文兜底：正文里写 ../resources/x.png 时也允许按字面量查表。
    resources[literal] = url;
  }
  return resources;
}

const RESOURCE_REFERENCE =
  /(?<![\w/])\/?(?:\.{1,2}\/)*resources\/[^\s"'<>()[\]{}|\\\u0060]+/g;

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + length + 30);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return head + text.slice(start, end) + tail;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

function contentTypeOf(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/* ------------------------------------------------------------------ *
 * 启动与关闭
 * ------------------------------------------------------------------ */

export interface StartGraphServiceOptions {
  readonly root: string;
  /** 省略时使用稳定端口偏好（remembered → 4317 → 空闲端口）；显式给出时精确使用（0 = 系统分配）。 */
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly webRoot?: string | null | undefined;
  readonly offlineDirectory?: string | undefined;
  readonly appRoot?: string | undefined;
  /** native launcher 路径；省略时取 installation.launcherPath（dev 模式通常不存在 → 501）。 */
  readonly launcherPath?: string | undefined;
}

export interface GraphServiceHandle {
  readonly url: string;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly revision: number;
  /** 服务因任何原因关闭时 resolve；serve 进程据此正常退出，不留下 unsettled top-level await。 */
  readonly closed: Promise<void>;
  stop(): Promise<void>;
}

function defaultWebRoot(appRoot: string): string {
  return path.join(appRoot, 'dist', 'web');
}

function defaultOfflineDirectory(appRoot: string): string {
  return path.join(appRoot, 'dist', 'offline');
}

async function existsDirectory(target: string): Promise<boolean> {
  const stat = await fs.stat(target).catch(() => null);
  return stat !== null && stat.isDirectory();
}

async function resolveWebRoot(
  explicit: string | null | undefined,
  appRoot: string,
): Promise<string | null> {
  if (explicit === null) return null;
  if (explicit !== undefined) return explicit;
  const candidate = defaultWebRoot(appRoot);
  return (await existsDirectory(candidate)) ? candidate : null;
}

interface ExportFactory {
  createExportManager?: (options: CreateExportManagerOptions) => ExportManagerLike;
}

/**
 * 懒加载 E 的导出实现；文件未就绪或初始化失败时服务照常启动，导出接口明确 503。
 * 用变量 specifier 让 TS 不把尚未存在的 export.js 当编译期依赖。
 */
async function loadExportManager(
  options: CreateExportManagerOptions,
): Promise<ExportManagerLike | null> {
  const specifier = './export.js';
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const factory = loaded['createExportManager'];
  if (typeof factory !== 'function') return null;
  try {
    const manager = (factory as (value: CreateExportManagerOptions) => ExportManagerLike)(options);
    await manager.init();
    return manager;
  } catch {
    return null;
  }
}


/**
 * native launcher 入口：分发包的 exe 处理 --choose-workspace。
 * dev/源码模式通常没有 launcher → 501；启动失败明确 500，不静默吞掉。
 */
async function launchChooseWorkspace(launcherPath: string): Promise<void> {
  const stat = await fs.stat(launcherPath).catch(() => null);
  if (stat === null || !stat.isFile()) {
    throw new DomainError(
      'LAUNCHER_UNAVAILABLE',
      '没有可用的原生 launcher，无法打开其他工作区：' + launcherPath,
      501,
      { launcherPath },
    );
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcherPath, ['--choose-workspace'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', (error) => {
      reject(
        new DomainError(
          'LAUNCHER_FAILED',
          '无法启动 launcher：' + (error instanceof Error ? error.message : String(error)),
          500,
          { launcherPath },
        ),
      );
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
}

async function listen(
  app: Hono,
  host: string,
  port: number,
): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    let server: ServerType | null = null;
    const errorListener = (error: unknown): void => {
      try {
        server?.close(() => undefined);
      } catch {
        // 绑定失败时关闭尽力而为
      }
      reject(error);
    };
    server = serve(
      { fetch: app.fetch, hostname: host, port },
      (info) => {
        const emitter = server as unknown as {
          off?: (event: string, listener: (error: unknown) => void) => void;
        };
        emitter.off?.('error', errorListener);
        resolve({ server: server as ServerType, port: info.port });
      },
    );
    (server as unknown as {
      once: (event: string, listener: (error: unknown) => void) => void;
    }).once('error', errorListener);
  });
}

/**
 * 省略 port 时的稳定选择：remembered → 4317 → 系统分配。
 * 只有真正绑定成功才返回；端口被占用时继续尝试下一个候选。
 */
async function listenPreferred(
  app: Hono,
  host: string,
  root: string,
): Promise<{ server: ServerType; port: number }> {
  const preferences = await readRuntimePreferences(root);
  const candidates: number[] = [];
  if (preferences?.preferredPort !== null && preferences?.preferredPort !== undefined) {
    candidates.push(preferences.preferredPort);
  }
  if (!candidates.includes(DEFAULT_PORT)) candidates.push(DEFAULT_PORT);
  candidates.push(0);
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return await listen(app, host, candidate);
    } catch (error) {
      if (!isErrnoCode(error, 'EADDRINUSE')) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new DomainError('PORT_UNAVAILABLE', '没有可用端口', 503, {});
}

async function closeServer(server: ServerType | null): Promise<void> {
  if (server === null) return;
  const closable = server as unknown as {
    closeAllConnections?: () => void;
    close(callback: () => void): void;
  };
  try {
    closable.closeAllConnections?.();
  } catch {
    // 尽力关闭活动连接
  }
  await new Promise<void>((resolve) => {
    try {
      closable.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * 启动单工作区本地服务：占启动位 → 打开 DB → HTTP 监听（稳定端口或显式端口）
 * → 记录实际端口 → 写描述文件。任一步失败释放占位并清理自己获取的资源，
 * 不删除其他实例的描述文件。
 */
export async function startGraphService(
  options: StartGraphServiceOptions,
): Promise<GraphServiceHandle> {
  const explicitPort = options.port;
  if (
    explicitPort !== undefined &&
    (!Number.isInteger(explicitPort) || explicitPort < 0 || explicitPort > 65535)
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'port 必须是 0-65535 的整数', 400, {
      port: explicitPort,
    });
  }
  const host = options.host ?? DEFAULT_HOST;
  const rootReal = await resolveWorkspaceRoot(options.root);
  // 先占住同一数据库的启动位：Windows named pipe，其他平台临时 socket 文件。
  const placeholder = await acquireStartupPlaceholder(rootReal);

  let runtime: GraphRuntime | null = null;
  let manager: ExportManagerLike | null = null;
  let server: ServerType | null = null;
  let descriptorWritten = false;
  let handle: GraphServiceHandle | null = null;

  try {
    const activeRuntime = await GraphRuntime.open(rootReal);
    runtime = activeRuntime;
    const appRoot = options.appRoot ?? packageRoot() ?? process.cwd();
    const installation = resolveInstallation(appRoot);
    const webRoot = await resolveWebRoot(options.webRoot, appRoot);
    const offlineDirectory = options.offlineDirectory ?? defaultOfflineDirectory(appRoot);
    const launcherPath = options.launcherPath ?? installation.launcherPath;

    manager = await loadExportManager({
      root: activeRuntime.root,
      appRoot,
      offlineDirectory,
      workspaceId: activeRuntime.workspaceId,
      workspaceName: activeRuntime.snapshot().name,
      onStatus: (status) => activeRuntime.publishExport(status),
    });
    activeRuntime.attachExports(manager);

    const runtimeControl: RuntimeControl = {
      requestStop: () => {
        // 让 /api/runtime/stop 的响应先出站，再由 startGraphService 调 handle.stop。
        setTimeout(() => {
          void handle?.stop().catch(() => undefined);
        }, 50).unref?.();
      },
      openWorkspace: async () => {
        await launchChooseWorkspace(launcherPath);
      },
    };

    const app = createGraphApp({
      runtime: activeRuntime,
      webRoot,
      exports: manager,
      agentEntry: agentEntryOf(installation),
      runtimeControl,
    });

    const bound =
      explicitPort === undefined
        ? await listenPreferred(app, host, activeRuntime.root)
        : await listen(app, host, explicitPort);
    server = bound.server;
    // 只有真正绑定成功后才记录稳定端口；失败的候选与启动失败都不写。
    await writeRuntimePreferences(activeRuntime.root, bound.port);
    const url = 'http://' + formatHost(host) + ':' + String(bound.port);
    activeRuntime.setUrl(url);
    await writeServiceDescriptor(activeRuntime, url);
    descriptorWritten = true;

    const revision = activeRuntime.snapshot().revision;
    let stopped = false;
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const created: GraphServiceHandle = {
      url,
      workspaceId: activeRuntime.workspaceId,
      instanceId: activeRuntime.instanceId,
      revision,
      closed,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        activeRuntime.attachExports(null);
        try {
          manager?.close();
        } catch {
          // 关闭导出失败不阻断服务退出
        }
        try {
          await removeOwnDescriptor(activeRuntime.root, activeRuntime.instanceId);
        } catch {
          // 描述文件清理失败不阻断退出；下次启动会覆盖。
        }
        await closeServer(server);
        activeRuntime.close();
        await placeholder.release().catch(() => undefined);
        handle = null;
        resolveClosed();
      },
    };
    handle = created;
    return created;
  } catch (error) {
    runtime?.attachExports(null);
    try {
      manager?.close();
    } catch {
      // ignore
    }
    if (descriptorWritten && runtime !== null) {
      await removeOwnDescriptor(runtime.root, runtime.instanceId).catch(() => undefined);
    }
    await closeServer(server);
    runtime?.close();
    await placeholder.release().catch(() => undefined);
    throw error;
  }
}

