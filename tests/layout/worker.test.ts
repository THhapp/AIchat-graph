import { describe, expect, it } from 'vitest';
import { computeLayout, type LayoutNodeInput } from '../../src/web/layout/index.js';
import { createLayoutWorkerState, handleLayoutMessage } from '../../src/web/layout/workerHandler.js';

const nodes: LayoutNodeInput[] = [
  { id: '06', from: null, flow: 'root' },
  { id: '07', from: '06', flow: 'next' },
  { id: '06-03', from: '06', flow: 'branch', side: 'right', order: 10 },
  { id: '06-04', from: '06-03', flow: 'next' },
];

function request(requestId: string, sequence: number, version: string): unknown {
  return { type: 'layout', requestId, sequence, input: { nodes, structureVersion: version } };
}

describe('layout worker protocol', () => {
  it('returns a result echoing requestId, sequence and structureVersion', () => {
    const state = createLayoutWorkerState();
    const response = handleLayoutMessage(request('r1', 1, 'v1'), state);
    expect(response?.type).toBe('layout-result');
    if (response === null || response.type !== 'layout-result') return;
    expect(response.requestId).toBe('r1');
    expect(response.sequence).toBe(1);
    expect(response.structureVersion).toBe('v1');
    expect(Object.keys(response.result.positions).sort()).toEqual(['06', '06-03', '06-04', '07']);
  });

  it('answers a stale (older-sequence) request without recomputing over the newer one', () => {
    const state = createLayoutWorkerState();
    const newer = handleLayoutMessage(request('r2', 2, 'v2'), state);
    expect(newer?.type).toBe('layout-result');
    const older = handleLayoutMessage(request('r1', 1, 'v1'), state);
    expect(older?.type).toBe('layout-stale');
    if (older === null) return;
    expect(older.requestId).toBe('r1');
    expect(older.structureVersion).toBe('v1');
  });

  it('accepts the same sequence again (retries are not silently dropped)', () => {
    const state = createLayoutWorkerState();
    expect(handleLayoutMessage(request('r1', 5, 'v1'), state)?.type).toBe('layout-result');
    expect(handleLayoutMessage(request('r2', 5, 'v1'), state)?.type).toBe('layout-result');
  });

  it('ignores non-layout and malformed messages', () => {
    const state = createLayoutWorkerState();
    expect(handleLayoutMessage({ type: 'ping' }, state)).toBeNull();
    expect(handleLayoutMessage(null, state)).toBeNull();
    expect(handleLayoutMessage({ type: 'layout', requestId: 'x' }, state)).toBeNull();
  });

  it('always answers a well-formed envelope, even with unusable input', () => {
    const state = createLayoutWorkerState();
    const nullInput = handleLayoutMessage({ type: 'layout', requestId: 'bad', sequence: 1, input: null }, state);
    expect(nullInput?.type).toBe('layout-result');
    if (nullInput === null || nullInput.type !== 'layout-result') return;
    expect(nullInput.result.positions).toEqual({});
    expect(nullInput.result.diagnostics[0]?.code).toBe('invalid-input');

    const broken: unknown = { type: 'layout', requestId: 'bad2', sequence: 2, input: { nodes: 'nope' } };
    const result = handleLayoutMessage(broken, state);
    expect(result?.type).toBe('layout-result');
    if (result === null || result.type !== 'layout-result') return;
    expect(result.result.positions).toEqual({});
    expect(result.result.diagnostics[0]?.code).toBe('invalid-input');
  });
});

describe('layout determinism guard', () => {
  it('produces identical geometry for repeated calls', () => {
    const first = JSON.stringify(computeLayout({ nodes }));
    const second = JSON.stringify(computeLayout({ nodes: [...nodes].reverse() }));
    expect(second).toBe(first);
  });
});
