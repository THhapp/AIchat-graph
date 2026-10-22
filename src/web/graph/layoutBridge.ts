import { createContext, useContext } from 'react';
import type {
  LayoutDiagnostic,
  LayoutEdgeRoute,
  LayoutInput,
  LayoutNodeInput,
  LayoutPosition,
  LayoutResult,
} from '../layout/types.js';
import type {
  LayoutWorkerRequest,
  LayoutWorkerResponse,
} from '../layout/workerProtocol.js';

/**
 * Adapter between the reading UI and the separately owned layout module
 * (src/web/layout). The UI never computes coordinates itself.
 *
 * Worker protocol (owned by layout):
 *   request  { type: 'layout', requestId: string, sequence: number, input }
 *   response { type: 'layout-result' | 'layout-stale' | 'layout-error',
 *              requestId, sequence, structureVersion, result? | error? }
 * The caller owns staleness: a response is applied only when its requestId is
 * still pending and the structureVersion it echoes is still current.
 */
export type {
  LayoutWorkerRequest,
  LayoutWorkerResultMessage,
  LayoutWorkerStaleMessage,
  LayoutWorkerErrorMessage,
  LayoutWorkerResponse,
} from '../layout/workerProtocol.js';

/** A stale worker answer is not a failure: the caller should simply ignore it. */
export class LayoutStaleError extends Error {
  readonly code = 'LAYOUT_STALE';
  readonly structureVersion: number | string | null;
  constructor(structureVersion: number | string | null) {
    super('布局结果已过期');
    this.name = 'LayoutStaleError';
    this.structureVersion = structureVersion;
  }
}

export class LayoutFailureError extends Error {
  readonly code: string;
  readonly diagnostics: LayoutDiagnostic[];
  readonly structureVersion: number | string | null;
  constructor(code: string, message: string, diagnostics: LayoutDiagnostic[], structureVersion: number | string | null) {
    super(message);
    this.name = 'LayoutFailureError';
    this.code = code;
    this.diagnostics = diagnostics;
    this.structureVersion = structureVersion;
  }
}

export interface LayoutResultEnvelope {
  result: LayoutResult;
  structureVersion: number | string | null;
}

export interface LayoutEngine {
  compute(input: LayoutInput, structureVersion: string): Promise<LayoutResultEnvelope>;
  dispose(): void;
}

function normalizeStructureVersion(value: number | string | null | undefined): number | string | null {
  return value === undefined ? null : value;
}

/** Default adapter: wraps the layout owner's Worker entry. */
export function createWorkerLayoutEngine(worker: Worker): LayoutEngine {
  let nextSequence = 1;
  const pending = new Map<
    string,
    {
      resolve: (value: LayoutResultEnvelope) => void;
      reject: (error: Error) => void;
      structureVersion: number | string | null;
    }
  >();

  const settle = (requestId: string, action: (entry: NonNullable<ReturnType<typeof pending.get>>) => void): void => {
    const entry = pending.get(requestId);
    if (entry === undefined) return;
    pending.delete(requestId);
    action(entry);
  };

  const onMessage = (event: MessageEvent<LayoutWorkerResponse>): void => {
    const data = event.data;
    if (data.type === 'layout-result') {
      settle(data.requestId, (entry) => {
        entry.resolve({ result: data.result, structureVersion: normalizeStructureVersion(data.structureVersion) ?? entry.structureVersion });
      });
      return;
    }
    if (data.type === 'layout-stale') {
      settle(data.requestId, (entry) => {
        entry.reject(new LayoutStaleError(normalizeStructureVersion(data.structureVersion)));
      });
      return;
    }
    if (data.type === 'layout-error') {
      settle(data.requestId, (entry) => {
        entry.reject(new LayoutFailureError(data.error.code, data.error.message, [], normalizeStructureVersion(data.structureVersion)));
      });
    }
  };

  let dead: string | null = null;

  const failAll = (code: string, message: string): void => {
    dead = message;
    for (const [requestId, entry] of [...pending]) {
      pending.delete(requestId);
      entry.reject(new LayoutFailureError(code, message, [], entry.structureVersion));
    }
  };

  const onError = (event: ErrorEvent): void => {
    failAll('LAYOUT_WORKER_ERROR', event.message || '布局 Worker 出错');
  };
  const onMessageError = (): void => {
    failAll('LAYOUT_WORKER_MESSAGE', '布局 Worker 返回了无法解析的消息');
  };

  worker.addEventListener('message', onMessage);
  worker.addEventListener('messageerror', onMessageError);
  worker.addEventListener('error', onError);

  return {
    compute(input, structureVersion) {
      if (dead !== null) {
        return Promise.reject(new LayoutFailureError('LAYOUT_WORKER_DEAD', dead, [], structureVersion));
      }
      const sequence = nextSequence++;
      const requestId = 'layout-' + String(sequence);
      return new Promise<LayoutResultEnvelope>((resolve, reject) => {
        pending.set(requestId, { resolve, reject, structureVersion });
        const request: LayoutWorkerRequest = { type: 'layout', requestId, sequence, input };
        try {
          worker.postMessage(request);
        } catch (cause) {
          pending.delete(requestId);
          const message = cause instanceof Error ? cause.message : '无法向布局 Worker 发送请求';
          reject(new LayoutFailureError('LAYOUT_POST_FAILED', message, [], structureVersion));
        }
      });
    },
    dispose() {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('messageerror', onMessageError);
      worker.removeEventListener('error', onError);
      dead = '布局已取消';
      for (const [requestId, entry] of [...pending]) {
        pending.delete(requestId);
        entry.reject(new LayoutFailureError('LAYOUT_DISPOSED', '布局已取消', [], entry.structureVersion));
      }
      worker.terminate();
    },
  };
}

export class LayoutUnavailableError extends Error {
  readonly code = 'LAYOUT_UNAVAILABLE';
  constructor(message = '布局模块尚未接入：src/web/layout 未提供可用实现，界面不会伪造节点坐标。') {
    super(message);
    this.name = 'LayoutUnavailableError';
  }
}

export interface LayoutEngineSlot {
  /** loading = worker module still being fetched; missing = no layout implementation. */
  status: 'loading' | 'ready' | 'missing';
  engine: LayoutEngine | null;
}

export const LayoutEngineContext = createContext<LayoutEngineSlot>({ status: 'missing', engine: null });

export function useLayoutEngine(): LayoutEngineSlot {
  return useContext(LayoutEngineContext);
}

/** Converts layout output into maps the React Flow adapter consumes. */
export function indexLayout(result: LayoutResult): {
  positions: Map<string, LayoutPosition>;
  routes: Map<string, LayoutEdgeRoute>;
} {
  return {
    positions: new Map(Object.entries(result.positions)),
    routes: new Map(result.edgeRoutes.map((route) => [route.id, route])),
  };
}

export interface LayoutNodeSeed {
  id: string;
  from: string | null;
  flow: 'root' | 'next' | 'branch';
  side?: 'left' | 'right';
  order?: number;
  label?: string;
  topicId?: string;
}

/** Strips UI-only fields; layout must not receive titles, bodies or numbers. */
export function toLayoutNodeInput(node: LayoutNodeSeed): LayoutNodeInput {
  return {
    id: node.id,
    from: node.from,
    flow: node.flow,
    side: node.side ?? null,
    order: node.order ?? null,
    label: node.label ?? null,
    topicId: node.topicId ?? null,
  };
}