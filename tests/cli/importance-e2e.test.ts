import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { main } from "../../src/cli/index.js";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";

/**
 * 重要标记（P11）与"最近一次内容更新"（P06）的端到端验收。
 *
 * 读取与内容修改走真实 CLI（main → 在线传输 → 服务 → 磁盘），
 * 重要标记走它唯一的入口 `POST /api/importance`；断言既看图协议回读，
 * 也看磁盘上的真实文件，避免只验证内存状态。
 */

const TOPIC_ID = "t_" + "5".repeat(32);
const ROOT_NODE = "n_" + "6".repeat(32);
const NEXT_NODE = "n_" + "7".repeat(32);
const DIR = "条目整理";

const temporaryRoots: string[] = [];
const running: ServiceHandle[] = [];

function nodeFile(options: {
  nodeId: string;
  title: string;
  from: string | null;
  flow: "root" | "next";
  description?: string;
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
  lines.push("---", "", options.body, "");
  return lines.join("\n");
}

function freePort(): Promise<number> {
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

async function newWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-importance-e2e-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  const files: Record<string, string> = {
    "workspace.json":
      JSON.stringify(
        { schemaVersion: 2, workspaceId: "w_importance_e2e", name: "importance e2e", activeNode: null },
        null,
        2,
      ) + "\n",
    ["topics/" + DIR + "/topic.md"]: ["---", "topicId: " + TOPIC_ID, "title: " + DIR, "---", ""].join("\n"),
    ["topics/" + DIR + "/" + ROOT_NODE + ".md"]: nodeFile({
      nodeId: ROOT_NODE,
      title: "记录的目的",
      from: null,
      flow: "root",
      body: "保留有用的思路来路与关键转折。",
    }),
    ["topics/" + DIR + "/" + NEXT_NODE + ".md"]: nodeFile({
      nodeId: NEXT_NODE,
      title: "原位维护",
      from: ROOT_NODE,
      flow: "next",
      description: "先记录目的，再说明维护方式",
      body: "默认更新现有内容。",
    }),
  };
  for (const [relativePath, text] of Object.entries(files)) {
    const absolute = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text, "utf8");
  }
  return fs.realpath(root);
}

async function start(root: string): Promise<ServiceHandle> {
  const handle = await startService({ root, port: await freePort() });
  running.push(handle);
  return handle;
}

async function stop(handle: ServiceHandle): Promise<void> {
  const index = running.indexOf(handle);
  if (index >= 0) running.splice(index, 1);
  await handle.stop();
}

afterEach(async () => {
  for (const handle of running.splice(0)) {
    await handle.stop().catch(() => undefined);
  }
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface CliNode {
  id: string;
  title: string;
  important: boolean;
}

interface CliRead {
  ok: boolean;
  nodes: Array<{ source: string; node: CliNode; editRef: { ref: string } }>;
}

async function cliRead(root: string, nodeId: string): Promise<{ node: CliNode; source: string; ref: string }> {
  const outcome = await main(["read", "--node", nodeId, "--workspace", root]);
  expect(outcome.exitCode, outcome.stderr).toBe(0);
  const body = JSON.parse(outcome.stdout) as CliRead;
  const entry = body.nodes[0];
  expect(entry).toBeDefined();
  const value = entry as { source: string; node: CliNode; editRef: { ref: string } };
  return { node: value.node, source: value.source, ref: value.editRef.ref };
}

/** 用真实 CLI 做一次内容修改；返回提交响应的绝对时间（毫秒）。 */
async function cliEdit(root: string, nodeId: string, text: string): Promise<number> {
  const read = await cliRead(root, nodeId);
  const outcome = await main([
    "edit",
    "--ref",
    read.ref,
    "--body",
    text,
    "--workspace",
    root,
  ]);
  expect(outcome.exitCode, outcome.stderr).toBe(0);
  return Date.now();
}

interface GraphBody {
  revision: number;
  lastChanges?: Record<string, { at: string; nodeIds: string[] }>;
  nodes: Array<{ id: string; important: boolean }>;
}

async function graphOf(handle: ServiceHandle): Promise<GraphBody> {
  const response = await fetch(handle.url + "/api/graph");
  expect(response.status).toBe(200);
  return (await response.json()) as GraphBody;
}

async function postImportance(
  handle: ServiceHandle,
  payload: Record<string, unknown>,
): Promise<Response> {
  return fetch(handle.url + "/api/importance", {
    method: "POST",
    headers: { "content-type": "application/json", "x-aichat-client": "cli" },
    body: JSON.stringify(payload),
  });
}

function lastChangePath(root: string): string {
  return path.join(root, ".aichat", "runtime", "last-change.json");
}

function nodeTextPath(root: string, nodeId: string): string {
  return path.join(root, "topics", DIR, nodeId + ".md");
}

/** 有界等待：提交链路正常时文件已存在；这里只防文件系统可见性抖动。 */
async function waitForFile(absolute: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const present = await fs.stat(absolute).then(
      () => true,
      () => false,
    );
    if (present) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("重要标记：设置 → 读回 → 清除", () => {
  it("写进真实节点文件，清除后字段不留痕", async () => {
    const root = await newWorkspace();
    const handle = await start(root);

    expect((await cliRead(root, NEXT_NODE)).node.important).toBe(false);

    const set = await postImportance(handle, { topicId: TOPIC_ID, nodeId: NEXT_NODE, important: true });
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as { ok: boolean; node: { id: string; important: boolean; title: string } };
    expect(setBody.ok).toBe(true);
    expect(setBody.node.id).toBe(NEXT_NODE);
    expect(setBody.node.important).toBe(true);
    expect(setBody.node.title).toBe("原位维护");

    // CLI 读回：线上载荷来自服务端快照，不是本地猜测。
    const readBack = await cliRead(root, NEXT_NODE);
    expect(readBack.node.important).toBe(true);
    expect(readBack.source).toBe("online");
    expect((await graphOf(handle)).nodes.find((node) => node.id === NEXT_NODE)?.important).toBe(true);

    const marked = await fs.readFile(nodeTextPath(root, NEXT_NODE), "utf8");
    expect(marked).toContain("important: true");
    expect(marked).toContain("默认更新现有内容。");

    const clear = await postImportance(handle, { topicId: TOPIC_ID, nodeId: NEXT_NODE, important: false });
    expect(clear.status).toBe(200);
    expect(((await clear.json()) as { node: { important: boolean } }).node.important).toBe(false);
    expect((await cliRead(root, NEXT_NODE)).node.important).toBe(false);

    // "干净"：字段整条消失，不是留一个 important: false。
    const cleared = await fs.readFile(nodeTextPath(root, NEXT_NODE), "utf8");
    expect(cleared).not.toContain("important");
    expect(cleared).toContain("默认更新现有内容。");

    // 标记只动元数据，不产生"最近一次内容更新"。
    expect((await graphOf(handle)).lastChanges).toBeUndefined();
    expect(await fs.stat(lastChangePath(root)).then(() => true, () => false)).toBe(false);
  });
});

describe("最近一次内容更新", () => {
  it("一次内容修改只记被改节点，且提交返回时记录已落盘", async () => {
    const root = await newWorkspace();
    const handle = await start(root);
    expect((await graphOf(handle)).lastChanges).toBeUndefined();

    const respondedAt = await cliEdit(root, NEXT_NODE, "改成新的正文。");
    expect(await waitForFile(lastChangePath(root))).toBe(true);

    const record = JSON.parse(await fs.readFile(lastChangePath(root), "utf8")) as {
      schemaVersion: number;
      topics: Record<string, { at: string; nodeIds: string[] }>;
    };
    expect(record.schemaVersion).toBe(2);
    const topicRecord = record.topics[TOPIC_ID];
    expect(topicRecord?.nodeIds).toEqual([NEXT_NODE]);

    // 时序：记录时间产生于提交链路内部，必不晚于提交响应到达的时刻。
    expect(Date.parse(topicRecord?.at ?? "")).toBeLessThanOrEqual(respondedAt);

    const first = (await graphOf(handle)).lastChanges?.[TOPIC_ID];
    expect(first?.nodeIds).toEqual([NEXT_NODE]);
    expect(first?.at).toBe(topicRecord?.at);

    // 只有被改节点进记录：没动的根节点不出现。
    expect(first?.nodeIds.includes(ROOT_NODE)).toBe(false);
    expect(await fs.readFile(nodeTextPath(root, ROOT_NODE), "utf8")).not.toContain("important");

    // 同一主题的下一次真实修改替换该主题上一批。
    await cliEdit(root, ROOT_NODE, "根节点也改一次。");
    const second = (await graphOf(handle)).lastChanges?.[TOPIC_ID];
    expect(second?.nodeIds).toEqual([ROOT_NODE]);
    const replaced = JSON.parse(await fs.readFile(lastChangePath(root), "utf8")) as {
      topics: Record<string, { nodeIds: string[]; at: string }>;
    };
    expect(replaced.topics[TOPIC_ID]?.nodeIds).toEqual([ROOT_NODE]);
    expect(replaced.topics[TOPIC_ID]?.at).toBe(second?.at);
  });

  it("纯读取与重要标记都不替换记录", async () => {
    const root = await newWorkspace();
    const handle = await start(root);

    await cliEdit(root, NEXT_NODE, "先写一段正文。");
    const recorded = (await graphOf(handle)).lastChanges?.[TOPIC_ID];
    expect(recorded?.nodeIds).toEqual([NEXT_NODE]);

    // 只读路径：CLI read（在线 + 落盘回退）、topics、validate、graph、节点详情、主题详情。
    await cliRead(root, NEXT_NODE);
    await cliRead(root, ROOT_NODE);
    for (const args of [
      ["topics", "--workspace", root],
      ["validate", "--workspace", root],
      ["read", "--node", NEXT_NODE, "--offline", "--workspace", root],
    ]) {
      const outcome = await main(args);
      expect(outcome.exitCode, outcome.stderr).toBe(0);
    }
    await fetch(handle.url + "/api/nodes/" + NEXT_NODE);
    await fetch(handle.url + "/api/topics/" + TOPIC_ID);

    expect((await graphOf(handle)).lastChanges?.[TOPIC_ID]).toEqual(recorded);

    // 标记重要性是元数据操作，同样不替换。
    expect((await postImportance(handle, { topicId: TOPIC_ID, nodeId: ROOT_NODE, important: true })).status).toBe(
      200,
    );
    expect((await graphOf(handle)).lastChanges?.[TOPIC_ID]).toEqual(recorded);

    const unchanged = JSON.parse(await fs.readFile(lastChangePath(root), "utf8")) as {
      topics: Record<string, { at: string; nodeIds: string[] }>;
    };
    expect(unchanged.topics[TOPIC_ID]?.at).toBe(recorded?.at);
    expect(unchanged.topics[TOPIC_ID]?.nodeIds).toEqual([NEXT_NODE]);
  });

  it("无实际改动的提交不刷新记录", async () => {
    const root = await newWorkspace();
    const handle = await start(root);
    await cliEdit(root, NEXT_NODE, "保持这段正文。");
    const recorded = (await graphOf(handle)).lastChanges?.[TOPIC_ID];

    // 同样内容的第二次提交：服务判定 noop，不递增 revision、不重写记录。
    const read = await cliRead(root, NEXT_NODE);
    const same = await main([
      "edit",
      "--ref",
      read.ref,
      "--body",
      "保持这段正文。",
      "--workspace",
      root,
    ]);
    expect(same.exitCode, same.stderr).toBe(0);
    expect((await graphOf(handle)).lastChanges?.[TOPIC_ID]).toEqual(recorded);
  });

  it("重启后仍能读到同一条记录", async () => {
    const root = await newWorkspace();
    const first = await start(root);
    await cliEdit(root, NEXT_NODE, "重启前写下的正文。");
    const recorded = (await graphOf(first)).lastChanges?.[TOPIC_ID];
    expect(recorded?.nodeIds).toEqual([NEXT_NODE]);
    await stop(first);

    const again = await start(root);
    expect((await graphOf(again)).lastChanges?.[TOPIC_ID]).toEqual(recorded);
    // 重启后的 CLI 读取仍看得到同一条，且节点正文就是上次提交的内容。
    expect((await cliRead(root, NEXT_NODE)).node.id).toBe(NEXT_NODE);
    expect(await fs.readFile(nodeTextPath(root, NEXT_NODE), "utf8")).toContain("重启前写下的正文。");
  });
});

describe("POST /api/importance 的错误面", () => {
  it("非法请求体 400／节点或主题不存在 409／expectedHash 失配 412", async () => {
    const root = await newWorkspace();
    const handle = await start(root);

    const badBody = await postImportance(handle, { topicId: TOPIC_ID, nodeId: NEXT_NODE, important: "yes" });
    expect(badBody.status).toBe(400);
    expect(((await badBody.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");

    const extraField = await postImportance(handle, {
      topicId: TOPIC_ID,
      nodeId: NEXT_NODE,
      important: true,
      body: "顺手改正文",
    });
    expect(extraField.status).toBe(400);

    const missingNode = await postImportance(handle, {
      topicId: TOPIC_ID,
      nodeId: "n_" + "9".repeat(32),
      important: true,
    });
    expect(missingNode.status).toBe(409);

    const wrongTopic = await postImportance(handle, {
      topicId: "t_" + "8".repeat(32),
      nodeId: NEXT_NODE,
      important: true,
    });
    expect(wrongTopic.status).toBe(409);

    const stale = await postImportance(handle, {
      topicId: TOPIC_ID,
      nodeId: NEXT_NODE,
      important: true,
      expectedHash: "0".repeat(64),
    });
    expect(stale.status).toBe(412);

    // 三种失败都没有落盘副作用。
    expect(await fs.stat(lastChangePath(root)).then(() => true, () => false)).toBe(false);
    expect(await fs.readFile(nodeTextPath(root, NEXT_NODE), "utf8")).not.toContain("important");
  });
});
