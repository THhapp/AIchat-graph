import type { LayoutInput, LayoutResult } from './types.js';

/**
 * Worker 协议。页面层应以 requestId/sequence 识别自己的请求，并按
 * structureVersion 丢弃旧结果；result 原样回显请求的结构版本。
 */
export interface LayoutWorkerRequest {
  type: 'layout';
  requestId: string;
  sequence: number;
  input: LayoutInput;
}

export interface LayoutWorkerResultMessage {
  type: 'layout-result';
  requestId: string;
  sequence: number;
  structureVersion: number | string | null;
  result: LayoutResult;
}

export interface LayoutWorkerStaleMessage {
  type: 'layout-stale';
  requestId: string;
  sequence: number;
  structureVersion: number | string | null;
}

export interface LayoutWorkerErrorMessage {
  type: 'layout-error';
  requestId: string;
  sequence: number;
  structureVersion: number | string | null;
  error: { code: string; message: string };
}

export type LayoutWorkerResponse =
  | LayoutWorkerResultMessage
  | LayoutWorkerStaleMessage
  | LayoutWorkerErrorMessage;
