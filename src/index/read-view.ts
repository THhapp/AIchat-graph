/**
 * 纯读取视图引擎：overview / structure / content。
 *
 * 本模块不读文件、不调用服务、不调用模型，也不保存历史快照或分页会话。
 * 节点、正文、哈希和在线凭据全部由调用方传入；相同输入得到相同输出。
 *
 * 预算覆盖最终 ReadViewResponse 的 JSON.stringify(...).length（UTF-16 code units），
 * 包括 envelope、items、boundaries、page.next、budget.used 与 fingerprint。
 */
import { createHash } from "node:crypto";
import { DEFAULT_READ_LENGTH, locateSection, sliceBody } from "../core/index.js";
import type {
  AgentEditRef,
  AgentReadRange,
  BranchSide,
  GraphNode,
  NodeFlow,
  NodeState,
  ReadBoundary,
  ReadContentItem,
  ReadOnlineInfo,
  ReadOverviewItem,
  ReadScope,
  ReadScopeInfo,
  ReadStructureItem,
  ReadViewItem,
  ReadViewKind,
  ReadViewResponse,
} from "../shared/protocol.js";

export interface ReadViewNode {
  id: string;
  topicId: string;
  title: string;
  summary: string;
  number: string;
  state: NodeState;
  flow: NodeFlow;
  from: string | null;
  side?: BranchSide;
  order?: number;
  description?: string;
  important: boolean;
  sourcePath?: string;
  fileHash?: string;
  body?: string;
}

export interface ReadContentOptions {
  start?: number;
  length?: number;
  full?: boolean;
  section?: string;
  sectionIndex?: number;
  meta?: boolean;
}

export interface ReadViewBuildInput {
  workspaceId: string;
  mode: "online" | "disk";
  topicId: string | null;
  topicTitle: string | null;
  /** 主题根；overview/structure 需要，content 可为空。 */
  rootIds: readonly string[];
  /** overview/structure 传主题全部节点；content 传请求的节点。 */
  nodes: readonly ReadViewNode[];
  view: ReadViewKind;
  scope: ReadScope;
  /** 调用方已带默认值；必须 1..1_000_000。 */
  budget: number;
  cursor?: string;
  content?: ReadContentOptions;
  /** 在线 content 的凭据；离线为空/缺省。 */
  editRefs?: Readonly<Record<string, AgentEditRef | null>>;
  /** 由服务/CLI 提供，计入预算。 */
  envelope: { source: "online" | "disk"; root: string; online: ReadOnlineInfo };
}

export const DEFAULT_READ_BUDGET = 12000;
export const MAX_READ_BUDGET = 1_000_000;

const CURSOR_VERSION = 1;
const AUTO_CONTENT_LENGTH = DEFAULT_READ_LENGTH;
const OVERVIEW_NOTE = "分支内部未展开，用 branch 的 read 入口继续读取结构。";
const CONTENT_AUTO_NOTE = "多卡正文按预算续读；page.next 只继续正文，范围不变。";

export type ReadViewErrorCode =
  | "INVALID_SCOPE"
  | "INVALID_CURSOR"
  | "STALE_READ"
  | "BUDGET_TOO_SMALL"
  | "BUDGET_EXCEEDED"
  | "INVALID_SECTION";

export class ReadViewError extends Error {
  readonly code: ReadViewErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ReadViewErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ReadViewError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** 续读标记的内部状态；Agent 文档不暴露该形状。 */
export interface ReadCursorState {
  version: 1;
  mode: "online" | "disk";
  workspaceId: string;
  topicId: string | null;
  view: ReadViewKind;
  scope: ReadScope;
  fingerprint: string;
  /** overview / structure：下一条记录的偏移。 */
  offset?: number;
  /** content：下一条正文卡片的节点序号。 */
  index?: number;
  /** content：该节点的正文起点。 */
  start?: number;
  /** content：本页为 meta 读取；续读时调用方应据此保持 content.meta。 */
  meta?: true;
}

interface ResolvedScope {
  topicId: string | null;
  scope: ReadScope;
  info: ReadScopeInfo;
  nodes: ReadViewNode[];
}

interface ViewContext {
  input: ReadViewBuildInput;
  topicId: string | null;
  scope: ReadScope;
  scopeInfo: ReadScopeInfo;
  fingerprint: string;
  boundaries?: ReadBoundary[];
}

interface ContentPosition {
  index: number;
  start: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyOf(node: ReadViewNode): string {
  return node.body ?? "";
}

function joinNotes(current: string | undefined, extra: string): string {
  return current === undefined || current.length === 0 ? extra : current + " " + extra;
}

/* ------------------------------------------------------------------ *
 * 续读标记
 * ------------------------------------------------------------------ */

function cursorError(message: string, details?: Record<string, unknown>): ReadViewError {
  return new ReadViewError("INVALID_CURSOR", message, details);
}

function readTokenScope(value: unknown): ReadScope {
  if (!isRecord(value)) throw cursorError("续读标记缺少有效的 scope");
  const kind = value["kind"];
  if (kind === "topic") return { kind: "topic" };
  if (kind === "subtree") {
    const from = value["from"];
    if (typeof from !== "string" || from.length === 0) {
      throw cursorError("续读标记的 subtree.from 不合法");
    }
    return { kind: "subtree", from };
  }
  if (kind === "nodes") {
    const nodeIds = value["nodeIds"];
    if (!Array.isArray(nodeIds) || nodeIds.some((id) => typeof id !== "string")) {
      throw cursorError("续读标记的 nodes.nodeIds 不合法");
    }
    return { kind: "nodes", nodeIds: [...nodeIds] };
  }
  throw cursorError("续读标记的 scope.kind 不合法");
}

function readOptionalPosition(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw cursorError("续读标记的 " + field + " 必须是非负整数");
  }
  return value;
}

/** 解析不透明续读标记；字段不全或格式错误一律 INVALID_CURSOR。 */
export function decodeReadCursor(token: string): ReadCursorState {
  if (typeof token !== "string" || token.length === 0) {
    throw cursorError("续读标记为空");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
  } catch {
    throw cursorError("续读标记不是有效的 base64url JSON");
  }
  if (!isRecord(value)) throw cursorError("续读标记必须是 JSON 对象");
  if (value["version"] !== CURSOR_VERSION) {
    throw cursorError("续读标记版本不受支持", { version: value["version"] });
  }
  const mode = value["mode"];
  if (mode !== "online" && mode !== "disk") {
    throw cursorError("续读标记的 mode 不合法");
  }
  const workspaceId = value["workspaceId"];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw cursorError("续读标记缺少 workspaceId");
  }
  const topicId = value["topicId"];
  if (topicId !== null && typeof topicId !== "string") {
    throw cursorError("续读标记的 topicId 不合法");
  }
  const view = value["view"];
  if (view !== "overview" && view !== "structure" && view !== "content") {
    throw cursorError("续读标记的 view 不合法");
  }
  const fingerprint = value["fingerprint"];
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw cursorError("续读标记缺少 fingerprint");
  }
  const offset = readOptionalPosition(value["offset"], "offset");
  const index = readOptionalPosition(value["index"], "index");
  const start = readOptionalPosition(value["start"], "start");
  const meta = value["meta"];
  if (meta !== undefined && meta !== true) {
    throw cursorError("续读标记的 meta 不合法");
  }
  return {
    version: CURSOR_VERSION,
    mode,
    workspaceId,
    topicId,
    view,
    scope: readTokenScope(value["scope"]),
    fingerprint,
    ...(offset !== undefined ? { offset } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(meta === true ? { meta: true as const } : {}),
  };
}

function encodeReadCursor(state: ReadCursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function sameScope(left: ReadScope, right: ReadScope): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "topic") return true;
  if (left.kind === "subtree") {
    return right.kind === "subtree" && left.from === right.from;
  }
  if (right.kind !== "nodes") return false;
  if (left.nodeIds.length !== right.nodeIds.length) return false;
  return left.nodeIds.every((id, index) => right.nodeIds[index] === id);
}

function makeCursor(ctx: ViewContext, position: ContentPosition | { offset: number }): ReadCursorState {
  const offset = "offset" in position ? position.offset : undefined;
  const index = "index" in position ? position.index : undefined;
  const start = "start" in position ? position.start : undefined;
  return {
    version: CURSOR_VERSION,
    mode: ctx.input.mode,
    workspaceId: ctx.input.workspaceId,
    topicId: ctx.topicId,
    view: ctx.input.view,
    scope: ctx.scope,
    fingerprint: ctx.fingerprint,
    ...(offset !== undefined ? { offset } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(ctx.input.content?.meta === true ? { meta: true as const } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 范围解析（确定性）
 * ------------------------------------------------------------------ */

function invalidScope(message: string, details?: Record<string, unknown>): ReadViewError {
  return new ReadViewError("INVALID_SCOPE", message, details);
}

function resolveScope(input: ReadViewBuildInput): ResolvedScope {
  if (input.view === "content" && input.scope.kind !== "nodes") {
    throw invalidScope("content 只接受 nodes 范围", { view: input.view, scope: input.scope });
  }
  if (input.view !== "content" && input.scope.kind === "nodes") {
    throw invalidScope("overview/structure 不使用 nodes 范围", { view: input.view, scope: input.scope });
  }

  // 输入顺序即稳定顺序；重复 id 只保留第一次出现。
  const all: ReadViewNode[] = [];
  const byId = new Map<string, ReadViewNode>();
  for (const node of input.nodes) {
    if (byId.has(node.id)) continue;
    byId.set(node.id, node);
    all.push(node);
  }

  let topicId = input.topicId;
  if (topicId === null) {
    const firstTopic = all[0]?.topicId ?? null;
    if (all.some((node) => node.topicId !== firstTopic)) {
      throw invalidScope("节点集合跨主题，读取范围必须属于同一主题");
    }
    topicId = firstTopic;
  } else if (all.some((node) => node.topicId !== topicId)) {
    throw invalidScope("节点集合跨主题，读取范围必须属于同一主题", {
      topicId,
      otherTopicIds: [...new Set(all.filter((node) => node.topicId !== topicId).map((node) => node.topicId))],
    });
  }

  let nodes: ReadViewNode[];
  let scope: ReadScope;
  let fromId: string | undefined;
  let note: string | undefined;

  if (input.scope.kind === "topic") {
    nodes = all;
    scope = { kind: "topic" };
  } else if (input.scope.kind === "subtree") {
    const from = input.scope.from;
    const start = byId.get(from);
    if (start === undefined) {
      throw invalidScope("subtree 起点不存在或不属于该主题", { from, topicId });
    }
    const childrenOf = new Map<string, ReadViewNode[]>();
    for (const node of all) {
      if (node.from === null) continue;
      const bucket = childrenOf.get(node.from);
      if (bucket) bucket.push(node);
      else childrenOf.set(node.from, [node]);
    }
    // 沿真实 from 关系向下（next 与 branch 都算后代），最后按输入顺序输出。
    const included = new Set<string>();
    const stack: ReadViewNode[] = [start];
    while (stack.length > 0) {
      const current = stack.pop() as ReadViewNode;
      if (included.has(current.id)) continue;
      included.add(current.id);
      for (const child of childrenOf.get(current.id) ?? []) stack.push(child);
    }
    nodes = all.filter((node) => included.has(node.id));
    scope = { kind: "subtree", from };
    fromId = from;
    note =
      start.flow === "root"
        ? "范围从根 " + from + " 开始，包含自身与其全部同主题后代。"
        : "范围从 " + from + " 开始，包含其后的主线延续与所有分支后代；不含起点之前的节点。";
  } else {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const id of input.scope.nodeIds) {
      if (typeof id !== "string" || id.length === 0) {
        throw invalidScope("nodes 范围包含非法 nodeId");
      }
      if (seen.has(id)) continue;
      seen.add(id);
      if (!byId.has(id)) {
        throw invalidScope("nodes 范围包含不存在或不属于该主题的节点", { nodeId: id, topicId });
      }
      ids.push(id);
    }
    if (ids.length === 0) {
      throw invalidScope("nodes 范围至少需要一个节点", { topicId });
    }
    nodes = ids.map((id) => byId.get(id) as ReadViewNode);
    scope = { kind: "nodes", nodeIds: ids };
    note = "按请求顺序读取 " + String(ids.length) + " 个节点。";
  }

  const info: ReadScopeInfo = {
    kind: scope.kind,
    nodeCount: nodes.length,
    ...(fromId !== undefined ? { from: fromId } : {}),
    ...(note !== undefined ? { note } : {}),
  };

  return { topicId, scope, info, nodes };
}

/* ------------------------------------------------------------------ *
 * 指纹
 * ------------------------------------------------------------------ */

function boundaryFingerprintOf(
  input: ReadViewBuildInput,
  resolved: ResolvedScope,
): unknown[] | undefined {
  if (input.view !== "structure" || resolved.scope.kind !== "subtree") return undefined;
  const inScope = new Set(resolved.nodes.map((node) => node.id));
  const byId = new Map<string, ReadViewNode>();
  for (const node of input.nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }
  // 边界外部父节点不在范围节点里，但它会出现在每一页的 boundaries.external，
  // 因此它本身以及边界连接的可见字段都必须进入指纹。
  const facts: unknown[] = [];
  for (const node of resolved.nodes) {
    if (node.from === null || inScope.has(node.from)) continue;
    const parent = byId.get(node.from);
    facts.push([
      node.from,
      parent?.title ?? "",
      parent?.topicId ?? resolved.topicId,
      node.flow,
      node.description ?? null,
      node.id,
    ]);
  }
  return facts;
}

function fingerprintOf(input: ReadViewBuildInput, resolved: ResolvedScope): string {
  const boundaries = boundaryFingerprintOf(input, resolved);
  const payload = {
    workspaceId: input.workspaceId,
    topicId: resolved.topicId,
    view: input.view,
    mode: input.mode,
    scope: resolved.scope,
    nodes: resolved.nodes.map((node) => {
      const metadata: unknown[] = [
        node.id,
        node.title,
        node.summary,
        node.number,
        node.state,
        node.flow,
        node.from,
        node.side ?? null,
        node.order ?? null,
        node.description ?? null,
        node.important,
      ];
      if (input.view === "content") {
        metadata.push(node.fileHash ?? null, bodyOf(node).length);
      }
      return metadata;
    }),
    ...(boundaries !== undefined ? { boundaries } : {}),
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

/* ------------------------------------------------------------------ *
 * 记录构造
 * ------------------------------------------------------------------ */

function graphNodeOf(node: ReadViewNode): GraphNode {
  return {
    id: node.id,
    topicId: node.topicId,
    title: node.title,
    summary: node.summary,
    number: node.number,
    from: node.from,
    flow: node.flow,
    state: node.state,
    important: node.important,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    ...(node.sourcePath !== undefined ? { sourcePath: node.sourcePath } : {}),
  };
}

function compareBranches(left: ReadViewNode, right: ReadViewNode): number {
  if (left.order !== undefined && right.order !== undefined) return left.order - right.order;
  if (left.order !== undefined) return -1;
  if (right.order !== undefined) return 1;
  return 0;
}

function overviewItems(input: ReadViewBuildInput, resolved: ResolvedScope): ReadOverviewItem[] {
  const byId = new Map(resolved.nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, ReadViewNode[]>();
  for (const node of resolved.nodes) {
    if (node.from === null) continue;
    const bucket = childrenOf.get(node.from);
    if (bucket) bucket.push(node);
    else childrenOf.set(node.from, [node]);
  }

  let startId: string;
  if (input.scope.kind === "subtree") {
    startId = input.scope.from;
  } else {
    const rootId = input.rootIds.find((id) => byId.has(id));
    if (rootId === undefined) {
      throw invalidScope("overview 需要该主题的 root 节点", {
        topicId: resolved.topicId,
        rootIds: input.rootIds,
      });
    }
    startId = rootId;
  }
  if (!byId.has(startId)) {
    throw invalidScope("overview 起点不存在于该范围", { from: startId, topicId: resolved.topicId });
  }

  const branchesOf = (id: string): ReadViewNode[] =>
    (childrenOf.get(id) ?? []).filter((node) => node.flow === "branch").slice().sort(compareBranches);
  const nextOf = (id: string): ReadViewNode | undefined =>
    (childrenOf.get(id) ?? []).find((node) => node.flow === "next");

  const subtreeCounts = new Map<string, number>();
  const subtreeNodeCount = (id: string): number => {
    const cached = subtreeCounts.get(id);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const child of childrenOf.get(current) ?? []) stack.push(child.id);
    }
    subtreeCounts.set(id, seen.size);
    return seen.size;
  };

  const records: ReadOverviewItem[] = [];
  const mainlineSeen = new Set<string>();
  let currentId: string | undefined = startId;
  while (currentId !== undefined) {
    if (mainlineSeen.has(currentId)) break;
    mainlineSeen.add(currentId);
    const node = byId.get(currentId);
    if (node === undefined) break;
    records.push({
      role: "mainline",
      id: node.id,
      title: node.title,
      summary: node.summary,
      number: node.number,
      state: node.state,
      flow: node.flow,
      from: node.from,
      ...(node.description !== undefined ? { description: node.description } : {}),
      important: node.important,
    });
    for (const branch of branchesOf(currentId)) {
      records.push({
        role: "branch",
        id: branch.id,
        title: branch.title,
        summary: branch.summary,
        number: branch.number,
        state: branch.state,
        flow: branch.flow,
        from: branch.from,
        ...(branch.description !== undefined ? { description: branch.description } : {}),
        important: branch.important,
        subtreeNodeCount: subtreeNodeCount(branch.id),
        read: { view: "structure", from: branch.id },
      });
    }
    currentId = nextOf(currentId)?.id;
  }
  return records;
}

function structureItems(resolved: ResolvedScope): ReadStructureItem[] {
  return resolved.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    summary: node.summary,
    number: node.number,
    state: node.state,
    flow: node.flow,
    from: node.from,
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    important: node.important,
  }));
}

function boundariesFor(
  input: ReadViewBuildInput,
  resolved: ResolvedScope,
): ReadBoundary[] {
  if (input.scope.kind !== "subtree") return [];
  const inScope = new Set(resolved.nodes.map((node) => node.id));
  const byId = new Map<string, ReadViewNode>();
  for (const node of input.nodes) {
    if (!byId.has(node.id)) byId.set(node.id, node);
  }
  const boundaries: ReadBoundary[] = [];
  for (const node of resolved.nodes) {
    if (node.from === null || inScope.has(node.from)) continue;
    const parent = byId.get(node.from);
    const external: ReadBoundary["external"] = {
      id: node.from,
      title: parent?.title ?? "",
      ...(parent?.topicId !== undefined
        ? { topicId: parent.topicId }
        : resolved.topicId !== null
          ? { topicId: resolved.topicId }
          : {}),
    };
    boundaries.push({
      from: node.from,
      to: node.id,
      flow: node.flow === "branch" ? "branch" : "next",
      ...(node.description !== undefined ? { description: node.description } : {}),
      external,
    });
  }
  return boundaries;
}

/* ------------------------------------------------------------------ *
 * 预算与响应
 * ------------------------------------------------------------------ */

function validateBudget(budget: number): void {
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_READ_BUDGET) {
    throw new ReadViewError(
      "BUDGET_TOO_SMALL",
      "budget 必须是 1-" + String(MAX_READ_BUDGET) + " 之间的整数，收到 " + String(budget),
      { limit: budget, min: 1, max: MAX_READ_BUDGET },
    );
  }
}

function responseOf(
  ctx: ViewContext,
  items: ReadViewItem[],
  hasMore: boolean,
  next: string | undefined,
  mode: "auto" | "explicit",
  used: number,
): ReadViewResponse {
  return {
    ok: true,
    command: "read",
    source: ctx.input.envelope.source,
    root: ctx.input.envelope.root,
    online: ctx.input.envelope.online,
    workspaceId: ctx.input.workspaceId,
    view: ctx.input.view,
    topicId: ctx.topicId,
    topicTitle: ctx.input.topicTitle,
    scope: ctx.scopeInfo,
    items,
    ...(ctx.boundaries !== undefined && ctx.boundaries.length > 0
      ? { boundaries: ctx.boundaries }
      : {}),
    page: {
      hasMore,
      ...(next !== undefined ? { next } : {}),
    },
    budget: {
      unit: "utf16",
      limit: ctx.input.budget,
      used,
      mode,
    },
    fingerprint: ctx.fingerprint,
  };
}

/** budget.used 必须等于最终序列化长度；数字位数变化时继续收敛。 */
function finalizeResponse(
  ctx: ViewContext,
  items: ReadViewItem[],
  hasMore: boolean,
  next: string | undefined,
  mode: "auto" | "explicit",
): ReadViewResponse {
  const assemble = (used: number): ReadViewResponse =>
    responseOf(ctx, items, hasMore, next, mode, used);
  let used = 0;
  let response = assemble(used);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const length = JSON.stringify(response).length;
    if (length === used) return response;
    used = length;
    response = assemble(used);
  }
  const length = JSON.stringify(response).length;
  if (length !== used) {
    used = length;
    response = assemble(used);
  }
  return response;
}

function pageLength(
  ctx: ViewContext,
  items: ReadViewItem[],
  hasMore: boolean,
  next: string | undefined,
): number {
  return JSON.stringify(finalizeResponse(ctx, items, hasMore, next, "auto")).length;
}

function budgetTooSmall(ctx: ViewContext, minimum: number): ReadViewError {
  return new ReadViewError(
    "BUDGET_TOO_SMALL",
    "预算不足以放下最小记录；请提高 budget 或缩小范围",
    { limit: ctx.input.budget, minimum, view: ctx.input.view },
  );
}

/**
 * 用假设的 limit 测量同一页。报告的 minimum 必须本身就是可成功的 budget：
 * 直接把空页长度当 minimum，会漏掉候选卡片和 limit 位数变化。
 */
function pageLengthAtLimit(
  ctx: ViewContext,
  items: ReadViewItem[],
  hasMore: boolean,
  next: string | undefined,
  limit: number,
): number {
  const probe: ViewContext = { ...ctx, input: { ...ctx.input, budget: limit } };
  return pageLength(probe, items, hasMore, next);
}

/** 求最小的、按该 budget 能真正容纳此页配置的值。 */
function minimumPageBudget(
  ctx: ViewContext,
  items: ReadViewItem[],
  hasMore: boolean,
  next: string | undefined,
): number {
  let minimum = 1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const length = pageLengthAtLimit(ctx, items, hasMore, next, minimum);
    if (length <= minimum) return minimum;
    minimum = length;
  }
  return minimum;
}

function minimumCandidateBudget(
  ctx: ViewContext,
  candidate: ReadContentItem,
  nextPosition: ContentPosition | null,
): number {
  const hasMore = nextPosition !== null;
  const next = nextPosition === null
    ? undefined
    : encodeReadCursor(makeCursor(ctx, nextPosition));
  return minimumPageBudget(ctx, [candidate], hasMore, next);
}

function navigationPage(
  ctx: ViewContext,
  records: ReadViewItem[],
  cursor: ReadCursorState | undefined,
): ReadViewResponse {
  const total = records.length;
  let offset = 0;
  if (cursor !== undefined) {
    if (cursor.offset === undefined) {
      throw cursorError("overview/structure 的续读标记缺少 offset");
    }
    offset = cursor.offset;
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > total) {
    throw cursorError("续读标记的 offset 超出当前范围", { offset, total, view: ctx.input.view });
  }
  if (total === 0) {
    if (offset !== 0) {
      throw cursorError("续读标记的 offset 超出当前范围", { offset, total, view: ctx.input.view });
    }
    const response = finalizeResponse(ctx, [], false, undefined, "auto");
    const length = JSON.stringify(response).length;
    if (length > ctx.input.budget) throw budgetTooSmall(ctx, length);
    return response;
  }
  if (offset === total) {
    throw cursorError("续读标记已到达范围末尾；请从头开始读取", { offset, total, view: ctx.input.view });
  }

  const remaining = total - offset;
  const measure = (count: number): number => {
    const end = offset + count;
    const hasMore = end < total;
    const next = hasMore
      ? encodeReadCursor(makeCursor(ctx, { offset: end }))
      : undefined;
    return pageLength(ctx, records.slice(offset, end), hasMore, next);
  };
  const pageOf = (count: number, hasMore: boolean): ReadViewResponse => {
    const end = offset + count;
    const next = hasMore
      ? encodeReadCursor(makeCursor(ctx, { offset: end }))
      : undefined;
    return finalizeResponse(ctx, records.slice(offset, end), hasMore, next, "auto");
  };

  // 全部剩余记录不需要 next token；一次成功即可结束分页。
  const fullLength = measure(remaining);
  if (fullLength <= ctx.input.budget) {
    return pageOf(remaining, false);
  }

  // count < remaining 时页面都带 token；增加完整记录只会让长度单调不减，
  // 因此可以二分找预算内最大的 count，避免逐条重算的 O(n²)。
  let best = 0;
  if (remaining > 1) {
    let low = 1;
    let high = remaining - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (measure(mid) <= ctx.input.budget) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
  }
  if (best > 0) return pageOf(best, true);

  if (remaining > 1) {
    const next = encodeReadCursor(makeCursor(ctx, { offset: offset + 1 }));
    throw budgetTooSmall(
      ctx,
      minimumPageBudget(ctx, records.slice(offset, offset + 1), true, next),
    );
  }
  throw budgetTooSmall(
    ctx,
    minimumPageBudget(ctx, records.slice(offset, total), false, undefined),
  );
}

/* ------------------------------------------------------------------ *
 * content
 * ------------------------------------------------------------------ */

function contentItem(
  input: ReadViewBuildInput,
  node: ReadViewNode,
  body: string,
  omitted: boolean,
  range: AgentReadRange,
): ReadContentItem {
  return {
    node: graphNodeOf(node),
    body,
    ...(omitted ? { bodyOmitted: true } : {}),
    range,
    // “还有正文未返回”只看结尾；从中间读到末尾不算截断。meta 按设计省略正文。
    truncated: omitted ? false : range.end < range.total,
    path: node.sourcePath ?? "",
    fileHash: node.fileHash ?? "",
    editRef: input.mode === "online" ? input.editRefs?.[node.id] ?? null : null,
  };
}

function hasExplicitContentOptions(options: ReadContentOptions | undefined): boolean {
  return (
    options !== undefined &&
    (options.start !== undefined ||
      options.length !== undefined ||
      options.full === true ||
      options.section !== undefined ||
      options.sectionIndex !== undefined)
  );
}

function explicitContentItem(
  input: ReadViewBuildInput,
  node: ReadViewNode,
  options: ReadContentOptions,
): ReadContentItem {
  const body = bodyOf(node);
  const total = body.length;
  if (options.meta === true) {
    return contentItem(
      input,
      node,
      "",
      true,
      { start: 0, end: 0, total, unit: "utf16" },
    );
  }
  let start = options.start ?? 0;
  if (options.section !== undefined) {
    try {
      start = locateSection(body, options.section, options.sectionIndex).start;
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ReadViewError("INVALID_SECTION", error.message, {
          nodeId: node.id,
          section: options.section,
          ...(options.sectionIndex !== undefined ? { sectionIndex: options.sectionIndex } : {}),
        });
      }
      throw error;
    }
  } else if (options.sectionIndex !== undefined) {
    throw new ReadViewError(
      "INVALID_SECTION",
      "sectionIndex 必须与 section 一起使用",
      { nodeId: node.id, sectionIndex: options.sectionIndex },
    );
  }

  let segment;
  try {
    segment = sliceBody(body, {
      start,
      ...(options.length !== undefined ? { length: options.length } : {}),
      full: options.full === true,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw invalidScope("读取参数不合法：" + error.message, { nodeId: node.id });
    }
    throw error;
  }
  return contentItem(
    input,
    node,
    segment.text,
    false,
    segment.range,
  );
}

function contentExplicitPage(
  ctx: ViewContext,
  nodes: readonly ReadViewNode[],
  options: ReadContentOptions,
): ReadViewResponse {
  const items = nodes.map((node) => explicitContentItem(ctx.input, node, options));
  const response = finalizeResponse(ctx, items, false, undefined, "explicit");
  const required = JSON.stringify(response).length;
  if (required > ctx.input.budget) {
    throw new ReadViewError(
      "BUDGET_EXCEEDED",
      "显式读取的序列化结果超过 budget，未返回半份数据；请提高 budget 或缩小范围",
      { limit: ctx.input.budget, required, view: "content" },
    );
  }
  return response;
}

function nextContentPosition(
  nodes: readonly ReadViewNode[],
  index: number,
): ContentPosition | null {
  return index >= nodes.length ? null : { index, start: 0 };
}

function autoPageLength(
  ctx: ViewContext,
  items: ReadViewItem[],
  candidate: ReadContentItem,
  nextPosition: ContentPosition | null,
): number {
  const all = [...items, candidate];
  const hasMore = nextPosition !== null;
  const next = nextPosition === null
    ? undefined
    : encodeReadCursor(makeCursor(ctx, nextPosition));
  return pageLength(ctx, all, hasMore, next);
}

/** 在预算内找最大的正文长度；返回 null 表示连 1 个单元都放不下。 */
function shrinkContentItem(
  ctx: ViewContext,
  nodes: readonly ReadViewNode[],
  items: ReadViewItem[],
  node: ReadViewNode,
  body: string,
  start: number,
  total: number,
  index: number,
): { item: ReadContentItem; position: ContentPosition | null } | null {
  const available = Math.min(AUTO_CONTENT_LENGTH, total - start);
  if (available < 1) return null;
  let low = 1;
  let high = available;
  let best: { item: ReadContentItem; position: ContentPosition | null } | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const segment = sliceBody(body, { start, length: mid });
    if (segment.range.end <= start) {
      low = mid + 1;
      continue;
    }
    const candidate = contentItem(
      ctx.input,
      node,
      segment.text,
      false,
      segment.range,
    );
    const position: ContentPosition | null =
      segment.range.end < total
        ? { index, start: segment.range.end }
        : nextContentPosition(nodes, index + 1);
    if (autoPageLength(ctx, items, candidate, position) <= ctx.input.budget) {
      best = { item: candidate, position };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function minimumContentPageLength(
  ctx: ViewContext,
  nodes: readonly ReadViewNode[],
  node: ReadViewNode,
  body: string,
  start: number,
  total: number,
  index: number,
): number {
  let candidate: ReadContentItem;
  let position: ContentPosition | null;
  const segment = sliceBody(body, { start, length: 1 });
  candidate = contentItem(
    ctx.input,
    node,
    segment.text,
    false,
    segment.range,
  );
  position =
    segment.range.end < total
      ? { index, start: segment.range.end }
      : nextContentPosition(nodes, index + 1);
  return minimumCandidateBudget(ctx, candidate, position);
}

function contentAutoPage(
  ctx: ViewContext,
  nodes: readonly ReadViewNode[],
  cursor: ReadCursorState | undefined,
): ReadViewResponse {
  let position: ContentPosition | null;
  if (cursor !== undefined) {
    if (cursor.index === undefined || cursor.start === undefined) {
      throw cursorError("content 的续读标记缺少 index/start");
    }
    position = { index: cursor.index, start: cursor.start };
  } else {
    position = { index: 0, start: 0 };
  }
  if (position.index < 0 || position.index >= nodes.length) {
    throw cursorError("续读标记的 index 超出当前范围", {
      index: position.index,
      nodeCount: nodes.length,
    });
  }
  const first = nodes[position.index] as ReadViewNode;
  if (position.start < 0 || position.start > bodyOf(first).length) {
    throw cursorError("续读标记的 start 超出该节点正文范围", {
      start: position.start,
      nodeId: first.id,
    });
  }

  const items: ReadContentItem[] = [];
  const meta = ctx.input.content?.meta === true;
  while (position !== null) {
    const node = nodes[position.index] as ReadViewNode;
    const body = bodyOf(node);
    const total = body.length;
    const start = position.start;
    let candidate: ReadContentItem;
    let nextPosition: ContentPosition | null;
    if (meta) {
      candidate = contentItem(
        ctx.input,
        node,
        "",
        true,
        { start: 0, end: 0, total, unit: "utf16" },
      );
      nextPosition = nextContentPosition(nodes, position.index + 1);
    } else {
      const segment = sliceBody(body, { start, length: AUTO_CONTENT_LENGTH });
      candidate = contentItem(
        ctx.input,
        node,
        segment.text,
        false,
        segment.range,
      );
      nextPosition =
        segment.range.end < total
          ? { index: position.index, start: segment.range.end }
          : nextContentPosition(nodes, position.index + 1);
    }

    if (autoPageLength(ctx, items, candidate, nextPosition) <= ctx.input.budget) {
      items.push(candidate);
      if (nextPosition === null) {
        position = null;
        break;
      }
      if (nextPosition.index === position.index) {
        // 当前卡片还有正文：本页到此为止，token 从同一节点的 end 继续。
        position = nextPosition;
        break;
      }
      position = nextPosition;
      continue;
    }

    if (!meta && start < total) {
      const shrunk = shrinkContentItem(
        ctx,
        nodes,
        items,
        node,
        body,
        start,
        total,
        position.index,
      );
      if (shrunk !== null) {
        items.push(shrunk.item);
        position = shrunk.position;
        break;
      }
    }

    if (items.length === 0) {
      const minimum = meta
        ? minimumCandidateBudget(ctx, candidate, nextPosition)
        : minimumContentPageLength(ctx, nodes, node, body, start, total, position.index);
      throw budgetTooSmall(ctx, minimum);
    }
    // 已装填的记录保留；token 指回当前候选的起点。
    break;
  }

  const hasMore = position !== null;
  const next =
    position === null
      ? undefined
      : encodeReadCursor(makeCursor(ctx, position));
  return finalizeResponse(ctx, items, hasMore, next, "auto");
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

function staleError(
  input: ReadViewBuildInput,
  resolved: ResolvedScope,
): ReadViewError {
  return new ReadViewError(
    "STALE_READ",
    "范围内容已变化，续读标记已过期；请从头重新读取。",
    {
      view: input.view,
      topicId: resolved.topicId,
      scope: resolved.info,
      reason: "fingerprint 不一致",
    },
  );
}

function checkCursorIdentity(
  input: ReadViewBuildInput,
  resolved: ResolvedScope,
  cursor: ReadCursorState,
): void {
  if (cursor.mode !== input.mode) {
    throw cursorError("续读标记来自其他读取来源；请去掉 cursor 或使用相同的 mode", {
      expected: input.mode,
      actual: cursor.mode,
    });
  }
  if (cursor.workspaceId !== input.workspaceId) {
    throw cursorError("续读标记属于其他工作区", {
      expected: input.workspaceId,
      actual: cursor.workspaceId,
    });
  }
  if (cursor.topicId !== resolved.topicId) {
    throw cursorError("续读标记属于其他主题；请从头重新读取", {
      expected: resolved.topicId,
      actual: cursor.topicId,
    });
  }
  if (cursor.view !== input.view) {
    throw cursorError("续读标记属于其他视图；请从头重新读取", {
      expected: input.view,
      actual: cursor.view,
    });
  }
  if (!sameScope(cursor.scope, resolved.scope)) {
    throw cursorError("续读标记属于其他范围；请去掉 cursor 重新读取", {
      expected: resolved.scope,
      actual: cursor.scope,
    });
  }
}

export function buildReadView(input: ReadViewBuildInput): ReadViewResponse {
  validateBudget(input.budget);
  const resolved = resolveScope(input);
  const meta = input.view === "content" && input.content?.meta === true;
  const explicit =
    input.view === "content" && !meta && hasExplicitContentOptions(input.content);
  const fingerprint = fingerprintOf(input, resolved);

  let scopeInfo = resolved.info;
  if (input.view === "overview") {
    scopeInfo = { ...scopeInfo, note: joinNotes(scopeInfo.note, OVERVIEW_NOTE) };
  } else if (input.view === "content" && !explicit && !meta) {
    scopeInfo = { ...scopeInfo, note: joinNotes(scopeInfo.note, CONTENT_AUTO_NOTE) };
  }

  let cursor: ReadCursorState | undefined;
  if (input.cursor !== undefined) {
    cursor = decodeReadCursor(input.cursor);
    if (explicit) {
      throw cursorError("显式切片读取不使用自动续读；请去掉 cursor", {
        view: input.view,
      });
    }
    checkCursorIdentity(input, resolved, cursor);
    if (cursor.fingerprint !== fingerprint) throw staleError(input, resolved);
  }

  const ctx: ViewContext = {
    input,
    topicId: resolved.topicId,
    scope: resolved.scope,
    scopeInfo,
    fingerprint,
    ...(input.view === "structure"
      ? { boundaries: boundariesFor(input, resolved) }
      : {}),
  };

  if (input.view === "overview") {
    return navigationPage(ctx, overviewItems(input, resolved), cursor);
  }
  if (input.view === "structure") {
    return navigationPage(ctx, structureItems(resolved), cursor);
  }
  if (explicit) {
    return contentExplicitPage(ctx, resolved.nodes, input.content ?? {});
  }
  return contentAutoPage(ctx, resolved.nodes, cursor);
}
