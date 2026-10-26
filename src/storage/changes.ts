/**
 * 当前格式（一节点一份 Markdown）的候选变换。
 *
 * 只做纯文本变换：输入是本次扫描到的原始文本，输出是 CommitFileInput；不读盘、不取锁、不写缓存。
 * 解析与整图校验一律交给 core.parseWorkspaceDocuments，本模块不复制目录解析或 schema。
 *
 * 结构约定：
 * - 一个节点 = 一份文件，改标题／状态只改该文件的 YAML 头，改正文只换头部之后的正文；
 * - 主题入口 topic.md 只保存 topicId／title，没有节点总表；
 * - 节点正文没有 H2 卡片标记，旧注释不会被写入或当作结构；
 * - description 属于连接（为什么 A 接到 B），改接来源时必须显式重新确认。
 */
import { changeRequestSchema } from "./changes/request.js";
import type {
  PatchNodeOperation,
  UpdateConnectionOperation,
  CreateTopicOperation,
  CreateNodeOperation,
  UpdateNodeOperation,
  MoveNodeToTopicOperation,
  RemoveLeafOperation,
  SetDiscussionFocusOperation,
  SetImportanceOperation,
  ReplaceNodeSourceOperation,
  Operation,
  ChangeRequest,
} from "./changes/request.js";
export * from "./changes/request.js";
import {
  renderNodeText,
  nodeStateFrom,
  headerFromParsed,
  topicStateFrom,
} from "./changes/text.js";
import type { NodeFileState, TopicState } from "./changes/text.js";
import {
  nextBranchOrder,
  parseWorkspaceDocuments,
  type Diagnostic,
  type ParsedNode,
  type NodeHeader,
  type WorkspaceMeta,
} from "../core/index.js";
import type { StorageDiagnostic } from "./errors.js";
import type { CommitFileInput } from "./transactions.js";
import type { WorkspaceFiles } from "./workspace.js";
import {
  TOPIC_META_FILENAME,
  nodePath,
  renderTopicMetaText,
  topicMetaPath,
} from "./format.js";
import { normalizeNewlines } from "../core/newlines.js";
// 共享契约放在最底层模块，避免候选实现与公共工具形成循环。
import {
  ChangeError,
  badRequest,
  conflict,
  validationError,
} from "./changes/shared.js";
import type { ChangeErrorCode, PreparedChanges } from "./changes/shared.js";
import {
  buildSummary,
  normalizeDeclaredFiles,
  readWorkspaceIdentity,
  serializeWorkspace,
  verifyExpectedFiles,
  zodIssues,
} from "./changes/common.js";

export { ChangeError };
export type { ChangeErrorCode };

/** 候选编辑的共同返回形状；调用方把 files 直接交给 commitFiles。 */
export type { PreparedChanges };

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

/** 无法解析的现有文件：只有针对该文件的源码修复才能处理。 */
interface BrokenFile {
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
  nodes: Map<string, NodeFileState>;
  broken: Map<string, BrokenFile>;
  declared: Map<string, string | null>;
  changed: string[];
  changedSeen: Set<string>;
  /** 源文件内容真正被改写的节点；仅改重要性等元数据不进入这里。 */
  content: string[];
  contentSeen: Set<string>;
  notes: StorageDiagnostic[];
  opNames: string[];
}

/**
 * 载入扫描事实。
 *
 * 解析失败时把出问题的文件记进 broken，并立刻拒绝：其余操作不能在"半懂"的结构上继续；
 * 只有同一批的源码修复可以针对这些具体文件重建。
 */
function loadWorkspace(files: WorkspaceFiles, ctx: Context): void {
  const documents = files.topics.map((file) => ({ path: file.path, text: file.text }));
  const byPath = new Map(files.topics.map((file) => [file.path, file]));
  const result = parseWorkspaceDocuments({ workspace: ctx.workspace, documents });
  if (!result.ok) {
    for (const diagnostic of result.diagnostics) {
      const path = diagnostic.topicPath;
      if (path === undefined) continue;
      const file = byPath.get(path);
      if (!file) continue;
      const existing = ctx.broken.get(path);
      ctx.broken.set(path, {
        path,
        text: file.text,
        diagnostics: existing ? [...existing.diagnostics, diagnostic] : [diagnostic],
      });
    }
    throw validationError(
      "当前磁盘内容无法通过校验：先用源码修复操作（replaceTopic／replaceNodeSource）改正具体文件",
      result.diagnostics,
    );
  }
  for (const topic of result.topics) {
    ctx.topics.set(topic.topicId, topicStateFrom(topic, byPath.get(topic.document.path)));
    for (const node of topic.nodes) {
      const file = byPath.get(node.sourcePath);
      const header = headerFromParsed(node);
      ctx.nodes.set(
        node.id,
        nodeStateFrom({
          path: node.sourcePath,
          text: file?.text ?? "",
          node,
          header,
          originalText: file?.text ?? null,
          created: false,
        }),
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 上下文工具
 * ------------------------------------------------------------------ */

function markChanged(ctx: Context, nodeId: string): void {
  if (ctx.changedSeen.has(nodeId)) return;
  ctx.changedSeen.add(nodeId);
  ctx.changed.push(nodeId);
}

/**
 * 记录"节点文件被真实改写"。
 *
 * 与 markChanged 分开：changedNodeIds 也包含被删除的节点与仅改重要性的节点，
 * 而最近一次内容更新只算前者之外的"新建或实际改写"。
 */
function markContent(ctx: Context, nodeId: string): void {
  markChanged(ctx, nodeId);
  if (ctx.contentSeen.has(nodeId)) return;
  ctx.contentSeen.add(nodeId);
  ctx.content.push(nodeId);
}

function requireNode(ctx: Context, nodeId: string): NodeFileState {
  const node = ctx.nodes.get(nodeId);
  if (node) return node;
  throw conflict("节点不存在：" + nodeId, { nodeId });
}

/** 主题既可用稳定 ID，也可用目录名定位；两者都不命中才拒绝。 */
function requireTopic(ctx: Context, ref: string): TopicState {
  const byId = ctx.topics.get(ref);
  if (byId) return byId;
  const byDir = [...ctx.topics.values()].filter((topic) => topic.dir === ref);
  if (byDir.length === 1) return byDir[0] as TopicState;
  throw conflict("主题不存在：" + ref, { topicId: ref });
}

function childrenOf(ctx: Context, nodeId: string): NodeFileState[] {
  return [...ctx.nodes.values()]
    .filter((node) => node.header.from === nodeId)
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId, "en"));
}

function nextChildOf(ctx: Context, nodeId: string): NodeFileState | undefined {
  return childrenOf(ctx, nodeId).find((node) => node.header.flow === "next");
}
/** 同源 branch 的默认 order：沿用 core 的 nextBranchOrder（max+10，无分支时 10）。 */
function defaultBranchOrder(ctx: Context, fromId: string): number {
  const orders = childrenOf(ctx, fromId)
    .filter((node) => node.header.flow === "branch")
    .map((node) => node.header.order)
    .filter((value): value is number => value !== undefined);
  return nextBranchOrder(orders);
}

function setActiveNode(ctx: Context, nodeId: string | null): void {
  if (nodeId !== null) requireNode(ctx, nodeId);
  if (ctx.workspace.activeNode === nodeId) return;
  ctx.workspace = { ...ctx.workspace, activeNode: nodeId };
  ctx.workspaceDirty = true;
}

/** 结构字段自洽性：root 不写 description／side／order，非 root 必须有 from 与 description。 */
function assertHeaderShape(header: NodeHeader, where: string): void {
  if (header.flow === "root") {
    if (header.from !== null) throw validationError(where + "：root 的 from 必须为 null");
    if (header.description !== undefined) {
      throw validationError(where + "：root 不写 description（没有来源可解释）");
    }
    if (header.side !== undefined || header.order !== undefined) {
      throw validationError(where + "：root 不使用 side／order");
    }
    return;
  }
  if (header.from === null) throw validationError(where + "：" + header.flow + " 必须声明 from");
  if (header.description === undefined) {
    throw validationError(where + "：非 root 必须写 description，说明为什么接到来源");
  }
  if (header.flow === "next" && (header.side !== undefined || header.order !== undefined)) {
    throw validationError(where + "：next 不使用 side／order");
  }
}

/* ------------------------------------------------------------------ *
 * 各操作
 * ------------------------------------------------------------------ */

function applyCreateTopic(ctx: Context, op: CreateTopicOperation): void {
  if (ctx.topics.has(op.topicId)) {
    throw conflict("主题 ID 已存在：" + op.topicId, { topicId: op.topicId });
  }
  const dir = op.path.trim().replace(/^\/+|\/+$/g, "");
  if (dir.length === 0 || dir.includes("/") || dir.includes("\\")) {
    throw badRequest("主题目录名必须是 topics 下的一层目录名：" + op.path);
  }
  if (dir === TOPIC_META_FILENAME || dir.startsWith(".")) {
    throw badRequest("主题目录名不能是保留名或以点开头：" + op.path);
  }
  if ([...ctx.topics.values()].some((topic) => topic.dir === dir)) {
    throw conflict("该主题目录已被占用：" + dir, { path: topicMetaPath(dir) });
  }
  const metaPath = topicMetaPath(dir);
  if (ctx.broken.has(metaPath)) {
    throw conflict("该主题入口是现有无法解析的文件，请改用源码修复：" + metaPath, { path: metaPath });
  }
  const state: TopicState = {
    topicId: op.topicId,
    dir,
    title: op.title.trim(),
    metaPath,
    metaText: "",
    metaOriginal: null,
    nl: "\n",
    created: true,
  };
  state.metaText = renderTopicMetaText({
    topicId: state.topicId,
    title: state.title,
    nl: state.nl,
  });
  ctx.topics.set(op.topicId, state);
}

function applyCreateNode(ctx: Context, op: CreateNodeOperation): void {
  if (ctx.nodes.has(op.nodeId)) {
    throw conflict("节点 ID 已存在：" + op.nodeId, { nodeId: op.nodeId });
  }
  const topic = requireTopic(ctx, op.topicId);
  let order = op.order;
  if (op.flow === "branch" && order === undefined && op.from !== null) {
    requireNode(ctx, op.from);
    order = defaultBranchOrder(ctx, op.from);
  }
  const header: NodeHeader = {
    nodeId: op.nodeId,
    title: op.title.trim(),
    state: op.state,
    from: op.from,
    flow: op.flow,
  };
  if (op.description !== undefined) header.description = op.description.trim();
  if (op.side !== undefined) header.side = op.side;
  if (order !== undefined) header.order = order;
  if (op.summary !== undefined) header.summary = op.summary.trim();
  if (op.important === true) header.important = true;
  assertHeaderShape(header, "createNode");
  if (op.from !== null) {
    if (op.from === op.nodeId) throw validationError("createNode：节点不能以自身作为 from");
    requireNode(ctx, op.from);
    if (op.flow === "next" && nextChildOf(ctx, op.from)) {
      throw conflict("来源已有 next 后继，请改用 insertNext 的等价做法或先重接：" + op.from, {
        sourceId: op.from,
      });
    }
  }
  const path = nodePath(topic.dir, op.nodeId);
  const state: NodeFileState = {
    nodeId: op.nodeId,
    topicId: topic.topicId,
    dir: topic.dir,
    path,
    header,
    body: normalizeNewlines(op.body, "\n"),
    headOpen: "---\n",
    bodyPrefix: "\n",
    bodyTail: "\n",
    // 新节点没有旧头，扫描快照用一个"必然不等"的占位，确保按字段重新序列化。
    originalHeaderYaml: "",
    scannedHeader: { ...header, nodeId: "", title: "" },
    nl: "\n",
    originalText: null,
    created: true,
  };
  ctx.nodes.set(op.nodeId, state);
  markContent(ctx, op.nodeId);
}

function applyUpdateNode(ctx: Context, op: UpdateNodeOperation): void {
  const node = requireNode(ctx, op.nodeId);
  const nextTitle = op.title === undefined ? node.header.title : op.title.trim();
  const nextBody = op.body === undefined ? node.body : op.body;
  const nextState = op.state === undefined ? node.header.state : op.state;
  const nextHeader: NodeHeader = { ...node.header, title: nextTitle, state: nextState };
  let metaChanged = nextTitle !== node.header.title || nextState !== node.header.state;
  if (op.summary !== undefined) {
    if (op.summary === null) {
      if (nextHeader.summary !== undefined) {
        delete nextHeader.summary;
        metaChanged = true;
      }
    } else if (nextHeader.summary !== op.summary.trim()) {
      nextHeader.summary = op.summary.trim();
      metaChanged = true;
    }
  }
  const bodyChanged = nextBody !== node.body;
  if (!metaChanged && !bodyChanged) {
    ctx.opNames.push("updateNode(no-op)");
    return;
  }
  node.header = nextHeader;
  if (bodyChanged) node.body = nextBody;
  markContent(ctx, node.nodeId);
}

/**
 * 局部改正文：replace 的 old 必须在正文中恰好出现一次，否则整体拒绝。
 * 不做全局替换，也不回退成"没找到就算了"。
 */
function applyPatchNode(ctx: Context, op: PatchNodeOperation): void {
  const node = requireNode(ctx, op.nodeId);
  const nextHeader: NodeHeader = { ...node.header };
  let metaChanged = false;
  if (op.title !== undefined && op.title.trim() !== nextHeader.title) {
    nextHeader.title = op.title.trim();
    metaChanged = true;
  }
  if (op.state !== undefined && op.state !== nextHeader.state) {
    nextHeader.state = op.state;
    metaChanged = true;
  }
  if (op.summary !== undefined) {
    if (op.summary === null) {
      if (nextHeader.summary !== undefined) {
        delete nextHeader.summary;
        metaChanged = true;
      }
    } else if (nextHeader.summary !== op.summary.trim()) {
      nextHeader.summary = op.summary.trim();
      metaChanged = true;
    }
  }

  let nextBody = node.body;
  let bodyChanged = false;
  if (op.replace !== undefined) {
    for (const replacement of op.replace) {
      const occurrences = countOccurrences(nextBody, replacement.old);
      if (occurrences === 0) {
        throw conflict("replace.old 在正文中未找到，拒绝修改：" + truncateForMessage(replacement.old), {
          nodeId: op.nodeId,
          reason: "NOT_FOUND",
        });
      }
      if (occurrences > 1) {
        throw conflict("replace.old 在正文中不唯一，拒绝全局替换：" + truncateForMessage(replacement.old), {
          nodeId: op.nodeId,
          reason: "NOT_UNIQUE",
          occurrences,
        });
      }
      nextBody = nextBody.replace(replacement.old, replacement.new);
      bodyChanged = true;
    }
  } else if (op.append !== undefined) {
    // 追加规范化在这里统一：去掉首部空行、去掉末尾空白，再在非空 base 后
    // 插入恰好一个空行。调用方（JSON 字符串／bodyFile／appendFile）不必自己补换行。
    const addition = op.append
      .replace(/^(?:[ \t]*\r?\n)+/, "")
      .replace(/\s+$/, "");
    if (addition.length > 0) {
      const base = nextBody.replace(/\s+$/, "");
      nextBody = base.length === 0 ? addition : base + "\n\n" + addition;
      bodyChanged = true;
    }
  } else if (op.body !== undefined) {
    nextBody = op.body;
    bodyChanged = nextBody !== node.body;
  }

  if (!metaChanged && !bodyChanged) {
    ctx.opNames.push("patchNode(no-op)");
    return;
  }
  if (metaChanged) node.header = nextHeader;
  if (bodyChanged) node.body = nextBody;
  markContent(ctx, node.nodeId);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function truncateForMessage(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= 60 ? single : single.slice(0, 60) + "…";
}

/**
 * 连接更新：改接来源时 description 必须显式给出。
 * 旧描述解释的是旧边，直接沿用到新边会留下错误理由。
 */
function applyUpdateConnection(ctx: Context, op: UpdateConnectionOperation): void {
  const node = requireNode(ctx, op.nodeId);
  const header: NodeHeader = { ...node.header };
  const nextFlow = op.flow ?? header.flow;
  const fromChanged = op.from !== undefined && op.from !== header.from;

  if (op.from !== undefined) {
    header.from = op.from;
    if (op.from !== null) {
      if (op.from === node.nodeId) throw validationError("updateConnection：节点不能以自身作为 from");
      requireNode(ctx, op.from);
    }
  }
  header.flow = nextFlow;
  if (op.side !== undefined) header.side = op.side;
  if (op.order !== undefined) header.order = op.order;

  if (nextFlow === "root") {
    header.from = null;
    delete header.description;
    delete header.side;
    delete header.order;
  } else if (nextFlow === "next") {
    delete header.side;
    delete header.order;
    if (header.from !== null) {
      const existing = nextChildOf(ctx, header.from);
      if (existing && existing.nodeId !== node.nodeId) {
        throw conflict("该来源已有 next 后继，不能隐式挤掉：" + existing.nodeId, {
          sourceId: header.from,
          nextId: existing.nodeId,
        });
      }
    }
  } else if (nextFlow === "branch") {
    if (header.order === undefined) {
      header.order = header.from === null ? 10 : defaultBranchOrder(ctx, header.from);
    }
  }

  if (fromChanged && op.description === undefined && header.description !== undefined) {
    throw conflict("改接来源必须显式重新确认 description（旧描述解释的是旧连接）", {
      nodeId: op.nodeId,
      previousDescription: header.description,
    });
  }
  if (op.description !== undefined) header.description = op.description.trim();
  assertHeaderShape(header, "updateConnection");
  node.header = header;
  markContent(ctx, node.nodeId);
}

function applyMoveNodeToTopic(ctx: Context, op: MoveNodeToTopicOperation): void {
  const node = requireNode(ctx, op.nodeId);
  const topic = requireTopic(ctx, op.topicId);
  if (topic.topicId === node.topicId) {
    ctx.opNames.push("moveNodeToTopic(no-op)");
    return;
  }
  // 保留 ID、连接、状态与正文；只改变归组目录与真实文件路径。
  node.topicId = topic.topicId;
  node.dir = topic.dir;
  node.path = nodePath(topic.dir, node.nodeId);
  markContent(ctx, node.nodeId);
}

function applyRemoveLeaf(ctx: Context, op: RemoveLeafOperation): void {
  requireNode(ctx, op.nodeId);
  const children = childrenOf(ctx, op.nodeId);
  if (children.length > 0) {
    throw conflict("removeLeaf 不能删除仍有后继的节点，请先显式重接：" + op.nodeId, {
      nodeId: op.nodeId,
      children: children.map((child) => child.nodeId),
    });
  }
  ctx.nodes.delete(op.nodeId);
  markChanged(ctx, op.nodeId);
  if (ctx.workspace.activeNode === op.nodeId) {
    ctx.workspace = { ...ctx.workspace, activeNode: null };
    ctx.workspaceDirty = true;
    ctx.notes.push({
      code: "FOCUS_CLEARED",
      message: "讨论焦点节点被删除，activeNode 已清空",
    });
  }
}

/**
 * 重要标记：只写节点头的 important；false 表示删除该字段（文件恢复干净）。
 * 值未变时视为 no-op，不写文件、不改动任何节点。
 */
function applySetImportance(ctx: Context, op: SetImportanceOperation): void {
  const node = requireNode(ctx, op.nodeId);
  const current = node.header.important === true;
  if (current === op.important) {
    ctx.opNames.push("setImportance(no-op)");
    return;
  }
  const header: NodeHeader = { ...node.header };
  if (op.important) header.important = true;
  else delete header.important;
  node.header = header;
  // 只改这一项元数据：磁盘文件确实被改写，但不计入"最近一次内容更新"。
  markChanged(ctx, node.nodeId);
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
    case "patchNode":
      applyPatchNode(ctx, op);
      return;
    case "updateConnection":
      applyUpdateConnection(ctx, op);
      return;
    case "moveNodeToTopic":
      applyMoveNodeToTopic(ctx, op);
      return;
    case "removeLeaf":
      applyRemoveLeaf(ctx, op);
      return;
    case "setDiscussionFocus":
      setActiveNode(ctx, op.nodeId);
      return;
    case "setImportance":
      applySetImportance(ctx, op);
      return;
    case "replaceNodeSource":
      throw badRequest("replaceNodeSource 只能用于修复无法解析的文件，当前工作区解析正常");
    default: {
      const exhaustive: never = op;
      throw badRequest("未知操作：" + String(exhaustive));
    }
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 纯同步准备一次变更集合。
 *
 * 顺序：结构校验 → workspaceId 与身份核对 → 全量 expectedFiles 核对 → core 解析当前磁盘
 * → 按顺序应用操作 → 用候选文本重建并全图校验 → 只输出真正变化的文件。
 * 不读盘、不取锁、不提交；旧哈希一律取自调用方声明，绝不替它补。
 */
export function prepareChanges(files: WorkspaceFiles, request: ChangeRequest): PreparedChanges {
  const parsedRequest = changeRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw badRequest("变更请求结构不合法", { issues: zodIssues(parsedRequest.error) });
  }
  const validated = parsedRequest.data;

  if (validated.workspaceId !== files.workspace.workspaceId) {
    throw badRequest("workspaceId 与当前工作区不一致", {
      expectedWorkspaceId: files.workspace.workspaceId,
      workspaceId: validated.workspaceId,
    });
  }

  const declared = normalizeDeclaredFiles(validated.expectedFiles, (rawPath) =>
    rawPath.replace(/\\/g, "/"),
  );
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
    nodes: new Map(),
    broken: new Map(),
    declared,
    changed: [],
    changedSeen: new Set(),
    content: [],
    contentSeen: new Set(),
    notes: [],
    opNames: [],
  };

  loadWorkspace(files, ctx);
  for (const op of validated.operations) applyOperation(ctx, op);

  // 主题不能只剩空目录：清空后的主题按显式删除处理。
  const topicHasNodes = new Set([...ctx.nodes.values()].map((node) => node.topicId));
  for (const topic of ctx.topics.values()) {
    if (topic.created && !topicHasNodes.has(topic.topicId)) {
      throw conflict("createTopic 必须在同一批次中创建首张卡片：" + topic.topicId, {
        topicId: topic.topicId,
        path: topic.metaPath,
      });
    }
  }

  const documents: Array<{ path: string; text: string }> = [];
  for (const topic of ctx.topics.values()) {
    const nodesOfTopic = [...ctx.nodes.values()].filter((node) => node.topicId === topic.topicId);
    if (nodesOfTopic.length === 0) continue;
    documents.push({ path: topic.metaPath, text: topic.metaText });
    for (const node of nodesOfTopic) documents.push({ path: node.path, text: renderNodeText(node) });
  }
  for (const broken of ctx.broken.values()) {
    documents.push({ path: broken.path, text: broken.text });
  }

  const verified = parseWorkspaceDocuments({ workspace: ctx.workspace, documents });
  if (!verified.ok) {
    throw validationError("候选工作区未通过校验", verified.diagnostics);
  }

  const output: CommitFileInput[] = [];
  const missing: string[] = [];

  const workspaceDeclared = declared.get("workspace.json");
  if (ctx.workspaceDirty) {
    if (workspaceDeclared === undefined) missing.push("workspace.json");
    else {
      output.push({
        path: "workspace.json",
        content: serializeWorkspace(
          ctx.workspaceRaw,
          ctx.workspace.activeNode,
          ctx.workspaceNl,
        ),
        expectedSha256: workspaceDeclared,
      });
    }
  }

  const sortedTopics = [...ctx.topics.values()].sort((left, right) =>
    left.metaPath.localeCompare(right.metaPath, "en"),
  );
  for (const topic of sortedTopics) {
    const nodesOfTopic = [...ctx.nodes.values()]
      .filter((node) => node.topicId === topic.topicId)
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    const expectedMeta = declared.get(topic.metaPath);
    if (nodesOfTopic.length === 0) {
      // 主题被清空：显式删除 topic.md 与残留节点文件；本批新建的从未落盘。
      if (!topic.created) {
        if (expectedMeta === undefined) missing.push(topic.metaPath);
        else output.push({ path: topic.metaPath, content: null, expectedSha256: expectedMeta });
      }
      continue;
    }
    if (topic.created || topic.metaText !== topic.metaOriginal) {
      if (expectedMeta === undefined) missing.push(topic.metaPath);
      else {
        output.push({
          path: topic.metaPath,
          content: topic.metaText,
          expectedSha256: expectedMeta,
        });
      }
    }
    for (const node of nodesOfTopic) {
      const expected = declared.get(node.path);
      const nextText = renderNodeText(node);
      // expected 为 null 表示目标路径尚不存在：移动/新建都必须落盘，
      // 即使正文逐字节未变，否则旧路径删除后会丢失该节点。
      if (node.created || expected === null || nextText !== node.originalText) {
        if (expected === undefined) missing.push(node.path);
        else output.push({ path: node.path, content: nextText, expectedSha256: expected });
      }
    }
  }

  // 被删除／移走的旧文件：仍在扫描里但已不属于任何主题。
  const livePaths = new Set<string>();
  for (const topic of sortedTopics) {
    if ([...ctx.nodes.values()].some((node) => node.topicId === topic.topicId)) {
      livePaths.add(topic.metaPath);
    }
  }
  for (const node of ctx.nodes.values()) livePaths.add(node.path);
  // 上一段已为清空的主题输出过 topic.md 删除；这里跳过，避免同一路径重复提交。
  const emittedPaths = new Set(output.map((file) => file.path));
  for (const file of files.topics) {
    if (livePaths.has(file.path) || emittedPaths.has(file.path)) continue;
    if (ctx.broken.has(file.path)) continue;
    const expected = declared.get(file.path);
    if (expected === undefined) missing.push(file.path);
    else output.push({ path: file.path, content: null, expectedSha256: expected });
  }

  if (missing.length > 0) {
    throw conflict("缺少前置文件声明，调用方需重新读取后再提交", { missingFiles: missing });
  }

  // 最近更新只算最终真实写盘的内容节点：markContent 在操作过程中收集的只是候选，
  // 同批先改后恢复原值、仅改重要性、删除或移动都可能让它与最终 output 不一致；
  // 这里以最终 node.path 命中非删除写盘文件为准，顺序与去重保持不变。
  const writtenPaths = new Set(
    output.filter((file) => file.content !== null).map((file) => file.path),
  );
  const contentNodeIds: string[] = [];
  for (const nodeId of ctx.content) {
    const node = ctx.nodes.get(nodeId);
    if (node !== undefined && writtenPaths.has(node.path)) contentNodeIds.push(nodeId);
  }

  return {
    files: output,
    changedNodeIds: ctx.changed,
    contentNodeIds,
    diagnostics: [...files.diagnostics, ...ctx.notes],
    summary: buildSummary(ctx.opNames, output),
  };
}