/** 格式 1 的候选请求：类型与严格输入校验，不依赖候选执行入口。 */
import { z } from "zod";
import {
  branchSideSchema,
  nodeFlowSchema,
  nodeIdSchema,
  nodeStateSchema,
  topicIdSchema,
  type NodeMeta,
} from "../../core/index.js";


export interface CreateTopicOperation {
  readonly op: "createTopic";
  readonly topicId: string;
  readonly path: string;
  readonly title: string;
}

export interface CreateNodeOperation {
  readonly op: "createNode";
  readonly nodeId: string;
  readonly topicId: string;
  readonly title: string;
  readonly body: string;
  readonly from: string | null;
  readonly flow: NodeMeta["flow"];
  readonly state: NodeMeta["state"];
  readonly side?: NodeMeta["side"] | undefined;
  readonly order?: number | undefined;
  readonly label?: string | undefined;
  readonly summary?: string | undefined;
}

export interface UpdateNodeOperation {
  readonly op: "updateNode";
  readonly nodeId: string;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly state?: NodeMeta["state"] | undefined;
  /** null 删除显式摘要；省略表示不改。 */
  readonly summary?: string | null | undefined;
}

export interface InsertNextNodeInput {
  readonly nodeId: string;
  readonly topicId: string;
  readonly title: string;
  readonly body: string;
  readonly state: NodeMeta["state"];
  readonly label?: string | undefined;
  readonly summary?: string | undefined;
}

export interface InsertNextOperation {
  readonly op: "insertNext";
  readonly sourceId: string;
  readonly node: InsertNextNodeInput;
}

export interface MoveBranchOperation {
  readonly op: "moveBranch";
  readonly nodeId: string;
  readonly from: string;
  readonly side: NodeMeta["side"];
  readonly order: number;
}

export interface MoveNodeToTopicOperation {
  readonly op: "moveNodeToTopic";
  readonly nodeId: string;
  readonly topicId: string;
}

export interface ReplaceTopicOperation {
  readonly op: "replaceTopic";
  readonly topicId: string;
  readonly path: string;
  readonly raw: string;
}

export interface SetDiscussionFocusOperation {
  readonly op: "setDiscussionFocus";
  readonly nodeId: string | null;
}

export interface RemoveLeafOperation {
  readonly op: "removeLeaf";
  readonly nodeId: string;
}

/** 受影响边的完整新结构；未给出的 side／order 表示删除该字段。 */
export interface MergeReconnectEntry {
  readonly nodeId: string;
  readonly from: string | null;
  readonly flow: NodeMeta["flow"];
  readonly side?: NodeMeta["side"] | undefined;
  readonly order?: number | undefined;
  readonly label?: string | undefined;
}

export interface MergeNodesOperation {
  readonly op: "mergeNodes";
  readonly survivorId: string;
  readonly mergedNodeIds: string[];
  readonly body: string;
  readonly reconnect: MergeReconnectEntry[];
  readonly activeNode: string | null;
}

export type Operation =
  | CreateTopicOperation
  | CreateNodeOperation
  | UpdateNodeOperation
  | InsertNextOperation
  | MoveBranchOperation
  | MoveNodeToTopicOperation
  | ReplaceTopicOperation
  | SetDiscussionFocusOperation
  | RemoveLeafOperation
  | MergeNodesOperation;

export interface ChangeRequest {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedFiles: Record<string, string | null>;
  readonly operations: Operation[];
}

/* ------------------------------------------------------------------ *
 * 严格运行时校验：拒绝未知／多余字段，不把类型断言当校验
 * ------------------------------------------------------------------ */

const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "SHA-256 必须是 64 位小写十六进制");

const titleSchema = z.string().superRefine((value, ctx) => {
  if (value.trim().length === 0) {
    ctx.addIssue({ code: "custom", message: "标题不能为空" });
    return;
  }
  if (/[\r\n]/.test(value)) {
    ctx.addIssue({ code: "custom", message: "标题必须是单行文本" });
    return;
  }
  // 标题里的 HTML 注释片段会被解析成别人的 node 标记，必须拒绝。
  if (/<!--|-->|node:/.test(value)) {
    ctx.addIssue({ code: "custom", message: "标题不能包含伪 ID 标记（<!--、-->、node:）" });
  }
});

const labelSchema = z.string().superRefine((value, ctx) => {
  if (value.trim().length === 0) ctx.addIssue({ code: "custom", message: "label 不能为空" });
  else if (/[\r\n]/.test(value)) ctx.addIssue({ code: "custom", message: "label 必须是单行文本" });
});

const summarySchema = z.string().superRefine((value, ctx) => {
  if (value.trim().length === 0) ctx.addIssue({ code: "custom", message: "summary 不能为空" });
  else if (/[\r\n]/.test(value)) {
    ctx.addIssue({ code: "custom", message: "summary 必须是单行文本" });
  }
});

const createTopicSchema = z.strictObject({
  op: z.literal("createTopic"),
  topicId: topicIdSchema,
  path: z.string().min(1),
  title: titleSchema,
});

const createNodeSchema = z.strictObject({
  op: z.literal("createNode"),
  nodeId: nodeIdSchema,
  topicId: topicIdSchema,
  title: titleSchema,
  body: z.string(),
  from: nodeIdSchema.nullable(),
  flow: nodeFlowSchema,
  state: nodeStateSchema,
  side: branchSideSchema.optional(),
  order: z.int().optional(),
  label: labelSchema.optional(),
  summary: summarySchema.optional(),
});

const updateNodeSchema = z.strictObject({
  op: z.literal("updateNode"),
  nodeId: nodeIdSchema,
  title: titleSchema.optional(),
  body: z.string().optional(),
  state: nodeStateSchema.optional(),
  summary: summarySchema.nullable().optional(),
});

const insertNextSchema = z.strictObject({
  op: z.literal("insertNext"),
  sourceId: nodeIdSchema,
  node: z.strictObject({
    nodeId: nodeIdSchema,
    topicId: topicIdSchema,
    title: titleSchema,
    body: z.string(),
    state: nodeStateSchema,
    label: labelSchema.optional(),
    summary: summarySchema.optional(),
  }),
});

const moveBranchSchema = z.strictObject({
  op: z.literal("moveBranch"),
  nodeId: nodeIdSchema,
  from: nodeIdSchema,
  side: branchSideSchema,
  order: z.int(),
});

const moveNodeToTopicSchema = z.strictObject({
  op: z.literal("moveNodeToTopic"),
  nodeId: nodeIdSchema,
  topicId: topicIdSchema,
});

const replaceTopicSchema = z.strictObject({
  op: z.literal("replaceTopic"),
  topicId: topicIdSchema,
  path: z.string().min(1),
  raw: z.string(),
});

const setDiscussionFocusSchema = z.strictObject({
  op: z.literal("setDiscussionFocus"),
  nodeId: nodeIdSchema.nullable(),
});

const removeLeafSchema = z.strictObject({
  op: z.literal("removeLeaf"),
  nodeId: nodeIdSchema,
});

const reconnectSchema = z.strictObject({
  nodeId: nodeIdSchema,
  from: nodeIdSchema.nullable(),
  flow: nodeFlowSchema,
  side: branchSideSchema.optional(),
  order: z.int().optional(),
  label: labelSchema.optional(),
});

const mergeNodesSchema = z.strictObject({
  op: z.literal("mergeNodes"),
  survivorId: nodeIdSchema,
  mergedNodeIds: z.array(nodeIdSchema).min(1),
  body: z.string(),
  reconnect: z.array(reconnectSchema),
  activeNode: nodeIdSchema.nullable(),
});

const operationSchema = z.discriminatedUnion("op", [
  createTopicSchema,
  createNodeSchema,
  updateNodeSchema,
  insertNextSchema,
  moveBranchSchema,
  moveNodeToTopicSchema,
  replaceTopicSchema,
  setDiscussionFocusSchema,
  removeLeafSchema,
  mergeNodesSchema,
]);

/** 严格请求 schema；service 可在任何计算前复用同一套结构校验。 */
export const changeRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  requestId: z.uuid(),
  expectedFiles: z.record(z.string().min(1), sha256HexSchema.nullable()),
  operations: z.array(operationSchema),
});
