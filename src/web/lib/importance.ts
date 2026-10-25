import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphNode, ImportanceRequest, ImportanceResponse } from '../../shared/protocol.js';
import { ApiError, errorMessage } from '../data/client.js';

/** The flag is a source field; the reader only ever reads it. */
export function importanceOf(node: Pick<GraphNode, 'important'> | null | undefined): boolean {
  return node?.important === true;
}

/**
 * POST /api/importance. Same transport shape as the existing export writes
 * (`src/web/data/exports.ts`): JSON body, the client header the service requires
 * on writes, and `ApiError` carrying the service error code and status.
 */
export async function writeImportance(request: ImportanceRequest, signal: AbortSignal): Promise<ImportanceResponse> {
  let response: Response;
  try {
    response = await fetch('/api/importance', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-aichat-client': 'cli',
      },
      body: JSON.stringify({
        topicId: request.topicId,
        nodeId: request.nodeId,
        important: request.important,
        ...(request.expectedHash !== undefined ? { expectedHash: request.expectedHash } : {}),
      }),
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(0, 'NETWORK', '无法连接到本地服务');
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try { parsed = JSON.parse(text) as unknown; } catch { parsed = null; }
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'HTTP_' + String(response.status),
      error?.message ?? '设置重要性失败',
      parsed,
    );
  }
  const body = parsed as Partial<ImportanceResponse> | null;
  if (body === null || typeof body !== 'object' || body.node === undefined) {
    throw new ApiError(response.status, 'EMPTY_RESPONSE', '服务没有返回更新后的卡片');
  }
  return {
    instanceId: typeof body.instanceId === 'string' ? body.instanceId : '',
    revision: typeof body.revision === 'number' ? body.revision : -1,
    ok: true,
    node: body.node,
  };
}

/** Status codes are the promise; codes are accepted as a fallback for older services. */
export function importanceErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 412 || error.code === 'VERSION_CONFLICT' || error.code === 'STALE_SNAPSHOT') {
      return '内容已变化，需要重新读取这张卡片后再设置重要性。';
    }
    if (error.status === 409 || error.code === 'NOT_FOUND') {
      return '这张卡片已不存在（可能被删除），请刷新后重试。';
    }
    if (error.status === 400 || error.code === 'BAD_REQUEST' || error.code === 'VALIDATION_FAILED') {
      return '设置被拒绝：' + error.message;
    }
    if (error.code === 'NETWORK') return '无法连接到本地服务，重要性未改变。';
  }
  return '设置重要性失败：' + errorMessage(error);
}

export interface UseImportanceOptions {
  onApplied: (node: GraphNode) => void;
  onRefresh: () => void;
}

export interface ImportanceError {
  /** Stable node id the failed write was for. */
  nodeId: string;
  message: string;
}

export interface ImportanceState {
  /** Stable node ids with a write in flight; cards and the detail panel read this. */
  busyIds: ReadonlySet<string>;
  /** Latest failed write, if any; independent from the current selection. */
  error: ImportanceError | null;
  /**
   * Writes one node's flag. `expectedHash` is optional: the detail panel supplies
   * the body hash it actually displayed, a card operation submits without one.
   */
  set: (node: GraphNode, important: boolean, expectedHash?: string | null) => void;
  clearError: () => void;
}

/**
 * One write state for every target node. The detail panel and canvas cards both
 * use this hook, so a card can be marked without first selecting it and there is
 * no second copy of busy/error state. A successful write is mirrored locally
 * through `onApplied` and followed by a graph refresh; the service stays the
 * source of truth.
 */
export function useImportance({ onApplied, onRefresh }: UseImportanceOptions): ImportanceState {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<ImportanceError | null>(null);
  const aborts = useRef(new Map<string, AbortController>());

  useEffect(() => () => {
    for (const controller of aborts.current.values()) controller.abort();
    aborts.current.clear();
  }, []);

  const markBusy = useCallback((nodeId: string, busy: boolean) => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  }, []);

  const clearError = useCallback(() => { setError(null); }, []);

  const set = useCallback((node: GraphNode, important: boolean, expectedHash: string | null = null) => {
    const nodeId = node.id;
    const previous = aborts.current.get(nodeId);
    previous?.abort();
    const controller = new AbortController();
    aborts.current.set(nodeId, controller);
    markBusy(nodeId, true);
    setError(null);
    writeImportance(
      {
        topicId: node.topicId,
        nodeId,
        important,
        ...(expectedHash !== null ? { expectedHash } : {}),
      },
      controller.signal,
    ).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (aborts.current.get(nodeId) === controller) aborts.current.delete(nodeId);
        markBusy(nodeId, false);
        onApplied(result.node);
        // The service owns the source; the local snapshot only mirrors the answer.
        onRefresh();
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        if (aborts.current.get(nodeId) === controller) aborts.current.delete(nodeId);
        markBusy(nodeId, false);
        setError({ nodeId, message: importanceErrorMessage(cause) });
      },
    );
  }, [markBusy, onApplied, onRefresh]);

  return { busyIds, error, set, clearError };
}
