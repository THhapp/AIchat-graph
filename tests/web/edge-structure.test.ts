import { describe, expect, it } from 'vitest';
import type { GraphNode, GraphResponse } from '../../src/shared/protocol.js';
import { buildFlowEdges } from '../../src/web/graph/flowEdges.js';
import { layoutInputForView } from '../../src/web/graph/layoutBridge.js';
import { buildGraphView } from '../../src/web/graph/viewModel.js';
import { computeLayout } from '../../src/web/layout/index.js';

function node(
  id: string,
  from: string | null,
  flow: GraphNode['flow'],
  order?: number,
): GraphNode {
  return {
    id,
    topicId: 't_1',
    title: id,
    summary: '',
    number: id,
    from,
    flow,
    state: 'agreed',
    important: false,
    ...(flow === 'branch' ? { order: order ?? 10 } : {}),
  };
}

const graph: GraphResponse = {
  instanceId: 'instance',
  revision: 1,
  workspaceId: 'workspace',
  activeNode: null,
  stale: false,
  diagnostics: [],
  nodes: [
    node('r', null, 'root'),
    node('n1', 'r', 'next'),
    node('b1', 'r', 'branch', 10),
    node('b2', 'r', 'branch', 20),
    node('s1', 'n1', 'branch', 10),
  ],
  topics: [{
    id: 't_1',
    title: 'topic',
    path: 'topics/t_1.md',
    nodeIds: ['r', 'n1', 'b1', 'b2', 's1'],
    fileHash: 'hash',
  }],
};

const view = buildGraphView(graph, new Set(), null);
const layout = computeLayout(layoutInputForView(view));
const edges = buildFlowEdges(layout, view);
const byId = new Map(edges.map((edge) => [edge.id, edge]));

function routeOf(id: string): { trunkId?: string } | null {
  const data = byId.get(id)?.data as { route?: { trunkId?: string } | null } | undefined;
  return data?.route ?? null;
}

describe('flow edge structure', () => {
  it('adds relationship edges first and every shared trunk last', () => {
    expect(edges.map((edge) => edge.id)).toEqual([
      'r->n1',
      'r->b1',
      'r->b2',
      'n1->s1',
      'trunk|r~branches',
    ]);
    expect(edges.at(-1)?.type).toBe('trunk');
    expect(edges.filter((edge) => edge.type === 'route')).toHaveLength(4);
    expect(edges.filter((edge) => edge.type === 'trunk')).toHaveLength(1);
  });

  it('marks only branch routes that join a shared trunk as stubs', () => {
    expect(byId.get('r->n1')?.className).toBe('rf-edge--next');
    expect(byId.get('r->b1')?.className).toBe('rf-edge--branch rf-edge--stub');
    expect(byId.get('r->b2')?.className).toBe('rf-edge--branch rf-edge--stub');
    expect(byId.get('n1->s1')?.className).toBe('rf-edge--branch');
    expect(byId.get('trunk|r~branches')?.className).toBe('rf-edge--trunk');

    expect(routeOf('r->b1')?.trunkId).toBe('r~branches');
    expect(routeOf('r->b2')?.trunkId).toBe('r~branches');
    expect(routeOf('n1->s1')?.trunkId).toBeUndefined();
  });
});
