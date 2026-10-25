import { workspaceMetaSchema } from "./schema.js";
import type { WorkspaceMeta } from "./schema.js";
import { makeDiagnostic } from "./diagnostics.js";
import type { Diagnostic, DiagnosticContext } from "./diagnostics.js";
import type { ParsedNode, ParsedTopic } from "./model.js";

export interface WorkspaceTopicView {
  readonly topicId: string;
  readonly title: string;
  readonly path: string;
  /** 主题内按正文出现顺序排列的节点 ID。 */
  readonly nodeIds: readonly string[];
}

/** 布局与检索用的轻量视图：不含正文和源码范围，正文按需读取。 */
export interface WorkspaceNodeSummary {
  readonly id: string;
  readonly topicId: string;
  readonly topicPath: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly state: ParsedNode["state"];
  readonly flow: ParsedNode["flow"];
  readonly from: string | null;
  readonly side?: ParsedNode["side"] | undefined;
  readonly order?: number | undefined;
  readonly important: boolean;
  readonly number: string;
  readonly nextId: string | null;
  readonly branchIds: readonly string[];
}

/** 带正文与源码范围的完整节点，供阅读、更新使用。 */
export interface WorkspaceNodeView extends ParsedNode {
  readonly number: string;
  readonly nextId: string | null;
  readonly branchIds: readonly string[];
  /**
   * 仅当源记录显式声明了 side 时才存在；缺失表示来源未指定方向，
   * core 不补默认值，由阅读端自行择侧。
   */
  readonly side?: ParsedNode["side"] | undefined;
}

export interface WorkspaceGraph {
  readonly workspaceId: string;
  readonly name: string;
  readonly activeNode: string | null;
  /** 各主题的 root ID，按 ID 排序；空工作区为空数组。 */
  readonly rootIds: readonly string[];
  readonly topics: readonly WorkspaceTopicView[];
  /** 按主题与派生编号稳定排序；含正文，调用方可用 toNodeSummary 转成轻量视图。 */
  readonly nodes: readonly WorkspaceNodeView[];
}

export interface ValidateWorkspaceInput {
  readonly workspace: WorkspaceMeta;
  readonly topics: readonly ParsedTopic[];
}

export interface ValidateWorkspaceResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly graph?: WorkspaceGraph | undefined;
}

interface IndexedNode {
  readonly node: ParsedNode;
}

function byNumberSegments(left: string, right: string): number {
  const leftParts = left.split("-").map(Number);
  const rightParts = right.split("-").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? -1;
    const b = rightParts[index] ?? -1;
    if (a !== b) return a - b;
  }
  return 0;
}

/** 节点诊断统一带 topicPath／topicId／nodeId；sourcePath 由调用方按需补充。 */
function nodeContext(node: ParsedNode): DiagnosticContext {
  return { topicPath: node.topicPath, topicId: node.topicId, nodeId: node.id };
}

/** 节点范围即整个节点文件，可直接定位回源文件。 */
function locate(node: ParsedNode): { start: number; end: number } {
  return node.ranges.node;
}

function padding(value: number): string {
  return value < 10 ? "0" + value : String(value);
}

/** 新增 branch 的默认 order：当前最大值加 10；没有分支时从 10 开始。 */
export function nextBranchOrder(orders: readonly number[]): number {
  if (orders.length === 0) return 10;
  return Math.max(...orders) + 10;
}

export function getNodeById(graph: WorkspaceGraph, nodeId: string): WorkspaceNodeView | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

/** 去掉正文与源码范围，供图／检索等不需要完整正文的调用方使用。 */
export function toNodeSummary(node: WorkspaceNodeView): WorkspaceNodeSummary {
  return {
    id: node.id,
    topicId: node.topicId,
    topicPath: node.topicPath,
    sourcePath: node.sourcePath,
    title: node.title,
    summary: node.summary,
    ...(node.description !== undefined ? { description: node.description } : {}),
    state: node.state,
    flow: node.flow,
    from: node.from,
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    important: node.important,
    number: node.number,
    nextId: node.nextId,
    branchIds: node.branchIds,
  };
}

/**
 * 校验整个工作区并派生编号。core 只处理内存数据，不读文件、不写文件。
 * 固定 isolated：每个非空主题恰好一个 root，禁止跨主题连接。
 * 失败时不返回 graph，避免调用方把部分结构误当成有效图。
 */
export function validateWorkspace(input: ValidateWorkspaceInput): ValidateWorkspaceResult {
  const diagnostics: Diagnostic[] = [];
  const workspaceParsed = workspaceMetaSchema.safeParse(input.workspace);
  if (!workspaceParsed.success) {
    for (const issue of workspaceParsed.error.issues) {
      diagnostics.push(
        makeDiagnostic("WORKSPACE_SCHEMA_INVALID", "workspace.json: " + issue.message + " (" + issue.path.join(".") + ")"),
      );
    }
    return { ok: false, diagnostics };
  }
  const workspace = workspaceParsed.data;

  const nodesById = new Map<string, IndexedNode>();
  const topicIds = new Set<string>();
  const topicViews: WorkspaceTopicView[] = [];

  for (const topic of input.topics) {
    if (topicIds.has(topic.topicId)) {
      diagnostics.push(
        makeDiagnostic("TOPIC_ID_DUPLICATED", "工作区内重复的主题 ID " + topic.topicId, {
          topicPath: topic.document.path,
          topicId: topic.topicId,
        }),
      );
    }
    topicIds.add(topic.topicId);
    topicViews.push({
      topicId: topic.topicId,
      title: topic.title,
      path: topic.document.path,
      nodeIds: topic.nodes.map((node) => node.id),
    });

    for (const node of topic.nodes) {
      const previous = nodesById.get(node.id);
      if (previous) {
        diagnostics.push(
          makeDiagnostic(
            "NODE_ID_DUPLICATED",
            "工作区内重复的节点 ID " + node.id + "（另见 " + previous.node.topicPath + "）",
            nodeContext(node),
            locate(node),
          ),
        );
        continue;
      }
      nodesById.set(node.id, { node });
    }
  }

  const allNodes = [...nodesById.values()].map((entry) => entry.node);
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));

  const diagnose = (node: ParsedNode, code: Diagnostic["code"], message: string): void => {
    diagnostics.push(makeDiagnostic(code, message, nodeContext(node), locate(node)));
  };

  const roots: ParsedNode[] = [];
  const childrenOf = new Map<string, ParsedNode[]>();

  for (const node of allNodes) {
    if (node.flow === "root") {
      roots.push(node);
      if (node.from !== null) {
        diagnose(node, "NODE_ROOT_INVALID", "root 节点的 from 必须为空");
      }
      if (node.side !== undefined || node.order !== undefined) {
        diagnose(node, "NODE_FLOW_FIELD_INVALID", "root 节点不使用 side／order");
      }
    } else {
      if (node.from === null) {
        diagnose(node, "NODE_FROM_MISSING", node.flow + " 节点必须声明 from");
      }
    }

    if (node.flow === "next" && (node.side !== undefined || node.order !== undefined)) {
      diagnose(node, "NODE_FLOW_FIELD_INVALID", "next 节点不使用 side／order");
    }
    if (node.from !== null) {
      if (node.from === node.id) {
        diagnose(node, "NODE_SELF_LINK", "节点不能以自身作为 from");
        continue;
      }
      if (!nodeById.has(node.from)) {
        diagnose(node, "NODE_FROM_UNKNOWN", "from 指向不存在的节点 " + node.from);
        continue;
      }
      if (nodeById.get(node.from)?.topicId !== node.topicId) {
        diagnose(node, "NODE_CROSS_TOPIC", "隔离主题不能连接其他主题的节点 " + node.from);
        continue;
      }
      const siblings = childrenOf.get(node.from);
      if (siblings) siblings.push(node);
      else childrenOf.set(node.from, [node]);
    }
  }

  for (const topic of input.topics) {
    const topicRoots = roots.filter((node) => node.topicId === topic.topicId);
    if (topic.nodes.length > 0 && topicRoots.length === 0) {
      diagnostics.push(makeDiagnostic("NODE_ROOT_MISSING", "非空主题必须恰好有一个 root", {
        topicId: topic.topicId, topicPath: topic.document.path,
      }));
    } else if (topicRoots.length > 1) {
      for (const root of topicRoots) diagnose(root, "NODE_ROOT_MULTIPLE", "每个主题只能有一个 root");
    }
  }

  for (const [sourceId, children] of childrenOf) {
    const nextChildren = children.filter((child) => child.flow === "next");
    if (nextChildren.length > 1) {
      for (const child of nextChildren) {
        diagnose(child, "NODE_NEXT_MULTIPLE", "来源 " + sourceId + " 最多只能有一个 next 后继");
      }
    }
    const branches = children.filter((child) => child.flow === "branch");
    const orders = new Map<number, ParsedNode[]>();
    for (const branch of branches) {
      if (branch.order === undefined) continue;
      const bucket = orders.get(branch.order);
      if (bucket) bucket.push(branch);
      else orders.set(branch.order, [branch]);
    }
    for (const [order, duplicates] of orders) {
      if (duplicates.length < 2) continue;
      for (const duplicate of duplicates) {
        diagnose(
          duplicate,
          "NODE_BRANCH_ORDER_DUPLICATED",
          "来源 " + sourceId + " 的 branch order 重复：" + order,
        );
      }
    }
  }

  const cycleVisited = new Set<string>();
  const cycleReported = new Set<string>();
  for (const node of allNodes) {
    if (cycleVisited.has(node.id)) continue;
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: ParsedNode | undefined = node;
    while (current) {
      if (pathIndex.has(current.id)) {
        const start = pathIndex.get(current.id) ?? 0;
        const cycleIds = path.slice(start);
        for (const id of cycleIds) {
          if (cycleReported.has(id)) continue;
          cycleReported.add(id);
          const member = nodeById.get(id);
          if (member) diagnose(member, "GRAPH_CYCLE", "连接形成环：" + cycleIds.join(" → "));
        }
        break;
      }
      if (cycleVisited.has(current.id)) break;
      pathIndex.set(current.id, path.length);
      path.push(current.id);
      current = current.from === null ? undefined : nodeById.get(current.from);
    }
    for (const id of path) cycleVisited.add(id);
  }

  const reachable = new Set<string>();
  const queue: ParsedNode[] = [...roots];
  while (queue.length > 0) {
    const current = queue.shift() as ParsedNode;
    if (reachable.has(current.id)) continue;
    reachable.add(current.id);
    for (const child of childrenOf.get(current.id) ?? []) queue.push(child);
  }
  for (const node of allNodes) {
    if (!reachable.has(node.id)) {
      diagnose(node, "NODE_UNREACHABLE", "节点不能从所在主题的 root 到达");
    }
  }

  if (workspace.activeNode !== null && !nodeById.has(workspace.activeNode)) {
    diagnostics.push(
      makeDiagnostic(
        "FOCUS_NODE_UNKNOWN",
        "activeNode 指向不存在的节点 " + workspace.activeNode,
      ),
    );
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const numbers = new Map<string, string>();
  let numberCollision: string | undefined;
  const assign = (nodeId: string, number: string): void => {
    if (numbers.has(nodeId)) {
      numberCollision = nodeId + " → " + number;
      return;
    }
    numbers.set(nodeId, number);
  };

  /**
   * branch 按显式 order 升序；未写 order 的排在显式值之后，并按稳定 node.id 升序。
   * 不依赖 topics 入参顺序或正文出现顺序，因此同结构重排输入仍得到同一编号。
   * order 缺失只影响派生结果，不改写源文件。
   */
  const branchEntriesOf = (nodeId: string): ParsedNode[] =>
    (childrenOf.get(nodeId) ?? [])
      .filter((child) => child.flow === "branch")
      .sort((left, right) => {
        if (left.order !== undefined && right.order !== undefined) {
          const orderDiff = left.order - right.order;
          if (orderDiff !== 0) return orderDiff;
        } else if (left.order !== undefined) {
          return -1;
        } else if (right.order !== undefined) {
          return 1;
        }
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });

  const nextChildOf = (nodeId: string): ParsedNode | undefined =>
    (childrenOf.get(nodeId) ?? []).find((child) => child.flow === "next");

  /** 一条纵向链：先给本节点编号，再展开它的侧枝，最后继续 next。 */
  const assignChain = (startId: string, prefix: string | null, startCounter: number): number => {
    let counter = startCounter;
    let currentId: string | undefined = startId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const nodeNumber = prefix === null ? padding(counter) : prefix + "-" + padding(counter);
      assign(currentId, nodeNumber);
      counter += 1;
      let branchCounter = 1;
      for (const entry of branchEntriesOf(currentId)) {
        branchCounter = assignChain(entry.id, nodeNumber, branchCounter);
      }
      currentId = nextChildOf(currentId)?.id;
    }
    return counter;
  };

  // 隔离主题各自从 01 起编号；root 顺序不影响编号结果。
  for (const root of roots) assignChain(root.id, null, 1);

  if (numberCollision || numbers.size !== allNodes.length) {
    return {
      ok: false,
      diagnostics: [
        makeDiagnostic(
          "GRAPH_STRUCTURE_INCOMPLETE",
          "编号失败：结构未能覆盖全部节点" + (numberCollision ? "（" + numberCollision + "）" : ""),
        ),
      ],
    };
  }

  const views: WorkspaceNodeView[] = allNodes
    .map((node) => {
      const number = numbers.get(node.id);
      if (number === undefined) throw new Error("缺少编号：" + node.id);
      const branches = branchEntriesOf(node.id).map((branch) => branch.id);
      return {
        ...node,
        // 只在来源显式声明 side 时透传；缺省不补值，交由阅读端择侧。
        ...(node.flow === "branch" && node.side !== undefined ? { side: node.side } : {}),
        number,
        nextId: nextChildOf(node.id)?.id ?? null,
        branchIds: branches,
      };
    })
    .sort(
      (left, right) =>
        (left.topicId < right.topicId ? -1 : left.topicId > right.topicId ? 1 : 0) ||
        byNumberSegments(left.number, right.number),
    );

  const graph: WorkspaceGraph = {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    activeNode: workspace.activeNode,
    rootIds: roots.map((node) => node.id).sort(),
    topics: topicViews,
    nodes: views,
  };
  return { ok: true, diagnostics: [], graph };
}
