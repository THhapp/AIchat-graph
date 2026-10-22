import { z } from "zod";

/** 格式 1 主题文件只接受 schemaVersion 1；格式 2 的版本在 workspace.json 中声明。 */
export const TOPIC_SCHEMA_VERSION = 1;
/** 工作区接受格式 1（兼容读取）与格式 2（新默认）。 */
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;
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
 * 格式 1 的节点元数据（frontmatter nodes 下的单条）。标题只存在于正文 H2。
 * side／order 只对 branch 有意义；root／next 使用它们是结构错误，由 graph 校验报出。
 */
export const nodeMetaSchema = z.strictObject({
  from: nodeIdSchema.nullable(),
  flow: nodeFlowSchema,
  state: nodeStateSchema,
  side: branchSideSchema.optional(),
  order: z.int().optional(),
  label: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).optional(),
});

export const topicFrontmatterSchema = z.strictObject({
  schemaVersion: z.literal(TOPIC_SCHEMA_VERSION),
  topicId: topicIdSchema,
  title: z.string().trim().min(1),
  nodes: z.record(nodeIdSchema, nodeMetaSchema),
});

/**
 * 格式 2：topic.md 的严格头。只有身份与标题；正文必须为空白。
 * 节点清单不在这里维护，身份来自各节点文件自己的头。
 */
export const v2TopicHeaderSchema = z.strictObject({
  topicId: topicIdSchema,
  title: z.string().trim().min(1),
});

/**
 * 格式 2：单节点文件的严格头。标题只在此维护，正文不再要求 H2 卡片标记。
 * label／坐标／children 等旧字段一律拒绝；description 解释为什么接到来源。
 */
export const v2NodeHeaderSchema = z.strictObject({
  nodeId: nodeIdSchema,
  title: z.string().trim().min(1),
  state: nodeStateSchema,
  from: nodeIdSchema.nullable(),
  flow: nodeFlowSchema,
  description: z.string().trim().min(1).optional(),
  side: branchSideSchema.optional(),
  order: z.int().optional(),
  summary: z.string().trim().min(1).optional(),
});

/** workspace.json 的身份与讨论焦点；activeNode 不是用户选中卡片。 */
export const WORKSPACE_SCHEMA_VERSION = 1;
export const workspaceMetaSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  workspaceId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  activeNode: nodeIdSchema.nullable(),
  topicMode: z.enum(["isolated", "shared"]).optional(),
}).refine((value) => value.schemaVersion !== 1 || value.topicMode !== "isolated", {
  message: "格式 1 工作区只能使用 shared 主题模式", path: ["topicMode"],
});

export type SupportedSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];
export type NodeState = z.infer<typeof nodeStateSchema>;
export type NodeFlow = z.infer<typeof nodeFlowSchema>;
export type BranchSide = z.infer<typeof branchSideSchema>;
export type NodeMeta = z.infer<typeof nodeMetaSchema>;
export type TopicFrontmatter = z.infer<typeof topicFrontmatterSchema>;
export type V2TopicHeader = z.infer<typeof v2TopicHeaderSchema>;
export type V2NodeHeader = z.infer<typeof v2NodeHeaderSchema>;
export type WorkspaceMeta = z.infer<typeof workspaceMetaSchema>;
