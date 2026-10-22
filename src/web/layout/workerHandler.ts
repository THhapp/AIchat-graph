import { computeLayout } from './index.js';
import type { LayoutWorkerRequest, LayoutWorkerResponse } from './workerProtocol.js';

export interface LayoutWorkerState {
  /** 已受理的最大请求序号；更旧的请求直接返回 layout-stale。 */
  latestSequence: number;
}

export function createLayoutWorkerState(): LayoutWorkerState {
  return { latestSequence: Number.NEGATIVE_INFINITY };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function structureVersionOf(input: unknown): number | string | null {
  if (!isRecord(input)) return null;
  const value = input.structureVersion;
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function asRequest(value: unknown): LayoutWorkerRequest | null {
  if (!isRecord(value)) return null;
  const requestId = value.requestId;
  const sequence = value.sequence;
  if (value.type !== 'layout' || typeof requestId !== 'string') return null;
  if (typeof sequence !== 'number' || !Number.isFinite(sequence)) return null;
  // input 即使损坏也交给 computeLayout 产生诊断结果，避免调用方一直等待。
  return { type: 'layout', requestId, sequence, input: value.input as LayoutWorkerRequest['input'] };
}

/**
 * 单条 Worker 消息的处理。与 Worker 全局作用域解耦，便于直接测试。
 * 返回 null 表示消息不是布局请求，应忽略。
 */
export function handleLayoutMessage(value: unknown, state: LayoutWorkerState): LayoutWorkerResponse | null {
  const request = asRequest(value);
  if (request === null) return null;

  const structureVersion = structureVersionOf(request.input);
  if (request.sequence < state.latestSequence) {
    return { type: 'layout-stale', requestId: request.requestId, sequence: request.sequence, structureVersion };
  }
  state.latestSequence = request.sequence;

  try {
    const result = computeLayout(request.input);
    return {
      type: 'layout-result',
      requestId: request.requestId,
      sequence: request.sequence,
      structureVersion: result.structureVersion,
      result,
    };
  } catch (error) {
    return {
      type: 'layout-error',
      requestId: request.requestId,
      sequence: request.sequence,
      structureVersion,
      error: { code: 'LAYOUT_FAILED', message: error instanceof Error ? error.message : '布局计算失败' },
    };
  }
}
