import { useEffect, useRef, useState } from 'react';
import type { LayoutPosition, LayoutResult } from '../layout/types.js';
import { LayoutFailureError, LayoutStaleError, layoutInputForView, type LayoutEngineSlot } from './layoutBridge.js';
import type { GraphView } from './viewModel.js';

export interface LayoutState {
  result: LayoutResult | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: { code: string; message: string } | null;
  /** structureVersion of the applied result. */
  appliedVersion: string | null;
}

const EMPTY: LayoutState = { result: null, status: 'idle', error: null, appliedVersion: null };

/**
 * Recomputes geometry only when the structure key changes. Overlapping requests
 * resolve in favour of the newest key; late answers for old keys are discarded,
 * never drawn over the current graph. Only text edits that leave label wrapping
 * and title height unchanged keep the key; a relationship wording change
 * recomputes the layout, and anchor compensation preserves the reading position.
 */
export function useGraphLayout(view: GraphView | null, slot: LayoutEngineSlot): LayoutState {
  const [state, setState] = useState<LayoutState>(EMPTY);
  const previousPositions = useRef<Record<string, LayoutPosition>>({});
  const latestKey = useRef<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (view === null) {
      latestKey.current = null;
      setState(EMPTY);
      return;
    }
    const key = view.structureKey;
    latestKey.current = key;
    const requestId = ++requestSeq.current;

    if (slot.status === 'loading') {
      setState({ result: null, status: 'loading', error: null, appliedVersion: null });
      return;
    }
    if (slot.engine === null) {
      setState({
        result: null,
        status: 'error',
        error: { code: 'LAYOUT_UNAVAILABLE', message: '布局模块尚未提供（src/web/layout/worker.ts），未绘制节点坐标。' },
        appliedVersion: null,
      });
      return;
    }

    setState((current) => ({ ...current, status: 'loading' }));

    const input = layoutInputForView(view, { previousPositions: previousPositions.current });

    let cancelled = false;
    slot.engine.compute(input, key).then(
      (envelope) => {
        if (cancelled || requestId !== requestSeq.current || latestKey.current !== key) return;
        if (envelope.structureVersion !== null && String(envelope.structureVersion) !== key) return;
        const positions: Record<string, LayoutPosition> = {};
        let complete = true;
        for (const id of view.visibleIds) {
          const position = envelope.result.positions[id];
          if (position === undefined) {
            complete = false;
            continue;
          }
          positions[id] = { x: position.x, y: position.y };
        }
        if (!complete) {
          setState({
            result: envelope.result,
            status: 'error',
            error: { code: 'LAYOUT_INCOMPLETE', message: '布局未返回全部可见节点的位置，未使用不完整坐标。' },
            appliedVersion: null,
          });
          return;
        }
        previousPositions.current = positions;
        setState({ result: envelope.result, status: 'ready', error: null, appliedVersion: key });
      },
      (failure: unknown) => {
        if (cancelled || requestId !== requestSeq.current || latestKey.current !== key) return;
        if (failure instanceof LayoutStaleError) return;
        if (failure instanceof LayoutFailureError) {
          setState({ result: null, status: 'error', error: { code: failure.code, message: failure.message }, appliedVersion: null });
          return;
        }
        const message = failure instanceof Error ? failure.message : '布局计算失败';
        setState({ result: null, status: 'error', error: { code: 'LAYOUT_FAILED', message }, appliedVersion: null });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [view, slot]);

  return state;
}
