import type { ApiErrorResponse } from '../../shared/protocol.js';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly body: unknown;
  /** Machine-readable payload (hashes, missingFiles, ...) when the service sends it. */
  readonly details: unknown;

  constructor(status: number, code: string, message: string, body: unknown = null, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.details = details;
  }
}

function isErrorBody(value: unknown): value is ApiErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

/** GET JSON with abort support. Network failures and malformed bodies are errors, never empty data. */
export async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { signal, headers: { accept: 'application/json' } });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(0, 'NETWORK', '无法连接到本地服务');
  }

  let body: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(response.status, 'BAD_RESPONSE', '服务返回了无法解析的内容', text.slice(0, 400));
    }
  }

  if (!response.ok) {
    if (isErrorBody(body)) {
      throw new ApiError(response.status, body.error.code, body.error.message, body, body.error.details ?? null);
    }
    throw new ApiError(response.status, 'HTTP_' + String(response.status), '请求失败（HTTP ' + String(response.status) + '）', body);
  }
  if (body === null) {
    throw new ApiError(response.status, 'EMPTY_RESPONSE', '服务返回了空响应');
  }
  return body as T;
}

export function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '未知错误';
}