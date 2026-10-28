import type { ExportsResponse, TopicExportStatus } from '../../next/protocol.js';
import { getJson, requestJson } from './client.js';

/**
 * Export target/status calls go through the local service. The page never writes
 * a file itself and never turns an export into a browser download.
 */
export async function fetchExportStatuses(signal: AbortSignal): Promise<TopicExportStatus[]> {
  const response = await getJson<ExportsResponse>('/api/exports', signal);
  return response.topics;
}

function sendJson<T>(method: 'PUT' | 'POST', path: string, body: unknown, signal: AbortSignal): Promise<T> {
  return requestJson<T>(path, {
    method,
    body,
    signal,
    write: true,
    fallbackMessage: '导出请求失败',
    malformedAsEmpty: true,
  });
}

/** Sets or clears the absolute .html target for one topic. */
export async function setExportTarget(
  topicId: string,
  path: string | null,
  signal: AbortSignal,
): Promise<TopicExportStatus> {
  return sendJson<TopicExportStatus>(
    'PUT',
    '/api/exports/' + encodeURIComponent(topicId) + '/target',
    { path },
    signal,
  );
}

export async function retryExport(topicId: string, signal: AbortSignal): Promise<TopicExportStatus> {
  return sendJson<TopicExportStatus>(
    'POST',
    '/api/exports/' + encodeURIComponent(topicId) + '/retry',
    {},
    signal,
  );
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
