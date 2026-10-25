/**
 * Layout 模块的纯结构契约。
 *
 * 只消费已校验的最小结构，不复制 core 的主题/正文 schema，也不依赖
 * React、React Flow、Node 或文件系统。文本字段只通过 label 参与几何：
 * 关系文字需要预留标签框，不读取标题或正文。
 */
import {
  CARD_WIDTH,
  LAYOUT_HORIZONTAL_GAP,
  LAYOUT_VERTICAL_GAP,
  LAYOUT_VERSION,
} from '../graph/cardMetrics.js';

export { LAYOUT_VERSION };

export type LayoutFlow = 'root' | 'next' | 'branch';

/** layout 接收的最小节点结构；其他业务字段会被忽略。 */
export interface LayoutNodeInput {
  id: string;
  /** 有效输入中 root 为 null，其余节点为工作区内的父节点 ID。 */
  from?: string | null | undefined;
  flow: LayoutFlow;
  /** 仅 branch：同源兄弟的稳定顺序；缺失时按 ID 排在后面。 */
  order?: number | null | undefined;
  /**
   * 卡片高度提示（px）。布局只把它当作几何量，绝不从标题/正文推导。
   * 非法值回退 cardHeight。
   */
  height?: number | null | undefined;
  /** 该节点入边的关系文字；参与标签框与纵向间距，不截断。 */
  label?: string | null | undefined;
  /** 保留字段；当前不输出主题框，不参与坐标。 */
  topicId?: string | null | undefined;
}

export interface LayoutPoint {
  x: number;
  y: number;
}

/** 卡片左上角坐标。 */
export interface LayoutPosition extends LayoutPoint {}

export interface LayoutRect extends LayoutPoint {
  width: number;
  height: number;
}

export interface LayoutLabelBox extends LayoutRect {
  /** Same value as `x`; provided for the label contract used by the reader. */
  left: number;
  /** Same value as `y`; provided for the label contract used by the reader. */
  top: number;
  /** 完整折行结果；不截断、不加省略号。 */
  lines: string[];
  /** 文字锚点中心（标签框内文字居中）。 */
  centerX: number;
  /** 第一行基线。 */
  baseline: number;
}

/**
 * 正交折线。首尾点落在卡片边缘，中间点只做水平/垂直移动。
 * branch 加入共享竖向干线时，points 从干线接出点开始；单支从源卡边缘开始。
 */
export interface LayoutEdgeRoute {
  /** 稳定边 ID：`${from}->${to}`。 */
  id: string;
  from: string;
  to: string;
  flow: 'next' | 'branch';
  points: LayoutPoint[];
  /** branch 加入共享竖向干线时存在；单支没有。 */
  trunkId?: string;
  /** 关系文字框；没有文字时省略。 */
  label?: LayoutLabelBox;
}

/**
 * 同源多个 branch 共用的一条竖向干线；纯显示几何，不是思想节点或关系。
 * 干线只画一次，起点在源卡右边缘。
 */
export interface LayoutBranchTrunk {
  /** 稳定 id：`${from}~branches`。 */
  id: string;
  from: string;
  /** 最下方（最后一个）成员节点 id：仅用于界面挂载，不表示关系。 */
  to: string;
  points: LayoutPoint[];
}

export type LayoutDiagnosticCode =
  | 'invalid-input'
  | 'invalid-option'
  | 'duplicate-node-id'
  | 'invalid-node'
  | 'invalid-flow'
  | 'missing-root'
  | 'multiple-roots'
  | 'unknown-parent'
  | 'self-parent'
  | 'multiple-next'
  | 'duplicate-branch-order'
  | 'collapsed-node-missing'
  | 'visibility-root-hidden'
  | 'cycle'
  | 'unreachable-node'
  | 'previous-positions-ignored'
  | 'diagnostics-truncated';

/** 与 web 的约定保持最小：code、可读消息、可选的关联节点。 */
export interface LayoutDiagnostic {
  code: LayoutDiagnosticCode;
  message: string;
  nodeId?: string;
}

export interface LayoutInput {
  /** 普通对象数组即可；不会被修改。 */
  nodes: readonly LayoutNodeInput[];
  /** undefined/null 表示全部可见；显式空数组表示没有可见节点。 */
  visibleNodeIds?: readonly string[] | null | undefined;
  /** 空数组表示不折叠；被折叠节点的全部后代不参与布局。 */
  collapsedNodeIds?: readonly string[] | null | undefined;
  cardWidth?: number | undefined;
  cardHeight?: number | undefined;
  verticalGap?: number | undefined;
  horizontalGap?: number | undefined;
  /**
   * 上次布局的节点左上角坐标。用于保持阅读锚点：若其中包含主根的有效坐标，
   * 本次全部输出几何（positions、routes、trunks、label boxes）整体平移，使主根
   * 回到该坐标；其余几何仍按当前结构确定，避免旧坐标造成卡片重叠或错误连线。
   * 不会修改传入对象。
   */
  previousPositions?: Readonly<Record<string, LayoutPosition>> | null | undefined;
  /** 调用方持有的结构快照版本；原样回传，供 Worker/页面层丢弃旧结果。 */
  structureVersion?: number | string | null | undefined;
}

export interface LayoutResult {
  /** 仅可见节点，键为稳定节点 ID，值为左上角坐标。 */
  positions: Record<string, LayoutPosition>;
  edgeRoutes: LayoutEdgeRoute[];
  /** 共享干线；单张直连的组不产出。 */
  branchTrunks: LayoutBranchTrunk[];
  /** 折叠节点 -> 被隐藏的后代数；省略 0。 */
  hiddenCounts: Record<string, number>;
  diagnostics: LayoutDiagnostic[];
  /** 所有可见卡片与标签框的并集。 */
  bounds: LayoutRect;
  /** 默认卡片宽度；单卡高度见 heights。 */
  cardWidth: number;
  /** 默认卡片高度；单卡实际高度见 heights。 */
  cardHeight: number;
  /** 每个可见节点的实际卡片高度（含 height 提示，缺省用 cardHeight）。 */
  heights: Record<string, number>;
  /** 本模块输出契约版本。 */
  layoutVersion: number;
  /** 回显调用方的 structureVersion；未提供时为 null。 */
  structureVersion: number | string | null;
}

export const DEFAULT_CARD_WIDTH = CARD_WIDTH;
export const DEFAULT_CARD_HEIGHT = 152;
export const DEFAULT_VERTICAL_GAP = LAYOUT_VERTICAL_GAP;
export const DEFAULT_HORIZONTAL_GAP = LAYOUT_HORIZONTAL_GAP;
export const MAX_LAYOUT_DIAGNOSTICS = 32;
