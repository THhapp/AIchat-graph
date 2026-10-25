import { describe, expect, it } from 'vitest';
import type { LayoutNodeInput, LayoutResult } from '../../src/web/layout/index.js';
import {
  CARD_BASE_HEIGHT,
  CARD_WIDTH,
  LAYOUT_HORIZONTAL_GAP,
  LAYOUT_VERTICAL_GAP,
  cardHeightForTitle,
} from '../../src/web/graph/cardMetrics.js';
import {
  cardRects,
  labelCardCollisions,
  labelLabelCollisions,
  labelRects,
  labelTrunkCollisions,
  layout,
  overlaps,
  routePenetrations,
} from './support.js';

/** Fixed-seed deterministic pseudo-random, so failures are reproducible. */
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
  for (const edge of result.edgeRoutes) scan(edge.id, edge.points);
  for (const trunk of result.branchTrunks) scan(trunk.id, trunk.points);
  return bad;
}

/**
 * Random but valid structure: one root, at most one next per parent, unique
 * branch orders per parent, parents always chosen from earlier nodes so the
 * relation graph cannot contain a cycle.
 */
function build(seed: number): LayoutNodeInput[] {
  const next = random(seed);
  const nodes: LayoutNodeInput[] = [
    { id: 'n0', from: null, flow: 'root', height: 100 + Math.floor(next() * 180) },
  ];
  const ids = ['n0'];
  const hasNext = new Set<string>();
  const branchCount = new Map<string, number>();
  const count = 14 + Math.floor(next() * 10);
  for (let index = 1; index < count; index += 1) {
    const parent = ids[Math.floor(next() * ids.length)] ?? 'n0';
    const id = 'n' + String(index);
    const height = 80 + Math.floor(next() * 200);
    const label = next() < 0.45 ? '关系说明'.repeat(1 + Math.floor(next() * 7)) : undefined;
    if (next() < 0.42 && !hasNext.has(parent)) {
      hasNext.add(parent);
      nodes.push({ id, from: parent, flow: 'next', height, ...(label === undefined ? {} : { label }) });
    } else {
      const order = (branchCount.get(parent) ?? 0) + 1;
      branchCount.set(parent, order);
      nodes.push({
        id,
        from: parent,
        flow: 'branch',
        order,
        height,
        ...(label === undefined ? {} : { label }),
      });
    }
    ids.push(id);
  }
  return nodes;
}

describe('geometry invariants on dense structures', () => {
  it('keeps cards, routes, trunks and labels apart for every seeded structure', () => {
    const report: string[] = [];
    for (let seed = 1; seed <= 60; seed += 1) {
      const nodes = build(seed);
      const result = layout(nodes);
      const problems = [
        ...overlaps(result),
        ...routePenetrations(result),
        ...diagonals(result),
        ...labelCardCollisions(result),
        ...labelTrunkCollisions(result),
        ...labelLabelCollisions(result),
      ];
      if (problems.length > 0) report.push('seed ' + String(seed) + ': ' + problems.join(', '));
      expect(Object.keys(result.heights).sort()).toEqual(Object.keys(result.positions).sort());
      expect(result.layoutVersion).toBe(5);
      expect(result.diagnostics).toEqual([]);
      for (const label of labelRects(result)) {
        expect(label.x).toBeGreaterThanOrEqual(result.bounds.x);
        expect(label.y).toBeGreaterThanOrEqual(result.bounds.y);
        expect(label.right).toBeLessThanOrEqual(result.bounds.x + result.bounds.width + 1e-6);
        expect(label.bottom).toBeLessThanOrEqual(result.bounds.y + result.bounds.height + 1e-6);
      }
      for (const card of cardRects(result)) {
        expect(card.right).toBeLessThanOrEqual(result.bounds.x + result.bounds.width + 1e-6);
        expect(card.bottom).toBeLessThanOrEqual(result.bounds.y + result.bounds.height + 1e-6);
      }
      // Trunks are one per source with more than one visible branch.
      expect(new Set(result.branchTrunks.map((trunk) => trunk.id)).size).toBe(result.branchTrunks.length);
      for (const trunk of result.branchTrunks) {
        expect(trunk.id).toBe(trunk.from + '~branches');
        const members = result.edgeRoutes.filter((edge) => edge.trunkId === trunk.id);
        expect(members.length).toBeGreaterThan(1);
        for (const edge of members) expect(edge.points[0]?.x).toBe(trunk.points[1]?.x);
      }
    }
    expect(report).toEqual([]);
  });

  it('is input-order independent on dense structures', () => {
    for (const seed of [3, 17, 42, 64]) {
      const nodes = build(seed);
      const forward = layout(nodes);
      const reversed = layout([...nodes].reverse());
      expect(reversed.positions).toEqual(forward.positions);
      expect(reversed.edgeRoutes.map((edge) => edge.points)).toEqual(forward.edgeRoutes.map((edge) => edge.points));
      expect(reversed.branchTrunks).toEqual(forward.branchTrunks);
      expect(reversed.heights).toEqual(forward.heights);
    }
  });
});

/**
 * Production parameters: the live and offline readers pass cardMetrics values
 * and per-card title heights, not the layout defaults.
 */
describe('production card metrics contract', () => {
  it('keeps the right-hand branch layout apart with live gaps and per-card heights', () => {
    const titles: Record<string, string> = {
      p: '根节点',
      n: '主线二：需要换行才能完整显示的较长标题',
      b1: '第一条分支的标题足够长，占三行也不会被裁切',
      b2: '第二条分支',
      b1n: '枝内后续',
      b1b: '枝内再分支',
    };
    const shape: Omit<LayoutNodeInput, 'height'>[] = [
      { id: 'p', from: null, flow: 'root' },
      { id: 'n', from: 'p', flow: 'next' },
      { id: 'b1', from: 'n', flow: 'branch', order: 10 },
      { id: 'b2', from: 'n', flow: 'branch', order: 20 },
      { id: 'b1n', from: 'b1', flow: 'next' },
      { id: 'b1b', from: 'b1', flow: 'branch', order: 10, label: '枝内关系说明需要换行' },
    ];
    const nodes: LayoutNodeInput[] = shape.map((item) => ({
      ...item,
      height: cardHeightForTitle(titles[item.id] ?? ''),
    }));
    const input = {
      nodes,
      visibleNodeIds: nodes.map((item) => item.id),
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_BASE_HEIGHT,
      verticalGap: LAYOUT_VERTICAL_GAP,
      horizontalGap: LAYOUT_HORIZONTAL_GAP,
      structureVersion: 'production-contract',
    };

    const result = layout(nodes, input);
    expect(result.cardWidth).toBe(CARD_WIDTH);
    expect(result.cardHeight).toBe(CARD_BASE_HEIGHT);
    for (const item of nodes) {
      expect(result.heights[item.id]).toBe(cardHeightForTitle(titles[item.id] ?? ''));
    }
    expect(result.structureVersion).toBe('production-contract');
    expect([...overlaps(result), ...routePenetrations(result), ...diagonals(result)]).toEqual([]);
    expect([...labelCardCollisions(result), ...labelTrunkCollisions(result), ...labelLabelCollisions(result)]).toEqual(
      [],
    );

    const again = layout(nodes, input);
    expect(again.positions).toEqual(result.positions);
    const reversed = layout([...nodes].reverse(), input);
    expect(reversed.positions).toEqual(result.positions);
    expect(reversed.edgeRoutes.map((edge) => edge.points)).toEqual(result.edgeRoutes.map((edge) => edge.points));
    expect(reversed.branchTrunks).toEqual(result.branchTrunks);
  });
});
