/** Block geometry, reading anchor and deterministic orthogonal routes. */
import type { LayoutEdgeRoute, LayoutPoint, LayoutPosition, LayoutRect, LayoutSide } from './types.js';
import {
  isRecord,
  type Block,
  type BlockNode,
  type DiagnosticSink,
  type LayoutConfig,
  type MeasureContext,
  type WorkingNode,
} from './internal.js';

export function measureBlock(head: WorkingNode, context: MeasureContext): Block {
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

export function applyPreviousAnchor(
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

export function buildEdgeRoutes(
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

export function reportRoutePenetrations(
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

export function computeBounds(
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
