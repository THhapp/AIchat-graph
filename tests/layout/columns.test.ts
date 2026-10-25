import { describe, expect, it } from 'vitest';
import { computeLayout, type LayoutNodeInput, type LayoutResult } from '../../src/web/layout/index.js';
import {
  EDGE_LABEL_FONT,
  EDGE_LABEL_PAD_X,
  textWidth,
  wrapByWidth,
} from '../../src/web/graph/cardMetrics.js';

const W = 360;
const H = 152;
const VG = 64;
const HG = 88;

function node(id: string, from: string | null, flow: 'root' | 'next' | 'branch', extra: Partial<LayoutNodeInput> = {}): LayoutNodeInput {
  return { id, from, flow, ...extra };
}

interface Rect {
  id: string;
  x: number;
  y: number;
  height: number;
  right: number;
  bottom: number;
}

function rects(result: LayoutResult): Rect[] {
  return Object.entries(result.positions).map(([id, position]) => {
    const height = result.heights[id] ?? result.cardHeight;
    return { id, x: position.x, y: position.y, height, right: position.x + result.cardWidth, bottom: position.y + height };
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

function penetrated(result: LayoutResult): string[] {
  const bad: string[] = [];
  const rectById = new Map(rects(result).map((rect) => [rect.id, rect]));
  for (const route of result.edgeRoutes) {
    for (const [id, rect] of rectById) {
      if (id === route.from || id === route.to) continue;
      if (crossesRect(route.points, rect)) bad.push(route.id + ' x ' + id);
    }
  }
  // 共享干线不属于任何一条关系，但同样只能走卡片之间的通道。
  for (const trunk of result.branchTrunks) {
    for (const [id, rect] of rectById) {
      if (id === trunk.from) continue;
      if (crossesRect(trunk.points, rect)) bad.push(trunk.id + ' x ' + id);
    }
  }
  return bad;
}

function crossesRect(points: { x: number; y: number }[], rect: Rect): boolean {
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

/** 点是否落在某张卡内部（严格包含，边界不算）。 */
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

/** 断言一组兄弟首卡同带、x 严格外扩且相邻间距不小于卡宽 + 列间距。 */
function expectSameBand(result: LayoutResult, ids: string[], bandY: number, direction: 'right' | 'left'): void {
  for (const id of ids) expect(pos(result, id).y).toBe(bandY);
  for (let index = 1; index < ids.length; index += 1) {
    const previous = pos(result, ids[index - 1] ?? '');
    const current = pos(result, ids[index] ?? '');
    if (direction === 'right') {
      expect(current.x - previous.x).toBeGreaterThanOrEqual(W + HG);
    } else {
      expect(previous.x - current.x).toBeGreaterThanOrEqual(W + HG);
    }
  }
}

describe('branch columns', () => {
  it('puts every same-side branch of one parent in a single horizontal band', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('b1', 'r', 'branch', { side: 'right', order: 10 }),
      node('b2', 'r', 'branch', { side: 'right', order: 20 }),
      node('b3', 'r', 'branch', { side: 'right', order: 30 }),
    ];
    const result = computeLayout({ nodes });
    const r = pos(result, 'r');

    // 三个方向同时出现在父节点这一条横带上，而不是斜向阶梯。
    expectSameBand(result, ['b1', 'b2', 'b3'], r.y, 'right');
    for (const id of ['b1', 'b2', 'b3']) expect(pos(result, id).x).toBeGreaterThan(r.x + W);

    // 并列带必须完整：横向三列、纵向只有一行卡片高。
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);

    // 走廊在带的上方：整组共用一条干线，三条分支从干线各自下接。
    expect(result.branchTrunks).toHaveLength(1);
    const trunk = result.branchTrunks[0];
    expect(trunk?.id).toBe('r~right');
    expect(trunk?.trunkY).toBe(r.y - 18);
    for (const id of ['b1', 'b2', 'b3']) {
      const edge = route(result, 'r->' + id);
      const target = pos(result, id);
      expect(edge.join?.y).toBe(trunk?.trunkY);
      expect(edge.points[0]).toEqual(edge.join);
      expect(edge.points[edge.points.length - 1]).toEqual({ x: target.x, y: target.y + H / 2 });
      // 末段只跨空隙：落点 x 在目标卡左侧一格空隙内。
      const dropX = edge.points[edge.points.length - 2]?.x ?? 0;
      expect(dropX).toBeGreaterThan(target.x - HG);
      expect(dropX).toBeLessThan(target.x);
    }
    // 干线止于最远接出点，其余接出点在干线上。
    expect(trunk?.points[trunk.points.length - 1]?.x).toBe(pos(result, 'b3').x - HG / 2);
  });

  it('keeps an inner next chain inside its own column', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('b1', 'r', 'branch', { side: 'right', order: 10 }),
      node('b1a', 'b1', 'next'),
      node('b1b', 'b1a', 'next'),
      node('b2', 'r', 'branch', { side: 'right', order: 20 }),
    ];
    const result = computeLayout({ nodes });
    const b1 = pos(result, 'b1');
    expect(pos(result, 'b1a').x).toBe(b1.x);
    expect(pos(result, 'b1b').x).toBe(b1.x);
    expect(pos(result, 'b1a').y).toBe(b1.y + H + VG);
    expect(pos(result, 'b1b').y).toBe(pos(result, 'b1a').y + H + VG);

    // 同一个带里的兄弟不受另一支链条影响。
    expect(pos(result, 'b2').y).toBe(b1.y);
    expect(pos(result, 'b2').x).toBeGreaterThan(b1.x + W);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });

  it('does not push sibling entries down when one branch next chain grows', () => {
    const base: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('b1', 'r', 'branch', { side: 'right', order: 10 }),
      node('b2', 'r', 'branch', { side: 'right', order: 20 }),
      node('b3', 'r', 'branch', { side: 'right', order: 30 }),
    ];
    const stretched: LayoutNodeInput[] = [
      ...base,
      node('b1a', 'b1', 'next'),
      node('b1b', 'b1a', 'next'),
      node('b1c', 'b1b', 'next'),
    ];
    const before = computeLayout({ nodes: base });
    const after = computeLayout({ nodes: stretched });

    // 入口位置与兄弟是否被拉扯无关：只有 b1 自己的链条变长。
    for (const id of ['b1', 'b2', 'b3']) expect(pos(after, id)).toEqual(pos(before, id));
    expect(pos(after, 'b1c').x).toBe(pos(after, 'b1').x);
    expect(pos(after, 'b1c').y).toBe(pos(after, 'b1').y + 3 * (H + VG));
    expect(overlaps(after)).toEqual([]);
    expect(penetrated(after)).toEqual([]);
  });

  it('uses both sides for automatic branches and keeps declared sides', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('a1', 'r', 'branch', { order: 10 }),
      node('a2', 'r', 'branch', { order: 20 }),
      node('a3', 'r', 'branch', { order: 30 }),
      node('l1', 'r2', 'branch', { side: 'left', order: 10 }),
    ];
    const result = computeLayout({ nodes });
    const r = pos(result, 'r');
    const sides = new Set<'left' | 'right'>();
    for (const id of ['a1', 'a2', 'a3']) {
      const p = pos(result, id);
      sides.add(p.x > r.x ? 'right' : 'left');
    }
    // 自动择侧不只挤在一侧。
    expect(sides.size).toBe(2);

    // 显式 left 必须在左侧。
    expect(pos(result, 'l1').x + W).toBeLessThanOrEqual(r.x);

    // 同侧兄弟仍同带。
    expect(pos(result, 'a1').y).toBe(r.y);
    expect(pos(result, 'a2').y).toBe(r.y);

    // 路由声明的 side 与实际落位一致。
    for (const edge of result.edgeRoutes) {
      if (edge.flow !== 'branch') continue;
      const source = pos(result, edge.from);
      const target = pos(result, edge.to);
      if (edge.side === 'right') expect(target.x).toBeGreaterThanOrEqual(source.x + W);
      else expect(target.x + W).toBeLessThanOrEqual(source.x);
    }

    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });

  it('keeps the entry side in one band and without a ghost row when the head has no next', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('br', 'r', 'branch', { side: 'right', order: 10 }),
      node('bl1', 'br', 'branch', { side: 'left', order: 10 }),
      node('bl2', 'br', 'branch', { side: 'left', order: 20 }),
    ];
    const result = computeLayout({ nodes });
    const br = pos(result, 'br');
    // 入口侧同带：两张都在 head 的下一行，不堆在 head 中心行；br 是分支节点，这条带整体下移 24。
    expect(pos(result, 'bl1').y).toBe(br.y + H + VG + 24);
    expect(pos(result, 'bl2').y).toBe(br.y + H + VG + 24);
    // 入口侧同样按列外扩，列 1 最靠近 head。
    expect(pos(result, 'br').x - (pos(result, 'bl1').x + W)).toBe(HG);
    expect(pos(result, 'bl2').x + W + HG).toBeLessThanOrEqual(pos(result, 'bl1').x);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });

  it('keeps an unrelated upper group in place when a lower branch gains a child', () => {
    const base: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('s2', 'r', 'next'),
      node('s3', 's2', 'next'),
      node('a1', 'r', 'branch', { side: 'right', order: 10 }),
      node('a2', 'r', 'branch', { side: 'right', order: 20 }),
      node('b1', 's2', 'branch', { side: 'right', order: 10 }),
    ];
    const grown = [...base, node('b1x', 'b1', 'branch', { side: 'right', order: 10 })];
    const before = computeLayout({ nodes: base });
    const after = computeLayout({ nodes: grown });

    // 上方分组与主脊完全不动。列宽按纵向区间取：b1 的块变宽只影响与它纵向相交的行，
    // 上方 a1/a2 与 b1 不在同一段区间，因此原来的全局列宽扩张不再发生。
    for (const id of ['r', 'a1', 'a2', 'b1']) expect(pos(after, id)).toEqual(pos(before, id));

    // 子分支只占 b1 自己那一列外侧的一格，落回嵌套带的 24px 提示。
    expect(pos(after, 'b1x').x).toBe(pos(after, 'b1').x + W + HG);
    expect(pos(after, 'b1x').y).toBe(pos(after, 'b1').y + 24);

    expect(overlaps(after)).toEqual([]);
    expect(penetrated(after)).toEqual([]);
    expect(after.diagnostics).toEqual([]);
  });

  it('keeps a later spine node branch on its own parent band in the nearest column', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('s2', 'r', 'next'),
      node('s3', 's2', 'next'),
      node('s4', 's3', 'next'),
      node('b1', 'r', 'branch', { side: 'right', order: 10 }),
      node('b2', 'r', 'branch', { side: 'right', order: 20 }),
      node('late', 's3', 'branch', { side: 'right', order: 10 }),
    ];
    const result = computeLayout({ nodes });
    const s3 = pos(result, 's3');
    const late = pos(result, 'late');
    // 贴着来源：同一 y 带 + 当时最内的空列，而不是排到前面分支下方。
    expect(late.y).toBe(s3.y);
    expect(late.x).toBe(pos(result, 'b1').x);
    expect(late.x).toBeGreaterThan(s3.x + W);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('drops the main line below a long sibling cluster instead of shifting the band', () => {
    const chain: LayoutNodeInput[] = [];
    let previous = 'b1';
    for (let index = 1; index <= 5; index += 1) {
      const id = 'b1-' + String(index);
      chain.push(node(id, previous, 'next'));
      previous = id;
    }
    const secondChain: LayoutNodeInput[] = [];
    let second = 'b2';
    for (let index = 1; index <= 5; index += 1) {
      const id = 'b2-' + String(index);
      secondChain.push(node(id, second, 'next'));
      second = id;
    }
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('s2', 'r', 'next'),
      node('s3', 's2', 'next'),
      node('s4', 's3', 'next'),
      node('b1', 'r', 'branch', { side: 'right', order: 10 }),
      ...chain,
      node('b2', 'r', 'branch', { side: 'right', order: 20 }),
      ...secondChain,
      node('late1', 's3', 'branch', { side: 'right', order: 10 }),
      node('late2', 's3', 'branch', { side: 'right', order: 20 }),
    ];
    const result = computeLayout({ nodes });
    const s2 = pos(result, 's2');
    const s3 = pos(result, 's3');
    const late1 = pos(result, 'late1');
    const late2 = pos(result, 'late2');

    // 侧支簇占满父行：主线下一个节点排在两列的整簇之下，兄弟带宽始终空着。
    const clusterBottom = Math.max(pos(result, 'b1-5').y, pos(result, 'b2-5').y) + H;
    expect(s2.y).toBe(clusterBottom + VG);
    expect(s3.y).toBe(s2.y + H + VG);

    // 后续主线的分支仍然贴着自己的来源：同带 + 最内可用列，且不再需要整组下移。
    expect(late1.y).toBe(s3.y);
    expect(late2.y).toBe(s3.y);
    expect(late2.x - late1.x).toBeGreaterThanOrEqual(W + HG);
    expect(late1.x).toBe(pos(result, 'b1').x);
    expect(result.diagnostics).toEqual([]);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });
});

describe('lone branch routing', () => {
  /**
   * 标签板水平区间，按 `RouteEdge.tsx` 的 `layoutEdgeLabel` 复算：以 `labelAnchor.x` 居中，
   * 宽 = `min(labelWidth, 最长行宽) + 两侧内边距`。
   *
   * 行数上限写死 3：只适用于 branch（`MAX_LABEL_LINES.branch = 3`；next 是 2），别把这个辅助复用到 next 边。
   * 渲染端另有一条防御边界（板不许越过目标卡边），这里没有模拟：用例要求居中板本来就落在两侧卡边之间，
   * 真越界时下面"框不越卡边"的断言会先红，不需要再复算 clamp。
   */
  function labelBox(result: LayoutResult, id: string, text: string) {
    const edge = route(result, id);
    const anchor = edge.labelAnchor;
    const labelWidth = edge.labelWidth;
    if (anchor === undefined || labelWidth === undefined) throw new Error('missing label ' + id);
    const lines = wrapByWidth(text, labelWidth, EDGE_LABEL_FONT, 3);
    const widest = Math.max(...lines.map((line) => textWidth(line, EDGE_LABEL_FONT)));
    const width = Math.min(labelWidth, widest) + EDGE_LABEL_PAD_X * 2;
    return { left: anchor.x - width / 2, right: anchor.x + width / 2, width, lines, anchor, edge };
  }

  it('draws a Z-shape through the gap centre for a single branch whose two cards differ in height', () => {
    const result = computeLayout({
      nodes: [
        node('r', null, 'root', { height: 152, label: '根' }),
        node('b1', 'r', 'branch', { side: 'right', order: 10, height: 232, label: '甲支再往下走一步' }),
      ],
    });
    const r = pos(result, 'r');
    const b1 = pos(result, 'b1');

    // 只隔一格空隙，不需要一条上到带上方的干线，也不带 join。
    expect(result.branchTrunks).toEqual([]);
    const edge = route(result, 'r->b1');
    expect(edge.join).toBeUndefined();
    expect(edge.points).toEqual([
      { x: r.x + W, y: r.y + 152 / 2 },
      { x: r.x + W + HG / 2, y: r.y + 152 / 2 },
      { x: r.x + W + HG / 2, y: b1.y + 232 / 2 },
      { x: b1.x, y: b1.y + 232 / 2 },
    ]);
    // 竖直通道落在空隙正中，与干线成员的落点同一列带，不再贴源卡。
    expect(edge.points[1]?.x).toBe(r.x + W + HG / 2);
    expect(edge.points[1]?.x).toBe((r.x + W + b1.x) / 2);
    // 拐点最多四个，且每一段都只有一维变化（无斜线）。
    expect(edge.points.length).toBeLessThanOrEqual(4);
    for (let index = 1; index < edge.points.length; index += 1) {
      const a = edge.points[index - 1];
      const b = edge.points[index];
      if (a === undefined || b === undefined) continue;
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }

    // 标签以空隙中心（也就是竖线本身）为板心，按真实行宽算的框也不越过两侧卡边。
    const box = labelBox(result, 'r->b1', '甲支再往下走一步');
    expect(box.anchor.x).toBe(r.x + W + HG / 2);
    expect(box.edge.labelWidth).toBe(Math.max(40, HG - 16));
    expect(box.left).toBeGreaterThanOrEqual(r.x + W);
    expect(box.right).toBeLessThanOrEqual(b1.x);

    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('mirrors the gap-centre channel and label box on the left side', () => {
    const result = computeLayout({
      nodes: [
        node('r', null, 'root', { height: 152, label: '根' }),
        node('l1', 'r', 'branch', { side: 'left', order: 10, height: 232, label: '甲支再往下走一步' }),
      ],
    });
    const r = pos(result, 'r');
    const l1 = pos(result, 'l1');

    expect(result.branchTrunks).toEqual([]);
    const edge = route(result, 'r->l1');
    expect(edge.join).toBeUndefined();
    expect(edge.points).toEqual([
      { x: r.x, y: r.y + 152 / 2 },
      { x: r.x - HG / 2, y: r.y + 152 / 2 },
      { x: r.x - HG / 2, y: l1.y + 232 / 2 },
      { x: l1.x + W, y: l1.y + 232 / 2 },
    ]);
    expect(edge.points[1]?.x).toBe(r.x - HG / 2);
    expect(edge.points[1]?.x).toBe((r.x + l1.x + W) / 2);

    const box = labelBox(result, 'r->l1', '甲支再往下走一步');
    expect(box.anchor.x).toBe(r.x - HG / 2);
    expect(box.left).toBeGreaterThanOrEqual(l1.x + W);
    expect(box.right).toBeLessThanOrEqual(r.x);

    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps a single branch in the nearest column as two points when the cards share a center line', () => {
    const result = computeLayout({
      nodes: [node('r', null, 'root'), node('b1', 'r', 'branch', { side: 'right', order: 10 })],
    });
    const r = pos(result, 'r');
    const b1 = pos(result, 'b1');

    // 等高时竖向通道退化，Z 形塌回原来的一条水平直连。
    expect(result.branchTrunks).toEqual([]);
    const edge = route(result, 'r->b1');
    expect(edge.join).toBeUndefined();
    expect(edge.points).toEqual([
      { x: r.x + W, y: r.y + H / 2 },
      { x: b1.x, y: b1.y + H / 2 },
    ]);
    expect(penetrated(result)).toEqual([]);
  });

  it('still draws a trunk and a join for a single branch pushed out to the second column', () => {
    const result = computeLayout({
      nodes: [
        node('r', null, 'root'),
        node('br', 'r', 'branch', { side: 'right', order: 10 }),
        node('bn', 'br', 'next'),
        node('bl', 'br', 'branch', { side: 'left', order: 10 }),
        node('bl2', 'bn', 'branch', { side: 'left', order: 10 }),
      ],
    });
    const bl = pos(result, 'bl');
    const bl2 = pos(result, 'bl2');
    // bl 贴最内一列，bl2 被挤到第二列：后者要从带上方的走廊绕过内层列。
    expect(bl.x).toBe(bl2.x + W + HG);

    expect(result.branchTrunks.map((trunk) => trunk.id)).toEqual(['bn~left']);
    const trunk = result.branchTrunks[0];
    if (trunk === undefined) throw new Error('missing trunk bn~left');
    const edge = route(result, 'bn->bl2');
    expect(edge.join).toBeDefined();
    expect(edge.join?.y).toBe(trunk.trunkY);
    expect(edge.points[0]).toEqual(edge.join);
    expect(edge.points[edge.points.length - 1]).toEqual({ x: bl2.x + W, y: bl2.y + H / 2 });

    // 列 1 的那一张不受影响：仍是 Z 形短折，不挂到别人的干线上。
    const inner = route(result, 'br->bl');
    expect(inner.join).toBeUndefined();
    expect(inner.points).toHaveLength(4);
    expect(inner.points[1]?.x).toBe(pos(result, 'br').x - HG / 2);

    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });
});

describe('nested band offset', () => {
  const nodes: LayoutNodeInput[] = [
    node('r', null, 'root'),
    node('r2', 'r', 'next'),
    node('a', 'r', 'branch', { side: 'right', order: 10 }),
    node('b', 'r', 'branch', { side: 'right', order: 20 }),
    node('c', 'r', 'branch', { side: 'right', order: 30 }),
    node('b1', 'b', 'branch', { side: 'right', order: 10 }),
    node('b2', 'b', 'branch', { side: 'right', order: 20 }),
  ];

  it('drops a branch block own bands by 24 without moving the parent sibling band', () => {
    const result = computeLayout({ nodes });
    const r = pos(result, 'r');
    const b = pos(result, 'b');

    // 父节点自己的兄弟带完全不动：甲/乙/丙 仍然同一个 y。
    for (const id of ['a', 'b', 'c']) expect(pos(result, id).y).toBe(r.y);

    // 分支自己的子分支带整条下移 24，组内仍同带、彼此不错开。
    expect(pos(result, 'b1').y).toBe(b.y + 24);
    expect(pos(result, 'b2').y).toBe(b.y + 24);
    // 层级提示只改纵向位置，列序不变。
    expect(pos(result, 'b2').x).toBeGreaterThan(pos(result, 'b1').x);

    // 子块变高之后仍参与主线推进：主线下一个节点排在整簇底部 + 行距之下。
    expect(pos(result, 'r2').y).toBe(pos(result, 'b1').y + H + VG);

    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('acceptance structure', () => {
  const nodes: LayoutNodeInput[] = [
    node('r', null, 'root', { height: 152 }),
    node('s2', 'r', 'next', { height: 192 }),
    node('s3', 's2', 'next', { height: 232 }),
    node('s4', 's3', 'next', { height: 152 }),
    node('b1', 'r', 'branch', { order: 10 }),
    node('b1a', 'b1', 'next'),
    node('b2', 'r', 'branch', { order: 20 }),
    node('b2a', 'b2', 'next'),
    node('b2x', 'b2', 'branch', { order: 10 }),
    node('b3', 'r', 'branch', { side: 'left', order: 30 }),
    node('b4', 's3', 'branch', { order: 10 }),
    node('b4a', 'b4', 'next'),
    node('ml', 's3', 'branch', { side: 'left', order: 20 }),
  ];

  it('lays out main line, sibling band, nested branch and long cards without collisions', () => {
    const result = computeLayout({ nodes });

    // 覆盖与版本。
    expect(Object.keys(result.positions).sort()).toEqual(nodes.map((item) => item.id).sort());
    expect(Object.keys(result.heights).sort()).toEqual(Object.keys(result.positions).sort());
    expect(result.layoutVersion).toBe(4);

    // 关系未变：边集合与 flow 一致。
    const edgeIds = result.edgeRoutes.map((edge) => edge.id).sort();
    expect(edgeIds).toEqual(
      ['b1->b1a', 'b2->b2a', 'b2->b2x', 'b4->b4a', 'r->b1', 'r->b2', 'r->b3', 'r->s2', 's2->s3', 's3->b4', 's3->ml', 's3->s4'].sort(),
    );
    const nextEdges = new Set(['b1->b1a', 'b2->b2a', 'b4->b4a', 'r->s2', 's2->s3', 's3->s4']);
    for (const edge of result.edgeRoutes) {
      expect(edge.flow).toBe(nextEdges.has(edge.id) ? 'next' : 'branch');
      expect(edge.points.length).toBeGreaterThanOrEqual(2);
    }

    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);

    const r = pos(result, 'r');
    const s3 = pos(result, 's3');

    // 主线继续纵向推进。
    expect(pos(result, 's2').x).toBe(r.x);
    expect(pos(result, 's3').x).toBe(r.x);
    expect(pos(result, 's4').x).toBe(r.x);
    // 行 0 有一个 2 卡侧支簇（b1/b2 各带一节），主线下一个节点排在整簇之下。
    // b2 块里的再分支带下移 24，整簇因此高了 24，s2 随之下移同样距离。
    expect(pos(result, 's2').y).toBe(r.y + (2 * H + VG) + VG + 24);
    expect(pos(result, 's3').y).toBe(pos(result, 's2').y + 192 + VG);

    // 同父同侧三分支：x 分明，y 同带（b1 在右，b2/b3 自动择侧后同在左）。
    expect(new Set(['b1', 'b2', 'b3'].map((id) => pos(result, id).x)).size).toBe(3);
    expect(pos(result, 'b1').y).toBe(r.y);
    expect(pos(result, 'b2').y).toBe(r.y);
    expect(pos(result, 'b3').y).toBe(r.y);
    expect(pos(result, 'b1').x).toBeGreaterThan(r.x + W);
    expect(pos(result, 'b2').x + W).toBeLessThan(r.x);
    expect(pos(result, 'b3').x + W).toBeLessThan(r.x);
    expect(pos(result, 'b2').x - pos(result, 'b3').x).toBeGreaterThanOrEqual(W + HG);

    // 明确 left 的分支留在左侧。
    expect(pos(result, 'b3').x + W).toBeLessThan(r.x);
    expect(pos(result, 'ml').x + W).toBeLessThan(s3.x);

    // 再分支：属于它自己的父节点，落在父分支所在带的外侧列，且整条带下移 24（层级提示）。
    const b2 = pos(result, 'b2');
    const b2x = pos(result, 'b2x');
    expect(b2x.y).toBe(b2.y + 24);
    expect(Math.abs(b2x.x - r.x)).toBeGreaterThan(Math.abs(b2.x - r.x));
    expect(b2x.x).not.toBe(pos(result, 'b1').x);
    expect(b2x.x).not.toBe(pos(result, 'b3').x);

    // 后续主线节点的分支贴着自己的来源：同带 + 最内可用列。
    expect(pos(result, 'b4').y).toBe(s3.y);
    expect(pos(result, 'b4').x).toBeGreaterThan(s3.x + W);
    expect(pos(result, 'ml').y).toBe(s3.y);

    // 枝内 next 仍在本列。
    expect(pos(result, 'b4a').x).toBe(pos(result, 'b4').x);
    expect(pos(result, 'b4a').y).toBe(pos(result, 'b4').y + H + VG);
    expect(pos(result, 'b1a').x).toBe(pos(result, 'b1').x);
    expect(pos(result, 'b2a').x).toBe(pos(result, 'b2').x);

    // 每条 branch 路由的 side 与实际落位一致。
    for (const edge of result.edgeRoutes) {
      if (edge.flow !== 'branch' || edge.side === undefined) continue;
      const source = pos(result, edge.from);
      const target = pos(result, edge.to);
      if (edge.side === 'right') expect(target.x).toBeGreaterThanOrEqual(source.x + W);
      else expect(target.x + W).toBeLessThanOrEqual(source.x);
    }
  });

  it('is stable under input order and label text changes', () => {
    const base = computeLayout({ nodes });
    const reversed = computeLayout({ nodes: [...nodes].reverse() });
    const relabeled = computeLayout({
      nodes: nodes.map((item) => ({ ...item, label: '关系说明文字 ' + item.id, topicId: 't_x' })),
    });
    expect(reversed.positions).toEqual(base.positions);
    expect(relabeled.positions).toEqual(base.positions);
    expect(relabeled.edgeRoutes.map((edge) => edge.points)).toEqual(base.edgeRoutes.map((edge) => edge.points));
  });
});

describe('band self-check', () => {
  const base: LayoutNodeInput[] = [
    node('r', null, 'root'),
    node('r2', 'r', 'next'),
    node('b1', 'r', 'branch', { side: 'right', order: 10 }),
    node('b1a', 'b1', 'next'),
    node('b1b', 'b1a', 'next'),
    node('b2', 'r', 'branch', { side: 'right', order: 20 }),
    node('b2a', 'b2', 'next'),
    node('b3', 'r', 'branch', { side: 'right', order: 30 }),
    node('b3a', 'b3', 'next'),
  ];

  it('(a) three siblings with their own next chains share one band', () => {
    const result = computeLayout({ nodes: base });
    const r = pos(result, 'r');
    expectSameBand(result, ['b1', 'b2', 'b3'], r.y, 'right');
    for (const id of ['b1', 'b2', 'b3']) {
      expect(pos(result, id + 'a').x).toBe(pos(result, id).x);
      expect(pos(result, id + 'a').y).toBe(pos(result, id).y + H + VG);
    }
    // 3 卡侧链占满父行：主线后继排在整簇底部 + gap 之下，而不是贴着父卡。
    expect(pos(result, 'r2').y).toBe(pos(result, 'b1b').y + H + VG);
    expect(pos(result, 'r2').x).toBe(r.x);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('(b) extending the first chain leaves the other two entries bit-identical', () => {
    const stretched = [...base, node('b1c', 'b1b', 'next')];
    const before = computeLayout({ nodes: base });
    const after = computeLayout({ nodes: stretched });
    expect(pos(after, 'b2')).toEqual(pos(before, 'b2'));
    expect(pos(after, 'b3')).toEqual(pos(before, 'b3'));
    expect(pos(after, 'b1')).toEqual(pos(before, 'b1'));
    expect(pos(after, 'b1c').x).toBe(pos(after, 'b1').x);
    expect(overlaps(after)).toEqual([]);
    expect(penetrated(after)).toEqual([]);
  });

  it('(c) a nested branch stays on its parent band, in an outer column, without touching siblings', () => {
    const nested = [
      ...base,
      node('b2x', 'b2', 'branch', { side: 'right', order: 10 }),
      node('b2y', 'b2', 'branch', { side: 'right', order: 20 }),
    ];
    const before = computeLayout({ nodes: base });
    const after = computeLayout({ nodes: nested });
    const b2 = pos(after, 'b2');
    const b2x = pos(after, 'b2x');
    // 子分支带整体下移 24：仍与父同一带（同一水平组），但纵向低 24，避免被读成第四个并列方向。
    expect(b2x.y).toBe(b2.y + 24);
    expect(b2x.x).toBeGreaterThan(b2.x + W);
    // 再分支只加宽自己那一列，父块的带内位置不变：以主根为原点比较。
    const rel = (result: LayoutResult, id: string) => {
      const root = pos(result, 'r');
      const point = pos(result, id);
      return { x: point.x - root.x, y: point.y - root.y };
    };
    expect(rel(after, 'b1')).toEqual(rel(before, 'b1'));
    expect(rel(after, 'b2')).toEqual(rel(before, 'b2'));
    expect(rel(after, 'b3').y).toBe(rel(before, 'b3').y);
    // 再分支加宽了第二支所在列，第三支仍在外侧一列，顺序不变。
    expect(pos(after, 'b3').x).toBeGreaterThan(b2x.x + W);

    // 父组与成员的再分组各自一条干线，深度不同 → 干线不共线。
    // 子组的带整体下移 24，干线要按"未下移的那条带"算，所以补偿 24 后反而比父组高一层。
    const parent = after.branchTrunks.find((trunk) => trunk.id === 'r~right');
    const child = after.branchTrunks.find((trunk) => trunk.id === 'b2~right');
    expect(parent?.trunkY).toBe(b2.y - 18);
    expect(child?.trunkY).toBe(b2.y + 24 - 18 - 14 - 24);
    expect(parent?.trunkY).not.toBe(child?.trunkY);
    // 嵌套层的干线在父层之上，层级方向与卡片的下移方向一致。
    expect(child?.trunkY).toBe((parent?.trunkY ?? 0) - 14);
    expect(route(after, 'b2->b2x').join?.y).toBe(child?.trunkY);
    expect(route(after, 'b2->b2x').join?.y).not.toBe(route(after, 'r->b2').join?.y);
    expect(overlaps(after)).toEqual([]);
    expect(penetrated(after)).toEqual([]);
  });
});

describe('route labels', () => {
  const nodes: LayoutNodeInput[] = [
    node('r', null, 'root', { label: '主根到下一步' }),
    node('s2', 'r', 'next', { label: '继续' }),
    node('s3', 's2', 'next'),
    node('b1', 'r', 'branch', { side: 'right', order: 10, label: '并列分支一' }),
    node('b2', 'r', 'branch', { side: 'right', order: 20, label: '并列分支二' }),
    node('b2a', 'b2', 'next'),
    node('b3', 's3', 'branch', { side: 'left', order: 10, label: '对手观点' }),
  ];

  it('puts every label anchor in the gap between cards and reports its width', () => {
    const result = computeLayout({ nodes });
    const labelled = result.edgeRoutes.filter((edge) => edge.labelAnchor !== undefined);
    expect(labelled.map((edge) => edge.id).sort()).toEqual(['r->b1', 'r->b2', 'r->s2', 's3->b3'].sort());

    for (const edge of labelled) {
      const anchor = edge.labelAnchor;
      if (anchor === undefined) continue;
      expect(insideAnyCard(result, anchor)).toEqual([]);
      expect(edge.labelWidth).toBeDefined();
      expect(edge.labelWidth ?? 0).toBeGreaterThanOrEqual(40);
    }

    // next 的标签宽度按卡片宽度给足；branch 的标签宽度受列间空隙限制。
    for (const edge of labelled) {
      if (edge.flow === 'next') expect(edge.labelWidth).toBe(Math.max(80, W - 40));
      else expect(edge.labelWidth).toBe(Math.max(40, HG - 16));
    }
  });

  it('anchors branch labels on the drop line inside the gap, not on the shared channel', () => {
    const gap = 120;
    const nodes: LayoutNodeInput[] = [node('r', null, 'root')];
    for (let index = 1; index <= 6; index += 1) {
      nodes.push(node('b' + index, 'r', 'branch', { side: 'right', order: index * 10, label: 'x' }));
    }
    const result = computeLayout({ nodes, horizontalGap: gap });
    const routes = result.edgeRoutes.filter((edge) => edge.id.startsWith('r->b'));
    expect(routes).toHaveLength(6);

    const anchors: number[] = [];
    for (const edge of routes) {
      const anchor = edge.labelAnchor;
      if (anchor === undefined) throw new Error('missing label anchor ' + edge.id);
      const target = pos(result, edge.to);
      // 最内成员（b1）的落点竖段就是干线竖段，标签改骑自己的入卡横段中点；
      // 其余成员落在自己那一格的落点线上，都与共享出口竖线的 x 不同。
      const innermost = edge.to === 'b1';
      expect(anchor.x).toBe(innermost ? target.x - gap / 4 : target.x - gap / 2);
      anchors.push(anchor.x);
      expect(insideAnyCard(result, anchor)).toEqual([]);

      // 文字框（labelWidth + 8 内边距，高度按 3 行粗略估计）不压任何卡。
      // 水平位置按渲染端的同一条防御边界复算：板不许越过目标卡的入口边（右侧卡是左边缘）。
      const width = (edge.labelWidth ?? 0) + 8;
      const x0 = Math.min(anchor.x - width / 2, target.x - width);
      const x1 = x0 + width;
      const y0 = anchor.y - 30;
      const y1 = anchor.y + 30;
      const hits = rects(result).filter((rect) => x0 < rect.right && x1 > rect.x && y0 < rect.bottom && y1 > rect.y);
      expect(hits.map((rect) => rect.id)).toEqual([]);
    }
    expect(new Set(anchors).size).toBe(6);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });

  it('keeps the innermost branch label on its own entry run, off the shared exit riser', () => {
    const result = computeLayout({
      nodes: [
        node('r', null, 'root'),
        node('b1', 'r', 'branch', { side: 'right', order: 10, label: '第一个分支的说明' }),
        node('b2', 'r', 'branch', { side: 'right', order: 20, label: '第二个分支的说明' }),
        node('b3', 'r', 'branch', { side: 'right', order: 30, label: '第三个分支的说明' }),
      ],
    });
    const trunk = result.branchTrunks[0];
    if (trunk === undefined) throw new Error('missing trunk');

    /** 点是否落在干线（多条关系共用的段）内部。 */
    const onSharedRun = (point: { x: number; y: number }): boolean => {
      for (let index = 1; index < trunk.points.length; index += 1) {
        const a = trunk.points[index - 1];
        const b = trunk.points[index];
        if (a === undefined || b === undefined) continue;
        if (Math.abs(a.y - b.y) < 0.01) {
          if (Math.abs(point.y - a.y) < 0.01 && point.x > Math.min(a.x, b.x) && point.x < Math.max(a.x, b.x)) {
            return true;
          }
        } else if (Math.abs(point.x - a.x) < 0.01 && point.y > Math.min(a.y, b.y) && point.y < Math.max(a.y, b.y)) {
          return true;
        }
      }
      return false;
    };

    // 共享段只画一次，说明文字挂上去就会被读成整组说明：任何一条都不能骑在上面。
    for (const edge of result.edgeRoutes) {
      if (edge.flow !== 'branch') continue;
      const anchor = edge.labelAnchor;
      if (anchor === undefined) throw new Error('missing label ' + edge.id);
      expect(onSharedRun(anchor)).toBe(false);
    }

    // 最内支线的共享段就是它的落点竖段：说明改骑自己的入卡横段中点，只指向这张卡。
    const inner = route(result, 'r->b1');
    const target = pos(result, 'b1');
    const anchor = inner.labelAnchor;
    if (anchor === undefined) throw new Error('missing label r->b1');
    expect(anchor.y).toBe(target.y + H / 2);
    expect(anchor.x).toBeGreaterThan(inner.join?.x ?? 0);
    expect(anchor.x).toBeLessThan(target.x);
    // 不为了塞进横段而缩窄：宽度仍按列间空隙给足。
    expect(inner.labelWidth).toBe(Math.max(40, HG - 16));
    expect(insideAnyCard(result, anchor)).toEqual([]);
    // 其余两条仍骑在自己那一格的落点竖段上（那是它们独有的段）。
    expect(route(result, 'r->b2').labelAnchor?.x).toBe(route(result, 'r->b2').join?.x);
    expect(route(result, 'r->b3').labelAnchor?.x).toBe(route(result, 'r->b3').join?.x);
  });

  it('omits label fields when there is no label', () => {
    const result = computeLayout({ nodes: nodes.map((item) => ({ ...item, label: null })) });
    for (const edge of result.edgeRoutes) {
      expect(edge.labelAnchor).toBeUndefined();
      expect(edge.labelWidth).toBeUndefined();
    }
  });

  it('shares one exit channel per group and keeps every drop inside its own column gap', () => {
    const result = computeLayout({
      nodes: [
        node('r', null, 'root'),
        node('b1', 'r', 'branch', { side: 'right', order: 10 }),
        node('b2', 'r', 'branch', { side: 'right', order: 20 }),
        node('b3', 'r', 'branch', { side: 'right', order: 30 }),
      ],
    });
    const verticals = (points: { x: number; y: number }[]): number[] => {
      const found: number[] = [];
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1];
        const b = points[index];
        if (a === undefined || b === undefined) continue;
        if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) > 0.01) found.push(a.x);
      }
      return found;
    };
    const r = pos(result, 'r');
    const trunk = result.branchTrunks[0];
    if (trunk === undefined) throw new Error('missing trunk');

    // 出口竖线只有一条，仍夹在源卡与第一列之间；分支不再各自错开一根。
    const channels = verticals(trunk.points);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toBeGreaterThan(r.x + W);
    expect(channels[0]).toBeLessThan(r.x + W + HG);

    // 落点竖线各在自己的目标列空隙里，不共线也不压卡。
    const drops = ['r->b1', 'r->b2', 'r->b3'].map((id) => verticals(route(result, id).points)[0] ?? 0);
    expect(new Set(drops).size).toBe(3);
    for (const [index, id] of ['b1', 'b2', 'b3'].entries()) {
      const target = pos(result, id);
      expect(drops[index]).toBe(target.x - HG / 2);
    }
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });
});
