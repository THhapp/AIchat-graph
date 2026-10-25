import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initWorkspace, sha256Bytes } from "../../src/storage/index.js";
import { main } from "../../src/cli/index.js";
import type { ServiceHandleLike, StartServiceLike } from "../../src/cli/context.js";

const temporaryRoots: string[] = [];

async function newParent(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-agent-"));
  temporaryRoots.push(parent);
  return parent;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const TOPIC_ID = "t_64e917c597fb4da4abd5467512fab596";
const ROOT_NODE = "n_ac6022c7b25c40c7bd5f849bf6cd36ef";
const CHILD_NODE = "n_0d2f6687895d435f8bd389558b0820f3";
const TOPIC_DIR = "topics/条目整理";
const CHILD_PATH = `${TOPIC_DIR}/${CHILD_NODE}.md`;

function nodeFile(options: {
  nodeId: string;
  title: string;
  state: string;
  from: string | null;
  flow: string;
  body: string;
  description?: string;
}): string {
  const lines = [
    "---",
    `nodeId: ${options.nodeId}`,
    `title: ${options.title}`,
    `state: ${options.state}`,
    `from: ${options.from ?? "null"}`,
    `flow: ${options.flow}`,
  ];
  if (options.description !== undefined) lines.push(`description: ${options.description}`);
  lines.push("---", "", options.body, "");
  return lines.join("\n");
}

async function newV2Workspace(): Promise<{
  root: string;
  workspaceId: string;
  childText: string;
}> {
  const parent = await newParent();
  const root = path.join(parent, "workspace");
  const created = await initWorkspace({ root, name: "agent-test" });
  const files: Record<string, string> = {
    [`${TOPIC_DIR}/topic.md`]: ["---", `topicId: ${TOPIC_ID}`, "title: 条目整理", "---", ""].join("\n"),
    [`${TOPIC_DIR}/${ROOT_NODE}.md`]: nodeFile({
      nodeId: ROOT_NODE,
      title: "条目整理",
      state: "agreed",
      from: null,
      flow: "root",
      body: "保留有用的思路来路与关键转折。",
    }),
    [CHILD_PATH]: nodeFile({
      nodeId: CHILD_NODE,
      title: "可以回查的现场",
      state: "proposed",
      from: ROOT_NODE,
      flow: "next",
      body: "记录既包括讨论过什么，也包括想法怎样走到这里。",
      description: "承接记录分寸的讨论",
    }),
  };
  for (const [relativePath, text] of Object.entries(files)) {
    const absolute = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text, "utf8");
  }
  // initWorkspace 返回规范化真实路径；Windows 8.3 短名会让 descriptor 比对失败。
  return { root: created.root, workspaceId: created.workspaceId, childText: files[CHILD_PATH] as string };
}

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

interface FakeOptions {
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly nodePath: string;
  readonly fileHash: string;
  readonly instanceId?: string | undefined;
  readonly readBody?: string | undefined;
  readonly changeState?: number | undefined;
  readonly changeBody?: unknown;
}

function fakeService(options: FakeOptions): { fetchImpl: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const origin = "http://127.0.0.1:4400";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    requests.push({
      method: init?.method ?? "GET",
      url,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === `${origin}/api/workspace`) {
      return json(200, {
        workspaceId: options.workspaceId,
        instanceId: options.instanceId ?? "inst-1",
        revision: 3,
        rootPath: options.rootPath,
        name: "agent-test",
        activeNode: null,
        stale: false,
        diagnostics: [],
      });
    }
    if (url.startsWith(`${origin}/api/agent/nodes/`)) {
      const body = options.readBody ?? "记录既包括讨论过什么，也包括想法怎样走到这里。";
      return json(200, {
        instanceId: options.instanceId ?? "inst-1",
        revision: 3,
        workspaceId: options.workspaceId,
        node: {
          id: CHILD_NODE,
          topicId: TOPIC_ID,
          title: "可以回查的现场",
          summary: body.slice(0, 20),
          number: "02",
          from: ROOT_NODE,
          flow: "next",
          state: "proposed",
          description: "承接记录分寸的讨论",
        },
        body,
        range: { start: 0, end: body.length, total: body.length, unit: "utf16" },
        truncated: false,
        path: options.nodePath,
        fileHash: options.fileHash,
        topicPath: `${TOPIC_DIR}/topic.md`,
        editRef: {
          ref: "ref-abc123",
          workspaceId: options.workspaceId,
          topicId: TOPIC_ID,
          nodeId: CHILD_NODE,
          path: options.nodePath,
          fileHash: options.fileHash,
          instanceId: options.instanceId ?? "inst-1",
          revision: 3,
          issuedAt: "2026-10-22T05:00:00.000Z",
        },
        section: null,
      });
    }
    if (url === `${origin}/api/agent/changes`) {
      return json(options.changeState ?? 200, options.changeBody ?? {
        ok: true,
        requestId: "generated",
        action: "patchNode",
        state: "committed",
        instanceId: options.instanceId ?? "inst-1",
        revision: 4,
        created: { topicId: null, topicPath: null, nodeIds: [], paths: [] },
        changedNodeIds: [CHILD_NODE],
        touchedFiles: [
          {
            path: options.nodePath,
            beforeSha256: options.fileHash,
            afterSha256: "b".repeat(64),
            byteLength: 200,
          },
        ],
        editRef: null,
        summary: "1 个操作（patchNode）",
        diagnostics: [],
        transactionId: "tx-1",
        journalCleaned: true,
      });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "no route" } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

async function writeDescriptor(root: string, workspaceId: string, instanceId = "inst-1"): Promise<void> {
  const file = path.join(root, ".aichat", "runtime", "service.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        url: "http://127.0.0.1:4400",
        rootPath: root,
        workspaceId,
        instanceId,
        pid: process.pid,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function parseBody(request: Recorded | undefined): Record<string, unknown> {
  expect(request?.body).toBeDefined();
  return JSON.parse(request?.body as string) as Record<string, unknown>;
}

describe("read --node 在线获取 editRef", () => {
  it("有服务时返回线上片段、版本与 editRef，不改用磁盘快照", async () => {
    const { root, workspaceId } = await newV2Workspace();
    await writeDescriptor(root, workspaceId);
    const fake = fakeService({
      workspaceId,
      rootPath: root,
      nodePath: CHILD_PATH,
      fileHash: "a".repeat(64),
    });
    const result = await main(
      ["read", "--node", CHILD_NODE, "--length", "10", "--workspace", root],
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    const node = (body["nodes"] as Array<Record<string, unknown>>)[0];
    expect(node?.["source"]).toBe("online");
    // 版本与身份只在顶层 online 出现，不再逐项重复。
    expect(node?.["revision"]).toBeUndefined();
    expect(node?.["online"]).toBeUndefined();
    expect(body["online"]).toMatchObject({
      available: true,
      instanceId: "inst-1",
      revision: 3,
      workspaceId,
    });
    expect(node?.["truncated"]).toBe(false);
    expect((node?.["editRef"] as Record<string, unknown>)["ref"]).toBe("ref-abc123");
    const call = fake.requests.find((request) => request.url.includes("/api/agent/nodes/"));
    expect(call?.url).toContain("length=10");
  });

  it("无服务时回退磁盘并明确标注不提供可写凭据", async () => {
    const { root } = await newV2Workspace();
    const result = await main(["read", "--node", CHILD_NODE, "--workspace", root]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    const node = (body["nodes"] as Array<Record<string, unknown>>)[0];
    expect(node?.["source"]).toBe("disk");
    expect(node?.["editRef"]).toBeNull();
    expect(body["online"]).toMatchObject({
      available: false,
      code: "SERVICE_NOT_RUNNING",
    });
  });

  it("--offline 时不访问服务，只读磁盘", async () => {
    const { root, workspaceId } = await newV2Workspace();
    await writeDescriptor(root, workspaceId);
    const fake = fakeService({
      workspaceId,
      rootPath: root,
      nodePath: CHILD_PATH,
      fileHash: "a".repeat(64),
    });
    const result = await main(
      ["read", "--node", CHILD_NODE, "--offline", "--workspace", root],
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    expect(fake.requests).toHaveLength(0);
    const node = (JSON.parse(result.stdout)["nodes"] as Array<Record<string, unknown>>)[0];
    expect(node?.["source"]).toBe("disk");
  });
});

describe("低摩擦写入命令", () => {
  async function withService(): Promise<{
    root: string;
    workspaceId: string;
    fetchImpl: typeof fetch;
    requests: Recorded[];
  }> {
    const { root, workspaceId } = await newV2Workspace();
    await writeDescriptor(root, workspaceId);
    const fake = fakeService({
      workspaceId,
      rootPath: root,
      nodePath: CHILD_PATH,
      fileHash: "a".repeat(64),
    });
    return { root, workspaceId, fetchImpl: fake.fetchImpl, requests: fake.requests };
  }

  it("edit --append-file 发 patchNode.append，字段拼写与共享 DTO 一致", async () => {
    const { root, fetchImpl, requests } = await withService();
    const appendFile = path.join(root, "append.md");
    await fs.writeFile(appendFile, "补充一段新的讨论。", "utf8");
    const result = await main(
      ["edit", "--ref", "ref-abc123", "--append-file", appendFile, "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    const post = requests.find((request) => request.url.endsWith("/api/agent/changes"));
    expect(post?.headers["x-aichat-client"]).toBe("cli");
    expect(post?.headers["content-type"]).toBe("application/json");
    const sent = parseBody(post);
    expect(sent["workspaceId"]).toBe(await (async () => {
      const meta = JSON.parse(await fs.readFile(path.join(root, "workspace.json"), "utf8"));
      return meta.workspaceId as string;
    })());
    expect(typeof sent["requestId"]).toBe("string");
    expect(sent["requestId"]).toMatch(/^[0-9a-f-]{36}$/);
    const action = sent["action"] as Record<string, unknown>;
    expect(action["action"]).toBe("patchNode");
    expect(action["editRef"]).toBe("ref-abc123");
    expect(action["append"]).toContain("补充一段新的讨论。");
    // 不自行补哈希、不带 body 与 replace。
    expect(action["body"]).toBeUndefined();
    expect(action["replace"]).toBeUndefined();
    expect(sent["expectedFiles"]).toBeUndefined();
  });

  it("edit --replace-file 与 --body-file 互斥，且不发送请求", async () => {
    const { root, fetchImpl, requests } = await withService();
    const bodyFile = path.join(root, "body.md");
    const replaceFile = path.join(root, "replace.json");
    await fs.writeFile(bodyFile, "整篇新正文", "utf8");
    await fs.writeFile(replaceFile, JSON.stringify([{ old: "a", new: "b" }]), "utf8");
    const conflict = await main(
      [
        "edit",
        "--ref",
        "ref-abc123",
        "--body-file",
        bodyFile,
        "--replace-file",
        replaceFile,
        "--workspace",
        root,
      ],
      { fetchImpl },
    );
    expect(conflict.exitCode).toBe(2);
    expect(JSON.parse(conflict.stderr).error.message).toContain("互斥");
    expect(requests.filter((request) => request.url.endsWith("/api/agent/changes"))).toHaveLength(0);

    const emptyReplace = path.join(root, "empty.json");
    await fs.writeFile(emptyReplace, JSON.stringify([{ old: "", new: "x" }]), "utf8");
    const badReplace = await main(
      ["edit", "--ref", "ref-abc123", "--replace-file", emptyReplace, "--workspace", root],
      { fetchImpl },
    );
    expect(badReplace.exitCode).toBe(2);
    expect(JSON.parse(badReplace.stderr).error.code).toBe("INVALID_REPLACE");
  });

  it("branch 要求 description 与正文来源，提交 createBranch", async () => {
    const { root, fetchImpl, requests } = await withService();
    const bodyFile = path.join(root, "branch.md");
    await fs.writeFile(bodyFile, "旁支的正文。", "utf8");

    const missingDescription = await main(
      [
        "branch",
        "--from-ref",
        "ref-parent",
        "--title",
        "一个新旁支",
        "--body-file",
        bodyFile,
        "--workspace",
        root,
      ],
      { fetchImpl },
    );
    expect(missingDescription.exitCode).toBe(2);
    expect(JSON.parse(missingDescription.stderr).error.message).toContain("--description");

    const ok = await main(
      [
        "branch",
        "--from-ref",
        "ref-parent",
        "--title",
        "一个新旁支",
        "--description",
        "因为这里出现了不同的取舍",
        "--body-file",
        bodyFile,
        "--state",
        "proposed",
        "--side",
        "left",
        "--order",
        "30",
        "--workspace",
        root,
      ],
      { fetchImpl },
    );
    expect(ok.exitCode).toBe(0);
    const action = parseBody(
      requests.find((request) => request.url.endsWith("/api/agent/changes")),
    )["action"] as Record<string, unknown>;
    expect(action).toMatchObject({
      action: "createBranch",
      editRef: "ref-parent",
      title: "一个新旁支",
      description: "因为这里出现了不同的取舍",
      state: "proposed",
      side: "left",
      order: 30,
    });
    expect(action["body"]).toBe("旁支的正文。");
    // 机械字段由服务生成，CLI 不发。
    expect(action["nodeId"]).toBeUndefined();
    expect(action["topicId"]).toBeUndefined();
  });

  it("next 一次提交 createNext，不带 side／order；来源已有 next 时透传 409", async () => {
    const { root, fetchImpl, requests } = await withService();
    const bodyFile = path.join(root, "next.md");
    await fs.writeFile(bodyFile, "沿这条线继续的一段。", "utf8");

    const missingDescription = await main(
      [
        "next",
        "--from-ref",
        "ref-parent",
        "--title",
        "后继卡片",
        "--body-file",
        bodyFile,
        "--workspace",
        root,
      ],
      { fetchImpl },
    );
    expect(missingDescription.exitCode).toBe(2);
    expect(JSON.parse(missingDescription.stderr).error.message).toContain("--description");

    const ok = await main(
      [
        "next",
        "--from-ref",
        "ref-parent",
        "--title",
        "后继卡片",
        "--description",
        "这条线还没有走完",
        "--body-file",
        bodyFile,
        "--workspace",
        root,
      ],
      { fetchImpl },
    );
    expect(ok.exitCode).toBe(0);
    const action = parseBody(
      requests.find((request) => request.url.endsWith("/api/agent/changes")),
    )["action"] as Record<string, unknown>;
    expect(action).toEqual({
      action: "createNext",
      editRef: "ref-parent",
      title: "后继卡片",
      body: "沿这条线继续的一段。",
      description: "这条线还没有走完",
    });
    // 纵向后继不带 branch 的排布字段。
    expect(action["side"]).toBeUndefined();
    expect(action["order"]).toBeUndefined();

    // 来源已有 next：服务 409，CLI 原样透传，不自动顶掉旧主线。
    const { root: conflictRoot, workspaceId } = await newV2Workspace();
    await writeDescriptor(conflictRoot, workspaceId);
    const conflict = fakeService({
      workspaceId,
      rootPath: conflictRoot,
      nodePath: CHILD_PATH,
      fileHash: "a".repeat(64),
      changeState: 409,
      changeBody: {
        error: { code: "OPERATION_CONFLICT", message: "该来源已经有 next 后继" },
      },
    });
    const conflictResult = await main(
      [
        "next",
        "--from-ref",
        "ref-parent",
        "--title",
        "再挂一张",
        "--description",
        "想继续",
        "--body",
        "正文",
        "--workspace",
        conflictRoot,
      ],
      { fetchImpl: conflict.fetchImpl },
    );
    expect(conflictResult.exitCode).toBe(5);
    expect(JSON.parse(conflictResult.stderr).error.code).toBe("OPERATION_CONFLICT");
    expect(JSON.parse(conflictResult.stderr).httpStatus).toBe(409);
  });

  it("connect 必须给出 description，改接来源时带 fromRef", async () => {
    const { root, fetchImpl, requests } = await withService();
    const ok = await main(
      [
        "connect",
        "--ref",
        "ref-child",
        "--from-ref",
        "ref-other",
        "--flow",
        "branch",
        "--description",
        "现在接到另一个来源更准确",
        "--workspace",
        root,
      ],
      { fetchImpl },
    );
    expect(ok.exitCode).toBe(0);
    const action = parseBody(
      requests.find((request) => request.url.endsWith("/api/agent/changes")),
    )["action"] as Record<string, unknown>;
    expect(action).toMatchObject({
      action: "updateConnection",
      editRef: "ref-child",
      fromRef: "ref-other",
      flow: "branch",
      description: "现在接到另一个来源更准确",
    });

    const missing = await main(["connect", "--ref", "ref-child", "--workspace", root], {
      fetchImpl,
    });
    expect(missing.exitCode).toBe(2);
  });

  it("create-root 只要求主题标题、标题与正文", async () => {
    const { root, fetchImpl, requests } = await withService();
    const result = await main(
      [
        "create-root",
        "--topic-title",
        "新的主题",
        "--title",
        "新的根卡",
        "--body",
        "第一段正文。",
        "--workspace",
        root,
      ],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    const action = parseBody(
      requests.find((request) => request.url.endsWith("/api/agent/changes")),
    )["action"] as Record<string, unknown>;
    expect(action).toEqual({
      action: "createRoot",
      topicTitle: "新的主题",
      title: "新的根卡",
      body: "第一段正文。",
    });
  });

  it("edit 无任何修改字段时是用法错误", async () => {
    const { root, fetchImpl, requests } = await withService();
    const result = await main(["edit", "--ref", "ref-x", "--workspace", root], { fetchImpl });
    expect(result.exitCode).toBe(2);
    expect(requests.filter((request) => request.url.endsWith("/api/agent/changes"))).toHaveLength(0);
  });

  it("412／409／422 映射为 4／5／6 并保留服务错误细节", async () => {
    const { root, workspaceId } = await newV2Workspace();
    await writeDescriptor(root, workspaceId);
    for (const [status, code, exitCode] of [
      [412, "VERSION_CONFLICT", 4],
      [409, "OPERATION_CONFLICT", 5],
      [422, "VALIDATION_FAILED", 6],
    ] as const) {
      const fake = fakeService({
        workspaceId,
        rootPath: root,
        nodePath: CHILD_PATH,
        fileHash: "a".repeat(64),
        changeState: status,
        changeBody: {
          error: {
            code,
            message: "服务拒绝",
            ...(status === 422
              ? { diagnostics: [{ code: "GRAPH_CYCLE", message: "连接形成环" }] }
              : { details: { conflicts: [{ path: CHILD_PATH }] } }),
          },
        },
      });
      const result = await main(["edit", "--ref", "ref-x", "--title", "新标题", "--workspace", root], {
        fetchImpl: fake.fetchImpl,
      });
      expect(result.exitCode).toBe(exitCode);
      const error = JSON.parse(result.stderr).error as Record<string, unknown>;
      expect(error["code"]).toBe(code);
      expect(JSON.parse(result.stderr).httpStatus).toBe(status);
    }
  });

  it("提交断线时报告 RESULT_UNKNOWN 且只发一次请求", async () => {
    const { root, workspaceId } = await newV2Workspace();
    await writeDescriptor(root, workspaceId);
    let posts = 0;
    const failing = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/workspace")) {
        return new Response(
          JSON.stringify({
            workspaceId,
            instanceId: "inst-1",
            revision: 1,
            rootPath: root,
            name: "agent-test",
            activeNode: null,
            stale: false,
            diagnostics: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/agent/changes")) {
        posts += 1;
        throw new TypeError("fetch failed");
      }
      if (url.includes("/api/changes/")) {
        return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no record" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const result = await main(
      ["edit", "--ref", "ref-x", "--title", "新标题", "--workspace", root],
      { fetchImpl: failing },
    );
    expect(result.exitCode).toBe(8);
    expect(JSON.parse(result.stderr).error.code).toBe("RESULT_UNKNOWN");
    expect(posts).toBe(1);
    const error = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(error["requestId"]).toBeTruthy();
    // 只做一次只读状态探测，不重放写请求；结果如实标记 unknown。
    expect((error["statusProbe"] as Record<string, unknown>)["state"]).toBe("unknown");
    expect(error["error"]).toMatchObject({ code: "RESULT_UNKNOWN" });
  });

  it("branch --body-stdin 从注入 stdin 读取正文并提交", async () => {
    const { root, fetchImpl, requests } = await withService();
    const result = await main(
      [
        "branch",
        "--from-ref",
        "ref-parent",
        "--title",
        "从 stdin 来的旁支",
        "--description",
        "正文较长，走 stdin 避免命令行长度限制",
        "--body-stdin",
        "--workspace",
        root,
      ],
      { fetchImpl, stdin: async () => "stdin 里的正文。\r\n第二行。\r\n" },
    );
    expect(result.exitCode).toBe(0);
    const action = parseBody(
      requests.find((request) => request.url.endsWith("/api/agent/changes")),
    )["action"] as Record<string, unknown>;
    expect(action["action"]).toBe("createBranch");
    // CRLF 统一成 LF，避免把平台差异写进节点文件。
    expect(action["body"]).toBe("stdin 里的正文。\n第二行。\n");
  });

  it("important --node 只解析一次服务身份（一次 GET /api/workspace）", async () => {
    const { root, fetchImpl, requests } = await withService();
    const result = await main(
      ["important", "--node", CHILD_NODE, "--on", "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    expect(
      requests.filter((request) => request.url.endsWith("/api/workspace")),
    ).toHaveLength(1);
    const action = parseBody(
      requests.find((request) => request.url.endsWith("/api/agent/changes")),
    )["action"] as Record<string, unknown>;
    expect(action).toMatchObject({ action: "setImportance", editRef: "ref-abc123", important: true });
  });

  it("read --node 的 404 标准 NOT_FOUND 仍映射为节点不存在（退出码 11）", async () => {
    const { root, workspaceId } = await newV2Workspace();
    await writeDescriptor(root, workspaceId);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/api/workspace")) {
        return json(200, {
          workspaceId,
          instanceId: "inst-1",
          revision: 1,
          rootPath: root,
          name: "agent-test",
          activeNode: null,
          stale: false,
          diagnostics: [],
        });
      }
      return json(404, { error: { code: "NOT_FOUND", message: "当前快照中没有节点" } });
    }) as typeof fetch;

    const result = await main(
      ["read", "--node", "n_00000000000000000000000000000000", "--workspace", root],
      { fetchImpl },
    );
    expect(result.exitCode).toBe(11);
    expect(JSON.parse(result.stderr).error.code).toBe("NOT_FOUND");
  });

  it("serve 仍可用替身启动并按关停信号停止", async () => {
    const { root, workspaceId } = await newV2Workspace();
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([{ root, port: 4401 }]);
    controller.abort();
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(stopped).toBe(1);
  });
});

describe("磁盘哈希在写入前后保持一致的真实性", () => {
  it("离线读取的 fileHash 等于实际节点文件哈希", async () => {
    const { root, childText } = await newV2Workspace();
    const result = await main(["read", "--node", CHILD_NODE, "--workspace", root]);
    const node = (JSON.parse(result.stdout)["nodes"] as Array<Record<string, unknown>>)[0];
    expect(node?.["fileHash"]).toBe(sha256Bytes(childText));
    expect(node?.["file"]).toBeUndefined();
  });
});