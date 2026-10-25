import { LAYOUT_VERSION, type LayoutInput, type LayoutPosition, type LayoutResult, type LayoutSide } from './types.js';
import { compareIds, createDiagnosticSink, emptyResult } from './internal.js';
import { isRecord } from '../../shared/guards.js';
import {
  defaultConfig,
  readConfig,
  readStructureVersion,
  normalizeNodes,
  resolveParentReferences,
  breakCycles,
  detachConflictingSiblings,
  reportRootShape,
  buildChildMap,
  computeVisibility,
  buildVisibleTree,
} from './inputTree.js';
import { measureBlock, type MeasureContext } from './measure.js';
import { applyPreviousAnchor, buildEdgeRoutes, reportRoutePenetrations, computeBounds } from './routing.js';

export * from './types.js';

/**
 * 确定性纯布局。
 *
 * 结构解释：
 * - 每个节点最多一个 next 后继；next 共享当前局部纵轴，主线继续纵向推进。
 * - 同一父节点的 branch 横向各占一列，枝内 next 沿本列继续；列从主脊向外编号。
 * - branch 显式声明的 side 优先；未声明时按分支计数自动择侧。
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
  const nodes = normalizeNodes(raw.nodes, diagnostics, config.cardHeight);
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

  const sides = new Map<string, LayoutSide>();
  const groupDepths = new Map<string, number>();
  const columns = new Map<string, number>();
  const entrySides = new Map<string, LayoutSide>();
  const measureContext: MeasureContext = {
    nextByParent: tree.nextByParent,
    branchesByParent: tree.branchesByParent,
    config,
    diagnostics,
    memo: new Map(),
    visiting: new Set(),
    sides,
    groupDepths,
    columns,
    entrySides,
  };

  const forest = tree.roots.map((root) => ({ root, block: measureBlock(root, null, 0, measureContext) }));
  const placed = new Map<string, LayoutPosition>();
  let forestCursor = 0;
  for (const entry of forest) {
    // 行 0 的走廊落在 head 上方，整块下移自己的 topExtent，避免负坐标与负起点包围盒。
    for (const node of entry.block.nodes) {
      placed.set(node.node.id, { x: forestCursor + node.x, y: entry.block.topExtent + node.y });
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
  const heights: Record<string, number> = {};
  const visibleSorted = nodes
    .filter((node) => visibility.visible.has(node.id))
    .map((node) => node.id)
    .sort(compareIds);
  for (const id of visibleSorted) {
    const position = placed.get(id);
    if (position !== undefined) positions[id] = { x: position.x, y: position.y };
    const node = byId.get(id);
    if (node !== undefined) heights[id] = node.height;
  }

  const routed = buildEdgeRoutes(
    nodes,
    visibility.visible,
    tree.parentOf,
    placed,
    config,
    sides,
    groupDepths,
    columns,
    entrySides,
  );
  const edgeRoutes = routed.routes;
  reportRoutePenetrations(edgeRoutes, routed.trunks, nodes, visibility.visible, positions, config, diagnostics);
  const bounds = computeBounds(nodes, visibility.visible, positions, config);

  return {
    positions,
    edgeRoutes,
    branchTrunks: routed.trunks,
    hiddenCounts: visibility.hiddenCounts,
    diagnostics: diagnostics.finish(),
    bounds,
    cardWidth: config.cardWidth,
    cardHeight: config.cardHeight,
    heights,
    layoutVersion: LAYOUT_VERSION,
    structureVersion,
  };
}
