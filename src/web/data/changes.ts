import type { ChangeBatchSummary, ChangeNodeDiff, ChangeNodeResponse, ChangeSummaryResponse } from '../../next/protocol.js';
import { ApiError, getJson } from './client.js';

/**
 * Latest persisted change batch / one node diff.
 *
 * The node diff is fetched only when the user asks for it. A 404 with
 * CHANGE_NOT_FOUND is a real, non-error answer ("nothing changed in the latest
 * batch"); every other failure stays an error and is never replaced by fake data.
 */
function isChangeNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'CHANGE_NOT_FOUND';
}

export async function fetchTopicChange(
  topicId: string,
  signal: AbortSignal,
): Promise<ChangeBatchSummary | null> {
  try {
    const response = await getJson<ChangeSummaryResponse>(
      '/api/changes?topicId=' + encodeURIComponent(topicId),
      signal,
    );
    return response.batch ?? null;
  } catch (cause) {
    if (isChangeNotFound(cause)) return null;
    throw cause;
  }
}

export async function fetchNodeChange(
  topicId: string,
  nodeId: string,
  signal: AbortSignal,
): Promise<ChangeNodeDiff | null> {
  try {
    const response = await getJson<ChangeNodeResponse>(
      '/api/changes/nodes/' + encodeURIComponent(nodeId) + '?topicId=' + encodeURIComponent(topicId),
      signal,
    );
    return response.change ?? null;
  } catch (cause) {
    if (isChangeNotFound(cause)) return null;
    throw cause;
  }
}
