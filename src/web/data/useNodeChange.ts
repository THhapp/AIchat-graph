import { useEffect, useState } from 'react';
import type { ChangeNodeDiff, GraphResponse } from '../../next/protocol.js';
import { ApiError, errorMessage } from './client.js';
import { fetchNodeChange } from './changes.js';

export interface NodeChangeState {
  loading: boolean;
  error: string | null;
  change: ChangeNodeDiff | null;
  /** The service answered that this node has no diff in the latest batch. */
  missing: boolean;
}

const EMPTY: NodeChangeState = { loading: false, error: null, change: null, missing: false };

/**
 * On-demand diff for one node: no request until enabled, aborted when the
 * selection closes, and retried when the graph snapshot advances.
 */
export function useNodeChange(
  graph: GraphResponse | null,
  topicId: string | null,
  nodeId: string | null,
  enabled: boolean,
  onStale: () => void,
): NodeChangeState {
  const [state, setState] = useState<NodeChangeState>(EMPTY);

  useEffect(() => {
    if (!enabled || graph === null || topicId === null || nodeId === null) {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    setState({ ...EMPTY, loading: true });
    fetchNodeChange(topicId, nodeId, controller.signal).then(
      (change) => {
        if (controller.signal.aborted) return;
        setState({ loading: false, error: null, change, missing: change === null });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && (cause.code === 'STALE_SNAPSHOT' || cause.status === 412)) {
          setState(EMPTY);
          onStale();
          return;
        }
        setState({ loading: false, error: errorMessage(cause), change: null, missing: false });
      },
    );
    return () => { controller.abort(); };
  }, [graph?.instanceId, graph?.revision, topicId, nodeId, enabled, onStale]);

  return state;
}
