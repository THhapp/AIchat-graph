/** Input normalization, relationship repair and the visible reading tree. */
import {
  DEFAULT_CARD_HEIGHT,
  DEFAULT_CARD_WIDTH,
  DEFAULT_HORIZONTAL_GAP,
  DEFAULT_VERTICAL_GAP,
  type LayoutFlow,
  type LayoutSide,
} from './types.js';
import {
  compareIds,
  type DiagnosticSink,
  type LayoutConfig,
  type Visibility,
  type VisibleTree,
  type WorkingNode,
} from './internal.js';
import { isRecord } from '../../shared/guards.js';

export function defaultConfig(): LayoutConfig {
  return {
    cardWidth: DEFAULT_CARD_WIDTH,
    cardHeight: DEFAULT_CARD_HEIGHT,
    verticalGap: DEFAULT_VERTICAL_GAP,
    horizontalGap: DEFAULT_HORIZONTAL_GAP,
  };
}

export function readConfig(raw: Record<string, unknown>, diagnostics: DiagnosticSink): LayoutConfig {
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

export function readStructureVersion(raw: Record<string, unknown>): number | string | null {
  const value = raw.structureVersion;
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

export function normalizeNodes(rawNodes: unknown, diagnostics: DiagnosticSink, cardHeight: number): WorkingNode[] {
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

    let declaredSide: LayoutSide | null = null;
    if (flow === 'branch') {
      if (raw.side === 'left' || raw.side === 'right') {
        declaredSide = raw.side;
      } else if (raw.side !== undefined && raw.side !== null) {
        diagnostics.add('invalid-node', 'branch.side 无效，按未声明（自动择侧）处理', id);
      }
    }

    let order: number | null = null;
    if (flow === 'branch') {
      if (typeof raw.order === 'number' && Number.isFinite(raw.order)) order = raw.order;
      else if (raw.order !== undefined && raw.order !== null) {
        diagnostics.add('invalid-node', 'branch.order 必须是有限数字，按缺失处理', id);
      }
    }

    let height = cardHeight;
    if (raw.height !== undefined && raw.height !== null) {
      if (typeof raw.height === 'number' && Number.isFinite(raw.height) && raw.height > 0) height = raw.height;
      else diagnostics.add('invalid-node', '卡片高度提示无效，按默认高度处理', id);
    }

    result.push({
      id,
      inputIndex: index,
      flow,
      parentId,
      declaredSide,
      order,
      height,
      label: typeof raw.label === 'string' ? raw.label : null,
      topicId: typeof raw.topicId === 'string' ? raw.topicId : null,
    });
  }

  return result;
}

export function resolveParentReferences(
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

export function breakCycles(
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

export function detachConflictingSiblings(nodes: WorkingNode[], diagnostics: DiagnosticSink): void {
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

export function reportRootShape(nodes: WorkingNode[], diagnostics: DiagnosticSink): void {
  let declaredRoots = 0;
  for (const node of nodes) if (node.flow === 'root') declaredRoots += 1;
  if (declaredRoots === 0) diagnostics.add('missing-root', '结构中没有 root，按独立顶层绘制');
  else if (declaredRoots > 1) diagnostics.add('multiple-roots', '结构中有多个 root，按并列顶层绘制');
}

export function buildChildMap(nodes: WorkingNode[]): Map<string, WorkingNode[]> {
  const map = new Map<string, WorkingNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = map.get(node.parentId);
    if (list === undefined) map.set(node.parentId, [node]);
    else list.push(node);
  }
  return map;
}

export function computeVisibility(
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

export function buildVisibleTree(
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

/** 同源 branch 的稳定顺序：order 升序，缺失后置，同序/同缺按 node.id。 */
export function compareBranches(a: WorkingNode, b: WorkingNode): number {
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
