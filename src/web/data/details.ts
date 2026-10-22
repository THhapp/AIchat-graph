import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GraphResponse,
  NodeDetailResponse,
  SnapshotQuery,
  TopicDetailResponse,
} from '../../shared/protocol.js';
import { ApiError, errorMessage, getJson } from './client.js';

export interface DetailState {
  nodeDetail: NodeDetailResponse | null;
  topicDetail: TopicDetailResponse | null;
  /** Node/topic the retained detail belongs to, so a new selection never shows the old body. */
  detailNodeId: string | null;
  detailTopicId: string | null;
  loading: boolean;
  error: string | null;
  /** Exactly the snapshot the displayed detail came from, or null. */
  detailVersion: string | null;
}

const EMPTY: DetailState = {
  nodeDetail: null,
  topicDetail: null,
  detailNodeId: null,
  detailTopicId: null,
  loading: false,
  error: null,
  detailVersion: null,
};

function versionOf(instanceId: string, revision: number): string {
  return instanceId + ':' + String(revision);
}

function queryOf(graph: GraphResponse): string {
  const query: SnapshotQuery = { instanceId: graph.instanceId, revision: graph.revision };
  return '?instanceId=' + encodeURIComponent(query.instanceId) + '&revision=' + encodeURIComponent(String(query.revision));
}

/**
 * Detail requests always carry the graph's instanceId/revision. When the snapshot
 * changes, details are re-fetched; outdated ones are aborted and never merged into
 * the new graph. STALE_SNAPSHOT detaches the detail instead of showing mismatched text.
 */
export function useDetails(
  graph: GraphResponse | null,
  nodeId: string | null,
  topicId: string | null,
  enabled: boolean,
  onStale: () => void,
) {
  const [state, setState] = useState<DetailState>(EMPTY);
  const abort = useRef<AbortController | null>(null);
  const requestKey = useRef<string>('');
  const activeKey = useRef<string>('');
  const [retryNonce, setRetryNonce] = useState(0);

  const retry = useCallback(() => { setRetryNonce((value) => value + 1); }, []);

  // Abort any in-flight detail when the whole panel unmounts.
  useEffect(() => () => { abort.current?.abort(); }, []);

  useEffect(() => {
    if (graph === null || !enabled || (nodeId === null && topicId === null)) {
      abort.current?.abort();
      requestKey.current = '';
      activeKey.current = '';
      setState(EMPTY);
      return;
    }

    const key = [graph.instanceId, String(graph.revision), nodeId ?? '', topicId ?? '', String(retryNonce)].join('|');
    if (requestKey.current === key) return;
    requestKey.current = key;
    activeKey.current = key;

    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    const version = versionOf(graph.instanceId, graph.revision);
    const query = queryOf(graph);

    setState((current) => ({
      // A different card must never show the previous card's body while loading.
      nodeDetail: current.detailNodeId === nodeId ? current.nodeDetail : null,
      topicDetail: current.detailTopicId === topicId ? current.topicDetail : null,
      detailNodeId: current.detailNodeId === nodeId ? current.detailNodeId : null,
      detailTopicId: current.detailTopicId === topicId ? current.detailTopicId : null,
      loading: true,
      error: null,
      // Keep the version label only when the retained content is reused.
      detailVersion:
        current.detailNodeId === nodeId && current.detailTopicId === topicId ? current.detailVersion : null,
    }));

    const nodePromise = nodeId === null ? Promise.resolve(null) : getJson<NodeDetailResponse>('/api/nodes/' + encodeURIComponent(nodeId) + query, controller.signal);
    const topicPromise = topicId === null ? Promise.resolve(null) : getJson<TopicDetailResponse>('/api/topics/' + encodeURIComponent(topicId) + query, controller.signal);

    Promise.all([nodePromise, topicPromise]).then(
      ([nodeDetail, topicDetail]) => {
        if (controller.signal.aborted) return;
        setState({ nodeDetail, topicDetail, detailNodeId: nodeId, detailTopicId: topicId, loading: false, error: null, detailVersion: version });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.code === 'STALE_SNAPSHOT') {
          requestKey.current = '';
          activeKey.current = '';
          setState({ nodeDetail: null, topicDetail: null, detailNodeId: null, detailTopicId: null, loading: false, error: null, detailVersion: null });
          onStale();
          return;
        }
        setState((current) => ({
          nodeDetail: current.nodeDetail,
          topicDetail: current.topicDetail,
          detailNodeId: current.detailNodeId,
          detailTopicId: current.detailTopicId,
          loading: false,
          error: errorMessage(cause),
          detailVersion: current.detailVersion,
        }));
      },
    );

    return () => {
      // Abort only when the selection/version actually changed. A graph object
      // refresh carrying the same version must not cancel the in-flight detail,
      // otherwise the panel would stay in a loading state with no request.
      if (activeKey.current !== key) controller.abort();
    };
  }, [graph, nodeId, topicId, enabled, retryNonce, onStale]);

  return { ...state, retry };
}