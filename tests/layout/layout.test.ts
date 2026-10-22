import { describe, expect, it } from 'vitest';
import { computeLayout, type LayoutInput, type LayoutNodeInput, type LayoutPosition, type LayoutResult } from '../../src/web/layout/index.js';

const W = 360;
const H = 152;
const VG = 64;
const HG = 88;

function node(id: string, from: string | null, flow: 'root' | 'next' | 'branch', extra: Partial<LayoutNodeInput> = {}): LayoutNodeInput {
  return { id, from, flow, ...extra };
}

/** 06 / 06-03 / 07：branch 进入局部轴，06→07 不受影响。 */
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

function rects(result: LayoutResult): { id: string; x: number; y: number; right: number; bottom: number }[] {
  return Object.entries(result.positions).map(([id, position]) => ({
    id,
    x: position.x,
    y: position.y,
    right: position.x + result.cardWidth,
    bottom: position.y + result.cardHeight,
  }));
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
      let hit = false;
      for (let index = 1; index < route.points.length; index += 1) {
        const a = route.points[index - 1];
        const b = route.points[index];
        if (a === undefined || b === undefined) continue;
        if (Math.abs(a.y - b.y) < 0.01) {
          if (a.y <= rect.y || a.y >= rect.bottom) continue;
          if (Math.min(Math.max(a.x, b.x), rect.right) > Math.max(Math.min(a.x, b.x), rect.x)) hit = true;
        } else if (Math.abs(a.x - b.x) < 0.01) {
          if (a.x <= rect.x || a.x >= rect.right) continue;
          if (Math.min(Math.max(a.y, b.y), rect.bottom) > Math.max(Math.min(a.y, b.y), rect.y)) hit = true;
        }
      }
      if (hit) bad.push(route.id + ' x ' + id);
    }
  }
  return bad;
}

function position(result: LayoutResult, id: string): LayoutPosition {
  const found = result.positions[id];
  if (found === undefined) throw new Error('missing position ' + id);
  return found;
}

describe('computeLayout', () => {
  it('keeps 06 -> 07 as the global next and places 06-03 on a side axis', () => {
    const result = layout(f01);
    expect(result.diagnostics.filter((d) => d.code !== 'duplicate-branch-order')).toEqual([]);

    const p06 = position(result, '06');
    const p07 = position(result, '07');
    const p0603 = position(result, '06-03');
    const p0604 = position(result, '06-04');

    // 全局 next 保持同 x、向下。
    expect(p07.x).toBe(p06.x);
    expect(p07.y).toBe(p06.y + H + VG);

    // 侧枝从右侧进入，自己内部继续向下。
    expect(p0603.x).toBeGreaterThan(p06.x + W);
    expect(p0603.y).toBe(p06.y);
    expect(p0604.x).toBe(p0603.x);
    expect(p0604.y).toBe(p0603.y + H + VG);

    // 06-03 的 next 不会接到 07 上。
    expect(p07.y).toBe(p06.y + H + VG);

    const routes = new Map(result.edgeRoutes.map((route) => [route.id, route]));
    const globalNext = routes.get('06->07');
    expect(globalNext?.flow).toBe('next');
    expect(globalNext?.points).toHaveLength(2);
    const sideEntry = routes.get('06->06-03');
    expect(sideEntry?.flow).toBe('branch');
    expect(sideEntry?.side).toBe('right');
    expect(sideEntry?.points[0]?.x).toBe(p06.x + W);
    expect(sideEntry?.points[0]?.y).toBe(p06.y + H / 2);
    expect(sideEntry?.points[sideEntry.points.length - 1]?.x).toBe(p0603.x);
  });

  it('does not overlap cards or cross body text with routes', () => {
    const result = layout(f01);
    expect(overlaps(result)).toEqual([]);
    expect(penetrated(result)).toEqual([]);
  });

  it('nests a branch of a branch on its own local next axis', () => {
    const p0603 = position(layout(f01), '06-03');
    const result = layout(f01);
    const p0631 = position(result, '06-03-01');
    const p0632 = position(result, '06-03-02');
    expect(p0631.x).toBeGreaterThan(p0603.x + W);
    expect(p0632.x).toBe(p0631.x);
    expect(p0632.y).toBe(p0631.y + H + VG);
    expect(overlaps(result)).toEqual([]);
  });

  it('supports multiple branches on both sides ordered by order', () => {
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
    const left = ['b-left-10', 'b-left-20'].map((id) => position(result, id));
    expect(left[0]?.y).toBeLessThan(left[1]?.y ?? -1);
    const right = ['b-right-30', 'b-missing'].map((id) => position(result, id));
    expect(right[0]?.y).toBeLessThan(right[1]?.y ?? -1);
    expect(position(result, 'b-right-30').x).toBe(position(result, 'b-missing').x);
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

    // 隐藏子树不占位：同侧后续分支上移，而不是留下空槽。
    const expandedOtherY = position(expanded, 'other').y;
    const collapsedOtherY = position(collapsed, 'other').y;
    expect(collapsedOtherY).toBeLessThan(expandedOtherY);
    expect(collapsedOtherY).toBe(position(collapsed, 'tall').y + H + VG);

    // 折叠不影响主链本身。
    expect(position(collapsed, 'r2')).toEqual(position(expanded, 'r2'));

    expect(overlaps(collapsed)).toEqual([]);
    expect(penetrated(collapsed)).toEqual([]);
    expect(collapsed.edgeRoutes.some((route) => route.id === 'tall->tall-next')).toBe(false);
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
    const route = result.edgeRoutes.find((candidate) => candidate.id === 'b->b-back');
    expect(route?.side).toBe('left');
    expect(route?.points[0]?.x).toBe(position(result, 'b').x);
    expect(route?.points[route.points.length - 1]?.x).toBe(position(result, 'b-back').x + W);
  });

  it('keeps a branch-of-branch inner lane clear of a longer main spine', () => {
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
    expect(JSON.stringify(relabeled.edgeRoutes.map((route) => route.points))).toBe(JSON.stringify(a.edgeRoutes.map((route) => route.points)));
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
    expect(result.edgeRoutes).toEqual([]);
    expect(result.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
