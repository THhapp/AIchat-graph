import { describe, expect, it } from 'vitest';
import type { GraphNode, GraphResponse } from '../../src/next/protocol.js';
import {
  CARD_BASE_HEIGHT,
  CARD_WIDTH,
  LAYOUT_HORIZONTAL_GAP,
  LAYOUT_VERTICAL_GAP,
} from '../../src/web/graph/cardMetrics.js';
import { layoutInputForView } from '../../src/web/graph/layoutBridge.js';
import { buildGraphView } from '../../src/web/graph/viewModel.js';
import { computeLayout } from '../../src/web/layout/index.js';
import type { LayoutInput } from '../../src/web/layout/types.js';

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
    revision: 1,
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
  ],
  topics: [{
    id: 't_1',
    key: 'topic',
    title: 'topic',
    nodeIds: ['r', 'n1', 'b1', 'b2'],
    revision: 1,
  }],
};

describe('layoutInputForView', () => {
  it('projects the visible view and the shared card metrics into one layout input', () => {
    const view = buildGraphView(graph, new Set(['r']), null);
    const input = layoutInputForView(view);

    expect(input.nodes).toBe(view.layoutNodes);
    expect(input.visibleNodeIds).toEqual(['r']);
    expect(input.collapsedNodeIds).toEqual(['r']);
    expect(input.cardWidth).toBe(CARD_WIDTH);
    expect(input.cardHeight).toBe(CARD_BASE_HEIGHT);
    expect(input.verticalGap).toBe(LAYOUT_VERTICAL_GAP);
    expect(input.horizontalGap).toBe(LAYOUT_HORIZONTAL_GAP);
    expect(input.structureVersion).toBe(view.structureKey);
    expect(input.previousPositions).toBeNull();
  });

  it('passes previous positions through unchanged', () => {
    const view = buildGraphView(graph, new Set(), null);
    const previous = { r: { x: 12, y: 34 } };

    expect(layoutInputForView(view, { previousPositions: previous }).previousPositions).toBe(previous);
    expect(layoutInputForView(view, { previousPositions: null }).previousPositions).toBeNull();
    expect(layoutInputForView(view, {}).previousPositions).toBeNull();
  });

  it('matches the input shape layout used before the shared bridge', () => {
    const view = buildGraphView(graph, new Set(), null);
    const previous = { r: { x: 40, y: 60 } };
    const legacy: LayoutInput = {
      nodes: view.layoutNodes,
      visibleNodeIds: [...view.visibleIds],
      collapsedNodeIds: view.collapsedIds,
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_BASE_HEIGHT,
      verticalGap: LAYOUT_VERTICAL_GAP,
      horizontalGap: LAYOUT_HORIZONTAL_GAP,
      previousPositions: previous,
      structureVersion: view.structureKey,
    };

    expect(computeLayout(layoutInputForView(view, { previousPositions: previous })))
      .toEqual(computeLayout(legacy));
  });
});
