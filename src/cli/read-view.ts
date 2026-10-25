/**
 * 离线渐进读取：把磁盘工作区投影成引擎输入，并生成 disk envelope。
 *
 * 只使用有效图的事实（编号／连接／状态）与节点自己的源文件（正文／哈希）；
 * 不伪造图、不签发凭据，也不把在线续读标记混进离线结果。
 */
import {
  ReadViewError,
  buildReadView,
  decodeReadCursor,
  serializeReadView,
  type ReadContentOptions,
  type ReadCursorState,
  type ReadViewBuildInput,
  type ReadViewNode,
} from "../index/read-view.js";
import type {
  ReadBoundary,
  ReadContentItem,
  ReadOverviewItem,
  ReadStructureItem,
  ReadScope,
  ReadViewKind,
  ReadViewResponse,
} from "../shared/protocol.js";
import type { CliContext } from "./context.js";
import { CliError, EXIT_CODES } from "./errors.js";
import { emit } from "./output.js";
import {
  findNode,
  requireTopicEntry,
  type NodeEntry,
  type TopicEntry,
  type WorkspaceSnapshot,
} from "./workspace.js";

export interface OfflineReadOnlineInfo {
  readonly code: string;
  readonly reason: string;
}

export interface OfflineReadViewOptions {
  readonly budget: number;
  readonly cursor?: string | undefined;
  readonly view?: ReadViewKind | undefined;
  /** 稳定 topicId 或相对入口路径；cursor 模式不需要。 */
  readonly topic?: string | undefined;
  readonly from?: string | undefined;
  readonly nodeIds?: readonly string[] | undefined;
  readonly content?: ReadContentOptions | undefined;
  /** 进入磁盘读取的原因：--offline 或服务回退的实际 code/reason。 */
  readonly online: OfflineReadOnlineInfo;
}

/** 工作区没有有效图时不猜测结构：返回带诊断的 CLI 错误（退出码 6）。 */
function requireGraph(snapshot: WorkspaceSnapshot): NonNullable<WorkspaceSnapshot["graph"]> {
  if (!snapshot.ok || snapshot.graph === null) {
    throw new CliError(
      "WORKSPACE_INVALID",
      "工作区无效，无法读取渐进视图；请先运行 aichat validate 查看诊断",
      EXIT_CODES.validation,
      {
        diagnostics: snapshot.diagnostics,
        details: {
          root: snapshot.root,
          schemaVersion: snapshot.schemaVersion,
          workspaceJsonError: snapshot.workspaceJsonError ?? null,
        },
      },
    );
  }
  return snapshot.graph;
}

function diagnosticDetails(snapshot: WorkspaceSnapshot): Record<string, unknown> {
  return {
    schemaVersion: snapshot.schemaVersion,
    diagnostics: snapshot.diagnostics.slice(0, 20),
  };
}

function missingNodeError(snapshot: WorkspaceSnapshot, nodeIds: readonly string[]): CliError {
  return new CliError(
    "NODE_NOT_FOUND",
    `找不到节点: ${nodeIds.join(", ")}`,
    EXIT_CODES.notFound,
    { details: { nodeIds, ...diagnosticDetails(snapshot) } },
  );
}

function staleCursor(
  message: string,
  details: Record<string, unknown>,
): ReadViewError {
  return new ReadViewError("STALE_READ", message, details);
}

function invalidCursor(message: string, details: Record<string, unknown>): ReadViewError {
  return new ReadViewError("INVALID_CURSOR", message, details);
}

/** ReadViewError → CLI 错误：过期续读是操作冲突 5，其余范围／预算问题是用例 2。 */
export function cliErrorFromReadView(error: ReadViewError): CliError {
  const exitCode =
    error.code === "STALE_READ" ? EXIT_CODES.operationConflict : EXIT_CODES.usage;
  return new CliError(
    error.code,
    error.message,
    exitCode,
    error.details !== undefined ? { details: error.details } : { cause: error },
  );
}

/* ------------------------------------------------------------------ *
 * 磁盘节点投影
 * ------------------------------------------------------------------ */

function graphIndex(snapshot: WorkspaceSnapshot): Map<string, NonNullable<WorkspaceSnapshot["graph"]>["nodes"][number]> {
  const graph = requireGraph(snapshot);
  return new Map(graph.nodes.map((node) => [node.id, node] as const));
}

function offlineNode(
  snapshot: WorkspaceSnapshot,
  graphById: ReadonlyMap<string, NonNullable<WorkspaceSnapshot["graph"]>["nodes"][number]>,
  entry: NodeEntry,
): ReadViewNode {
  const view = graphById.get(entry.node.id);
  if (view === undefined) {
    throw new CliError(
      "WORKSPACE_INVALID",
      `节点 ${entry.node.id} 不在有效图中；拒绝用残缺事实拼装读取视图`,
      EXIT_CODES.validation,
      { diagnostics: snapshot.diagnostics, details: { nodeId: entry.node.id, path: entry.path } },
    );
  }
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
    sourcePath: entry.path,
    fileHash: entry.file.sha256,
    body: entry.node.body,
  };
}

function topicNodes(
  snapshot: WorkspaceSnapshot,
  graphById: ReadonlyMap<string, NonNullable<WorkspaceSnapshot["graph"]>["nodes"][number]>,
  topic: TopicEntry,
): ReadViewNode[] {
  return topic.nodes.map((entry) => offlineNode(snapshot, graphById, entry));
}

function topicRootIds(
  snapshot: WorkspaceSnapshot,
  topicId: string,
): string[] {
  const graph = requireGraph(snapshot);
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  return graph.rootIds.filter((id) => byId.get(id)?.topicId === topicId);
}

/* ------------------------------------------------------------------ *
 * topic / node 解析
 * ------------------------------------------------------------------ */

function resolveOfflineTopic(
  snapshot: WorkspaceSnapshot,
  locator: string,
): TopicEntry {
  return requireTopicEntry(snapshot, locator);
}

/** content 节点：保持请求顺序、去重，并保证全部属于同一主题。 */
function resolveOfflineContent(
  snapshot: WorkspaceSnapshot,
  requested: readonly string[],
): { entries: NodeEntry[]; topic: TopicEntry; nodeIds: string[] } {
  const seen = new Set<string>();
  const entries: NodeEntry[] = [];
  const missing: string[] = [];
  let topic: TopicEntry | undefined;
  let topicIds: Set<string> | undefined;

  for (const nodeId of requested) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const found = findNode(snapshot, nodeId);
    if (found === undefined) {
      missing.push(nodeId);
      continue;
    }
    if (topic === undefined) {
      topic = found.topic;
      topicIds = new Set([found.topic.topic.topicId]);
    } else if (found.topic.topic.topicId !== topic.topic.topicId) {
      topicIds?.add(found.topic.topic.topicId);
      const first = entries[0];
      throw new CliError(
        "INVALID_SCOPE",
        `节点集合跨主题（节点 ${first?.node.id ?? nodeId} 与 ${nodeId} 不属于同一主题）；读取范围必须属于同一主题`,
        EXIT_CODES.usage,
        {
          details: {
            nodeIds: [...seen],
            topicIds: [...(topicIds ?? new Set<string>())],
          },
        },
      );
    }
    entries.push(found.entry);
  }

  if (missing.length > 0) throw missingNodeError(snapshot, missing);
  if (topic === undefined || entries.length === 0) {
    throw new ReadViewError("INVALID_SCOPE", "content 读取至少需要一个节点", {
      nodeIds: [...requested],
    });
  }
  return { entries, topic, nodeIds: entries.map((entry) => entry.node.id) };
}

function requireSubtreeFrom(
  snapshot: WorkspaceSnapshot,
  topic: TopicEntry,
  from: string,
): void {
  const found = findNode(snapshot, from);
  if (found === undefined) throw missingNodeError(snapshot, [from]);
  if (found.topic.topic.topicId !== topic.topic.topicId) {
    throw new CliError(
      "INVALID_SCOPE",
      `节点 ${from} 不属于主题 ${topic.topic.topicId}`,
      EXIT_CODES.usage,
      {
        details: {
          nodeId: from,
          topicId: topic.topic.topicId,
          actualTopicId: found.topic.topic.topicId,
        },
      },
    );
  }
}

/* ------------------------------------------------------------------ *
 * 输入装配
 * ------------------------------------------------------------------ */

interface ResolvedOfflineRead {
  workspaceId: string;
  topicId: string | null;
  topicTitle: string | null;
  rootIds: string[];
  nodes: ReadViewNode[];
  view: ReadViewKind;
  scope: ReadScope;
  content?: ReadContentOptions;
  cursor?: string;
}

function freshOfflineRead(
  snapshot: WorkspaceSnapshot,
  graphById: ReadonlyMap<string, NonNullable<WorkspaceSnapshot["graph"]>["nodes"][number]>,
  options: OfflineReadViewOptions,
): ResolvedOfflineRead {
  const requested = options.nodeIds ?? [];
  const view: ReadViewKind =
    options.view ?? (requested.length > 0 ? "content" : options.from !== undefined ? "structure" : "overview");

  if (view === "content") {
    const resolved = resolveOfflineContent(snapshot, requested);
    return {
      workspaceId: requireGraph(snapshot).workspaceId,
      topicId: resolved.topic.topic.topicId,
      topicTitle: resolved.topic.topic.title,
      rootIds: [],
      nodes: resolved.entries.map((entry) => offlineNode(snapshot, graphById, entry)),
      view,
      scope: { kind: "nodes", nodeIds: resolved.nodeIds },
      ...(options.content !== undefined ? { content: options.content } : {}),
    };
  }

  if (requested.length > 0) {
    throw new ReadViewError("INVALID_SCOPE", view + " 读取不接受 node；content 才使用 node", {
      view,
      nodeIds: requested,
    });
  }
  const locator = options.topic;
  if (locator === undefined || locator.length === 0) {
    throw new ReadViewError("INVALID_SCOPE", view + " 读取必须提供主题", { view });
  }
  const topic = resolveOfflineTopic(snapshot, locator);
  const from = options.from;
  if (from !== undefined) requireSubtreeFrom(snapshot, topic, from);
  return {
    workspaceId: requireGraph(snapshot).workspaceId,
    topicId: topic.topic.topicId,
    topicTitle: topic.topic.title,
    rootIds: topicRootIds(snapshot, topic.topic.topicId),
    nodes: topicNodes(snapshot, graphById, topic),
    view,
    scope: from !== undefined ? { kind: "subtree", from } : { kind: "topic" },
  };
}

function cursorOfflineRead(
  snapshot: WorkspaceSnapshot,
  graphById: ReadonlyMap<string, NonNullable<WorkspaceSnapshot["graph"]>["nodes"][number]>,
  state: ReadCursorState,
  options: OfflineReadViewOptions,
): ResolvedOfflineRead {
  const workspaceId = requireGraph(snapshot).workspaceId;
  if (state.workspaceId !== workspaceId) {
    throw invalidCursor("续读标记属于其他工作区", {
      expected: workspaceId,
      actual: state.workspaceId,
    });
  }
  if (state.topicId === null) {
    throw staleCursor("续读标记缺少主题；请从头重新读取该范围。", {
      view: state.view,
    });
  }
  const topic = snapshot.topics.find((entry) => entry.topic.topicId === state.topicId);
  if (topic === undefined) {
    throw staleCursor("续读标记中的主题已不存在；请从头重新读取该范围。", {
      view: state.view,
      topicId: state.topicId,
      reason: "topic missing",
    });
  }

  if (state.view === "content") {
    if (state.scope.kind !== "nodes") {
      throw invalidCursor("content 的续读标记范围不合法", { scope: state.scope });
    }
    const nodes: ReadViewNode[] = [];
    for (const nodeId of state.scope.nodeIds) {
      const found = findNode(snapshot, nodeId);
      if (found === undefined || found.topic.topic.topicId !== state.topicId) {
        throw staleCursor(
          "续读标记中的节点已不存在或主题已变化；请从头重新读取该范围。",
          {
            view: state.view,
            topicId: state.topicId,
            nodeId,
            reason: found === undefined ? "node missing" : "topic changed",
          },
        );
      }
      nodes.push(offlineNode(snapshot, graphById, found.entry));
    }
    return {
      workspaceId,
      topicId: topic.topic.topicId,
      topicTitle: topic.topic.title,
      rootIds: [],
      nodes,
      view: "content",
      scope: { kind: "nodes", nodeIds: nodes.map((node) => node.id) },
      ...(state.meta === true ? { content: { meta: true as const } } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    };
  }

  if (state.scope.kind === "nodes") {
    throw invalidCursor(state.view + " 的续读标记范围不合法", { scope: state.scope });
  }
  if (state.scope.kind === "subtree") {
    const from = state.scope.from;
    if (!topic.nodes.some((entry) => entry.node.id === from)) {
      throw staleCursor("续读标记中的起点节点已不存在；请从头重新读取该范围。", {
        view: state.view,
        topicId: state.topicId,
        from,
        reason: "node missing",
      });
    }
  }
  return {
    workspaceId,
    topicId: topic.topic.topicId,
    topicTitle: topic.topic.title,
    rootIds: topicRootIds(snapshot, topic.topic.topicId),
    nodes: topicNodes(snapshot, graphById, topic),
    view: state.view,
    scope: state.scope,
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  };
}

/** 从磁盘工作区构建 ReadViewResponse；引擎错误统一映射为 CLI 错误。 */
export function buildOfflineReadView(
  snapshot: WorkspaceSnapshot,
  options: OfflineReadViewOptions,
  _ctx: CliContext,
): ReadViewResponse {
  // 无效工作区先于任何范围解析失败：不返回伪造的图或空清单。
  requireGraph(snapshot);
  try {
    const graphById = graphIndex(snapshot);
    let resolved: ResolvedOfflineRead;
    if (options.cursor !== undefined) {
      const state = decodeReadCursor(options.cursor);
      if (state.mode !== "disk") {
        throw staleCursor(
          "续读标记来自在线读取；离线无法继续该标记，请去掉 --offline 重新在线读取，或从头重读。",
          { expected: "disk", actual: state.mode, view: state.view },
        );
      }
      resolved = cursorOfflineRead(snapshot, graphById, state, options);
    } else {
      resolved = freshOfflineRead(snapshot, graphById, options);
    }

    const input: ReadViewBuildInput = {
      workspaceId: resolved.workspaceId,
      mode: "disk",
      topicId: resolved.topicId,
      topicTitle: resolved.topicTitle,
      rootIds: resolved.rootIds,
      nodes: resolved.nodes,
      view: resolved.view,
      scope: resolved.scope,
      budget: options.budget,
      ...(resolved.cursor !== undefined ? { cursor: resolved.cursor } : {}),
      ...(resolved.content !== undefined ? { content: resolved.content } : {}),
      envelope: {
        source: "disk",
        root: snapshot.root,
        online: {
          available: false,
          code: options.online.code,
          reason: options.online.reason,
        },
      },
    };
    return buildReadView(input);
  } catch (error) {
    if (error instanceof ReadViewError) throw cliErrorFromReadView(error);
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * 文本输出
 * ------------------------------------------------------------------ */

function cursorHint(payload: ReadViewResponse): string {
  const offline = payload.source === "disk" ? " --offline" : "";
  return (
    'page.next: aichat read --cursor "' +
    (payload.page.next ?? "") +
    '"' +
    offline +
    " --budget " +
    String(payload.budget.limit)
  );
}

function overviewItemLine(item: ReadOverviewItem, topicId: string | null): string {
  if (item.role === "branch") {
    return (
      `branch ${item.number} ${item.id} ${item.title} — subtree ${String(item.subtreeNodeCount ?? 0)} node(s); ` +
      `read ${topicId ?? "-"} --view structure --from ${item.id}`
    );
  }
  return (
    `mainline ${item.number} ${item.id} ${item.title}` +
    (item.from === null ? "" : ` (from ${item.from})`) +
    (item.description !== undefined ? ` — ${item.description}` : "")
  );
}

function structureItemLine(item: ReadStructureItem): string {
  return (
    `${item.number} ${item.id} from=${item.from ?? "-"} flow=${item.flow} ${item.title}` +
    (item.description !== undefined ? ` — ${item.description}` : "")
  );
}

function boundaryLine(boundary: ReadBoundary): string {
  return (
    `boundary ${boundary.from} -> ${boundary.to} (${boundary.flow}) external ` +
    `${boundary.external.id} ${boundary.external.title}` +
    (boundary.external.topicId !== undefined ? ` [${boundary.external.topicId}]` : "")
  );
}

function contentItemLine(item: ReadContentItem, source: "online" | "disk"): string[] {
  const lines = [
    `# ${item.node.title} (${item.node.id}) ${source} ` +
      `[${String(item.range.start)},${String(item.range.end)})/${String(item.range.total)}`,
  ];
  if (item.bodyOmitted === true) {
    lines.push(`（仅元数据，总长 ${String(item.range.total)}；正文未返回）`);
  } else {
    lines.push(item.body);
  }
  return lines;
}

/**
 * 输出读取结果：JSON 直接写引擎的预算序列化（紧凑 JSON + 换行），
 * 与 budget.used 逐字符一致；文本只给可粘贴的续读命令，不暴露 cursor 的 JSON 结构。
 */
export function emitReadViewText(
  payload: ReadViewResponse,
  ctx: CliContext,
  mode: "json" | "text",
): void {
  if (mode === "json") {
    ctx.stdout(serializeReadView(payload));
    return;
  }

  const lines: string[] = [];
  lines.push(
    `read ${payload.view} ${payload.topicId ?? "-"} ${payload.topicTitle ?? ""}`.trimEnd(),
  );
  const from = payload.scope.from === undefined ? "" : ` from ${payload.scope.from}`;
  lines.push(
    `source ${payload.source}; scope ${payload.scope.kind} ${String(payload.scope.nodeCount)} node(s)${from}`,
  );
  if (payload.online.available === false) {
    lines.push(`offline (${payload.online.code}) ${payload.online.reason}`);
  }

  if (payload.view === "overview") {
    for (const item of payload.items as ReadOverviewItem[]) {
      lines.push(overviewItemLine(item, payload.topicId));
    }
  } else if (payload.view === "structure") {
    for (const item of payload.items as ReadStructureItem[]) {
      lines.push(structureItemLine(item));
    }
    for (const boundary of payload.boundaries ?? []) lines.push(boundaryLine(boundary));
  } else {
    for (const item of payload.items as ReadContentItem[]) {
      lines.push(...contentItemLine(item, payload.source));
      lines.push("");
    }
  }

  lines.push(
    `budget ${String(payload.budget.used)}/${String(payload.budget.limit)} (${payload.budget.mode})`,
  );
  if (payload.page.hasMore) lines.push(cursorHint(payload));
  emit(ctx, "text", payload, lines);
}
