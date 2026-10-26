/** CLI 测试共用：新版服务身份（program）与统一写响应形状。 */
import type {
  AgentChangeResponse,
  AgentCreatedIds,
  ProgramInfo,
} from "../../src/shared/protocol.js";

export function testProgram(overrides: Partial<ProgramInfo> = {}): ProgramInfo {
  return {
    program: "aichat-graph",
    version: "0.1.0",
    interfaceVersion: 2,
    buildId: "test-build",
    commit: null,
    builtAt: null,
    manifest: "dev",
    ...overrides,
  };
}

/** GET /api/workspace 的最小响应；program 可显式置空模拟旧服务。 */
export function workspaceResponse(options: {
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly instanceId?: string;
  readonly revision?: number;
  readonly program?: Partial<ProgramInfo> | null;
}): Record<string, unknown> {
  return {
    workspaceId: options.workspaceId,
    instanceId: options.instanceId ?? "inst-1",
    revision: options.revision ?? 3,
    rootPath: options.rootPath,
    name: "test",
    activeNode: null,
    stale: false,
    diagnostics: [],
    ...(options.program === null
      ? {}
      : { program: testProgram(options.program ?? {}) }),
  };
}

export interface ChangeResponseOptions {
  readonly workspaceId: string;
  readonly topicId?: string;
  readonly requestId?: string;
  readonly action?: AgentChangeResponse["action"];
  readonly state?: AgentChangeResponse["state"];
  readonly instanceId?: string;
  readonly revision?: number;
  readonly created?: Partial<AgentCreatedIds>;
  readonly changedNodeIds?: readonly string[];
  readonly refs?: Readonly<Record<string, string>>;
  readonly touchedFiles?: AgentChangeResponse["touchedFiles"];
  readonly summary?: string;
  readonly diagnostics?: AgentChangeResponse["diagnostics"];
  readonly transactionId?: string | null;
  readonly journalCleaned?: boolean;
  readonly replayed?: boolean;
}

/** POST /api/agent/changes 的统一响应：顶层 workspaceId／topicId／refs，无 editRef。 */
export function changeResponse(options: ChangeResponseOptions): AgentChangeResponse {
  const created: AgentCreatedIds = {
    topicId: null,
    topicPath: null,
    nodeIds: [],
    paths: [],
    aliases: {},
    ...options.created,
  };
  return {
    ok: true,
    requestId: options.requestId ?? "generated",
    action: options.action ?? "patchNode",
    workspaceId: options.workspaceId,
    topicId: options.topicId ?? "t_" + "0".repeat(32),
    state: options.state ?? "committed",
    instanceId: options.instanceId ?? "inst-1",
    revision: options.revision ?? 4,
    created,
    changedNodeIds: [...(options.changedNodeIds ?? [])],
    refs: { ...(options.refs ?? {}) },
    touchedFiles: options.touchedFiles ?? [],
    summary: options.summary ?? "1 个操作",
    diagnostics: options.diagnostics ?? [],
    transactionId: options.transactionId === undefined ? "tx-1" : options.transactionId,
    journalCleaned: options.journalCleaned ?? true,
    ...(options.replayed === true ? { replayed: true } : {}),
  };
}
