/**
 * 格式 2（一节点一份 Markdown）的候选变换。
 *
 * 只做纯文本变换：输入是本次扫描到的原始文本，输出是 CommitFileInput；不读盘、不取锁、不写缓存。
 * 解析与整图校验一律交给 core.parseWorkspaceDocuments，本模块不复制目录解析或 schema。
 *
 * 与格式 1 的关键差别：
 * - 一个节点 = 一份文件，改标题／状态只改该文件的 YAML 头，改正文只换头部之后的正文；
 * - 主题入口 topic.md 只保存 topicId／title，没有节点总表；
 * - 节点正文没有 H2 卡片标记，旧注释不会被写入或当作结构；
 * - description 属于连接（为什么 A 接到 B），改接来源时必须显式重新确认。
 */
import { parseDocument, stringify as stringifyYaml } from "yaml";
import type { Document as YamlBaseDocument, ParsedNode as YamlParsedNode } from "yaml";
import { z } from "zod";
import {
  branchSideSchema,
  nextBranchOrder,
  nodeFlowSchema,
  nodeIdSchema,
  nodeStateSchema,
  parseWorkspaceDocuments,
  topicIdSchema,
  workspaceMetaSchema,
  type Diagnostic,
  type ParsedNode,
  type ParsedTopic,
  type SupportedSchemaVersion,
  type V2NodeHeader,
  type WorkspaceGraph,
  type WorkspaceMeta,
} from "../core/index.js";
import type { StorageDiagnostic } from "./errors.js";
import type { CommitFileInput } from "./transactions.js";
import type { WorkspaceFile, WorkspaceFiles } from "./workspace.js";
import { groupWorkspaceFiles } from "./workspace.js";
import {
  TOPIC_META_FILENAME,
  isV2TopicFilePath,
  nodeHeaderObject,
  nodePath,
  normalizeNewlines,
  parseTopicPath,
  renderTopicMetaText,
  topicMetaPath,
} from "./format-v2.js";
// 共享契约放在最底层模块：本文件不 import changes.ts，避免两版实现互相初始化。
import {
  ChangeError,
  badRequest,
  conflict,
  validationError,
} from "./changes-shared.js";
import type { ChangeErrorCode, PreparedChanges } from "./changes-shared.js";

export { ChangeError };
export type { ChangeErrorCode };

/** 与格式 1 完全相同的返回形状（同一类型）；调用方把两版候选一起交给 commitFiles。 */
export type { PreparedChanges };

/* ------------------------------------------------------------------ *
 * 操作：低摩擦入口 + 必要结构动作
 * ------------------------------------------------------------------ */

/** 正文模式：片段替换、追加、整篇替换三者互斥。 */
export interface PatchNodeOperation {
  readonly op: "patchNode";
  readonly nodeId: string;
  readonly title?: string | undefined;
  readonly state?: V2NodeHeader["state"] | undefined;
  /** null 删除显式摘要；省略表示不改。 */
  readonly summary?: string | null | undefined;
  /** old 必须非空且在正文中恰好出现一次；匹配失败不全局替换。 */
  readonly replace?: readonly { readonly old: string; readonly new: string }[] | undefined;
  readonly append?: string | undefined;
  readonly body?: string | undefined;
}

/** 连接更新：改接来源时 description 必须显式给出，不能沿用旧解释。 */
export interface UpdateConnectionOperation {
  readonly op: "updateConnection";
  readonly nodeId: string;
  readonly from?: string | undefined;
  readonly flow?: V2NodeHeader["flow"] | undefined;
  readonly side?: V2NodeHeader["side"] | undefined;
  readonly order?: number | undefined;
  readonly description?: string | undefined;
}

export interface V2CreateTopicOperation {
  readonly op: "createTopic";
  readonly topicId: string;
  /** 主题目录名（topics/<dir>），不是文件路径。 */
  readonly path: string;
  readonly title: string;
}

export interface V2CreateNodeOperation {
  readonly op: "createNode";
  readonly nodeId: string;
  readonly topicId: string;
  readonly title: string;
  readonly body: string;
  readonly from: string | null;
  readonly flow: V2NodeHeader["flow"];
  readonly state: V2NodeHeader["state"];
  readonly description?: string | undefined;
  readonly side?: V2NodeHeader["side"] | undefined;
  readonly order?: number | undefined;
  readonly summary?: string | undefined;
}

export interface V2UpdateNodeOperation {
  readonly op: "updateNode";
  readonly nodeId: string;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly state?: V2NodeHeader["state"] | undefined;
  readonly summary?: string | null | undefined;
}

export interface V2MoveNodeToTopicOperation {
  readonly op: "moveNodeToTopic";
  readonly nodeId: string;
  readonly topicId: string;
}

export interface V2RemoveLeafOperation {
  readonly op: "removeLeaf";
  readonly nodeId: string;
}

export interface V2SetDiscussionFocusOperation {
  readonly op: "setDiscussionFocus";
  readonly nodeId: string | null;
}

/** 源码修复：给出真实节点文件的完整新原文，用于无法解析的文件。 */
export interface ReplaceNodeSourceOperation {
  readonly op: "replaceNodeSource";
  readonly nodeId: string;
  readonly path: string;
  readonly raw: string;
}

export type V2Operation =
  | V2CreateTopicOperation
  | V2CreateNodeOperation
  | V2UpdateNodeOperation
  | PatchNodeOperation
  | UpdateConnectionOperation
  | V2MoveNodeToTopicOperation
  | V2RemoveLeafOperation
  | V2SetDiscussionFocusOperation
  | ReplaceNodeSourceOperation;

export interface V2ChangeRequest {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedFiles: Record<string, string | null>;
  readonly operations: V2Operation[];
}

/* ------------------------------------------------------------------ *
 * 严格请求校验（未知／多余字段一律拒绝）
 * ------------------------------------------------------------------ */

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

function singleLine(label: string): z.ZodString {
  return z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) ctx.addIssue({ code: "custom", message: label + "不能为空" });
    else if (/[\r\n]/.test(value)) ctx.addIssue({ code: "custom", message: label + "必须是单行文本" });
  });
}

const operationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("createTopic"),
    topicId: topicIdSchema,
    path: singleLine("主题目录名"),
    title: singleLine("主题标题"),
  }),
  z.strictObject({
    op: z.literal("createNode"),
    nodeId: nodeIdSchema,
    topicId: topicIdSchema,
    title: singleLine("标题"),
    body: z.string(),
    from: nodeIdSchema.nullable(),
    flow: nodeFlowSchema,
    state: nodeStateSchema,
    description: singleLine("description").optional(),
    side: branchSideSchema.optional(),
    order: z.int().optional(),
    summary: singleLine("summary").optional(),
  }),
  z.strictObject({
    op: z.literal("updateNode"),
    nodeId: nodeIdSchema,
    title: singleLine("标题").optional(),
    body: z.string().optional(),
    state: nodeStateSchema.optional(),
    summary: singleLine("summary").nullable().optional(),
  }),
  z
    .strictObject({
      op: z.literal("patchNode"),
      nodeId: nodeIdSchema,
      title: singleLine("标题").optional(),
      state: nodeStateSchema.optional(),
      summary: singleLine("summary").nullable().optional(),
      replace: z
        // old 是"要精确命中的原文片段"，可以跨行、可以带首尾空白：只要求非空，
        // 不 trim（否则会改变匹配语义）。唯一性由 countOccurrences 在执行期保证。
        .array(z.strictObject({ old: z.string().min(1), new: z.string() }))
        .min(1)
        .optional(),
      append: z.string().optional(),
      body: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      const modes = [
        value.replace !== undefined,
        value.append !== undefined,
        value.body !== undefined,
      ].filter(Boolean).length;
      if (modes > 1) {
        ctx.addIssue({ code: "custom", message: "正文模式互斥：replace／append／body 只能选一个" });
      }
    }),
  z.strictObject({
    op: z.literal("updateConnection"),
    nodeId: nodeIdSchema,
    from: nodeIdSchema.optional(),
    flow: nodeFlowSchema.optional(),
    side: branchSideSchema.optional(),
    order: z.int().optional(),
    description: singleLine("description").optional(),
  }),
  z.strictObject({
    op: z.literal("moveNodeToTopic"),
    nodeId: nodeIdSchema,
    topicId: topicIdSchema,
  }),
  z.strictObject({ op: z.literal("removeLeaf"), nodeId: nodeIdSchema }),
  z.strictObject({ op: z.literal("setDiscussionFocus"), nodeId: nodeIdSchema.nullable() }),
  z.strictObject({
    op: z.literal("replaceNodeSource"),
    nodeId: nodeIdSchema,
    path: singleLine("路径"),
    raw: z.string(),
  }),
]);

export const v2ChangeRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  requestId: z.uuid(),
  expectedFiles: z.record(z.string().min(1), sha256HexSchema.nullable()),
  operations: z.array(operationSchema),
});

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

function issuesOf(error: z.ZodError): Array<{ path: string; message: string; code: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join("."),
    message: issue.message,
    code: issue.code,
  }));
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
/* ------------------------------------------------------------------ *
 * 候选模型：一份节点文件 = YAML 头 + 正文
 * ------------------------------------------------------------------ */

/**
 * 节点文件的候选状态。
 *
 * 头与正文分开保存：改标题／状态只重写 YAML 头，改正文只换 frontmatter 之后的正文，
 * 两者之间的分隔空行与尾随换行保持原样，因此中文、BOM、CRLF 不会被顺手重排。
 */
interface NodeFileState {
  readonly nodeId: string;
  topicId: string;
  dir: string;
  path: string;
  header: V2NodeHeader;
  body: string;
  /** BOM（若有）与起始 --- 行（含其换行）。 */
  readonly headOpen: string;
  /** YAML 头之后的结束 --- 行到正文之前（含分隔空行）。 */
  readonly bodyPrefix: string;
  /** 扫描时原始的 YAML 头文本；未改头字段时原样写回，避免无谓重排。 */
  readonly originalHeaderYaml: string;
  /** 扫描时的头字段快照，用来判断本批是否真的改了头。 */
  readonly scannedHeader: V2NodeHeader;
  /** 正文 trim 结束之后到文件结尾的尾随空白。 */
  readonly bodyTail: string;
  readonly nl: string;
  readonly originalText: string | null;
  /** 本批新建、尚未落盘：被清空时无需输出删除。 */
  readonly created: boolean;
}

interface TopicState {
  topicId: string;
  dir: string;
  title: string;
  metaPath: string;
  metaText: string;
  metaOriginal: string | null;
  readonly nl: string;
  readonly created: boolean;
}

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
  notes: StorageDiagnostic[];
  opNames: string[];
}

function headerYaml(header: V2NodeHeader, nl: string): string {
  return normalizeNewlines(stringifyYaml(nodeHeaderObject(header), { lineWidth: 0 }), nl);
}

function headerEquals(left: V2NodeHeader, right: V2NodeHeader): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.title === right.title &&
    left.state === right.state &&
    left.from === right.from &&
    left.flow === right.flow &&
    left.description === right.description &&
    left.side === right.side &&
    left.order === right.order &&
    left.summary === right.summary
  );
}

/**
 * 重建整份节点文件。
 *
 * 头字段没变时沿用扫描到的原始 YAML 头（含原有字段顺序与引号风格），
 * 只有真正改动的文件才重新序列化，未改动的节点因此可以与原文逐字节相同。
 */
function renderNodeText(state: NodeFileState): string {
  const normalized = normalizeNewlines(state.body, state.nl).replace(/\s+$/, "");
  const headerDiffers = !headerEquals(state.header, state.scannedHeader);
  const yaml = headerDiffers ? headerYaml(state.header, state.nl) : state.originalHeaderYaml;
  const head = state.headOpen + yaml + "---" + state.nl + state.bodyPrefix;
  const tail = state.bodyTail.length > 0 ? state.bodyTail : state.nl;
  if (normalized.length === 0) return head + tail;
  return head + normalized + tail;
}

function renderTopicMetaState(state: TopicState): string {
  return renderTopicMetaText({ topicId: state.topicId, title: state.title, nl: state.nl });
}

/**
 * 从原文切出头的三段与正文，保留原始换行与 BOM。
 *
 * 头部边界直接取 core 给出的 frontmatter 范围，因此注释、引号风格、字段顺序都不会被改写；
 * 只有真正改动头字段的文件才重新序列化 YAML。
 */
function nodeStateFrom(options: {
  path: string;
  text: string;
  node: ParsedNode;
  header: V2NodeHeader;
  originalText: string | null;
  created: boolean;
}): NodeFileState {
  const { text } = options;
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const contentRange = options.node.ranges;
  const bodyStart = contentRange.body.start;
  const bodyEnd = contentRange.body.end;
  const openEnd = text.indexOf("\n");
  const headOpen = text.slice(0, openEnd === -1 ? text.length : openEnd + 1);
  const closingAt = findClosingFence(text, headOpen.length);
  const headerEnd = closingAt === -1 ? Math.min(bodyStart, text.length) : closingAt;
  const originalHeaderYaml = text.slice(headOpen.length, headerEnd);
  // 结束 --- 行本身（含其后的换行）；再接 bodyPrefix 就是正文之前的全部字节。
  const fenceEnd = closingAt === -1 ? headerEnd : text.indexOf("\n", closingAt);
  const afterFence = fenceEnd === -1 ? text.length : fenceEnd + 1;
  return {
    nodeId: options.node.id,
    topicId: options.node.topicId,
    dir: parseTopicPath(options.path)?.directory ?? "",
    path: options.path,
    header: options.header,
    body: options.node.body,
    headOpen,
    // 结束 --- 行之后到正文之前：保留原有的分隔空行。
    bodyPrefix: text.slice(afterFence, bodyStart),
    bodyTail: text.slice(bodyEnd),
    originalHeaderYaml,
    scannedHeader: options.header,
    nl,
    originalText: options.originalText,
    created: options.created,
  };
}

/** 结束 --- 行的起点位置；找不到时返回 -1（改用正文起点兜底）。 */
function findClosingFence(text: string, from: number): number {
  if (from >= text.length) return -1;
  const found = text.indexOf("\n---", from);
  return found === -1 ? -1 : found + 1;
}

/* ------------------------------------------------------------------ *
 * 载入：先用 core 解析整份工作区
 * ------------------------------------------------------------------ */

function headerFromParsed(node: ParsedNode): V2NodeHeader {
  const header: V2NodeHeader = {
    nodeId: node.id,
    title: node.title,
    state: node.state,
    from: node.from,
    flow: node.flow,
  };
  if (node.description !== undefined) header.description = node.description;
  if (node.side !== undefined) header.side = node.side;
  if (node.order !== undefined) header.order = node.order;
  if (node.summaryExplicit) header.summary = node.summary;
  return header;
}

function topicStateFrom(topic: ParsedTopic, file: WorkspaceFile | undefined): TopicState {
  const dir = topic.dir ?? "";
  const text = file?.text ?? topic.document.text;
  return {
    topicId: topic.topicId,
    dir,
    title: topic.title,
    metaPath: topic.document.path,
    metaText: text,
    metaOriginal: text,
    nl: text.includes("\r\n") ? "\r\n" : "\n",
    created: false,
  };
}

/**
 * 载入扫描事实。
 *
 * 解析失败时把出问题的文件记进 broken，并立刻拒绝：其余操作不能在"半懂"的结构上继续；
 * 只有同一批的源码修复可以针对这些具体文件重建。
 */
function loadWorkspace(files: WorkspaceFiles, ctx: Context): void {
  if (files.workspace.schemaVersion !== 2) {
    throw badRequest("prepareChangesV2 只处理 schemaVersion 2；格式 1 请用 prepareChanges", {
      schemaVersion: files.workspace.schemaVersion,
    });
  }
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
function assertHeaderShape(header: V2NodeHeader, where: string): void {
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

function applyCreateTopic(ctx: Context, op: V2CreateTopicOperation): void {
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

function applyCreateNode(ctx: Context, op: V2CreateNodeOperation): void {
  if (ctx.nodes.has(op.nodeId)) {
    throw conflict("节点 ID 已存在：" + op.nodeId, { nodeId: op.nodeId });
  }
  const topic = requireTopic(ctx, op.topicId);
  let order = op.order;
  if (op.flow === "branch" && order === undefined && op.from !== null) {
    requireNode(ctx, op.from);
    order = defaultBranchOrder(ctx, op.from);
  }
  const header: V2NodeHeader = {
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
  markChanged(ctx, op.nodeId);
}

function applyUpdateNode(ctx: Context, op: V2UpdateNodeOperation): void {
  const node = requireNode(ctx, op.nodeId);
  const nextTitle = op.title === undefined ? node.header.title : op.title.trim();
  const nextBody = op.body === undefined ? node.body : op.body;
  const nextState = op.state === undefined ? node.header.state : op.state;
  const nextHeader: V2NodeHeader = { ...node.header, title: nextTitle, state: nextState };
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
  markChanged(ctx, node.nodeId);
}

/**
 * 局部改正文：replace 的 old 必须在正文中恰好出现一次，否则整体拒绝。
 * 不做全局替换，也不回退成"没找到就算了"。
 */
function applyPatchNode(ctx: Context, op: PatchNodeOperation): void {
  const node = requireNode(ctx, op.nodeId);
  const nextHeader: V2NodeHeader = { ...node.header };
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
    const addition = op.append.replace(/\s+$/, "");
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
  markChanged(ctx, node.nodeId);
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
  const header: V2NodeHeader = { ...node.header };
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
  markChanged(ctx, node.nodeId);
}

function applyMoveNodeToTopic(ctx: Context, op: V2MoveNodeToTopicOperation): void {
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
  markChanged(ctx, node.nodeId);
}

function applyRemoveLeaf(ctx: Context, op: V2RemoveLeafOperation): void {
  const node = requireNode(ctx, op.nodeId);
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
  void node;
}

function applyOperation(ctx: Context, op: V2Operation): void {
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
  return (
    ctx.opNames.length +
    " 个操作（" +
    [...new Set(ctx.opNames)].join("、") +
    "），影响 " +
    output.length +
    " 个文件：" +
    output.map((file) => file.path + (file.content === null ? "(删除)" : "")).join("、")
  );
}

function normalizeDeclared(
  expectedFiles: Record<string, string | null>,
): Map<string, string | null> {
  const declared = new Map<string, string | null>();
  for (const [rawPath, hash] of Object.entries(expectedFiles)) {
    const path = rawPath.replace(/\\/g, "/");
    if (declared.has(path)) {
      throw badRequest("expectedFiles 规范化后重复声明同一路径：" + path);
    }
    declared.set(path, hash);
  }
  return declared;
}

/** 全量核对 expectedFiles：不只 touched；缺声明与哈希不符都拒绝。 */
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

function readWorkspaceIdentity(files: WorkspaceFiles): {
  meta: WorkspaceMeta;
  raw: Record<string, unknown>;
  nl: string;
} {
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
    throw validationError("workspace.json 结构不合法", [], { issues: issuesOf(parsed.error) });
  }
  return {
    meta: parsed.data,
    raw: raw as Record<string, unknown>,
    nl: text.includes("\r\n") ? "\r\n" : "\n",
  };
}
/**
 * 纯同步准备一次格式 2 变更集合。
 *
 * 顺序：结构校验 → workspaceId 与身份核对 → 全量 expectedFiles 核对 → core 解析当前磁盘
 * → 按顺序应用操作 → 用候选文本重建并全图校验 → 只输出真正变化的文件。
 * 不读盘、不取锁、不提交；旧哈希一律取自调用方声明，绝不替它补。
 */
export function prepareChangesV2(files: WorkspaceFiles, request: V2ChangeRequest): PreparedChanges {
  const parsedRequest = v2ChangeRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw badRequest("变更请求结构不合法", { issues: issuesOf(parsedRequest.error) });
  }
  const validated = parsedRequest.data;

  if (files.workspace.schemaVersion !== 2) {
    throw badRequest("该工作区不是格式 2（一节点一份 Markdown）；请用对应格式的操作", {
      schemaVersion: files.workspace.schemaVersion,
    });
  }
  if (validated.workspaceId !== files.workspace.workspaceId) {
    throw badRequest("workspaceId 与当前工作区不一致", {
      expectedWorkspaceId: files.workspace.workspaceId,
      workspaceId: validated.workspaceId,
    });
  }

  const declared = normalizeDeclared(validated.expectedFiles);
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
        content: serializeWorkspace(ctx),
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
      if (node.created || nextText !== node.originalText) {
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
  for (const file of files.topics) {
    if (livePaths.has(file.path)) continue;
    if (ctx.broken.has(file.path)) continue;
    const expected = declared.get(file.path);
    if (expected === undefined) missing.push(file.path);
    else output.push({ path: file.path, content: null, expectedSha256: expected });
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