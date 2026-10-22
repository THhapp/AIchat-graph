/**
 * CLI 与服务描述文件的连接规则：
 * - 只读 <root>/.aichat/runtime/service.json，不跟随外部符号链接；
 * - url 只接受 loopback HTTP，且不得带凭据／路径／查询；
 * - 先 GET /api/workspace，核对 workspaceId、instanceId、rootPath；
 * - 错配／不可达／描述文件陈旧一律拒绝；不回退默认端口上的其他工作区，
 *   也不自动启动新服务。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { workspaceMetaSchema, type WorkspaceMeta } from "../core/index.js";
import {
  assertPathInsideWorkspace,
  isErrnoCode,
  readWorkspaceFile,
  resolveWorkspaceRoot,
  StorageError,
} from "../storage/index.js";
import { CliError, EXIT_CODES } from "./errors.js";

export const SERVICE_DESCRIPTOR_PATH = ".aichat/runtime/service.json";
export const CLIENT_HEADER = "X-AIchat-Client";
export const CLIENT_HEADER_VALUE = "cli";
export const DEFAULT_PORT = 4317;
export const REQUEST_TIMEOUT_MS = 15_000;

export interface ServiceDescriptor {
  readonly url: string;
  readonly rootPath: string;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly pid: number;
}

export interface WorkspaceIdentity {
  readonly topicMode?: "isolated" | "shared";
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly rootPath: string;
  readonly name?: string;
  readonly url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 严格解析描述文件；缺字段／类型错误一律视为陈旧描述。 */
export function parseServiceDescriptor(raw: unknown): ServiceDescriptor {
  if (!isRecord(raw)) {
    throw new CliError(
      "SERVICE_DESCRIPTOR_INVALID",
      "service.json 必须是 JSON 对象",
      EXIT_CODES.service,
    );
  }
  const { url, rootPath, workspaceId, instanceId, pid } = raw;
  if (typeof url !== "string" || typeof rootPath !== "string") {
    throw new CliError(
      "SERVICE_DESCRIPTOR_INVALID",
      "service.json 缺少 url 或 rootPath",
      EXIT_CODES.service,
    );
  }
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new CliError(
      "SERVICE_DESCRIPTOR_INVALID",
      "service.json 缺少 workspaceId",
      EXIT_CODES.service,
    );
  }
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    throw new CliError(
      "SERVICE_DESCRIPTOR_INVALID",
      "service.json 缺少 instanceId",
      EXIT_CODES.service,
    );
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new CliError("SERVICE_DESCRIPTOR_INVALID", "service.json 缺少有效 pid", EXIT_CODES.service);
  }
  return { url, rootPath, workspaceId, instanceId, pid };
}

/** 只接受 http://127.0.0.1:port、http://localhost:port 或 http://[::1]:port。 */
export function assertLoopbackUrl(urlText: string): URL {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new CliError(
      "SERVICE_URL_INVALID",
      `service.json 的 url 不是合法 URL: ${urlText}`,
      EXIT_CODES.service,
    );
  }
  if (url.protocol !== "http:") {
    throw new CliError(
      "SERVICE_URL_INVALID",
      `只允许本机 http 服务，收到 ${url.protocol}`,
      EXIT_CODES.service,
    );
  }
  const host = url.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
    throw new CliError(
      "SERVICE_URL_INVALID",
      `只允许 loopback 地址，收到 ${url.hostname}`,
      EXIT_CODES.service,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new CliError("SERVICE_URL_INVALID", "url 不能包含凭据", EXIT_CODES.service);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new CliError("SERVICE_URL_INVALID", `url 不能带路径: ${url.pathname}`, EXIT_CODES.service);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new CliError("SERVICE_URL_INVALID", "url 不能带查询或片段", EXIT_CODES.service);
  }
  return url;
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 描述文件路径的每一级已存在分量都必须是工作区内的真实文件／目录；
 * 只做检查，不创建目录，也不跟随外部符号链接。
 */
async function descriptorPathInsideWorkspace(root: string): Promise<string> {
  try {
    return await assertPathInsideWorkspace(root, SERVICE_DESCRIPTOR_PATH);
  } catch (error) {
    if (error instanceof StorageError) {
      throw new CliError(
        "SERVICE_DESCRIPTOR_UNSAFE",
        `描述文件路径不安全，拒绝跟随: ${error.message}`,
        EXIT_CODES.service,
        { details: { path: SERVICE_DESCRIPTOR_PATH } },
      );
    }
    throw error;
  }
}

export interface ResolvedService {
  readonly descriptor: ServiceDescriptor;
  readonly identity: WorkspaceIdentity;
  readonly root: string;
  /** 当前磁盘 workspace.json 声明的身份；写入前必须与服务一致。 */
  readonly diskWorkspaceId: string;
  readonly baseUrl: string;
}

/**
 * 读取当前磁盘上的 workspace.json，并用 core 的 workspaceMetaSchema
 * 校验整份原始 JSON；身份不可信时拒绝继续。
 */
export async function readDiskWorkspaceMeta(root: string): Promise<WorkspaceMeta> {
  let text: string;
  try {
    text = (await readWorkspaceFile(root, "workspace.json")).text;
  } catch (error) {
    if (error instanceof StorageError) {
      throw new CliError(
        "WORKSPACE_INVALID",
        `无法读取当前工作区的 workspace.json: ${error.message}`,
        EXIT_CODES.workspace,
        { details: { root, path: "workspace.json" }, cause: error },
      );
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError(
      "WORKSPACE_INVALID",
      "当前工作区的 workspace.json 不是合法 JSON；拒绝写入",
      EXIT_CODES.workspace,
      { details: { root, path: "workspace.json" }, cause: error },
    );
  }
  const parsed = workspaceMetaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      "WORKSPACE_INVALID",
      "当前工作区的 workspace.json 未通过 schema 校验；拒绝写入",
      EXIT_CODES.workspace,
      {
        details: {
          root,
          path: "workspace.json",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.map((part) => String(part)).join("."),
            message: issue.message,
          })),
        },
      },
    );
  }
  return parsed.data;
}

/**
 * 读取指定工作区的描述文件并核对服务身份。
 * 四处身份必须完全一致：descriptor、GET /api/workspace、当前真实磁盘根，
 * 以及当前磁盘 workspace.json 的 workspaceId（防止同路径工作区身份被替换后
 * 仍把写请求发给旧服务）。
 */
export async function resolveServiceForWorkspace(
  workspaceRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedService> {
  const root = await resolveWorkspaceRoot(workspaceRoot);
  const diskMeta = await readDiskWorkspaceMeta(root);
  const descriptorPath = await descriptorPathInsideWorkspace(root);
  let text: string;
  try {
    text = await fs.readFile(descriptorPath, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      throw new CliError(
        "SERVICE_NOT_RUNNING",
        `该工作区没有运行中的服务（缺少 ${SERVICE_DESCRIPTOR_PATH}）；请先运行 aichat serve --workspace "<dir>"`,
        EXIT_CODES.service,
        { details: { root, descriptor: SERVICE_DESCRIPTOR_PATH } },
      );
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(
      "SERVICE_DESCRIPTOR_INVALID",
      "service.json 不是合法 JSON；描述文件可能已损坏，请重启服务",
      EXIT_CODES.service,
    );
  }
  const descriptor = parseServiceDescriptor(raw);
  // 先比磁盘与描述文件：身份被替换时无需联网即可拒绝。
  assertDiskMatchesDescriptor(descriptor, diskMeta, root);
  const baseUrl = ensureTrailingSlash(assertLoopbackUrl(descriptor.url));
  const identity = await fetchWorkspaceIdentity(baseUrl, fetchImpl);
  assertIdentity(identity, descriptor, root);
  assertDiskIdentity(identity, diskMeta, root);
  return { descriptor, identity, root, diskWorkspaceId: diskMeta.workspaceId, baseUrl };
}

function ensureTrailingSlash(url: URL): string {
  const text = url.toString();
  return text.endsWith("/") ? text : text + "/";
}

export async function fetchWorkspaceIdentity(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkspaceIdentity> {
  const endpoint = new URL("api/workspace", baseUrl).toString();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new CliError(
      "SERVICE_UNREACHABLE",
      `无法连接描述文件中的服务 ${baseUrl}：${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.service,
      { details: { url: baseUrl }, cause: error },
    );
  }
  if (!response.ok) {
    throw new CliError(
      "SERVICE_UNREACHABLE",
      `服务 ${baseUrl} 的 GET /api/workspace 返回 HTTP ${response.status}`,
      EXIT_CODES.service,
      { details: { url: baseUrl, httpStatus: response.status } },
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CliError(
      "SERVICE_RESPONSE_INVALID",
      "服务 GET /api/workspace 返回的不是 JSON",
      EXIT_CODES.service,
      { details: { url: baseUrl } },
    );
  }
  if (!isRecord(body)) {
    throw new CliError("SERVICE_RESPONSE_INVALID", "服务身份响应必须是 JSON 对象", EXIT_CODES.service);
  }
  const { workspaceId, instanceId, rootPath } = body;
  if (
    typeof workspaceId !== "string" ||
    typeof instanceId !== "string" ||
    typeof rootPath !== "string"
  ) {
    throw new CliError(
      "SERVICE_RESPONSE_INVALID",
      "服务身份响应缺少 workspaceId／instanceId／rootPath",
      EXIT_CODES.service,
    );
  }
  return {
    workspaceId,
    instanceId,
    rootPath,
    url: baseUrl,
    ...(body["topicMode"] === "isolated" || body["topicMode"] === "shared" ? { topicMode: body["topicMode"] } : {}),
    ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
  };
}

/** 描述文件的 workspaceId 必须等于当前磁盘 workspace.json 的身份。 */
export function assertDiskMatchesDescriptor(
  descriptor: ServiceDescriptor,
  diskMeta: Pick<WorkspaceMeta, "workspaceId">,
  diskRoot: string,
): void {
  if (descriptor.workspaceId === diskMeta.workspaceId) return;
  throw new CliError(
    "SERVICE_IDENTITY_MISMATCH",
    "当前磁盘 workspace.json 的 workspaceId 与描述文件不一致（工作区身份可能被替换）；拒绝发送请求",
    EXIT_CODES.service,
    {
      details: {
        mismatches: [
          `workspaceId: disk=${diskMeta.workspaceId} descriptor=${descriptor.workspaceId}`,
        ],
        diskWorkspaceId: diskMeta.workspaceId,
        descriptorWorkspaceId: descriptor.workspaceId,
        workspaceRoot: diskRoot,
      },
    },
  );
}

/** 当前磁盘 workspace.json 的 workspaceId 必须等于服务与描述文件的身份。 */
export function assertDiskIdentity(
  identity: WorkspaceIdentity,
  diskMeta: Pick<WorkspaceMeta, "workspaceId" | "name" | "activeNode">,
  diskRoot: string,
): void {
  if (diskMeta.workspaceId === identity.workspaceId) return;
  throw new CliError(
    "SERVICE_IDENTITY_MISMATCH",
    "当前磁盘 workspace.json 的 workspaceId 与服务不一致（工作区身份可能被替换）；拒绝发送请求",
    EXIT_CODES.service,
    {
      details: {
        mismatches: [
          `workspaceId: disk=${diskMeta.workspaceId} service=${identity.workspaceId}`,
        ],
        diskWorkspaceId: diskMeta.workspaceId,
        serviceWorkspaceId: identity.workspaceId,
        workspaceRoot: diskRoot,
      },
    },
  );
}

/** 三处身份必须完全一致；不一致时列出每一处差异，拒绝写入。 */
export function assertIdentity(
  identity: WorkspaceIdentity,
  descriptor: ServiceDescriptor,
  diskRoot: string,
): void {
  const mismatches: string[] = [];
  if (identity.workspaceId !== descriptor.workspaceId) {
    mismatches.push(
      `workspaceId: descriptor=${descriptor.workspaceId} service=${identity.workspaceId}`,
    );
  }
  if (identity.instanceId !== descriptor.instanceId) {
    mismatches.push(
      `instanceId: descriptor=${descriptor.instanceId} service=${identity.instanceId}`,
    );
  }
  if (normalizeForCompare(identity.rootPath) !== normalizeForCompare(descriptor.rootPath)) {
    mismatches.push(`rootPath: descriptor=${descriptor.rootPath} service=${identity.rootPath}`);
  }
  if (normalizeForCompare(identity.rootPath) !== normalizeForCompare(diskRoot)) {
    mismatches.push(`rootPath: service=${identity.rootPath} disk=${diskRoot}`);
  }
  if (normalizeForCompare(descriptor.rootPath) !== normalizeForCompare(diskRoot)) {
    mismatches.push(`rootPath: descriptor=${descriptor.rootPath} disk=${diskRoot}`);
  }
  if (mismatches.length > 0) {
    throw new CliError(
      "SERVICE_IDENTITY_MISMATCH",
      "描述文件、服务身份与当前工作区不一致；拒绝发送请求（不会回退到其他服务或端口）",
      EXIT_CODES.service,
      {
        details: {
          mismatches,
          descriptor,
          service: identity,
          workspaceRoot: diskRoot,
        },
      },
    );
  }
}