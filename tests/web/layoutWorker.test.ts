import { describe, expect, it, vi } from 'vitest';
import type { LayoutInput, LayoutResult } from '../../src/web/layout/types.js';
import {
  LayoutFailureError,
  LayoutStaleError,
  createWorkerLayoutEngine,
  type LayoutWorkerRequest,
  type LayoutWorkerResponse,
} from '../../src/web/graph/layoutBridge.js';

class FakeWorker {
  listeners = new Map<string, ((event: unknown) => void)[]>();
  posted: LayoutWorkerRequest[] = [];
  terminated = false;

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== fn));
  }
  postMessage(request: LayoutWorkerRequest): void { this.posted.push(request); }
  terminate(): void { this.terminated = true; }
  emit(type: string, payload: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }
  reply(response: LayoutWorkerResponse): void { this.emit('message', { data: response }); }
}

function result(ids: string[], version: string): LayoutResult {
  const positions: LayoutResult['positions'] = {};
  ids.forEach((id, index) => { positions[id] = { x: 0, y: index * 216 }; });
  return {
    positions,
    edgeRoutes: [],
    branchTrunks: [],
    hiddenCounts: {},
    heights: {},
    diagnostics: [],
    bounds: { x: 0, y: 0, width: 360, height: 216 * ids.length },
    cardWidth: 360,
    cardHeight: 152,
    layoutVersion: 1,
    structureVersion: version,
  };
}

const input: LayoutInput = { nodes: [{ id: 'n1', from: null, flow: 'root' }], visibleNodeIds: ['n1'] };

describe('layout worker adapter', () => {
  it('resolves a matching result and sends the agreed request shape', async () => {
    const worker = new FakeWorker();
    const engine = createWorkerLayoutEngine(worker as unknown as Worker);
    const promise = engine.compute(input, 'k1');
    const request = worker.posted[0];
    expect(request?.type).toBe('layout');
    expect(typeof request?.requestId).toBe('string');
    expect(request?.sequence).toBe(1);
    if (request === undefined) throw new Error('missing request');
    worker.reply({ type: 'layout-result', requestId: request.requestId, sequence: request.sequence, structureVersion: 'k1', result: result(['n1'], 'k1') });
    const envelope = await promise;
    expect(envelope.structureVersion).toBe('k1');
    expect(envelope.result.positions['n1']).toEqual({ x: 0, y: 0 });
    engine.dispose();
  });

  it('rejects stale responses so callers can drop them', async () => {
    const worker = new FakeWorker();
    const engine = createWorkerLayoutEngine(worker as unknown as Worker);
    const promise = engine.compute(input, 'k1');
    const request = worker.posted[0];
    if (request === undefined) throw new Error('missing request');
    worker.reply({ type: 'layout-stale', requestId: request.requestId, sequence: request.sequence, structureVersion: 'k0' });
    await expect(promise).rejects.toBeInstanceOf(LayoutStaleError);
    engine.dispose();
  });

  it('rejects with the reported error code', async () => {
    const worker = new FakeWorker();
    const engine = createWorkerLayoutEngine(worker as unknown as Worker);
    const promise = engine.compute(input, 'k1');
    const request = worker.posted[0];
    if (request === undefined) throw new Error('missing request');
    worker.reply({ type: 'layout-error', requestId: request.requestId, sequence: request.sequence, structureVersion: 'k1', error: { code: 'missing-root', message: '没有根节点' } });
    await expect(promise).rejects.toMatchObject({ code: 'missing-root' });
    engine.dispose();
  });

  it('rejects pending work when the worker crashes and refuses new work', async () => {
    const worker = new FakeWorker();
    const engine = createWorkerLayoutEngine(worker as unknown as Worker);
    const promise = engine.compute(input, 'k1');
    worker.emit('error', { message: 'boom' });
    await expect(promise).rejects.toBeInstanceOf(LayoutFailureError);
    await expect(engine.compute(input, 'k2')).rejects.toMatchObject({ code: 'LAYOUT_WORKER_DEAD' });
    engine.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('rejects when postMessage throws instead of hanging forever', async () => {
    const worker = new FakeWorker();
    worker.postMessage = vi.fn(() => { throw new Error('DataCloneError'); });
    const engine = createWorkerLayoutEngine(worker as unknown as Worker);
    await expect(engine.compute(input, 'k1')).rejects.toMatchObject({ code: 'LAYOUT_POST_FAILED' });
    engine.dispose();
  });

  it('ignores responses for unknown request ids', async () => {
    const worker = new FakeWorker();
    const engine = createWorkerLayoutEngine(worker as unknown as Worker);
    const promise = engine.compute(input, 'k1');
    worker.reply({ type: 'layout-result', requestId: 'layout-999', sequence: 999, structureVersion: 'k1', result: result(['n1'], 'k1') });
    const request = worker.posted[0];
    if (request === undefined) throw new Error('missing request');
    worker.reply({ type: 'layout-result', requestId: request.requestId, sequence: request.sequence, structureVersion: 'k1', result: result(['n1'], 'k1') });
    await expect(promise).resolves.toBeDefined();
    engine.dispose();
  });
});
