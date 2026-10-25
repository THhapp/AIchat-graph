/** Block measurement and column/band placement. */
import type { LayoutSide } from './types.js';
import {
  NESTED_BAND_OFFSET,
  TRUNK_OFFSET,
  TRUNK_STEP,
  type DiagnosticSink,
  type LayoutConfig,
  type WorkingNode,
} from './internal.js';

export interface BlockNode {
  node: WorkingNode;
  x: number;
  y: number;
}

export interface Block {
  width: number;
  /** head 卡的实际高度；同带落位按它判断卡片占用。 */
  headHeight: number;
  /** 全块最低边界（head 为原点，向下为正）。 */
  bottom: number;
  /** head 上方需要预留的走廊高度，供父 block 判断落位。 */
  topExtent: number;
  /**
   * 本块 head 所在带的分组嵌套深度：0 表示这条带上只有父组一层，
   * 成员自己在带内再分支时再加一层。干线按它逐层抬高，同带上的组不共线。
   */
  bandDepth: number;
  nodes: BlockNode[];
}

export interface MeasureContext {
  nextByParent: Map<string, WorkingNode>;
  branchesByParent: Map<string, WorkingNode[]>;
  config: LayoutConfig;
  diagnostics: DiagnosticSink;
  memo: Map<string, Block>;
  visiting: Set<string>;
  /** 每个 branch 的实际落位方向（显式或自动），路由与界面提示复用。 */
  sides: Map<string, LayoutSide>;
  /** 并列分组深度：`${from}~${side}` -> 该组在带内的嵌套层数（父组为 0）。 */
  groupDepths: Map<string, number>;
  /** branch 节点在父 block 内落到的列（从 1 起，越靠近主脊越小）。 */
  columns: Map<string, number>;
  /**
   * 有入口带的分支节点：node id -> 入口侧（它背向自己方向的那一侧）。
   * 这一侧的子分支从卡片底边分出，与父节点连进来的中心行横线区分开。
   */
  entrySides: Map<string, LayoutSide>;
}

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
  /** 该块在这一列占用的纵向区间（含上方走廊），列宽只按与它相交的块计算。 */
  top: number;
  bottom: number;
}

/** 一段纵向占用，含该块自身在带上方的走廊预留与它在该列的宽度。 */
interface Occupancy {
  top: number;
  bottom: number;
  width: number;
}

/** 每侧向外编号的列：1 最靠近主脊。索引 0 留空。 */
interface Column {
  intervals: Occupancy[];
}

/** 走廊在干线之上再留的空隙。 */
const TRUNK_PAD = 6;
/** 走廊与相邻卡片之间保留的空隙。 */
const CORRIDOR_PAD = 8;
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

  // 两侧都有子分支时，出口侧首行成员与入口侧共用 head 下方那一条带（P10）。
  // 成因：入口侧不能占 head 自己那一行——父节点连进来的横线正好在 head 的中心行，
  // 同带的卡会被那条线穿过；而两侧各自占一条带，同级两个方向就差了一整行，读不出并列。
  // 因此两侧一起落在 head 下方那一条带上：入口带在前，出口侧首行成员并进去。
  const deferredRow0 =
    entrySide !== null && entryMembers.length > 0
      ? measured.filter((entry) => entry.side !== entrySide && entry.sourceIndex === 0)
      : [];
  const deferred = new Set<MeasuredEntry>(deferredRow0);
  const deferredSpan = laneSpanOf(deferredRow0);
  // 入口带存在时，入口侧的出线改从卡片底边分出（路由侧读这张表），
  // 与"进入父卡"的中心行横线分开，读者能区分两个方向。
  if (entrySide !== null && entryMembers.length > 0) context.entrySides.set(head.id, entrySide);

  const corridorAt: number[] = [];
  for (let row = 0; row < spine.length; row += 1) {
    let span = 0;
    for (const sideName of ['left', 'right'] as const) {
      if (sideName === entrySide) continue;
      const group = measured.filter(
        (entry) => entry.side === sideName && entry.sourceIndex === row && !deferred.has(entry),
      );
      if (group.length === 0) continue;
      span = Math.max(span, laneSpanOf(group));
    }
    corridorAt[row] = span;
  }
  // 兄弟 block 自己的 topExtent 是它内部再分支要的头部空间，行距必须一并容下。
  for (const entry of measured) {
    const bandRow = entry.side === entrySide || deferred.has(entry) ? 1 : entry.sourceIndex;
    if (bandRow < 0 || bandRow >= spine.length) continue;
    if (entry.side === entrySide && spine.length === 1) continue;
    corridorAt[bandRow] = Math.max(corridorAt[bandRow] ?? 0, entry.block.topExtent);
  }
  // 入口侧整侧是一条带且落在 rowY[1]：它的干线也要在 0→1 的行间距里有位置。
  const entrySpan = laneSpanOf(entryMembers);
  if (entrySide !== null && entryMembers.length > 0 && spine.length > 1) {
    corridorAt[1] = Math.max(corridorAt[1] ?? 0, entrySpan, deferredSpan);
  }

  // 5. 逐行推进：本行侧支簇占满父行的纵向区间，主线下一个节点排在整个簇之下。
  // 这样每条带的上方永远是空的，兄弟首卡始终与父节点同带，整组下移只剩兜底作用。
  // 分支块（某个分支自己的子分支）整条带再下移 NESTED_BAND_OFFSET：
  // 这是层级提示，不是新的带规则——同一块内兄弟仍然同带、互相不错开，
  // 只是让"子分支的并列带"和"父节点的兄弟带"在纵向拉开，不被读成同一层的第四个方向。
  const bandShift = head.flow === 'branch' ? NESTED_BAND_OFFSET : 0;
  const columns: Record<LayoutSide, Column[]> = { left: [createColumn()], right: [createColumn()] };
  const placements: Placement[] = [];
  /** 每次 placeGroup 的落位集合：同组兄弟共用一个纵向并集区间来算列宽，保证对齐。 */
  const groups: Placement[][] = [];
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
      const group = measured.filter(
        (entry) => entry.side === sideName && entry.sourceIndex === row && !deferred.has(entry),
      );
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
      groups.push(placed);
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
      groups.push(placed);
      // 出口侧首行成员与入口侧同带（P10）：两侧一起读作并列的同一行。
      if (deferredRow0.length > 0) {
        const deferredPlaced = placeGroup(
          columns[opposite(entrySide)],
          deferredRow0,
          bandY + bandShift,
          deferredSpan,
          context.config,
          head.id,
          context.diagnostics,
        );
        for (const placement of deferredPlaced) {
          placements.push(placement);
          bandBottom = Math.max(bandBottom, placement.y + placement.entry.block.bottom);
        }
        groups.push(deferredPlaced);
      }
    }
    clusterBottom[row] = Math.max(0, bandBottom - bandY);
  }
  const topExtent = corridorAt[0] ?? 0;
  // head 没有 next 时不新开 rowY[1] 幽灵行：入口带直接落在 head 下方。
  if (spine.length === 1 && entrySide !== null && entryMembers.length > 0) {
    const entryBandY =
      head.height + Math.max(verticalGap, entrySpan, deferredSpan) + bandShift;
    const placed = placeGroup(
      columns[entrySide],
      entryMembers,
      entryBandY,
      entrySpan,
      context.config,
      head.id,
      context.diagnostics,
    );
    placements.push(...placed);
    groups.push(placed);
    // 出口侧首行成员并进同一条带（P10），不再单独占 head 自己那一行。
    if (deferredRow0.length > 0) {
      const deferredPlaced = placeGroup(
        columns[opposite(entrySide)],
        deferredRow0,
        entryBandY,
        deferredSpan,
        context.config,
        head.id,
        context.diagnostics,
      );
      placements.push(...deferredPlaced);
      groups.push(deferredPlaced);
    }
  }

  // 记录每个分支在父块内落到的列，路由据此判断"最内一列"并决定是否简化。
  for (const placement of placements) context.columns.set(placement.entry.child.id, placement.column);

  // 6. 列宽按纵向区间取，不按整列取一个值。
  //    成因（P02）：原先每列只有一个宽度，取全列所有块的最大值，与行无关。
  //    给下方分支加一个子分支，只让下方那个块变宽，却把同一列里上方无关分组的下一列
  //    一起推出去——两者在纵向并不相交，本来不需要互相让路。
  //    现在每个落位只累加"与自己纵向区间相交的块"的列宽；同一带的兄弟共用一个并集
  //    区间，所以组内仍然对齐，只有不同行的列宽可以不同。
  const spanOfPlacement = new Map<Placement, { top: number; bottom: number }>();
  for (const group of groups) {
    const top = Math.min(...group.map((placement) => placement.top));
    const bottom = Math.max(...group.map((placement) => placement.bottom));
    for (const placement of group) spanOfPlacement.set(placement, { top, bottom });
  }
  const spanFor = (placement: Placement): { top: number; bottom: number } =>
    spanOfPlacement.get(placement) ?? { top: placement.top, bottom: placement.bottom };

  /** 列 1..column 合计占用的横向宽度（含每列之后的列间距）。 */
  const stripSpan = (side: LayoutSide, column: number, span: { top: number; bottom: number }): number => {
    let total = 0;
    for (let index = 1; index <= column; index += 1) {
      total += columnWidthIn(columns[side], index, span.top, span.bottom) + horizontalGap;
    }
    return total;
  };

  // 左侧从主脊向左编号，cardX 是主脊左边缘：块左边界要容下每一行各自需要的列宽。
  let leftWidth = 0;
  for (const placement of placements) {
    if (placement.entry.side !== 'left') continue;
    leftWidth = Math.max(leftWidth, stripSpan('left', placement.column, spanFor(placement)));
  }
  const cardX = leftWidth;

  // 左侧列的条带右边界（列 1 紧贴主脊），块在条带内右对齐；右侧列左对齐。
  const offsetOf = (placement: Placement): number => {
    const span = spanFor(placement);
    if (placement.entry.side === 'left') {
      return cardX - horizontalGap - stripSpan('left', placement.column - 1, span) - placement.entry.block.width;
    }
    return cardX + cardWidth + horizontalGap + stripSpan('right', placement.column - 1, span);
  };

  let width = cardX + cardWidth;
  for (const placement of placements) {
    if (placement.entry.side !== 'right') continue;
    const span = spanFor(placement);
    const stripLeft = cardX + cardWidth + horizontalGap + stripSpan('right', placement.column - 1, span);
    width = Math.max(width, stripLeft + columnWidthIn(columns.right, placement.column, span.top, span.bottom));
  }

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
    const offsetX = offsetOf(placement);
    for (const node of block.nodes) nodes.push({ node: node.node, x: offsetX + node.x, y: placement.y + node.y });
    bottom = Math.max(bottom, placement.y + block.bottom);
  }

  const block: Block = { width, headHeight: head.height, bottom, topExtent, bandDepth, nodes };
  context.memo.set(memoKey, block);
  context.visiting.delete(memoKey);
  return block;
}

function createColumn(): Column {
  return { intervals: [] };
}

/**
 * 某列在给定纵向区间内的宽度：取与之相交的块的宽度最大值。
 * 纵向不相交的块（不同行、互不重叠）不必互相让路，这是 P02 的关键。
 */
function columnWidthIn(columns: Column[], column: number, top: number, bottom: number): number {
  const state = columns[column];
  if (state === undefined) return 0;
  let width = 0;
  for (const interval of state.intervals) {
    if (interval.bottom <= top + EDGE_EPSILON || interval.top >= bottom - EDGE_EPSILON) continue;
    width = Math.max(width, interval.width);
  }
  return width;
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
    const top = y - above;
    const bottom = y + entry.block.bottom;
    state.intervals.push({ top, bottom, width: entry.block.width });
    placements.push({ entry, column: target, y, top, bottom });
  }
  return placements;
}
