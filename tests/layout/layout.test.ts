import { describe, expect, it } from 'vitest';
import { computeLayout, type LayoutNodeInput } from '../../src/web/layout/index.js';
import {
  H,
  ROOT_GAP,
  VG,
  cardRects,
  labelRects,
  layout,
  node,
  overlaps,
  position,
  route,
  routePenetrations,
} from './support.js';

describe('computeLayout v5', () => {
  it('keeps a pure next chain on one x axis and advances by card height + gap', () => {
    const result = layout([
      node('r', null, 'root'),
      node('s1', 'r', 'next'),
      node('s2', 's1', 'next'),
    ]);
    const r = position(result, 'r');
    const s1 = position(result, 's1');
    const s2 = position(result, 's2');

    expect(s1.x).toBe(r.x);
    expect(s2.x).toBe(r.x);
    expect(s1.y).toBe(r.y + H + VG);
    expect(s2.y).toBe(s1.y + H + VG);
    expect(route(result, 'r->s1').points).toEqual([
      { x: r.x + 180, y: r.y + H },
      { x: s1.x + 180, y: s1.y },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(overlaps(result)).toEqual([]);
  });

  it('moves positions, routes, trunks and labels together for the previous root anchor', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('r2', 'r', 'next', { label: '继续向下' }),
      node('b1', 'r', 'branch', { order: 10, label: '分支一' }),
      node('b2', 'r', 'branch', { order: 20, label: '分支二' }),
    ];
    const first = layout(nodes);
    const shifted = layout(nodes, { previousPositions: { r: { x: 100, y: 250 } } });
    const dx = 100 - (first.positions['r']?.x ?? 0);
    const dy = 250 - (first.positions['r']?.y ?? 0);

    for (const [id, point] of Object.entries(first.positions)) {
      expect(shifted.positions[id]).toEqual({ x: point.x + dx, y: point.y + dy });
    }
    expect(shifted.positions['r']).toEqual({ x: 100, y: 250 });
    for (let index = 0; index < first.edgeRoutes.length; index += 1) {
      const before = first.edgeRoutes[index];
      const after = shifted.edgeRoutes[index];
      if (before === undefined || after === undefined) continue;
      expect(after.points).toEqual(before.points.map((point) => ({ x: point.x + dx, y: point.y + dy })));
      if (before.label === undefined) {
        expect(after.label).toBeUndefined();
      } else if (after.label !== undefined) {
        expect(after.label.left).toBe(before.label.left + dx);
        expect(after.label.top).toBe(before.label.top + dy);
        expect(after.label.baseline).toBe(before.label.baseline + dy);
      }
    }
    expect(shifted.branchTrunks[0]?.points).toEqual(
      first.branchTrunks[0]?.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
    );
  });

  it('collapses descendants without reserving their space and restores the geometry on expand', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('b1', 'r', 'branch', { order: 10 }),
      node('b1n', 'b1', 'next'),
      node('b2', 'r', 'branch', { order: 20 }),
    ];
    const expanded = layout(nodes);
    const collapsed = layout(nodes, { collapsedNodeIds: ['b1'] });
    const restored = layout(nodes);

    expect(collapsed.positions['b1']).toBeDefined();
    expect(collapsed.positions['b1n']).toBeUndefined();
    expect(collapsed.heights['b1n']).toBeUndefined();
    expect(collapsed.hiddenCounts).toEqual({ b1: 1 });

    // The upper sibling head does not move; the lower sibling and the main-line
    // successor move up because the hidden chain no longer occupies space.
    expect(position(collapsed, 'b1')).toEqual(position(expanded, 'b1'));
    expect(position(collapsed, 'b2').y).toBeLessThan(position(expanded, 'b2').y);
    expect(position(collapsed, 'r2').y).toBeLessThan(position(expanded, 'r2').y);
    expect(collapsed.bounds.height).toBeLessThan(expanded.bounds.height);
    expect(restored.positions).toEqual(expanded.positions);
    expect(restored.edgeRoutes).toEqual(expanded.edgeRoutes);
    expect(overlaps(collapsed)).toEqual([]);
    expect(routePenetrations(collapsed)).toEqual([]);
    expect(collapsed.edgeRoutes.some((edge) => edge.id === 'b1->b1n')).toBe(false);
  });

  it('uses each card height for branch heads, next steps and route endpoints', () => {
    const result = layout([
      node('r', null, 'root', { height: 152 }),
      node('s2', 'r', 'next', { height: 192 }),
      node('s3', 's2', 'next', { height: 232 }),
      node('s4', 's3', 'next', { height: 152 }),
      node('b', 's2', 'branch', { order: 10, height: 200 }),
    ]);
    expect(result.heights).toEqual({ r: 152, s2: 192, s3: 232, s4: 152, b: 200 });

    const r = position(result, 'r');
    const s2 = position(result, 's2');
    const s3 = position(result, 's3');
    const s4 = position(result, 's4');
    const b = position(result, 'b');

    expect(s2.y).toBe(r.y + 152 + VG);
    expect(b.y).toBe(s2.y);
    // The branch card is taller than s2, so the branch region (not just s2)
    // determines where the next main-line card starts.
    expect(s3.y).toBe(s2.y + 200 + VG);
    expect(s4.y).toBe(s3.y + 232 + VG);

    const rToS2 = route(result, 'r->s2');
    expect(rToS2.points[0]?.y).toBe(r.y + 152);
    expect(rToS2.points[rToS2.points.length - 1]?.y).toBe(s2.y);
    const s2ToB = route(result, 's2->b');
    expect(s2ToB.points).toEqual([
      { x: s2.x + 180 + 180, y: s2.y + 200 / 2 },
      { x: b.x, y: b.y + 200 / 2 },
    ]);
    expect(result.branchTrunks).toEqual([]);
    expect(overlaps(result)).toEqual([]);
    expect(routePenetrations(result)).toEqual([]);
  });

  it('is deterministic under input reversal and label text changes of equal height', () => {
    const nodes: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('b1', 'r', 'branch', { order: 10, label: '关系说明甲' }),
      node('b2', 'r', 'branch', { order: 20, label: '关系说明乙' }),
      node('b2n', 'b2', 'next'),
    ];
    const base = layout(nodes);
    const reversed = layout([...nodes].reverse());
    const relabeled = layout(
      nodes.map((item) => ({ ...item, label: item.label === undefined ? item.label : '另一段说明' })),
    );

    expect(reversed.positions).toEqual(base.positions);
    expect(reversed.edgeRoutes.map((edge) => edge.points)).toEqual(base.edgeRoutes.map((edge) => edge.points));
    expect(reversed.branchTrunks).toEqual(base.branchTrunks);
    expect(relabeled.positions).toEqual(base.positions);
    expect(relabeled.edgeRoutes.map((edge) => edge.points)).toEqual(base.edgeRoutes.map((edge) => edge.points));
    expect(relabeled.edgeRoutes.map((edge) => edge.label?.lines)).not.toEqual(
      base.edgeRoutes.map((edge) => edge.label?.lines),
    );
  });

  it('reports layoutVersion 5, heights for all positions and bounds containing every label', () => {
    const result = layout([
      node('r', null, 'root'),
      node('r2', 'r', 'next', { label: '下一步的关系说明' }),
      node('b1', 'r', 'branch', { order: 10, label: '分支一的关系说明' }),
      node('b2', 'r', 'branch', { order: 20, label: '分支二的关系说明' }),
    ]);
    expect(result.layoutVersion).toBe(5);
    expect(Object.keys(result.heights).sort()).toEqual(Object.keys(result.positions).sort());
    const labels = labelRects(result);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    for (const label of labels) {
      expect(label.x).toBeGreaterThanOrEqual(result.bounds.x);
      expect(label.y).toBeGreaterThanOrEqual(result.bounds.y);
      expect(label.right).toBeLessThanOrEqual(result.bounds.x + result.bounds.width + 1e-6);
      expect(label.bottom).toBeLessThanOrEqual(result.bounds.y + result.bounds.height + 1e-6);
    }
    for (const card of cardRects(result)) {
      expect(card.x).toBeGreaterThanOrEqual(result.bounds.x);
      expect(card.y).toBeGreaterThanOrEqual(result.bounds.y);
      expect(card.right).toBeLessThanOrEqual(result.bounds.x + result.bounds.width + 1e-6);
      expect(card.bottom).toBeLessThanOrEqual(result.bounds.y + result.bounds.height + 1e-6);
    }
  });

  it('stacks top-level forest blocks at x = 0 with the root gap', () => {
    const result = layout([
      node('z-root', null, 'root'),
      node('a-root', null, 'root'),
    ]);
    expect(position(result, 'a-root')).toEqual({ x: 0, y: 0 });
    expect(position(result, 'z-root')).toEqual({ x: 0, y: H + ROOT_GAP });
    expect(result.diagnostics.map((item) => item.code)).toContain('multiple-roots');
    expect(result.bounds.width).toBe(360);
  });

  it('treats undefined visibleNodeIds as everything and an explicit empty array as nothing', () => {
    const nodes: LayoutNodeInput[] = [node('r', null, 'root'), node('r2', 'r', 'next')];
    expect(Object.keys(layout(nodes).positions)).toHaveLength(2);
    expect(Object.keys(layout(nodes, { visibleNodeIds: [] }).positions)).toHaveLength(0);
    expect(Object.keys(layout(nodes, { collapsedNodeIds: [] }).positions)).toHaveLength(2);
  });

  it('reports diagnostics for malformed structures without throwing', () => {
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
    expect(result.positions['a']).toBeDefined();
  });

  it('handles an empty workspace and invalid heights', () => {
    const empty = computeLayout({ nodes: [] });
    expect(empty.positions).toEqual({});
    expect(empty.heights).toEqual({});
    expect(empty.edgeRoutes).toEqual([]);
    expect(empty.branchTrunks).toEqual([]);
    expect(empty.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(empty.layoutVersion).toBe(5);

    const fallback = layout([
      node('r', null, 'root', { height: -10 }),
      node('s', 'r', 'next', { height: Number.POSITIVE_INFINITY }),
    ]);
    expect(fallback.heights).toEqual({ r: 152, s: 152 });
    expect(fallback.diagnostics.map((item) => item.code)).toContain('invalid-node');
  });
});
