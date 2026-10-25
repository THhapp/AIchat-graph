import { z } from "zod";

export const NODE_ID_PATTERN = /^n_[0-9a-f]{32}$/;
export const TOPIC_ID_PATTERN = /^t_[0-9a-f]{32}$/;

export const nodeIdSchema = z
  .string()
  .regex(NODE_ID_PATTERN, "节点 ID 必须为 n_ 加 32 位小写十六进制");
export const topicIdSchema = z
  .string()
  .regex(TOPIC_ID_PATTERN, "主题 ID 必须为 t_ 加 32 位小写十六进制");

export const nodeStateSchema = z.enum(["agreed", "proposed", "reference"]);
export const nodeFlowSchema = z.enum(["root", "next", "branch"]);
export const branchSideSchema = z.enum(["left", "right"]);

/**
 * topic.md 的严格头。只有身份与标题；正文必须为空白。
 * 节点清单不在这里维护，身份来自各节点文件自己的头。
 */
export const topicHeaderSchema = z.strictObject({
  topicId: topicIdSchema,
  title: z.string().trim().min(1),
});

/**
 * 单节点文件的严格头。标题只在此维护，正文不要求 H2 卡片标记。
 * label／坐标／children 等旧字段一律拒绝；description 解释为什么接到来源。
 */
export const nodeHeaderSchema = z.strictObject({
  nodeId: nodeIdSchema,
  title: z.string().trim().min(1),
  state: nodeStateSchema,
  from: nodeIdSchema.nullable(),
  flow: nodeFlowSchema,
  description: z.string().trim().min(1).optional(),
  side: branchSideSchema.optional(),
  order: z.int().optional(),
  summary: z.string().trim().min(1).optional(),
  /**
   * 重要标记：只表示"值得关注"，不参与编号、连接与排序。
   * 缺省即未标记；写入 false 时不落字段，因此既有文件保持原样。
   */
  important: z.boolean().optional(),
});

/** workspace.json 的身份与讨论焦点；activeNode 不是用户选中卡片。 */
export const WORKSPACE_SCHEMA_VERSION = 2;
export const workspaceMetaSchema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  workspaceId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  activeNode: nodeIdSchema.nullable(),
  topicMode: z.literal("isolated").optional(),
});

export type NodeState = z.infer<typeof nodeStateSchema>;
export type NodeFlow = z.infer<typeof nodeFlowSchema>;
export type BranchSide = z.infer<typeof branchSideSchema>;
export type TopicHeader = z.infer<typeof topicHeaderSchema>;
export type NodeHeader = z.infer<typeof nodeHeaderSchema>;
export type WorkspaceMeta = z.infer<typeof workspaceMetaSchema>;
