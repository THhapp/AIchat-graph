/**
 * 低摩擦 Agent 入口：有界读取与动作编译。
 *
 * - 读取默认有界（4000 UTF-16 单元，单段最多 16000），显式 full 才返回全文；
 *   不切断代理对，并附带真实源路径／哈希与绑定该版本的 editRef。
 * - 动作（patchNode／createBranch／updateConnection／createRoot）编译成
 *   现有 storage 变更请求，交回同一 apply 链路（队列 → 候选 → 事务 → 发布），
 *   不复制候选业务、不绕过队列。
 *
 * 本模块不做 I/O；由 changes.ts 在同一队列内调用。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  branchSideSchema,
  nodeFlowSchema,
  nodeStateSchema,
} from "../core/index.js";
import type {
  AgentChangeAction,
  AgentCreateBranchAction,
  AgentCreateNextAction,
  AgentCreateRootAction,
  AgentCreateTopicAction,
  AgentEditRef,
  AgentNodeReadResponse,
  AgentPatchNodeAction,
  AgentReadRange,
  AgentRearrangeAction,
  AgentSection,
  AgentSetImportanceAction,
  AgentUpdateConnectionAction,
  Diagnostic,
  GraphNode,
} from "../shared/protocol.js";
import type {
  Operation as V1Operation,
  V2Operation,
} from "../storage/index.js";
import { normalizeRelativePath } from "../storage/paths.js";
import {
  DEFAULT_READ_LENGTH,
  MAX_READ_SEGMENT,
  locateSection,
  sliceBody,
} from "../core/index.js";
import type { ParsedNode } from "../core/index.js";
import type { WorkspaceRuntime } from "./workspace.js";
import type { SnapshotData, TopicSnapshot } from "./snapshot.js";
import { ServiceError } from "./errors.js";
import type { EditRefStore } from "./editref.js";

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

/** 单次可请求的最大片段长度（与 core 一致，仅作为对外别名）。 */
export const MAX_READ_LENGTH = MAX_READ_SEGMENT;

export { DEFAULT_READ_LENGTH };

export interface AgentReadQuery {
  readonly start?: number | undefined;
  readonly length?: number | undefined;
  readonly full?: boolean | undefined;
  /** 只取元数据与 editRef，不返回正文（不能与其他定位／切片参数同时使用）。 */
  readonly meta?: boolean | undefined;
  /** 按标题定位章节；start 取该章节起点。 */
  readonly section?: string | undefined;
  /** 同名标题中的第几个（0 起）；必须与 section 一起使用。 */
  readonly sectionIndex?: number | undefined;
}

function parseOffset(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    throw new ServiceError(400, "BAD_REQUEST", label + " 必须是非负整数", { details: { value: raw } });
  }
  return Number(raw);
}

export function parseAgentReadQuery(query: Record<string, string | undefined>): AgentReadQuery {
  const start = parseOffset(query["start"], "start");
  const length = parseOffset(query["length"], "length");
  if (start !== undefined && start > 100_000_000) {
    throw new ServiceError(400, "BAD_REQUEST", "start 超出可接受范围", {});
  }
  if (length !== undefined && (length < 1 || length > MAX_READ_LENGTH)) {
    throw new ServiceError(400, "BAD_REQUEST", "length 必须在 1-" + MAX_READ_LENGTH + " 之间", {
      details: { max: MAX_READ_LENGTH },
    });
  }
  const fullRaw = query["full"];
  if (fullRaw !== undefined && fullRaw !== "true" && fullRaw !== "false" && fullRaw !== "") {
    throw new ServiceError(400, "BAD_REQUEST", "full 只接受 true 或省略", {});
  }
  const metaRaw = query["meta"];
  if (metaRaw !== undefined && metaRaw !== "true" && metaRaw !== "false" && metaRaw !== "") {
    throw new ServiceError(400, "BAD_REQUEST", "meta 只接受 true 或省略", {});
  }
  const meta = metaRaw === "true" || metaRaw === "";

  let section: string | undefined;
  const sectionRaw = query["section"];
  if (sectionRaw !== undefined) {
    const trimmed = sectionRaw.trim();
    if (trimmed.length === 0) {
      throw new ServiceError(
        400,
        "BAD_REQUEST",
        "section 去空白后不能为空；请给出正文里的标题，例如 --section \"小节一\"",
        {},
      );
    }
    section = trimmed;
  }
  const sectionIndex = parseOffset(query["section-index"], "section-index");
  if (sectionIndex !== undefined && section === undefined) {
    throw new ServiceError(
      400,
      "BAD_REQUEST",
      "section-index 必须与 section 一起使用；单独给出无法定位章节",
      {},
    );
  }

  if (meta) {
    // meta 只返回元数据与 editRef；切片／章节参数会让人误以为正文仍被返回。
    const conflicts = [
      query["start"] !== undefined ? "start" : undefined,
      query["length"] !== undefined ? "length" : undefined,
      query["full"] !== undefined ? "full" : undefined,
      query["section"] !== undefined ? "section" : undefined,
      query["section-index"] !== undefined ? "section-index" : undefined,
    ].filter((item): item is string => item !== undefined);
    if (conflicts.length > 0) {
      throw new ServiceError(
        400,
        "BAD_REQUEST",
        "meta=true 不能与 " + conflicts.join("／") + " 同时使用；meta 读取不含正文，请去掉这些参数",
        { details: { conflicts } },
      );
    }
  }

  return {
    start,
    length,
    full: fullRaw === "true" || fullRaw === "",
    ...(meta ? { meta: true } : {}),
    ...(section !== undefined ? { section } : {}),
    ...(sectionIndex !== undefined ? { sectionIndex } : {}),
  };
}

function findParsedNode(snapshot: SnapshotData, nodeId: string): {
  node: ParsedNode;
  topic: TopicSnapshot;
  view: SnapshotData["graph"]["nodes"][number];
  fileHash: string;
} | null {
  const view = snapshot.graph.nodes.find((entry) => entry.id === nodeId);
  if (view === undefined) return null;
  const topic = snapshot.topics.find((entry) => entry.topicId === view.topicId);
  if (topic === undefined) return null;
  const node = topic.nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) return null;
  const file = topic.files.find((entry) => entry.path === node.sourcePath);
  return { node, topic, view, fileHash: file?.fileHash ?? "" };
}

/** 正文里 Markdown 标题的行范围（相对正文起点），用于可选章节定位。 */
function sectionsOf(body: string): AgentSection[] {
  const sections: AgentSection[] = [];
  const lines = body.split("\n");
  let offset = 0;
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = /^\s*(\`\`\`+|~~~+)/.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) fence = marker;
      else if (line.trimStart().startsWith(fence)) fence = null;
      offset += line.length + 1;
      continue;
    }
    if (fence === null) {
      const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (heading !== null) {
        sections.push({
          index: sections.length,
          title: (heading[2] ?? "").trim(),
          level: (heading[1] ?? "").length,
          start: offset,
          end: offset + line.length,
        });
      }
    }
    offset += line.length + 1;
  }
  return sections;
}

/** 返回包含 offset 的最近章节（含上一级）；没有标题返回 null。 */
function sectionAt(sections: readonly AgentSection[], offset: number): AgentSection | null {
  let found: AgentSection | null = null;
  for (const section of sections) {
    if (section.start > offset) break;
    found = section;
  }
  return found;
}

export interface AgentReadContext {
  readonly runtime: WorkspaceRuntime;
  readonly editRefs: EditRefStore;
  readonly nodeId: string;
  readonly query: AgentReadQuery;
}

/**
 * 有界读取一个节点。正文来自有效快照（不与新磁盘字节拼装）；
 * editRef 绑定该快照版本与真实源文件哈希。
 */
export function readAgentNode(context: AgentReadContext): AgentNodeReadResponse {
  const { runtime, editRefs, nodeId, query } = context;
  const snapshot = runtime.current.data;
  const found = findParsedNode(snapshot, nodeId);
  if (found === null) {
    throw new ServiceError(404, "NOT_FOUND", "当前有效快照中没有节点 " + nodeId, {
      details: { nodeId },
    });
  }
  const { node, topic, view, fileHash } = found;
  const body = node.body;
  const sections = sectionsOf(body);

  // section 定位走 core 的 AST helper；在线与离线共用同一份实现。
  let rangeStart = query.start ?? 0;
  let locatedSection: AgentSection | null = null;
  if (query.section !== undefined) {
    let location;
    try {
      location = locateSection(body, query.section, query.sectionIndex);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ServiceError(400, "INVALID_SECTION", error.message, {
          details: {
            section: query.section,
            ...(query.sectionIndex !== undefined ? { sectionIndex: query.sectionIndex } : {}),
          },
        });
      }
      throw error;
    }
    rangeStart = location.start;
    const known = sections.find((entry) => entry.start === location.start);
    if (known !== undefined) {
      locatedSection = known;
    } else {
      // AST 能识别缩进 0-3 格的标题，本地正则只认行首；仍返回同一位置。
      const lineEnd = body.indexOf("\n", location.start);
      locatedSection = {
        index: location.index,
        title: location.title,
        level: location.level,
        start: location.start,
        end: lineEnd === -1 ? body.length : lineEnd,
      };
    }
  }

  let fragment: string;
  let range: AgentReadRange;
  let truncated: boolean;
  let section: AgentSection | null;
  if (query.meta === true) {
    // meta 只给元数据与 editRef：正文明确省略，range 以 0/0 表达。
    fragment = "";
    range = { start: 0, end: 0, total: body.length, unit: "utf16" };
    truncated = false;
    section = null;
  } else {
    // 切片统一复用 core 的纯 helper：UTF-16 单位、不切断代理对、
    // truncated = start > 0 || end < total。
    const segment = sliceBody(body, {
      start: rangeStart,
      ...(query.length !== undefined ? { length: query.length } : {}),
      full: query.full === true,
    });
    fragment = segment.text;
    range = segment.range;
    truncated = segment.truncated;
    // 显式 section 返回定位到的章节；否则保留"包含 range.start 的最近章节"。
    section = locatedSection ?? sectionAt(sections, range.start);
  }

  const issued = editRefs.issue({
    workspaceId: snapshot.workspaceId,
    topicId: node.topicId,
    nodeId: node.id,
    path: node.sourcePath,
    fileHash,
    instanceId: runtime.instanceId,
    revision: runtime.current.revision,
  });

  const graphNode: GraphNode = {
    id: view.id,
    topicId: view.topicId,
    title: view.title,
    summary: view.summary,
    number: view.number,
    from: view.from,
    flow: view.flow,
    state: view.state,
    important: view.important,
    ...(view.description !== undefined ? { description: view.description } : {}),
    ...(view.side !== undefined ? { side: view.side } : {}),
    ...(view.order !== undefined ? { order: view.order } : {}),
    ...(view.description === undefined && view.label !== undefined ? { label: view.label } : {}),
    sourcePath: node.sourcePath,
  };

  return {
    ...runtime.snapshotVersion(),
    workspaceId: snapshot.workspaceId,
    node: graphNode,
    body: fragment,
    ...(query.meta === true ? { bodyOmitted: true } : {}),
    range,
    truncated,
    path: node.sourcePath,
    fileHash,
    topicPath: topic.path,
    editRef: issued,
    section,
  };
}

/* ------------------------------------------------------------------ *
 * 动作编译
 * ------------------------------------------------------------------ */

export interface CompiledAction {
  readonly operations: Array<V1Operation | V2Operation>;
  /** 本次需要声明的旧哈希（相对路径 → 现有哈希或 null）。 */
  readonly expectedFiles: Record<string, string | null>;
  /** 生成的新 ID（重放时由请求记录复用，不重新生成）。 */
  readonly created: {
    topicId: string | null;
    /** 新建主题时它的入口文件（topic.md）；追加到现有主题为 null。 */
    topicPath: string | null;
    nodeIds: string[];
    paths: string[];
  };
  /** 主要受影响节点，用于返回新 editRef。 */
  readonly primaryNodeId: string | null;
  readonly action: AgentChangeAction["action"];
}

export interface CompileContext {
  readonly runtime: WorkspaceRuntime;
  readonly editRefs: EditRefStore;
  readonly requestId: string;
  /** 同一 requestId 之前生成过的 ID；重放必须复用。 */
  readonly generated: { topicId: string; nodeId: string; dir: string } | null;
}

/** 新节点文件的相对路径：V2 为 主题目录/<nodeId>.md，V1 追加在主题文件内（无新文件）。 */
function newNodeFilePath(topic: TopicSnapshot, nodeId: string): string {
  const dir = topic.path.split("/").slice(0, -1).join("/");
  return dir + "/" + nodeId + ".md";
}

function newId(prefix: "n_" | "t_"): string {
  return prefix + randomUUID().replace(/-/g, "");
}

/** 目录名：取标题的安全子集，冲突时附加短 ID，绝不覆盖已有目录。 */
function topicDirectory(title: string, suffix: string): string {
  const cleaned = title
    .replace(/[<>:"|?*\\/\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 40);
  const base = cleaned.length === 0 ? "topic-" + suffix.slice(0, 8) : cleaned;
  return base + "-" + suffix.slice(0, 8);
}

function requireEditRef(context: CompileContext, ref: unknown): {
  binding: ReturnType<EditRefStore["resolve"]>;
} {
  const binding = context.editRefs.resolve(ref);
  if (binding === null) {
    throw new ServiceError(
      409,
      "STALE_EDIT_REF",
      "editRef 无效或已过期（服务重启、凭据淘汰或旧版本）；请重新读取节点后按真实内容修改",
      { details: { editRef: typeof ref === "string" ? ref.slice(0, 24) : null } },
    );
  }
  return { binding };
}

/** 412：读取之后源文件已被改成别的字节；调用方必须重读，不能拿旧正文覆盖。 */
function staleContent(
  binding: NonNullable<ReturnType<EditRefStore["resolve"]>>,
  actualHash: string,
): ServiceError {
  return new ServiceError(
    412,
    "VERSION_CONFLICT",
    "editRef 读取后源文件已变化；请重新读取节点后再修改（不覆盖他人的改动）",
    {
      details: {
        path: binding.path,
        nodeId: binding.nodeId,
        expectedSha256: binding.fileHash,
        actualSha256: actualHash,
      },
    },
  );
}

/**
 * 核对凭据绑定仍对应当前节点与真实源文件，并返回应声明的旧哈希。
 *
 * 关键点：expectedFiles 必须填"读取时"的 binding.fileHash，而不是当前快照里的哈希，
 * 否则会静默吞掉读取之后别人的修改。当前快照里的哈希与 binding 不一致，说明源已变，
 * 直接 412；即便这里通过，磁盘随后再变也由 prepare／commit 的旧哈希核对再报 412。
 */
function expectedForBinding(
  snapshot: SnapshotData,
  binding: NonNullable<ReturnType<EditRefStore["resolve"]>>,
): Record<string, string | null> {
  if (binding.workspaceId !== snapshot.workspaceId) {
    throw new ServiceError(412, "VERSION_CONFLICT", "editRef 属于另一个工作区", {
      details: { editRefWorkspaceId: binding.workspaceId },
    });
  }
  const topic = snapshot.topics.find((entry) => entry.topicId === binding.topicId);
  if (topic === undefined) {
    throw new ServiceError(409, "STALE_EDIT_REF", "editRef 指向的主题不在当前快照中", {
      details: { topicId: binding.topicId },
    });
  }
  const node = topic.nodes.find((entry) => entry.id === binding.nodeId);
  if (node === undefined || node.sourcePath !== binding.path) {
    throw new ServiceError(412, "VERSION_CONFLICT", "editRef 绑定的节点与源文件不再匹配", {
      details: {
        nodeId: binding.nodeId,
        path: binding.path,
        actualPath: node?.sourcePath ?? null,
      },
    });
  }
  const file = topic.files.find((entry) => entry.path === binding.path);
  if (file === undefined) {
    throw new ServiceError(409, "STALE_EDIT_REF", "editRef 指向的源文件不在当前快照中", {
      details: { path: binding.path },
    });
  }
  if (file.fileHash !== binding.fileHash) {
    // 读取之后该文件已被改过并发布：不能沿用旧正文，也不能偷补新哈希通过。
    throw staleContent(binding, file.fileHash);
  }
  const expected: Record<string, string | null> = {
    [binding.path]: binding.fileHash,
    "workspace.json": snapshot.workspaceHash,
  };
  return expected;
}

function patchNodeOperations(
  action: AgentPatchNodeAction,
  binding: NonNullable<ReturnType<EditRefStore["resolve"]>>,
  schemaVersion: 1 | 2,
): Array<V1Operation | V2Operation> {
  if (schemaVersion === 2) {
    const operation: V2Operation = {
      op: "patchNode",
      nodeId: binding.nodeId,
      ...(action.title !== undefined ? { title: action.title } : {}),
      ...(action.state !== undefined ? { state: action.state } : {}),
      ...(action.summary !== undefined ? { summary: action.summary } : {}),
      ...(action.replace !== undefined ? { replace: action.replace } : {}),
      ...(action.append !== undefined ? { append: action.append } : {}),
      ...(action.body !== undefined ? { body: action.body } : {}),
    };
    return [operation];
  }
  // 格式 1 没有 patchNode：片段修改先由调用方基于实际读取解析，这里只允许整篇或元数据。
  if (action.replace !== undefined || action.append !== undefined) {
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "格式 1 工作区不支持片段修改；请用 body 整篇替换，或迁移到格式 2",
      {},
    );
  }
  return [
    {
      op: "updateNode",
      nodeId: binding.nodeId,
      ...(action.title !== undefined ? { title: action.title } : {}),
      ...(action.state !== undefined ? { state: action.state } : {}),
      ...(action.summary !== undefined ? { summary: action.summary } : {}),
      ...(action.body !== undefined ? { body: action.body } : {}),
    } as V1Operation,
  ];
}

export function compileAgentAction(
  context: CompileContext,
  action: AgentChangeAction,
): CompiledAction {
  const snapshot = context.runtime.current.data;
  const schemaVersion = snapshot.schemaVersion;

  if (action.action === "patchNode") {
    const { binding } = requireEditRef(context, action.editRef);
    const expected = expectedForBinding(snapshot, binding as NonNullable<typeof binding>);
    return {
      operations: patchNodeOperations(action, binding as NonNullable<typeof binding>, schemaVersion),
      expectedFiles: expected,
      created: { topicId: null, topicPath: null, nodeIds: [], paths: [] },
      primaryNodeId: binding?.nodeId ?? null,
      action: action.action,
    };
  }

  if (action.action === "createBranch") {
    return compileCreateBranch(context, action);
  }

  if (action.action === "createNext") {
    return compileCreateNext(context, action);
  }

  if (action.action === "updateConnection") {
    const { binding } = requireEditRef(context, action.editRef);
    const resolved = binding as NonNullable<typeof binding>;
    const expected = expectedForBinding(snapshot, resolved);
    const node = snapshot.graph.nodes.find((entry) => entry.id === resolved.nodeId);
    if (node === undefined) {
      throw new ServiceError(409, "STALE_EDIT_REF", "editRef 指向的节点不在当前快照中", {
        details: { nodeId: resolved.nodeId },
      });
    }
    if (action.description.trim().length === 0) {
      throw new ServiceError(422, "VALIDATION_FAILED", "updateConnection 必须给出新的 description", {});
    }
    if (schemaVersion === 2) {
      const from = resolveFromRef(context, action, snapshot);
      if (from !== undefined) {
        const source = snapshot.topics.find((topic) =>
          topic.nodes.some((entry) => entry.id === from),
        );
        const sourceFile = source?.files.find((file) =>
          source.nodes.find((entry) => entry.id === from)?.sourcePath === file.path,
        );
        if (sourceFile === undefined) {
          throw new ServiceError(409, "STALE_EDIT_REF", "fromRef 指向的源文件不在当前快照中", {
            details: { fromRef: action.fromRef ?? null },
          });
        }
        expected[sourceFile.path] = sourceFile.fileHash;
      }
      return {
        operations: [
          {
            op: "updateConnection",
            nodeId: resolved.nodeId,
            ...(from !== undefined ? { from } : {}),
            ...(action.flow !== undefined ? { flow: action.flow } : {}),
            ...(action.side !== undefined && action.side !== null ? { side: action.side } : {}),
            ...(action.order !== undefined && action.order !== null ? { order: action.order } : {}),
            description: action.description.trim(),
          } as V2Operation,
        ],
        expectedFiles: expected,
        created: { topicId: null, topicPath: null, nodeIds: [], paths: [] },
        primaryNodeId: resolved.nodeId,
        action: action.action,
      };
    }
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "格式 1 没有连接 description；updateConnection 仅用于格式 2 工作区",
      {},
    );
  }

  if (action.action === "rearrange") {
    return compileRearrange(context, action);
  }

  if (action.action === "setImportance") {
    return compileSetImportance(context, action);
  }

  return compileCreateRoot(context, action);
}

function resolveFromRef(
  context: CompileContext,
  action: AgentUpdateConnectionAction,
  snapshot: SnapshotData,
): string | undefined {
  if (action.fromRef === undefined) return undefined;
  const binding = context.editRefs.resolve(action.fromRef);
  if (binding === null) {
    throw new ServiceError(409, "STALE_EDIT_REF", "fromRef 无效或已过期；请重新读取来源节点", {
      details: { fromRef: action.fromRef.slice(0, 24) },
    });
  }
  if (!snapshot.graph.nodes.some((node) => node.id === binding.nodeId)) {
    throw new ServiceError(409, "STALE_EDIT_REF", "fromRef 指向的节点不在当前快照中", {
      details: { fromRef: action.fromRef.slice(0, 24) },
    });
  }
  return binding.nodeId;
}

/** 同一路径被两个凭据读出不同哈希：拒绝拿任何一边覆盖，先重新读取。 */
function conflictingHashes(
  path: string,
  firstHash: string,
  secondHash: string,
): ServiceError {
  return new ServiceError(
    412,
    "VERSION_CONFLICT",
    "同一源文件出现两份不一致的读取哈希（凭据读数不一致）；请重新读取相关节点后再 rearrange",
    { details: { path, firstSha256: firstHash, secondSha256: secondHash } },
  );
}

/** 合并 expectedFiles；同一路径哈希不一致时立即 412，绝不静默选一个。 */
function mergeExpected(
  target: Record<string, string | null>,
  source: Record<string, string | null>,
): void {
  for (const [path, hash] of Object.entries(source)) {
    const existing = target[path];
    if (existing !== undefined && existing !== null && hash !== null && existing !== hash) {
      throw conflictingHashes(path, existing, hash);
    }
    target[path] = hash;
  }
}

/**
 * rearrange：一次表达若干节点的最终入边。
 *
 * 只生成现有 updateConnection 操作，分两步：
 * 1. 腾空——当前是 next、但最终 from 不同或最终不是 next 的节点，先退成
 *    当前来源下的 branch；这些中间状态只存在于内存候选，不落盘。
 * 2. 落位——按调用方的最终关系逐条 updateConnection。
 *
 * 最终唯一 next／无环／结构由候选层整图校验负责；这里不覆盖未在 edits 中
 * 声明的旧后继，占用冲突会自然得到 409。
 */
function compileRearrange(
  context: CompileContext,
  action: AgentRearrangeAction,
): CompiledAction {
  const snapshot = context.runtime.current.data;
  if (snapshot.schemaVersion !== 2) {
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "rearrange 仅用于格式 2 工作区（一节点一份 Markdown）；格式 1 没有可安全改接的节点文件",
      { details: { schemaVersion: snapshot.schemaVersion } },
    );
  }

  interface Target {
    readonly nodeId: string;
    readonly fromNodeId: string;
    readonly flow: "next" | "branch";
    readonly side: "left" | "right" | undefined;
    readonly order: number | undefined;
    readonly description: string;
    readonly currentFrom: string | null;
    readonly currentFlow: GraphNode["flow"];
    readonly currentDescription: string | undefined;
  }

  const expected: Record<string, string | null> = {};
  const targets: Target[] = [];
  const seen = new Set<string>();

  for (const edit of action.edits) {
    const targetBinding = context.editRefs.resolve(edit.editRef);
    if (targetBinding === null) {
      throw new ServiceError(409, "STALE_EDIT_REF", "editRef 无效或已过期；请重新读取要改接的节点", {
        details: { editRef: edit.editRef.slice(0, 24) },
      });
    }
    const fromBinding = context.editRefs.resolve(edit.fromRef);
    if (fromBinding === null) {
      throw new ServiceError(409, "STALE_EDIT_REF", "fromRef 无效或已过期；请重新读取最终来源节点", {
        details: { fromRef: edit.fromRef.slice(0, 24) },
      });
    }
    if (seen.has(targetBinding.nodeId)) {
      throw new ServiceError(
        422,
        "VALIDATION_FAILED",
        "rearrange 的 edits 重复指向同一节点：" + targetBinding.nodeId + "；每个节点只能有一条最终入边",
        { details: { nodeId: targetBinding.nodeId } },
      );
    }
    seen.add(targetBinding.nodeId);

    const targetView = snapshot.graph.nodes.find((entry) => entry.id === targetBinding.nodeId);
    if (targetView === undefined) {
      throw new ServiceError(409, "STALE_EDIT_REF", "editRef 指向的节点不在当前快照中", {
        details: { nodeId: targetBinding.nodeId },
      });
    }
    if (targetView.flow === "root") {
      throw new ServiceError(
        422,
        "VALIDATION_FAILED",
        "rearrange 不能改接 root 节点；每个工作区／隔离主题只能有一个根",
        { details: { nodeId: targetView.id } },
      );
    }
    const fromView = snapshot.graph.nodes.find((entry) => entry.id === fromBinding.nodeId);
    if (fromView === undefined) {
      throw new ServiceError(409, "STALE_EDIT_REF", "fromRef 指向的节点不在当前快照中", {
        details: { nodeId: fromBinding.nodeId },
      });
    }
    if (snapshot.topicMode === "isolated" && targetView.topicId !== fromView.topicId) {
      throw new ServiceError(
        409,
        "OPERATION_CONFLICT",
        "隔离主题不能把节点改接到其他主题的来源",
        { details: { topicId: targetView.topicId, sourceTopicId: fromView.topicId } },
      );
    }

    // 目标与来源都按"读取时哈希"声明；快照已变或两凭据不一致都在写盘前失败。
    mergeExpected(expected, expectedForBinding(snapshot, targetBinding));
    mergeExpected(expected, expectedForBinding(snapshot, fromBinding));

    targets.push({
      nodeId: targetBinding.nodeId,
      fromNodeId: fromBinding.nodeId,
      flow: edit.flow,
      side: edit.flow === "branch" ? edit.side : undefined,
      order: edit.flow === "branch" ? edit.order : undefined,
      description: edit.description.trim(),
      currentFrom: targetView.from,
      currentFlow: targetView.flow,
      currentDescription: targetView.description,
    });
  }

  const operations: V2Operation[] = [];
  // 先腾空所有需要让出 next 位置的节点，再统一落位。
  for (const target of targets) {
    const finalIsNext = target.flow === "next";
    if (
      target.currentFlow === "next" &&
      (target.fromNodeId !== target.currentFrom || !finalIsNext)
    ) {
      operations.push({
        op: "updateConnection",
        nodeId: target.nodeId,
        flow: "branch",
        description:
          target.currentDescription !== undefined && target.currentDescription.trim().length > 0
            ? target.currentDescription
            : target.description,
      });
    }
  }
  for (const target of targets) {
    operations.push({
      op: "updateConnection",
      nodeId: target.nodeId,
      from: target.fromNodeId,
      flow: target.flow,
      ...(target.flow === "branch" && target.side !== undefined ? { side: target.side } : {}),
      ...(target.flow === "branch" && target.order !== undefined ? { order: target.order } : {}),
      description: target.description,
    });
  }

  return {
    operations,
    expectedFiles: expected,
    created: { topicId: null, topicPath: null, nodeIds: [], paths: [] },
    // rearrange 是多节点操作：不签发单节点兼容 editRef，凭据统一走 editRefs。
    primaryNodeId: null,
    action: action.action,
  };
}

/** setImportance：只改一项元数据；值未变由候选层按 no-op 处理。 */
function compileSetImportance(
  context: CompileContext,
  action: AgentSetImportanceAction,
): CompiledAction {
  const snapshot = context.runtime.current.data;
  if (snapshot.schemaVersion !== 2) {
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "重要标记只支持格式 2 工作区（一节点一份 Markdown）；格式 1 没有该写入口",
      { details: { schemaVersion: snapshot.schemaVersion } },
    );
  }
  const { binding } = requireEditRef(context, action.editRef);
  const resolved = binding as NonNullable<typeof binding>;
  const expected = expectedForBinding(snapshot, resolved);
  if (!snapshot.graph.nodes.some((entry) => entry.id === resolved.nodeId)) {
    throw new ServiceError(409, "STALE_EDIT_REF", "editRef 指向的节点不在当前快照中", {
      details: { nodeId: resolved.nodeId },
    });
  }
  return {
    operations: [
      { op: "setImportance", nodeId: resolved.nodeId, important: action.important },
    ] as V2Operation[],
    expectedFiles: expected,
    created: { topicId: null, topicPath: null, nodeIds: [], paths: [] },
    primaryNodeId: resolved.nodeId,
    action: action.action,
  };
}

function compileCreateBranch(context: CompileContext, action: AgentCreateBranchAction): CompiledAction {
  const snapshot = context.runtime.current.data;
  const { binding } = requireEditRef(context, action.editRef);
  const resolved = binding as NonNullable<typeof binding>;
  if (!snapshot.graph.nodes.some((entry) => entry.id === resolved.nodeId)) {
    throw new ServiceError(409, "STALE_EDIT_REF", "editRef 指向的节点不在当前快照中", {
      details: { nodeId: resolved.nodeId },
    });
  }
  return compileChild(context, {
    node: resolved,
    title: action.title,
    body: action.body,
    description: action.description,
    state: action.state,
    topicId: action.topicId,
    flow: "branch",
    side: action.side,
    order: action.order,
    action: action.action,
  });
}

interface ChildInput {
  readonly node: NonNullable<ReturnType<EditRefStore["resolve"]>>;
  readonly title: string;
  readonly body: string;
  readonly description: string;
  readonly state: AgentCreateBranchAction["state"];
  readonly topicId: string | undefined;
  readonly flow: "next" | "branch";
  readonly side: AgentCreateBranchAction["side"];
  readonly order: number | undefined;
  readonly action: AgentChangeAction["action"];
}

/** createBranch 与 createNext 的唯一实现：同一事务、同一 ID 生成与重放规则。 */
function compileChild(context: CompileContext, input: ChildInput): CompiledAction {
  const snapshot = context.runtime.current.data;
  if (input.title.trim().length === 0) {
    throw new ServiceError(422, "VALIDATION_FAILED", input.action + " 需要非空标题", {});
  }
  if (input.description.trim().length === 0) {
    throw new ServiceError(
      422,
      "VALIDATION_FAILED",
      input.action + " 需要说明为什么接到来源",
      {},
    );
  }
  const topicId = input.topicId ?? input.node.topicId;
  if (snapshot.topicMode === "isolated" && topicId !== input.node.topicId) {
    throw new ServiceError(409, "OPERATION_CONFLICT", "隔离主题不能连接其他主题的节点", { details: { topicId, sourceTopicId: input.node.topicId } });
  }
  const topic = snapshot.topics.find((entry) => entry.topicId === topicId);
  if (topic === undefined) {
    throw new ServiceError(422, "VALIDATION_FAILED", input.action + " 的目标主题不存在", {
      details: { topicId },
    });
  }
  // 重放必须复用同一 ID：优先使用请求记录里的生成值。
  const nodeId = context.generated?.nodeId ?? newId("n_");
  const expected = expectedForBinding(snapshot, input.node);
  expected[topic.path] = topic.fileHash;
  // 新节点文件尚不存在：必须显式声明 null，候选层不接受"漏声明"。
  const newNodePath = newNodeFilePath(topic, nodeId);
  expected[newNodePath] = null;

  const base = {
    nodeId,
    topicId,
    title: input.title.trim(),
    body: input.body,
    from: input.node.nodeId,
    flow: input.flow,
    state: input.state ?? "proposed",
    description: input.description.trim(),
    ...(input.side !== undefined ? { side: input.side } : {}),
    ...(input.order !== undefined ? { order: input.order } : {}),
  };
  const operations: Array<V1Operation | V2Operation> =
    snapshot.schemaVersion === 2
      ? [{ op: "createNode", ...base } as V2Operation]
      : input.flow === "next"
        ? [{ op: "createNode", ...base } as V1Operation]
        : [{ op: "createNode", ...base, order: input.order ?? 10 } as V1Operation];

  return {
    operations,
    expectedFiles: expected,
    created: {
      topicId: null,
      topicPath: null,
      nodeIds: [nodeId],
      paths: [newNodePath],
    },
    primaryNodeId: nodeId,
    action: input.action,
  };
}

/**
 * 纵向后继：与 createBranch 共用同一实现，仅 flow 与 side／order 不同。
 * 来源已有 next 时由候选层拒绝（OPERATION_CONFLICT），这里先友好报 409。
 */
function compileCreateNext(context: CompileContext, action: AgentCreateNextAction): CompiledAction {
  const snapshot = context.runtime.current.data;
  const { binding } = requireEditRef(context, action.editRef);
  const resolved = binding as NonNullable<typeof binding>;
  const node = snapshot.graph.nodes.find((entry) => entry.id === resolved.nodeId);
  if (node === undefined) {
    throw new ServiceError(409, "STALE_EDIT_REF", "editRef 指向的节点不在当前快照中", {
      details: { nodeId: resolved.nodeId },
    });
  }
  if (node.nextId !== null) {
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "来源已有纵向后继（" + node.nextId + "）；createNext 不会插入或挤走主线",
      { details: { sourceId: node.id, nextId: node.nextId } },
    );
  }
  return compileChild(context, {
    node: resolved,
    title: action.title,
    body: action.body,
    description: action.description,
    state: action.state,
    topicId: action.topicId,
    flow: "next",
    side: undefined,
    order: undefined,
    action: action.action,
  });
}

function compileCreateRoot(context: CompileContext, action: AgentCreateRootAction | AgentCreateTopicAction): CompiledAction {
  const snapshot = context.runtime.current.data;
  if (action.action === "createTopic" && snapshot.topicMode !== "isolated") {
    throw new ServiceError(409, "OPERATION_CONFLICT", "createTopic 需要 isolated 工作区；旧 shared 工作区不能自动转换", {});
  }
  if (action.action === "createRoot" && snapshot.graph.nodes.length > 0) {
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "工作区已有内容；createRoot 只用于空工作区，新增节点请用 createBranch 或低层 apply",
      { details: { nodeCount: snapshot.graph.nodes.length } },
    );
  }
  if (snapshot.schemaVersion !== 2) {
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "createRoot 只支持格式 2 工作区；格式 1 请用低层 createTopic＋createNode",
      {},
    );
  }
  if (action.topicTitle.trim().length === 0) {
    throw new ServiceError(422, "VALIDATION_FAILED", "createRoot 需要主题标题", {});
  }
  const title = action.title ?? action.topicTitle;
  if (title.trim().length === 0) {
    throw new ServiceError(422, "VALIDATION_FAILED", "createRoot 需要节点标题", {});
  }
  const topicId = context.generated?.topicId ?? newId("t_");
  const nodeId = context.generated?.nodeId ?? newId("n_");
  const dir = context.generated?.dir ?? (action.action === "createTopic"
    ? isolatedTopicDirectory(action.topicTitle, action.directory)
    : topicDirectory(action.topicTitle, topicId.slice(2, 10)));
  if (snapshot.topics.some((topic) => topic.path.split("/")[1]?.toLocaleLowerCase() === dir.toLocaleLowerCase())) {
    throw new ServiceError(409, "OPERATION_CONFLICT", "主题目录已存在：" + dir, { details: { directory: dir } });
  }
  const operations: V2Operation[] = [
    { op: "createTopic", topicId, path: dir, title: action.topicTitle.trim() },
    {
      op: "createNode",
      nodeId,
      topicId,
      title: title.trim(),
      body: action.body,
      from: null,
      flow: "root",
      state: action.state ?? "proposed",
    },
  ];
  const metaPath = "topics/" + dir + "/topic.md";
  const rootNodePath = "topics/" + dir + "/" + nodeId + ".md";
  return {
    operations,
    expectedFiles: {
      "workspace.json": snapshot.workspaceHash,
      // 新建主题与节点文件都尚不存在。
      [metaPath]: null,
      [rootNodePath]: null,
    },
    created: {
      topicId,
      topicPath: metaPath,
      nodeIds: [nodeId],
      paths: [metaPath, rootNodePath],
    },
    primaryNodeId: nodeId,
    action: action.action,
  };
}

function isolatedTopicDirectory(title: string, explicit?: string): string {
  let dir = explicit ?? title.trim().replace(/[<>:"|?*\\/\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "");
  if (explicit === undefined && (dir.length === 0 || dir.startsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(dir))) dir = "topic-" + dir.replace(/^\.+/, "");
  try {
    if (dir.trim() !== dir || dir.startsWith(".") || dir.includes("/") || dir.includes("\\") || dir === "topic.md") throw new Error("必须是非隐藏的单层目录名");
    normalizeRelativePath(dir);
  } catch (error) {
    throw new ServiceError(422, "VALIDATION_FAILED", "非法主题目录：" + dir + "；" + (error instanceof Error ? error.message : String(error)), {});
  }
  return dir;
}

/** 生成新节点后的读取凭据（正文已在快照中）；找不到时返回 null。 */
export function issueRefForNode(
  runtime: WorkspaceRuntime,
  editRefs: EditRefStore,
  nodeId: string,
): AgentEditRef | null {
  const found = findParsedNode(runtime.current.data, nodeId);
  if (found === null) return null;
  return editRefs.issue({
    workspaceId: runtime.current.data.workspaceId,
    topicId: found.node.topicId,
    nodeId: found.node.id,
    path: found.node.sourcePath,
    fileHash: found.fileHash,
    instanceId: runtime.instanceId,
    revision: runtime.current.revision,
  });
}