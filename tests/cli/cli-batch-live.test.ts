import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";
import { main } from "../../src/cli/index.js";

const TOPIC_ID = "t_" + "3".repeat(32);
const A = "n_" + "a".repeat(32);
const B = "n_" + "b".repeat(32);
const C = "n_" + "c".repeat(32);
const DIR = "冒烟";
let parent: string;
let root: string;
let handle: ServiceHandle;

function nodeFile(id: string, title: string, from: string | null, flow: "root" | "next" | "branch", description: string | undefined, body: string): string {
  const lines = ["---", "nodeId: " + id, "title: " + title, "state: agreed", "from: " + (from ?? "null"), "flow: " + flow];
  if (description !== undefined) lines.push("description: " + description);
  lines.push("---", "", body, "");
  return lines.join("\n");
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

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await main(args);
  return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function jsonOf(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-b-smoke-"));
  const created = await initWorkspace({ root: path.join(parent, "workspace"), name: "smoke" });
  root = created.root;
  const dir = path.join(root, "topics", DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "topic.md"), "---\ntopicId: " + TOPIC_ID + "\ntitle: 冒烟\n---\n", "utf8");
  await fs.writeFile(path.join(dir, A + ".md"), nodeFile(A, "甲", null, "root", undefined, "甲正文。"), "utf8");
  await fs.writeFile(path.join(dir, B + ".md"), nodeFile(B, "乙", A, "next", "甲到乙", "乙正文。"), "utf8");
  await fs.writeFile(path.join(dir, C + ".md"), nodeFile(C, "丙", B, "next", "乙到丙", "丙正文。"), "utf8");
  handle = await startService({ root, port: await freePort() });
  expect(handle.url).toBeTruthy();
});

afterAll(async () => {
  await handle?.stop();
  await fs.rm(parent, { recursive: true, force: true });
});

describe("真实服务上的 batch／insert／whoami（CLI 与服务字段拼写一致）", () => {
  it("read refs → batch create + edit → insert → whoami 全链路", async () => {
    const read = await run(["read", "--node", A, "--node", B, "--node", C, "--workspace", root]);
    expect(read.code, read.stderr).toBe(0);
    const page = jsonOf(read.stdout);
    const refs = page["refs"] as Record<string, string>;
    expect(Object.keys(refs).sort()).toEqual([A, B, C].sort());

    const dir = path.join(parent, "batch");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "body.md"), "批量新卡正文。", "utf8");
    const batchPath = path.join(dir, "batch.json");
    await fs.writeFile(batchPath, JSON.stringify({
      topicId: TOPIC_ID,
      ops: [
        { op: "edit", target: { ref: refs[A] }, patch: { title: "甲（批量改标题）" } },
        { op: "create", as: "批量卡", from: { ref: refs[B] }, flow: "branch", title: "批量旁支", description: "批量旁支说明", bodyFile: "body.md", side: "right", order: 10 },
      ],
    }, null, 2), "utf8");
    const batch = await run(["batch", "--input", batchPath, "--workspace", root]);
    expect(batch.code, batch.stderr).toBe(0);
    const batchBody = jsonOf(batch.stdout);
    expect(batchBody["state"]).toBe("committed");
    const created = batchBody["created"] as Record<string, unknown>;
    expect((created["nodeIds"] as string[]).length).toBe(1);
    expect(batchBody["refs"]).toBeTruthy();
    const titleText = await fs.readFile(path.join(root, "topics", DIR, A + ".md"), "utf8");
    expect(titleText).toContain("title: 甲（批量改标题）");

    // insert 需要相邻 next：A→B 仍相邻（批量 create 是 branch）。
    const rerun = await run(["read", "--node", A, "--node", B, "--workspace", root]);
    const refs2 = jsonOf(rerun.stdout)["refs"] as Record<string, string>;
    const insert = await run([
      "insert",
      "--after-ref", refs2[A] as string,
      "--before-ref", refs2[B] as string,
      "--title", "插入卡",
      "--description", "甲到插入卡",
      "--next-description", "插入卡到乙",
      "--body", "插入卡正文。",
      "--workspace", root,
    ]);
    expect(insert.code, insert.stderr).toBe(0);
    const insertBody = jsonOf(insert.stdout);
    expect(insertBody["state"]).toBe("committed");
    const graph = (await (await fetch(handle.url + "/api/graph")).json()) as {
      nodes: Array<{ id: string; from: string | null; description?: string }>;
      topics: Array<{ nodeIds: string[] }>;
    };
    const all = JSON.stringify(graph);
    expect(all).toContain("甲到插入卡");
    expect(all).toContain("插入卡到乙");
    // description 写在 after→新卡的入边目标（新卡）上；nextDescription 写在 before 上。
    const newNodeId = ((insertBody["created"] as Record<string, unknown>)["nodeIds"] as string[])[0] as string;
    const nText = await fs.readFile(path.join(root, "topics", DIR, newNodeId + ".md"), "utf8");
    expect(nText).toContain("description: 甲到插入卡");
    expect(nText).toContain("from: " + A);
    const bText = await fs.readFile(path.join(root, "topics", DIR, B + ".md"), "utf8");
    expect(bText).toContain("description: 插入卡到乙");
    expect(bText).toContain("from: " + newNodeId);
    // 无临时旁支落盘：主题节点数 = 原 3 + 批量 branch 1 + 插入 1。
    const topicNodes = graph.topics.find((topic) => topic.nodeIds.includes(A));
    expect(topicNodes?.nodeIds.length).toBe(5);

    const who = await run(["whoami", "--workspace", root]);
    expect(who.code, who.stderr).toBe(0);
    const whoBody = jsonOf(who.stdout);
    expect(whoBody["ok"]).toBe(true);
    expect((whoBody["interface"] as Record<string, unknown>)["compatible"]).toBe(true);
    expect((whoBody["build"] as Record<string, unknown>)["same"]).toBe(true);
  }, 60000);
});
