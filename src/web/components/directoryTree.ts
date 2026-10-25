import type { GraphNode } from '../../shared/protocol.js';

/**
 * One row of the directory projection.
 *
 * The directory is a file-manager-like view of the real `from`/`flow` graph,
 * not the graph itself:
 * - a mainline (`next`) chain stays on its starting level;
 * - direct `branch` children start one level deeper;
 * - a branch's own `next` continuation is a sibling on that same level;
 * - that branch node's `branch` children go one level deeper again.
 *
 * This is exactly the recursion used by the service's numbering (`assignChain`),
 * so indentation, row order, twisties and hidden counts can all be derived from
 * this single model instead of from the number of hyphens in `node.number`.
 */
export interface DirectoryRow {
  node: GraphNode;
  /** 0 for a mainline chain; +1 for each branch step. */
  level: number;
  /** Directory parent (the source of a branch chain), or null for mainline. */
  parentId: string | null;
  /** True when folding this row would hide rows at all: it has direct branch children. */
  hasChildren: boolean;
  /** Rows hidden by folding this node: its whole directory subtree, never its `next`. */
  hiddenCount: number;
}

interface Relations {
  next: GraphNode | null;
  branches: GraphNode[];
}

function compareBranches(left: GraphNode, right: GraphNode): number {
  // Same order as src/core/graph.ts: explicit order first, then stable node id.
  if (left.order !== undefined && right.order !== undefined) {
    const diff = left.order - right.order;
    if (diff !== 0) return diff;
  } else if (left.order !== undefined) {
    return -1;
  } else if (right.order !== undefined) {
    return 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareStarts(left: GraphNode, right: GraphNode): number {
  const byNumber = left.number.localeCompare(right.number, 'zh-CN', { numeric: true });
  if (byNumber !== 0) return byNumber;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function relationsOf(nodes: readonly GraphNode[]): Map<string, Relations> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const grouped = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.from === null || !byId.has(node.from)) continue;
    const list = grouped.get(node.from);
    if (list === undefined) grouped.set(node.from, [node]);
    else list.push(node);
  }
  const relations = new Map<string, Relations>();
  for (const node of nodes) {
    const children = grouped.get(node.id) ?? [];
    const next = children.find((child) => child.flow === 'next') ?? null;
    const branches = children.filter((child) => child.flow === 'branch').sort(compareBranches);
    relations.set(node.id, { next, branches });
  }
  return relations;
}

/**
 * Build the directory rows in numbering/reading order.
 *
 * A node's `next` is deliberately traversed at the same level and with the same
 * parent as the current row. That is what keeps mainline 03 out of the folder
 * for 02 (and 02-02 out of the folder for 02-01), while a branch child's whole
 * chain stays inside its source's folder.
 */
export function directoryRows(nodes: readonly GraphNode[]): DirectoryRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const relations = relationsOf(nodes);
  const rows: DirectoryRow[] = [];
  const seen = new Set<string>();

  const pushChain = (start: GraphNode, level: number, parentId: string | null): void => {
    let current: GraphNode | undefined = start;
    while (current !== undefined && !seen.has(current.id)) {
      const node = current;
      seen.add(node.id);
      const relation = relations.get(node.id);
      rows.push({
        node,
        level,
        parentId,
        hasChildren: (relation?.branches.length ?? 0) > 0,
        hiddenCount: 0,
      });
      for (const branch of relation?.branches ?? []) pushChain(branch, level + 1, node.id);
      current = relation?.next ?? undefined;
    }
  };

  const roots = nodes.filter((node) => node.from === null || !byId.has(node.from)).sort(compareStarts);
  for (const root of roots) pushChain(root, 0, null);
  // Defensive: orphaned/cyclic leftovers stay visible rather than disappearing.
  for (const node of [...nodes].sort(compareStarts)) pushChain(node, 0, null);

  // Derive the true directory hierarchy from the rows themselves: a branch
  // chain's next siblings share the chain's parent, so they are not children of
  // the previous branch node.
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const list = children.get(row.parentId);
    if (list === undefined) children.set(row.parentId, [row.node.id]);
    else list.push(row.node.id);
  }
  const memo = new Map<string, number>();
  const countDescendants = (id: string, visiting: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let total = 0;
    for (const childId of children.get(id) ?? []) {
      total += 1 + countDescendants(childId, visiting);
    }
    visiting.delete(id);
    memo.set(id, total);
    return total;
  };
  for (const row of rows) row.hiddenCount = countDescendants(row.node.id, new Set());

  return rows;
}

function childMap(rows: readonly DirectoryRow[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  const ids = new Set(rows.map((row) => row.node.id));
  for (const row of rows) {
    if (row.parentId === null || !ids.has(row.parentId)) continue;
    const list = children.get(row.parentId);
    if (list === undefined) children.set(row.parentId, [row.node.id]);
    else list.push(row.node.id);
  }
  return children;
}

/** Rows still visible when the given directory folds are closed. */
export function visibleDirectoryRows(
  rows: readonly DirectoryRow[],
  collapsed: ReadonlySet<string>,
): DirectoryRow[] {
  const known = new Set(rows.map((row) => row.node.id));
  const children = childMap(rows);
  const hidden = new Set<string>();
  for (const id of collapsed) {
    if (!known.has(id)) continue;
    const stack = [...(children.get(id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined || hidden.has(next)) continue;
      hidden.add(next);
      stack.push(...(children.get(next) ?? []));
    }
  }
  return rows.filter((row) => !hidden.has(row.node.id));
}

/**
 * Direct directory children per node. This counts branch-chain starts only:
 * a `next` continuation shares the chain's parent folder (so a fold hides it),
 * but it is a same-level sibling rather than another child of the previous row.
 */
export function directoryChildCounts(rows: readonly DirectoryRow[]): Map<string, number> {
  const known = new Set(rows.map((row) => row.node.id));
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.parentId === null || !known.has(row.parentId)) continue;
    if (row.node.flow !== 'branch') continue;
    counts.set(row.parentId, (counts.get(row.parentId) ?? 0) + 1);
  }
  return counts;
}
