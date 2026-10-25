import { LAYOUT_ROOT_GAP } from '../graph/cardMetrics.js';
import { LAYOUT_VERSION, type LayoutInput, type LayoutPosition, type LayoutResult } from './types.js';
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
import { measureChain, type MeasureContext } from './measure.js';
import { applyPreviousAnchor, buildEdgeRoutes, computeBounds } from './routing.js';

export * from './types.js';

/**
 * 确定性纯布局。
 *
 * 结构解释：
 * - 全局主线与每条 branch 目标链都沿 next 从上到下推进。
 * - branch 统一从来源卡片向右展开；同源兄弟在右侧上下堆叠，共用一条竖向干线。
 * - 一个节点与它的直接分支组成完整纵向区域，本链 next 后继从区域底部继续。
 * - 折叠节点不占位；位置、路由、干线和标签框统一按 previousPositions 平移。
 *
 * 同输入同输出，不读取正文、标题或编号；side 不再参与布局。
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

  const measureContext: MeasureContext = {
    nextByParent: tree.nextByParent,
    branchesByParent: tree.branchesByParent,
    config,
    diagnostics,
    memo: new Map(),
    visiting: new Set(),
  };

  const placed = new Map<string, LayoutPosition>();
  let cursorY = 0;
  for (const root of tree.roots) {
    const block = measureChain(root, measureContext);
    for (const node of block.nodes) {
      if (placed.has(node.node.id)) continue;
      placed.set(node.node.id, { x: node.x, y: cursorY + node.y });
    }
    cursorY += block.height + LAYOUT_ROOT_GAP;
  }

  // Safety net: a visible node must always receive a coordinate. Valid inputs
  // never reach this branch; keep the fallback in the left-hand forest.
  const visibleSorted = nodes
    .filter((node) => visibility.visible.has(node.id))
    .map((node) => node.id)
    .sort(compareIds);
  for (const id of visibleSorted) {
    if (placed.has(id)) continue;
    const node = byId.get(id);
    if (node === undefined) continue;
    placed.set(id, { x: 0, y: cursorY });
    cursorY += node.height + LAYOUT_ROOT_GAP;
    diagnostics.add('unreachable-node', '节点未接入可见树，已单独放置在左侧森林下方', id);
  }

  const primaryRoot = tree.roots[0];
  applyPreviousAnchor(raw.previousPositions, primaryRoot, placed);

  // Output records are sorted by stable id, so input array order cannot change
  // the serialized result.
  const positions: Record<string, LayoutPosition> = {};
  const heights: Record<string, number> = {};
  for (const id of visibleSorted) {
    const position = placed.get(id);
    if (position !== undefined) positions[id] = { x: position.x, y: position.y };
    const node = byId.get(id);
    if (node !== undefined) heights[id] = node.height;
  }

  const routed = buildEdgeRoutes(byId, tree, placed, config);
  const labels = routed.routes
    .map((route) => route.label)
    .filter((label): label is NonNullable<typeof label> => label !== undefined);
  const bounds = computeBounds(positions, heights, config.cardWidth, labels);

  return {
    positions,
    edgeRoutes: routed.routes,
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
