import type {
  ExportTargetResponse,
  ExportsResponse,
  TopicExportStatus,
} from '../../shared/protocol.js';
import { ApiError, errorMessage, getJson } from './client.js';

/**
 * Export target/status calls go through the local service. The page never writes
 * a file itself and never turns an export into a browser download.
 */
export async function fetchExportStatuses(signal: AbortSignal): Promise<TopicExportStatus[]> {
  const response = await getJson<ExportsResponse>('/api/exports', signal);
  return response.topics;
}

async function sendJson<T>(method: 'PUT' | 'POST', path: string, body: unknown, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: {
        'content-type': 'application/json',
        // The service contract requires exactly this value on write requests;
        // anything else (including a browser-specific label) is rejected with 403.
        'x-aichat-client': 'cli',
      },
      body: JSON.stringify(body),
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
    throw new ApiError(response.status, error?.code ?? 'HTTP_' + String(response.status), error?.message ?? '导出请求失败', parsed);
  }
  if (parsed === null) throw new ApiError(response.status, 'EMPTY_RESPONSE', '服务返回了空响应');
  return parsed as T;
}

/** Sets or clears the absolute .html target for one topic. */
export async function setExportTarget(
  topicId: string,
  path: string | null,
  signal: AbortSignal,
): Promise<TopicExportStatus> {
  const response = await sendJson<ExportTargetResponse>(
    'PUT',
    '/api/exports/' + encodeURIComponent(topicId) + '/target',
    { path },
    signal,
  );
  return response;
}

export async function retryExport(topicId: string, signal: AbortSignal): Promise<TopicExportStatus> {
  const response = await sendJson<ExportTargetResponse>(
    'POST',
    '/api/exports/' + encodeURIComponent(topicId) + '/retry',
    {},
    signal,
  );
  return response;
}

export function exportStateLabel(status: TopicExportStatus): string {
  switch (status.state) {
    case 'unset': return '未设置目标';
    case 'pending': return '等待生成';
    case 'writing': return '正在写入';
    case 'ready': return '已是最新';
    case 'error': return '导出失败';
    case 'stale': return '源已更新，待重生成';
    default: return status.state;
  }
}

/** Explains whether the file on disk matches the current source snapshot. */
export function describeExportFreshness(status: TopicExportStatus): string {
  if (status.targetPath === null) return '尚未选择保存位置';
  if (status.exportedFingerprint === null) return '尚未成功生成';
  if (status.sourceFingerprint === null) return '源快照不可用';
  if (status.exportedFingerprint === status.sourceFingerprint) return '成品与当前源一致';
  return '成品来自较早的源版本';
}

export { errorMessage };
