import type {
  RuntimeOpenWorkspaceRequest,
  RuntimeOpenWorkspaceResponse,
  RuntimeStopRequest,
  RuntimeStopResponse,
} from '../../next/protocol.js';
import { ApiError, errorMessage, requestJson } from './client.js';

/**
 * Local runtime controls.
 *
 * These endpoints belong to the service that is serving this page: they open
 * another discussion library or stop this one. They are local writes, so the
 * same JSON/client-header transport as other local writes is used. The reader
 * only asks and reports; it never starts a service on page load or after a stop.
 */
const RUNTIME_STOP_PATH = '/api/runtime/stop';
const RUNTIME_OPEN_PATH = '/api/runtime/open-workspace';

interface RuntimeControlBody {
  workspaceId: string;
  instanceId: string;
}

function bodyOf(request: RuntimeStopRequest | RuntimeOpenWorkspaceRequest): RuntimeControlBody {
  return { workspaceId: request.workspaceId, instanceId: request.instanceId };
}

/** The frozen contract answers { ok: true, state }; anything else is not a confirmation. */
function assertRuntimeOk(body: unknown, message: string): void {
  if (typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) {
    throw new ApiError(200, 'BAD_RESPONSE', message);
  }
}

/** POST /api/runtime/stop: asks the running service to shut down. */
export async function stopRuntimeService(
  request: RuntimeStopRequest,
  signal: AbortSignal,
): Promise<RuntimeStopResponse> {
  const body = await requestJson<Partial<RuntimeStopResponse>>(RUNTIME_STOP_PATH, {
    method: 'POST',
    signal,
    write: true,
    body: bodyOf(request),
    fallbackMessage: '停止本库服务失败',
    emptyMessage: '服务没有确认停止请求',
    malformedAsEmpty: true,
  });
  assertRuntimeOk(body, '服务没有确认停止请求');
  return { ok: true, state: 'stopping' };
}

/** POST /api/runtime/open-workspace: asks the service to open another library. */
export async function openWorkspaceRuntime(
  request: RuntimeOpenWorkspaceRequest,
  signal: AbortSignal,
): Promise<RuntimeOpenWorkspaceResponse> {
  const body = await requestJson<Partial<RuntimeOpenWorkspaceResponse>>(RUNTIME_OPEN_PATH, {
    method: 'POST',
    signal,
    write: true,
    body: bodyOf(request),
    fallbackMessage: '打开其他讨论库失败',
    emptyMessage: '服务没有确认打开请求',
    malformedAsEmpty: true,
  });
  assertRuntimeOk(body, '服务没有确认打开请求');
  return { ok: true, state: 'started' };
}

export type RuntimeAction = 'open' | 'stop';

/** Human-readable reason for a failed runtime control request. */
export function runtimeErrorMessage(error: unknown, action: RuntimeAction): string {
  const prefix = action === 'stop' ? '停止本库服务失败：' : '打开其他讨论库失败：';
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK') {
      return action === 'stop'
        ? '无法连接本地服务，未确认停止；当前页面保持原样。'
        : '无法连接本地服务，未发起打开请求。';
    }
    if (error.status === 404) return '当前服务不支持运行控制，请使用同版本的服务与页面。';
    if (error.status === 501) {
      return action === 'open'
        ? '当前运行方式没有可用的程序启动器，无法从这里打开其他讨论库；请使用便携版或手动打开。'
        : '当前运行方式不支持停止服务。';
    }
    if (error.status === 403) return '服务拒绝了该操作：' + error.message;
    return prefix + error.message;
  }
  return prefix + errorMessage(error);
}
