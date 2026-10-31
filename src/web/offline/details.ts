import type {
  ChangeBatchSummary,
  ChangeNodeDiff,
  GraphNode,
  GraphResponse,
  GraphTopic,
  NodeDetailResponse,
  OfflineTopicDocument,
  TopicDetailResponse,
} from '../../next/protocol.js';
import { changeSummaryFromDetail, nodeChangeFromDetail } from '../lib/changes.js';

export interface OfflineDetailView {
  nodeDetail: NodeDetailResponse | null;
  topicDetail: TopicDetailResponse | null;
  /** Version label of the frozen snapshot the detail belongs to. */
  detailVersion: string | null;
  /** Latest persisted batch embedded in the export, if the export has one. */
  batch: ChangeBatchSummary | null;
  /** Selected node's frozen diff from that batch, if it changed. */
  nodeChange: ChangeNodeDiff | null;
}

const EMPTY: OfflineDetailView = {
  nodeDetail: null,
  topicDetail: null,
  detailVersion: null,
  batch: null,
  nodeChange: null,
};

export interface OfflineDetailInput {
  graph: GraphResponse | null;
  doc: OfflineTopicDocument | null;
  bodies: ReadonlyMap<string, string>;
  tab: 'node' | 'topic';
  node: GraphNode | null;
  topic: GraphTopic | null;
}

/**
 * Detail body for the selected offline tab. The exported document is already the
 * frozen snapshot, so this only projects it into the same response shapes the
 * detail panel reads; it never fetches, retries or writes. The frozen resource
 * map is attached to both detail kinds: in the offline reader it holds inline
 * data URIs, exactly what MarkdownBody can render without a network.
 */
export function deriveOfflineDetails(input: OfflineDetailInput): OfflineDetailView {
  const { graph, doc, bodies, tab, node, topic } = input;
  if (graph === null || doc === null) return EMPTY;

  const detailVersion = graph.instanceId + ':' + String(graph.revision);
  const batch = changeSummaryFromDetail(doc.changes ?? null);
  if (tab === 'topic') {
    const nodes = doc.nodes.map((item) => ({
      ...item,
      body: bodies.get(item.id) ?? item.body,
    }));
    return {
      nodeDetail: null,
      topicDetail: {
        instanceId: graph.instanceId,
        revision: graph.revision,
        source: 'database',
        valid: true,
        topic: topic ?? doc.topic,
        nodes,
        diagnostics: graph.diagnostics,
        resources: doc.resources,
      },
      detailVersion,
      batch,
      nodeChange: null,
    };
  }

  if (node === null) return EMPTY;
  const frozen = doc.nodes.find((item) => item.id === node.id);
  return {
    nodeDetail: {
      instanceId: graph.instanceId,
      revision: graph.revision,
      node,
      body: bodies.get(node.id) ?? frozen?.body ?? '',
      resources: doc.resources,
    },
    topicDetail: null,
    detailVersion,
    batch,
    nodeChange: nodeChangeFromDetail(doc.changes ?? null, node.id),
  };
}
