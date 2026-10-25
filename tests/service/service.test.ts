import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { initWorkspace, sha256Bytes } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import { WorkspaceRuntime } from "../../src/service/workspace.js";
import { createApp } from "../../src/service/server.js";

const temporaryRoots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

const NODE_ROOT = "n_00000000000000000000000000000001";
const NODE_SECOND = "n_00000000000000000000000000000002";
const TOPIC_ID = "t_00000000000000000000000000000001";
const DIR = "条目";
const TOPIC_META_PATH = "topics/" + DIR + "/topic.md";
const ROOT_PATH = "topics/" + DIR + "/" + NODE_ROOT + ".md";
const SECOND_PATH = "topics/" + DIR + "/" + NODE_SECOND + ".md";
const TOPIC_PATH = TOPIC_META_PATH;

const TOPIC_TEXT = [
  "---",
  "topicId: " + TOPIC_ID,
  "title: 条目整理",
  "---",
  "",
].join("\n");

const ROOT_TEXT = [
  "---",
  "nodeId: " + NODE_ROOT,
  "title: 记录的目的",
  "state: agreed",
  "from: null",
  "flow: root",
  "---",
  "",
  "保留有用的思路来路和关键转折。",
  "",
].join("\n");

const SECOND_TEXT = [
  "---",
  "nodeId: " + NODE_SECOND,
  "title: 原位维护",
  "state: proposed",
  "from: " + NODE_ROOT,
  "flow: next",
  "description: 先记录目的，再说明维护方式",
  "---",
  "",
  "默认更新现有内容，不按聊天轮次新增副本。",
  "",
  "这里另外说明副本策略。",
  "",
].join("\n");

async function newWorkspace(options: { withTopic?: boolean } = {}): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-service-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "service-test" });
  if (options.withTopic === true) {
    const topicDir = path.join(root, "topics", DIR);
    await fs.mkdir(topicDir, { recursive: true });
    await fs.writeFile(path.join(topicDir, "topic.md"), TOPIC_TEXT, "utf8");
    await fs.writeFile(path.join(topicDir, NODE_ROOT + ".md"), ROOT_TEXT, "utf8");
    await fs.writeFile(path.join(topicDir, NODE_SECOND + ".md"), SECOND_TEXT, "utf8");
  }
  return fs.realpath(root);
}

async function fileHash(root: string, relative: string): Promise<string> {
  const bytes = await fs.readFile(path.join(root, ...relative.split("/")));
  return sha256Bytes(bytes);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

afterEach(async () => {
  for (const handle of running.splice(0)) {
    await handle.stop().catch(() => undefined);
  }
  // 锁目录若仍存在，说明 stop 未释放；测试结束清理临时目录即可。
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeRuntime(root: string): Promise<WorkspaceRuntime> {
  const runtime = await WorkspaceRuntime.create(root);
  running.push(runtime);
  return runtime;
}

/** 用 Hono app.request 做路由级验证：不占真实端口，Host 必须显式给出。 */
async function request(
  runtime: WorkspaceRuntime,
  port: number,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  const app = createApp({ runtime, webRoot: null });
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", "127.0.0.1:" + String(port));
  return app.request("http://127.0.0.1:" + String(port) + pathname, { ...init, headers });
}

describe("只读接口", () => {
  it("空工作区成功启动并返回空图", async () => {
    const root = await newWorkspace();
    const runtime = await makeRuntime(root);
    runtime.port = 4399;
    const response = await request(runtime, 4399, "/api/graph");
    expect(response.status).toBe(200);
    const graph = (await response.json()) as Record<string, unknown>;
    expect(graph["workspaceId"]).toBe(runtime.workspaceId);
    expect(graph["nodes"]).toEqual([]);
    expect(graph["topics"]).toEqual([]);
    expect(graph["instanceId"]).toBe(runtime.instanceId);
    expect(graph["revision"]).toBe(1);
    expect(graph["stale"]).toBe(false);

    const workspace = (await (
      await request(runtime, 4399, "/api/workspace")
    ).json()) as Record<string, unknown>;
    expect(workspace["rootPath"]).toBe(root);
    expect(workspace["activeNode"]).toBeNull();
    expect(workspace["stale"]).toBe(false);

    const search = (await (
      await request(runtime, 4399, "/api/search?q=记录")
    ).json()) as Record<string, unknown>;
    expect(search["hits"]).toEqual([]);
    expect(search["truncated"]).toBe(false);
  });

  it("graph、节点与主题详情返回同一快照的正文与哈希", async () => {
    const root = await newWorkspace({ withTopic: true });
    const runtime = await makeRuntime(root);
    runtime.port = 4399;
    const graph = (await (
      await request(runtime, 4399, "/api/graph")
    ).json()) as {
      revision: number;
      instanceId: string;
      nodes: Array<{ id: string; title: string; number: string }>;
      topics: Array<{ id: string; fileHash: string }>;
    };
    expect(graph.nodes.map((node) => node.title)).toEqual(["记录的目的", "原位维护"]);
    expect(graph.topics[0]?.fileHash).toBe(await fileHash(root, TOPIC_PATH));

    const version = "?instanceId=" + graph.instanceId + "&revision=" + String(graph.revision);
    const detail = (await (
      await request(runtime, 4399, "/api/nodes/" + NODE_ROOT + version)
    ).json()) as Record<string, unknown>;
    expect(detail["body"]).toContain("保留有用的思路来路");
    expect(detail["fileHash"]).toBe(await fileHash(root, ROOT_PATH));
    expect(detail["path"]).toBe(ROOT_PATH);

    const topic = (await (
      await request(runtime, 4399, "/api/topics/" + TOPIC_ID + version)
    ).json()) as { source: string; valid: boolean; raw: string; nodes: Array<{ id: string }> };
    expect(topic.source).toBe("snapshot");
    expect(topic.valid).toBe(true);
    expect(topic.raw).toBe(TOPIC_TEXT);
    expect(topic.nodes.map((node) => node.id)).toEqual([NODE_ROOT, NODE_SECOND]);

    // 不带版本：真实磁盘原文与同一 hash。
    const disk = (await (
      await request(runtime, 4399, "/api/topics/" + TOPIC_ID)
    ).json()) as { source: string; valid: boolean; raw: string; fileHash: string };
    expect(disk.source).toBe("disk");
    expect(disk.valid).toBe(true);
    expect(disk.raw).toBe(TOPIC_TEXT);
    expect(disk.fileHash).toBe(await fileHash(root, TOPIC_PATH));

    // 旧版本详情：409 STALE_SNAPSHOT，不混用正文。
    const stale = await request(
      runtime,
      4399,
      "/api/nodes/" + NODE_ROOT + "?instanceId=" + graph.instanceId + "&revision=" + String(graph.revision - 1),
    );
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: { code: string } };
    expect(body.error.code).toBe("STALE_SNAPSHOT");
  });

  it("搜索按标题精确 > 标题包含 > 摘要 > 正文排序", async () => {
    const root = await newWorkspace({ withTopic: true });
    const runtime = await makeRuntime(root);
    runtime.port = 4399;
    const exact = (await (
      await request(runtime, 4399, "/api/search?q=" + encodeURIComponent("原位维护"))
    ).json()) as { hits: Array<{ nodeId: string; field: string }> };
    expect(exact.hits[0]).toMatchObject({ nodeId: NODE_SECOND, field: "title" });

    const bodyHit = (await (
      await request(runtime, 4399, "/api/search?q=" + encodeURIComponent("另外说明"))
    ).json()) as { hits: Array<{ nodeId: string; field: string }> };
    expect(bodyHit.hits.map((hit) => hit.nodeId)).toEqual([NODE_SECOND]);
    expect(bodyHit.hits[0]?.field).toBe("body");

    const tooLong = await request(runtime, 4399, "/api/search?q=" + "字".repeat(200));
    expect(tooLong.status).toBe(400);
  });
});

describe("本机访问边界", () => {
  it("拒绝非当前端口的 Host、跨站 Origin 与缺少写头的写请求", async () => {
    const root = await newWorkspace({ withTopic: true });
    const runtime = await makeRuntime(root);
    runtime.port = 4399;

    const badHost = await request(runtime, 4399, "/api/graph", {
      headers: { host: "evil.example:4399" },
    });
    expect(badHost.status).toBe(403);
    expect(((await badHost.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");

    const foreignPort = await request(runtime, 4399, "/api/graph", {
      headers: { host: "127.0.0.1:4400" },
    });
    expect(foreignPort.status).toBe(403);

    const badOrigin = await request(runtime, 4399, "/api/graph", {
      headers: { origin: "http://evil.example" },
    });
    expect(badOrigin.status).toBe(403);

    const okOrigin = await request(runtime, 4399, "/api/graph", {
      headers: { origin: "http://127.0.0.1:4399" },
    });
    expect(okOrigin.status).toBe(200);

    // Host=localhost 时 Origin=127.0.0.1 也是不同来源，必须拒绝。
    const mixedHost = await request(runtime, 4399, "/api/graph", {
      headers: { host: "localhost:4399", origin: "http://127.0.0.1:4399" },
    });
    expect(mixedHost.status).toBe(403);

    const payload = JSON.stringify({
      workspaceId: runtime.workspaceId,
      requestId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      expectedFiles: {},
      operations: [],
    });
    const missingHeader = await request(runtime, 4399, "/api/changes/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(missingHeader.status).toBe(403);

    const wrongType = await request(runtime, 4399, "/api/changes/check", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-aichat-client": "cli",
      },
      body: payload,
    });
    expect(wrongType.status).toBe(415);

    const prototypeKey = await request(runtime, 4399, "/api/changes/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aichat-client": "cli",
      },
      body: '{"workspaceId":"x","requestId":"0f8fad5b-d9cb-469f-a165-70867728950e","expectedFiles":{},"operations":[],"__proto__":{"polluted":true}}',
    });
    expect(prototypeKey.status).toBe(400);
    expect((await prototypeKey.json() as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("变更检查与提交", () => {
  function updateRequest(
    workspaceId: string,
    requestId: string,
    expectedHash: string,
    body: string,
  ): Record<string, unknown> {
    return {
      workspaceId,
      requestId,
      expectedFiles: { [ROOT_PATH]: expectedHash },
      operations: [{ op: "updateNode", nodeId: NODE_ROOT, body }],
    };
  }

  async function post(
    runtime: WorkspaceRuntime,
    pathname: string,
    payload: Record<string, unknown>,
  ): Promise<Response> {
    return request(runtime, 4399, pathname, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aichat-client": "cli",
      },
      body: JSON.stringify(payload),
    });
  }

  it("check 不写文件，apply 只写一次", async () => {
    const root = await newWorkspace({ withTopic: true });
    const runtime = await makeRuntime(root);
    runtime.port = 4399;
    const before = await fileHash(root, ROOT_PATH);

    const check = await post(
      runtime,
      "/api/changes/check",
      updateRequest(runtime.workspaceId, "0f8fad5b-d9cb-469f-a165-70867728950e", before, "新的正文。"),
    );
    expect(check.status).toBe(200);
    const checkBody = (await check.json()) as {
      dryRun: boolean;
      files: Array<{ path: string; nextSha256: string }>;
    };
    expect(checkBody.dryRun).toBe(true);
    expect(checkBody.files.map((file) => file.path)).toEqual([ROOT_PATH]);
    expect(await fileHash(root, ROOT_PATH)).toBe(before);

    const requestId = "1f8fad5b-d9cb-469f-a165-70867728950e";
    const payload = updateRequest(runtime.workspaceId, requestId, before, "新的正文。");
    const applied = await post(runtime, "/api/changes", payload);
    expect(applied.status).toBe(200);
    const appliedBody = (await applied.json()) as {
      state: string;
      revision: number;
      touchedFiles: Array<{ path: string; afterSha256: string }>;
      journalCleaned: boolean;
    };
    expect(appliedBody.state).toBe("committed");
    expect(appliedBody.revision).toBe(2);
    expect(appliedBody.journalCleaned).toBe(true);
    expect(appliedBody.touchedFiles[0]?.path).toBe(ROOT_PATH);
    const afterFirst = await fileHash(root, ROOT_PATH);
    expect(afterFirst).toBe(appliedBody.touchedFiles[0]?.afterSha256);

    // 同 requestId 同请求体：返回原结果，不重复写、不重复增版本。
    const replay = await post(runtime, "/api/changes", payload);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { replayed?: boolean; revision: number };
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.revision).toBe(2);
    expect(await fileHash(root, ROOT_PATH)).toBe(afterFirst);

    // 同 requestId 不同请求体：409，不执行新请求。
    const conflict = await post(
      runtime,
      "/api/changes",
      updateRequest(runtime.workspaceId, requestId, afterFirst, "另一份正文。"),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
      "OPERATION_CONFLICT",
    );
    expect(await fileHash(root, ROOT_PATH)).toBe(afterFirst);

    // 详情与新快照一致。
    const detail = (await (
      await request(runtime, 4399, "/api/nodes/" + NODE_ROOT)
    ).json()) as { body: string; fileHash: string };
    expect(detail.body).toContain("新的正文。");
    expect(detail.fileHash).toBe(afterFirst);
  });

  it("过期 hash 返回 412，不覆盖磁盘", async () => {
    const root = await newWorkspace({ withTopic: true });
    const runtime = await makeRuntime(root);
    runtime.port = 4399;
    const before = await fileHash(root, ROOT_PATH);
    const result = await post(
      runtime,
      "/api/changes",
      updateRequest(runtime.workspaceId, "2f8fad5b-d9cb-469f-a165-70867728950e", "0".repeat(64), "覆盖"),
    );
    expect(result.status).toBe(412);
    expect(((await result.json()) as { error: { code: string } }).error.code).toBe(
      "VERSION_CONFLICT",
    );
    expect(await fileHash(root, ROOT_PATH)).toBe(before);
    expect(await fs.readFile(path.join(root, ...ROOT_PATH.split("/")), "utf8")).toBe(ROOT_TEXT);
  });

  it("no-op 变更不提交、不增 revision", async () => {
    const root = await newWorkspace({ withTopic: true });
    const runtime = await makeRuntime(root);
    runtime.port = 4399;
    const before = await fileHash(root, ROOT_PATH);
    const result = await post(
      runtime,
      "/api/changes",
      updateRequest(
        runtime.workspaceId,
        "3f8fad5b-d9cb-469f-a165-70867728950e",
        before,
        "保留有用的思路来路和关键转折。",
      ),
    );
    expect(result.status).toBe(200);
    const body = (await result.json()) as { state: string; revision: number; touchedFiles: unknown[] };
    expect(body.state).toBe("noop");
    expect(body.revision).toBe(1);
    expect(body.touchedFiles).toEqual([]);
    expect(await fileHash(root, ROOT_PATH)).toBe(before);
  });
});

describe("外部坏文件与有效快照", () => {
  it("disk 非法时保留上一份有效详情并标 stale", async () => {
    const root = await newWorkspace({ withTopic: true });
    const runtime = await makeRuntime(root);
    runtime.port = 4399;
    const before = (await (
      await request(runtime, 4399, "/api/graph")
    ).json()) as { revision: number; instanceId: string; topics: Array<{ fileHash: string }> };

    const broken = "---\ntitle: 坏文件\n---\n";
    await fs.writeFile(path.join(root, ...TOPIC_PATH.split("/")), broken, "utf8");
    const reloaded = await runtime.reloadFromDisk();
    expect(reloaded.ok).toBe(false);

    const workspace = (await (
      await request(runtime, 4399, "/api/workspace")
    ).json()) as { stale: boolean; revision: number; diagnostics: Array<{ code: string }> };
    expect(workspace.stale).toBe(true);
    expect(workspace.revision).toBe(before.revision);
    expect(workspace.diagnostics.length).toBeGreaterThan(0);

    // 有效快照详情仍来自旧版本，且哈希一致。
    const version = "?instanceId=" + before.instanceId + "&revision=" + String(before.revision);
    const snapshotDetail = (await (
      await request(runtime, 4399, "/api/topics/" + TOPIC_ID + version)
    ).json()) as { source: string; valid: boolean; raw: string; fileHash: string };
    expect(snapshotDetail.source).toBe("snapshot");
    expect(snapshotDetail.valid).toBe(true);
    expect(snapshotDetail.raw).toBe(TOPIC_TEXT);
    expect(snapshotDetail.fileHash).toBe(before.topics[0]?.fileHash);

    // 磁盘详情：invalid，raw 是新坏文件、hash 是新坏文件，不拼旧内容。
    const diskDetail = (await (
      await request(runtime, 4399, "/api/topics/" + TOPIC_ID)
    ).json()) as { source: string; valid: boolean; raw: string; fileHash: string; nodes: unknown[] };
    expect(diskDetail.source).toBe("disk");
    expect(diskDetail.valid).toBe(false);
    expect(diskDetail.raw).toBe(broken);
    expect(diskDetail.fileHash).toBe(sha256Bytes(broken));
    expect(diskDetail.nodes).toEqual([]);

    // workspace.json 的 workspaceId 被改成另一个工作区时，拒绝切换身份。
    const workspaceFile = JSON.parse(
      await fs.readFile(path.join(root, "workspace.json"), "utf8"),
    ) as Record<string, unknown>;
    await fs.writeFile(
      path.join(root, "workspace.json"),
      JSON.stringify({ ...workspaceFile, workspaceId: "w_other" }, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, ...TOPIC_PATH.split("/")), TOPIC_TEXT, "utf8");
    const identityReload = await runtime.reloadFromDisk();
    expect(identityReload.ok).toBe(false);
    const stillSame = (await (
      await request(runtime, 4399, "/api/workspace")
    ).json()) as { workspaceId: string; stale: boolean };
    expect(stillSame.workspaceId).toBe(runtime.workspaceId);
    expect(stillSame.stale).toBe(true);
    // 恢复原 workspace.json 与坏主题，继续后面的坏源验证。
    await fs.writeFile(
      path.join(root, "workspace.json"),
      JSON.stringify(workspaceFile, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, ...TOPIC_PATH.split("/")), broken, "utf8");
    await runtime.reloadFromDisk();

    // 坏源不能通过普通 apply 被"顺手修复"：任何写请求都因解析失败而拒绝。
    const apply = await request(runtime, 4399, "/api/changes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aichat-client": "cli" },
      body: JSON.stringify({
        workspaceId: runtime.workspaceId,
        requestId: "4f8fad5b-d9cb-469f-a165-70867728950e",
        expectedFiles: { [TOPIC_PATH]: sha256Bytes(broken) },
        operations: [{ op: "updateNode", nodeId: NODE_ROOT, body: "修复" }],
      }),
    });
    const applyBody = (await apply.json()) as { error?: { code: string } };
    expect(apply.status).toBe(422);
    expect(applyBody.error?.code).toBe("VALIDATION_FAILED");
    expect(await fs.readFile(path.join(root, ...TOPIC_PATH.split("/")), "utf8")).toBe(broken);
  });
});

describe("真实 loopback 启动", () => {
  it("启动、提供静态页面与 SSE、停止后只清理自己的描述文件", async () => {
    const root = await newWorkspace({ withTopic: true });
    const port = await freePort();
    const handle = await startService({ root, port });
    running.push(handle);
    expect(handle.url).toBe("http://127.0.0.1:" + String(port));
    expect(handle.rootPath).toBe(root);

    const descriptor = JSON.parse(
      await fs.readFile(path.join(root, ".aichat", "runtime", "service.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(descriptor).toMatchObject({
      url: handle.url,
      rootPath: root,
      workspaceId: handle.workspaceId,
      instanceId: handle.instanceId,
      pid: process.pid,
    });

    const workspace = (await (await fetch(handle.url + "/api/workspace")).json()) as Record<
      string,
      unknown
    >;
    expect(workspace["workspaceId"]).toBe(handle.workspaceId);
    expect(workspace["instanceId"]).toBe(handle.instanceId);

    const page = await fetch(handle.url + "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("<div id=\"root\">");

    const controller = new AbortController();
    const events = await fetch(handle.url + "/api/events", { signal: controller.signal });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = events.body?.getReader();
    const first = await reader?.read();
    controller.abort();
    const chunk = new TextDecoder().decode(first?.value ?? new Uint8Array());
    expect(chunk).toContain("event: snapshot");
    expect(chunk).toContain(handle.instanceId);

    // 第二次启动同一工作区：写锁被占用，明确失败而不是静默换端口。
    await expect(startService({ root, port: await freePort() })).rejects.toMatchObject({
      code: "WRITER_LOCKED",
    });

    await handle.stop();
    running.splice(running.indexOf(handle), 1);
    await expect(
      fs.access(path.join(root, ".aichat", "runtime", "service.json")),
    ).rejects.toBeTruthy();
    await expect(fs.access(path.join(root, ".aichat", "runtime", "writer.lock"))).rejects.toBeTruthy();

    // stop 幂等，并允许再次启动。
    await handle.stop();
    const again = await startService({ root, port });
    running.push(again);
    expect(again.workspaceId).toBe(handle.workspaceId);
    expect(again.instanceId).not.toBe(handle.instanceId);
  });
});
describe("丢锁与状态细节", () => {
  it("状态查询保留会话细分状态", async () => {
    const root = await newWorkspace({ withTopic: true });
    const runtime = await makeRuntime(root);
    runtime.port = 4399;
    runtime.recordChange({
      requestId: "5f8fad5b-d9cb-469f-a165-70867728950e",
      bodyHash: "hash",
      httpStatus: 200,
      state: "committed_refresh_pending",
      body: { ok: true, state: "committed", revision: 3 },
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    const response = await request(
      runtime,
      4399,
      "/api/changes/5f8fad5b-d9cb-469f-a165-70867728950e",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["state"]).toBe("committed_refresh_pending");
    expect(body["source"]).toBe("session");
    expect(body["revision"]).toBe(3);
  });

  it("受控写入停用后 apply 拒绝并不触碰磁盘", async () => {
    const root = await newWorkspace({ withTopic: true });
    const runtime = await makeRuntime(root);
    runtime.port = 4399;
    const before = await fileHash(root, ROOT_PATH);
    runtime.disableWrites("WRITER_LOCK_COMPROMISED", "测试：写锁失效");
    const response = await request(runtime, 4399, "/api/changes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aichat-client": "cli" },
      body: JSON.stringify({
        workspaceId: runtime.workspaceId,
        requestId: "6f8fad5b-d9cb-469f-a165-70867728950e",
        expectedFiles: { [ROOT_PATH]: before },
        operations: [{ op: "updateNode", nodeId: NODE_ROOT, body: "不应写入" }],
      }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "WRITE_DISABLED",
    );
    expect(await fileHash(root, ROOT_PATH)).toBe(before);
    const diagnostics = (await (
      await request(runtime, 4399, "/api/diagnostics")
    ).json()) as { diagnostics: Array<{ code: string }> };
    expect(diagnostics.diagnostics.some((item) => item.code === "WRITER_LOCK_COMPROMISED")).toBe(
      true,
    );
  });
});
describe("监听与端口", () => {
  it("外部编辑经 watcher 发布新快照；托管写后同内容不重复发布", async () => {
    const root = await newWorkspace({ withTopic: true });
    const port = await freePort();
    const handle = await startService({ root, port });
    running.push(handle);

    const controller = new AbortController();
    const events = await fetch(handle.url + "/api/events", { signal: controller.signal });
    const reader = events.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const nextSnapshot = async (): Promise<{ revision: number; changedNodeIds: string[] }> => {
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.value === undefined) throw new Error("SSE 结束");
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (!block.includes("event: snapshot")) continue;
          const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine === undefined) continue;
          const payload = JSON.parse(dataLine.slice(6)) as {
            revision: number;
            changedNodeIds: string[];
          };
          if (payload.revision > 1) return payload;
        }
      }
    };

    // 首次连接立即收到当前版本事件，忽略；之后外部编辑应触发新版本。
    const graph = (await (await fetch(handle.url + "/api/graph")).json()) as {
      revision: number;
      instanceId: string;
    };
    expect(graph.revision).toBe(1);

    const edited = ROOT_TEXT.replace("保留有用的思路来路和关键转折。", "外部编辑后的正文。");
    await fs.writeFile(path.join(root, ...ROOT_PATH.split("/")), edited, "utf8");
    const published = await nextSnapshot();
    expect(published.revision).toBe(2);
    expect(published.changedNodeIds).toEqual([NODE_ROOT]);

    const detail = (await (
      await fetch(
        handle.url +
          "/api/nodes/" +
          NODE_ROOT +
          "?instanceId=" +
          graph.instanceId +
          "&revision=" +
          String(published.revision),
      )
    ).json()) as { body: string };
    expect(detail.body).toContain("外部编辑后的正文。");

    // 托管写入同一个文件后，watcher 重读不应再发布一次（内容指纹相同）。
    const hashNow = await fileHash(root, SECOND_PATH);
    const payload = JSON.stringify({
      workspaceId: handle.workspaceId,
      requestId: "7f8fad5b-d9cb-469f-a165-70867728950e",
      expectedFiles: { [SECOND_PATH]: hashNow },
      operations: [{ op: "updateNode", nodeId: NODE_SECOND, body: "托管写入正文。" }],
    });
    const applied = await fetch(handle.url + "/api/changes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aichat-client": "cli" },
      body: payload,
    });
    expect(applied.status).toBe(200);
    const appliedBody = (await applied.json()) as { revision: number };
    expect(appliedBody.revision).toBe(3);

    // 等待 watcher 批处理窗口过去，再确认版本没有再次增加。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = (await (await fetch(handle.url + "/api/graph")).json()) as { revision: number };
    expect(after.revision).toBe(3);
    controller.abort();
    await handle.stop();
    running.splice(running.indexOf(handle), 1);
  });

  it("端口被占用时明确失败，不静默换端口", async () => {
    const root = await newWorkspace();
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    try {
      await expect(startService({ root, port })).rejects.toMatchObject({ code: "PORT_UNAVAILABLE" });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    // 失败的服务不留下 descriptor，也不占着写锁。
    await expect(fs.access(path.join(root, ".aichat", "runtime", "service.json"))).rejects.toBeTruthy();
    const handle = await startService({ root, port });
    running.push(handle);
    expect(new URL(handle.url).port).toBe(String(port));
  });
});