/**
 * Interface 4 CLI 的服务边界：
 * - 读取 <root>/.aichat/runtime/service.json，只接受 loopback http；
 * - GET /api/workspace 核对 workspaceId／rootPath／instanceId 与接口版本 4；
 * - 写：POST /api/agent/changes（不投递 /api/changes/:id；status 直接读 SQLite）；
 * - descriptor 缺失时按约定自启动同版 CLI 的 serve（端口由服务的端口偏好决定），轮询到超时，不杀后台进程；
 * - 连不上／结果不明时如实报告，不换 requestId 重发。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CliFailure,
  EXIT_CODES,
  operationConflictFailure,
  serviceFailure,
  usageFailure,
  validationFailure,
  versionConflictFailure,
} from './args.js';
import { INTERFACE_VERSION } from './protocol.js';
import type {
  AgentChangeAction,
  AgentChangeResponse,
  AgentCheckResponse,
  AgentChangeRequest,
  ProgramInfo,
  RuntimeStopResponse,
  WorkspaceResponse,
} from './protocol.js';

export const SERVICE_DESCRIPTOR_PATH = '.aichat/runtime/service.json';
export const DEFAULT_SERVICE_PORT = 4317;
export const REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_START_TIMEOUT_MS = 8_000;
export const DEFAULT_POLL_INTERVAL_MS = 100;
export const CLIENT_HEADER = 'X-AIchat-Client';
export const CLIENT_HEADER_VALUE = 'cli-interface4';

export interface ServiceDescriptor {
  readonly version?: number;
  readonly url: string;
  readonly workspaceId?: string;
  readonly instanceId?: string;
  readonly pid?: number;
  readonly rootPath?: string;
  readonly program?: ProgramInfo;
}

export interface SpawnedProcessLike {
  readonly pid?: number;
  unref?: () => void;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => SpawnedProcessLike;

export interface ServiceDeps {
  readonly fetchImpl: typeof fetch;
  readonly spawnImpl: SpawnLike;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly startTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly noStart: boolean;
  readonly requireInterface: boolean;
  /** 测试覆盖：自启动使用的 CLI 入口路径。 */
  readonly entryPath?: string | undefined;
}

export interface ResolvedService {
  readonly descriptor: ServiceDescriptor;
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly rootPath: string;
  readonly revision: number;
  readonly program: ProgramInfo | null;
  readonly interfaceCompatible: boolean;
}

export function serviceDescriptorPath(root: string): string {
  return path.join(root, ...SERVICE_DESCRIPTOR_PATH.split('/'));
}

function defaultSpawnImpl(
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
): SpawnedProcessLike {
  const child = spawn(command, [...args], options);
  return {
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    unref: () => {
      child.unref();
    },
  };
}

export function defaultServiceDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    fetchImpl: overrides.fetchImpl ?? fetch,
    spawnImpl: overrides.spawnImpl ?? defaultSpawnImpl,
    sleep:
      overrides.sleep ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    startTimeoutMs: overrides.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    pollIntervalMs: overrides.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    noStart: overrides.noStart ?? false,
    requireInterface: overrides.requireInterface ?? true,
    ...(overrides.entryPath !== undefined ? { entryPath: overrides.entryPath } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertLoopbackUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw serviceFailure('SERVICE_URL_INVALID', '服务地址不是合法 URL：' + rawUrl, { url: rawUrl });
  }
  if (url.protocol !== 'http:') {
    throw serviceFailure('SERVICE_URL_INVALID', '只允许本机 http 服务，收到 ' + url.protocol, {
      url: rawUrl,
    });
  }
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw serviceFailure('SERVICE_URL_INVALID', '只允许 loopback 地址，收到 ' + url.hostname, {
      url: rawUrl,
    });
  }
  if (url.username !== '' || url.password !== '') {
    throw serviceFailure('SERVICE_URL_INVALID', '服务地址不能包含凭据', { url: rawUrl });
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw serviceFailure('SERVICE_URL_INVALID', '服务地址不能带路径：' + url.pathname, {
      url: rawUrl,
    });
  }
  if (url.search !== '' || url.hash !== '') {
    throw serviceFailure('SERVICE_URL_INVALID', '服务地址不能带查询或片段', { url: rawUrl });
  }
  return url;
}

export function parseServiceDescriptor(raw: unknown): ServiceDescriptor {
  if (!isRecord(raw)) {
    throw serviceFailure('SERVICE_DESCRIPTOR_INVALID', 'service.json 必须是 JSON 对象');
  }
  const url = raw['url'];
  if (typeof url !== 'string' || url.length === 0) {
    throw serviceFailure('SERVICE_DESCRIPTOR_INVALID', 'service.json 缺少 url');
  }
  const descriptor: {
    version?: number;
    url: string;
    workspaceId?: string;
    instanceId?: string;
    pid?: number;
    rootPath?: string;
    program?: ProgramInfo;
  } = { url };
  if (raw['version'] !== undefined) {
    if (typeof raw['version'] !== 'number' || !Number.isInteger(raw['version']) || raw['version'] !== 1) {
      throw serviceFailure('SERVICE_DESCRIPTOR_INVALID', 'service.json 的 version 必须是 1');
    }
    descriptor.version = raw['version'];
  }
  for (const key of ['workspaceId', 'instanceId'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string' || (raw[key] as string).length === 0) {
        throw serviceFailure('SERVICE_DESCRIPTOR_INVALID', 'service.json 的 ' + key + ' 不合法');
      }
      descriptor[key] = raw[key] as string;
    }
  }
  if (raw['rootPath'] !== undefined) {
    if (typeof raw['rootPath'] !== 'string' || raw['rootPath'].length === 0) {
      throw serviceFailure('SERVICE_DESCRIPTOR_INVALID', 'service.json 的 rootPath 不合法');
    }
    descriptor.rootPath = raw['rootPath'];
  }
  if (raw['pid'] !== undefined) {
    if (typeof raw['pid'] !== 'number' || !Number.isInteger(raw['pid']) || raw['pid'] <= 0) {
      throw serviceFailure('SERVICE_DESCRIPTOR_INVALID', 'service.json 的 pid 不合法');
    }
    descriptor.pid = raw['pid'];
  }
  if (raw['program'] !== undefined) {
    const program = parseProgramInfo(raw['program']);
    if (program === null) {
      throw serviceFailure('SERVICE_DESCRIPTOR_INVALID', 'service.json 的 program 不合法');
    }
    descriptor.program = program;
  }
  return descriptor;
}

export function parseProgramInfo(raw: unknown): ProgramInfo | null {
  if (!isRecord(raw)) return null;
  const program = raw['program'];
  const version = raw['version'];
  const interfaceVersion = raw['interfaceVersion'];
  const buildId = raw['buildId'];
  if (
    program !== 'aichat-graph' ||
    typeof version !== 'string' ||
    typeof interfaceVersion !== 'number' ||
    !Number.isInteger(interfaceVersion) ||
    typeof buildId !== 'string' ||
    buildId.length === 0
  ) {
    return null;
  }
  const commit = raw['commit'];
  const builtAt = raw['builtAt'];
  const manifest = raw['manifest'];
  return {
    program: 'aichat-graph',
    version,
    interfaceVersion,
    buildId,
    commit: typeof commit === 'string' ? commit : null,
    builtAt: typeof builtAt === 'string' ? builtAt : null,
    ...(manifest === 'dist' || manifest === 'dev' || manifest === 'invalid' ? { manifest } : {}),
  };
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: unknown; text: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw serviceFailure(
      'SERVICE_UNREACHABLE',
      '请求 ' + url + ' 失败：' + (error instanceof Error ? error.message : String(error)),
      { url },
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw serviceFailure(
      'SERVICE_UNREACHABLE',
      '读取 ' + url + ' 的响应失败（连接中断）',
      { url },
    );
  }
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, body, text };
}

export function serviceErrorFromResponse(outcome: {
  status: number;
  body: unknown;
}): CliFailure {
  const envelope = isRecord(outcome.body) && isRecord(outcome.body['error'])
    ? outcome.body['error']
    : null;
  const code = typeof envelope?.['code'] === 'string' ? envelope['code'] : undefined;
  const message =
    typeof envelope?.['message'] === 'string' && envelope['message'].length > 0
      ? envelope['message']
      : '服务返回 HTTP ' + String(outcome.status);
  const details = isRecord(envelope?.['details']) ? (envelope['details'] as Record<string, unknown>) : undefined;
  const status = outcome.status;
  if (status === 412) {
    return versionConflictFailure(message, details);
  }
  if (status === 409) {
    return operationConflictFailure(code ?? 'OPERATION_CONFLICT', message, details);
  }
  if (status === 422) {
    return validationFailure(code ?? 'VALIDATION_FAILED', message, details);
  }
  if (status === 400) {
    return usageFailure(message, { ...(details !== undefined ? { details } : {}) });
  }
  if (status === 404) {
    return new CliFailure('SERVICE_HTTP_ERROR', message, EXIT_CODES.http, {
      ...(details !== undefined ? { details } : {}),
    });
  }
  return new CliFailure('SERVICE_HTTP_ERROR', message, EXIT_CODES.http, {
    ...(details !== undefined ? { details } : {}),
  });
}

export async function readServiceDescriptor(root: string): Promise<ServiceDescriptor | null> {
  const file = serviceDescriptorPath(root);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw serviceFailure('SERVICE_DESCRIPTOR_UNREADABLE', '无法读取服务描述文件：' + file, {
      descriptorPath: file,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw serviceFailure('SERVICE_DESCRIPTOR_INVALID', '服务描述文件不是合法 JSON：' + file, {
      descriptorPath: file,
    });
  }
  return parseServiceDescriptor(parsed);
}

export async function fetchWorkspaceIdentity(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<WorkspaceResponse> {
  const endpoint = new URL('api/workspace', baseUrl).toString();
  const outcome = await requestJson(
    endpoint,
    { method: 'GET', headers: { accept: 'application/json' } },
    fetchImpl,
  );
  if (outcome.status < 200 || outcome.status >= 300) {
    throw serviceErrorFromResponse({ status: outcome.status, body: outcome.body });
  }
  const body = outcome.body;
  if (!isRecord(body)) {
    throw serviceFailure('SERVICE_RESPONSE_INVALID', endpoint + ' 的响应不是 JSON 对象', {
      endpoint,
    });
  }
  const { workspaceId, instanceId, rootPath, name, revision, stale, diagnostics, program } = body;
  if (
    typeof workspaceId !== 'string' ||
    typeof instanceId !== 'string' ||
    typeof rootPath !== 'string' ||
    typeof revision !== 'number'
  ) {
    throw serviceFailure(
      'SERVICE_RESPONSE_INVALID',
      endpoint + ' 缺少 workspaceId／instanceId／rootPath／revision',
      { endpoint },
    );
  }
  return {
    workspaceId,
    instanceId,
    rootPath,
    revision,
    name: typeof name === 'string' ? name : '',
    activeNode: typeof body['activeNode'] === 'string' ? (body['activeNode'] as string) : null,
    stale: stale === true,
    diagnostics: Array.isArray(diagnostics) ? (diagnostics as WorkspaceResponse['diagnostics']) : [],
    ...(parseProgramInfo(program) !== null ? { program: parseProgramInfo(program) as ProgramInfo } : {}),
  };
}

/** Windows 8.3 短名／大小写／斜杠差异不应被当成不同工作区；比较前统一真实路径。 */
async function canonicalForCompare(value: string): Promise<string> {
  let resolved = path.resolve(value);
  try {
    resolved = await fs.realpath(resolved);
  } catch {
    // 路径不存在时保留解析后的形式，由 mismatches 报告真实差异。
  }
  resolved = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function assertIdentity(input: {
  root: string;
  workspaceId: string;
  descriptor: ServiceDescriptor;
  identity: WorkspaceResponse;
}): Promise<void> {
  const mismatches: string[] = [];
  if (input.identity.workspaceId !== input.workspaceId) {
    mismatches.push(
      'workspaceId: local=' + input.workspaceId + ' service=' + input.identity.workspaceId,
    );
  }
  if (input.descriptor.workspaceId !== undefined && input.descriptor.workspaceId !== input.identity.workspaceId) {
    mismatches.push(
      'workspaceId: descriptor=' +
        input.descriptor.workspaceId +
        ' service=' +
        input.identity.workspaceId,
    );
  }
  const localRoot = await canonicalForCompare(input.root);
  const serviceRoot = await canonicalForCompare(input.identity.rootPath);
  if (serviceRoot !== localRoot) {
    mismatches.push(
      'rootPath: local=' + input.root + ' service=' + input.identity.rootPath,
    );
  }
  if (input.descriptor.rootPath !== undefined) {
    const descriptorRoot = await canonicalForCompare(input.descriptor.rootPath);
    if (descriptorRoot !== localRoot) {
      mismatches.push(
        'rootPath: descriptor=' + input.descriptor.rootPath + ' local=' + input.root,
      );
    }
  }
  if (input.descriptor.instanceId !== undefined && input.descriptor.instanceId !== input.identity.instanceId) {
    mismatches.push(
      'instanceId: descriptor=' +
        input.descriptor.instanceId +
        ' service=' +
        input.identity.instanceId,
    );
  }
  if (mismatches.length > 0) {
    throw serviceFailure(
      'SERVICE_IDENTITY_MISMATCH',
      '服务身份与当前工作区不一致；拒绝发送请求（不会回退到其他服务或端口）',
      {
        mismatches,
        descriptor: input.descriptor,
        service: {
          workspaceId: input.identity.workspaceId,
          instanceId: input.identity.instanceId,
          rootPath: input.identity.rootPath,
        },
        workspaceRoot: input.root,
      },
    );
  }
}

function assertInterface(
  program: ProgramInfo | null,
  requireInterface: boolean,
  identityUrl: string,
): boolean {
  const actual = program?.interfaceVersion ?? null;
  const compatible = program !== null && program.interfaceVersion === INTERFACE_VERSION;
  if (!compatible && requireInterface) {
    if (program === null) {
      throw serviceFailure(
        'INTERFACE_MISMATCH',
        '服务未声明接口版本（可能是旧版服务）；本 CLI 需要接口版本 ' + String(INTERFACE_VERSION) +
          '。请重新构建并重启服务，或运行 aichat whoami 诊断。',
        { reason: 'missing', expectedInterfaceVersion: INTERFACE_VERSION, url: identityUrl },
      );
    }
    throw serviceFailure(
      'INTERFACE_MISMATCH',
      '服务接口版本为 ' + String(program.interfaceVersion) + '，本 CLI 需要 ' +
        String(INTERFACE_VERSION) + '；请让 CLI 与服务使用同一构建。',
      {
        reason: 'mismatch',
        expectedInterfaceVersion: INTERFACE_VERSION,
        serviceProgram: program,
        url: identityUrl,
      },
    );
  }
  return compatible;
}

async function resolveFromDescriptor(
  root: string,
  workspaceId: string,
  descriptor: ServiceDescriptor,
  deps: ServiceDeps,
): Promise<ResolvedService> {
  const url = assertLoopbackUrl(descriptor.url);
  const identity = await fetchWorkspaceIdentity(url.toString(), deps.fetchImpl);
  await assertIdentity({ root, workspaceId, descriptor, identity });
  const compatible = assertInterface(identity.program ?? null, deps.requireInterface, url.toString());
  return {
    descriptor,
    baseUrl: url.toString(),
    workspaceId: identity.workspaceId,
    instanceId: identity.instanceId,
    rootPath: identity.rootPath,
    revision: identity.revision,
    program: identity.program ?? null,
    interfaceCompatible: compatible,
  };
}

/** 自启动入口：优先当前 CLI 脚本，其次编译后的同目录 cli.js。 */
export function cliEntryPath(): string | null {
  const argv1 = process.argv[1];
  if (typeof argv1 === 'string' && /\.(?:mjs|cjs|js)$/i.test(argv1) && existsSync(argv1)) {
    return path.resolve(argv1);
  }
  const compiled = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (existsSync(compiled)) return compiled;
  return null;
}

export async function startServiceProcess(root: string, deps: ServiceDeps): Promise<void> {
  const entry = deps.entryPath ?? cliEntryPath();
  if (entry === null) {
    throw serviceFailure(
      'SERVICE_START_FAILED',
      '无法确定自启动入口；请显式运行 aichat serve --workspace <dir>',
      { root },
    );
  }
  try {
    // 不传 --port 0：由服务读取自己的端口偏好，避免每次启动都换端口。
    const child = deps.spawnImpl(
      process.execPath,
      [entry, 'serve', '--workspace', root, '--no-browser'],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref?.();
  } catch (error) {
    throw serviceFailure(
      'SERVICE_START_FAILED',
      '自启动服务失败：' + (error instanceof Error ? error.message : String(error)),
      { root, entry },
    );
  }
}

async function waitForStartedService(
  root: string,
  workspaceId: string,
  deps: ServiceDeps,
): Promise<ResolvedService> {
  const deadline = Date.now() + deps.startTimeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const descriptor = await readServiceDescriptor(root);
      if (descriptor !== null) {
        return await resolveFromDescriptor(root, workspaceId, descriptor, deps);
      }
    } catch (error) {
      lastError = error;
    }
    await deps.sleep(deps.pollIntervalMs);
  }
  throw serviceFailure(
    'SERVICE_START_TIMEOUT',
    '已尝试自启动服务，但 ' +
      String(deps.startTimeoutMs) +
      'ms 内没有可用的服务（descriptor：' +
      serviceDescriptorPath(root) +
      '）',
    {
      descriptorPath: serviceDescriptorPath(root),
      ...(lastError instanceof Error ? { lastError: lastError.message } : {}),
    },
  );
}

/** 解析本工作区的服务；descriptor 缺失时按约定自启动并轮询。 */
export async function resolveService(
  root: string,
  workspaceId: string,
  deps: ServiceDeps,
): Promise<ResolvedService> {
  const descriptor = await readServiceDescriptor(root);
  if (descriptor !== null) {
    return resolveFromDescriptor(root, workspaceId, descriptor, deps);
  }
  if (deps.noStart) {
    throw serviceFailure(
      'SERVICE_NOT_RUNNING',
      '该工作区没有运行中的服务（' + serviceDescriptorPath(root) + ' 不存在）；请运行 aichat serve --workspace <dir>，或允许 CLI 自启动',
      { descriptorPath: serviceDescriptorPath(root) },
    );
  }
  await startServiceProcess(root, deps);
  return waitForStartedService(root, workspaceId, deps);
}

export interface EnsureServiceResult {
  readonly service: ResolvedService;
  /** true 表示复用了 descriptor 指向的存活服务；false 表示本次自启动。 */
  readonly reused: boolean;
}

const STALE_DESCRIPTOR_CODES: ReadonlySet<string> = new Set([
  'SERVICE_UNREACHABLE',
  'SERVICE_DESCRIPTOR_INVALID',
  'SERVICE_DESCRIPTOR_UNREADABLE',
  'SERVICE_URL_INVALID',
]);

/**
 * open 的服务边界：优先复用存活 descriptor；descriptor 缺失或已失效（进程已退出、
 * 端口拒绝连接、描述文件损坏）时自启动一次并轮询。绝不按 PID 杀进程。
 */
export async function ensureService(
  root: string,
  workspaceId: string,
  deps: ServiceDeps,
): Promise<EnsureServiceResult> {
  let descriptor: ServiceDescriptor | null = null;
  try {
    descriptor = await readServiceDescriptor(root);
  } catch (error) {
    if (error instanceof CliFailure && STALE_DESCRIPTOR_CODES.has(error.code)) {
      descriptor = null;
    } else {
      throw error;
    }
  }
  if (descriptor !== null) {
    try {
      const service = await resolveFromDescriptor(root, workspaceId, descriptor, deps);
      return { service, reused: true };
    } catch (error) {
      if (!(error instanceof CliFailure) || !STALE_DESCRIPTOR_CODES.has(error.code)) {
        throw error;
      }
      // 失效描述：交给下方自启动覆盖，不删除他人 descriptor。
    }
  }
  if (deps.noStart) {
    throw serviceFailure(
      'SERVICE_NOT_RUNNING',
      '该工作区没有运行中的服务（' + serviceDescriptorPath(root) + ' 不存在或已失效）；请运行 aichat serve --workspace <dir>，或允许 CLI 自启动',
      { descriptorPath: serviceDescriptorPath(root) },
    );
  }
  await startServiceProcess(root, deps);
  const service = await waitForStartedService(root, workspaceId, deps);
  return { service, reused: false };
}

/** POST /api/runtime/stop 的返回值；只表示服务接受了停止请求。 */
export interface RuntimeStopResult {
  readonly httpStatus: number;
  readonly response: RuntimeStopResponse;
}

/**
 * 请求服务自行停止（POST /api/runtime/stop）。连接拒绝由调用方视为「已不在运行」；
 * 旧版服务没有该端点时返回 404，这里给出明确的不支持错误，绝不移交 PID 杀进程。
 */
export async function requestRuntimeStop(
  service: ResolvedService,
  deps: ServiceDeps,
): Promise<RuntimeStopResult> {
  const endpoint = new URL('api/runtime/stop', service.baseUrl).toString();
  const body = JSON.stringify({
    workspaceId: service.workspaceId,
    instanceId: service.instanceId,
  });
  let outcome: { status: number; body: unknown; text: string };
  try {
    outcome = await requestJson(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
        },
        body,
      },
      deps.fetchImpl,
    );
  } catch (error) {
    throw error;
  }
  if (outcome.status === 404) {
    throw new CliFailure(
      'SERVICE_STOP_UNSUPPORTED',
      '该服务是旧版本，没有 POST /api/runtime/stop（HTTP 404）；CLI 不会按 PID 杀进程。' +
        '请关闭服务窗口／结束其运行后重试，或升级到同一构建。',
      EXIT_CODES.service,
      {
        details: {
          endpoint,
          httpStatus: 404,
          url: service.baseUrl,
          hint: '旧服务没有运行控制端点；本命令只请求服务自己退出。',
        },
      },
    );
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    throw serviceErrorFromResponse({ status: outcome.status, body: outcome.body });
  }
  if (!isRecord(outcome.body) || outcome.body['ok'] !== true) {
    throw serviceFailure('SERVICE_RESPONSE_INVALID', endpoint + ' 的响应缺少 ok:true', {
      endpoint,
    });
  }
  return { httpStatus: outcome.status, response: outcome.body as unknown as RuntimeStopResponse };
}

/** 轮询直到服务端口不可达或 descriptor 消失；超时不杀进程，交给调用方报错。 */
export async function waitForServiceStopped(
  root: string,
  baseUrl: string,
  deps: ServiceDeps,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const probeUrl = new URL('api/workspace', baseUrl).toString();
  while (Date.now() < deadline) {
    if (!existsSync(serviceDescriptorPath(root))) return;
    let alive = false;
    try {
      const response = await deps.fetchImpl(probeUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(1_000),
      });
      alive = response.status >= 200 && response.status < 500;
    } catch {
      return;
    }
    if (!alive) return;
    await deps.sleep(deps.pollIntervalMs);
  }
  throw serviceFailure(
    'SERVICE_STOP_TIMEOUT',
    '已请求服务停止，但 ' + String(timeoutMs) + 'ms 内仍能访问 ' + baseUrl +
      '；不会按 PID 杀进程，请手动检查。',
    { url: baseUrl, timeoutMs, descriptorPath: serviceDescriptorPath(root) },
  );
}

export interface SubmitResult {
  readonly requestId: string;
  readonly httpStatus: number;
  readonly response: AgentChangeResponse | AgentCheckResponse;
}

/** 提交一次写入动作。结果不明时报告 RESULT_UNKNOWN，不换 requestId 重发。 */
export interface SubmitOptions {
  /** batch dry-run：请求体带 dryRun:true，服务只检查不落库。 */
  readonly dryRun?: boolean | undefined;
}

export async function submitAgentChange(
  service: ResolvedService,
  action: AgentChangeAction,
  deps: ServiceDeps,
  requestId: string = randomUUID(),
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  const endpoint = new URL('api/agent/changes', service.baseUrl).toString();
  const request: AgentChangeRequest = {
    workspaceId: service.workspaceId,
    requestId,
    ...(options.dryRun === true ? { dryRun: true } : {}),
    action,
  };
  let outcome: { status: number; body: unknown; text: string };
  try {
    outcome = await requestJson(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
        },
        body: JSON.stringify(request),
      },
      deps.fetchImpl,
    );
  } catch (error) {
    // 连接中断时写入可能已生效。不猜结果、不重发：交给 status（直接读 DB）。
    if (error instanceof CliFailure && error.code === 'SERVICE_UNREACHABLE') {
      throw new CliFailure(
        'RESULT_UNKNOWN',
        '写入请求结果未知（连接中断）。先用 aichat status ' + requestId + ' 查询，不要换 requestId 重发',
        EXIT_CODES.resultUnknown,
        {
          details: {
            requestId,
            endpoint,
            ...(error.details !== undefined ? { cause: error.details } : {}),
          },
          cause: error,
        },
      );
    }
    throw error;
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    throw serviceErrorFromResponse({ status: outcome.status, body: outcome.body });
  }
  if (!isRecord(outcome.body) || outcome.body['ok'] !== true) {
    throw serviceFailure(
      'SERVICE_RESPONSE_INVALID',
      endpoint + ' 的响应缺少 ok:true',
      { endpoint },
    );
  }
  return {
    requestId,
    httpStatus: outcome.status,
    response: outcome.body as unknown as AgentChangeResponse | AgentCheckResponse,
  };
}
