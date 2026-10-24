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

export interface BlockNode {
  node: WorkingNode;
  x: number;
  y: number;
}

export interface Block {
  width: number;
  /** head 卡的实际高度；同带落位按它判断卡片占用。 */
  headHeight: number;
  /** 全块最低边界（head 为原点，向下为正）。 */
  bottom: number;
  /** head 上方需要预留的走廊高度，供父 block 判断落位。 */
  topExtent: number;
  /**
   * 本块 head 所在带的分组嵌套深度：0 表示这条带上只有父组一层，
   * 成员自己在带内再分支时再加一层。干线按它逐层抬高，同带上的组不共线。
   */
  bandDepth: number;
  nodes: BlockNode[];
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

export interface MeasureContext {
  nextByParent: Map<string, WorkingNode>;
  branchesByParent: Map<string, WorkingNode[]>;
  config: LayoutConfig;
  diagnostics: DiagnosticSink;
  memo: Map<string, Block>;
  visiting: Set<string>;
  /** 每个 branch 的实际落位方向（显式或自动），路由与界面提示复用。 */
  sides: Map<string, LayoutSide>;
  /** 并列分组深度：`${from}~${side}` -> 该组在带内的嵌套层数（父组为 0）。 */
  groupDepths: Map<string, number>;
  /** branch 节点在父 block 内落到的列（从 1 起，越靠近主脊越小）。 */
  columns: Map<string, number>;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
