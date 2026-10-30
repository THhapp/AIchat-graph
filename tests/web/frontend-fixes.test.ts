import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../../src/next/protocol.js';
import {
  directoryChildCounts,
  directoryRows,
  visibleDirectoryRows,
} from '../../src/web/components/directoryTree.js';

function node(
  id: string,
  from: string | null,
  flow: 'root' | 'next' | 'branch',
  number: string,
  title: string,
  order?: number,
): GraphNode {
  return {
    id,
    topicId: 't_1',
    title,
    summary: title + ' 摘要',
    number,
    from,
    flow,
    important: false,
    revision: 1,
    ...(flow === 'branch' ? { side: 'right' as const, ...(order !== undefined ? { order } : {}) } : {}),
  };
}

/**
 * The acceptance fixture's 02 subtree:
 *   01 -> 02 -> 03 -> 04 -> 05 mainline
 *   02 has branches 02-01 (with two branches and a next) and 02-03 (with a next)
 *   02-01 -> 02-01-01 / 02-01-02, then 02-02 (same level as 02-01)
 */
const nodes: GraphNode[] = [
  node('n01', null, 'root', '01', '起点'),
  node('n02', 'n01', 'next', '02', '主线二'),
  node('n0201', 'n02', 'branch', '02-01', '左侧分支', 10),
  node('n020101', 'n0201', 'branch', '02-01-01', '左下的右子分支', 10),
  node('n020102', 'n0201', 'branch', '02-01-02', '左下的左子分支', 20),
  node('n0202', 'n0201', 'next', '02-02', '左侧分支续'),
  node('n0203', 'n02', 'branch', '02-03', '右侧分支', 20),
  node('n0204', 'n0203', 'next', '02-04', '右侧分支续'),
  node('n03', 'n02', 'next', '03', '主线三'),
  node('n0301', 'n03', 'branch', '03-01', '主线三的分支', 10),
  node('n04', 'n03', 'next', '04', '主线四'),
  node('n0401', 'n04', 'branch', '04-01', '主线四的分支', 10),
  node('n05', 'n04', 'next', '05', '主线五'),
  node('n0501', 'n05', 'branch', '05-01', '主线五的分支', 10),
];

describe('directory hierarchy projection', () => {
  it('keeps mainline on level 0 and follows each node with its branch chain', () => {
    const rows = directoryRows(nodes);
    expect(rows.map((row) => [row.node.number, row.level, row.parentId])).toEqual([
      ['01', 0, null],
      ['02', 0, null],
      ['02-01', 1, 'n02'],
      ['02-01-01', 2, 'n0201'],
      ['02-01-02', 2, 'n0201'],
      ['02-02', 1, 'n02'],
      ['02-03', 1, 'n02'],
      ['02-04', 1, 'n02'],
      ['03', 0, null],
      ['03-01', 1, 'n03'],
      ['04', 0, null],
      ['04-01', 1, 'n04'],
      ['05', 0, null],
      ['05-01', 1, 'n05'],
    ]);
  });

  it('uses the same parent model for twisties and direct child counts', () => {
    const counts = directoryChildCounts(directoryRows(nodes));
    expect(counts.get('n02')).toBe(2); // 02-01, 02-03 (02-02/02-04 are next siblings)
    expect(counts.get('n0201')).toBe(2); // 02-01-01, 02-01-02 (not 02-02)
    expect(counts.get('n03')).toBe(1);
    expect(counts.get('n0202')).toBeUndefined();
  });

  it('folding 02 hides only its directory subtree, never mainline 03', () => {
    const rows = directoryRows(nodes);
    const folded = visibleDirectoryRows(rows, new Set(['n02']));
    expect(folded.map((row) => row.node.number)).toEqual(['01', '02', '03', '03-01', '04', '04-01', '05', '05-01']);
    expect(rows.find((row) => row.node.id === 'n02')?.hiddenCount).toBe(6);
  });

  it('folding 02-01 hides its nested branches but keeps 02-02 and 02-03', () => {
    const rows = directoryRows(nodes);
    const folded = visibleDirectoryRows(rows, new Set(['n0201']));
    const numbers = folded.map((row) => row.node.number);
    expect(numbers).toContain('02-01');
    expect(numbers).toContain('02-02');
    expect(numbers).toContain('02-03');
    expect(numbers).not.toContain('02-01-01');
    expect(numbers).not.toContain('02-01-02');
    expect(rows.find((row) => row.node.id === 'n0201')?.hiddenCount).toBe(2);
  });

  it('never derives level or children from the number of hyphens', () => {
    // Same numbering shape, but the branch continuation is a next sibling:
    // its own directory parent stays the source of the chain, not the previous row.
    const odd = [
      node('r', null, 'root', '01', '根'),
      node('a', 'r', 'branch', '01-01', '甲', 10),
      node('b', 'a', 'next', '01-02', '乙'),
      node('c', 'r', 'branch', '01-03', '丙', 20),
    ];
    const rows = directoryRows(odd);
    expect(rows.map((row) => [row.node.id, row.level, row.parentId])).toEqual([
      ['r', 0, null],
      ['a', 1, 'r'],
      ['b', 1, 'r'],
      ['c', 1, 'r'],
    ]);
    expect(directoryChildCounts(rows).get('r')).toBe(2);
    expect(directoryChildCounts(rows).get('a')).toBeUndefined();
  });
});
