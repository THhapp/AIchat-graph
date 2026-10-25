/**
 * Agent 动作的传输层 schema：HTTP 层只做结构与单行／互斥校验。
 *
 * 节点是否存在、editRef 是否有效、连接与跨主题约束都在 compile 阶段判断；
 * 这里不读取快照，也不做 IO。
 */
import { z } from "zod";
import {
  branchSideSchema,
  nodeFlowSchema,
  nodeStateSchema,
} from "../../core/index.js";

const singleLine = (label: string): z.ZodString =>
  z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue({ code: "custom", message: label + "不能为空" });
      return;
    }
    if (/[\r\n]/.test(value)) ctx.addIssue({ code: "custom", message: label + "必须是单行文本" });
  });

const patchNodeActionSchema = z
  .strictObject({
    action: z.literal("patchNode"),
    editRef: z.string().min(1),
    title: singleLine("title").optional(),
    state: nodeStateSchema.optional(),
    summary: singleLine("summary").nullable().optional(),
    // exact 片段允许跨行并原样保留首尾空白：old 只要求非空，
    // 唯一性由候选层（countOccurrences === 1）判定，匹配不上就整批拒绝。
    // title／summary 仍是单行短字段，继续用 singleLine。
    replace: z
      .array(z.strictObject({ old: z.string().min(1), new: z.string() }))
      .min(1)
      .optional(),
    append: z.string().optional(),
    body: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const modes = [value.replace !== undefined, value.append !== undefined, value.body !== undefined]
      .filter(Boolean).length;
    if (modes > 1) {
      ctx.addIssue({ code: "custom", message: "正文模式互斥：replace／append／body 只能选一个" });
    }
    if (
      modes === 0 &&
      value.title === undefined &&
      value.state === undefined &&
      value.summary === undefined
    ) {
      ctx.addIssue({ code: "custom", message: "patchNode 至少需要一处修改" });
    }
  });

const createBranchActionSchema = z.strictObject({
  action: z.literal("createBranch"),
  editRef: z.string().min(1),
  title: singleLine("title"),
  body: z.string(),
  description: singleLine("description"),
  state: nodeStateSchema.optional(),
  side: branchSideSchema.optional(),
  order: z.int().optional(),
  topicId: z.string().optional(),
});

const createNextActionSchema = z.strictObject({
  action: z.literal("createNext"),
  editRef: z.string().min(1),
  title: singleLine("title"),
  body: z.string(),
  description: singleLine("description"),
  state: nodeStateSchema.optional(),
  topicId: z.string().optional(),
});

const updateConnectionActionSchema = z.strictObject({
  action: z.literal("updateConnection"),
  editRef: z.string().min(1),
  fromRef: z.string().min(1).optional(),
  flow: nodeFlowSchema.optional(),
  side: branchSideSchema.nullable().optional(),
  order: z.int().nullable().optional(),
  description: singleLine("description"),
});

/**
 * rearrange 的一条最终入边：只表达"最后接到哪里"，不表达中间步骤。
 * flow=next 时 side／order 没有意义，出现即拒绝（400 级校验错误）。
 */
const rearrangeEditSchema = z
  .strictObject({
    editRef: singleLine("editRef"),
    fromRef: singleLine("fromRef"),
    flow: z.enum(["next", "branch"]),
    side: branchSideSchema.optional(),
    order: z.int().min(0).optional(),
    description: singleLine("description"),
  })
  .superRefine((value, ctx) => {
    if (value.flow !== "next") return;
    if (value.side !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["side"],
        message: "flow=next 时不能带 side（纵向后继不使用左右排布）",
      });
    }
    if (value.order !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["order"],
        message: "flow=next 时不能带 order（纵向后继不使用兄弟排序）",
      });
    }
  });

const rearrangeActionSchema = z.strictObject({
  action: z.literal("rearrange"),
  edits: z.array(rearrangeEditSchema).min(1),
});

const setImportanceActionSchema = z.strictObject({
  action: z.literal("setImportance"),
  editRef: z.string().min(1),
  important: z.boolean(),
});

const createRootActionSchema = z.strictObject({
  action: z.literal("createRoot"),
  topicTitle: singleLine("topicTitle"),
  title: singleLine("title"),
  body: z.string(),
  state: nodeStateSchema.optional(),
  description: singleLine("description").optional(),
});

const createTopicActionSchema = z.strictObject({
  action: z.literal("createTopic"),
  topicTitle: singleLine("topicTitle"),
  directory: singleLine("directory").optional(),
  title: singleLine("title").optional(),
  body: z.string(),
  state: nodeStateSchema.optional(),
});

/** 严格请求 schema：未知字段一律拒绝，正文模式互斥由 action 层校验。 */
export const agentChangeRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  requestId: z.uuid(),
  action: z.discriminatedUnion("action", [
    patchNodeActionSchema,
    createBranchActionSchema,
    createNextActionSchema,
    updateConnectionActionSchema,
    rearrangeActionSchema,
    setImportanceActionSchema,
    createRootActionSchema,
    createTopicActionSchema,
  ]),
});
