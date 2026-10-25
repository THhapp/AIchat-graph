import { describe, expect, it } from 'vitest';
import type { LayoutNodeInput } from '../../src/web/layout/index.js';
import { H, HG, SIBLING_GAP, VG, W, layout, node, overlaps, position, route, routePenetrations } from './support.js';

describe('chain blocks', () => {
  it('stacks two same-source branches by order, shares one x and starts next only after both', () => {
    const result = layout([
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('b1', 'r', 'branch', { order: 10 }),
      node('b1n', 'b1', 'next'),
      node('b2', 'r', 'branch', { order: 20 }),
    ]);

    const r = position(result, 'r');
    const b1 = position(result, 'b1');
    const b1n = position(result, 'b1n');
    const b2 = position(result, 'b2');
    const r2 = position(result, 'r2');

    expect(b1.x).toBe(r.x + W + HG);
    expect(b2.x).toBe(b1.x);
    expect(b1n.x).toBe(b1.x);
    // b1's whole chain (head + next) forms its block; b2 starts below it.
    expect(b1n.y).toBe(b1.y + H + VG);
    expect(b2.y).toBe(b1.y + H + VG + H + SIBLING_GAP);
    // The main-line successor starts below the complete branch stack.
    expect(r2.y).toBe(b2.y + H + VG);
    expect(r2.x).toBe(r.x);

    const reversed = layout([
      node('b2', 'r', 'branch', { order: 20 }),
      node('b1n', 'b1', 'next'),
      node('b1', 'r', 'branch', { order: 10 }),
      node('r2', 'r', 'next'),
      node('r', null, 'root'),
    ]);
    expect(reversed.positions).toEqual(result.positions);
    expect(result.diagnostics).toEqual([]);
    expect(overlaps(result)).toEqual([]);
    expect(routePenetrations(result)).toEqual([]);
  });

  it('keeps stable branch order: order ascending, missing order last, ties by id', () => {
    const result = layout([
      node('r', null, 'root'),
      node('b-late', 'r', 'branch', { order: 20 }),
      node('b-missing-z', 'r', 'branch'),
      node('b-early', 'r', 'branch', { order: 10 }),
      node('b-missing-a', 'r', 'branch'),
    ]);
    const order = ['b-early', 'b-late', 'b-missing-a', 'b-missing-z'];
    const ys = order.map((id) => position(result, id).y);
    expect(ys).toEqual([0, 192, 384, 576]);
    expect(new Set(order.map((id) => position(result, id).x)).size).toBe(1);
  });

  it('branches from a real mid-chain node and continues the original next below it', () => {
    const result = layout([
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('b', 'r', 'branch', { order: 10 }),
      node('bn', 'b', 'next'),
      node('bn2', 'bn', 'next'),
      node('c', 'bn', 'branch', { order: 10 }),
      node('cn', 'c', 'next'),
    ]);
    const b = position(result, 'b');
    const bn = position(result, 'bn');
    const bn2 = position(result, 'bn2');
    const c = position(result, 'c');
    const cn = position(result, 'cn');
    const r2 = position(result, 'r2');

    expect(c.x).toBe(b.x + W + HG);
    expect(bn2.x).toBe(b.x);
    expect(c.y).toBe(bn.y);
    expect(cn.y).toBe(c.y + H + VG);
    // The original branch chain's next continues below the complete c block.
    expect(bn2.y).toBe(bn.y + H + VG + H + VG);
    // The global main line waits for the whole branch block.
    expect(r2.y).toBe(bn2.y + H + VG);

    const childRoute = route(result, 'bn->c');
    expect(childRoute.from).toBe('bn');
    expect(childRoute.to).toBe('c');
    expect(childRoute.trunkId).toBeUndefined();
    expect(childRoute.points[childRoute.points.length - 1]).toEqual({
      x: c.x,
      y: c.y + H / 2,
    });
    expect(overlaps(result)).toEqual([]);
    expect(routePenetrations(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('pushes only lower siblings and the main line when a sibling grows', () => {
    const base: LayoutNodeInput[] = [
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('b1', 'r', 'branch', { order: 10 }),
      node('b2', 'r', 'branch', { order: 20 }),
    ];
    const grownLower = layout([...base, node('b2n', 'b2', 'next')]);
    const grownUpper = layout([...base, node('b1n', 'b1', 'next')]);

    const before = layout(base);
    expect(position(grownLower, 'b1')).toEqual(position(before, 'b1'));
    expect(position(grownLower, 'b2')).toEqual(position(before, 'b2'));
    expect(position(grownLower, 'b2n').y).toBe(position(grownLower, 'b2').y + H + VG);
    expect(position(grownLower, 'r2').y).toBeGreaterThan(position(before, 'r2').y);

    expect(position(grownUpper, 'b1')).toEqual(position(before, 'b1'));
    expect(position(grownUpper, 'b2').y).toBeGreaterThan(position(before, 'b2').y);
    expect(position(grownUpper, 'r2').y).toBeGreaterThan(position(before, 'r2').y);

    expect(overlaps(grownLower)).toEqual([]);
    expect(overlaps(grownUpper)).toEqual([]);
    expect(routePenetrations(grownLower)).toEqual([]);
    expect(routePenetrations(grownUpper)).toEqual([]);
  });

  it('ignores a source side value: every branch still unfolds to the right', () => {
    const leftSide = { ...node('bl', 'r', 'branch', { order: 10 }), side: 'left' } as LayoutNodeInput;
    const result = layout([node('r', null, 'root'), leftSide]);
    expect(position(result, 'bl').x).toBe(position(result, 'r').x + W + HG);
    expect(routePenetrations(result)).toEqual([]);
  });
});
