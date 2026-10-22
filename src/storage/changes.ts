/**
 * 候选变更集合：把一份 ChangeRequest 应用到"本次扫描得到的文本"上，
 * 纯同步地算出可提交的文件与全图校验结果。
 *
 * 边界：
 * - 不读文件、不写文件、不取锁、不发布快照；所有事实来自调用方传入的 WorkspaceFiles；
 * - 只改动本次操作涉及的卡片区块与目标文件的 frontmatter；其他卡片正文、BOM、CRLF 原样保留；
 * - frontmatter 用 yaml Document 做受控元数据更新；正文只按 AST 源码范围拼接，不用正则解析 Markdown；
 * - 返回的 CommitFileInput.expectedSha256 一律取自调用方声明，绝不替调用者补旧哈希；
 * - 最终必须整份工作区 parse + graph 校验通过，否则不返回任何可提交候选。
 */
import { changeRequestSchema } from "./changes/v1-request.js";
import type {
  CreateTopicOperation,
  CreateNodeOperation,
  UpdateNodeOperation,
  InsertNextNodeInput,
  InsertNextOperation,
  MoveBranchOperation,
  MoveNodeToTopicOperation,
  ReplaceTopicOperation,
  SetDiscussionFocusOperation,
  RemoveLeafOperation,
  MergeReconnectEntry,
  MergeNodesOperation,
  Operation,
  ChangeRequest,
} from "./changes/v1-request.js";
export * from "./changes/v1-request.js";
import {
  normalizeNewlines,
  detectNewline,
  renderNewBlock,
  patchBlock,
  renderText,
  setNodeMeta,
  stateFromParsed,
  newTopicState,
  resync,
  appendBlock,
  insertBlockAfter,
  removeBlock,
} from "./changes/v1-text.js";
import type { NodeView, TopicState } from "./changes/v1-text.js";
import { z } from "zod";
import {
  parseTopicDocument,
  nextBranchOrder,
  validateWorkspace,
  workspaceMetaSchema,
  type Diagnostic,
  type NodeMeta,
  type ParsedTopic,
  type WorkspaceMeta,
} from "../core/index.js";
import type { StorageDiagnostic } from "./errors.js";
import { isWritableContentPath, normalizeRelativePath } from "./paths.js";
import type { CommitFileInput } from "./transactions.js";
import { prepareChangesV2, v2ChangeRequestSchema } from "./changes-v2.js";
import type { V2ChangeRequest } from "./changes-v2.js";
import type { WorkspaceFiles } from "./workspace.js";

/* ------------------------------------------------------------------ *
 * 公开类型
 * ------------------------------------------------------------------ */

// 错误类型与结果形状来自最底层的共享契约：这里导入后再导出，
// 既给本文件使用，也保持旧的 `from "./changes.js"` 导入路径可用。
import {
  ChangeError,
  badRequest,
  conflict,
  validationError,
  flattenChangeRequestIssues,
} from "./changes-shared.js";
import type { ChangeErrorCode, ChangeErrorOptions, PreparedChanges } from "./changes-shared.js";

export { ChangeError, badRequest, conflict, validationError, flattenChangeRequestIssues };
export type { ChangeErrorCode, ChangeErrorOptions, PreparedChanges };
export type { FlatIssue } from "./changes-shared.js";

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

function issueList(error: z.ZodError): Array<{ path: string; message: string; code: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join("."),
    message: issue.message,
    code: issue.code,
  }));
}

function requireContentPath(rawPath: string): string {
  let normalized: string;
  try {
    normalized = normalizeRelativePath(rawPath);
  } catch (error) {
    throw badRequest("路径不合法：" + rawPath, { reason: String(error) });
  }
  if (!isWritableContentPath(normalized)) {
    throw badRequest("只允许 workspace.json 与 topics 下的 Markdown：" + normalized);
  }
  return normalized;
}

interface MetaInput {
  from: string | null;
  flow: NodeMeta["flow"];
  state: NodeMeta["state"];
  side?: NodeMeta["side"] | undefined;
  order?: number | undefined;
  label?: string | undefined;
  summary?: string | undefined;
}

function makeMeta(input: MetaInput): NodeMeta {
  const meta: NodeMeta = { from: input.from, flow: input.flow, state: input.state };
  if (input.side !== undefined) meta.side = input.side;
  if (input.order !== undefined) meta.order = input.order;
  if (input.label !== undefined) meta.label = input.label;
  if (input.summary !== undefined) meta.summary = input.summary;
  return meta;
}

/** 单条连接字段的自洽性：root／next 不用 side／order，branch 必须有 order 与 from。 */
function assertStructure(meta: NodeMeta, where: string): void {
  if (meta.flow === "root") {
    if (meta.from !== null) throw validationError(where + "：root 节点的 from 必须为 null");
    if (meta.side !== undefined || meta.order !== undefined) {
      throw validationError(where + "：root 节点不使用 side／order");
    }
    return;
  }
  if (meta.from === null) {
    throw validationError(where + "：" + meta.flow + " 节点必须声明 from");
  }
  if (meta.flow === "next") {
    if (meta.side !== undefined || meta.order !== undefined) {
      throw validationError(where + "：next 节点不使用 side／order");
    }
    return;
  }
  // branch 的 order 可缺省：既有文件允许缺省，受控新增按 core 的 nextBranchOrder 补默认值。
}

/* ------------------------------------------------------------------ *
 * 操作上下文
 * ------------------------------------------------------------------ */

interface BrokenTopic {
  readonly path: string;
  readonly text: string;
  readonly diagnostics: readonly Diagnostic[];
}

interface Context {
  workspace: WorkspaceMeta;
  workspaceRaw: Record<string, unknown>;
  workspaceNl: string;
  workspaceDirty: boolean;
  topics: Map<string, TopicState>;
  broken: Map<string, BrokenTopic>;
  declared: Map<string, string | null>;
  changed: string[];
  changedSeen: Set<string>;
  notes: StorageDiagnostic[];
  opNames: string[];
}

function markChanged(ctx: Context, nodeId: string): void {
  if (ctx.changedSeen.has(nodeId)) return;
  ctx.changedSeen.add(nodeId);
  ctx.changed.push(nodeId);
}

function brokenHint(ctx: Context): string {
  if (ctx.broken.size === 0) return "";
  return (
    "；工作区还有无法解析的主题（" +
    [...ctx.broken.keys()].join("、") +
    "），需先用 replaceTopic 修复"
  );
}

function findNode(ctx: Context, nodeId: string): { state: TopicState; node: NodeView } | undefined {
  for (const state of ctx.topics.values()) {
    const node = state.nodes.get(nodeId);
    if (node) return { state, node };
  }
  return undefined;
}

function requireNode(ctx: Context, nodeId: string): { state: TopicState; node: NodeView } {
  const found = findNode(ctx, nodeId);
  if (found) return found;
  throw conflict("节点不存在：" + nodeId + brokenHint(ctx), { nodeId });
}

function requireTopic(ctx: Context, topicId: string): TopicState {
  const state = ctx.topics.get(topicId);
  if (state) return state;
  throw conflict("主题不存在：" + topicId + brokenHint(ctx), { topicId });
}

function findStateByPath(ctx: Context, path: string): TopicState | undefined {
  for (const state of ctx.topics.values()) {
    if (state.path === path) return state;
  }
  return undefined;
}

function allChildren(ctx: Context, nodeId: string): Array<{ state: TopicState; node: NodeView }> {
  const children: Array<{ state: TopicState; node: NodeView }> = [];
  const states = [...ctx.topics.values()].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  for (const state of states) {
    for (const node of state.nodes.values()) {
      if (node.meta.from === nodeId) children.push({ state, node });
    }
  }
  return children;
}

function nextChildOf(
  ctx: Context,
  nodeId: string,
): { state: TopicState; node: NodeView } | undefined {
  return allChildren(ctx, nodeId).find((child) => child.node.meta.flow === "next");
}

/** 同源 branch 的默认 order：沿用 core 的规则（已显式 order 的最大值 + 10）。 */
function defaultBranchOrder(ctx: Context, fromId: string): number {
  const orders: number[] = [];
  for (const child of allChildren(ctx, fromId)) {
    if (child.node.meta.flow !== "branch") continue;
    if (child.node.meta.order !== undefined) orders.push(child.node.meta.order);
  }
  return nextBranchOrder(orders);
}

function setActiveNode(ctx: Context, nodeId: string | null): void {
  if (nodeId !== null && !findNode(ctx, nodeId)) {
    throw conflict("讨论焦点节点不存在：" + nodeId, { nodeId });
  }
  if (ctx.workspace.activeNode === nodeId) return;
  ctx.workspace = { ...ctx.workspace, activeNode: nodeId };
  ctx.workspaceDirty = true;
}

/* ------------------------------------------------------------------ *
 * 各操作
 * ------------------------------------------------------------------ */

function applyCreateTopic(ctx: Context, op: CreateTopicOperation): void {
  if (ctx.topics.has(op.topicId)) {
    throw conflict("主题 ID 已存在：" + op.topicId, { topicId: op.topicId });
  }
  const path = requireContentPath(op.path);
  const occupying = findStateByPath(ctx, path);
  if (occupying) {
    throw conflict("该路径已被其他主题占用：" + path, { path, topicId: occupying.topicId });
  }
  if (ctx.broken.has(path)) {
    throw conflict("该路径是现有无法解析的主题，请改用 replaceTopic：" + path, { path });
  }
  ctx.topics.set(op.topicId, newTopicState(op.topicId, path, op.title.trim()));
}

function addCreatedNode(
  ctx: Context,
  state: TopicState,
  nodeId: string,
  title: string,
  body: string,
  meta: NodeMeta,
): void {
  state.nodes.set(nodeId, {
    id: nodeId,
    title: title.trim(),
    body: normalizeNewlines(body, state.nl),
    meta,
    headingStart: 0,
    headingEnd: 0,
    titleRange: null,
    bodyStart: 0,
    bodyEnd: 0,
  });
  appendBlock(
    state,
    nodeId,
    renderNewBlock(nodeId, title.trim(), body, state.nl, state.nl),
  );
  state.everHadNode = true;
  setNodeMeta(state, nodeId, meta);
  resync(state, true);
  markChanged(ctx, nodeId);
}

function applyCreateNode(ctx: Context, op: CreateNodeOperation): void {
  if (findNode(ctx, op.nodeId)) {
    throw conflict("节点 ID 已存在：" + op.nodeId, { nodeId: op.nodeId });
  }
  const state = requireTopic(ctx, op.topicId);
  let order = op.order;
  if (op.flow === "branch" && order === undefined && op.from !== null) {
    requireNode(ctx, op.from);
    order = defaultBranchOrder(ctx, op.from);
  }
  const meta = makeMeta({
    from: op.from,
    flow: op.flow,
    state: op.state,
    side: op.side,
    order,
    label: op.label,
    summary: op.summary,
  });
  assertStructure(meta, "createNode");
  if (op.from !== null) {
    if (op.from === op.nodeId) throw validationError("createNode：节点不能以自身作为 from");
    requireNode(ctx, op.from);
    if (op.flow === "next" && nextChildOf(ctx, op.from)) {
      throw conflict("来源已有 next 后继，请改用 insertNext：" + op.from, { sourceId: op.from });
    }
  }
  addCreatedNode(ctx, state, op.nodeId, op.title, op.body, meta);
}

function applyUpdateNode(ctx: Context, op: UpdateNodeOperation): void {
  const { state, node } = requireNode(ctx, op.nodeId);
  const nextTitle = op.title === undefined ? node.title : op.title.trim();
  const nextBody = op.body === undefined ? node.body : normalizeNewlines(op.body, state.nl);
  const meta: NodeMeta = { ...node.meta };
  let metaChanged = false;
  if (op.state !== undefined && op.state !== meta.state) {
    meta.state = op.state;
    metaChanged = true;
  }
  if (op.summary !== undefined) {
    if (op.summary === null) {
      if (meta.summary !== undefined) {
        delete meta.summary;
        metaChanged = true;
      }
    } else if (meta.summary !== op.summary) {
      meta.summary = op.summary;
      metaChanged = true;
    }
  }
  const blockChanged = nextTitle !== node.title || nextBody !== node.body;
  if (!blockChanged && !metaChanged) {
    ctx.opNames.push("updateNode(no-op)");
    return;
  }
  const nextBlock = blockChanged
    ? patchBlock(state.blocks.get(node.id) ?? "", node, {
        title: nextTitle === node.title ? undefined : nextTitle,
        body: nextBody === node.body ? undefined : nextBody,
        nl: state.nl,
      })
    : (state.blocks.get(node.id) ?? "");
  node.title = nextTitle;
  node.body = nextBody;
  node.meta = meta;
  state.blocks.set(node.id, nextBlock);
  if (metaChanged) setNodeMeta(state, node.id, meta);
  resync(state, true);
  markChanged(ctx, node.id);
}

function applyInsertNext(ctx: Context, op: InsertNextOperation): void {
  const source = requireNode(ctx, op.sourceId);
  const input = op.node;
  if (findNode(ctx, input.nodeId)) {
    throw conflict("节点 ID 已存在：" + input.nodeId, { nodeId: input.nodeId });
  }
  const target = requireTopic(ctx, input.topicId);
  const existingNext = nextChildOf(ctx, op.sourceId);
  const meta = makeMeta({
    from: op.sourceId,
    flow: "next",
    state: input.state,
    label: input.label,
    summary: input.summary,
  });
  assertStructure(meta, "insertNext");

  target.nodes.set(input.nodeId, {
    id: input.nodeId,
    title: input.title.trim(),
    body: normalizeNewlines(input.body, target.nl),
    meta,
    headingStart: 0,
    headingEnd: 0,
    titleRange: null,
    bodyStart: 0,
    bodyEnd: 0,
  });
  const block = renderNewBlock(input.nodeId, input.title.trim(), input.body, target.nl, target.nl);
  if (target === source.state) insertBlockAfter(target, op.sourceId, input.nodeId, block);
  else appendBlock(target, input.nodeId, block);
  target.everHadNode = true;
  setNodeMeta(target, input.nodeId, meta);
  resync(target, true);
  markChanged(ctx, input.nodeId);

  // 原 next 顺延到新节点之后：只改 from，正文区块不动。
  if (existingNext && existingNext.node.id !== input.nodeId) {
    const reconnectMeta: NodeMeta = { ...existingNext.node.meta, from: input.nodeId };
    existingNext.node.meta = reconnectMeta;
    setNodeMeta(existingNext.state, existingNext.node.id, reconnectMeta);
    resync(existingNext.state, true);
    markChanged(ctx, existingNext.node.id);
  }
}

function applyMoveBranch(ctx: Context, op: MoveBranchOperation): void {
  const { state, node } = requireNode(ctx, op.nodeId);
  if (node.meta.flow !== "branch") {
    throw conflict("moveBranch 只接受现有 branch 入口：" + op.nodeId, { nodeId: op.nodeId });
  }
  if (op.from === op.nodeId) throw validationError("moveBranch：节点不能以自身作为 from");
  const source = requireNode(ctx, op.from);
  if (op.order === undefined) {
    throw validationError("moveBranch：必须显式给出 order");
  }
  const meta = makeMeta({
    from: source.node.id,
    flow: "branch",
    state: node.meta.state,
    side: op.side,
    order: op.order,
    label: node.meta.label,
    summary: node.meta.summary,
  });
  node.meta = meta;
  setNodeMeta(state, node.id, meta);
  resync(state, true);
  markChanged(ctx, node.id);
}

function applyMoveNodeToTopic(ctx: Context, op: MoveNodeToTopicOperation): void {
  const { state: source, node } = requireNode(ctx, op.nodeId);
  const target = requireTopic(ctx, op.topicId);
  if (target === source) {
    ctx.opNames.push("moveNodeToTopic(no-op)");
    return;
  }
  const moved = removeBlock(source, op.nodeId);
  if (!moved) throw conflict("节点不存在：" + op.nodeId, { nodeId: op.nodeId });
  resync(source, false);
  target.nodes.set(moved.id, {
    id: moved.id,
    title: moved.title,
    body: moved.body,
    meta: moved.meta,
    headingStart: 0,
    headingEnd: 0,
    titleRange: null,
    bodyStart: 0,
    bodyEnd: 0,
  });
  appendBlock(
    target,
    moved.id,
    renderNewBlock(moved.id, moved.title, moved.body, target.nl, target.nl),
  );
  target.everHadNode = true;
  setNodeMeta(target, moved.id, moved.meta);
  resync(target, true);
  markChanged(ctx, moved.id);
}

function applyReplaceTopic(ctx: Context, op: ReplaceTopicOperation): void {
  const path = requireContentPath(op.path);
  const current = ctx.topics.get(op.topicId);
  const broken = ctx.broken.get(path);
  if (current) {
    if (current.path !== path) {
      throw conflict(
        "replaceTopic 的 path 与现有主题文件不一致：" + op.topicId + " 位于 " + current.path,
        { topicId: op.topicId, path },
      );
    }
  } else if (!broken) {
    throw conflict("replaceTopic 的目标不存在：" + op.topicId + " @ " + path, {
      topicId: op.topicId,
      path,
    });
  }
  const parsed = parseTopicDocument(op.raw, { path });
  if (!parsed.ok || !parsed.topic) {
    throw validationError("replaceTopic 的新原文不是合法主题：" + path, parsed.diagnostics, {
      path,
    });
  }
  if (parsed.topic.topicId !== op.topicId) {
    throw validationError(
      "replaceTopic 新原文的 topicId 与操作不一致：" + parsed.topic.topicId + " ≠ " + op.topicId,
      parsed.diagnostics,
      { path, topicId: op.topicId },
    );
  }
  const scannedText = current ? current.originalText : broken ? broken.text : null;
  const next = stateFromParsed(parsed.topic, {
    path,
    text: op.raw,
    originalText: scannedText,
    existing: true,
  });
  const previousIds = current ? [...current.nodes.keys()] : [];
  ctx.topics.set(op.topicId, next);
  ctx.broken.delete(path);
  const nextIds = new Set(next.nodes.keys());
  for (const id of previousIds) if (!nextIds.has(id)) markChanged(ctx, id);
  for (const id of nextIds) markChanged(ctx, id);
}

function applySetDiscussionFocus(ctx: Context, op: SetDiscussionFocusOperation): void {
  setActiveNode(ctx, op.nodeId);
}

function applyRemoveLeaf(ctx: Context, op: RemoveLeafOperation): void {
  const { state, node } = requireNode(ctx, op.nodeId);
  const children = allChildren(ctx, op.nodeId);
  if (children.length > 0) {
    throw conflict("removeLeaf 不能删除仍有后继的节点，请先显式重接：" + op.nodeId, {
      nodeId: op.nodeId,
      children: children.map((child) => child.node.id),
    });
  }
  removeBlock(state, node.id);
  resync(state, false);
  markChanged(ctx, node.id);
  if (ctx.workspace.activeNode === node.id) {
    ctx.workspace = { ...ctx.workspace, activeNode: null };
    ctx.workspaceDirty = true;
    ctx.notes.push({
      code: "FOCUS_CLEARED",
      message: "讨论焦点节点被删除，activeNode 已清空",
    });
  }
}

function applyMergeNodes(ctx: Context, op: MergeNodesOperation): void {
  const survivor = requireNode(ctx, op.survivorId);
  if (op.mergedNodeIds.includes(op.survivorId)) {
    throw conflict("mergedNodeIds 不能包含 survivorId", { survivorId: op.survivorId });
  }
  if (new Set(op.mergedNodeIds).size !== op.mergedNodeIds.length) {
    throw conflict("mergedNodeIds 含重复节点", { mergedNodeIds: op.mergedNodeIds });
  }
  const merged = new Set(op.mergedNodeIds);
  const mergedNodes = op.mergedNodeIds.map((id) => requireNode(ctx, id));

  const reconnect = new Map<string, MergeReconnectEntry>();
  for (const entry of op.reconnect) {
    if (reconnect.has(entry.nodeId)) {
      throw conflict("reconnect 含重复节点：" + entry.nodeId, { nodeId: entry.nodeId });
    }
    if (merged.has(entry.nodeId)) {
      throw conflict("reconnect 不能包含被合并节点：" + entry.nodeId, { nodeId: entry.nodeId });
    }
    requireNode(ctx, entry.nodeId);
    reconnect.set(entry.nodeId, entry);
  }

  // 所有从被合并节点指出的边都必须显式重接，绝不猜测。
  const required = new Set<string>();
  for (const mergedId of merged) {
    for (const child of allChildren(ctx, mergedId)) {
      if (!merged.has(child.node.id)) required.add(child.node.id);
    }
  }
  const missing = [...required].filter((id) => !reconnect.has(id));
  if (missing.length > 0) {
    throw conflict("被合并节点的后继必须在 reconnect 中显式重接", {
      missingReconnect: missing,
      mergedNodeIds: [...merged],
    });
  }
  if (
    survivor.node.meta.from !== null &&
    merged.has(survivor.node.meta.from) &&
    !reconnect.has(op.survivorId)
  ) {
    throw conflict("survivor 的 from 指向被合并节点，必须在 reconnect 中显式重接", {
      survivorId: op.survivorId,
    });
  }

  for (const entry of op.reconnect) {
    if (entry.from !== null && merged.has(entry.from)) {
      throw conflict("reconnect 不能指向被合并的节点：" + entry.nodeId, { nodeId: entry.nodeId });
    }
    const target = requireNode(ctx, entry.nodeId);
    if (entry.from !== null) requireNode(ctx, entry.from);
    if (entry.from === entry.nodeId) {
      throw validationError("reconnect：节点不能以自身作为 from：" + entry.nodeId);
    }
    const meta = makeMeta({
      from: entry.from,
      flow: entry.flow,
      state: target.node.meta.state,
      side: entry.side,
      order: entry.order,
      label: entry.label === undefined ? target.node.meta.label : entry.label,
      summary: target.node.meta.summary,
    });
    assertStructure(meta, "mergeNodes.reconnect");
    target.node.meta = meta;
    setNodeMeta(target.state, target.node.id, meta);
    resync(target.state, true);
    markChanged(ctx, target.node.id);
  }

  for (const mergedNode of mergedNodes) {
    removeBlock(mergedNode.state, mergedNode.node.id);
    resync(mergedNode.state, false);
    markChanged(ctx, mergedNode.node.id);
  }

  const body = normalizeNewlines(op.body, survivor.state.nl);
  const survivorBlock = survivor.state.blocks.get(survivor.node.id) ?? "";
  survivor.node.body = body;
  survivor.state.blocks.set(
    survivor.node.id,
    patchBlock(survivorBlock, survivor.node, { body, nl: survivor.state.nl }),
  );
  resync(survivor.state, true);
  markChanged(ctx, op.survivorId);

  if (op.activeNode !== null && merged.has(op.activeNode)) {
    throw conflict("activeNode 不能指向被合并的节点：" + op.activeNode, {
      nodeId: op.activeNode,
    });
  }
  setActiveNode(ctx, op.activeNode);
}

function applyOperation(ctx: Context, op: Operation): void {
  ctx.opNames.push(op.op);
  switch (op.op) {
    case "createTopic":
      applyCreateTopic(ctx, op);
      return;
    case "createNode":
      applyCreateNode(ctx, op);
      return;
    case "updateNode":
      applyUpdateNode(ctx, op);
      return;
    case "insertNext":
      applyInsertNext(ctx, op);
      return;
    case "moveBranch":
      applyMoveBranch(ctx, op);
      return;
    case "moveNodeToTopic":
      applyMoveNodeToTopic(ctx, op);
      return;
    case "replaceTopic":
      applyReplaceTopic(ctx, op);
      return;
    case "setDiscussionFocus":
      applySetDiscussionFocus(ctx, op);
      return;
    case "removeLeaf":
      applyRemoveLeaf(ctx, op);
      return;
    case "mergeNodes":
      applyMergeNodes(ctx, op);
      return;
    default: {
      const exhaustive: never = op;
      throw badRequest("未知操作：" + String(exhaustive));
    }
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

function normalizeDeclaredFiles(
  expectedFiles: Record<string, string | null>,
): Map<string, string | null> {
  const declared = new Map<string, string | null>();
  for (const [rawPath, hash] of Object.entries(expectedFiles)) {
    const path = requireContentPath(rawPath);
    if (declared.has(path)) {
      throw badRequest("expectedFiles 规范化后重复声明同一路径：" + path);
    }
    declared.set(path, hash);
  }
  return declared;
}

interface WorkspaceIdentity {
  meta: WorkspaceMeta;
  raw: Record<string, unknown>;
  nl: string;
}

/** workspace.json 按完整原始 JSON 严格校验：不先丢弃 extra 字段再通过。 */
function readWorkspaceIdentity(files: WorkspaceFiles): WorkspaceIdentity {
  const text = files.workspaceFile.text;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw validationError("workspace.json 不是合法 JSON", [], { reason: String(error) });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw validationError("workspace.json 必须是 JSON 对象");
  }
  const parsed = workspaceMetaSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError("workspace.json 结构不合法", [], { issues: issueList(parsed.error) });
  }
  return { meta: parsed.data, raw: raw as Record<string, unknown>, nl: detectNewline(text) };
}

/** 全量核对 expectedFiles：不只 touched，缺声明与哈希不符都拒绝。 */
function verifyExpectedFiles(files: WorkspaceFiles, declared: Map<string, string | null>): void {
  const actual = new Map<string, string>();
  actual.set("workspace.json", files.workspaceFile.sha256);
  for (const topic of files.topics) actual.set(topic.path, topic.sha256);
  const conflicts: Array<{
    path: string;
    expectedSha256: string | null;
    actualSha256: string | null;
  }> = [];
  for (const [path, expected] of declared) {
    const actualSha256 = actual.get(path) ?? null;
    if (actualSha256 !== expected) conflicts.push({ path, expectedSha256: expected, actualSha256 });
  }
  if (conflicts.length > 0) {
    throw new ChangeError("VERSION_CONFLICT", "expectedFiles 与实际文件哈希不符", {
      details: { conflicts },
    });
  }
}

function loadTopics(ctx: Context, files: WorkspaceFiles): void {
  for (const file of files.topics) {
    const parsed = parseTopicDocument(file.text, { path: file.path });
    if (!parsed.ok || !parsed.topic) {
      ctx.broken.set(file.path, {
        path: file.path,
        text: file.text,
        diagnostics: parsed.diagnostics,
      });
      continue;
    }
    if (ctx.topics.has(parsed.topic.topicId)) {
      throw validationError("工作区存在重复主题 ID：" + parsed.topic.topicId, parsed.diagnostics, {
        path: file.path,
      });
    }
    ctx.topics.set(
      parsed.topic.topicId,
      stateFromParsed(parsed.topic, {
        path: file.path,
        text: file.text,
        originalText: file.text,
        existing: true,
      }),
    );
  }
}

/**
 * 现有主题无法解析时，本批必须包含针对它的 replaceTopic；
 * 其他操作不能基于"旧快照里看起来还能用"的结构继续执行。
 */
function requireBrokenTopicsRepaired(ctx: Context, operations: readonly Operation[]): void {
  if (ctx.broken.size === 0) return;
  const repaired = new Set<string>();
  for (const op of operations) {
    if (op.op !== "replaceTopic") continue;
    try {
      repaired.add(normalizeRelativePath(op.path));
    } catch {
      continue;
    }
  }
  const unrepaired = [...ctx.broken.keys()].filter((path) => !repaired.has(path));
  if (unrepaired.length === 0) return;
  const diagnostics: Diagnostic[] = [];
  for (const path of unrepaired) diagnostics.push(...(ctx.broken.get(path)?.diagnostics ?? []));
  throw validationError(
    "工作区存在无法解析的主题，必须在本批用 replaceTopic 修复：" + unrepaired.join("、"),
    diagnostics,
    { paths: unrepaired },
  );
}

function sortedStates(ctx: Context): TopicState[] {
  return [...ctx.topics.values()].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
}

function serializeWorkspace(ctx: Context): string {
  const record: Record<string, unknown> = {
    ...ctx.workspaceRaw,
    activeNode: ctx.workspace.activeNode,
  };
  return normalizeNewlines(JSON.stringify(record, null, 2) + "\n", ctx.workspaceNl);
}

function buildSummary(ctx: Context, output: readonly CommitFileInput[]): string {
  if (output.length === 0) {
    return ctx.opNames.length === 0
      ? "无操作，未产生文件变化"
      : "无实际文件变化（" + ctx.opNames.join("、") + "）";
  }
  const names = [...new Set(ctx.opNames)];
  return (
    ctx.opNames.length +
    " 个操作（" +
    names.join("、") +
    "），影响 " +
    output.length +
    " 个文件：" +
    output.map((file) => file.path + (file.content === null ? "(删除)" : "")).join("、")
  );
}

/**
 * 纯同步准备一次变更集合：只变换本次扫描的文本并做整份工作区校验。
 * 不读取／写入磁盘、不获取锁、不发布快照；调用方把 files 交给 commitFiles。
 *
 * 仅用于格式 1（一个主题文件内多张卡）；格式 2 见 prepareChangesV2，
 * 统一入口见 prepareChangesForWorkspace。
 */
export function prepareChanges(files: WorkspaceFiles, request: ChangeRequest): PreparedChanges {
  // 格式分派：本模块只处理"一个主题文件内多张卡"的格式 1。
  // 格式 2 的节点是一份独立文件，由 prepareChangesV2 处理；不在此猜测或混写。
  if (files.workspace.schemaVersion !== 1) {
    throw new ChangeError(
      "BAD_REQUEST",
      "该工作区是 schemaVersion " +
        files.workspace.schemaVersion +
        "；格式 2 请使用 prepareChangesV2（一节点一份 Markdown），不要按格式 1 写入",
      { details: { schemaVersion: files.workspace.schemaVersion } },
    );
  }
  const parsedRequest = changeRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw badRequest("变更请求结构不合法", { issues: issueList(parsedRequest.error) });
  }
  const validated = parsedRequest.data;

  if (validated.workspaceId !== files.workspace.workspaceId) {
    throw badRequest("workspaceId 与当前工作区不一致", {
      expectedWorkspaceId: files.workspace.workspaceId,
      workspaceId: validated.workspaceId,
    });
  }

  const declared = normalizeDeclaredFiles(validated.expectedFiles);
  verifyExpectedFiles(files, declared);

  const identity = readWorkspaceIdentity(files);
  if (identity.meta.workspaceId !== validated.workspaceId) {
    throw badRequest("workspaceId 与 workspace.json 不一致", {
      expectedWorkspaceId: identity.meta.workspaceId,
      workspaceId: validated.workspaceId,
    });
  }

  const ctx: Context = {
    workspace: identity.meta,
    workspaceRaw: identity.raw,
    workspaceNl: identity.nl,
    workspaceDirty: false,
    topics: new Map(),
    broken: new Map(),
    declared,
    changed: [],
    changedSeen: new Set(),
    notes: [],
    opNames: [],
  };
  loadTopics(ctx, files);
  requireBrokenTopicsRepaired(ctx, validated.operations);

  for (const op of validated.operations) applyOperation(ctx, op);

  for (const state of ctx.topics.values()) {
    if (!state.existing && !state.everHadNode) {
      throw conflict("createTopic 必须在同一批次中创建首张卡片：" + state.topicId, {
        topicId: state.topicId,
        path: state.path,
      });
    }
    if (state.order.length > 0) resync(state, false);
    state.text = renderText(state);
  }

  if (ctx.broken.size > 0) {
    const diagnostics: Diagnostic[] = [];
    for (const broken of ctx.broken.values()) diagnostics.push(...broken.diagnostics);
    throw validationError(
      "工作区仍有无法解析的主题，需先用 replaceTopic 修复：" + [...ctx.broken.keys()].join("、"),
      diagnostics,
      { paths: [...ctx.broken.keys()] },
    );
  }

  const parsedTopics: ParsedTopic[] = [];
  for (const state of sortedStates(ctx)) {
    if (state.order.length === 0) continue; // 空主题按本批显式删除处理
    const result = parseTopicDocument(state.text, { path: state.path });
    if (!result.ok || !result.topic) {
      throw validationError("候选主题无法通过解析：" + state.path, result.diagnostics, {
        path: state.path,
      });
    }
    if (result.topic.topicId !== state.topicId) {
      throw validationError("候选主题的 topicId 发生变化：" + state.path);
    }
    parsedTopics.push(result.topic);
  }

  const validation = validateWorkspace({ workspace: ctx.workspace, topics: parsedTopics });
  if (!validation.ok) throw validationError("候选工作区未通过图校验", validation.diagnostics);

  const output: CommitFileInput[] = [];
  const missing: string[] = [];

  const workspaceDeclared = declared.get("workspace.json");
  if (ctx.workspaceDirty) {
    if (workspaceDeclared === undefined) missing.push("workspace.json");
    else {
      output.push({
        path: "workspace.json",
        content: serializeWorkspace(ctx),
        expectedSha256: workspaceDeclared,
      });
    }
  }

  for (const state of sortedStates(ctx)) {
    const expected = declared.get(state.path);
    if (state.order.length === 0) {
      // 主题清空：显式输出 content:null 删除源文件；本批新建后清空则从未落盘。
      if (!state.existing) continue;
      if (expected === undefined) missing.push(state.path);
      else output.push({ path: state.path, content: null, expectedSha256: expected });
      continue;
    }
    if (state.existing && state.text === state.originalText) continue;
    if (expected === undefined) missing.push(state.path);
    else output.push({ path: state.path, content: state.text, expectedSha256: expected });
  }

  if (missing.length > 0) {
    throw conflict("缺少前置文件声明，调用方需重新读取后再提交", { missingFiles: missing });
  }

  return {
    files: output,
    changedNodeIds: ctx.changed,
    diagnostics: [...files.diagnostics, ...ctx.notes],
    summary: buildSummary(ctx, output),
  };
}

/**
 * 按工作区实际格式分派候选计算。
 *
 * 调用方（service／CLI）不需要知道当前工作区是哪种格式：这里读 workspace.schemaVersion 后
 * 交给对应实现；未知版本直接拒绝，绝不"猜一个格式"写入。
 */
export function prepareChangesForWorkspace(
  files: WorkspaceFiles,
  request: AnyChangeRequest,
): PreparedChanges {
  if (files.workspace.schemaVersion === 2) {
    return prepareChangesV2(files, request as V2ChangeRequest);
  }
  if (files.workspace.schemaVersion === 1) {
    return prepareChanges(files, request as ChangeRequest);
  }
  throw new ChangeError("BAD_REQUEST", "不支持的工作区格式", {
    details: { schemaVersion: String(files.workspace.schemaVersion) },
  });
}

/* ------------------------------------------------------------------ *
 * 版本无关的请求外壳
 * ------------------------------------------------------------------ */

/** 两版请求的外层结构相同：workspaceId／requestId／expectedFiles／operations。 */
export type AnyChangeRequest = ChangeRequest | V2ChangeRequest;

/**
 * 严格联合：先用格式 1 的 strict schema，再用格式 2 的 strict schema，两者都原样复用。
 *
 * 只组合已有 schema，不复制操作字段，所以两版规则仍是单一来源。
 * 用 union 而非 discriminatedUnion：两版共用的 op 名（updateNode／createTopic 等）字段不同，
 * 必须按完整形状判定，不能只看 op 名。
 */
export const anyChangeRequestSchema = z.union([changeRequestSchema, v2ChangeRequestSchema]);
