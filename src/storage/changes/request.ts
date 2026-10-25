/** 当前格式（一节点一份 Markdown）的候选请求：类型与严格输入校验，不依赖候选执行入口。 */
import { z } from "zod";
import {
  branchSideSchema,
  nodeFlowSchema,
  nodeIdSchema,
  nodeStateSchema,
  topicIdSchema,
  type NodeHeader,
} from "../../core/index.js";


/* ------------------------------------------------------------------ *
 * 操作：低摩擦入口 + 必要结构动作
 * ------------------------------------------------------------------ */

/** 正文模式：片段替换、追加、整篇替换三者互斥。 */
export interface PatchNodeOperation {
  readonly op: "patchNode";
  readonly nodeId: string;
  readonly title?: string | undefined;
  readonly state?: NodeHeader["state"] | undefined;
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
  readonly flow?: NodeHeader["flow"] | undefined;
  readonly side?: NodeHeader["side"] | undefined;
  readonly order?: number | undefined;
  readonly description?: string | undefined;
}

export interface CreateTopicOperation {
  readonly op: "createTopic";
  readonly topicId: string;
  /** 主题目录名（topics/<dir>），不是文件路径。 */
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
  readonly flow: NodeHeader["flow"];
  readonly state: NodeHeader["state"];
  readonly description?: string | undefined;
  readonly side?: NodeHeader["side"] | undefined;
  readonly order?: number | undefined;
  readonly summary?: string | undefined;
}

export interface UpdateNodeOperation {
  readonly op: "updateNode";
  readonly nodeId: string;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly state?: NodeHeader["state"] | undefined;
  readonly summary?: string | null | undefined;
}

export interface MoveNodeToTopicOperation {
  readonly op: "moveNodeToTopic";
  readonly nodeId: string;
  readonly topicId: string;
}

export interface RemoveLeafOperation {
  readonly op: "removeLeaf";
  readonly nodeId: string;
}

export interface SetDiscussionFocusOperation {
  readonly op: "setDiscussionFocus";
  readonly nodeId: string | null;
}

/**
 * 重要标记：只改一项元数据，不改正文、连接或排序。
 * 它属于"卡片值得关注"的标注，不计入最近一次内容更新。
 */
export interface SetImportanceOperation {
  readonly op: "setImportance";
  readonly nodeId: string;
  readonly important: boolean;
}

/** 源码修复：给出真实节点文件的完整新原文，用于无法解析的文件。 */
export interface ReplaceNodeSourceOperation {
  readonly op: "replaceNodeSource";
  readonly nodeId: string;
  readonly path: string;
  readonly raw: string;
}

export type Operation =
  | CreateTopicOperation
  | CreateNodeOperation
  | UpdateNodeOperation
  | PatchNodeOperation
  | UpdateConnectionOperation
  | MoveNodeToTopicOperation
  | RemoveLeafOperation
  | SetDiscussionFocusOperation
  | SetImportanceOperation
  | ReplaceNodeSourceOperation;

export interface ChangeRequest {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedFiles: Record<string, string | null>;
  readonly operations: Operation[];
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
  z.strictObject({ op: z.literal("setImportance"), nodeId: nodeIdSchema, important: z.boolean() }),
  z.strictObject({
    op: z.literal("replaceNodeSource"),
    nodeId: nodeIdSchema,
    path: singleLine("路径"),
    raw: z.string(),
  }),
]);

export const changeRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  requestId: z.uuid(),
  expectedFiles: z.record(z.string().min(1), sha256HexSchema.nullable()),
  operations: z.array(operationSchema),
});
