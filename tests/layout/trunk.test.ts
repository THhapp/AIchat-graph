import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  type LayoutBranchTrunk,
  type LayoutInput,
  type LayoutNodeInput,
  type LayoutResult,
} from '../../src/web/layout/index.js';

const W = 360;
const H = 152;
const VG = 64;
const HG = 88;
/** 干线离带顶的距离与带内每层的抬升，见 geometry.ts 的 TRUNK_OFFSET / TRUNK_STEP。 */
const TRUNK_OFFSET = 18;
const TRUNK_STEP = 14;
/** 分支块自己的子分支带整体下移的层级提示量，见 geometry.ts 的 NESTED_BAND_OFFSET。 */
const NESTED_BAND_OFFSET = 24;

function node(
  id: string,
  from: string | null,
  flow: 'root' | 'next' | 'branch',
  extra: Partial<LayoutNodeInput> = {},
): LayoutNodeInput {
  return { id, from, flow, ...extra };
}

interface Rect {
  id: string;
  x: number;
  y: number;
  right: number;
  bottom: number;
}

function rects(result: LayoutResult): Rect[] {
  return Object.entries(result.positions).map(([id, position]) => {
    const height = result.heights[id] ?? result.cardHeight;
    return {
      id,
      x: position.x,
      y: position.y,
      right: position.x + result.cardWidth,
      bottom: position.y + height,
    };
  });
}

function overlaps(result: LayoutResult): string[] {
  const list = rects(result);
  const found: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a === undefined || b === undefined) continue;
      const separated = a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y;
      if (!separated) found.push(a.id + '<->' + b.id);
    }
  }
  return found;
}

/** 一条折线是否穿过某张卡正文（边界接触不算）。 */
function crosses(points: { x: number; y: number }[], rect: Rect): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) continue;
    if (Math.abs(a.y - b.y) < 0.01) {
      if (a.y <= rect.y || a.y >= rect.bottom) continue;
      if (Math.min(Math.max(a.x, b.x), rect.right) > Math.max(Math.min(a.x, b.x), rect.x)) return true;
    } else if (Math.abs(a.x - b.x) < 0.01) {
      if (a.x <= rect.x || a.x >= rect.right) continue;
      if (Math.min(Math.max(a.y, b.y), rect.bottom) > Math.max(Math.min(a.y, b.y), rect.y)) return true;
    }
  }
  return false;
}

/** 边与干线一并检查：共享段只画一次，但同样不能穿卡。 */
function penetrated(result: LayoutResult): string[] {
  const bad: string[] = [];
  const list = rects(result);
  for (const route of result.edgeRoutes) {
    for (const rect of list) {
      if (rect.id === route.from || rect.id === route.to) continue;
      if (crosses(route.points, rect)) bad.push(route.id + ' x ' + rect.id);
    }
  }
  for (const trunk of result.branchTrunks) {
    for (const rect of list) {
      if (rect.id === trunk.from) continue;
      if (crosses(trunk.points, rect)) bad.push(trunk.id + ' x ' + rect.id);
    }
  }
  return bad;
}

/** 折线里所有线段都必须是纯水平或纯垂直（两点斜线也算违规）。 */
function diagonals(result: LayoutResult): string[] {
  const bad: string[] = [];
  const scan = (id: string, points: { x: number; y: number }[]): void => {
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1];
      const b = points[index];
      if (a === undefined || b === undefined) continue;
      if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) bad.push(id);
    }
  };
  for (const route of result.edgeRoutes) scan(route.id, route.points);
  for (const trunk of result.branchTrunks) scan(trunk.id, trunk.points);
  return bad;
}

function insideAnyCard(result: LayoutResult, point: { x: number; y: number }): string[] {
  return rects(result)
    .filter((rect) => point.x > rect.x && point.x < rect.right && point.y > rect.y && point.y < rect.bottom)
    .map((rect) => rect.id);
}

function pos(result: LayoutResult, id: string) {
  const found = result.positions[id];
  if (found === undefined) throw new Error('missing position ' + id);
  return found;
}

function route(result: LayoutResult, id: string) {
  const found = result.edgeRoutes.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error('missing route ' + id);
  return found;
}

function trunkOf(result: LayoutResult, from: string, side: 'left' | 'right'): LayoutBranchTrunk {
  const id = from + '~' + side;
  const found = result.branchTrunks.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error('missing trunk ' + id);
  return found;
}

/** 三兄弟：同父同侧，同带三列。 */
const threeSiblings: LayoutNodeInput[] = [
  node('r', null, 'root'),
  node('r2', 'r', 'next'),
  node('b1', 'r', 'branch', { side: 'right', order: 10 }),
  node('b2', 'r', 'branch', { side: 'right', order: 20 }),
  node('b3', 'r', 'branch', { side: 'right', order: 30 }),
];

describe('branch trunk', () => {
  it('draws one shared trunk for three same-side siblings and joins every branch on it', () => {
    const result = computeLayout({ nodes: threeSiblings });
    const r = pos(result, 'r');
    const right = r.x + W;

    // 一组一条干线：不是每人一条完整路径。
    expect(result.branchTrunks).toHaveLength(1);
    const trunk = trunkOf(result, 'r', 'right');
    expect(trunk.from).toBe('r');
    expect(trunk.side).toBe('right');
    expect(trunk.trunkY).toBe(r.y - TRUNK_OFFSET);

    // 出口横段 → 上升竖段 → 横向干线，止于最远接出点。
    // 上升竖段与最内成员（b1）的落点竖段合成一条线：同一空隙里只有一条竖线。
    expect(trunk.points).toHaveLength(4);
    expect(trunk.points[0]).toEqual({ x: right, y: r.y + H / 2 });
    expect(trunk.points[1]).toEqual({ x: right + HG / 2, y: r.y + H / 2 });
    expect(trunk.points[2]).toEqual({ x: right + HG / 2, y: trunk.trunkY });

    const members = ['b1', 'b2', 'b3'].map((id) => route(result, 'r->' + id));
    const drops = ['b1', 'b2', 'b3'].map((id) => pos(result, id).x - HG / 2);
    expect(trunk.points[3]).toEqual({ x: drops[2], y: trunk.trunkY });
    expect(drops[2]).toBeGreaterThan(drops[0] ?? 0);
    // 最远成员按落点列取，就是干线末点接的那一支。
    expect(trunk.to).toBe('b3');
    expect(diagonals(result)).toEqual([]);

    // 出口竖段 = 最内成员的落点竖段：干线竖线与最内接出点共线。
    expect(trunk.points[1]?.x).toBe(drops[0]);
    expect(members[0]?.join?.x).toBe(trunk.points[1]?.x);

    const joins = members.map((edge) => edge.join);
    for (const [index, edge] of members.entries()) {
      const join = edge.join;
      expect(join).toBeDefined();
      if (join === undefined) continue;
      // 接出点落在干线末段的 y 上，x 各不相同。
      expect(join.y).toBe(trunk.trunkY);
      expect(join.x).toBe(drops[index]);
      // 每条分支只保留自己从接出点下到目标卡的独占段，共享段不重复描画。
      expect(edge.points[0]).toEqual(join);
      expect(edge.points.length).toBeLessThanOrEqual(3);
      expect(edge.points[edge.points.length - 1]).toEqual({
        x: pos(result, edge.to).x,
        y: pos(result, edge.to).y + H / 2,
      });
    }
    expect(new Set(joins.map((join) => join?.x)).size).toBe(3);

    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps a single branch in the nearest column as one straight segment', () => {
    const result = computeLayout({
      nodes: [node('r', null, 'root'), node('b1', 'r', 'branch', { side: 'right', order: 10 })],
    });
    const r = pos(result, 'r');
    const b1 = pos(result, 'b1');

    expect(result.branchTrunks).toEqual([]);
    const edge = route(result, 'r->b1');
    expect(edge.join).toBeUndefined();
    expect(edge.points).toEqual([
      { x: r.x + W, y: r.y + H / 2 },
      { x: b1.x, y: b1.y + H / 2 },
    ]);
    expect(penetrated(result)).toEqual([]);
  });

  it('keeps a trunk only for the lone branch pushed out to the second column', () => {
    // br 与它的 next bn 都把分支指回入口带：bl 在列 1，bl2 被挤到列 2。
    const result = computeLayout({
      nodes: [
        node('r', null, 'root'),
        node('br', 'r', 'branch', { side: 'right', order: 10 }),
        node('bn', 'br', 'next'),
        node('bl', 'br', 'branch', { side: 'left', order: 10 }),
        node('bl2', 'bn', 'branch', { side: 'left', order: 10 }),
      ],
    });
    const br = pos(result, 'br');
    const bn = pos(result, 'bn');
    const bl = pos(result, 'bl');
    const bl2 = pos(result, 'bl2');
    expect(bl.x).toBeGreaterThan(bl2.x);
    // br 是分支节点：它自己的子分支带整体下移 24，bn 行的入口带同样带这个偏移。
    expect(bl.y).toBe(br.y + H + VG + 24);
    expect(bl2.y).toBe(bn.y + 24);

    // 列 1 的单张不需要绕到带上方：只有列 2 那一张还要一条干线。
    expect(result.branchTrunks.map((trunk) => trunk.id)).toEqual(['bn~left']);
    const outer = trunkOf(result, 'bn', 'left');
    expect(outer.from).toBe('bn');
    expect(outer.to).toBe('bl2');
    expect(outer.points[0]).toEqual({ x: bn.x, y: bn.y + H / 2 });
    // 干线止于唯一成员的接出点，支线从这一点下到目标中心。
    expect(outer.points[outer.points.length - 1]).toEqual({ x: bl2.x + W + HG / 2, y: outer.trunkY });
    const edge = route(result, 'bn->bl2');
    expect(edge.join).toEqual(outer.points[outer.points.length - 1]);
    expect(edge.points[0]).toEqual(edge.join);

    // 列 1 的单张走 Z 形短折：出口横段 → 空隙正中的竖向通道 → 入卡横段，不产干线、不带 join。
    const inner = route(result, 'br->bl');
    expect(inner.join).toBeUndefined();
    expect(inner.points).toEqual([
      { x: br.x, y: br.y + H / 2 },
      { x: br.x - HG / 2, y: br.y + H / 2 },
      { x: br.x - HG / 2, y: bl.y + H / 2 },
      { x: bl.x + W, y: bl.y + H / 2 },
    ]);
    // 两个来源同在一列：干线共用出口按 rank 外移 12（最小可辨间距），单支走空隙中点，两者不共线。
    expect(outer.points[1]?.x).toBe(br.x - 24);
    // 偏移后仍在空隙内（不越过源卡、也不越过最内落点），所以横段仍能盖住接出点。
    expect(outer.points[1]?.x).toBeLessThan(br.x);
    expect(outer.points[1]?.x).toBeGreaterThan(bl.x + W);
    expect(inner.points[1]?.x).not.toBe(outer.points[1]?.x);
    expect(diagonals(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });

  it('keeps every trunk its own distance above its own band, so nested groups never share a lane', () => {
    const result = computeLayout({
      nodes: [
        node('r', null, 'root'),
        node('b1', 'r', 'branch', { side: 'right', order: 10 }),
        node('b2', 'r', 'branch', { side: 'right', order: 20 }),
        node('b2x', 'b2', 'branch', { side: 'right', order: 10 }),
        node('b2y', 'b2', 'branch', { side: 'right', order: 20 }),
      ],
    });
    const b2 = pos(result, 'b2');
    const parent = trunkOf(result, 'r', 'right');
    const nested = trunkOf(result, 'b2', 'right');

    // 子分支带整体下移 24，干线要相对"未下移的那条带"来算：补偿掉这段位移后，
    // 嵌套干线落在父干线之上一个 TRUNK_STEP，层级方向与卡片的下移方向一致。
    expect(pos(result, 'b2x').y).toBe(b2.y + NESTED_BAND_OFFSET);
    expect(parent.trunkY).toBe(b2.y - TRUNK_OFFSET);
    expect(nested.trunkY).toBe(b2.y + NESTED_BAND_OFFSET - TRUNK_OFFSET - TRUNK_STEP - NESTED_BAND_OFFSET);
    expect(pos(result, 'b2x').y - nested.trunkY).toBe(TRUNK_OFFSET + TRUNK_STEP + NESTED_BAND_OFFSET);
    // 两条干线仍在不同 y 上，不会共线叠画；嵌套组那条更高，且仍在自己带的上方。
    expect(nested.trunkY).not.toBe(parent.trunkY);
    expect(nested.trunkY).toBeLessThan(parent.trunkY);
    expect(nested.trunkY).toBeLessThan(pos(result, 'b2').y + NESTED_BAND_OFFSET);
    expect(route(result, 'b2->b2x').join?.y).toBe(nested.trunkY);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });

  it('puts a nested group trunk above its parent trunk, strictly inside its own columns', () => {
    // 父节点两个并列分支，其中一个分支自己有两个子分支：嵌套组 k=2，会产生嵌套干线。
    const result = computeLayout({
      nodes: [
        node('r', null, 'root'),
        node('b1', 'r', 'branch', { side: 'right', order: 10 }),
        node('b2', 'r', 'branch', { side: 'right', order: 20 }),
        node('b2x', 'b2', 'branch', { side: 'right', order: 10 }),
        node('b2y', 'b2', 'branch', { side: 'right', order: 20 }),
      ],
    });
    const b1 = pos(result, 'b1');
    const b2 = pos(result, 'b2');
    const parent = trunkOf(result, 'r', 'right');
    const nested = trunkOf(result, 'b2', 'right');

    // 两条干线都在，各自接自己那一组的最远成员。
    expect(result.branchTrunks.map((trunk) => trunk.id).sort()).toEqual(['b2~right', 'r~right']);
    expect(parent.to).toBe('b2');
    expect(nested.to).toBe('b2y');

    // 嵌套干线在父干线之上（y 更小），正好高一层 TRUNK_STEP：层级方向与卡片的下移方向一致。
    expect(nested.trunkY).toBeLessThan(parent.trunkY);
    expect(parent.trunkY - nested.trunkY).toBe(TRUNK_STEP);

    // 嵌套干线的横段只走自己的列区间：从父卡（b2）右边缘之外出发，
    // 止于最外子分支的落点，不回头越过父带的其它卡（b1 在更内侧）。
    const dropOf = (id: string): number => pos(result, id).x - HG / 2;
    const flat = nested.points.filter((point) => Math.abs(point.y - nested.trunkY) < 0.01).map((point) => point.x);
    expect(flat.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...flat)).toBeGreaterThan(b2.x + W);
    expect(Math.min(...flat)).toBeGreaterThan(b1.x + W);
    expect(Math.max(...flat)).toBe(dropOf('b2y'));
    expect(Math.max(...flat)).toBeGreaterThan(dropOf('b2x'));
    // 两级垂直段都从父组干线所在的带上方经过：两条干线不共线、不与卡片相撞。
    expect(nested.trunkY).toBeLessThan(b2.y);
    expect(diagonals(result)).toEqual([]);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('separates two sources that share the entry band into their own lanes', () => {
    // 同一入口带上挤进了 br 与它的 next bn 各自的回头分支：两条干线不能落在同一 y 上叠画。
    const result = computeLayout({
      nodes: [
        node('r', null, 'root'),
        node('br', 'r', 'branch', { side: 'right', order: 10 }),
        node('bn', 'br', 'next'),
        node('bl1', 'br', 'branch', { side: 'left', order: 10 }),
        node('bl2', 'br', 'branch', { side: 'left', order: 20 }),
        node('bn1', 'bn', 'branch', { side: 'left', order: 10 }),
        node('bn2', 'bn', 'branch', { side: 'left', order: 20 }),
      ],
    });
    const inner = trunkOf(result, 'br', 'left');
    const outer = trunkOf(result, 'bn', 'left');
    // br 是分支节点，它的整条入口带也下移了 24；干线按未下移的带计算，所以这 24 又被补回去。
    // 同一条带里的两个来源只差一层 TRUNK_STEP——depth 在这里是带内层号，不是嵌套级数。
    expect(inner.trunkY).toBe(pos(result, 'bl1').y - TRUNK_OFFSET - NESTED_BAND_OFFSET);
    expect(outer.trunkY).toBe(inner.trunkY - TRUNK_STEP);
    // 两个来源同在一列：出口竖段也要错开。
    expect(outer.points[1]?.x).not.toBe(inner.points[1]?.x);
    // 每条干线只接自己的成员：接出点落回自己那条干线的 y。
    expect(route(result, 'br->bl1').join?.y).toBe(inner.trunkY);
    expect(route(result, 'br->bl2').join?.y).toBe(inner.trunkY);
    expect(route(result, 'bn->bn1').join?.y).toBe(outer.trunkY);
    expect(route(result, 'bn->bn2').join?.y).toBe(outer.trunkY);
    // 每条接出点都落在自己干线的横段范围内。
    for (const [trunk, ids] of [
      [inner, ['br->bl1', 'br->bl2']],
      [outer, ['bn->bn1', 'bn->bn2']],
    ] as const) {
      const xs = trunk.points.filter((point) => Math.abs(point.y - trunk.trunkY) < 0.01).map((point) => point.x);
      for (const id of ids) {
        const join = route(result, id).join;
        expect(join?.x).toBeGreaterThanOrEqual(Math.min(...xs));
        expect(join?.x).toBeLessThanOrEqual(Math.max(...xs));
      }
    }
    expect(penetrated(result)).toEqual([]);
    expect(overlaps(result)).toEqual([]);
  });

  it('never merges groups from different parents', () => {
    const result = computeLayout({
      nodes: [
        node('r', null, 'root'),
        node('r2', 'r', 'next'),
        node('b1', 'r', 'branch', { side: 'right', order: 10 }),
        node('b2', 'r', 'branch', { side: 'right', order: 20 }),
        node('c1', 'r2', 'branch', { side: 'right', order: 10 }),
        node('c2', 'r2', 'branch', { side: 'right', order: 20 }),
      ],
    });
    expect(result.branchTrunks.map((trunk) => trunk.id).sort()).toEqual(['r2~right', 'r~right']);
    expect(route(result, 'r->b1').join?.y).toBe(trunkOf(result, 'r', 'right').trunkY);
    expect(route(result, 'r2->c1').join?.y).toBe(trunkOf(result, 'r2', 'right').trunkY);
    expect(penetrated(result)).toEqual([]);
  });

  it('keeps a lone branch orthogonal with a Z-shape when the two cards do not share a center line', () => {
    // 目标卡更高：中心不同高，两点直连会是一条斜线，必须走一次 Z 形短折。
    const result = computeLayout({
      nodes: [
        node('r', null, 'root', { height: 152 }),
        node('b1', 'r', 'branch', { side: 'right', order: 10, height: 232 }),
      ],
    });
    const r = pos(result, 'r');
    const b1 = pos(result, 'b1');
    // 最内一列只隔一格空隙：不需要一条绕到带上方的干线。
    expect(result.branchTrunks).toEqual([]);
    const edge = route(result, 'r->b1');
    expect(edge.join).toBeUndefined();
    expect(edge.points).toEqual([
      { x: r.x + W, y: r.y + 152 / 2 },
      { x: r.x + W + HG / 2, y: r.y + 152 / 2 },
      { x: r.x + W + HG / 2, y: b1.y + 232 / 2 },
      { x: b1.x, y: b1.y + 232 / 2 },
    ]);
    // 全图没有斜线；竖向通道走在空隙正中，不贴源卡当第二条边框。
    expect(diagonals(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(edge.points[1]?.x).toBe(r.x + W + HG / 2);
    expect(edge.points[1]?.x).toBeLessThan(b1.x);
  });

  it('keeps labels off the shared trunk and out of every card', () => {
    const nodes = threeSiblings.map((item) =>
      item.flow === 'branch' ? { ...item, label: '分支说明 ' + item.id } : item,
    );
    const result = computeLayout({ nodes });
    const trunk = trunkOf(result, 'r', 'right');
    const labelled = result.edgeRoutes.filter((edge) => edge.flow === 'branch');
    expect(labelled).toHaveLength(3);

    for (const edge of labelled) {
      const anchor = edge.labelAnchor;
      if (anchor === undefined) throw new Error('missing label anchor ' + edge.id);
      const join = edge.join;
      if (join === undefined) throw new Error('missing join ' + edge.id);
      const target = pos(result, edge.to);
      // 落在自己的独占支线上，不在公共干线、也不在任何卡里。
      expect(anchor.x).toBe(join.x);
      expect(anchor.y).not.toBe(trunk.trunkY);
      expect(anchor.y).toBeGreaterThan(trunk.trunkY + 14);
      expect(anchor.y).toBeLessThan(target.y + H / 2 - 14);
      expect(insideAnyCard(result, anchor)).toEqual([]);
      expect(edge.labelWidth).toBe(Math.max(40, HG - 16));
    }
  });

  it('shrinks the trunk with the visible members and degenerates when only the nearest is left', () => {
    const two = computeLayout({ nodes: threeSiblings, visibleNodeIds: ['r', 'r2', 'b1', 'b2'] });
    const one = computeLayout({ nodes: threeSiblings, visibleNodeIds: ['r', 'r2', 'b1'] });

    expect(two.branchTrunks).toHaveLength(1);
    expect(two.branchTrunks[0]?.points[3]?.x).toBe(pos(two, 'b2').x - HG / 2);
    expect(two.edgeRoutes.filter((edge) => edge.flow === 'branch')).toHaveLength(2);

    expect(one.branchTrunks).toEqual([]);
    const edge = route(one, 'r->b1');
    expect(edge.join).toBeUndefined();
    expect(edge.points).toHaveLength(2);
  });

  it('is order independent for trunks and joins', () => {
    const forward = computeLayout({ nodes: threeSiblings });
    const reversed = computeLayout({ nodes: [...threeSiblings].reverse() });
    expect(reversed.branchTrunks).toEqual(forward.branchTrunks);
    expect(reversed.edgeRoutes.map((edge) => [edge.id, edge.points, edge.join])).toEqual(
      forward.edgeRoutes.map((edge) => [edge.id, edge.points, edge.join]),
    );
  });

  it('mirrors the same geometry on the left side', () => {
    const input: LayoutInput = {
      nodes: [
        node('r', null, 'root'),
        node('l1', 'r', 'branch', { side: 'left', order: 10 }),
        node('l2', 'r', 'branch', { side: 'left', order: 20 }),
      ],
    };
    const result = computeLayout(input);
    const r = pos(result, 'r');
    const l1 = pos(result, 'l1');
    const trunk = trunkOf(result, 'r', 'left');
    // 出口竖段与最内成员（l1）的落点竖段合成一条线，镜像右侧。
    const innerDrop = l1.x + W + HG / 2;
    expect(trunk.points[0]).toEqual({ x: r.x, y: r.y + H / 2 });
    expect(trunk.points[1]).toEqual({ x: innerDrop, y: r.y + H / 2 });
    expect(trunk.points[2]).toEqual({ x: innerDrop, y: trunk.trunkY });
    expect(route(result, 'r->l1').join?.x).toBe(innerDrop);
    expect(trunk.trunkY).toBe(r.y - TRUNK_OFFSET);
    // 左侧最远接出点在最左一列的空隙中心。
    expect(trunk.points[3]?.x).toBe(pos(result, 'l2').x + W + HG / 2);
    expect(trunk.points[3]?.x).toBeLessThan(trunk.points[1]?.x ?? 0);
    expect(penetrated(result)).toEqual([]);
  });
});
