/**
 * Agent 渐进读取（overview / structure / content）的服务层装配。
 *
 * 查询解析、快照取数与凭据签发在这里完成；分页、预算与指纹全部交给
 * index/read-view 的纯引擎。本模块不读磁盘、不写文件、不保存分页会话。
 * 续读只依赖不透明 cursor：token 已包含 view／scope／topic／meta，
 * 调用方只需再带 budget。
 */
import {
  DEFAULT_READ_BUDGET,
  MAX_READ_BUDGET,
  ReadViewError,
  buildReadView,
  decodeReadCursor,
} from "../../index/read-view.js";
import type {
  ReadContentOptions,
  ReadViewBuildInput,
  ReadViewNode,
} from "../../index/read-view.js";
import type {
  AgentEditRef,
  ReadOnlineInfo,
  ReadScope,
  ReadViewKind,
  ReadViewResponse,
} from "../../shared/protocol.js";
import type { ParsedNode } from "../../core/index.js";
import type { EditRefStore } from "../editref.js";
import { ServiceError, serviceErrorFromUnknown } from "../errors.js";
import { badRequest } from "../http/requests.js";
import type { SnapshotData, TopicSnapshot } from "../snapshot.js";
import { findTopic } from "../snapshot.js";
import type { WorkspaceRuntime } from "../workspace.js";
import { MAX_READ_LENGTH } from "./read.js";
import { findParsedNode } from "./shared.js";

const MAX_START = 100_000_000;

const VIEW_VALUES: readonly ReadViewKind[] = ["overview", "structure", "content"];

const ALLOWED_QUERY_KEYS = new Set([
  "view",
  "topic",
  "from",
  "node",
  "budget",
  "cursor",
  "start",
  "length",
  "full",
  "section",
  "section-index",
  "meta",
]);

/** cursor 只允许与 budget 同用；token 已包含范围与模式。 */
const CURSOR_CONFLICT_KEYS = [
  "view",
  "topic",
  "from",
  "node",
  "start",
  "length",
  "full",
  "section",
  "section-index",
  "meta",
] as const;

/** overview / structure 只接受范围与预算。 */
const NAVIGATION_FORBIDDEN_KEYS = [
  "node",
  "start",
  "length",
  "full",
  "section",
  "section-index",
  "meta",
] as const;

export interface ReadViewQuery {
  readonly budget: number;
  readonly cursor?: string;
  readonly view?: ReadViewKind;
  readonly topicId?: string;
  readonly from?: string;
  readonly nodeIds?: readonly string[];
  readonly content?: ReadContentOptions;
}

type RawQuery = Record<string, readonly string[] | undefined>;

function singleValue(raw: RawQuery, key: string): string | undefined {
  const values = raw[key];
  if (values === undefined || values.length === 0) return undefined;
  if (values.length > 1) {
    throw badRequest("参数 " + key + " 只能出现一次", { parameter: key });
  }
  return values[0];
}

function nonEmpty(raw: RawQuery, key: string): string | undefined {
  const value = singleValue(raw, key);
  if (value === undefined) return undefined;
  if (value.length === 0) {
    throw badRequest(key + " 不能为空", { parameter: key });
  }
  return value;
}

function parseInteger(
  raw: RawQuery,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = singleValue(raw, key);
  if (value === undefined) return undefined;
  const parsed = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ServiceError(
      400,
      "BAD_REQUEST",
      key + " 必须是 " + String(min) + "-" + String(max) + " 之间的整数",
      { details: { parameter: key, value, min, max } },
    );
  }
  return parsed;
}

function parseSectionIndex(raw: RawQuery): number | undefined {
  const value = singleValue(raw, "section-index");
  if (value === undefined) return undefined;
  const parsed = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ServiceError(400, "BAD_REQUEST", "section-index 必须是非负整数", {
      details: { parameter: "section-index", value },
    });
  }
  return parsed;
}

function parseBoolean(raw: RawQuery, key: string): boolean | undefined {
  const value = singleValue(raw, key);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ServiceError(400, "BAD_REQUEST", key + " 只接受 true 或 false", {
    details: { parameter: key, value },
  });
}

function parseSection(raw: RawQuery): string | undefined {
  const value = singleValue(raw, "section");
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ServiceError(
      400,
      "BAD_REQUEST",
      'section 去空白后不能为空；请给出正文里的标题，例如 section="小节一"',
      { details: { parameter: "section" } },
    );
  }
  return trimmed;
}

function parseContentOptions(raw: RawQuery): ReadContentOptions {
  const start = parseInteger(raw, "start", 0, MAX_START);
  const length = parseInteger(raw, "length", 1, MAX_READ_LENGTH);
  const full = parseBoolean(raw, "full");
  const meta = parseBoolean(raw, "meta");
  const section = parseSection(raw);
  const sectionIndex = parseSectionIndex(raw);

  if (sectionIndex !== undefined && section === undefined) {
    throw badRequest(
      "section-index 必须与 section 一起使用；单独给出无法定位章节",
      { parameter: "section-index" },
    );
  }

  if (meta === true) {
    const conflicts = ["start", "length", "full", "section", "section-index"].filter(
      (key) => raw[key] !== undefined,
    );
    if (conflicts.length > 0) {
      throw badRequest(
        "meta=true 不能与 " + conflicts.join("／") + " 同时使用；meta 读取不含正文，请去掉这些参数",
        { conflicts },
      );
    }
  }

  return {
    ...(start !== undefined ? { start } : {}),
    ...(length !== undefined ? { length } : {}),
    ...(full !== undefined ? { full } : {}),
    ...(section !== undefined ? { section } : {}),
    ...(sectionIndex !== undefined ? { sectionIndex } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

function presentKeys(raw: RawQuery, keys: readonly string[]): string[] {
  return keys.filter((key) => raw[key] !== undefined);
}

/** 严格解析 `/api/agent/read` 查询；cursor 模式下只允许 budget。 */
export function parseReadViewQuery(raw: RawQuery): ReadViewQuery {
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw badRequest("未知查询参数：" + key, { parameter: key });
    }
  }

  const budgetValue = parseInteger(raw, "budget", 1, MAX_READ_BUDGET) ?? DEFAULT_READ_BUDGET;
  const cursor = singleValue(raw, "cursor");

  if (cursor !== undefined) {
    const conflicts = presentKeys(raw, CURSOR_CONFLICT_KEYS);
    if (conflicts.length > 0) {
      throw badRequest(
        "cursor 不能与 " +
          conflicts.join("／") +
          " 同时使用；续读标记已包含范围与模式，只可另带 budget",
        { conflicts },
      );
    }
    return { budget: budgetValue, cursor };
  }

  const viewRaw = singleValue(raw, "view");
  if (viewRaw !== undefined && !VIEW_VALUES.includes(viewRaw as ReadViewKind)) {
    throw badRequest("view 必须是 overview、structure 或 content", {
      parameter: "view",
      value: viewRaw,
    });
  }

  const topicId = nonEmpty(raw, "topic");
  const from = nonEmpty(raw, "from");
  const nodeValues = raw["node"] ?? [];
  for (const nodeId of nodeValues) {
    if (nodeId.length === 0) {
      throw badRequest("node 必须是非空节点 ID", { parameter: "node" });
    }
  }

  // 无 cursor 时：有 node → content，否则 overview。
  const view: ReadViewKind =
    (viewRaw as ReadViewKind | undefined) ?? (nodeValues.length > 0 ? "content" : "overview");

  if (view === "content") {
    if (raw["from"] !== undefined) {
      throw badRequest("content 读取不接受 from；content 的范围由 node 参数给出", {
        parameter: "from",
      });
    }
    if (nodeValues.length === 0) {
      throw badRequest("content 读取至少需要一个 node 参数", { parameter: "node" });
    }
    return {
      budget: budgetValue,
      view,
      nodeIds: [...nodeValues],
      ...(topicId !== undefined ? { topicId } : {}),
      content: parseContentOptions(raw),
    };
  }

  const forbidden = presentKeys(raw, NAVIGATION_FORBIDDEN_KEYS);
  if (forbidden.length > 0) {
    throw badRequest(
      view + " 读取不接受参数：" + forbidden.join("／") + "；这些参数只用于 content",
      { parameters: forbidden },
    );
  }
  if (topicId === undefined) {
    throw badRequest(view + " 读取必须提供 topic 参数", { parameter: "topic" });
  }
  return {
    budget: budgetValue,
    view,
    topicId,
    ...(from !== undefined ? { from } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 快照取数与 ReadViewNode 投影
 * ------------------------------------------------------------------ */

function readViewNode(
  view: SnapshotData["graph"]["nodes"][number],
  parsed: ParsedNode,
  fileHash: string,
): ReadViewNode {
  return {
    id: view.id,
    topicId: view.topicId,
    title: view.title,
    summary: view.summary,
    number: view.number,
    state: view.state,
    flow: view.flow,
    from: view.from,
    ...(view.side !== undefined ? { side: view.side } : {}),
    ...(view.order !== undefined ? { order: view.order } : {}),
    ...(view.description !== undefined ? { description: view.description } : {}),
    important: view.important,
    sourcePath: parsed.sourcePath,
    fileHash,
    body: parsed.body,
  };
}

function topicNodes(snapshot: SnapshotData, topic: TopicSnapshot): ReadViewNode[] {
  const views = new Map(snapshot.graph.nodes.map((node) => [node.id, node] as const));
  const files = new Map(topic.files.map((file) => [file.path, file.fileHash] as const));
  const nodes: ReadViewNode[] = [];
  for (const parsed of topic.nodes) {
    const view = views.get(parsed.id);
    if (view === undefined) continue;
    nodes.push(readViewNode(view, parsed, files.get(parsed.sourcePath) ?? ""));
  }
  return nodes;
}

function topicRootIds(snapshot: SnapshotData, topicId: string): string[] {
  const views = new Map(snapshot.graph.nodes.map((node) => [node.id, node] as const));
  return snapshot.graph.rootIds.filter((id) => views.get(id)?.topicId === topicId);
}

function requireTopic(snapshot: SnapshotData, topicId: string): TopicSnapshot {
  const topic = findTopic(snapshot, topicId);
  if (topic === undefined) {
    throw new ServiceError(404, "TOPIC_NOT_FOUND", "当前有效快照中没有主题 " + topicId, {
      details: { topicId },
    });
  }
  return topic;
}

function requireFrom(snapshot: SnapshotData, topicId: string, from: string): void {
  const view = snapshot.graph.nodes.find((node) => node.id === from);
  if (view === undefined) {
    throw new ServiceError(404, "NODE_NOT_FOUND", "当前有效快照中没有节点 " + from, {
      details: { nodeId: from, topicId },
    });
  }
  if (view.topicId !== topicId) {
    throw new ServiceError(400, "INVALID_SCOPE", "节点 " + from + " 不属于主题 " + topicId, {
      details: { nodeId: from, topicId, actualTopicId: view.topicId },
    });
  }
}

/**
 * content 的请求节点：保持请求顺序、去重，并确保全部属于同一主题。
 * 显式给出 topic 时同时校验归属。
 */
function contentNodes(
  snapshot: SnapshotData,
  requested: readonly string[],
  expectedTopicId: string | undefined,
): { nodes: ReadViewNode[]; topic: TopicSnapshot } {
  const expectedTopic =
    expectedTopicId === undefined ? undefined : requireTopic(snapshot, expectedTopicId);

  const seen = new Set<string>();
  const nodes: ReadViewNode[] = [];
  const topicIds = new Set<string>();

  for (const nodeId of requested) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const found = findParsedNode(snapshot, nodeId);
    if (found === null) {
      throw new ServiceError(404, "NODE_NOT_FOUND", "当前有效快照中没有节点 " + nodeId, {
        details: { nodeId },
      });
    }
    if (expectedTopic !== undefined && found.topic.topicId !== expectedTopic.topicId) {
      throw new ServiceError(
        400,
        "INVALID_SCOPE",
        "节点 " + nodeId + " 不属于主题 " + expectedTopic.topicId,
        { details: { nodeId, topicId: expectedTopic.topicId, actualTopicId: found.topic.topicId } },
      );
    }
    topicIds.add(found.topic.topicId);
    if (topicIds.size > 1) {
      const first = nodes[0];
      throw new ServiceError(
        400,
        "INVALID_SCOPE",
        "节点集合跨主题（节点 " +
          (first?.id ?? nodeId) +
          " 与 " +
          nodeId +
          " 不属于同一主题）；读取范围必须属于同一主题",
        { details: { nodeIds: [...seen], topicIds: [...topicIds] } },
      );
    }
    nodes.push(readViewNode(found.view, found.node, found.fileHash));
  }

  const commonTopicId = expectedTopic?.topicId ?? nodes[0]?.topicId;
  if (commonTopicId === undefined) {
    throw badRequest("content 读取至少需要一个 node 参数", { parameter: "node" });
  }
  const topic = expectedTopic ?? requireTopic(snapshot, commonTopicId);
  return { nodes, topic };
}

function issueEditRefs(
  editRefs: EditRefStore,
  runtime: WorkspaceRuntime,
  workspaceId: string,
  nodes: readonly ReadViewNode[],
): Record<string, AgentEditRef> {
  const refs: Record<string, AgentEditRef> = {};
  for (const node of nodes) {
    if (refs[node.id] !== undefined) continue;
    refs[node.id] = editRefs.issue({
      workspaceId,
      topicId: node.topicId,
      nodeId: node.id,
      path: node.sourcePath ?? "",
      fileHash: node.fileHash ?? "",
      instanceId: runtime.instanceId,
      revision: runtime.current.revision,
    });
  }
  return refs;
}

function onlineEnvelope(runtime: WorkspaceRuntime): {
  source: "online";
  root: string;
  online: ReadOnlineInfo;
} {
  return {
    source: "online",
    root: runtime.rootReal,
    online: {
      available: true,
      instanceId: runtime.instanceId,
      revision: runtime.current.revision,
      workspaceId: runtime.workspaceId,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 输入装配
 * ------------------------------------------------------------------ */

function freshInput(
  runtime: WorkspaceRuntime,
  editRefs: EditRefStore,
  query: ReadViewQuery,
): ReadViewBuildInput {
  const snapshot = runtime.current.data;
  const envelope = onlineEnvelope(runtime);

  if (query.view === "content") {
    const resolved = contentNodes(snapshot, query.nodeIds ?? [], query.topicId);
    const refs = issueEditRefs(editRefs, runtime, snapshot.workspaceId, resolved.nodes);
    return {
      workspaceId: snapshot.workspaceId,
      mode: "online",
      topicId: resolved.topic.topicId,
      topicTitle: resolved.topic.title,
      rootIds: [],
      nodes: resolved.nodes,
      view: "content",
      scope: { kind: "nodes", nodeIds: resolved.nodes.map((node) => node.id) },
      budget: query.budget,
      ...(query.content !== undefined ? { content: query.content } : {}),
      editRefs: refs,
      envelope,
    };
  }

  const topicId = query.topicId ?? "";
  const topic = requireTopic(snapshot, topicId);
  if (query.from !== undefined) requireFrom(snapshot, topic.topicId, query.from);
  return {
    workspaceId: snapshot.workspaceId,
    mode: "online",
    topicId: topic.topicId,
    topicTitle: topic.title,
    rootIds: topicRootIds(snapshot, topic.topicId),
    nodes: topicNodes(snapshot, topic),
    view: query.view === "structure" ? "structure" : "overview",
    scope: query.from !== undefined ? { kind: "subtree", from: query.from } : { kind: "topic" },
    budget: query.budget,
    envelope,
  };
}

function staleRead(message: string, details: Record<string, unknown>): ServiceError {
  return new ServiceError(409, "STALE_READ", message, { details });
}

function staleCursor(
  message: string,
  state: { view: ReadViewKind; topicId: string | null },
  extra: Record<string, unknown>,
): ServiceError {
  return staleRead(message, { view: state.view, topicId: state.topicId, ...extra });
}

function invalidCursor(message: string, details: Record<string, unknown>): ReadViewError {
  return new ReadViewError("INVALID_CURSOR", message, details);
}

/**
 * cursor 续读：view／scope／topic／meta 全部取自 token，不要求调用方重复范围参数。
 * token 已失效（离线来源、节点/主题消失）时明确要求重新在线读取，不混合续读。
 */
function cursorInput(
  runtime: WorkspaceRuntime,
  editRefs: EditRefStore,
  cursor: string,
  budget: number,
): ReadViewBuildInput {
  const state = decodeReadCursor(cursor);
  if (state.mode !== "online") {
    throw staleRead("续读标记来自离线读取；请重新在线读取该范围。", {
      reason: "cursor mode is " + state.mode,
      view: state.view,
      topicId: state.topicId,
    });
  }

  const snapshot = runtime.current.data;
  const envelope = onlineEnvelope(runtime);

  if (state.view === "content") {
    if (state.scope.kind !== "nodes") {
      throw invalidCursor("content 的续读标记范围不合法", { scope: state.scope });
    }
    if (state.topicId === null) {
      throw staleCursor("续读标记缺少主题；请从头重新读取该范围。", state, {});
    }
    const topic = findTopic(snapshot, state.topicId);
    if (topic === undefined) {
      throw staleCursor(
        "续读标记中的主题已不存在；请从头重新读取该范围。",
        state,
        { reason: "topic missing" },
      );
    }
    const nodes: ReadViewNode[] = [];
    for (const nodeId of state.scope.nodeIds) {
      const found = findParsedNode(snapshot, nodeId);
      if (found === null || found.topic.topicId !== state.topicId) {
        throw staleCursor(
          "续读标记中的节点已不存在或主题已变化；请从头重新读取该范围。",
          state,
          { nodeId, reason: found === null ? "node missing" : "topic changed" },
        );
      }
      nodes.push(readViewNode(found.view, found.node, found.fileHash));
    }
    const refs = issueEditRefs(editRefs, runtime, snapshot.workspaceId, nodes);
    return {
      workspaceId: snapshot.workspaceId,
      mode: "online",
      topicId: state.topicId,
      topicTitle: topic.title,
      rootIds: [],
      nodes,
      view: "content",
      scope: { kind: "nodes", nodeIds: nodes.map((node) => node.id) },
      budget,
      cursor,
      ...(state.meta === true ? { content: { meta: true } } : {}),
      editRefs: refs,
      envelope,
    };
  }

  if (state.scope.kind === "nodes") {
    throw invalidCursor(state.view + " 的续读标记范围不合法", { scope: state.scope });
  }
  if (state.topicId === null) {
    throw staleCursor("续读标记缺少主题；请从头重新读取该范围。", state, {});
  }
  const topic = findTopic(snapshot, state.topicId);
  if (topic === undefined) {
    throw staleCursor(
      "续读标记中的主题已不存在；请从头重新读取该范围。",
      state,
      { reason: "topic missing" },
    );
  }
  const nodes = topicNodes(snapshot, topic);
  const cursorScope = state.scope;
  if (
    cursorScope.kind === "subtree" &&
    !nodes.some((node) => node.id === cursorScope.from)
  ) {
    throw staleCursor(
      "续读标记中的起点节点已不存在；请从头重新读取该范围。",
      state,
      { from: cursorScope.from, reason: "node missing" },
    );
  }
  const scope: ReadScope = cursorScope;
  return {
    workspaceId: snapshot.workspaceId,
    mode: "online",
    topicId: topic.topicId,
    topicTitle: topic.title,
    rootIds: topicRootIds(snapshot, topic.topicId),
    nodes,
    view: state.view,
    scope,
    budget,
    cursor,
    envelope,
  };
}

/* ------------------------------------------------------------------ *
 * 错误映射与入口
 * ------------------------------------------------------------------ */

/** ReadViewError 映射为统一 ServiceError，details 原样保留。 */
export function serviceErrorFromReadView(error: ReadViewError): ServiceError {
  const details = error.details;
  const mapping: Record<string, { status: number; code: string }> = {
    INVALID_CURSOR: { status: 400, code: "INVALID_CURSOR" },
    STALE_READ: { status: 409, code: "STALE_READ" },
    BUDGET_TOO_SMALL: { status: 400, code: "BUDGET_TOO_SMALL" },
    BUDGET_EXCEEDED: { status: 400, code: "BUDGET_EXCEEDED" },
    INVALID_SCOPE: { status: 400, code: "INVALID_SCOPE" },
    INVALID_SECTION: { status: 400, code: "INVALID_SECTION" },
  };
  const target = mapping[error.code];
  if (target === undefined) return serviceErrorFromUnknown(error);
  return new ServiceError(target.status, target.code, error.message, { details, cause: error });
}

export interface AgentReadViewContext {
  readonly runtime: WorkspaceRuntime;
  readonly editRefs: EditRefStore;
  /** Hono `c.req.queries()` 的原始多值查询。 */
  readonly query: RawQuery;
}

/** GET /api/agent/read 的实现；所有错误都转换为传输层 ServiceError。 */
export function readAgentView(context: AgentReadViewContext): ReadViewResponse {
  try {
    const query = parseReadViewQuery(context.query);
    const input =
      query.cursor === undefined
        ? freshInput(context.runtime, context.editRefs, query)
        : cursorInput(context.runtime, context.editRefs, query.cursor, query.budget);
    return buildReadView(input);
  } catch (error) {
    if (error instanceof ReadViewError) throw serviceErrorFromReadView(error);
    throw error;
  }
}
