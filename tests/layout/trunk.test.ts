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

/** 两条正交折线中被重复描画的共线正长度段。 */
function sharedSegments(a: { x: number; y: number }[], b: { x: number; y: number }[]): string[] {
  const segments = (points: { x: number; y: number }[]) => {
    const list: { left: number; right: number; top: number; bottom: number }[] = [];
    for (let index = 1; index < points.length; index += 1) {
      const p = points[index - 1];
      const q = points[index];
      if (p === undefined || q === undefined) continue;
      list.push({
        left: Math.min(p.x, q.x),
        right: Math.max(p.x, q.x),
        top: Math.min(p.y, q.y),
        bottom: Math.max(p.y, q.y),
      });
    }
    return list;
  };
  const found: string[] = [];
  for (const one of segments(a)) {
    for (const other of segments(b)) {
      const bothHorizontal = one.bottom - one.top < 0.01 && other.bottom - other.top < 0.01;
      const bothVertical = one.right - one.left < 0.01 && other.right - other.left < 0.01;
      if (bothHorizontal && Math.abs(one.top - other.top) < 0.01) {
        if (Math.min(one.right, other.right) - Math.max(one.left, other.left) > 0.01) found.push('horizontal');
      } else if (bothVertical && Math.abs(one.left - other.left) < 0.01) {
        if (Math.min(one.bottom, other.bottom) - Math.max(one.top, other.top) > 0.01) found.push('vertical');
      }
    }
  }
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

describe('entry-side exit port', () => {
  it('leaves from the second side port on both sides instead of the card bottom', () => {
    const result = computeLayout({
      nodes: [
        node('r', null, 'root'),
        node('pR', 'r', 'branch', { side: 'right', order: 10 }),
        node('cR', 'pR', 'branch', { side: 'left', order: 10 }),
        node('pL', 'r', 'branch', { side: 'left', order: 20 }),
        node('cL', 'pL', 'branch', { side: 'right', order: 10 }),
      ],
    });
    const pR = pos(result, 'pR');
    const pL = pos(result, 'pL');
    const port = H / 2 + 18;

    // 入口侧的出口与父节点连进来的中心行横线分开，但仍落在同一侧边上；
    // 起点就是路径首点，不退到底边或底角。
    const rightOut = route(result, 'pR->cR');
    expect(rightOut.points[0]).toEqual({ x: pR.x, y: pR.y + port });
    expect(rightOut.points[0]?.y).not.toBe(pR.y + H);
    expect(rightOut.points[0]?.y).not.toBe(pR.y + H / 2);

    // 左侧镜像使用右侧边的第二个端口。
    const leftOut = route(result, 'pL->cL');
    expect(leftOut.points[0]).toEqual({ x: pL.x + W, y: pL.y + port });

    // 进入父卡的入线仍接目标侧边中心，两个方向不共线。
    const intoRight = route(result, 'r->pR');
    const intoLeft = route(result, 'r->pL');
    expect(intoRight.points[intoRight.points.length - 1]).toEqual({ x: pR.x, y: pR.y + H / 2 });
    expect(intoLeft.points[intoLeft.points.length - 1]).toEqual({ x: pL.x + W, y: pL.y + H / 2 });
    expect(rightOut.points[0]).not.toEqual(intoRight.points[intoRight.points.length - 1]);
    expect(leftOut.points[0]).not.toEqual(intoLeft.points[intoLeft.points.length - 1]);

    // 源关系没有被改写。
    expect(rightOut.from).toBe('pR');
    expect(rightOut.to).toBe('cR');
    expect(leftOut.from).toBe('pL');
    expect(leftOut.to).toBe('cL');
    expect(penetrated(result)).toEqual([]);
  });

  it('starts a shared entry-side trunk at the same second port as a lone branch', () => {
    const result = computeLayout({
      nodes: [
        node('r', null, 'root'),
        node('pR', 'r', 'branch', { side: 'right', order: 10 }),
        node('c1', 'pR', 'branch', { side: 'left', order: 10 }),
        node('c2', 'pR', 'branch', { side: 'left', order: 20 }),
        node('pL', 'r', 'branch', { side: 'left', order: 20 }),
        node('c3', 'pL', 'branch', { side: 'right', order: 10 }),
        node('c4', 'pL', 'branch', { side: 'right', order: 20 }),
      ],
    });
    const pR = pos(result, 'pR');
    const pL = pos(result, 'pL');
    const port = H / 2 + 18;
    const rightTrunk = trunkOf(result, 'pR', 'left');
    const leftTrunk = trunkOf(result, 'pL', 'right');

    // 干线首点就是实际路径首点（起点圆点挂在这里），仍在卡片侧边上。
    expect(rightTrunk.points[0]).toEqual({ x: pR.x, y: pR.y + port });
    expect(leftTrunk.points[0]).toEqual({ x: pL.x + W, y: pL.y + port });
    // 两条入口干线各自从第二个端口分出，不落到卡片底边。
    expect(rightTrunk.points[0]?.y).not.toBe(pR.y + H);
    expect(leftTrunk.points[0]?.y).not.toBe(pL.y + H);
    // 干线共享段与进入卡片的线不重合。
    expect(sharedSegments(route(result, 'r->pR').points, rightTrunk.points)).toEqual([]);
    expect(sharedSegments(route(result, 'r->pL').points, leftTrunk.points)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(overlaps(result)).toEqual([]);
  });
});

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
    // 入口侧的子分支改从同侧边第二个端口分出（见下），但 bn 是 next 节点：
    // 连进来的线是自上而下的竖线，中心行横线不会与出口重合，所以它的干线仍从中心行横出。
    expect(outer.points[0]).toEqual({ x: bn.x, y: bn.y + H / 2 });
    // 干线止于唯一成员的接出点，支线从这一点下到目标中心。
    expect(outer.points[outer.points.length - 1]).toEqual({ x: bl2.x + W + HG / 2, y: outer.trunkY });
    const edge = route(result, 'bn->bl2');
    expect(edge.join).toEqual(outer.points[outer.points.length - 1]);
    expect(edge.points[0]).toEqual(edge.join);

    // 列 1 的单张走 Z 形短折：出口横段 → 空隙正中的竖向通道 → 入卡横段，不产干线、不带 join。
    // 入口侧（左边）的出口横段从同侧边中心下方固定偏移的第二个端口分出，左右镜像。
    const inner = route(result, 'br->bl');
    expect(inner.join).toBeUndefined();
    expect(inner.points).toEqual([
      { x: br.x, y: br.y + H / 2 + 18 },
      { x: br.x - HG / 2, y: br.y + H / 2 + 18 },
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
    const b2x = pos(result, 'b2x');
    const parent = trunkOf(result, 'r', 'right');
    const nested = trunkOf(result, 'b2', 'right');

    // 分支 head 的直接子项统一落在 head 下方那条带（b2 没有 next，带在卡下 + 行距），
    // 子分支带整体再下移 24；干线相对未下移的带计算，所以嵌套干线仍在自己带的上方。
    expect(b2x.y).toBe(b2.y + H + VG + NESTED_BAND_OFFSET);
    expect(parent.trunkY).toBe(b2.y - TRUNK_OFFSET);
    expect(nested.trunkY).toBe(b2x.y - TRUNK_OFFSET - NESTED_BAND_OFFSET);
    expect(b2x.y - nested.trunkY).toBe(TRUNK_OFFSET + NESTED_BAND_OFFSET);
    // 两条干线仍在不同 y 上，不会共线叠画；子分支在父卡下方，它的干线也在父带之下。
    expect(nested.trunkY).not.toBe(parent.trunkY);
    expect(nested.trunkY).toBeGreaterThan(parent.trunkY);
    expect(nested.trunkY).toBeLessThan(b2x.y);
    expect(route(result, 'b2->b2x').join?.y).toBe(nested.trunkY);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });

  it('puts a nested group trunk below the parent band, strictly inside its own columns', () => {
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
    const b2x = pos(result, 'b2x');
    const parent = trunkOf(result, 'r', 'right');
    const nested = trunkOf(result, 'b2', 'right');

    // 两条干线都在，各自接自己那一组的最远成员。
    expect(result.branchTrunks.map((trunk) => trunk.id).sort()).toEqual(['b2~right', 'r~right']);
    expect(parent.to).toBe('b2');
    expect(nested.to).toBe('b2y');

    // 子分支带在父卡下方，嵌套干线也跟着落在父带之下；两者不会被读成同一条线。
    expect(nested.trunkY).toBeGreaterThan(parent.trunkY);
    expect(nested.trunkY - parent.trunkY).toBe(H + VG);

    // 嵌套干线的横段只走自己的列区间：从父卡（b2）右边缘之外出发，
    // 止于最外子分支的落点，不回头越过父带的其它卡（b1 在更内侧）。
    const dropOf = (id: string): number => pos(result, id).x - HG / 2;
    const flat = nested.points.filter((point) => Math.abs(point.y - nested.trunkY) < 0.01).map((point) => point.x);
    expect(flat.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...flat)).toBeGreaterThan(b2.x + W);
    expect(Math.min(...flat)).toBeGreaterThan(b1.x + W);
    expect(Math.max(...flat)).toBe(dropOf('b2y'));
    expect(Math.max(...flat)).toBeGreaterThan(dropOf('b2x'));
    // 嵌套干线仍在自己的带上方，且不与任何卡片或其它线冲突。
    expect(nested.trunkY).toBeLessThan(b2x.y);
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
      expect(anchor.y).not.toBe(trunk.trunkY);
      if (edge.to === 'b1') {
        // 最内成员的落点竖段与干线竖段是同一条线：标签不能骑上去（会读成整组说明），
        // 改骑它自己的入卡横段中点——那条横段只通向这张卡。
        expect(anchor.x).toBe((join.x + target.x) / 2);
        expect(anchor.x).toBeGreaterThan(join.x);
        expect(anchor.x).toBeLessThan(target.x);
        expect(anchor.y).toBe(target.y + H / 2);
      } else {
        expect(anchor.x).toBe(join.x);
        expect(anchor.y).toBeGreaterThan(trunk.trunkY + 14);
        expect(anchor.y).toBeLessThan(target.y + H / 2 - 14);
      }
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
