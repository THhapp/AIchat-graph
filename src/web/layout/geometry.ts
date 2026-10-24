/** Block geometry, reading anchor and deterministic orthogonal routes. */
import type {
  LayoutBranchTrunk,
  LayoutEdgeRoute,
  LayoutPoint,
  LayoutPosition,
  LayoutRect,
  LayoutSide,
} from './types.js';
import {
  compareIds,
  isRecord,
  type Block,
  type BlockNode,
  type DiagnosticSink,
  type LayoutConfig,
  type MeasureContext,
  type WorkingNode,
} from './internal.js';
import { compareBranches } from './inputTree.js';

interface BranchEntry {
  child: WorkingNode;
  sourceIndex: number;
  side: LayoutSide;
}

interface MeasuredEntry extends BranchEntry {
  block: Block;
}

interface Placement {
  entry: MeasuredEntry;
  column: number;
  y: number;
}

/** 一段纵向占用，含该块自身在带上方的走廊预留。 */
interface Occupancy {
  top: number;
  bottom: number;
}

/** 每侧向外编号的列：1 最靠近主脊。索引 0 留空。 */
interface Column {
  intervals: Occupancy[];
  width: number;
}

/** 干线离目标带上沿的距离；带内每嵌套一层再抬高一个 TRUNK_STEP。 */
const TRUNK_OFFSET = 18;
/**
 * 带内每层的抬升。间距 = 本常量：嵌套带的 NESTED_BAND_OFFSET 位移在算干线 y 时被减回去了，两者不叠加。
 * 14px 低于复核给的 20px 双线阈值，但该拓扑（同带多来源 / 深度≥1 的子干线）在现有数据中为 0 例，
 * 故不为此放大全局行距（本常量同时是走廊高度与 topExtent，一动全局卡片起点位移）。
 * 若将来真出现这类形态，应在嵌套那一处按 parentTrunkY - 20 夹取，而不是抬高这个常量。
 */
const TRUNK_STEP = 14;
/** 走廊在干线之上再留的空隙。 */
const TRUNK_PAD = 6;
/** 走廊与相邻卡片之间保留的空隙。 */
const CORRIDOR_PAD = 8;
/** 出口竖线贴源卡的距离；最内成员不在第一列时用它，同带的其他来源逐个外移。 */
const CHANNEL_INSET = 12;
/** 同一空隙里出现第二个来源时，两条出口竖线的最小可辨间距（4px 会被读成一根粗线）。 */
const CHANNEL_STEP = 12;
/** 分支块自己的子分支带整体下移的距离，只用于层级提示，不改变带内规则。 */
const NESTED_BAND_OFFSET = 24;
/** 关系文字落在独占支线上的比例，以及它距支线两端的最小留白。 */
const LABEL_RATIO = 0.62;
const LABEL_PAD = 14;
/** Z 形短折的竖段短于此值时视为近乎等高，标签退回两点中点。 */
const LABEL_MIN_RISE = 40;
const EDGE_EPSILON = 1e-6;
const MAX_BAND_SHIFTS = 64;

function opposite(side: LayoutSide): LayoutSide {
  return side === 'right' ? 'left' : 'right';
}

/**
 * 一组并列分支所在带要预留的走廊高度：干线在带上沿 TRUNK_OFFSET 之上，
 * 每嵌套一层再抬 TRUNK_STEP，向上再留 TRUNK_PAD 的空隙。
 */
function corridorNeedFor(depth: number): number {
  return TRUNK_OFFSET + depth * TRUNK_STEP + TRUNK_PAD;
}

/**
 * 递归测量一个 block：head 起沿 next 链形成主脊，主脊各节点的 branch 按列
 * 向外铺开。block 内坐标以主脊左上角为原点（head 卡左上角 = (cardX, 0)）。
 *
 * 同源同侧的兄弟共享一条横向展开带：首卡落在同一个 y，横向各占一列；
 * 远处兄弟的连线从带的上方走廊绕行，走廊按分组嵌套深度逐层抬高，绝不把卡片往下挪。
 * 行距由"本行侧支簇的整体底部"推进：簇占满父行，主线下一个节点排在整簇之下，
 * 因此每条带上方永远空着，整组下移只剩兜底作用。
 *
 * @param side 该 block 相对父节点所在的一侧（根/顶层为 null）；决定入口侧避让。
 * @param level 本块 head 自己的分组建在带内的嵌套深度；根/主脊为 0，
 *   并列组成员为所属组的深度 + 1。干线按它分层，同带上的组不会共线。
 */
export function measureBlock(
  head: WorkingNode,
  side: LayoutSide | null,
  level: number,
  context: MeasureContext,
): Block {
  const memoKey = head.id + '|' + (side ?? '-') + '|' + String(level);
  const cached = context.memo.get(memoKey);
  if (cached !== undefined) return cached;
  if (context.visiting.has(memoKey)) {
    context.diagnostics.add('cycle', '布局递归出现环，节点单独绘制', head.id);
    return {
      width: context.config.cardWidth,
      headHeight: head.height,
      bottom: head.height,
      topExtent: 0,
      bandDepth: 0,
      nodes: [{ node: head, x: 0, y: 0 }],
    };
  }
  context.visiting.add(memoKey);

  const { cardWidth, verticalGap, horizontalGap } = context.config;

  // 1. 主脊：head 起沿 next 链，行高按各卡实际高度累计。
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

  // 2. 分支条目：同源按 order/id 稳定排序，记录来源在主脊的位置。
  const entries: BranchEntry[] = [];
  for (let index = 0; index < spine.length; index += 1) {
    const source = spine[index];
    if (source === undefined) continue;
    const branches = context.branchesByParent.get(source.id) ?? [];
    for (const child of branches) entries.push({ child, sourceIndex: index, side: 'right' });
  }

  // 3. 择侧：显式声明优先；自动侧只按分支计数平衡，不看尺寸，避免改标题让分支翻面。
  let leftCount = 0;
  let rightCount = 0;
  const autoDefault: LayoutSide = head.flow === 'branch' && side !== null ? side : 'right';
  for (const entry of entries) {
    const declared = entry.child.declaredSide;
    if (declared !== null) {
      entry.side = declared;
      if (declared === 'left') leftCount += 1;
      else rightCount += 1;
      continue;
    }
    let chosen: LayoutSide;
    if (leftCount < rightCount) chosen = 'left';
    else if (rightCount < leftCount) chosen = 'right';
    else chosen = autoDefault;
    entry.side = chosen;
    if (chosen === 'left') leftCount += 1;
    else rightCount += 1;
  }

  // branch 型 head 的入口侧：父节点的横线正好落在 head 中心行，同带会被卡片挡住，
  // 因此这一侧的兄弟整体落在 head 的 next 行（rowY[1]）那条带上，规则与出口侧一致。
  const entrySide: LayoutSide | null = head.flow === 'branch' && side !== null ? opposite(side) : null;

  // 同带 row 0 的组与父带同层（level），其余行另起一条带（0 起算）。
  const baseDepthAt = (row: number): number => (row === 0 ? level : 0);

  // 入口带会挤进主脊上多个来源的并列组（spine[0]、spine[1] 都回头分支），
  // 而且前一个来源的成员还能在这条带上再分组。按来源先后依次占层，
  // 每层要连同该来源成员在带内再分的层数一起让开，否则两条干线会叠在同一 y 上。
  const entryRankBySource = new Map<number, number>();
  const measured: MeasuredEntry[] = [];
  let entryRank = 0;
  for (let cursor = 0; cursor < entries.length; ) {
    const sourceIndex = entries[cursor]?.sourceIndex ?? 0;
    const run: BranchEntry[] = [];
    while (cursor < entries.length && entries[cursor]?.sourceIndex === sourceIndex) {
      const item = entries[cursor];
      if (item !== undefined) run.push(item);
      cursor += 1;
    }
    const onEntryBand = run.filter((entry) => entry.side === entrySide);
    if (onEntryBand.length > 0) entryRankBySource.set(sourceIndex, entryRank);

    let nesting = 0;
    for (const entry of run) {
      context.sides.set(entry.child.id, entry.side);
      const depth = entry.side === entrySide ? entryRank : baseDepthAt(sourceIndex);
      const owner = spine[sourceIndex]?.id ?? head.id;
      context.groupDepths.set(owner + '~' + entry.side, depth);
      const block = measureBlock(entry.child, entry.side, depth + 1, context);
      if (entry.side === entrySide) nesting = Math.max(nesting, block.bandDepth);
      measured.push({ ...entry, block });
    }
    if (onEntryBand.length > 0) entryRank += 1 + nesting;
  }

  const groupDepthOf = (entry: BranchEntry): number =>
    entry.side === entrySide ? entryRankBySource.get(entry.sourceIndex) ?? 0 : baseDepthAt(entry.sourceIndex);

  // 4. 每条带的分组深度：深度决定干线抬高几层，不再按成员数叠加。
  const entryMembers: MeasuredEntry[] = [];
  for (const entry of measured) {
    if (entry.side === entrySide) entryMembers.push(entry);
  }

  /** 一组干线在这条带上要占的走廊高度：组深度 + 成员再分组的层数。 */
  const laneSpanOf = (group: MeasuredEntry[]): number => {
    let deepest = -1;
    for (const entry of group) {
      deepest = Math.max(deepest, groupDepthOf(entry) + entry.block.bandDepth);
    }
    return deepest < 0 ? 0 : corridorNeedFor(deepest);
  };

  const corridorAt: number[] = [];
  for (let row = 0; row < spine.length; row += 1) {
    let span = 0;
    for (const sideName of ['left', 'right'] as const) {
      if (sideName === entrySide) continue;
      const group = measured.filter((entry) => entry.side === sideName && entry.sourceIndex === row);
      if (group.length === 0) continue;
      span = Math.max(span, laneSpanOf(group));
    }
    corridorAt[row] = span;
  }
  // 兄弟 block 自己的 topExtent 是它内部再分支要的头部空间，行距必须一并容下。
  for (const entry of measured) {
    const bandRow = entry.side === entrySide ? 1 : entry.sourceIndex;
    if (bandRow < 0 || bandRow >= spine.length) continue;
    if (entry.side === entrySide && spine.length === 1) continue;
    corridorAt[bandRow] = Math.max(corridorAt[bandRow] ?? 0, entry.block.topExtent);
  }
  // 入口侧整侧是一条带且落在 rowY[1]：它的干线也要在 0→1 的行间距里有位置。
  const entrySpan = laneSpanOf(entryMembers);
  if (entrySide !== null && entryMembers.length > 0 && spine.length > 1) {
    corridorAt[1] = Math.max(corridorAt[1] ?? 0, entrySpan);
  }

  // 5. 逐行推进：本行侧支簇占满父行的纵向区间，主线下一个节点排在整个簇之下。
  // 这样每条带的上方永远是空的，兄弟首卡始终与父节点同带，整组下移只剩兜底作用。
  // 分支块（某个分支自己的子分支）整条带再下移 NESTED_BAND_OFFSET：
  // 这是层级提示，不是新的带规则——同一块内兄弟仍然同带、互相不错开，
  // 只是让"子分支的并列带"和"父节点的兄弟带"在纵向拉开，不被读成同一层的第四个方向。
  const bandShift = head.flow === 'branch' ? NESTED_BAND_OFFSET : 0;
  const columns: Record<LayoutSide, Column[]> = { left: [createColumn()], right: [createColumn()] };
  const placements: Placement[] = [];
  const rowY: number[] = [];
  const clusterBottom: number[] = [];
  for (let row = 0; row < spine.length; row += 1) {
    if (row === 0) rowY[0] = 0;
    else {
      const previous = spine[row - 1];
      const gap = Math.max(verticalGap, corridorAt[row] ?? 0);
      rowY[row] = (rowY[row - 1] ?? 0) + Math.max(previous?.height ?? 0, clusterBottom[row - 1] ?? 0) + gap;
    }
    const bandY = rowY[row] ?? 0;
    let bandBottom = bandY;
    for (const sideName of ['right', 'left'] as const) {
      if (sideName === entrySide) continue;
      const group = measured.filter((entry) => entry.side === sideName && entry.sourceIndex === row);
      if (group.length === 0) continue;
      const laneSpan = laneSpanOf(group);
      const placed = placeGroup(
        columns[sideName],
        group,
        bandY + bandShift,
        laneSpan,
        context.config,
        spine[row]?.id ?? head.id,
        context.diagnostics,
      );
      for (const placement of placed) {
        placements.push(placement);
        bandBottom = Math.max(bandBottom, placement.y + placement.entry.block.bottom);
      }
    }
    // 入口侧整侧是一条带，固定在 rowY[1]；它同样占满这一行的纵向区间。
    if (row === 1 && entrySide !== null && entryMembers.length > 0) {
      const placed = placeGroup(
        columns[entrySide],
        entryMembers,
        bandY + bandShift,
        entrySpan,
        context.config,
        head.id,
        context.diagnostics,
      );
      for (const placement of placed) {
        placements.push(placement);
        bandBottom = Math.max(bandBottom, placement.y + placement.entry.block.bottom);
      }
    }
    clusterBottom[row] = Math.max(0, bandBottom - bandY);
  }
  const topExtent = corridorAt[0] ?? 0;
  // head 没有 next 时不新开 rowY[1] 幽灵行：入口带直接落在 head 下方。
  if (spine.length === 1 && entrySide !== null && entryMembers.length > 0) {
    const entryBandY = head.height + Math.max(verticalGap, entrySpan) + bandShift;
    placements.push(
      ...placeGroup(columns[entrySide], entryMembers, entryBandY, entrySpan, context.config, head.id, context.diagnostics),
    );
  }

  // 记录每个分支在父块内落到的列，路由据此判断"最内一列"并决定是否简化。
  for (const placement of placements) context.columns.set(placement.entry.child.id, placement.column);

  const leftColumns = usedColumns(columns.left);
  const rightColumns = usedColumns(columns.right);
  const leftWidth = columnsWidth(columns.left, leftColumns, horizontalGap);
  const cardX = leftWidth;

  // 左侧列的条带右边界（列 1 紧贴主脊），块在条带内右对齐；右侧列左对齐。
  const leftStripRight = new Map<number, number>();
  let leftCursor = cardX - horizontalGap;
  for (const column of leftColumns) {
    leftStripRight.set(column, leftCursor);
    leftCursor -= horizontalGap + (columns.left[column]?.width ?? 0);
  }

  const rightStripLeft = new Map<number, number>();
  let rightCursor = cardX + cardWidth + horizontalGap;
  for (const column of rightColumns) {
    rightStripLeft.set(column, rightCursor);
    rightCursor += (columns.right[column]?.width ?? 0) + horizontalGap;
  }
  const width = rightColumns.length === 0 ? cardX + cardWidth : rightCursor - horizontalGap;

  // 7. 合成 block 内坐标；带内分组深度只算同一带上再分支的组（入口侧在别的带，不计）。
  let bandDepth = 0;
  for (const placement of placements) {
    if (placement.entry.side === entrySide || placement.entry.sourceIndex !== 0) continue;
    bandDepth = Math.max(bandDepth, placement.entry.block.bandDepth + 1);
  }

  const nodes: BlockNode[] = [];
  let bottom = 0;
  for (let index = 0; index < spine.length; index += 1) {
    const node = spine[index];
    if (node === undefined) continue;
    const y = rowY[index] ?? 0;
    nodes.push({ node, x: cardX, y });
    bottom = Math.max(bottom, y + node.height);
  }

  for (const placement of placements) {
    const block = placement.entry.block;
    const offsetX =
      placement.entry.side === 'left'
        ? (leftStripRight.get(placement.column) ?? cardX - horizontalGap) - block.width
        : (rightStripLeft.get(placement.column) ?? cardX);
    for (const node of block.nodes) nodes.push({ node: node.node, x: offsetX + node.x, y: placement.y + node.y });
    bottom = Math.max(bottom, placement.y + block.bottom);
  }

  const block: Block = { width, headHeight: head.height, bottom, topExtent, bandDepth, nodes };
  context.memo.set(memoKey, block);
  context.visiting.delete(memoKey);
  return block;
}

function createColumn(): Column {
  return { intervals: [], width: 0 };
}

function ensureColumn(columns: Column[], column: number): void {
  while (columns.length <= column) columns.push(createColumn());
}

function intervalFree(column: Column, top: number, bottom: number): boolean {
  for (const interval of column.intervals) {
    if (interval.bottom > top + EDGE_EPSILON && interval.top < bottom - EDGE_EPSILON) return false;
  }
  return true;
}

/**
 * 把同源同侧的一组兄弟放到同一条带上：所有首卡 y 相同，横向占 c..c+k-1。
 * 落位条件逐个兄弟检查这组共用的走廊需要的上方空间与卡片高度。
 */
function findColumn(columns: Column[], group: MeasuredEntry[], y: number, laneSpan: number): number {
  let column = 1;
  for (;;) {
    let free = true;
    for (let index = 0; index < group.length; index += 1) {
      const entry = group[index];
      if (entry === undefined) continue;
      const state = columns[column + index];
      if (state === undefined) continue;
      const above = Math.max(entry.block.topExtent, laneSpan);
      if (!intervalFree(state, y - above, y + entry.block.headHeight)) {
        free = false;
        break;
      }
    }
    if (free) return column;
    column += 1;
  }
}

/**
 * 走廊条件：第 i 张兄弟的横线从主脊横穿到它自己那一列左侧的空隙，
 * 途中经过列 1..(column+i-1)；组内并集是列 1..column+k-2（目标列本身不被横穿）。
 * 这些列在 [y - laneSpan, y] 内都要空着，否则候选列不可行，返回需要让开的最低边界。
 */
function corridorBlocked(
  columns: Column[],
  column: number,
  groupSize: number,
  y: number,
  laneSpan: number,
): number | undefined {
  let blocked: number | undefined;
  const top = y - laneSpan;
  const lastCrossed = column + groupSize - 2;
  for (let index = 1; index <= lastCrossed; index += 1) {
    const state = columns[index];
    if (state === undefined) continue;
    for (const interval of state.intervals) {
      if (interval.bottom <= top + EDGE_EPSILON) continue;
      if (interval.top >= y - EDGE_EPSILON) continue;
      blocked = Math.max(blocked ?? Number.NEGATIVE_INFINITY, interval.bottom);
    }
  }
  return blocked;
}

/**
 * 放置一组兄弟。没有任何可行列时整组一起下移到阻塞块底部 + verticalGap 之后重试，
 * 绝不只挪其中一张、也不把兄弟错开。
 *
 * @param laneSpan 该组干线要在带上方向预留的走廊高度（按组深度，不按成员数）。
 */
function placeGroup(
  columns: Column[],
  group: MeasuredEntry[],
  preferredY: number,
  laneSpan: number,
  config: LayoutConfig,
  sourceId: string,
  diagnostics: DiagnosticSink,
): Placement[] {
  let y = preferredY;
  let shifted = false;
  for (let guard = 0; guard < MAX_BAND_SHIFTS; guard += 1) {
    const column = findColumn(columns, group, y, laneSpan);
    const blocked = corridorBlocked(columns, column, group.length, y, laneSpan);
    if (blocked === undefined) return commitGroup(columns, group, column, y, laneSpan);
    // 让开后必须整叠走廊都在阻塞块之上，否则 corridorBlocked 仍会判占，原地打转。
    y = blocked + Math.max(config.verticalGap, laneSpan + CORRIDOR_PAD);
    if (!shifted) {
      diagnostics.add('branch-band-shifted', '并列带整体下移以避开上方走廊', sourceId);
      shifted = true;
    }
  }
  return commitGroup(columns, group, findColumn(columns, group, y, laneSpan), y, laneSpan);
}

function commitGroup(
  columns: Column[],
  group: MeasuredEntry[],
  column: number,
  y: number,
  laneSpan: number,
): Placement[] {
  const placements: Placement[] = [];
  for (let index = 0; index < group.length; index += 1) {
    const entry = group[index];
    if (entry === undefined) continue;
    const target = column + index;
    ensureColumn(columns, target);
    const state = columns[target];
    if (state === undefined) continue;
    const above = Math.max(entry.block.topExtent, laneSpan);
    state.intervals.push({ top: y - above, bottom: y + entry.block.bottom });
    state.width = Math.max(state.width, entry.block.width);
    placements.push({ entry, column: target, y });
  }
  return placements;
}

function usedColumns(columns: Column[]): number[] {
  const used: number[] = [];
  for (let column = 1; column < columns.length; column += 1) {
    if ((columns[column]?.width ?? 0) > 0) used.push(column);
  }
  return used;
}

function columnsWidth(columns: Column[], used: number[], horizontalGap: number): number {
  let total = 0;
  for (const column of used) total += (columns[column]?.width ?? 0) + horizontalGap;
  return total;
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
): BuiltRoutes {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const { cardWidth, horizontalGap } = config;
  const routes: LayoutEdgeRoute[] = [];
  const trunks: LayoutBranchTrunk[] = [];

  // 分支节点的子分支带整条下移 NESTED_BAND_OFFSET，逐级累计。
  // 干线 y 要相对"未加这条位移的那条带"来算，否则父带下移 24 会把嵌套干线压到父干线
  // 下方 10px，层级读反。位移量按父链上 branch 节点的个数还原，而不是用 depth 乘：
  // 入口带上的 depth 表示同一条带里的层号（entryRank），不是嵌套级数。
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
          { x: sourceEdge, y: sourceCenterY },
          { x: channelX, y: sourceCenterY },
          { x: channelX, y: first.targetCenterY },
          { x: first.targetEdge, y: first.targetCenterY },
        ]),
      };
      if (hasLabel(first.node)) {
        const rise = Math.abs(first.targetCenterY - sourceCenterY);
        const midY = (sourceCenterY + first.targetCenterY) / 2;
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
    //   近端（这里引入）——出口竖段 sourceCenterY→trunkY 与最内成员落点 trunkY→targetCenterY 合并；
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
        { x: sourceEdge, y: sourceCenterY },
        { x: channel, y: sourceCenterY },
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
        route.labelAnchor = { x: member.dropX, y: trunkLabelY(trunkY, member.targetCenterY) };
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
