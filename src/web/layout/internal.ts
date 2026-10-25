/** Internal working types and shared diagnostics; public contracts stay in types.ts. */
import {
  LAYOUT_VERSION,
  MAX_LAYOUT_DIAGNOSTICS,
  type LayoutDiagnostic,
  type LayoutDiagnosticCode,
  type LayoutFlow,
  type LayoutResult,
} from './types.js';

export interface LayoutConfig {
  cardWidth: number;
  cardHeight: number;
  verticalGap: number;
  horizontalGap: number;
}

export interface WorkingNode {
  id: string;
  inputIndex: number;
  flow: LayoutFlow;
  parentId: string | null;
  order: number | null;
  /** 实际卡片高度；已按 height 提示或 cardHeight 归一。 */
  height: number;
  label: string | null;
  topicId: string | null;
}

export interface VisibleTree {
  roots: WorkingNode[];
  nextByParent: Map<string, WorkingNode>;
  branchesByParent: Map<string, WorkingNode[]>;
  /** child id -> visible parent id, for edge routes only. */
  parentOf: Map<string, string>;
}

export interface Visibility {
  visible: Set<string>;
  hiddenCounts: Record<string, number>;
}

export interface DiagnosticSink {
  add: (code: LayoutDiagnosticCode, message: string, nodeId?: string) => void;
  finish: () => LayoutDiagnostic[];
}

export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function emptyResult(
  structureVersion: number | string | null,
  config: LayoutConfig,
  diagnostics: LayoutDiagnostic[],
): LayoutResult {
  return {
    positions: {},
    edgeRoutes: [],
    branchTrunks: [],
    hiddenCounts: {},
    diagnostics,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    cardWidth: config.cardWidth,
    cardHeight: config.cardHeight,
    heights: {},
    layoutVersion: LAYOUT_VERSION,
    structureVersion,
  };
}

export function createDiagnosticSink(): DiagnosticSink {
  const items: LayoutDiagnostic[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const add = (code: LayoutDiagnosticCode, message: string, nodeId?: string): void => {
    const key = code + '|' + (nodeId ?? '') + '|' + message;
    if (seen.has(key)) return;
    seen.add(key);
    if (items.length >= MAX_LAYOUT_DIAGNOSTICS) {
      truncated = true;
      return;
    }
    items.push(nodeId === undefined ? { code, message } : { code, message, nodeId });
  };

  const finish = (): LayoutDiagnostic[] => {
    if (!truncated) return items;
    if (items.length >= MAX_LAYOUT_DIAGNOSTICS) items.pop();
    items.push({ code: 'diagnostics-truncated', message: '诊断数量超过上限，其余已省略' });
    return items;
  };

  return { add, finish };
}
