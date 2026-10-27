/**
 * Agent 动作编译：把 patchNode／createBranch／createNext／updateConnection／
 * rearrange／setImportance／createRoot／createTopic 编译成现有 storage 变更请求，
 * 交回同一 apply 链路（队列 → 候选 → 事务 → 发布），不复制候选业务、不绕过队列。
 *
 * 本模块不做 IO；由 changes.ts 在同一队列内调用。
 */
import { randomUUID } from "node:crypto";
import type {
  AgentBatchAction,
  AgentBatchConnectOp,
  AgentBatchCreateOp,
  AgentBatchEditOp,
  AgentBatchImportantOp,
  AgentChangeAction,
  AgentCreateBranchAction,
  AgentCreateNextAction,
  AgentCreateRootAction,
  AgentCreateTopicAction,
  AgentEditRef,
  AgentInsertAction,
  AgentNodeSelector,
  AgentPatchNodeAction,
  AgentRearrangeAction,
  AgentSetImportanceAction,
  AgentUpdateConnectionAction,
  BranchSide,
  GraphNode,
} from "../../shared/protocol.js";
import type { WorkspaceNodeView } from "../../core/index.js";
import type {
  Operation,
  PatchNodeOperation,
} from "../../storage/index.js";
import { normalizeRelativePath } from "../../storage/paths.js";
import type { WorkspaceRuntime } from "../workspace.js";
import type { SnapshotData, TopicSnapshot } from "../snapshot.js";
import { ServiceError } from "../errors.js";
import type { EditRefStore } from "../editref.js";
import { findParsedNode } from "./shared.js";

export interface CompiledCreated {
  topicId: string | null;
  /** 新建主题时它的入口文件（topic.md）；追加到现有主题为 null。 */
  topicPath: string | null;
  nodeIds: string[];
  paths: string[];
  /** batch：局部名称 → 稳定 nodeId；其他动作为 {}。 */
  aliases: Record<string, string>;
}

export interface CompiledAction {
  readonly operations: Operation[];
  /** 本次需要声明的旧哈希（相对路径 → 现有哈希或 null）。 */
  readonly expectedFiles: Record<string, string | null>;
  /** 生成的新 ID（重放时由请求记录复用，不重新生成）。 */
  readonly created: CompiledCreated;
  readonly action: AgentChangeAction["action"];
  /** 本次写入所属主题；响应顶层 topicId 直接取这里。 */
  readonly topicId: string;
}

export interface CompileContext {
  readonly runtime: WorkspaceRuntime;
  readonly editRefs: EditRefStore;
  readonly requestId: string;
  /** 同一 requestId 之前生成过的 ID；重放必须复用。 */
  readonly generated: { topicId: string; nodeId: string; dir: string } | null;
}

/** 新节点文件的相对路径：主题目录/<nodeId>.md。 */
function newNodeFilePath(topic: TopicSnapshot, nodeId: string): string {
  const dir = topic.path.split("/").slice(0, -1).join("/");
  return dir + "/" + nodeId + ".md";
}

function topicDirectoryPath(topic: TopicSnapshot): string {
  return topic.path.split("/").slice(0, -1).join("/");
}

function emptyCreated(): CompiledCreated {
  return { topicId: null, topicPath: null, nodeIds: [], paths: [], aliases: {} };
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
): PatchNodeOperation[] {
  return [
    {
      op: "patchNode",
      nodeId: binding.nodeId,
      ...(action.title !== undefined ? { title: action.title } : {}),
      ...(action.state !== undefined ? { state: action.state } : {}),
      ...(action.summary !== undefined ? { summary: action.summary } : {}),
      ...(action.replace !== undefined ? { replace: action.replace } : {}),
      ...(action.append !== undefined ? { append: action.append } : {}),
      ...(action.body !== undefined ? { body: action.body } : {}),
    },
  ];
}

export function compileAgentAction(
  context: CompileContext,
  action: AgentChangeAction,
): CompiledAction {
  const snapshot = context.runtime.current.data;

  if (action.action === "patchNode") {
    return compilePatchNode(context, action);
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
        },
      ],
      expectedFiles: expected,
      created: emptyCreated(),
      action: action.action,
      topicId: resolved.topicId,
    };
  }

  if (action.action === "rearrange") {
    return compileRearrange(context, action);
  }

  if (action.action === "setImportance") {
    return compileSetImportance(context, action);
  }

  if (action.action === "batch") {
    return compileBatch(context, action);
  }

  if (action.action === "insert") {
    return compileInsert(context, action);
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

  interface Target {
    readonly nodeId: string;
    readonly topicId: string;
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
    if (targetView.topicId !== fromView.topicId) {
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
      topicId: targetView.topicId,
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

  const operations: Operation[] = [];
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
    created: emptyCreated(),
    action: action.action,
    // 多节点操作：以第一条最终入边的目标主题作为响应主题。
    topicId: targets[0]?.topicId ?? snapshot.workspaceId,
  };
}

/** setImportance：只改一项元数据；值未变由候选层按 no-op 处理。 */
function compileSetImportance(
  context: CompileContext,
  action: AgentSetImportanceAction,
): CompiledAction {
  const snapshot = context.runtime.current.data;
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
    ],
    expectedFiles: expected,
    created: emptyCreated(),
    action: action.action,
    topicId: resolved.topicId,
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
    summary: action.summary,
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
  readonly summary: string | undefined;
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
  if (topicId !== input.node.topicId) {
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "隔离主题不能连接其他主题的节点",
      { details: { topicId, sourceTopicId: input.node.topicId } },
    );
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
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.side !== undefined ? { side: input.side } : {}),
    ...(input.order !== undefined ? { order: input.order } : {}),
  };
  const operations: Operation[] = [{ op: "createNode", ...base }];

  return {
    operations,
    expectedFiles: expected,
    created: {
      topicId: null,
      topicPath: null,
      nodeIds: [nodeId],
      paths: [newNodePath],
      aliases: {},
    },
    action: input.action,
    topicId: topic.topicId,
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
    summary: action.summary,
    topicId: action.topicId,
    flow: "next",
    side: undefined,
    order: undefined,
    action: action.action,
  });
}

function compileCreateRoot(context: CompileContext, action: AgentCreateRootAction | AgentCreateTopicAction): CompiledAction {
  const snapshot = context.runtime.current.data;
  if (action.action === "createRoot" && snapshot.graph.nodes.length > 0) {
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "工作区已有内容；createRoot 只用于空工作区，新增节点请用 createBranch 或低层 apply",
      { details: { nodeCount: snapshot.graph.nodes.length } },
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
  const operations: Operation[] = [
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
      ...(action.summary !== undefined ? { summary: action.summary } : {}),
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
      aliases: {},
    },
    action: action.action,
    topicId,
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

/**
 * edit 复合动作：内容 patchNode → 入边 updateConnection → 重要性 setImportance
 * 编译成同一个 ChangeRequest，一次 prepareChanges／commitFiles。
 *
 * - 未给出的字段不生成操作；只 important 时 setImportance 是唯一操作，
 *   storage 的 contentNodeIds 会排除该节点（不替换最近内容更新）；
 * - fromRef 的来源必须按读取时哈希声明，跨主题／自连／根节点入边在这里明确拒绝；
 * - 占位后继、成环等最终结构仍由候选层整图校验，不重复实现。
 */
function compilePatchNode(
  context: CompileContext,
  action: AgentPatchNodeAction,
): CompiledAction {
  const snapshot = context.runtime.current.data;
  const { binding } = requireEditRef(context, action.editRef);
  const resolved = binding as NonNullable<typeof binding>;
  const expected = expectedForBinding(snapshot, resolved);
  const node = snapshot.graph.nodes.find((entry) => entry.id === resolved.nodeId);
  if (node === undefined) {
    throw new ServiceError(409, "STALE_EDIT_REF", "editRef 指向的节点不在当前快照中", {
      details: { nodeId: resolved.nodeId },
    });
  }

  // 入边字段：description／fromRef／flow 任一出现即视为"改入边"。
  const hasConnection =
    action.description !== undefined || action.fromRef !== undefined || action.flow !== undefined;
  if (node.flow === "root" && hasConnection) {
    const field =
      action.fromRef !== undefined ? "fromRef" : action.flow !== undefined ? "flow" : "description";
    throw new ServiceError(
      422,
      "VALIDATION_FAILED",
      "根节点没有入边，不能修改 description／fromRef／flow；只能改内容或重要标记" +
        "（可用 aichat help edit --json 查看 edit 字段）",
      { details: { category: "structure", nodeId: node.id, topicId: node.topicId, field } },
    );
  }

  let fromNodeId: string | undefined;
  if (action.fromRef !== undefined) {
    const sourceBinding = context.editRefs.resolve(action.fromRef);
    if (sourceBinding === null) {
      throw new ServiceError(409, "STALE_EDIT_REF", "fromRef 无效或已过期；请重新读取来源节点", {
        details: { category: "version", field: "fromRef", fromRef: action.fromRef.slice(0, 24) },
      });
    }
    // 来源文件必须声明读取时哈希；读取后被改过由 expectedForBinding 报 412。
    mergeExpected(expected, expectedForBinding(snapshot, sourceBinding));
    const source = snapshot.graph.nodes.find((entry) => entry.id === sourceBinding.nodeId);
    if (source === undefined) {
      throw new ServiceError(409, "STALE_EDIT_REF", "fromRef 指向的节点不在当前快照中", {
        details: { category: "version", field: "fromRef", fromRef: action.fromRef.slice(0, 24) },
      });
    }
    if (source.id === node.id) {
      throw new ServiceError(
        422,
        "VALIDATION_FAILED",
        "节点不能把自己作为来源（自连）；请选择另一个节点作为入边来源" +
          "（可用 aichat help edit --json）",
        { details: { category: "structure", field: "fromRef", nodeId: node.id } },
      );
    }
    if (source.topicId !== node.topicId) {
      throw new ServiceError(
        422,
        "VALIDATION_FAILED",
        "隔离主题不能把入边改接到其他主题的来源；请在同一主题内选择来源" +
          "（可用 aichat help edit --json）",
        {
          details: {
            category: "structure",
            field: "fromRef",
            nodeId: node.id,
            topicId: node.topicId,
            sourceNodeId: source.id,
            sourceTopicId: source.topicId,
          },
        },
      );
    }
    fromNodeId = source.id;
  }

  const operations: Operation[] = [];
  const hasContent =
    action.title !== undefined ||
    action.state !== undefined ||
    action.summary !== undefined ||
    action.replace !== undefined ||
    action.append !== undefined ||
    action.body !== undefined;
  if (hasContent) operations.push(...patchNodeOperations(action, resolved));
  if (hasConnection) {
    if (action.description === undefined) {
      // schema 已保证；保留防御，避免绕过 HTTP 层时写出没有理由的入边。
      throw new ServiceError(422, "VALIDATION_FAILED", "修改入边时必须给出 description", {
        details: { category: "parameter", field: "description", nodeId: node.id },
      });
    }
    operations.push({
      op: "updateConnection",
      nodeId: resolved.nodeId,
      ...(fromNodeId !== undefined ? { from: fromNodeId } : {}),
      ...(action.flow !== undefined ? { flow: action.flow } : {}),
      description: action.description.trim(),
    });
  }
  if (action.important !== undefined) {
    operations.push({
      op: "setImportance",
      nodeId: resolved.nodeId,
      important: action.important,
    });
  }

  return {
    operations,
    expectedFiles: expected,
    created: emptyCreated(),
    action: action.action,
    topicId: resolved.topicId,
  };
}

/* ------------------------------------------------------------------ *
 * batch / insert：一次编译成单个 ChangeRequest
 * ------------------------------------------------------------------ */

type ResolvedBinding = NonNullable<ReturnType<EditRefStore["resolve"]>>;

type BatchFlow = "next" | "branch";

interface BatchExisting {
  readonly binding: ResolvedBinding;
  readonly view: WorkspaceNodeView;
}

interface BatchFinalRelation {
  from: string | null;
  flow: "root" | BatchFlow;
  description: string | undefined;
  side: BranchSide | undefined;
  order: number | undefined;
  /** 设置这条最终关系的 op 下标；原有关系为 null。 */
  opIndex: number | null;
}

interface BatchCreateSpec {
  readonly index: number;
  readonly op: AgentBatchCreateOp;
  readonly local: string;
  readonly nodeId: string;
  readonly path: string;
  fromLocal: string | null;
  fromNodeId: string;
  final: BatchFinalRelation;
}

/** 参数／字段问题：422，details.category=parameter。 */
function batchParameter(message: string, details: Record<string, unknown>): ServiceError {
  return new ServiceError(422, "VALIDATION_FAILED", message, {
    details: { category: "parameter", ...details },
  });
}

/**
 * 格式／结构不合法：422 VALIDATION_FAILED（跨主题连接、局部依赖环、最终重复 next、
 * 最终连接成环）。details.category 仍是 structure，便于调用方按类别解释。
 */
function batchStructure(message: string, details: Record<string, unknown>): ServiceError {
  return new ServiceError(422, "VALIDATION_FAILED", message, {
    details: { category: "structure", ...details },
  });
}

/**
 * 语义／占位冲突：409 OPERATION_CONFLICT（next 槽位仍被原后继占用、
 * insert 的 after 与 before 不是当前真实相邻 next）。
 */
function batchConflict(message: string, details: Record<string, unknown>): ServiceError {
  return new ServiceError(409, "OPERATION_CONFLICT", message, {
    details: { category: "structure", ...details },
  });
}

/** ref 失效：409 STALE_EDIT_REF；源文件读取后被改由 expectedForBinding 报 412。 */
function batchVersion(message: string, details: Record<string, unknown>): ServiceError {
  return new ServiceError(409, "STALE_EDIT_REF", message, {
    details: { category: "version", ...details },
  });
}

/**
 * 解析批次内已有节点：token 必须在本实例有效，且其读取哈希仍是当前快照的哈希
 * （读取后被发布过 → 412，绝不静默补新哈希）。所有 old 文件哈希在这里累计。
 */
function resolveBatchRef(
  context: CompileContext,
  snapshot: SnapshotData,
  topicId: string,
  ref: string,
  where: Record<string, unknown>,
  expected: Record<string, string | null>,
  cache: Map<string, BatchExisting>,
): BatchExisting {
  const cached = cache.get(ref);
  if (cached !== undefined) return cached;
  const binding = context.editRefs.resolve(ref);
  if (binding === null) {
    throw batchVersion(
      "ref 无效或已过期（服务重启、凭据淘汰或旧版本）；请重新读取节点后再提交",
      { ...where, ref: ref.slice(0, 24) },
    );
  }
  mergeExpected(expected, expectedForBinding(snapshot, binding));
  const view = snapshot.graph.nodes.find((entry) => entry.id === binding.nodeId);
  if (view === undefined) {
    throw batchVersion("ref 绑定的节点不在当前快照中；请重新读取节点", {
      ...where,
      nodeId: binding.nodeId,
    });
  }
  if (view.topicId !== topicId) {
    throw batchStructure("隔离主题不能连接其他主题的节点", {
      ...where,
      nodeId: view.id,
      topicId,
      actualTopicId: view.topicId,
    });
  }
  const resolved: BatchExisting = { binding, view };
  cache.set(ref, resolved);
  return resolved;
}

/** 稳定拓扑排序：被引用的 create 先创建；同层按输入顺序。 */
function orderCreatesForCreation(
  creates: readonly BatchCreateSpec[],
  createByLocal: ReadonlyMap<string, BatchCreateSpec>,
): BatchCreateSpec[] {
  const byNodeId = new Map(creates.map((spec) => [spec.nodeId, spec] as const));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const spec of creates) indegree.set(spec.nodeId, 0);
  for (const spec of creates) {
    if (spec.fromLocal === null) continue;
    const dependency = createByLocal.get(spec.fromLocal);
    if (dependency === undefined) continue;
    indegree.set(spec.nodeId, (indegree.get(spec.nodeId) ?? 0) + 1);
    const bucket = dependents.get(dependency.nodeId);
    if (bucket === undefined) dependents.set(dependency.nodeId, [spec.nodeId]);
    else bucket.push(spec.nodeId);
  }
  const ready = creates.filter((spec) => (indegree.get(spec.nodeId) ?? 0) === 0);
  ready.sort((left, right) => left.index - right.index);
  const ordered: BatchCreateSpec[] = [];
  while (ready.length > 0) {
    const current = ready.shift() as BatchCreateSpec;
    ordered.push(current);
    for (const nodeId of dependents.get(current.nodeId) ?? []) {
      const remaining = (indegree.get(nodeId) ?? 0) - 1;
      indegree.set(nodeId, remaining);
      if (remaining !== 0) continue;
      const spec = byNodeId.get(nodeId);
      if (spec === undefined) continue;
      ready.push(spec);
      ready.sort((left, right) => left.index - right.index);
    }
  }
  if (ordered.length !== creates.length) {
    const pending = creates.filter((spec) => !ordered.includes(spec));
    throw batchStructure(
      "本批 create 的局部依赖形成环，无法确定创建顺序：" + pending.map((spec) => spec.local).join("、"),
      {
        ops: pending.map((spec) => spec.index),
        locals: pending.map((spec) => spec.local),
        conflict: "local-cycle",
      },
    );
  }
  return ordered;
}

/**
 * batch 的唯一实现：按批前 snapshot 解释 ref，编译成一次原子 ChangeRequest。
 *
 * 顺序：腾空旧 next → 按依赖拓扑 create → 最终 updateConnection → patch／important。
 * 中间结构只存在于内存候选；唯一 next／无环／根不变／主题隔离在生成操作前整图预检，
 * 最终写盘内容仍由 prepareChanges 再校验一次。
 */
function compileBatch(context: CompileContext, action: AgentBatchAction): CompiledAction {
  const snapshot = context.runtime.current.data;
  const topic = snapshot.topics.find((entry) => entry.topicId === action.topicId);
  if (topic === undefined) {
    throw batchParameter("当前有效快照中没有主题 " + action.topicId + "；batch 只能维护已存在的主题", {
      topicId: action.topicId,
      field: "topicId",
    });
  }
  const expected: Record<string, string | null> = {
    "workspace.json": snapshot.workspaceHash,
    [topic.path]: topic.fileHash,
  };
  const refCache = new Map<string, BatchExisting>();
  const topicNodes = new Map<string, WorkspaceNodeView>();
  for (const view of snapshot.graph.nodes) {
    if (view.topicId === topic.topicId) topicNodes.set(view.id, view);
  }
  const topicDir = topicDirectoryPath(topic);

  // 第一步：为 create 生成本批稳定 ID，建立局部名称表（允许前向引用）。
  const creates: BatchCreateSpec[] = [];
  const createByLocal = new Map<string, BatchCreateSpec>();
  const edits: Array<{ index: number; op: AgentBatchEditOp; existing: BatchExisting }> = [];
  const connects: Array<{
    index: number;
    op: AgentBatchConnectOp;
    existing: BatchExisting;
    fromNodeId: string | null;
    fromLocal: string | null;
  }> = [];
  const importants: Array<{ index: number; op: AgentBatchImportantOp; existing: BatchExisting }> = [];

  action.ops.forEach((op, index) => {
    if (op.op !== "create") return;
    const local = op.as.trim();
    if (createByLocal.has(local)) {
      throw batchParameter("batch 的局部名称重复：" + local + "；同一批内 local 必须唯一", {
        ops: [index],
        field: "as",
        local,
        conflict: "local-duplicate",
      });
    }
    const nodeId = newId("n_");
    const path = topicDir + "/" + nodeId + ".md";
    const spec: BatchCreateSpec = {
      index,
      op,
      local,
      nodeId,
      path,
      fromLocal: null,
      fromNodeId: "",
      final: {
        from: null,
        flow: op.flow,
        description: op.description.trim(),
        side: op.flow === "branch" ? op.side : undefined,
        order: op.flow === "branch" ? op.order : undefined,
        opIndex: index,
      },
    };
    creates.push(spec);
    createByLocal.set(local, spec);
    expected[path] = null;
  });

  // 选择器：ref 按批前快照解释；local 只在本输入有效。
  const resolveSelector = (
    selector: AgentNodeSelector,
    where: Record<string, unknown>,
  ): { nodeId: string; local: string | null } => {
    if (selector.ref !== undefined) {
      const existing = resolveBatchRef(
        context,
        snapshot,
        topic.topicId,
        selector.ref,
        where,
        expected,
        refCache,
      );
      return { nodeId: existing.binding.nodeId, local: null };
    }
    if (selector.local !== undefined) {
      const local = selector.local.trim();
      const spec = createByLocal.get(local);
      if (spec === undefined) {
        throw batchParameter(
          "local 名称未在本批 create 中声明：" + local + "；只能引用同一输入的 create.as",
          { ...where, local, conflict: "local-unknown" },
        );
      }
      return { nodeId: spec.nodeId, local };
    }
    throw batchParameter("from 必须给出 ref 或 local 之一", where);
  };

  for (const spec of creates) {
    const resolved = resolveSelector(spec.op.from, { ops: [spec.index], field: "from" });
    spec.fromLocal = resolved.local;
    spec.fromNodeId = resolved.nodeId;
    spec.final.from = resolved.nodeId;
  }
  // 局部依赖环必须在整图预检之前报出（否则会先表现为最终图成环）：
  // 它属于 create 输入本身无法排序的结构错误。
  const orderedCreates = orderCreatesForCreation(creates, createByLocal);

  const kindsByNode = new Map<string, Set<string>>();
  const claimKind = (nodeId: string, kind: string, index: number, field: string): void => {
    const kinds = kindsByNode.get(nodeId) ?? new Set<string>();
    if (kinds.has(kind)) {
      throw batchParameter(
        "同一节点在本批不能重复同类操作（" + kind + "）：" + nodeId,
        { ops: [index], field, nodeId, conflict: "duplicate-op" },
      );
    }
    kinds.add(kind);
    kindsByNode.set(nodeId, kinds);
  };

  action.ops.forEach((op, index) => {
    if (op.op !== "edit") return;
    const existing = resolveBatchRef(
      context,
      snapshot,
      topic.topicId,
      op.target.ref,
      { ops: [index], field: "target.ref" },
      expected,
      refCache,
    );
    claimKind(existing.binding.nodeId, "edit", index, "target.ref");
    edits.push({ index, op, existing });
  });

  action.ops.forEach((op, index) => {
    if (op.op !== "connect") return;
    const existing = resolveBatchRef(
      context,
      snapshot,
      topic.topicId,
      op.target.ref,
      { ops: [index], field: "target.ref" },
      expected,
      refCache,
    );
    claimKind(existing.binding.nodeId, "connect", index, "target.ref");
    if (existing.view.flow === "root") {
      throw new ServiceError(
        422,
        "VALIDATION_FAILED",
        "batch 不能改接根节点；每个主题的根保持不变",
        {
          details: {
            category: "structure",
            ops: [index],
            field: "target.ref",
            nodeId: existing.binding.nodeId,
            conflict: "root-immutable",
          },
        },
      );
    }
    let fromNodeId: string | null = null;
    let fromLocal: string | null = null;
    if (op.from !== undefined) {
      if (op.flow === undefined) {
        throw batchParameter("给出 from 时必须同时给出 flow（只给 flow 才沿用当前来源）", {
          ops: [index],
          field: "flow",
          nodeId: existing.binding.nodeId,
          conflict: "from-without-flow",
        });
      }
      const resolved = resolveSelector(op.from, { ops: [index], field: "from" });
      fromNodeId = resolved.nodeId;
      fromLocal = resolved.local;
    }
    connects.push({ index, op, existing, fromNodeId, fromLocal });
  });

  action.ops.forEach((op, index) => {
    if (op.op !== "important") return;
    const existing = resolveBatchRef(
      context,
      snapshot,
      topic.topicId,
      op.target.ref,
      { ops: [index], field: "target.ref" },
      expected,
      refCache,
    );
    claimKind(existing.binding.nodeId, "important", index, "target.ref");
    importants.push({ index, op, existing });
  });

  // 第二步：最终入边。已有节点从批前关系出发，create 直接以输入关系为最终关系。
  const finalRelations = new Map<string, BatchFinalRelation>();
  for (const [nodeId, view] of topicNodes) {
    finalRelations.set(nodeId, {
      from: view.from,
      flow: view.flow,
      description: view.description,
      side: view.side,
      order: view.order,
      opIndex: null,
    });
  }
  for (const spec of creates) finalRelations.set(spec.nodeId, spec.final);

  // 默认 branch order：同一来源的现有最大 order + 10，按输入顺序稳定递增；
  // 不依赖 storage 的临时默认值（否则多 create 的分配会随操作顺序漂移）。
  const maxOrderBySource = new Map<string, number>();
  for (const view of topicNodes.values()) {
    if (view.from === null || view.flow !== "branch" || view.order === undefined) continue;
    const current = maxOrderBySource.get(view.from);
    if (current === undefined || view.order > current) maxOrderBySource.set(view.from, view.order);
  }
  const takeNextOrder = (sourceId: string): number => {
    const next = (maxOrderBySource.get(sourceId) ?? 0) + 10;
    maxOrderBySource.set(sourceId, next);
    return next;
  };
  for (const spec of creates) {
    if (spec.final.flow !== "branch" || spec.final.order !== undefined) continue;
    spec.final.order = takeNextOrder(spec.final.from as string);
  }

  for (const connect of connects) {
    const pre = connect.existing.view;
    const relation = finalRelations.get(pre.id) as BatchFinalRelation;
    const flow: BatchFlow = connect.op.flow ?? (pre.flow === "root" ? "branch" : pre.flow);
    const from = connect.fromNodeId ?? pre.from;
    if (from === null) {
      throw batchParameter("连接必须有来源节点", {
        ops: [connect.index],
        field: "from",
        nodeId: pre.id,
      });
    }
    let side: BranchSide | undefined;
    let order: number | undefined;
    if (flow === "next") {
      if (connect.op.side !== undefined || connect.op.order !== undefined) {
        throw batchParameter("最终 flow=next 时不能带 side／order", {
          ops: [connect.index],
          field: connect.op.side !== undefined ? "side" : "order",
          nodeId: pre.id,
        });
      }
    } else {
      const sameSource = from === pre.from;
      side = connect.op.side ?? (pre.flow === "branch" && sameSource ? pre.side : undefined);
      order = connect.op.order;
      if (order === undefined) {
        order = pre.flow === "branch" && sameSource ? pre.order : takeNextOrder(from);
      }
    }
    relation.from = from;
    relation.flow = flow;
    relation.description = connect.op.description.trim();
    relation.side = side;
    relation.order = order;
    relation.opIndex = connect.index;
  }

  // 第三步：整图预检——唯一 next、无环、根不变、主题隔离。
  //
  // 先报占位／缺省原后继最终位置（语义冲突 409）：本批新声明的 next 若撞上
  // 批前原后继、而原后继又没有显式改接，则不能自动挤掉。仅此场景保留 409；
  // 其余"最终图本身不合法"（没有原后继可让位却出现多个 next）是结构错误 422。
  const preNextBySource = new Map<string, string>();
  for (const [nodeId, view] of topicNodes) {
    if (view.nextId !== null) preNextBySource.set(nodeId, view.nextId);
  }
  for (const [nodeId, relation] of finalRelations) {
    if (relation.flow !== "next" || relation.from === null || relation.opIndex === null) continue;
    const sourceId = relation.from;
    const preNextId = preNextBySource.get(sourceId);
    if (preNextId === undefined || preNextId === nodeId) continue;
    const preNextRelation = finalRelations.get(preNextId);
    const stillOccupies =
      preNextRelation !== undefined &&
      preNextRelation.from === sourceId &&
      preNextRelation.flow === "next";
    if (!stillOccupies) continue;
    const ops = [
      relation.opIndex,
      ...(preNextRelation.opIndex !== null ? [preNextRelation.opIndex] : []),
    ];
    throw batchConflict(
      "来源 " +
        sourceId +
        " 的 next 槽位仍被原后继 " +
        preNextId +
        " 占用；只有在本批显式声明原后继的最终位置才能腾出（不自动挤掉）",
      {
        ops: [...new Set(ops)],
        sourceId,
        nextId: preNextId,
        nodeId,
        conflict: "next-occupied",
      },
    );
  }

  const nextChildren = new Map<string, string[]>();
  for (const [nodeId, relation] of finalRelations) {
    if (relation.flow !== "next" || relation.from === null) continue;
    const bucket = nextChildren.get(relation.from);
    if (bucket === undefined) nextChildren.set(relation.from, [nodeId]);
    else bucket.push(nodeId);
  }
  for (const [sourceId, children] of nextChildren) {
    if (children.length <= 1) continue;
    const ops = children
      .map((nodeId) => finalRelations.get(nodeId)?.opIndex)
      .filter((value): value is number => value !== null && value !== undefined);
    throw batchStructure(
      "来源 " +
        sourceId +
        " 最多只能有一个 next 后继；本批最终关系会让 " +
        children.join("、") +
        " 同时成为它的 next（最终图结构不合法，请改接其中一条）",
      {
        ops: [...new Set(ops)],
        sourceId,
        nodeIds: children,
        conflict: "next-multiple",
      },
    );
  }

  const walkState = new Map<string, "done">();
  for (const start of finalRelations.keys()) {
    if (walkState.has(start)) continue;
    const path: string[] = [];
    let current: string | null = start;
    while (current !== null) {
      if (walkState.has(current)) break;
      const indexInPath = path.indexOf(current);
      if (indexInPath !== -1) {
        const cycle = path.slice(indexInPath);
        const ops = cycle
          .map((nodeId) => finalRelations.get(nodeId)?.opIndex)
          .filter((value): value is number => value !== null && value !== undefined);
        throw batchStructure(
          "本批最终连接形成环：" + cycle.concat(cycle[0] as string).join(" → "),
          {
            ops: [...new Set(ops)],
            nodeIds: cycle,
            conflict: "cycle",
          },
        );
      }
      path.push(current);
      const relation = finalRelations.get(current);
      current = relation?.from ?? null;
    }
    for (const nodeId of path) walkState.set(nodeId, "done");
  }

  // 第四步：生成操作序列。中间腾空只在内存候选里存在，最终写盘内容由最后的关系决定。
  const operations: Operation[] = [];

  for (const [nodeId, relation] of finalRelations) {
    const pre = topicNodes.get(nodeId);
    if (pre === undefined || pre.flow !== "next") continue;
    // 当前 next 只要最终不再是"同一来源的 next"就先腾空；即使最终是同源 branch
    // 也先腾一次，保证本批 create 抢占该 next 槽位时不会撞上旧后继。
    const sameSourceNext = relation.from === pre.from && relation.flow === "next";
    if (sameSourceNext) continue;
    const description =
      pre.description !== undefined && pre.description.trim().length > 0
        ? pre.description
        : "本批临时腾空，最终关系随后落位";
    operations.push({ op: "updateConnection", nodeId, flow: "branch", description });
  }

  for (const spec of orderedCreates) {
    const relation = spec.final;
    operations.push({
      op: "createNode",
      nodeId: spec.nodeId,
      topicId: topic.topicId,
      title: spec.op.title.trim(),
      body: spec.op.body,
      from: relation.from,
      flow: relation.flow === "branch" ? "branch" : "next",
      state: spec.op.state ?? "proposed",
      description: relation.description ?? "",
      ...(spec.op.summary !== undefined ? { summary: spec.op.summary } : {}),
      ...(relation.side !== undefined ? { side: relation.side } : {}),
      ...(relation.order !== undefined ? { order: relation.order } : {}),
      ...(spec.op.important === true ? { important: true } : {}),
    });
  }

  for (const connect of connects) {
    const pre = connect.existing.view;
    const relation = finalRelations.get(pre.id) as BatchFinalRelation;
    if (relation.from === null) continue;
    const unchanged =
      relation.from === pre.from &&
      relation.flow === pre.flow &&
      (relation.description ?? "") === (pre.description ?? "") &&
      relation.side === pre.side &&
      relation.order === pre.order;
    if (unchanged) continue;
    operations.push({
      op: "updateConnection",
      nodeId: pre.id,
      from: relation.from,
      flow: relation.flow,
      ...(relation.flow === "branch" && relation.side !== undefined
        ? { side: relation.side }
        : {}),
      ...(relation.flow === "branch" && relation.order !== undefined
        ? { order: relation.order }
        : {}),
      description: relation.description,
    });
  }

  for (const edit of edits) {
    const patch = edit.op.patch;
    operations.push({
      op: "patchNode",
      nodeId: edit.existing.binding.nodeId,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.replace !== undefined ? { replace: patch.replace } : {}),
      ...(patch.append !== undefined ? { append: patch.append } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
    });
  }

  for (const important of importants) {
    operations.push({
      op: "setImportance",
      nodeId: important.existing.binding.nodeId,
      important: important.op.important,
    });
  }

  const aliases: Record<string, string> = {};
  const nodeIds: string[] = [];
  const paths: string[] = [];
  for (const spec of creates) {
    aliases[spec.local] = spec.nodeId;
    nodeIds.push(spec.nodeId);
    paths.push(spec.path);
  }

  return {
    operations,
    expectedFiles: expected,
    created: { topicId: null, topicPath: null, nodeIds, paths, aliases },
    action: action.action,
    topicId: topic.topicId,
  };
}

/**
 * insert：先验证 after 与 before 是当前真实的相邻 next（after.nextId === before.id、
 * 同主题），否则整体 409，不降级；然后复用同一 batch 编译核心。
 */
function compileInsert(context: CompileContext, action: AgentInsertAction): CompiledAction {
  const snapshot = context.runtime.current.data;
  const afterBinding = context.editRefs.resolve(action.afterRef);
  const beforeBinding = context.editRefs.resolve(action.beforeRef);
  if (afterBinding === null || beforeBinding === null) {
    throw batchVersion("insert 的 afterRef／beforeRef 无效或已过期；请重新读取相邻节点", {
      field: afterBinding === null ? "afterRef" : "beforeRef",
      ref: (afterBinding === null ? action.afterRef : action.beforeRef).slice(0, 24),
    });
  }
  const afterView = snapshot.graph.nodes.find((entry) => entry.id === afterBinding.nodeId);
  const beforeView = snapshot.graph.nodes.find((entry) => entry.id === beforeBinding.nodeId);
  if (afterView === undefined || beforeView === undefined) {
    throw batchVersion("insert 的 afterRef／beforeRef 指向的节点不在当前快照中", {
      afterId: afterBinding.nodeId,
      beforeId: beforeBinding.nodeId,
    });
  }
  if (afterView.topicId !== beforeView.topicId) {
    throw batchStructure("insert 的 after 与 before 不属于同一主题", {
      topicId: afterView.topicId,
      beforeTopicId: beforeView.topicId,
      conflict: "cross-topic",
    });
  }
  if (afterView.nextId !== beforeView.id) {
    throw batchConflict(
      "insert 只接受当前真实相邻的 next：after(" +
        afterView.id +
        ") 的 next 是 " +
        String(afterView.nextId) +
        "，不是 before(" +
        beforeView.id +
        ")；不自动插入或改接其他节点",
      {
        afterId: afterView.id,
        beforeId: beforeView.id,
        actualNextId: afterView.nextId,
        conflict: "insert-not-adjacent",
      },
    );
  }

  const inserted = compileBatch(context, {
    action: "batch",
    topicId: afterView.topicId,
    ops: [
      {
        op: "create",
        as: "inserted",
        from: { ref: action.afterRef },
        flow: "next",
        title: action.title,
        body: action.body,
        description: action.description,
        ...(action.summary !== undefined ? { summary: action.summary } : {}),
        ...(action.state !== undefined ? { state: action.state } : {}),
      },
      {
        op: "connect",
        target: { ref: action.beforeRef },
        from: { local: "inserted" },
        flow: "next",
        description: action.nextDescription,
      },
    ],
  });
  return {
    ...inserted,
    action: action.action,
    created: { ...inserted.created, aliases: {} },
  };
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
