/**
 * Recursive chain-block measurement.
 *
 * A chain is a chain head plus the visible nodes reachable through next. Every
 * branch target is the head of another chain, so the whole visible graph is a
 * forest of chains. A chain block measures the chain spine and its recursive
 * branch groups in coordinates local to the head card's top-left corner.
 *
 * Siblings of one branch group share the same right-hand column and are stacked
 * vertically. Each sibling reserves the space its incoming relation label needs
 * above the entry run, so the label sits over its own exclusive line rather than
 * covering it and the parent chain's next successor starts only after the
 * complete branch region.
 *
 * This is a project-specific chain layout rather than a generic tidy tree:
 * subtree size drives sibling separation, but the explicit next/branch edges
 * and real `from` sources are never re-derived. No layout dependency is used.
 */
import {
  LAYOUT_BRANCH_SIBLING_GAP,
  LAYOUT_LABEL_GAP,
  LAYOUT_LABEL_GUTTER,
  LAYOUT_TRUNK_INSET,
  edgeLabelBoxSize,
} from '../graph/cardMetrics.js';
import { compareBranches } from './inputTree.js';
import type { DiagnosticSink, LayoutConfig, VisibleTree, WorkingNode } from './internal.js';

export interface ChainBlockNode {
  node: WorkingNode;
  x: number;
  y: number;
}

export interface ChainBlock {
  head: WorkingNode;
  /** Full horizontal extent from the head card's left edge. */
  width: number;
  /** Full vertical extent from the head card's top edge, including branch groups. */
  height: number;
  /** Height of the head card, used by the parent when reserving the branch label. */
  headHeight: number;
  nodes: ChainBlockNode[];
}

export interface MeasureContext {
  nextByParent: VisibleTree['nextByParent'];
  branchesByParent: VisibleTree['branchesByParent'];
  config: LayoutConfig;
  diagnostics: DiagnosticSink;
  memo: Map<string, ChainBlock>;
  visiting: Set<string>;
}

/** Wrap width available to a branch relation label inside the horizontal gap. */
export function branchLabelMaxWidth(config: LayoutConfig): number {
  return Math.max(1, config.horizontalGap - LAYOUT_TRUNK_INSET - LAYOUT_LABEL_GUTTER * 2);
}

/** Wrap width available to a next relation label under the source card. */
export function nextLabelMaxWidth(config: LayoutConfig): number {
  return Math.max(1, Math.min(240, config.cardWidth - 64));
}

/** Painted height of a relation label; zero when there is no text. */
export function labelHeightOf(label: string | null, maxWidth: number): number {
  if (label === null || label.trim() === '') return 0;
  return edgeLabelBoxSize(label, maxWidth).height;
}

function singleCardBlock(head: WorkingNode, cardWidth: number): ChainBlock {
  return {
    head,
    width: cardWidth,
    height: head.height,
    headHeight: head.height,
    nodes: [{ node: head, x: 0, y: 0 }],
  };
}

/** Collect the visible next chain; the guard only protects malformed structures. */
function collectSpine(head: WorkingNode, context: MeasureContext): WorkingNode[] {
  const spine: WorkingNode[] = [];
  const seen = new Set<string>();
  let current: WorkingNode | undefined = head;
  while (current !== undefined) {
    if (seen.has(current.id)) {
      context.diagnostics.add('cycle', 'next 链出现环，链在此处截断', current.id);
      break;
    }
    seen.add(current.id);
    spine.push(current);
    current = context.nextByParent.get(current.id);
  }
  return spine;
}

export function measureChain(head: WorkingNode, context: MeasureContext): ChainBlock {
  const cached = context.memo.get(head.id);
  if (cached !== undefined) return cached;
  if (context.visiting.has(head.id)) {
    context.diagnostics.add('cycle', '布局递归出现环，节点单独绘制', head.id);
    return singleCardBlock(head, context.config.cardWidth);
  }
  context.visiting.add(head.id);

  const { cardWidth, horizontalGap, verticalGap } = context.config;
  const childX = cardWidth + horizontalGap;
  const spine = collectSpine(head, context);
  const nodes: ChainBlockNode[] = [];
  let width = cardWidth;
  let height = 0;
  let cursorY = 0;

  for (let index = 0; index < spine.length; index += 1) {
    const source = spine[index];
    if (source === undefined) continue;
    nodes.push({ node: source, x: 0, y: cursorY });

    const branches = [...(context.branchesByParent.get(source.id) ?? [])].sort(compareBranches);
    let stackBottom = 0;
    let stackCursor = 0;
    for (const child of branches) {
      const childBlock = measureChain(child, context);
      const labelHeight = labelHeightOf(child.label, branchLabelMaxWidth(context.config));
      const labelBottomRel = childBlock.headHeight / 2 - LAYOUT_LABEL_GAP;
      const labelTopRel = labelBottomRel - labelHeight;
      const topPad = Math.max(0, -labelTopRel);
      const childHeadY = stackCursor + topPad;

      for (const childNode of childBlock.nodes) {
        nodes.push({
          node: childNode.node,
          x: childX + childNode.x,
          y: cursorY + childHeadY + childNode.y,
        });
      }
      width = Math.max(width, childX + childBlock.width);

      stackBottom = childHeadY + childBlock.height;
      stackCursor = stackBottom + LAYOUT_BRANCH_SIBLING_GAP;
    }

    // The node and its direct branch group form one vertical region. The next
    // chain may only continue below the complete branch stack.
    const regionHeight = Math.max(source.height, stackBottom);
    const regionBottom = cursorY + regionHeight;
    height = regionBottom;

    const next = spine[index + 1];
    if (next === undefined) continue;
    const nextLabelHeight = labelHeightOf(next.label, nextLabelMaxWidth(context.config));
    const nextGap =
      nextLabelHeight === 0
        ? verticalGap
        : Math.max(verticalGap, nextLabelHeight + LAYOUT_LABEL_GAP * 2);
    cursorY = regionBottom + nextGap;
  }

  const block: ChainBlock = { head, width, height, headHeight: head.height, nodes };
  context.memo.set(head.id, block);
  context.visiting.delete(head.id);
  return block;
}
