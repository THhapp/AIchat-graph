/** Internal working types and shared diagnostics; public contracts stay in types.ts. */
import {
  LAYOUT_VERSION,
  MAX_LAYOUT_DIAGNOSTICS,
  type LayoutDiagnostic,
  type LayoutDiagnosticCode,
  type LayoutFlow,
  type LayoutResult,
  type LayoutSide,
} from './types.js';

export interface LayoutConfig {
  cardWidth: number;
  cardHeight: number;
  verticalGap: number;
  horizontalGap: number;
}

/**
 * 测量与路由共用的带几何常量。
 * 测量侧用它预留走廊高度，路由侧用它还原干线 y；两处必须取同一值。
 */

/** 干线离目标带上沿的距离；带内每嵌套一层再抬高一个 TRUNK_STEP。 */
export const TRUNK_OFFSET = 18;
/**
 * 带内每层的抬升。间距 = 本常量：嵌套带的 NESTED_BAND_OFFSET 位移在算干线 y 时被减回去了，两者不叠加。
 * 14px 低于复核给的 20px 双线阈值，但该拓扑（同带多来源 / 深度≥1 的子干线）在现有数据中为 0 例，
 * 故不为此放大全局行距（本常量同时是走廊高度与 topExtent，一动全局卡片起点位移）。
 * 若将来真出现这类形态，应在嵌套那一处按 parentTrunkY - 20 夹取，而不是抬高这个常量。
 */
export const TRUNK_STEP = 14;
/** 分支块自己的子分支带整体下移的距离，只用于层级提示，不改变带内规则。 */
export const NESTED_BAND_OFFSET = 24;

export interface WorkingNode {
  id: string;
  inputIndex: number;
  flow: LayoutFlow;
  parentId: string | null;
  /** 源记录明确声明的方向；null 表示由布局自动择侧。 */
  declaredSide: LayoutSide | null;
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
