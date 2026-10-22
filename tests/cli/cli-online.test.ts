import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../../src/storage/index.js";
import { main } from "../../src/cli/index.js";
import type { ServiceHandleLike, StartServiceLike } from "../../src/cli/context.js";

const temporaryRoots: string[] = [];

async function newWorkspace(): Promise<{ root: string; workspaceId: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-online-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  const result = await initWorkspace({ root, name: "online-test" });
  return { root: result.root, workspaceId: result.workspaceId };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const REQUEST_ID = "3f0f6f1c-7f0e-4d5b-9a3e-1c2d3e4f5a6b";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

interface FakeServiceOptions {
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly instanceId?: string | undefined;
  readonly port?: number | undefined;
  readonly respond?:
    | ((request: Recorded) => { status: number; body: unknown } | "network-error")
    | undefined;
}

function fakeFetch(options: FakeServiceOptions): {
  fetchImpl: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const origin = `http://127.0.0.1:${options.port ?? 4400}`;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    const request: Recorded = {
      method: init?.method ?? "GET",
      url,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(request);
    if (url === origin + "/api/workspace") {
      return new Response(
        JSON.stringify({
          workspaceId: options.workspaceId,
          instanceId: options.instanceId ?? "inst-1",
          rootPath: options.rootPath,
          name: "online-test",
          activeNode: null,
          revision: 1,
          stale: false,
          diagnostics: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (!options.respond) {
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const outcome = options.respond(request);
    if (outcome === "network-error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

async function writeDescriptor(
  root: string,
  descriptor: Record<string, unknown>,
): Promise<void> {
  const file = path.join(root, ".aichat", "runtime", "service.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(descriptor, null, 2), "utf8");
}

async function writeRequest(root: string, request: Record<string, unknown>): Promise<string> {
  const file = path.join(root, "request.json");
  await fs.writeFile(file, JSON.stringify(request, null, 2), "utf8");
  return file;
}

function baseRequest(workspaceId: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    requestId: REQUEST_ID,
    expectedFiles: { "topics/条目整理.md": null },
    operations: [{ op: "setDiscussionFocus", nodeId: null }],
    ...overrides,
  };
}

describe("在线连接：descriptor 与身份核对", () => {
  it("缺少 descriptor 时拒绝，并提示启动 serve", async () => {
    const { root, workspaceId } = await newWorkspace();
    const result = await main(
      ["check", "--input", await writeRequest(root, baseRequest(workspaceId)), "--workspace", root],
    );
    expect(result.exitCode).toBe(7);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("SERVICE_NOT_RUNNING");
  });

  it("descriptor 指向另一个工作区时拒绝，且不发送任何写请求", async () => {
    const { root, workspaceId } = await newWorkspace();
    const other = await newWorkspace();
    const { fetchImpl, requests } = fakeFetch({
      workspaceId: other.workspaceId,
      rootPath: root,
    });
    await writeDescriptor(root, {
      url: "http://127.0.0.1:4400",
      rootPath: other.root,
      workspaceId: other.workspaceId,
      instanceId: "inst-1",
      pid: process.pid,
    });
    const input = await writeRequest(root, baseRequest(other.workspaceId));
    const result = await main(["apply", "--input", input, "--workspace", root], { fetchImpl });
    expect(result.exitCode).toBe(7);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("SERVICE_IDENTITY_MISMATCH");
    const mismatches = body.error.details.mismatches as string[];
    // 磁盘 workspace.json 与描述文件身份不同：本地即可判定，不发起任何请求。
    expect(mismatches.some((item) => item.startsWith("workspaceId: disk="))).toBe(true);
    expect(body.error.details.descriptorWorkspaceId).toBe(other.workspaceId);
    expect(requests).toHaveLength(0);
    void workspaceId;
  });

  it("同一路径 workspace.json 身份被替换（descriptor/API 仍旧）时拒绝写入", async () => {
    const { root, workspaceId } = await newWorkspace();
    // descriptor 与 API 都还是旧身份，只有磁盘 workspace.json 被换成另一个工作区。
    const { fetchImpl, requests } = fakeFetch({ workspaceId, rootPath: root });
    await writeDescriptor(root, {
      url: "http://127.0.0.1:4400",
      rootPath: root,
      workspaceId,
      instanceId: "inst-1",
      pid: process.pid,
    });
    const replaced = {
      schemaVersion: 1,
      workspaceId: "w_replaced_identity",
      name: "online-test",
      activeNode: null,
    };
    await fs.writeFile(
      path.join(root, "workspace.json"),
      JSON.stringify(replaced, null, 2) + "\n",
      "utf8",
    );
    const result = await main(
      ["apply", "--input", await writeRequest(root, baseRequest(workspaceId)), "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(7);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("SERVICE_IDENTITY_MISMATCH");
    expect(
      (body.error.details.mismatches as string[]).some((item) =>
        item.startsWith("workspaceId: disk=w_replaced_identity"),
      ),
    ).toBe(true);
    expect(body.error.details.diskWorkspaceId).toBe("w_replaced_identity");
    // 身份已替换时无需联网：连 GET /api/workspace 都不应发出。
    expect(requests).toHaveLength(0);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("磁盘 workspace.json 不合法时拒绝写入，且不请求服务", async () => {
    const { root, workspaceId } = await newWorkspace();
    const { fetchImpl, requests } = fakeFetch({ workspaceId, rootPath: root });
    await writeDescriptor(root, {
      url: "http://127.0.0.1:4400",
      rootPath: root,
      workspaceId,
      instanceId: "inst-1",
      pid: process.pid,
    });
    await fs.writeFile(path.join(root, "workspace.json"), "{ not json", "utf8");
    const result = await main(
      ["check", "--input", await writeRequest(root, baseRequest(workspaceId)), "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stderr).error.code).toBe("WORKSPACE_INVALID");
    expect(requests).toHaveLength(0);
  });

  it("服务 instanceId 与 descriptor 不同（陈旧描述）时拒绝写入", async () => {
    const { root, workspaceId } = await newWorkspace();
    const { fetchImpl, requests } = fakeFetch({
      workspaceId,
      rootPath: root,
      instanceId: "inst-new",
    });
    await writeDescriptor(root, {
      url: "http://127.0.0.1:4400",
      rootPath: root,
      workspaceId,
      instanceId: "inst-old",
      pid: process.pid,
    });
    const result = await main(
      ["apply", "--input", await writeRequest(root, baseRequest(workspaceId)), "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(7);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("SERVICE_IDENTITY_MISMATCH");
    expect((body.error.details.mismatches as string[]).some((item) => item.startsWith("instanceId"))).toBe(true);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("descriptor 的 url 非 loopback 时拒绝，且不发起请求", async () => {
    const { root, workspaceId } = await newWorkspace();
    const { fetchImpl, requests } = fakeFetch({ workspaceId, rootPath: root });
    await writeDescriptor(root, {
      url: "http://192.168.1.9:4400",
      rootPath: root,
      workspaceId,
      instanceId: "inst-1",
      pid: process.pid,
    });
    const result = await main(
      ["check", "--input", await writeRequest(root, baseRequest(workspaceId)), "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(7);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("SERVICE_URL_INVALID");
    expect(requests).toHaveLength(0);
  });

  it("ChangeRequest.workspaceId 与服务不一致时拒绝，不自动改写", async () => {
    const { root, workspaceId } = await newWorkspace();
    const { fetchImpl, requests } = fakeFetch({ workspaceId, rootPath: root });
    await writeDescriptor(root, {
      url: "http://127.0.0.1:4400",
      rootPath: root,
      workspaceId,
      instanceId: "inst-1",
      pid: process.pid,
    });
    const result = await main(
      ["apply", "--input", await writeRequest(root, baseRequest("w_other")), "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(3);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("WORKSPACE_ID_MISMATCH");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });
});

describe("check / apply 传输", () => {
  it("check 以正确头与原文发送，成功返回服务结果", async () => {
    const { root, workspaceId } = await newWorkspace();
    const request = baseRequest(workspaceId);
    const input = await writeRequest(root, request);
    const rawText = await fs.readFile(input, "utf8");
    const { fetchImpl, requests } = fakeFetch({
      workspaceId,
      rootPath: root,
      respond: () => ({ status: 200, body: { ok: true, dryRun: true, touchedFiles: [] } }),
    });
    await writeDescriptor(root, {
      url: "http://127.0.0.1:4400",
      rootPath: root,
      workspaceId,
      instanceId: "inst-1",
      pid: process.pid,
    });
    const result = await main(["check", "--input", input, "--workspace", root], { fetchImpl });
    expect(result.exitCode).toBe(0);
    const post = requests.find((request) => request.method === "POST");
    expect(post?.url).toBe("http://127.0.0.1:4400/api/changes/check");
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(post?.headers["x-aichat-client"]).toBe("cli");
    expect(post?.body).toBe(rawText);
    const body = JSON.parse(result.stdout);
    expect(body.command).toBe("check");
    expect(body.result).toEqual({ ok: true, dryRun: true, touchedFiles: [] });
    expect(body.service.instanceId).toBe("inst-1");
  });

  it("apply 412 版本冲突：非零退出并保留错误细节", async () => {
    const { root, workspaceId } = await newWorkspace();
    const { fetchImpl, requests } = fakeFetch({
      workspaceId,
      rootPath: root,
      respond: () => ({
        status: 412,
        body: {
          error: {
            code: "VERSION_CONFLICT",
            message: "hash mismatch",
            details: { conflicts: [{ path: "topics/条目整理.md", expected: "a", actual: "b" }] },
          },
        },
      }),
    });
    await writeDescriptor(root, {
      url: "http://127.0.0.1:4400",
      rootPath: root,
      workspaceId,
      instanceId: "inst-1",
      pid: process.pid,
    });
    const result = await main(
      ["apply", "--input", await writeRequest(root, baseRequest(workspaceId)), "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(4);
    const post = requests.find((item) => item.method === "POST");
    expect(post?.url).toBe("http://127.0.0.1:4400/api/changes");
    expect(post?.headers["x-aichat-client"]).toBe("cli");
    const body = JSON.parse(result.stderr);
    expect(body.httpStatus).toBe(412);
    expect(body.error.code).toBe("VERSION_CONFLICT");
    expect(body.error.details.conflicts[0].path).toBe("topics/条目整理.md");
  });

  it("apply 409／422 映射为不同退出码，不改写错误内容", async () => {
    const { root, workspaceId } = await newWorkspace();
    const input = await writeRequest(root, baseRequest(workspaceId));
    await writeDescriptor(root, {
      url: "http://127.0.0.1:4400",
      rootPath: root,
      workspaceId,
      instanceId: "inst-1",
      pid: process.pid,
    });

    const conflict = fakeFetch({
      workspaceId,
      rootPath: root,
      respond: () => ({
        status: 409,
        body: { error: { code: "OPERATION_CONFLICT", message: "next 已被占用" } },
      }),
    });
    const conflictResult = await main(["apply", "--input", input, "--workspace", root], {
      fetchImpl: conflict.fetchImpl,
    });
    expect(conflictResult.exitCode).toBe(5);
    expect(JSON.parse(conflictResult.stderr).error.code).toBe(
      "OPERATION_CONFLICT",
    );

    const validation = fakeFetch({
      workspaceId,
      rootPath: root,
      respond: () => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_FAILED",
            message: "候选图不合法",
            diagnostics: [{ code: "GRAPH_CYCLE", message: "连接形成环" }],
          },
        },
      }),
    });
    const validationResult = await main(["apply", "--input", input, "--workspace", root], {
      fetchImpl: validation.fetchImpl,
    });
    expect(validationResult.exitCode).toBe(6);
    const body = JSON.parse(validationResult.stderr);
    expect(body.error.diagnostics[0].code).toBe("GRAPH_CYCLE");
  });

  it("apply 断线时不重放，查询状态仍未知则明确 UNKNOWN", async () => {
    const { root, workspaceId } = await newWorkspace();
    const { fetchImpl, requests } = fakeFetch({
      workspaceId,
      rootPath: root,
      respond: () => "network-error",
    });
    await writeDescriptor(root, {
      url: "http://127.0.0.1:4400",
      rootPath: root,
      workspaceId,
      instanceId: "inst-1",
      pid: process.pid,
    });
    const result = await main(
      ["apply", "--input", await writeRequest(root, baseRequest(workspaceId)), "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(8);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("RESULT_UNKNOWN");
    expect(body.status).toBe("unknown");
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(requests.some((request) => request.method === "GET" && request.url.includes("/api/changes/" + REQUEST_ID))).toBe(true);
  });
});

describe("status", () => {
  async function setup(respond: FakeServiceOptions["respond"]) {
    const { root, workspaceId } = await newWorkspace();
    const fake = fakeFetch({ workspaceId, rootPath: root, respond });
    await writeDescriptor(root, {
      url: "http://127.0.0.1:4400",
      rootPath: root,
      workspaceId,
      instanceId: "inst-1",
      pid: process.pid,
    });
    return { root, workspaceId, ...fake };
  }

  it("已知状态如实返回", async () => {
    const { root, fetchImpl, requests } = await setup(() => ({
      status: 200,
      body: { requestId: REQUEST_ID, state: "committed", touchedFiles: ["topics/a.md"] },
    }));
    const result = await main(["status", REQUEST_ID, "--workspace", root], { fetchImpl });
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.state).toBe("committed");
    expect(body.known).toBe(true);
    expect(requests.some((request) => request.url === `http://127.0.0.1:4400/api/changes/${REQUEST_ID}`)).toBe(true);
  });

  it("服务无记录时明确 unknown，并要求重读（不推断写入结果）", async () => {
    const { root, fetchImpl } = await setup(() => ({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "no record" } },
    }));
    const result = await main(["status", REQUEST_ID, "--workspace", root], { fetchImpl });
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.state).toBe("unknown");
    expect(body.known).toBe(false);
    expect(body.status.reason).toContain("重读");
  });

  it("缺少 requestId 或格式不对时是用法错误，不发请求", async () => {
    const { root, fetchImpl, requests } = await setup(() => ({ status: 200, body: {} }));
    const missing = await main(["status", "--workspace", root], { fetchImpl });
    expect(missing.exitCode).toBe(2);
    const bad = await main(["status", "not-a-uuid", "--workspace", root], { fetchImpl });
    expect(bad.exitCode).toBe(2);
    expect(requests).toHaveLength(0);
  });
});

describe("descriptor 路径安全", () => {
  it("runtime 目录是外部链接时拒绝跟随", async () => {
    const { root, workspaceId } = await newWorkspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-outside-"));
    temporaryRoots.push(outside);
    await fs.writeFile(
      path.join(outside, "service.json"),
      JSON.stringify({
        url: "http://127.0.0.1:4400",
        rootPath: root,
        workspaceId,
        instanceId: "inst-1",
        pid: process.pid,
      }),
      "utf8",
    );
    // 用链接替换 .aichat 目录；无权限的环境直接跳过。
    await fs.rm(path.join(root, ".aichat"), { recursive: true, force: true });
    try {
      await fs.symlink(outside, path.join(root, ".aichat"), "junction");
    } catch {
      return;
    }
    const { fetchImpl, requests } = fakeFetch({ workspaceId, rootPath: root });
    const result = await main(
      ["check", "--input", await writeRequest(root, baseRequest(workspaceId)), "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(7);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("SERVICE_DESCRIPTOR_UNSAFE");
    expect(requests).toHaveLength(0);
  });
});

describe("serve", () => {
  it("调用 startService，等待关停信号后调用 stop", async () => {
    const { root, workspaceId } = await newWorkspace();
    const calls: Array<{ root: string; port?: number }> = [];
    let stopped = 0;
    const handle: ServiceHandleLike = {
      url: "http://127.0.0.1:4401/",
      workspaceId,
      instanceId: "inst-1",
      rootPath: root,
      stop: async () => {
        stopped += 1;
      },
    };
    const startService: StartServiceLike = async (options) => {
      calls.push(options);
      return handle;
    };
    const controller = new AbortController();
    const pending = main(["serve", "--workspace", root, "--port", "4401"], {
      startService,
      shutdownSignal: controller.signal,
    });
    // 让 serve 完成启动并进入等待
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([{ root, port: 4401 }]);
    expect(stopped).toBe(0);
    controller.abort();
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(stopped).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: true, command: "serve", url: handle.url, port: 4401, workspaceId });
  });

  it("startService 失败时非零退出并保留错误", async () => {
    const { root } = await newWorkspace();
    const result = await main(["serve", "--workspace", root], {
      startService: async () => {
        throw new Error("端口被占用");
      },
    });
    expect(result.exitCode).toBe(7);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("SERVICE_START_FAILED");
    expect(body.error.message).toContain("端口被占用");
  });

  // 服务模块落地后此用例自动跳过（改为真实服务联调，不在单元测试里开服）。
  it.skipIf(existsSync(path.join(process.cwd(), "src", "service", "index.ts")))(
    "未提供替身且服务模块缺失时以 SERVICE_UNAVAILABLE 失败（不谎报启动成功）",
    async () => {
    const { root } = await newWorkspace();
    const result = await main(["serve", "--workspace", root, "--port", "4502"]);
    expect(result.exitCode).toBe(7);
    const body = JSON.parse(result.stderr);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(result.stdout).toBe("");
    },
  );

  it("--port 非法时在执行 startService 之前失败", async () => {
    const { root } = await newWorkspace();
    let called = false;
    const result = await main(["serve", "--workspace", root, "--port", "0"], {
      startService: async () => {
        called = true;
        throw new Error("unreachable");
      },
    });
    expect(result.exitCode).toBe(2);
    expect(called).toBe(false);
  });
});