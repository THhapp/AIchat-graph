import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";

/**
 * 重要标记（P11）与最近一次内容更新（P06）的服务端契约。
 *
 * 用真实 startService + 真实磁盘：importance 必须真的写进节点文件，
 * lastChange 必须跨重启仍在，且不被读取、导出或标记操作替换。
 */

const temporaryRoots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

const TOPIC_ID = "t_" + "3".repeat(32);
const ROOT_NODE = "n_" + "1".repeat(32);
const NEXT_NODE = "n_" + "2".repeat(32);
const DIR = "讨论";

function nodeFile(options: {
  nodeId: string;
  title: string;
  from: string | null;
  flow: "root" | "next" | "branch";
  description?: string;
  important?: boolean;
  body: string;
}): string {
  const lines = [
    "---",
    "nodeId: " + options.nodeId,
    "title: " + options.title,
    "state: agreed",
    "from: " + (options.from ?? "null"),
    "flow: " + options.flow,
  ];
  if (options.description !== undefined) lines.push("description: " + options.description);
  if (options.important === true) lines.push("important: true");
  lines.push("---", "", options.body, "");
  return lines.join("\n");
}

async function newV2Workspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-importance-svc-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "importance-service" });
  const topicDir = path.join(root, "topics", DIR);
  await fs.mkdir(topicDir, { recursive: true });
  await fs.writeFile(
    path.join(topicDir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: 条目整理\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, ROOT_NODE + ".md"),
    nodeFile({ nodeId: ROOT_NODE, title: "记录的目的", from: null, flow: "root", body: "根节点正文。" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, NEXT_NODE + ".md"),
    nodeFile({
      nodeId: NEXT_NODE,
      title: "维护方式",
      from: ROOT_NODE,
      flow: "next",
      description: "先记录目的，再说明维护方式",
      body: "默认更新现有内容。\n\n第二段补充。",
    }),
    "utf8",
  );
  return fs.realpath(root);
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

function writeHeaders(): Record<string, string> {
  return { "content-type": "application/json", "x-aichat-client": "cli" };
}

interface GraphBody {
  instanceId: string;
  revision: number;
  lastChanges?: Record<string, { at: string; nodeIds: string[] }>;
  nodes: Array<{ id: string; important: boolean; title: string }>;
}

async function graphOf(url: string): Promise<GraphBody> {
  const response = await fetch(url + "/api/graph");
  expect(response.status).toBe(200);
  return (await response.json()) as GraphBody;
}

function nodeTextPath(root: string, nodeId: string): string {
  return path.join(root, "topics", DIR, nodeId + ".md");
}

afterEach(async () => {
  for (const handle of running.splice(0)) {
    await handle.stop().catch(() => undefined);
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("POST /api/importance", () => {
  it("设置、读回、清除，并把字段写进真实节点文件", async () => {
    const root = await newV2Workspace();
    const handle: ServiceHandle = await startService({ root, port: await freePort() });
    running.push(handle);

    const before = await graphOf(handle.url);
    expect(before.nodes.find((node) => node.id === NEXT_NODE)?.important).toBe(false);
    expect(before.lastChanges).toBeUndefined();

    const set = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ topicId: TOPIC_ID, nodeId: NEXT_NODE, important: true }),
    });
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as {
      ok: boolean;
      revision: number;
      node: { id: string; important: boolean; title: string };
    };
    expect(setBody.ok).toBe(true);
    expect(setBody.node.important).toBe(true);
    expect(setBody.node.title).toBe("维护方式");
    expect(setBody.revision).toBeGreaterThan(before.revision);

    const afterSet = await graphOf(handle.url);
    expect(afterSet.nodes.find((node) => node.id === NEXT_NODE)?.important).toBe(true);
    // 只改元数据：不产生"最近一次内容更新"。
    expect(afterSet.lastChanges).toBeUndefined();
    const onDisk = await fs.readFile(nodeTextPath(root, NEXT_NODE), "utf8");
    expect(onDisk).toContain("important: true");
    expect(onDisk).toContain("默认更新现有内容。");

    const clear = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ topicId: TOPIC_ID, nodeId: NEXT_NODE, important: false }),
    });
    expect(clear.status).toBe(200);
    const clearBody = (await clear.json()) as { node: { important: boolean } };
    expect(clearBody.node.important).toBe(false);
    expect((await graphOf(handle.url)).nodes.find((node) => node.id === NEXT_NODE)?.important).toBe(false);
    const clearedDisk = await fs.readFile(nodeTextPath(root, NEXT_NODE), "utf8");
    expect(clearedDisk).not.toContain("important");
  });

  it("expectedHash 失配 412，节点不存在 409，请求体非法 400", async () => {
    const root = await newV2Workspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const read = (await (await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE)).json()) as {
      fileHash: string;
    };
    const stale = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({
        topicId: TOPIC_ID,
        nodeId: NEXT_NODE,
        important: true,
        expectedHash: "0".repeat(64),
      }),
    });
    expect(stale.status).toBe(412);

    const fresh = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({
        topicId: TOPIC_ID,
        nodeId: NEXT_NODE,
        important: true,
        expectedHash: read.fileHash,
      }),
    });
    expect(fresh.status).toBe(200);

    const missing = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ topicId: TOPIC_ID, nodeId: "n_" + "9".repeat(32), important: true }),
    });
    expect(missing.status).toBe(409);

    const wrongTopic = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ topicId: "t_" + "8".repeat(32), nodeId: NEXT_NODE, important: true }),
    });
    expect(wrongTopic.status).toBe(409);

    const badBody = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ topicId: TOPIC_ID, nodeId: NEXT_NODE, important: "yes" }),
    });
    expect(badBody.status).toBe(400);

    const extraField = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ topicId: TOPIC_ID, nodeId: NEXT_NODE, important: true, body: "改正文" }),
    });
    expect(extraField.status).toBe(400);

    const noHeader = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topicId: TOPIC_ID, nodeId: NEXT_NODE, important: true }),
    });
    expect(noHeader.status).toBe(403);
  });

  it("重复设置同一值不写文件", async () => {
    const root = await newV2Workspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ topicId: TOPIC_ID, nodeId: NEXT_NODE, important: true }),
    });
    const before = await graphOf(handle.url);
    const again = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ topicId: TOPIC_ID, nodeId: NEXT_NODE, important: true }),
    });
    expect(again.status).toBe(200);
    const after = await graphOf(handle.url);
    expect(after.revision).toBe(before.revision);
  });
});

describe("GraphResponse.lastChanges", () => {
  async function editNode(
    handle: ServiceHandle,
    nodeId: string,
    action: Record<string, unknown>,
  ): Promise<Response> {
    const read = (await (await fetch(handle.url + "/api/agent/nodes/" + nodeId)).json()) as {
      editRef: { ref: string };
    };
    return fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: randomUUID(),
        action: { action: "patchNode", editRef: read.editRef.ref, ...action },
      }),
    });
  }

  it("只记录真正改写的节点，纯读取与标记不替换", async () => {
    const root = await newV2Workspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    expect((await graphOf(handle.url)).lastChanges).toBeUndefined();

    const edited = await editNode(handle, NEXT_NODE, { append: "\n\n追加一段。" });
    const respondedAt = Date.now();
    expect(edited.status).toBe(200);
    const first = (await graphOf(handle.url)).lastChanges?.[TOPIC_ID];
    expect(first?.nodeIds).toEqual([NEXT_NODE]);
    expect(typeof first?.at).toBe("string");
    expect(Number.isNaN(Date.parse(first?.at ?? ""))).toBe(false);

    // 时序：记录在提交链路内写盘，提交响应到达时文件已存在且时间不晚于响应。
    const recordAfterFirst = JSON.parse(
      await fs.readFile(path.join(root, ".aichat", "runtime", "last-change.json"), "utf8"),
    ) as { topics: Record<string, { at: string }> };
    expect(Date.parse(recordAfterFirst.topics[TOPIC_ID]?.at ?? "")).toBeLessThanOrEqual(respondedAt);

    // 纯读取：graph／节点详情／主题详情都不改变标记。
    await graphOf(handle.url);
    await fetch(handle.url + "/api/nodes/" + NEXT_NODE);
    await fetch(handle.url + "/api/topics/" + TOPIC_ID);
    expect((await graphOf(handle.url)).lastChanges?.[TOPIC_ID]).toEqual(first);

    // 标记重要性不替换标记。
    await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ topicId: TOPIC_ID, nodeId: ROOT_NODE, important: true }),
    });
    expect((await graphOf(handle.url)).lastChanges?.[TOPIC_ID]).toEqual(first);

    // 无变化的 patch 也不替换。
    const noop = await editNode(handle, NEXT_NODE, { title: "维护方式" });
    expect(noop.status).toBe(200);
    expect((await graphOf(handle.url)).lastChanges?.[TOPIC_ID]).toEqual(first);

    // 同一主题的下一次真实修改替换该主题上一批，只含新改动的节点。
    const second = await editNode(handle, ROOT_NODE, { title: "记录的目的（改）" });
    expect(second.status).toBe(200);
    const next = (await graphOf(handle.url)).lastChanges?.[TOPIC_ID];
    expect(next?.nodeIds).toEqual([ROOT_NODE]);
    expect((await graphOf(handle.url)).lastChanges?.[TOPIC_ID]).toEqual(next);

    // 单条主题记录：不是历史档案。
    const record = JSON.parse(
      await fs.readFile(path.join(root, ".aichat", "runtime", "last-change.json"), "utf8"),
    ) as { schemaVersion: number; topics: Record<string, { nodeIds: string[]; at: string }> };
    expect(record.schemaVersion).toBe(2);
    expect(record.topics[TOPIC_ID]?.nodeIds).toEqual([ROOT_NODE]);
  });

  it("重启后仍能读回同一条记录", async () => {
    const root = await newV2Workspace();
    const first = await startService({ root, port: await freePort() });
    running.push(first);
    await editNode(first, NEXT_NODE, { append: "\n\n追加一段。" });
    const recorded = (await graphOf(first.url)).lastChanges?.[TOPIC_ID];
    expect(recorded?.nodeIds).toEqual([NEXT_NODE]);
    await first.stop();
    running.splice(running.indexOf(first), 1);

    const again = await startService({ root, port: await freePort() });
    running.push(again);
    expect((await graphOf(again.url)).lastChanges?.[TOPIC_ID]).toEqual(recorded);
  });
});

describe("A03 读取参数", () => {
  it("GET /api/agent/nodes?length=0 返回 400 并给出有效范围", async () => {
    const root = await newV2Workspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const response = await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?length=0");
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string; details?: { max?: number } };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("1-16000");
    expect(body.error.details?.max).toBe(16000);
  });
});
