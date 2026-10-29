import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/web/data/client.js';
import {
  openWorkspaceRuntime,
  runtimeErrorMessage,
  stopRuntimeService,
} from '../../src/web/data/runtime.js';

const REQUEST = { workspaceId: 'w_1', instanceId: 'inst-1' };

function respondWith(body: string, status = 200) {
  const fetchMock = vi.fn(async () => new Response(
    body,
    { status, headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('runtime control requests', () => {
  it('posts the current workspace and instance to stop and accepts the stopping answer', async () => {
    const fetchMock = respondWith('{"ok":true,"state":"stopping"}');
    await expect(stopRuntimeService(REQUEST, new AbortController().signal))
      .resolves.toEqual({ ok: true, state: 'stopping' });

    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/runtime/stop');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    // Local write transport: the service expects its own client label.
    expect(headers['x-aichat-client']).toBe('cli');
  });

  it('posts the current workspace and instance to open-workspace and accepts the started answer', async () => {
    const fetchMock = respondWith('{"ok":true,"state":"started"}');
    await expect(openWorkspaceRuntime(REQUEST, new AbortController().signal))
      .resolves.toEqual({ ok: true, state: 'started' });

    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/runtime/open-workspace');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
  });

  it('never treats an empty or unconfirmed answer as success', async () => {
    respondWith('');
    await expect(stopRuntimeService(REQUEST, new AbortController().signal)).rejects.toMatchObject({
      code: 'EMPTY_RESPONSE',
      message: '服务没有确认停止请求',
    });

    respondWith('{"ok":false}');
    await expect(openWorkspaceRuntime(REQUEST, new AbortController().signal)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'BAD_RESPONSE',
    });
  });

  it('passes a service error through with its status and message', async () => {
    respondWith('{"error":{"code":"OPEN_UNSUPPORTED","message":"没有启动器"}}', 501);
    await expect(openWorkspaceRuntime(REQUEST, new AbortController().signal)).rejects.toMatchObject({
      status: 501,
      code: 'OPEN_UNSUPPORTED',
      message: '没有启动器',
    });
  });
});

describe('runtime control messages', () => {
  it('distinguishes a lost connection from a confirmed stop', () => {
    expect(runtimeErrorMessage(new ApiError(0, 'NETWORK', '无法连接'), 'stop')).toContain('未确认停止');
    expect(runtimeErrorMessage(new ApiError(0, 'NETWORK', '无法连接'), 'open')).toContain('未发起打开请求');
  });

  it('explains unsupported endpoints and missing launchers', () => {
    expect(runtimeErrorMessage(new ApiError(404, 'NOT_FOUND', 'x'), 'open')).toContain('不支持运行控制');
    expect(runtimeErrorMessage(new ApiError(501, 'NOT_IMPLEMENTED', 'x'), 'open')).toContain('启动器');
    expect(runtimeErrorMessage(new ApiError(501, 'NOT_IMPLEMENTED', 'x'), 'stop')).toContain('不支持停止');
  });

  it('keeps the service-provided message for other rejections', () => {
    expect(runtimeErrorMessage(new ApiError(409, 'BUSY', '已有其他操作'), 'stop')).toContain('已有其他操作');
    expect(runtimeErrorMessage(new Error('boom'), 'open')).toContain('boom');
  });
});
