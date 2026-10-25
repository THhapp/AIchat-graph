/** Reading anchor, deterministic orthogonal routes and route/bounds diagnostics. */
import type {
  LayoutBranchTrunk,
  LayoutEdgeRoute,
  LayoutPoint,
  LayoutPosition,
  LayoutRect,
  LayoutSide,
} from './types.js';
import {
  ENTRY_PORT_OFFSET,
  NESTED_BAND_OFFSET,
  TRUNK_OFFSET,
  TRUNK_STEP,
  compareIds,
  type DiagnosticSink,
  type LayoutConfig,
  type WorkingNode,
} from './internal.js';
import { isRecord } from '../../shared/guards.js';
import { compareBranches } from './inputTree.js';

/** 出口竖线贴源卡的距离；最内成员不在第一列时用它，同带的其他来源逐个外移。 */
const CHANNEL_INSET = 12;
/** 同一空隙里出现第二个来源时，两条出口竖线的最小可辨间距（4px 会被读成一根粗线）。 */
const CHANNEL_STEP = 12;
/** 关系文字落在独占支线上的比例，以及它距支线两端的最小留白。 */
const LABEL_RATIO = 0.62;
const LABEL_PAD = 14;
/** Z 形短折的竖段短于此值时视为近乎等高，标签退回两点中点。 */
const LABEL_MIN_RISE = 40;

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

function resolvedSide(node: WorkingNode, sides: Map<string, LayoutSide>): LayoutSide {
  return sides.get(node.id) ?? node.declaredSide ?? 'right';
}

/** 一个待接出的并列组成员：落点在目标列左侧空隙中心。 */
interface BranchMember {
  node: WorkingNode;
  dropX: number;
  targetEdge: number;
  targetCenterY: number;
  /** 目标卡左上角 y，整组共用同一带的 y。 */
  bandY: number;
}

/** 同源同侧的一组并列分支；整组共用一个出口和一条横向干线。 */
interface BranchGroup {
  id: string;
  from: string;
  side: LayoutSide;
  members: BranchMember[];
}

export interface BuiltRoutes {
  routes: LayoutEdgeRoute[];
  trunks: LayoutBranchTrunk[];
}

/**
 * 生成路由：next 直连，branch 同源同侧共用干线。
 *
 * 共享段只画一次——干线负责"出口横段 → 上升竖段 → 横向主干"，
 * 每条分支只保留自己从接出点下到目标卡的独占段。
 */
export function buildEdgeRoutes(
  nodes: WorkingNode[],
  visible: Set<string>,
  parentOf: Map<string, string>,
  positions: Map<string, LayoutPosition>,
  config: LayoutConfig,
  sides: Map<string, LayoutSide>,
  groupDepths: Map<string, number>,
  columns: Map<string, number>,
  entrySides: Map<string, LayoutSide>,
): BuiltRoutes {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const { cardWidth, horizontalGap } = config;
  const routes: LayoutEdgeRoute[] = [];
  const trunks: LayoutBranchTrunk[] = [];

  // 分支节点的子分支带整条下移 NESTED_BAND_OFFSET，逐级累计。
  // 干线 y 要相对"未加这条位移的那条带"来算，否则父带下移 24 会把嵌套干线压到父干线
  // 下方 10px，层级读反。位移量按父链上 branch 节点的个数还原，而不是用 depth 乘：
  // 同一条带上的多个来源共用一个 band，depth 表示带内层号，不是嵌套级数。
  const bandShifts = new Map<string, number>();
  const bandShiftOf = (id: string): number => {
    const cached = bandShifts.get(id);
    if (cached !== undefined) return cached;
    const chain: string[] = [];
    let base = 0;
    let cursor: string | undefined = id;
    while (cursor !== undefined) {
      const known = bandShifts.get(cursor);
      if (known !== undefined) {
        base = known;
        break;
      }
      if (chain.includes(cursor)) break;
      chain.push(cursor);
      cursor = parentOf.get(cursor);
    }
    // chain 是从 id 往上收集的逆序：从已知端往回逐级补上各自的位移。
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const key = chain[index];
      if (key === undefined) continue;
      if (byId.get(key)?.flow === 'branch') base += NESTED_BAND_OFFSET;
      bandShifts.set(key, base);
    }
    return bandShifts.get(id) ?? 0;
  };

  // 1. 分组与成员顺序沿用列分配：order/id 升序即由内到外的落位列。
  const ordered = [...nodes].sort((a, b) => compareIds(a.id, b.id));
  const collected = new Map<string, BranchGroup>();
  for (const node of ordered) {
    if (!visible.has(node.id) || node.flow !== 'branch') continue;
    const parentId = parentOf.get(node.id);
    if (parentId === undefined) continue;
    const side = resolvedSide(node, sides);
    const id = parentId + '~' + side;
    const found = collected.get(id);
    if (found === undefined) collected.set(id, { id, from: parentId, side, members: [] });
  }

  for (const node of ordered) {
    if (!visible.has(node.id) || node.flow === 'root') continue;
    const parentId = parentOf.get(node.id);
    if (parentId === undefined) continue;
    const parent = byId.get(parentId);
    if (parent === undefined) continue;
    const source = positions.get(parentId);
    const target = positions.get(node.id);
    if (source === undefined || target === undefined) continue;

    if (node.flow === 'next') {
      const centerX = source.x + cardWidth / 2;
      const targetCenterX = target.x + cardWidth / 2;
      const route: LayoutEdgeRoute = {
        id: parentId + '->' + node.id,
        from: parentId,
        to: node.id,
        flow: 'next',
        points: simplifyPoints([
          { x: centerX, y: source.y + parent.height },
          { x: targetCenterX, y: target.y },
        ]),
      };
      if (hasLabel(node)) {
        route.labelAnchor = { x: (centerX + targetCenterX) / 2, y: (source.y + parent.height + target.y) / 2 };
        route.labelWidth = Math.max(80, cardWidth - 40);
      }
      routes.push(route);
      continue;
    }

    const side = resolvedSide(node, sides);
    const group = collected.get(parentId + '~' + side);
    if (group === undefined) continue;
    group.members.push({
      node,
      // 落点竖线只跨目标列外侧的一格空隙，不跨任何卡。
      dropX: side === 'right' ? target.x - horizontalGap / 2 : target.x + cardWidth + horizontalGap / 2,
      targetEdge: side === 'right' ? target.x : target.x + cardWidth,
      targetCenterY: target.y + node.height / 2,
      bandY: target.y,
    });
  }

  // 同一带上同侧可能有多个来源（例如一个 branch 节点与它的 next 共享 x）：
  // 出口竖段已改成最内成员的落点线，这里记下同带的来源次序，供那条罕见情形内移错开。
  const channelRanks = new Map<string, number>();
  const bandSources = new Map<string, { id: string; sourceX: number; sourceY: number }[]>();
  for (const [id, group] of collected) {
    if (group.members.length === 0) continue;
    const source = positions.get(group.from);
    if (source === undefined) continue;
    const bandY = Math.min(...group.members.map((member) => member.bandY));
    const key = bandY + '|' + group.side;
    bandSources.set(key, [...(bandSources.get(key) ?? []), { id, sourceX: source.x, sourceY: source.y }]);
  }
  for (const list of bandSources.values()) {
    list.sort((a, b) => {
      if (a.sourceX !== b.sourceX) return a.sourceX - b.sourceX;
      if (a.sourceY !== b.sourceY) return a.sourceY - b.sourceY;
      return compareIds(a.id, b.id);
    });
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      if (item !== undefined) channelRanks.set(item.id, index);
    }
  }

  for (const id of [...collected.keys()].sort(compareIds)) {
    const group = collected.get(id);
    if (group === undefined || group.members.length === 0) continue;
    group.members.sort((a, b) => compareBranches(a.node, b.node));
    const parent = byId.get(group.from);
    const source = positions.get(group.from);
    if (parent === undefined || source === undefined) continue;

    const sourceCenterY = source.y + parent.height / 2;
    const sourceEdge = group.side === 'right' ? source.x + cardWidth : source.x;
    // 入口侧（分支节点背向自己方向的那一侧）的子分支从同一侧边的第二个端口分出：
    // 中心下方固定偏移，左右镜像。父节点连进来的横线仍在侧边中心，两个方向可分辨；
    // 不退到底边/底角，起点圆点与实际路径首点（包括干线起点）都落在这个端口上。
    const onEntrySide = entrySides.get(group.from) === group.side;
    const exitY = onEntrySide
      ? Math.min(sourceCenterY + ENTRY_PORT_OFFSET, source.y + parent.height - 2)
      : sourceCenterY;
    const first = group.members[0];
    if (first === undefined) continue;

    // 2. 单张、在最内一列：走一次 Z 形短折——出口横段 → 竖向通道 → 入卡横段。
    //    它与目标之间只隔一格空隙，没有别的卡要绕，所以不需要干线，也不带 join。
    //    竖线落在空隙正中（与干线成员的落点 x 同一列带），既不贴源卡当第二条边框，
    //    也不会和自己的标签框抢位置。等高时中间的通道点被 simplifyPoints 塌掉，
    //    退化成一条水平直连。
    if (group.members.length === 1 && columns.get(first.node.id) === 1) {
      const channelX =
        group.side === 'right' ? sourceEdge + horizontalGap / 2 : sourceEdge - horizontalGap / 2;
      const route: LayoutEdgeRoute = {
        id: group.from + '->' + first.node.id,
        from: group.from,
        to: first.node.id,
        flow: 'branch',
        side: group.side,
        points: simplifyPoints([
          { x: sourceEdge, y: exitY },
          { x: channelX, y: exitY },
          { x: channelX, y: first.targetCenterY },
          { x: first.targetEdge, y: first.targetCenterY },
        ]),
      };
      if (hasLabel(first.node)) {
        const rise = Math.abs(first.targetCenterY - exitY);
        const midY = (exitY + first.targetCenterY) / 2;
        // 竖段够长就贴着自己的竖段，近乎等高时退回两点中点；两者在空隙里同 x。
        route.labelAnchor =
          rise < LABEL_MIN_RISE ? { x: (sourceEdge + first.targetEdge) / 2, y: midY } : { x: channelX, y: midY };
        route.labelWidth = Math.max(40, horizontalGap - 16);
      }
      routes.push(route);
      continue;
    }

    // 3. 其余情况：整组共用一个出口、一条干线，再从干线分别下接目标。
    //    整组由一次 placeGroup 放到同一个 y，所以这里只有一个 bandY；
    //    若以后允许一个组拆到多条带，干线必须按带拆开、各自预留走廊。
    const bandY = Math.min(...group.members.map((member) => member.bandY));
    const depth = groupDepths.get(id) ?? 0;
    // 每嵌套一层抬 TRUNK_STEP，同时把这层带整体下移的 NESTED_BAND_OFFSET 补回去：
    // 嵌套组的干线于是比父组干线高一个 TRUNK_STEP，与卡片的下移方向一致，层级不会读反。
    const trunkY = bandY - TRUNK_OFFSET - depth * TRUNK_STEP - bandShiftOf(group.from);
    // 出口竖段与最内成员的落点竖段合成一条线：空隙里只留一条竖线，最内那张的标签骑在它上面。
    // 最内按落点列取（右侧最小 dropX、左侧最大 dropX），不依赖成员数组顺序。
    // 注意共线有两处，别把这句读成缺陷：
    //   近端（这里引入）——出口竖段 exitY→trunkY 与最内成员落点 trunkY→targetCenterY 合并；
    //   远端（既有结构）——干线末点就是最远成员的落点 dropX，任何 T 型干线都长这样。
    const innermost = group.members.reduce((best, member) =>
      group.side === 'right'
        ? member.dropX < best.dropX ? member : best
        : member.dropX > best.dropX ? member : best,
    );
    // 只有最内成员就在紧邻源卡的那一列时才能合并：这条横段从出口走到它，中间只有空隙。
    // 若最内成员被挤到更外层的列（那一列被别的来源占着），两者之间隔着第 1 列的卡，
    // 横段从出口直接横穿过去必然穿卡（实测 bn~left 穿过 bl；80 个随机种子里 10 例）。
    // 那种情况必须先贴着源卡升到干线高度再横穿，两条竖线是几何必需，别当成冗余删掉这个判断。
    // 合并时不会有两个来源争同一条线：同一带上同侧的第二个组会被 placeGroup 挪到下一列，
    // 也就走了下面这条兜底路径，各自按 rank 外移。
    const merged = columns.get(innermost.node.id) === 1;
    const rank = channelRanks.get(id) ?? 0;
    const channel = merged
      ? innermost.dropX
      : group.side === 'right'
        ? sourceEdge + channelInset(rank, horizontalGap)
        : sourceEdge - channelInset(rank, horizontalGap);
    // 最远成员按落点列取最外侧，不依赖成员数组顺序。
    const farthest = group.members.reduce((best, member) =>
      group.side === 'right'
        ? member.dropX > best.dropX ? member : best
        : member.dropX < best.dropX ? member : best,
    );

    trunks.push({
      id,
      from: group.from,
      side: group.side,
      to: farthest.node.id,
      trunkY,
      points: simplifyPoints([
        { x: sourceEdge, y: exitY },
        { x: channel, y: exitY },
        { x: channel, y: trunkY },
        { x: farthest.dropX, y: trunkY },
      ]),
    });

    for (const member of group.members) {
      const join: LayoutPoint = { x: member.dropX, y: trunkY };
      const route: LayoutEdgeRoute = {
        id: group.from + '->' + member.node.id,
        from: group.from,
        to: member.node.id,
        flow: 'branch',
        side: group.side,
        join,
        points: simplifyPoints([
          join,
          { x: member.dropX, y: member.targetCenterY },
          { x: member.targetEdge, y: member.targetCenterY },
        ]),
      };
      if (hasLabel(member.node)) {
        // 最内成员的落点竖段与干线竖段是同一条线（merged），标签骑上去等于贴在整组的
        // 共享通道上，会被读成整组说明。它的独占段只有那截入卡横段，所以改骑横段中点：
        // 这条横段只通向它自己的目标卡，指向唯一。其余成员落点线独占一格空隙，照旧。
        route.labelAnchor =
          merged && member === innermost
            ? { x: (member.dropX + member.targetEdge) / 2, y: member.targetCenterY }
            : { x: member.dropX, y: trunkLabelY(trunkY, member.targetCenterY) };
        route.labelWidth = Math.max(40, horizontalGap - 16);
      }
      routes.push(route);
    }
  }

  routes.sort((a, b) => compareIds(a.id, b.id));
  return { routes, trunks };
}

/**
 * 出口竖线离源卡边缘的距离：最内成员不在第一列时用它兜底，
 * 同带同侧的多个来源依次外移 CHANNEL_STEP（保证两条竖线可分辨），
 * 最后夹到空隙中点之内（`gap/2 - 4`），所以 rank 再大也不会越过最内落点。
 */
function channelInset(rank: number, horizontalGap: number): number {
  const wanted = Math.min(CHANNEL_INSET, horizontalGap / 4) + rank * CHANNEL_STEP;
  return Math.min(wanted, Math.max(1, horizontalGap / 2 - 4));
}

/**
 * 关系文字落在自己的独占支线上：距干线约 62%，并距两端各留 ≥ LABEL_PAD。
 * 支线过短时贴向目标端，仍留在支线内，绝不落到公共干线上。
 */
function trunkLabelY(trunkY: number, targetCenterY: number): number {
  const desired = trunkY + (targetCenterY - trunkY) * LABEL_RATIO;
  const low = trunkY + LABEL_PAD;
  const high = targetCenterY - LABEL_PAD;
  if (low > high) return high;
  return Math.min(high, Math.max(low, desired));
}

function hasLabel(node: WorkingNode): boolean {
  return node.label !== null && node.label.trim().length > 0;
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

export function reportRoutePenetrations(
  routes: LayoutEdgeRoute[],
  trunks: LayoutBranchTrunk[],
  nodes: WorkingNode[],
  visible: Set<string>,
  positions: Record<string, LayoutPosition>,
  config: LayoutConfig,
  diagnostics: DiagnosticSink,
): void {
  const rects: { node: WorkingNode; position: LayoutPosition }[] = [];
  for (const node of nodes) {
    if (!visible.has(node.id)) continue;
    const position = positions[node.id];
    if (position === undefined) continue;
    rects.push({ node, position });
  }

  const hits = (points: LayoutPoint[], skip: Set<string>): boolean =>
    rects.some(
      (item) =>
        !skip.has(item.node.id) && segmentsCrossRect(points, item.position, config.cardWidth, item.node.height),
    );

  for (const route of routes) {
    if (hits(route.points, new Set([route.from, route.to]))) {
      diagnostics.add(
        'route-fallback',
        '路由在有限搜索内避让失败，仍保留直角绕行；请检查卡片间距',
        route.to,
      );
    }
  }
  // 干线只画一次，同样要避开端点之外的卡片。
  for (const trunk of trunks) {
    if (hits(trunk.points, new Set([trunk.from]))) {
      diagnostics.add(
        'route-fallback',
        '干线在有限搜索内避让失败，仍保留直角绕行；请检查卡片间距',
        trunk.from,
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
    maxY = Math.max(maxY, position.y + node.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
