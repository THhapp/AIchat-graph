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
    // 入边与重要性：与内容字段同一动作提交；字段组合由下面的连带校验保证。
    important: z.boolean().optional(),
    description: singleLine("description").optional(),
    fromRef: z.string().min(1).optional(),
    flow: z.enum(["next", "branch"]).optional(),
  })
  .superRefine((value, ctx) => {
    const modes = [value.replace !== undefined, value.append !== undefined, value.body !== undefined]
      .filter(Boolean).length;
    if (modes > 1) {
      ctx.addIssue({ code: "custom", message: "正文模式互斥：replace／append／body 只能选一个" });
    }
    // 连带校验：改来源必须同时给关系类型；任何入边修改都必须重新确认说明。
    if (value.fromRef !== undefined && value.flow === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["flow"],
        message: "给出 fromRef 时必须同时给出 flow（只改类型时才可省略 fromRef）",
      });
    }
    if (
      (value.fromRef !== undefined || value.flow !== undefined) &&
      value.description === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["description"],
        message: "修改来源或关系类型时必须同时给出 description（新入边要有新的理由）",
      });
    }
    if (
      modes === 0 &&
      value.title === undefined &&
      value.state === undefined &&
      value.summary === undefined &&
      value.important === undefined &&
      value.description === undefined &&
      value.fromRef === undefined &&
      value.flow === undefined
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
  summary: singleLine("summary").optional(),
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
  summary: singleLine("summary").optional(),
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
  summary: singleLine("summary").optional(),
  description: singleLine("description").optional(),
});

const createTopicActionSchema = z.strictObject({
  action: z.literal("createTopic"),
  topicTitle: singleLine("topicTitle"),
  directory: singleLine("directory").optional(),
  title: singleLine("title").optional(),
  body: z.string(),
  state: nodeStateSchema.optional(),
  summary: singleLine("summary").optional(),
});

/* ------------------------------------------------------------------ *
 * batch / insert：严格结构校验；业务语义（批前快照、局部名称、唯一 next、
 * 环、主题隔离、占位）全部交给 compile 阶段的整图检查。
 * ------------------------------------------------------------------ */

/** 批次内节点选择：ref 与 local 二选一。 */
const nodeSelectorSchema = z
  .strictObject({
    ref: singleLine("ref").optional(),
    local: singleLine("local").optional(),
  })
  .superRefine((value, ctx) => {
    const count = [value.ref !== undefined, value.local !== undefined].filter(Boolean).length;
    if (count !== 1) {
      ctx.addIssue({ code: "custom", message: "必须且只能给 ref 或 local 之一" });
    }
  });

/** 已有节点的属性／正文修改；与 patchNode 的正文模式与互斥规则一致。 */
const batchEditPatchSchema = z
  .strictObject({
    title: singleLine("title").optional(),
    state: nodeStateSchema.optional(),
    summary: singleLine("summary").nullable().optional(),
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
      ctx.addIssue({ code: "custom", message: "edit.patch 至少需要一处修改" });
    }
  });

const targetRefSchema = z.strictObject({ ref: singleLine("target.ref") });

const batchEditOpSchema = z.strictObject({
  op: z.literal("edit"),
  target: targetRefSchema,
  patch: batchEditPatchSchema,
});

const batchCreateOpSchema = z
  .strictObject({
    op: z.literal("create"),
    as: singleLine("as"),
    from: nodeSelectorSchema,
    flow: z.enum(["next", "branch"]),
    title: singleLine("title"),
    body: z.string(),
    description: singleLine("description"),
    summary: singleLine("summary").optional(),
    state: nodeStateSchema.optional(),
    important: z.boolean().optional(),
    side: branchSideSchema.optional(),
    order: z.int().optional(),
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

const batchConnectOpSchema = z
  .strictObject({
    op: z.literal("connect"),
    target: targetRefSchema,
    from: nodeSelectorSchema.optional(),
    flow: z.enum(["next", "branch"]).optional(),
    description: singleLine("description"),
    side: branchSideSchema.optional(),
    order: z.int().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from !== undefined && value.flow === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["flow"],
        message: "给出 from 时必须同时给出 flow（只给 flow 才沿用当前来源）",
      });
    }
    if (value.flow !== "next") return;
    if (value.side !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["side"],
        message: "最终 flow=next 时不能带 side",
      });
    }
    if (value.order !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["order"],
        message: "最终 flow=next 时不能带 order",
      });
    }
  });

const batchImportantOpSchema = z.strictObject({
  op: z.literal("important"),
  target: targetRefSchema,
  important: z.boolean(),
});

const batchActionSchema = z.strictObject({
  action: z.literal("batch"),
  topicId: z.string().min(1),
  ops: z
    .array(
      z.discriminatedUnion("op", [
        batchEditOpSchema,
        batchCreateOpSchema,
        batchConnectOpSchema,
        batchImportantOpSchema,
      ]),
    )
    .min(1),
});

const insertActionSchema = z.strictObject({
  action: z.literal("insert"),
  afterRef: singleLine("afterRef"),
  beforeRef: singleLine("beforeRef"),
  title: singleLine("title"),
  body: z.string(),
  description: singleLine("description"),
  nextDescription: singleLine("nextDescription"),
  summary: singleLine("summary").optional(),
  state: nodeStateSchema.optional(),
});

/** 严格请求 schema：未知字段一律拒绝，正文模式互斥由 action 层校验。 */
export const agentChangeRequestSchema = z
  .strictObject({
    workspaceId: z.string().min(1),
    requestId: z.uuid(),
    dryRun: z.boolean().optional(),
    action: z.discriminatedUnion("action", [
      patchNodeActionSchema,
      createBranchActionSchema,
      createNextActionSchema,
      updateConnectionActionSchema,
      rearrangeActionSchema,
      setImportanceActionSchema,
      createRootActionSchema,
      createTopicActionSchema,
      batchActionSchema,
      insertActionSchema,
    ]),
  })
  .superRefine((value, ctx) => {
    if (value.dryRun === true && value.action.action !== "batch") {
      ctx.addIssue({
        code: "custom",
        path: ["dryRun"],
        message: "dryRun 只用于 batch",
      });
    }
  });
