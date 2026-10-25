import {
  computeLayout,
  type LayoutEdgeRoute,
  type LayoutInput,
  type LayoutNodeInput,
  type LayoutPoint,
  type LayoutResult,
  type LayoutPosition,
} from '../../src/web/layout/index.js';
import {
  CARD_WIDTH,
  LAYOUT_BRANCH_SIBLING_GAP,
  LAYOUT_HORIZONTAL_GAP,
  LAYOUT_LABEL_GAP,
  LAYOUT_ROOT_GAP,
  LAYOUT_TRUNK_INSET,
  LAYOUT_VERTICAL_GAP,
} from '../../src/web/graph/cardMetrics.js';

export const W = CARD_WIDTH;
export const VG = LAYOUT_VERTICAL_GAP;
export const HG = LAYOUT_HORIZONTAL_GAP;
export const SIBLING_GAP = LAYOUT_BRANCH_SIBLING_GAP;
export const TRUNK_INSET = LAYOUT_TRUNK_INSET;
export const LABEL_GAP = LAYOUT_LABEL_GAP;
export const ROOT_GAP = LAYOUT_ROOT_GAP;
export const H = 152;

export function node(
  id: string,
  from: string | null,
  flow: 'root' | 'next' | 'branch',
  extra: Partial<LayoutNodeInput> = {},
): LayoutNodeInput {
  return { id, from, flow, ...extra };
}

export function layout(nodes: LayoutNodeInput[], extra: Partial<LayoutInput> = {}): LayoutResult {
  return computeLayout({ ...extra, nodes });
}

export interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface LabelledRect extends Rect {
  lines: string[];
}

export function cardRects(result: LayoutResult): Rect[] {
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

export function overlaps(result: LayoutResult): string[] {
  const list = cardRects(result);
  const found: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a === undefined || b === undefined) continue;
      if (rectsOverlap(a, b)) found.push(a.id + '<->' + b.id);
    }
  }
  return found;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y);
}

/** Strict interior intersection; touching a card edge is allowed for a port. */
export function pointInRect(point: LayoutPoint, rect: Rect): boolean {
  return point.x > rect.x && point.x < rect.right && point.y > rect.y && point.y < rect.bottom;
}

export function segmentCrossesRect(from: LayoutPoint, to: LayoutPoint, rect: Rect): boolean {
  const epsilon = 0.01;
  if (Math.abs(from.y - to.y) < epsilon) {
    if (from.y <= rect.y + epsilon || from.y >= rect.bottom - epsilon) return false;
    const low = Math.min(from.x, to.x);
    const high = Math.max(from.x, to.x);
    return Math.min(high, rect.right - epsilon) > Math.max(low, rect.x + epsilon);
  }
  if (Math.abs(from.x - to.x) < epsilon) {
    if (from.x <= rect.x + epsilon || from.x >= rect.right - epsilon) return false;
    const low = Math.min(from.y, to.y);
    const high = Math.max(from.y, to.y);
    return Math.min(high, rect.bottom - epsilon) > Math.max(low, rect.y + epsilon);
  }
  return false;
}

export function pointsCrossRect(points: LayoutPoint[], rect: Rect): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === undefined || b === undefined) continue;
    if (segmentCrossesRect(a, b, rect)) return true;
  }
  return false;
}

export function routePenetrations(result: LayoutResult): string[] {
  const bad: string[] = [];
  const cards = cardRects(result);
  for (const route of result.edgeRoutes) {
    for (const card of cards) {
      if (card.id === route.from || card.id === route.to) continue;
      if (pointsCrossRect(route.points, card)) bad.push(route.id + ' x ' + card.id);
    }
  }
  for (const trunk of result.branchTrunks) {
    for (const card of cards) {
      if (card.id === trunk.from) continue;
      if (pointsCrossRect(trunk.points, card)) bad.push(trunk.id + ' x ' + card.id);
    }
  }
  return bad;
}

export function labelRects(result: LayoutResult): LabelledRect[] {
  const boxes: LabelledRect[] = [];
  for (const route of result.edgeRoutes) {
    const label = route.label;
    if (label === undefined) continue;
    boxes.push({
      id: route.id,
      x: label.left,
      y: label.top,
      width: label.width,
      height: label.height,
      right: label.left + label.width,
      bottom: label.top + label.height,
      lines: label.lines,
    });
  }
  return boxes;
}

export function labelCardCollisions(result: LayoutResult): string[] {
  const bad: string[] = [];
  for (const label of labelRects(result)) {
    for (const card of cardRects(result)) {
      if (rectsOverlap(label, card)) bad.push(label.id + ' x card ' + card.id);
    }
  }
  return bad;
}

export function labelTrunkCollisions(result: LayoutResult): string[] {
  const bad: string[] = [];
  for (const label of labelRects(result)) {
    for (const trunk of result.branchTrunks) {
      if (pointsCrossRect(trunk.points, label)) bad.push(label.id + ' x trunk ' + trunk.id);
    }
  }
  return bad;
}

export function labelLabelCollisions(result: LayoutResult): string[] {
  const labels = labelRects(result);
  const bad: string[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i];
      const b = labels[j];
      if (a === undefined || b === undefined) continue;
      if (rectsOverlap(a, b)) bad.push(a.id + '<->' + b.id);
    }
  }
  return bad;
}

export function position(result: LayoutResult, id: string): LayoutPosition {
  const found = result.positions[id];
  if (found === undefined) throw new Error('missing position ' + id);
  return found;
}

export function route(result: LayoutResult, id: string): LayoutEdgeRoute {
  const found = result.edgeRoutes.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error('missing route ' + id);
  return found;
}

/** Positive-length collinear overlap between two orthogonal polylines. */
export function sharedSegments(a: LayoutPoint[], b: LayoutPoint[]): string[] {
  const segments = (points: LayoutPoint[]): { left: number; right: number; top: number; bottom: number }[] => {
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
      const horizontal = one.bottom - one.top < 0.01 && other.bottom - other.top < 0.01;
      const vertical = one.right - one.left < 0.01 && other.right - other.left < 0.01;
      if (horizontal && Math.abs(one.top - other.top) < 0.01) {
        if (Math.min(one.right, other.right) - Math.max(one.left, other.left) > 0.01) {
          found.push('horizontal@' + String(one.top));
        }
      } else if (vertical && Math.abs(one.left - other.left) < 0.01) {
        if (Math.min(one.bottom, other.bottom) - Math.max(one.top, other.top) > 0.01) {
          found.push('vertical@' + String(one.left));
        }
      }
    }
  }
  return found;
}
