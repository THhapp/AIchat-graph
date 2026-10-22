/**
 * Layout 模块的纯结构契约。
 *
 * 只消费已校验的最小结构，不复制 core 的主题/正文 schema，也不依赖
 * React、React Flow、Node 或文件系统。文本字段不参与几何计算。
 */

export type LayoutFlow = 'root' | 'next' | 'branch';
export type LayoutSide = 'left' | 'right';

/** layout 接收的最小节点结构；其他业务字段会被忽略。 */
export interface LayoutNodeInput {
  id: string;
  /** 有效输入中 root 为 null，其余节点为工作区内的父节点 ID。 */
  from?: string | null | undefined;
  flow: LayoutFlow;
  /** 仅 branch 使用；缺省规范化为 right。 */
  side?: LayoutSide | null | undefined;
  /** 仅 branch 使用；整数升序，缺失时按 ID 排在后面。 */
  order?: number | null | undefined;
  /** 仅用于生成 labelAnchor，不参与坐标和碰撞计算。 */
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

/**
 * 正交折线。首尾点落在卡片边缘，中间点只做水平/垂直移动。
 */
export interface LayoutEdgeRoute {
  /** 稳定边 ID：`${from}->${to}`。 */
  id: string;
  from: string;
  to: string;
  flow: 'next' | 'branch';
  /** branch 边的规范化方向；next 边省略。 */
  side?: LayoutSide;
  points: LayoutPoint[];
  /** 有 label 的边在最长线段中点上的放置点；文本宽度不参与计算。 */
  labelAnchor?: LayoutPoint;
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
  | 'route-fallback'
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
   * 本次结果整体平移使主根回到该坐标；其余几何仍按当前结构确定，避免旧坐标
   * 造成卡片重叠或错误连线。不会修改传入对象。
   */
  previousPositions?: Readonly<Record<string, LayoutPosition>> | null | undefined;
  /** 调用方持有的结构快照版本；原样回传，供 Worker/页面层丢弃旧结果。 */
  structureVersion?: number | string | null | undefined;
}

export interface LayoutResult {
  /** 仅可见节点，键为稳定节点 ID，值为左上角坐标。 */
  positions: Record<string, LayoutPosition>;
  edgeRoutes: LayoutEdgeRoute[];
  /** 折叠节点 -> 被隐藏的后代数；省略 0。 */
  hiddenCounts: Record<string, number>;
  diagnostics: LayoutDiagnostic[];
  bounds: LayoutRect;
  cardWidth: number;
  cardHeight: number;
  /** 本模块输出契约版本。 */
  layoutVersion: number;
  /** 回显调用方的 structureVersion；未提供时为 null。 */
  structureVersion: number | string | null;
}

export const DEFAULT_CARD_WIDTH = 360;
export const DEFAULT_CARD_HEIGHT = 152;
export const DEFAULT_VERTICAL_GAP = 64;
export const DEFAULT_HORIZONTAL_GAP = 88;
export const LAYOUT_VERSION = 1;
export const MAX_LAYOUT_DIAGNOSTICS = 32;
