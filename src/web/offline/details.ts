import type {
  GraphNode,
  GraphResponse,
  GraphTopic,
  NodeDetailResponse,
  OfflineTopicDocument,
  TopicDetailResponse,
} from '../../shared/protocol.js';

export interface OfflineDetailView {
  nodeDetail: NodeDetailResponse | null;
  topicDetail: TopicDetailResponse | null;
  /** Version label of the frozen snapshot the detail belongs to. */
  detailVersion: string | null;
}

const EMPTY: OfflineDetailView = { nodeDetail: null, topicDetail: null, detailVersion: null };

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
 * detail panel reads; it never fetches, retries or writes.
 */
export function deriveOfflineDetails(input: OfflineDetailInput): OfflineDetailView {
  const { graph, doc, bodies, tab, node, topic } = input;
  if (graph === null || doc === null) return EMPTY;

  const detailVersion = graph.instanceId + ':' + String(graph.revision);
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
        source: 'snapshot',
        valid: true,
        topic: topic ?? doc.topic,
        raw: '',
        fileHash: doc.topic.fileHash,
        nodes,
        diagnostics: graph.diagnostics,
      },
      detailVersion,
    };
  }

  if (node === null) return EMPTY;
  return {
    nodeDetail: {
      instanceId: graph.instanceId,
      revision: graph.revision,
      node,
      body: bodies.get(node.id) ?? '',
      topicId: node.topicId,
      path: topic?.path ?? '',
      fileHash: topic?.fileHash ?? '',
    },
    topicDetail: null,
    detailVersion,
  };
}
