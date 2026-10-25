import { describe, expect, it } from 'vitest';
import {
  CARD_WIDTH,
  EDGE_LABEL_FONT,
  EDGE_LABEL_PAD_Y,
  LAYOUT_LABEL_GAP,
  LAYOUT_TRUNK_INSET,
  edgeLabelBoxSize,
} from '../../src/web/graph/cardMetrics.js';
import {
  H,
  HG,
  SIBLING_GAP,
  TRUNK_INSET,
  VG,
  W,
  cardRects,
  labelCardCollisions,
  labelLabelCollisions,
  labelRects,
  labelTrunkCollisions,
  layout,
  node,
  position,
  route,
} from './support.js';

const BRANCH_LABEL_WIDTH = HG - TRUNK_INSET - 16;
const NEXT_LABEL_WIDTH = Math.min(240, W - 64);

describe('branch routing and trunks', () => {
  it('draws one shared vertical trunk for several siblings and starts every route on it', () => {
    const result = layout([
      node('r', null, 'root'),
      node('b1', 'r', 'branch', { order: 10 }),
      node('b2', 'r', 'branch', { order: 20 }),
      node('b3', 'r', 'branch', { order: 30 }),
    ]);
    const r = position(result, 'r');
    const b1 = position(result, 'b1');
    const b3 = position(result, 'b3');

    expect(result.branchTrunks).toHaveLength(1);
    const trunk = result.branchTrunks[0];
    if (trunk === undefined) throw new Error('missing shared trunk');
    const sourceEdge = r.x + W;
    const channelX = sourceEdge + TRUNK_INSET;
    expect(trunk.id).toBe('r~branches');
    expect(trunk.from).toBe('r');
    expect(trunk.to).toBe('b3');
    expect(trunk.points).toEqual([
      { x: sourceEdge, y: b1.y + H / 2 },
      { x: channelX, y: b1.y + H / 2 },
      { x: channelX, y: b3.y + H / 2 },
    ]);

    for (const id of ['b1', 'b2', 'b3']) {
      const edge = route(result, 'r->' + id);
      expect(edge.flow).toBe('branch');
      expect(edge.trunkId).toBe(trunk.id);
      expect(edge.points).toHaveLength(2);
      expect(edge.points[0]?.x).toBe(trunk.points[1]?.x);
      const low = Math.min(trunk.points[1]?.y ?? 0, trunk.points[2]?.y ?? 0);
      const high = Math.max(trunk.points[1]?.y ?? 0, trunk.points[2]?.y ?? 0);
      expect(edge.points[0]?.y).toBeGreaterThanOrEqual(low);
      expect(edge.points[0]?.y).toBeLessThanOrEqual(high);
      expect(edge.points[1]).toEqual({ x: position(result, id).x, y: position(result, id).y + H / 2 });
    }
  });

  it('does not emit a trunk for a single branch and starts at the source edge', () => {
    const result = layout([
      node('r', null, 'root'),
      node('b1', 'r', 'branch', { order: 10 }),
    ]);
    const r = position(result, 'r');
    const b1 = position(result, 'b1');
    const edge = route(result, 'r->b1');

    expect(result.branchTrunks).toEqual([]);
    expect(edge.trunkId).toBeUndefined();
    expect(edge.points).toEqual([
      { x: r.x + W, y: r.y + H / 2 },
      { x: b1.x, y: b1.y + H / 2 },
    ]);
  });

  it('keeps a single branch orthogonal when the target centre is outside the source port clamp', () => {
    const result = layout([
      node('r', null, 'root'),
      node('b1', 'r', 'branch', { order: 10, height: 400 }),
    ]);
    const r = position(result, 'r');
    const b1 = position(result, 'b1');
    const edge = route(result, 'r->b1');

    expect(result.branchTrunks).toEqual([]);
    expect(edge.points).toEqual([
      { x: r.x + W, y: r.y + H - 12 },
      { x: r.x + W + TRUNK_INSET, y: r.y + H - 12 },
      { x: r.x + W + TRUNK_INSET, y: b1.y + 200 },
      { x: b1.x, y: b1.y + 200 },
    ]);
  });
});

describe('relation labels', () => {
  it('wraps a long branch label without truncation and lets it reserve sibling space', () => {
    const text = '长标签'.repeat(20);
    const branchHeight = 40;
    const result = layout([
      node('r', null, 'root'),
      node('r2', 'r', 'next'),
      node('b1', 'r', 'branch', { order: 10, height: branchHeight, label: text }),
      node('b2', 'r', 'branch', { order: 20, height: branchHeight, label: text }),
    ]);
    const b1 = position(result, 'b1');
    const b2 = position(result, 'b2');
    const r2 = position(result, 'r2');
    const label1 = route(result, 'r->b1').label;
    const label2 = route(result, 'r->b2').label;
    if (label1 === undefined || label2 === undefined) throw new Error('missing branch labels');

    const size = edgeLabelBoxSize(text, BRANCH_LABEL_WIDTH);
    expect(size.lines.length).toBeGreaterThan(1);
    expect(label1.lines).toEqual(size.lines);
    expect(label1.lines.join('')).toBe(text);
    expect(label1.height).toBe(size.height);
    expect(label1.width).toBe(size.width);
    expect(label1.left).toBe(position(result, 'r').x + W + TRUNK_INSET + 4);
    expect(label1.centerX).toBe(label1.left + label1.width / 2);
    expect(label1.baseline).toBe(label1.top + EDGE_LABEL_PAD_Y + EDGE_LABEL_FONT);

    const topPad = Math.max(0, size.height + LAYOUT_LABEL_GAP - branchHeight / 2);
    expect(b1.y).toBe(topPad);
    expect(label1.top).toBe(0);
    expect(label1.top + label1.height).toBe(b1.y + branchHeight / 2 - LAYOUT_LABEL_GAP);
    expect(b2.y).toBe(branchHeight + topPad * 2 + SIBLING_GAP);
    expect(label2.top).toBe(b2.y + branchHeight / 2 - LAYOUT_LABEL_GAP - label2.height);
    expect(label2.top - (label1.top + label1.height)).toBeGreaterThanOrEqual(SIBLING_GAP - 1e-6);
    // The label sits above its own exclusive entry run instead of covering it.
    const entry1 = position(result, 'b1').y + branchHeight / 2;
    const entryRoute = route(result, 'r->b1');
    expect(entryRoute.points[0]?.y).toBe(entry1);
    expect(label1.top + label1.height).toBeLessThanOrEqual(entry1 - LAYOUT_LABEL_GAP + 1e-6);
    // The main-line successor starts after the complete labelled stack.
    expect(r2.y).toBe(b2.y + branchHeight + VG);

    expect(labelCardCollisions(result)).toEqual([]);
    expect(labelTrunkCollisions(result)).toEqual([]);
    expect(labelLabelCollisions(result)).toEqual([]);
  });

  it('reserves a long next label inside nextGap without touching either card', () => {
    const text = '下一步的关系说明需要完整换行显示'.repeat(8);
    const result = layout([
      node('r', null, 'root'),
      node('s', 'r', 'next', { label: text }),
    ]);
    const r = position(result, 'r');
    const s = position(result, 's');
    const edge = route(result, 'r->s');
    const label = edge.label;
    if (label === undefined) throw new Error('missing next label');

    const size = edgeLabelBoxSize(text, NEXT_LABEL_WIDTH);
    expect(label.lines).toEqual(size.lines);
    expect(label.lines.join('')).toBe(text);
    expect(label.height).toBe(size.height);
    expect(label.top).toBe(r.y + H + LAYOUT_LABEL_GAP);
    expect(label.centerX).toBe(r.x + W / 2);
    expect(label.left).toBe(label.centerX - label.width / 2);
    const nextGap =
      size.height === 0 ? VG : Math.max(VG, size.height + LAYOUT_LABEL_GAP * 2);
    expect(s.y).toBe(r.y + H + nextGap);
    expect(s.y - (label.top + label.height)).toBeGreaterThanOrEqual(LAYOUT_LABEL_GAP - 1e-6);
    expect(edge.points[0]?.y).toBe(r.y + H);
    expect(edge.points[1]?.y).toBe(s.y);

    expect(labelCardCollisions(result)).toEqual([]);
    expect(labelLabelCollisions(result)).toEqual([]);
  });

  it('keeps branch and next labels clear of cards and each other in one mixed structure', () => {
    const branchText = '分支关系说明'.repeat(10);
    const nextText = '主线关系说明'.repeat(10);
    const result = layout([
      node('r', null, 'root'),
      node('r2', 'r', 'next', { label: nextText }),
      node('b1', 'r', 'branch', { order: 10, height: 60, label: branchText }),
      node('b2', 'r', 'branch', { order: 20, height: 80, label: branchText }),
      node('b2n', 'b2', 'next', { label: '枝内继续' }),
    ]);

    const labels = labelRects(result);
    expect(labels.length).toBe(4);
    expect(labelCardCollisions(result)).toEqual([]);
    expect(labelTrunkCollisions(result)).toEqual([]);
    expect(labelLabelCollisions(result)).toEqual([]);
    for (const label of labels) {
      const card = cardRects(result).find((item) => item.id === label.id.split('->')[1]);
      expect(card).toBeDefined();
    }
  });

  it('omits labels when the node has no text', () => {
    const result = layout([
      node('r', null, 'root'),
      node('s', 'r', 'next'),
      node('b', 'r', 'branch', { order: 10, label: '   ' }),
    ]);
    for (const edge of result.edgeRoutes) expect(edge.label).toBeUndefined();
    expect(CARD_WIDTH).toBe(W);
  });
});
