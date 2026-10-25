import { describe, expect, it } from 'vitest';
import {
  computeLayout,
  type LayoutInput,
  type LayoutNodeInput,
  type LayoutPoint,
  type LayoutPosition,
  type LayoutResult,
} from '../../src/web/layout/index.js';

const W = 360;
const H = 152;
const VG = 64;
const HG = 88;

function node(id: string, from: string | null, flow: 'root' | 'next' | 'branch', extra: Partial<LayoutNodeInput> = {}): LayoutNodeInput {
  return { id, from, flow, ...extra };
}

/** 06 / 06-03 / 07：branch 进入自己的列，06→07 不受影响。 */
const f01: LayoutNodeInput[] = [
  node('06', null, 'root'),
  node('07', '06', 'next'),
  node('06-03', '06', 'branch', { side: 'right', order: 20 }),
  node('06-04', '06-03', 'next'),
  node('06-03-01', '06-03', 'branch', { side: 'right', order: 10 }),
  node('06-03-02', '06-03-01', 'next'),
];

function layout(nodes: LayoutNodeInput[], extra: Partial<LayoutInput> = {}): LayoutResult {
  return computeLayout({ nodes, ...extra });
}

interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

/** 每张卡按自己的实际高度计算矩形。 */
function rects(result: LayoutResult): Rect[] {
  return Object.entries(result.positions).map(([id, position]) => {
    const height = result.heights[id] ?? result.cardHeight;
    return {
      id,
      x: position.x,
      y: position.y,
      width: result.cardWidth,
      height,
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

/** 非端点卡片正文是否被边线穿过（边界接触不算）。 */
function penetrated(result: LayoutResult): string[] {
  const bad: string[] = [];
  const rectById = new Map(rects(result).map((rect) => [rect.id, rect]));
  for (const route of result.edgeRoutes) {
    for (const [id, rect] of rectById) {
      if (id === route.from || id === route.to) continue;
      if (crossesRect(route.points, rect)) bad.push(route.id + ' x ' + id);
    }
  }
  for (const trunk of result.branchTrunks) {
    for (const [id, rect] of rectById) {
      if (id === trunk.from) continue;
      if (crossesRect(trunk.points, rect)) bad.push(trunk.id + ' x ' + id);
    }
  }
  return bad;
}

function crossesRect(points: LayoutPoint[], rect: Rect): boolean {
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

function position(result: LayoutResult, id: string): LayoutPosition {
  const found = result.positions[id];
  if (found === undefined) throw new Error('missing position ' + id);
  return found;
}

function route(result: LayoutResult, id: string) {
  const found = result.edgeRoutes.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error('missing route ' + id);
  return found;
}

/** 两条正交折线之间被重复描画的段（同一直线上有正长度重叠），用于查"两条线重合"。 */
function sharedSegments(a: LayoutPoint[], b: LayoutPoint[]): string[] {
  const segments = (points: LayoutPoint[]) => {
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
        if (Math.min(one.right, other.right) - Math.max(one.left, other.left) > 0.01) {
          found.push('horizontal@' + String(one.top));
        }
      } else if (bothVertical && Math.abs(one.left - other.left) < 0.01) {
        if (Math.min(one.bottom, other.bottom) - Math.max(one.top, other.top) > 0.01) {
          found.push('vertical@' + String(one.left));
        }
      }
    }
  }
  return found;
}

describe('computeLayout', () => {
  it('keeps 06 -> 07 as the global next and places 06-03 on a side column', () => {
    const result = layout(f01);
    expect(result.diagnostics.filter((d) => d.code !== 'duplicate-branch-order')).toEqual([]);

    const p06 = position(result, '06');
    const p07 = position(result, '07');
    const p0603 = position(result, '06-03');
    const p0604 = position(result, '06-04');

    // 全局 next 保持同 x；纵向上排在整条侧支簇之下（侧枝带 next，簇高过父卡）。
    expect(p07.x).toBe(p06.x);
    const clusterBottom = Math.max(p0604.y, position(result, '06-03-02').y) + H;
    expect(p07.y).toBe(clusterBottom + VG);
    expect(p07.y).toBeGreaterThan(p06.y + H + VG);

    // 侧枝独占右侧一列，枝内 next 沿本列继续；再分支属于分支自己的块：
    // 分支 head 的直接子项统一落在 head 下方那条带（有 next 时与 next 同层再下移 24）。
    expect(p0603.x).toBeGreaterThan(p06.x + W);
    expect(p0603.y).toBe(p06.y);
    expect(p0604.x).toBe(p0603.x);
    expect(position(result, '06-03-01').y).toBe(p0603.y + H + VG + 24);
    expect(p0604.y).toBeGreaterThan(p0603.y + H);

    // 06-03 的 next 不会接到 07 上。
    expect(p07.y).not.toBe(p0604.y);

    const globalNext = route(result, '06->07');
    expect(globalNext.flow).toBe('next');
    expect(globalNext.points).toHaveLength(2);
    const sideEntry = route(result, '06->06-03');
    expect(sideEntry.flow).toBe('branch');
    expect(sideEntry.side).toBe('right');
    expect(sideEntry.points[0]?.x).toBe(p06.x + W);
    expect(sideEntry.points[0]?.y).toBe(p06.y + H / 2);
    expect(sideEntry.points[sideEntry.points.length - 1]?.x).toBe(p0603.x);
  });

  it('does not overlap cards or cross body text with routes', () => {
    const result = layout(f01);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });

  it('nests a branch of a branch in its own column', () => {
    const result = layout(f01);
    const p0603 = position(result, '06-03');
    const p0631 = position(result, '06-03-01');
    const p0632 = position(result, '06-03-02');
    expect(p0631.x).toBeGreaterThan(p0603.x + W);
    // 再分支属于它自己的父节点：落在父分支下方那条带（父分支有 next，故与 next 同层再下移 24）。
    expect(p0631.y).toBe(p0603.y + H + VG + 24);
    expect(p0632.x).toBe(p0631.x);
    expect(p0632.y).toBe(p0631.y + H + VG);
    expect(overlaps(result)).toEqual([]);
  });

  it('keeps declared sides and puts same-side siblings on one band', () => {
    const nodes: LayoutNodeInput[] = [
      node('root', null, 'root'),
      node('r1', 'root', 'next'),
      node('r2', 'r1', 'next'),
      node('b-left-20', 'r1', 'branch', { side: 'left', order: 20 }),
      node('b-left-10', 'r1', 'branch', { side: 'left', order: 10 }),
      node('b-right-5', 'r2', 'branch', { side: 'right', order: 5 }),
      node('b-right-30', 'root', 'branch', { side: 'right', order: 30 }),
      node('b-missing', 'root', 'branch', { side: 'right' }),
    ];
    const result = layout(nodes);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);

    // 显式 left 必在左侧，且都贴着自己来源所在的 x 轴。
    const rootX = position(result, 'root').x;
    for (const id of ['b-left-10', 'b-left-20']) {
      expect(position(result, id).x + W).toBeLessThan(rootX);
    }
    // 同父兄弟同带：y 都等于来源行，只沿横向逐个外扩一列。
    const r1 = position(result, 'r1');
    const left = ['b-left-10', 'b-left-20'].map((id) => position(result, id));
    expect(left[0]?.y).toBe(r1.y);
    expect(left[1]?.y).toBe(r1.y);
    expect(left[0]?.x).toBeGreaterThanOrEqual((left[1]?.x ?? 0) + W + HG);

    const root = position(result, 'root');
    const right = ['b-right-30', 'b-missing'].map((id) => position(result, id));
    expect(right[0]?.y).toBe(root.y);
    expect(right[1]?.y).toBe(root.y);
    expect(right[1]?.x).toBeGreaterThanOrEqual((right[0]?.x ?? 0) + W + HG);

    // 后续主线节点的分支贴着自己的来源：同带 + 最内可用列。
    const r2y = position(result, 'r2');
    const bRight5 = position(result, 'b-right-5');
    expect(bRight5.x).toBe(right[0]?.x);
    expect(bRight5.y).toBe(r2y.y);
  });

  it('collapses descendants without leaving a gap and reports hidden counts', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('tall', 'r', 'branch', { side: 'right', order: 10 }),
      node('tall-next', 'tall', 'next'),
      node('tall-next2', 'tall-next', 'next'),
      node('other', 'r', 'branch', { side: 'right', order: 20 }),
    ];
    const expanded = layout(nodes);
    const collapsed = layout(nodes, { collapsedNodeIds: ['tall'] });

    expect(collapsed.positions['tall']).toBeDefined();
    expect(collapsed.positions['tall-next']).toBeUndefined();
    expect(collapsed.positions['tall-next2']).toBeUndefined();
    expect(collapsed.hiddenCounts).toEqual({ tall: 2 });
    expect(collapsed.heights['tall-next']).toBeUndefined();

    // 隐藏子树不占位：同带兄弟的入口不动，但整行簇变矮，主线后继随之上移。
    const expandedOtherY = position(expanded, 'other').y;
    const collapsedOtherY = position(collapsed, 'other').y;
    expect(collapsedOtherY).toBe(expandedOtherY);
    expect(collapsedOtherY).toBe(position(collapsed, 'tall').y);
    const collapsedR2 = position(collapsed, 'r2');
    const expandedR2 = position(expanded, 'r2');
    expect(collapsedR2.x).toBe(expandedR2.x);
    expect(collapsedR2.y).toBeLessThan(expandedR2.y);
    expect(collapsedR2.y).toBe(position(collapsed, 'tall').y + H + VG);
    expect(collapsed.bounds.height).toBeLessThan(expanded.bounds.height);


    expect(overlaps(collapsed)).toEqual([]);
    expect(penetrated(collapsed)).toEqual([]);
    expect(collapsed.edgeRoutes.some((item) => item.id === 'tall->tall-next')).toBe(false);
  });

  it('routes a nested branch on the opposite side without crossing cards', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('b', 'r', 'branch', { side: 'right', order: 10 }),
      node('b-next', 'b', 'next'),
      node('b-back', 'b', 'branch', { side: 'left', order: 20 }),
      node('b-back-next', 'b-back', 'next'),
      node('b-far', 'b', 'branch', { side: 'right', order: 30 }),
    ];
    const result = layout(nodes);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    const back = route(result, 'b->b-back');
    expect(back.side).toBe('left');
    const b = position(result, 'b');
    const bBack = position(result, 'b-back');
    // 入口侧成员与出口侧成员共用 head 下方那一条带：入口侧只走一次 Z 形短折，没有干线、没有 join。
    expect(result.branchTrunks.some((item) => item.id === 'b~left')).toBe(false);
    expect(back.join).toBeUndefined();
    // 入口侧出线从同侧边的第二个端口分出（中心下方固定偏移），
    // 父节点连进来的中心行横线仍接目标侧边中心；左右镜像。
    expect(back.points).toEqual([
      { x: b.x, y: b.y + H / 2 + 18 },
      { x: b.x - HG / 2, y: b.y + H / 2 + 18 },
      { x: b.x - HG / 2, y: bBack.y + H / 2 },
      { x: bBack.x + W, y: bBack.y + H / 2 },
    ]);

    // 回头的左枝不能落在 b 的入口行（父节点横线正好在那条带的中心行上，会穿卡），
    // 所以两侧子分支一起落在 b 下方那一条带（rowY[1]，b 是分支节点再下移 24）。
    // 下移 24 = 本条带自己的层级提示；出口侧不再单独占 b 自己那一行。
    expect(position(result, 'b-back').y).toBe(b.y + H + VG + 24);
    expect(position(result, 'b-back').y).not.toBe(b.y);
    // 同级的左右两侧横向读作并列：同一带、同一 y。
    expect(position(result, 'b-far').y).toBe(position(result, 'b-back').y);
  });

  it('puts both sides of a branch on one child band and separates the entry line from the exit line', () => {
    const result = layout([
      node('r', null, 'root'),
      node('br', 'r', 'branch', { side: 'right', order: 10, label: '右支的说明' }),
      node('bl', 'br', 'branch', { side: 'left', order: 10 }),
      node('br2', 'br', 'branch', { side: 'right', order: 20 }),
    ]);
    const br = position(result, 'br');
    const bl = position(result, 'bl');
    const br2 = position(result, 'br2');

    // 同级两个方向横向读作并列：同一带、同一 y，整条带落在父卡下方。
    expect(bl.y).toBe(br2.y);
    expect(bl.y).toBeGreaterThanOrEqual(br.y + H);
    // 左右各在自己一侧。
    expect(bl.x + W).toBeLessThan(br.x);
    expect(br2.x).toBeGreaterThan(br.x + W);

    const into = route(result, 'r->br');
    const out = route(result, 'br->bl');
    // 进入父卡：父卡朝向来源那一侧的中心行；从父卡分出：左支从同侧边中心下方的第二个端口分出。
    expect(into.points[into.points.length - 1]).toEqual({ x: br.x, y: br.y + H / 2 });
    expect(out.points[0]).toEqual({ x: br.x, y: br.y + H / 2 + 18 });
    // 两条线不重合：没有任何一截被画两遍。
    expect(sharedSegments(into.points, out.points)).toEqual([]);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('moves the whole child band with its shared trunk, still leaving from the side second port', () => {
    const result = layout([
      node('r', null, 'root'),
      node('br', 'r', 'branch', { side: 'right', order: 10 }),
      node('bl1', 'br', 'branch', { side: 'left', order: 10 }),
      node('bl2', 'br', 'branch', { side: 'left', order: 20 }),
      node('br1', 'br', 'branch', { side: 'right', order: 30 }),
    ]);
    const br = position(result, 'br');
    // 两侧三个同级成员在同一条带上。
    const bands = new Set(['bl1', 'bl2', 'br1'].map((id) => position(result, id).y));
    expect(bands.size).toBe(1);
    expect(position(result, 'bl1').y).toBeGreaterThan(br.y + H);

    // 多条入口侧成员共用干线，出口同样落在同侧边的第二个端口，且不与进入父卡的线重合。
    const trunk = result.branchTrunks.find((item) => item.id === 'br~left');
    if (trunk === undefined) throw new Error('missing trunk br~left');
    expect(trunk.points[0]).toEqual({ x: br.x, y: br.y + H / 2 + 18 });
    expect(sharedSegments(route(result, 'r->br').points, trunk.points)).toEqual([]);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps a branch-of-branch inner column clear of a longer main spine', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('r3', 'r2', 'next'),
      node('r4', 'r3', 'next'),
      node('h', 'r2', 'branch', { side: 'right', order: 10 }),
      node('h-left', 'h', 'branch', { side: 'left', order: 20 }),
      node('h-left-next', 'h-left', 'next'),
    ];
    const result = layout(nodes);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
    // 内层左枝落在主链右侧的独立通道，不侵入主链卡片。
    const hLeft = position(result, 'h-left');
    const spineRight = position(result, 'r').x + W;
    expect(hLeft.x).toBeGreaterThanOrEqual(spineRight + HG);
  });

  it('is deterministic regardless of input array order and text changes', () => {
    const a = layout(f01);
    const reversed = layout([...f01].reverse());
    const relabeled = layout(f01.map((item) => ({ ...item, label: '任意标签文字', topicId: 'topic-x' })));
    const expected = JSON.stringify(a.positions);
    expect(JSON.stringify(reversed.positions)).toBe(expected);
    expect(JSON.stringify(relabeled.positions)).toBe(expected);
    expect(JSON.stringify(relabeled.edgeRoutes.map((item) => item.points))).toBe(
      JSON.stringify(a.edgeRoutes.map((item) => item.points)),
    );
  });

  it('treats undefined visibleNodeIds as everything and an explicit empty array as nothing', () => {
    expect(Object.keys(layout(f01).positions)).toHaveLength(6);
    expect(Object.keys(layout(f01, { visibleNodeIds: [] }).positions)).toHaveLength(0);
    expect(Object.keys(layout(f01, { collapsedNodeIds: [] }).positions)).toHaveLength(6);
  });

  it('echoes structureVersion and reuses the previous root anchor', () => {
    const first = layout(f01, { structureVersion: 'v1' });
    expect(first.structureVersion).toBe('v1');
    const shifted = layout(f01, { structureVersion: 'v2', previousPositions: { '06': { x: 100, y: 250 } } });
    expect(shifted.positions['06']).toEqual({ x: 100, y: 250 });
    const dx = (shifted.positions['06']?.x ?? 0) - (first.positions['06']?.x ?? 0);
    expect((shifted.positions['07']?.x ?? 0) - (first.positions['07']?.x ?? 0)).toBe(dx);
  });

  it('reports diagnostics for malformed structure without throwing', () => {
    const result = layout([
      { id: 'a', from: null, flow: 'root' },
      { id: 'a', from: null, flow: 'root' },
      { id: 'b', from: 'ghost', flow: 'next' },
      node('c', 'c', 'next'),
    ]);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('duplicate-node-id');
    expect(codes).toContain('unknown-parent');
    expect(codes).toContain('self-parent');
    expect(Object.keys(result.positions).sort()).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty workspace', () => {
    const result = computeLayout({ nodes: [] });
    expect(result.positions).toEqual({});
    expect(result.heights).toEqual({});
    expect(result.edgeRoutes).toEqual([]);
    expect(result.branchTrunks).toEqual([]);
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('reports layoutVersion 4 and heights for every visible node', () => {
    const result = layout(f01);
    expect(result.layoutVersion).toBe(4);
    expect(Object.keys(result.heights).sort()).toEqual(Object.keys(result.positions).sort());
    for (const height of Object.values(result.heights)) expect(height).toBe(H);
    expect(result.cardWidth).toBe(W);
    expect(result.cardHeight).toBe(H);
  });

  it('follows per-card heights for steps, bounds and route endpoints', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root', { height: 152 }),
      node('s2', 'r', 'next', { height: 192 }),
      node('s3', 's2', 'next', { height: 232 }),
      node('s4', 's3', 'next'),
      node('b', 's2', 'branch', { side: 'right', order: 10 }),
    ];
    const result = layout(nodes);
    expect(result.heights).toEqual({ r: 152, s2: 192, s3: 232, s4: 152, b: 152 });

    const r = position(result, 'r');
    const s2 = position(result, 's2');
    const s3 = position(result, 's3');
    const s4 = position(result, 's4');
    expect(s2.y).toBe(r.y + 152 + VG);
    expect(s3.y).toBe(s2.y + 192 + VG);
    expect(s4.y).toBe(s3.y + 232 + VG);

    // next 与 branch 端点都用各自的实际高度。
    const next = route(result, 'r->s2');
    expect(next.points[0]?.y).toBe(r.y + 152);
    expect(next.points[next.points.length - 1]?.y).toBe(s2.y);
    // 单张分支在最内一列、与源中心不同高：走 Z 形短折，出口与落点都用各自的实际高度。
    const target = position(result, 'b');
    const branch = route(result, 's2->b');
    expect(result.branchTrunks).toEqual([]);
    expect(branch.join).toBeUndefined();
    expect(branch.points).toEqual([
      { x: s2.x + W, y: s2.y + 192 / 2 },
      { x: s2.x + W + HG / 2, y: s2.y + 192 / 2 },
      { x: s2.x + W + HG / 2, y: target.y + 152 / 2 },
      { x: target.x, y: target.y + 152 / 2 },
    ]);

    expect(result.bounds.height).toBe(s4.y + 152 - r.y);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });

  it('falls back to cardHeight for invalid height hints', () => {
    const result = layout([
      node('r', null, 'root', { height: -10 }),
      node('s', 'r', 'next', { height: Number.POSITIVE_INFINITY }),
    ]);
    expect(result.heights).toEqual({ r: H, s: H });
    expect(result.diagnostics.map((item) => item.code)).toContain('invalid-node');
  });
});
