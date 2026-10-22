import {
  DEFAULT_CARD_HEIGHT,
  DEFAULT_CARD_WIDTH,
  DEFAULT_HORIZONTAL_GAP,
  DEFAULT_VERTICAL_GAP,
  LAYOUT_VERSION,
  MAX_LAYOUT_DIAGNOSTICS,
  type LayoutDiagnostic,
  type LayoutDiagnosticCode,
  type LayoutEdgeRoute,
  type LayoutFlow,
  type LayoutInput,
  type LayoutPoint,
  type LayoutPosition,
  type LayoutRect,
  type LayoutResult,
  type LayoutSide,
} from './types.js';

export * from './types.js';

/**
 * 确定性纯布局。
 *
 * 结构解释：
 * - 每个节点最多一个 next 后继；next 共享当前局部纵轴。
 * - branch 入口放在来源的指定侧，并建立自己的局部纵轴。
 * - 同一来源的 branch 按 order 升序（同 order/缺失按输入顺序）展开。
 * - 卡片矩形不重叠；next 与 branch 折线路由都走卡片之间的通道。
 *
 * previousPositions 只把主根平移到上次坐标；其余几何由当前结构决定。
 * 同输入同输出，不读取正文、标题或编号。
 */
export function computeLayout(input: LayoutInput): LayoutResult {
  const diagnostics = createDiagnosticSink();
  const raw: unknown = input;
  if (!isRecord(raw)) {
    diagnostics.add('invalid-input', '布局输入必须是对象');
    return emptyResult(null, defaultConfig(), diagnostics.finish());
  }

  const config = readConfig(raw, diagnostics);
  const structureVersion = readStructureVersion(raw);
  const nodes = normalizeNodes(raw.nodes, diagnostics);
  if (nodes.length === 0) {
    return emptyResult(structureVersion, config, diagnostics.finish());
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  resolveParentReferences(nodes, byId, diagnostics);
  breakCycles(nodes, byId, diagnostics);
  detachConflictingSiblings(nodes, diagnostics);
  reportRootShape(nodes, diagnostics);

  const fullChildren = buildChildMap(nodes);
  const visibility = computeVisibility(nodes, byId, fullChildren, raw, diagnostics);
  const tree = buildVisibleTree(nodes, visibility.visible, byId, diagnostics);

  const measureContext: MeasureContext = {
    nextByParent: tree.nextByParent,
    branchesByParent: tree.branchesByParent,
    config,
    diagnostics,
    memo: new Map(),
    visiting: new Set(),
  };

  const forest = tree.roots.map((root) => ({ root, block: measureBlock(root, measureContext) }));
  const placed = new Map<string, LayoutPosition>();
  let forestCursor = 0;
  for (const entry of forest) {
    for (const node of entry.block.nodes) {
      placed.set(node.node.id, { x: forestCursor + node.x, y: node.y });
    }
    forestCursor += entry.block.width + config.horizontalGap;
  }

  // Safety net: a visible node must always receive a coordinate. Valid inputs
  // never reach this branch; a malformed cycle/filter combination may.
  for (const node of nodes) {
    if (!visibility.visible.has(node.id) || placed.has(node.id)) continue;
    placed.set(node.id, { x: forestCursor, y: 0 });
    forestCursor += config.cardWidth + config.horizontalGap;
    diagnostics.add('unreachable-node', '节点未接入可见树，已单独放置在右侧', node.id);
  }

  const primaryRoot = tree.roots.find((root) => root.flow === 'root') ?? tree.roots[0];
  applyPreviousAnchor(raw.previousPositions, primaryRoot, placed);

  // 输出按稳定 ID 排序，使输入数组顺序不同的等价结构也得到相同序列化结果。
  const positions: Record<string, LayoutPosition> = {};
  const visibleSorted = nodes
    .filter((node) => visibility.visible.has(node.id))
    .map((node) => node.id)
    .sort(compareIds);
  for (const id of visibleSorted) {
    const position = placed.get(id);
    if (position !== undefined) positions[id] = { x: position.x, y: position.y };
  }

  const edgeRoutes = buildEdgeRoutes(nodes, visibility.visible, tree.parentOf, placed, config, diagnostics).sort(
    (a, b) => compareIds(a.id, b.id),
  );
  reportRoutePenetrations(edgeRoutes, nodes, visibility.visible, positions, config, diagnostics);
  const bounds = computeBounds(nodes, visibility.visible, positions, config);

  return {
    positions,
    edgeRoutes,
    hiddenCounts: visibility.hiddenCounts,
    diagnostics: diagnostics.finish(),
    bounds,
    cardWidth: config.cardWidth,
    cardHeight: config.cardHeight,
    layoutVersion: LAYOUT_VERSION,
    structureVersion,
  };
}

interface LayoutConfig {
  cardWidth: number;
  cardHeight: number;
  verticalGap: number;
  horizontalGap: number;
}

interface WorkingNode {
  id: string;
  inputIndex: number;
  flow: LayoutFlow;
  parentId: string | null;
  side: LayoutSide;
  order: number | null;
  label: string | null;
  topicId: string | null;
}

interface BlockNode {
  node: WorkingNode;
  x: number;
  y: number;
}

interface Block {
  width: number;
  height: number;
  nodes: BlockNode[];
}

interface VisibleTree {
  roots: WorkingNode[];
  nextByParent: Map<string, WorkingNode>;
  branchesByParent: Map<string, WorkingNode[]>;
  /** child id -> visible parent id, for edge routes only. */
  parentOf: Map<string, string>;
}

interface Visibility {
  visible: Set<string>;
  hiddenCounts: Record<string, number>;
}

interface DiagnosticSink {
  add: (code: LayoutDiagnosticCode, message: string, nodeId?: string) => void;
  finish: () => LayoutDiagnostic[];
}

interface MeasureContext {
  nextByParent: Map<string, WorkingNode>;
  branchesByParent: Map<string, WorkingNode[]>;
  config: LayoutConfig;
  diagnostics: DiagnosticSink;
  memo: Map<string, Block>;
  visiting: Set<string>;
}

function defaultConfig(): LayoutConfig {
  return {
    cardWidth: DEFAULT_CARD_WIDTH,
    cardHeight: DEFAULT_CARD_HEIGHT,
    verticalGap: DEFAULT_VERTICAL_GAP,
    horizontalGap: DEFAULT_HORIZONTAL_GAP,
  };
}

function readConfig(raw: Record<string, unknown>, diagnostics: DiagnosticSink): LayoutConfig {
  return {
    cardWidth: readOption(raw.cardWidth, DEFAULT_CARD_WIDTH, (value) => value > 0, 'cardWidth', diagnostics),
    cardHeight: readOption(raw.cardHeight, DEFAULT_CARD_HEIGHT, (value) => value > 0, 'cardHeight', diagnostics),
    verticalGap: readOption(raw.verticalGap, DEFAULT_VERTICAL_GAP, (value) => value >= 0, 'verticalGap', diagnostics),
    horizontalGap: readOption(raw.horizontalGap, DEFAULT_HORIZONTAL_GAP, (value) => value >= 0, 'horizontalGap', diagnostics),
  };
}

function readOption(
  value: unknown,
  fallback: number,
  valid: (value: number) => boolean,
  name: string,
  diagnostics: DiagnosticSink,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && valid(value)) return value;
  diagnostics.add('invalid-option', '布局参数 ' + name + ' 无效，已使用默认值');
  return fallback;
}

function readStructureVersion(raw: Record<string, unknown>): number | string | null {
  const value = raw.structureVersion;
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function normalizeNodes(rawNodes: unknown, diagnostics: DiagnosticSink): WorkingNode[] {
  if (!Array.isArray(rawNodes)) {
    diagnostics.add('invalid-input', 'nodes 必须是数组');
    return [];
  }

  const seen = new Set<string>();
  const result: WorkingNode[] = [];

  for (let index = 0; index < rawNodes.length; index += 1) {
    const raw = rawNodes[index] as unknown;
    if (!isRecord(raw)) {
      diagnostics.add('invalid-node', '第 ' + String(index + 1) + ' 个节点不是对象');
      continue;
    }
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (id.length === 0 || id.trim().length === 0) {
      diagnostics.add('invalid-node', '第 ' + String(index + 1) + ' 个节点缺少有效 id');
      continue;
    }
    if (seen.has(id)) {
      diagnostics.add('duplicate-node-id', '节点 id 重复，保留第一次出现', id);
      continue;
    }
    seen.add(id);

    const parentCandidate = typeof raw.from === 'string' && raw.from.length > 0 ? raw.from : null;
    let flow: LayoutFlow;
    if (raw.flow === 'root' || raw.flow === 'next' || raw.flow === 'branch') {
      flow = raw.flow;
    } else {
      diagnostics.add('invalid-flow', '未知的 flow，按 from 是否存在推断', id);
      flow = parentCandidate === null ? 'root' : 'next';
    }

    let parentId: string | null = null;
    if (flow === 'root') {
      if (parentCandidate !== null) {
        diagnostics.add('invalid-node', 'root 不应设置 from，已忽略 from', id);
      }
    } else if (parentCandidate === null) {
      diagnostics.add('invalid-node', '非根节点缺少 from，按独立顶层绘制', id);
    } else {
      parentId = parentCandidate;
    }

    let side: LayoutSide = 'right';
    if (flow === 'branch') {
      if (raw.side === 'left') side = 'left';
      else if (raw.side === undefined || raw.side === null || raw.side === 'right') side = 'right';
      else diagnostics.add('invalid-node', 'branch.side 无效，按 right 处理', id);
    }

    let order: number | null = null;
    if (flow === 'branch') {
      if (typeof raw.order === 'number' && Number.isFinite(raw.order)) order = raw.order;
      else if (raw.order !== undefined && raw.order !== null) {
        diagnostics.add('invalid-node', 'branch.order 必须是有限数字，按缺失处理', id);
      }
    }

    result.push({
      id,
      inputIndex: index,
      flow,
      parentId,
      side,
      order,
      label: typeof raw.label === 'string' ? raw.label : null,
      topicId: typeof raw.topicId === 'string' ? raw.topicId : null,
    });
  }

  return result;
}

function resolveParentReferences(
  nodes: WorkingNode[],
  byId: Map<string, WorkingNode>,
  diagnostics: DiagnosticSink,
): void {
  for (const node of nodes) {
    if (node.parentId === null) continue;
    if (node.parentId === node.id) {
      node.parentId = null;
      diagnostics.add('self-parent', '节点不能以自身为父节点，按顶层绘制', node.id);
      continue;
    }
    if (!byId.has(node.parentId)) {
      diagnostics.add('unknown-parent', '父节点不存在，按顶层绘制', node.id);
      node.parentId = null;
    }
  }
}

function breakCycles(
  nodes: WorkingNode[],
  byId: Map<string, WorkingNode>,
  diagnostics: DiagnosticSink,
): void {
  for (const start of nodes) {
    if (start.parentId === null) continue;
    const path: WorkingNode[] = [];
    const onPath = new Map<string, number>();
    let current: WorkingNode | undefined = start;

    while (current !== undefined && current.parentId !== null) {
      const at = onPath.get(current.id);
      if (at !== undefined) {
        const cycle = path.slice(at);
        let breakNode = cycle[0];
        for (const candidate of cycle) {
          if (breakNode === undefined || candidate.inputIndex < breakNode.inputIndex) breakNode = candidate;
        }
        if (breakNode !== undefined) {
          breakNode.parentId = null;
          diagnostics.add('cycle', '父子关系存在环，已断开环中最早出现的节点', breakNode.id);
        }
        break;
      }
      onPath.set(current.id, path.length);
      path.push(current);
      const parentId: string | null = current.parentId;
      current = parentId === null ? undefined : byId.get(parentId);
    }
  }
}

function detachConflictingSiblings(nodes: WorkingNode[], diagnostics: DiagnosticSink): void {
  const byParent = new Map<string, WorkingNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = byParent.get(node.parentId);
    if (list === undefined) byParent.set(node.parentId, [node]);
    else list.push(node);
  }

  for (const children of byParent.values()) {
    const nextChildren = children.filter((child) => child.flow === 'next');
    for (let index = 1; index < nextChildren.length; index += 1) {
      const extra = nextChildren[index];
      if (extra === undefined) continue;
      extra.parentId = null;
      diagnostics.add('multiple-next', '同一来源有多个 next，保留第一个，其余按顶层绘制', extra.id);
    }

    const branchOrders = new Map<number, string>();
    for (const child of children) {
      if (child.flow !== 'branch' || child.order === null) continue;
      const previous = branchOrders.get(child.order);
      if (previous !== undefined) {
        diagnostics.add(
          'duplicate-branch-order',
          '同一来源的 branch.order 重复（与 ' + previous + ' 冲突），按输入顺序稳定排序',
          child.id,
        );
      } else {
        branchOrders.set(child.order, child.id);
      }
    }
  }
}

function reportRootShape(nodes: WorkingNode[], diagnostics: DiagnosticSink): void {
  let declaredRoots = 0;
  for (const node of nodes) if (node.flow === 'root') declaredRoots += 1;
  if (declaredRoots === 0) diagnostics.add('missing-root', '结构中没有 root，按独立顶层绘制');
  else if (declaredRoots > 1) diagnostics.add('multiple-roots', '结构中有多个 root，按并列顶层绘制');
}

function buildChildMap(nodes: WorkingNode[]): Map<string, WorkingNode[]> {
  const map = new Map<string, WorkingNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = map.get(node.parentId);
    if (list === undefined) map.set(node.parentId, [node]);
    else list.push(node);
  }
  return map;
}

function computeVisibility(
  nodes: WorkingNode[],
  byId: Map<string, WorkingNode>,
  children: Map<string, WorkingNode[]>,
  raw: Record<string, unknown>,
  diagnostics: DiagnosticSink,
): Visibility {
  const preCollapse = new Set<string>();
  const visibleOption = raw.visibleNodeIds;
  if (visibleOption === undefined || visibleOption === null) {
    for (const node of nodes) preCollapse.add(node.id);
  } else if (!Array.isArray(visibleOption)) {
    diagnostics.add('invalid-option', 'visibleNodeIds 必须是数组；已按全部可见处理');
    for (const node of nodes) preCollapse.add(node.id);
  } else {
    for (const value of visibleOption) {
      if (typeof value !== 'string') {
        diagnostics.add('invalid-input', 'visibleNodeIds 只能包含字符串');
        continue;
      }
      if (!byId.has(value)) {
        diagnostics.add('invalid-node', 'visibleNodeIds 包含未知节点', value);
        continue;
      }
      preCollapse.add(value);
    }
  }

  const collapsed = new Set<string>();
  const collapsedOption = raw.collapsedNodeIds;
  if (collapsedOption !== undefined && collapsedOption !== null) {
    if (!Array.isArray(collapsedOption)) {
      diagnostics.add('invalid-option', 'collapsedNodeIds 必须是数组；已按不折叠处理');
    } else {
      for (const value of collapsedOption) {
        if (typeof value !== 'string') {
          diagnostics.add('invalid-input', 'collapsedNodeIds 只能包含字符串');
          continue;
        }
        if (!byId.has(value)) {
          diagnostics.add('collapsed-node-missing', '折叠节点不在结构中，已忽略', value);
          continue;
        }
        if (preCollapse.has(value)) collapsed.add(value);
      }
    }
  }

  const hidden = new Set<string>();
  const descendantsByCollapse = new Map<string, WorkingNode[]>();
  for (const node of nodes) {
    if (!collapsed.has(node.id)) continue;
    const descendants = collectDescendants(node.id, children);
    descendantsByCollapse.set(node.id, descendants);
    for (const descendant of descendants) hidden.add(descendant.id);
  }

  const visible = new Set<string>();
  for (const id of preCollapse) if (!hidden.has(id)) visible.add(id);

  const hiddenCounts: Record<string, number> = {};
  const collapsedIds = [...collapsed].sort(compareIds);
  for (const id of collapsedIds) {
    if (!visible.has(id)) continue;
    const descendants = descendantsByCollapse.get(id) ?? [];
    let count = 0;
    for (const descendant of descendants) if (preCollapse.has(descendant.id)) count += 1;
    if (count > 0) hiddenCounts[id] = count;
  }

  return { visible, hiddenCounts };
}

function collectDescendants(rootId: string, children: Map<string, WorkingNode[]>): WorkingNode[] {
  const result: WorkingNode[] = [];
  const seen = new Set<string>([rootId]);
  const stack: WorkingNode[] = [...(children.get(rootId) ?? [])].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || seen.has(node.id)) continue;
    seen.add(node.id);
    result.push(node);
    const nested = children.get(node.id);
    if (nested !== undefined) {
      for (let index = nested.length - 1; index >= 0; index -= 1) {
        const child = nested[index];
        if (child !== undefined) stack.push(child);
      }
    }
  }
  result.sort((a, b) => a.inputIndex - b.inputIndex);
  return result;
}

function buildVisibleTree(
  nodes: WorkingNode[],
  visible: Set<string>,
  byId: Map<string, WorkingNode>,
  diagnostics: DiagnosticSink,
): VisibleTree {
  const roots: WorkingNode[] = [];
  const nextByParent = new Map<string, WorkingNode>();
  const branchesByParent = new Map<string, WorkingNode[]>();
  const parentOf = new Map<string, string>();

  for (const node of nodes) {
    if (!visible.has(node.id)) continue;
    const parentId = node.parentId;
    if (parentId !== null && visible.has(parentId)) {
      if (node.flow === 'next') {
        if (nextByParent.has(parentId)) {
          roots.push(node);
          diagnostics.add('multiple-next', '该来源已有可见 next，节点按顶层绘制', node.id);
          continue;
        }
        nextByParent.set(parentId, node);
        parentOf.set(node.id, parentId);
      } else if (node.flow === 'branch') {
        const list = branchesByParent.get(parentId);
        if (list === undefined) branchesByParent.set(parentId, [node]);
        else list.push(node);
        parentOf.set(node.id, parentId);
      } else {
        roots.push(node);
      }
      continue;
    }

    roots.push(node);
    if (parentId !== null && byId.has(parentId)) {
      diagnostics.add('visibility-root-hidden', '父节点未参与本次布局，节点按顶层绘制', node.id);
    }
  }

  for (const list of branchesByParent.values()) list.sort(compareBranches);
  // 森林顺序不依赖输入数组：声明 root 在前，其余按稳定 ID。
  roots.sort((a, b) => {
    const aRoot = a.flow === 'root' ? 0 : 1;
    const bRoot = b.flow === 'root' ? 0 : 1;
    if (aRoot !== bRoot) return aRoot - bRoot;
    return compareIds(a.id, b.id);
  });
  return { roots, nextByParent, branchesByParent, parentOf };
}

function compareBranches(a: WorkingNode, b: WorkingNode): number {
  if (a.order !== null && b.order !== null) {
    if (a.order !== b.order) return a.order - b.order;
    return compareIds(a.id, b.id);
  }
  if (a.order !== null) return -1;
  if (b.order !== null) return 1;
  // 缺 order 仍合法：排在显式 order 之后，同缺失按稳定 node.id 升序，
  // 避免输入数组顺序改变布局。
  return compareIds(a.id, b.id);
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function measureBlock(head: WorkingNode, context: MeasureContext): Block {
  const cached = context.memo.get(head.id);
  if (cached !== undefined) return cached;
  if (context.visiting.has(head.id)) {
    context.diagnostics.add('cycle', '布局递归出现环，节点单独绘制', head.id);
    return {
      width: context.config.cardWidth,
      height: context.config.cardHeight,
      nodes: [{ node: head, x: 0, y: 0 }],
    };
  }
  context.visiting.add(head.id);

  const { cardWidth, cardHeight, verticalGap, horizontalGap } = context.config;
  const step = cardHeight + verticalGap;

  const spine: WorkingNode[] = [];
  const inSpine = new Set<string>();
  let current: WorkingNode | undefined = head;
  while (current !== undefined) {
    if (inSpine.has(current.id)) {
      context.diagnostics.add('cycle', 'next 链出现环，链在此处截断', current.id);
      break;
    }
    inSpine.add(current.id);
    spine.push(current);
    current = context.nextByParent.get(current.id);
  }

  interface BranchEntry {
    block: Block;
    sourceIndex: number;
  }

  const leftEntries: BranchEntry[] = [];
  const rightEntries: BranchEntry[] = [];
  for (let index = 0; index < spine.length; index += 1) {
    const source = spine[index];
    if (source === undefined) continue;
    const branches = context.branchesByParent.get(source.id) ?? [];
    for (const child of branches) {
      const block = measureBlock(child, context);
      const entry: BranchEntry = { block, sourceIndex: index };
      if (child.side === 'left') leftEntries.push(entry);
      else rightEntries.push(entry);
    }
  }

  let leftWidth = 0;
  for (const entry of leftEntries) leftWidth = Math.max(leftWidth, entry.block.width);
  let rightWidth = 0;
  for (const entry of rightEntries) rightWidth = Math.max(rightWidth, entry.block.width);

  const cardX = leftWidth > 0 ? leftWidth + horizontalGap : 0;
  const width = cardX + cardWidth + (rightWidth > 0 ? horizontalGap + rightWidth : 0);
  const spineHeight = spine.length === 0 ? cardHeight : (spine.length - 1) * step + cardHeight;

  const entrySide: LayoutSide | null = head.flow === 'branch' ? (head.side === 'right' ? 'left' : 'right') : null;
  const branches: BlockNode[] = [];

  let leftLaneNext = 0;
  for (const entry of leftEntries) {
    const sourceY = entry.sourceIndex * step;
    const reserved = entry.sourceIndex === 0 && entrySide === 'left' ? step : 0;
    const y = Math.max(sourceY, leftLaneNext, reserved);
    const x = cardX - horizontalGap - entry.block.width;
    for (const node of entry.block.nodes) branches.push({ node: node.node, x: x + node.x, y: y + node.y });
    leftLaneNext = y + entry.block.height + verticalGap;
  }

  let rightLaneNext = 0;
  for (const entry of rightEntries) {
    const sourceY = entry.sourceIndex * step;
    const reserved = entry.sourceIndex === 0 && entrySide === 'right' ? step : 0;
    const y = Math.max(sourceY, rightLaneNext, reserved);
    const x = cardX + cardWidth + horizontalGap;
    for (const node of entry.block.nodes) branches.push({ node: node.node, x: x + node.x, y: y + node.y });
    rightLaneNext = y + entry.block.height + verticalGap;
  }

  const nodes: BlockNode[] = [];
  for (let index = 0; index < spine.length; index += 1) {
    const node = spine[index];
    if (node !== undefined) nodes.push({ node, x: cardX, y: index * step });
  }
  nodes.push(...branches);

  let height = spineHeight;
  if (leftEntries.length > 0) height = Math.max(height, leftLaneNext - verticalGap);
  if (rightEntries.length > 0) height = Math.max(height, rightLaneNext - verticalGap);

  const block: Block = { width, height, nodes };
  context.memo.set(head.id, block);
  context.visiting.delete(head.id);
  return block;
}

function applyPreviousAnchor(
  raw: unknown,
  primaryRoot: WorkingNode | undefined,
  positions: Map<string, LayoutPosition>,
): void {
  if (primaryRoot === undefined || !isRecord(raw)) return;
  const previous = raw[primaryRoot.id];
  if (!isRecord(previous)) return;
  const x = previous.x;
  const y = previous.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const current = positions.get(primaryRoot.id);
  if (current === undefined) return;
  const dx = x - current.x;
  const dy = y - current.y;
  if (dx === 0 && dy === 0) return;
  for (const [id, position] of positions) positions.set(id, { x: position.x + dx, y: position.y + dy });
}

function buildEdgeRoutes(
  nodes: WorkingNode[],
  visible: Set<string>,
  parentOf: Map<string, string>,
  positions: Map<string, LayoutPosition>,
  config: LayoutConfig,
  diagnostics: DiagnosticSink,
): LayoutEdgeRoute[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const routes: LayoutEdgeRoute[] = [];
  const { cardWidth, cardHeight, horizontalGap } = config;

  for (const node of nodes) {
    if (!visible.has(node.id) || node.flow === 'root') continue;
    const parentId = parentOf.get(node.id);
    if (parentId === undefined) continue;
    const parent = byId.get(parentId);
    if (parent === undefined) continue;
    const source = positions.get(parentId);
    const target = positions.get(node.id);
    if (source === undefined || target === undefined) continue;

    let points: LayoutPoint[];
    let side: LayoutSide | undefined;
    if (node.flow === 'next') {
      points = simplifyPoints([
        { x: source.x + cardWidth / 2, y: source.y + cardHeight },
        { x: target.x + cardWidth / 2, y: target.y },
      ]);
    } else if (node.flow === 'branch') {
      side = node.side;
      const sourceCenterY = source.y + cardHeight / 2;
      const targetCenterY = target.y + cardHeight / 2;
      if (side === 'right') {
        const sourceEdge = source.x + cardWidth;
        const channel = sourceEdge + horizontalGap / 2;
        const targetEdge = target.x;
        points = simplifyPoints([
          { x: sourceEdge, y: sourceCenterY },
          { x: channel, y: sourceCenterY },
          { x: channel, y: targetCenterY },
          { x: targetEdge, y: targetCenterY },
        ]);
      } else {
        const sourceEdge = source.x;
        const channel = sourceEdge - horizontalGap / 2;
        const targetEdge = target.x + cardWidth;
        points = simplifyPoints([
          { x: sourceEdge, y: sourceCenterY },
          { x: channel, y: sourceCenterY },
          { x: channel, y: targetCenterY },
          { x: targetEdge, y: targetCenterY },
        ]);
      }
    } else {
      continue;
    }

    const route: LayoutEdgeRoute = {
      id: parentId + '->' + node.id,
      from: parentId,
      to: node.id,
      flow: node.flow,
      points,
    };
    if (side !== undefined) route.side = side;
    if (node.label !== null && node.label.trim().length > 0) {
      route.labelAnchor = longestSegmentMidpoint(points);
    }
    routes.push(route);
  }

  return routes;
}

function simplifyPoints(raw: LayoutPoint[]): LayoutPoint[] {
  const deduped: LayoutPoint[] = [];
  for (const point of raw) {
    const last = deduped[deduped.length - 1];
    if (last !== undefined && Math.abs(last.x - point.x) < 1e-9 && Math.abs(last.y - point.y) < 1e-9) continue;
    deduped.push({ x: point.x, y: point.y });
  }

  let changed = true;
  while (changed && deduped.length > 2) {
    changed = false;
    for (let index = 1; index < deduped.length - 1; index += 1) {
      const a = deduped[index - 1];
      const b = deduped[index];
      const c = deduped[index + 1];
      if (a === undefined || b === undefined || c === undefined) continue;
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(cross) < 1e-9) {
        deduped.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return deduped;
}

function longestSegmentMidpoint(points: LayoutPoint[]): LayoutPoint {
  let bestA = points[0] ?? { x: 0, y: 0 };
  let bestB = points[1] ?? bestA;
  let bestLength = -1;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    if (length > bestLength) {
      bestLength = length;
      bestA = a;
      bestB = b;
    }
  }
  return { x: (bestA.x + bestB.x) / 2, y: (bestA.y + bestB.y) / 2 };
}

function reportRoutePenetrations(
  routes: LayoutEdgeRoute[],
  nodes: WorkingNode[],
  visible: Set<string>,
  positions: Record<string, LayoutPosition>,
  config: LayoutConfig,
  diagnostics: DiagnosticSink,
): void {
  for (const route of routes) {
    let crossed: WorkingNode | undefined;
    for (const node of nodes) {
      if (!visible.has(node.id) || node.id === route.from || node.id === route.to) continue;
      const position = positions[node.id];
      if (position === undefined) continue;
      if (segmentsCrossRect(route.points, position, config.cardWidth, config.cardHeight)) {
        crossed = node;
        break;
      }
    }
    if (crossed !== undefined) {
      diagnostics.add(
        'route-fallback',
        '路由在有限搜索内避让失败，仍保留直角绕行；请检查卡片间距',
        route.to,
      );
    }
  }
}

function segmentsCrossRect(
  points: LayoutPoint[],
  position: LayoutPosition,
  width: number,
  height: number,
): boolean {
  const left = position.x;
  const right = position.x + width;
  const top = position.y;
  const bottom = position.y + height;
  const epsilon = 0.01;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) continue;
    if (Math.abs(a.y - b.y) < epsilon) {
      if (a.y <= top + epsilon || a.y >= bottom - epsilon) continue;
      const low = Math.min(a.x, b.x);
      const high = Math.max(a.x, b.x);
      if (Math.min(high, right - epsilon) > Math.max(low, left + epsilon)) return true;
      continue;
    }
    if (Math.abs(a.x - b.x) < epsilon) {
      if (a.x <= left + epsilon || a.x >= right - epsilon) continue;
      const low = Math.min(a.y, b.y);
      const high = Math.max(a.y, b.y);
      if (Math.min(high, bottom - epsilon) > Math.max(low, top + epsilon)) return true;
    }
  }
  return false;
}

function computeBounds(
  nodes: WorkingNode[],
  visible: Set<string>,
  positions: Record<string, LayoutPosition>,
  config: LayoutConfig,
): LayoutRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    if (!visible.has(node.id)) continue;
    const position = positions[node.id];
    if (position === undefined) continue;
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + config.cardWidth);
    maxY = Math.max(maxY, position.y + config.cardHeight);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function emptyResult(
  structureVersion: number | string | null,
  config: LayoutConfig,
  diagnostics: LayoutDiagnostic[],
): LayoutResult {
  return {
    positions: {},
    edgeRoutes: [],
    hiddenCounts: {},
    diagnostics,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    cardWidth: config.cardWidth,
    cardHeight: config.cardHeight,
    layoutVersion: LAYOUT_VERSION,
    structureVersion,
  };
}

function createDiagnosticSink(): DiagnosticSink {
  const items: LayoutDiagnostic[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const add = (code: LayoutDiagnosticCode, message: string, nodeId?: string): void => {
    const key = code + '|' + (nodeId ?? '') + '|' + message;
    if (seen.has(key)) return;
    seen.add(key);
    if (items.length >= MAX_LAYOUT_DIAGNOSTICS) {
      truncated = true;
      return;
    }
    items.push(nodeId === undefined ? { code, message } : { code, message, nodeId });
  };

  const finish = (): LayoutDiagnostic[] => {
    if (!truncated) return items;
    if (items.length >= MAX_LAYOUT_DIAGNOSTICS) items.pop();
    items.push({ code: 'diagnostics-truncated', message: '诊断数量超过上限，其余已省略' });
    return items;
  };

  return { add, finish };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
