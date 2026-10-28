/**
 * 服务端错误响应外形（协议 4 未在 DTO 中冻结错误体，客户端只按最小结构读取）。
 * 未知 code 一律按通用错误处理。
 */
interface ApiErrorResponseBody {
  error: {
    code: string;
    message?: string;
    details?: unknown;
  };
}

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

function isErrorBody(value: unknown): value is ApiErrorResponseBody {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

interface ErrorBodyDetails {
  code: string;
  message: string | null;
  details: unknown;
}

function errorBodyDetails(body: unknown): ErrorBodyDetails | null {
  if (!isErrorBody(body)) return null;
  return {
    code: body.error.code,
    message: typeof body.error.message === 'string' ? body.error.message : null,
    details: body.error.details ?? null,
  };
}

export interface RequestJsonOptions {
  signal: AbortSignal;
  method?: 'GET' | 'POST' | 'PUT';
  /** JSON body; omitted for GET. */
  body?: unknown;
  /** Write requests carry the service's client header and JSON content type. */
  write?: boolean;
  /** Message for a failed response without a usable error body. */
  fallbackMessage?: string;
  /** Message for an empty successful response. */
  emptyMessage?: string;
  /**
   * Read export/importance bodies historically fell back to the empty-response
   * path on unparsable JSON instead of BAD_RESPONSE.
   */
  malformedAsEmpty?: boolean;
}

/**
 * One transport for API JSON. Network failures, HTTP errors, malformed bodies and
 * empty bodies are errors, never empty data.
 */
export async function requestJson<T>(path: string, options: RequestJsonOptions): Promise<T> {
  const {
    signal,
    method = 'GET',
    body,
    write = false,
    fallbackMessage,
    emptyMessage = '服务返回了空响应',
    malformedAsEmpty = false,
  } = options;
  const headers = write
    ? {
        'content-type': 'application/json',
        // The service contract requires exactly this value on write requests;
        // anything else (including a browser-specific label) is rejected with 403.
        'x-aichat-client': 'cli',
      }
    : { accept: 'application/json' };

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(0, 'NETWORK', '无法连接到本地服务');
  }

  let parsed: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      if (!malformedAsEmpty) {
        throw new ApiError(response.status, 'BAD_RESPONSE', '服务返回了无法解析的内容', text.slice(0, 400));
      }
      parsed = null;
    }
  }

  if (!response.ok) {
    const details = errorBodyDetails(parsed);
    const fallback = fallbackMessage ?? '请求失败（HTTP ' + String(response.status) + '）';
    if (details !== null) {
      throw new ApiError(response.status, details.code, details.message ?? fallback, parsed, details.details);
    }
    throw new ApiError(response.status, 'HTTP_' + String(response.status), fallback, parsed);
  }
  if (parsed === null) {
    throw new ApiError(response.status, 'EMPTY_RESPONSE', emptyMessage);
  }
  return parsed as T;
}

/** GET JSON with abort support. */
export async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  return requestJson<T>(path, { signal });
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '未知错误';
}