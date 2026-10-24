import { describe, expect, it } from 'vitest';
import { computeLayout, type LayoutNodeInput, type LayoutResult } from '../../src/web/layout/index.js';

/**
 * 复杂结构的几何不变量：同带放置 + 走廊绕行在任意拓扑下都必须保持
 * 零重叠、零穿卡，并且结构版本与高度覆盖不变。
 */

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
    return { id, x: position.x, y: position.y, right: position.x + result.cardWidth, bottom: position.y + height };
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
  // 共享干线只画一次，但同样不能穿卡。
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

/** 折线里所有线段都必须纯水平或纯垂直。 */
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

/** 固定种子的确定性伪随机，保证测试可复现。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 随机父节点 + 随机侧别 + 随机行高，覆盖深链、再分支与跨行柱。
 * 每个来源最多一个 next，branch.order 唯一，保证结构本身与输入顺序无关。
 */
function build(seed: number): LayoutNodeInput[] {
  const next = random(seed);
  const nodes: LayoutNodeInput[] = [{ id: 'n0', from: null, flow: 'root', height: 120 + Math.floor(next() * 160) }];
  const ids = ['n0'];
  const hasNext = new Set<string>();
  const count = 12 + Math.floor(next() * 10);
  for (let index = 1; index < count; index += 1) {
    const parent = ids[Math.floor(next() * ids.length)] ?? 'n0';
    const id = 'n' + String(index);
    const height = 120 + Math.floor(next() * 160);
    if (next() < 0.4 && !hasNext.has(parent)) {
      hasNext.add(parent);
      nodes.push({ id, from: parent, flow: 'next', height });
    } else {
      const side = next() < 0.5 ? 'left' : 'right';
      const siblings = nodes.filter((item) => item.from === parent && item.flow === 'branch').length;
      nodes.push({ id, from: parent, flow: 'branch', side, order: siblings + 1, height });
    }
    ids.push(id);
  }
  return nodes;
}

describe('geometry invariants on dense structures', () => {
  it('keeps cards and routes apart for every seeded structure', () => {
    const report: string[] = [];
    for (let seed = 1; seed <= 80; seed += 1) {
      const nodes = build(seed);
      const result = computeLayout({ nodes });
      const bad = [...overlaps(result), ...penetrated(result), ...diagonals(result)];
      if (bad.length > 0) report.push('seed ' + String(seed) + ': ' + bad.join(', '));
      expect(Object.keys(result.heights).sort()).toEqual(Object.keys(result.positions).sort());
      expect(result.layoutVersion).toBe(4);
      // 整组下移必须留诊断，不能静默挪动。
      const shifted = result.diagnostics.filter((item) => item.code === 'branch-band-shifted');
      for (const item of shifted) expect(item.nodeId).toBeDefined();
      // 干线必须是合法分组：同源同侧唯一，成员都有 join。
      expect(new Set(result.branchTrunks.map((trunk) => trunk.id)).size).toBe(result.branchTrunks.length);
      for (const trunk of result.branchTrunks) {
        expect(trunk.id).toBe(trunk.from + '~' + trunk.side);
        const members = result.edgeRoutes.filter(
          (edge) => edge.flow === 'branch' && edge.from === trunk.from && edge.side === trunk.side,
        );
        for (const edge of members) expect(edge.join).toBeDefined();
      }
      // 成员必须都在同一条带上，干线才能只按一个 bandY 预留走廊。
      for (const trunk of result.branchTrunks) {
        const members = result.edgeRoutes.filter(
          (edge) => edge.flow === 'branch' && edge.from === trunk.from && edge.side === trunk.side,
        );
        const bands = new Set(members.map((edge) => result.positions[edge.to]?.y));
        if (bands.size > 1) report.push('seed ' + String(seed) + ': 干线 ' + trunk.id + ' 跨多条带');
        // 接出点各在自己的列，同组内不重合，否则竖支线会叠画。
        const drops = members.map((edge) => edge.join?.x);
        if (new Set(drops).size !== drops.length) {
          report.push('seed ' + String(seed) + ': 干线 ' + trunk.id + ' 的接出点重合');
        }
      }
      // 同一 y 上的两条干线不能横向重叠，否则共享段被叠画。
      const spans = new Map<number, { id: string; low: number; high: number }[]>();
      for (const trunk of result.branchTrunks) {
        const xs = trunk.points.filter((point) => Math.abs(point.y - trunk.trunkY) < 0.01).map((point) => point.x);
        if (xs.length < 2) continue;
        const span = { id: trunk.id, low: Math.min(...xs), high: Math.max(...xs) };
        for (const other of spans.get(trunk.trunkY) ?? []) {
          if (other.high > span.low && span.high > other.low) {
            report.push(
              'seed ' + String(seed) + ': 干线 ' + other.id + ' 与 ' + span.id + ' 在 y=' + String(trunk.trunkY) + ' 重叠',
            );
          }
        }
        spans.set(trunk.trunkY, [...(spans.get(trunk.trunkY) ?? []), span]);
      }
    }
    expect(report).toEqual([]);
  });

  it('is order independent on dense structures', () => {
    for (const seed of [3, 17, 42, 64]) {
      const nodes = build(seed);
      const forward = computeLayout({ nodes });
      const reversed = computeLayout({ nodes: [...nodes].reverse() });
      expect(reversed.positions).toEqual(forward.positions);
      expect(reversed.edgeRoutes.map((edge) => edge.points)).toEqual(forward.edgeRoutes.map((edge) => edge.points));
      expect(reversed.branchTrunks).toEqual(forward.branchTrunks);
    }
  });
});
