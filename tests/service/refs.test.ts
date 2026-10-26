/**
 * read refs 的服务级契约：顶层统一位置、只覆盖当前页、参与序列化/预算、
 * 离线（磁盘）为空，以及刷新凭据可直接用于后续写入。
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type { AgentChangeResponse, ReadContentItem, ReadViewResponse } from "../../src/shared/protocol.js";

const temporaryRoots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

const TOPIC = "t_" + "1".repeat(32);
const DIR = "主线";
const R = "n_" + "1".repeat(32);
const A = "n_" + "2".repeat(32);
const B = "n_" + "3".repeat(32);
const C = "n_" + "4".repeat(32);

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

async function newWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-refs-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "refs-test" });
  const dir = path.join(root, "topics", DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "topic.md"),
    "---\ntopicId: " + TOPIC + "\ntitle: 主线主题\n---\n",
    "utf8",
  );
  const nodes: Array<[string, string | null, "root" | "next", string, string]> = [
    [R, null, "root", "起点", "起点正文。"],
    [A, R, "next", "第二张", "第二张正文。"],
    [B, A, "next", "第三张", "第三张正文。"],
    [C, B, "next", "第四张", "第四张正文。"],
  ];
  for (const [id, from, flow, title, body] of nodes) {
    await fs.writeFile(
      path.join(dir, id + ".md"),
      nodeFile({
        nodeId: id,
        title,
        from,
        flow,
        ...(from === null ? {} : { description: "从 " + from + " 继续" }),
        body,
      }),
      "utf8",
    );
  }
  return fs.realpath(root);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const value = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(value));
    });
  });
}

async function readView(url: string, query: string): Promise<{ status: number; body: ReadViewResponse }> {
  const response = await fetch(url + "/api/agent/read?" + query);
  return { status: response.status, body: (await response.json()) as ReadViewResponse };
}

function agentHeaders(): Record<string, string> {
  return { "content-type": "application/json", "x-aichat-client": "cli" };
}

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("read refs 顶层统一位置", () => {
  it("content 页 refs 只覆盖本页节点，且参与最终序列化与 budget.used", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const pages: ReadViewResponse[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query =
        cursor === undefined
          ? "view=content&topic=" +
            TOPIC +
            "&" +
            [R, A, B, C].map((id) => "node=" + id).join("&") +
            "&meta=true&budget=2000"
          : "budget=2000&cursor=" + encodeURIComponent(cursor);
      const result = await readView(handle.url, query);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const body = result.body;
      // refs 与序列化同源：预算增量必须等于真实线上响应长度。
      expect(body.budget.used).toBe(JSON.stringify(body).length + 1);
      expect(JSON.stringify(body).length + 1).toBeLessThanOrEqual(body.budget.limit);
      const items = body.items as ReadContentItem[];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item).not.toHaveProperty("editRef");
        expect(body.refs[item.node.id]).toMatch(/^er_/);
      }
      // 只覆盖当前页：keys 恰好是本页出现的节点，不携带旧页凭据。
      expect(Object.keys(body.refs).sort()).toEqual(
        [...new Set(items.map((item) => item.node.id))].sort(),
      );
      pages.push(body);
      if (!body.page.hasMore) break;
      cursor = body.page.next as string;
    }
    expect(pages.length).toBeGreaterThan(1);
    const pageIds = pages.map((page) => page.items.map((item) => (item as ReadContentItem).node.id));
    // 每页一个节点：旧页凭据不泄漏到后面的页。
    expect(new Set(pageIds.map((ids) => ids.join(","))).size).toBe(pageIds.length);
  });

  it("overview/structure 顶层 refs 是空对象；离线磁盘读取同样为空（CLI 侧用同一引擎）", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    for (const query of [
      "view=overview&topic=" + TOPIC + "&budget=40000",
      "view=structure&topic=" + TOPIC + "&budget=40000",
    ]) {
      const result = await readView(handle.url, query);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.refs).toEqual({});
      expect(result.body.budget.used).toBe(JSON.stringify(result.body).length + 1);
    }
  });

  it("content 的 refs 可直接用于后续写入，写后返回刷新凭据", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const first = await readView(
      handle.url,
      "view=content&topic=" + TOPIC + "&node=" + A + "&budget=20000",
    );
    expect(first.status).toBe(200);
    const firstToken = first.body.refs[A] as string;
    expect(firstToken).toMatch(/^er_/);

    const write = await fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: randomUUID(),
        action: { action: "patchNode", editRef: firstToken, append: "读取凭据直接追加。" },
      }),
    });
    expect(write.status).toBe(200);
    const writeBody = (await write.json()) as AgentChangeResponse;
    expect(writeBody.refs[A]).toMatch(/^er_/);
    expect(writeBody.refs[A]).not.toBe(firstToken);

    // 刷新凭据继续改；旧凭据统计为过期（源文件已被改写）。
    const again = await fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: randomUUID(),
        action: { action: "patchNode", editRef: writeBody.refs[A] as string, append: "再追加一次。" },
      }),
    });
    expect(again.status).toBe(200);
    const stale = await fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: randomUUID(),
        action: { action: "patchNode", editRef: firstToken, append: "旧凭据不应写入。" },
      }),
    });
    expect(stale.status).toBe(412);
    const text = await fs.readFile(path.join(root, "topics", DIR, A + ".md"), "utf8");
    expect(text).toContain("读取凭据直接追加。");
    expect(text).toContain("再追加一次。");
    expect(text).not.toContain("旧凭据不应写入。");
  });
});
