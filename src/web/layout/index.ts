import { LAYOUT_VERSION, type LayoutInput, type LayoutPosition, type LayoutResult } from './types.js';
import { compareIds, createDiagnosticSink, emptyResult, isRecord, type MeasureContext } from './internal.js';
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
import { measureBlock, applyPreviousAnchor, buildEdgeRoutes, reportRoutePenetrations, computeBounds } from './geometry.js';

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
