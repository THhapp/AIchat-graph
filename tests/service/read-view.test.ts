/**
 * GET /api/agent/read 的服务级契约：
 * 真实工作区 + 真实 startService/fetch，覆盖三种视图、预算分页、editRef、
 * cursor 失效与参数边界。
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type {
  ReadContentItem,
  ReadOverviewItem,
  ReadStructureItem,
  ReadViewResponse,
} from "../../src/shared/protocol.js";

const temporaryRoots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

const MAIN_TOPIC = "t_" + "1".repeat(32);
const MAIN_DIR = "主线";
const R = "n_" + "1".repeat(32);
const N1 = "n_" + "2".repeat(32);
const N2 = "n_" + "3".repeat(32);
const B1 = "n_" + "4".repeat(32);
const B1N = "n_" + "5".repeat(32);
const B1B = "n_" + "6".repeat(32);

const OTHER_TOPIC = "t_" + "7".repeat(32);
const OTHER_DIR = "旁支";
const OR = "n_" + "8".repeat(32);

const LONG = "这一段用于填充正文，让预算分页能够看到真实的切片与续读。";

function nodeFile(options: {
  nodeId: string;
  title: string;
  from: string | null;
  flow: "root" | "next" | "branch";
  description?: string;
  side?: "left" | "right";
  order?: number;
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
  if (options.side !== undefined) lines.push("side: " + options.side);
  if (options.order !== undefined) lines.push("order: " + String(options.order));
  lines.push("---", "", options.body, "");
  return lines.join("\n");
}

async function newWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-read-view-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "read-view-test" });

  const mainDir = path.join(root, "topics", MAIN_DIR);
  await fs.mkdir(mainDir, { recursive: true });
  await fs.writeFile(
    path.join(mainDir, "topic.md"),
    "---\ntopicId: " + MAIN_TOPIC + "\ntitle: 主线主题\n---\n",
    "utf8",
  );
  const nodes: Array<{
    id: string;
    title: string;
    from: string | null;
    flow: "root" | "next" | "branch";
    description?: string;
    side?: "left" | "right";
    order?: number;
    body: string;
  }> = [
    {
      id: R,
      title: "起点",
      from: null,
      flow: "root",
      body: "起点正文。" + LONG.repeat(6),
    },
    {
      id: N1,
      title: "主线第二张",
      from: R,
      flow: "next",
      description: "先从起点进入维护方式",
      body: "第二张正文。" + LONG.repeat(7),
    },
    {
      id: N2,
      title: "主线第三张",
      from: N1,
      flow: "next",
      description: "沿主线继续",
      body: "第三张正文。" + LONG.repeat(5),
    },
    {
      id: B1,
      title: "起点侧枝",
      from: R,
      flow: "branch",
      description: "从起点展开一条侧枝",
      side: "right",
      order: 10,
      body: "侧枝正文。" + LONG.repeat(4),
    },
    {
      id: B1N,
      title: "侧枝延续",
      from: B1,
      flow: "next",
      description: "侧枝内部继续",
      body: "侧枝延续正文。" + LONG.repeat(6),
    },
    {
      id: B1B,
      title: "侧枝的小分支",
      from: B1,
      flow: "branch",
      description: "侧枝内部再分出一条",
      side: "left",
      order: 5,
      body: "小分支正文。" + LONG.repeat(3),
    },
  ];
  for (const node of nodes) {
    await fs.writeFile(
      path.join(mainDir, node.id + ".md"),
      nodeFile({
        nodeId: node.id,
        title: node.title,
        from: node.from,
        flow: node.flow,
        ...(node.description !== undefined ? { description: node.description } : {}),
        ...(node.side !== undefined ? { side: node.side } : {}),
        ...(node.order !== undefined ? { order: node.order } : {}),
        body: node.body,
      }),
      "utf8",
    );
  }

  const otherDir = path.join(root, "topics", OTHER_DIR);
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(
    path.join(otherDir, "topic.md"),
    "---\ntopicId: " + OTHER_TOPIC + "\ntitle: 另一主题\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(otherDir, OR + ".md"),
    nodeFile({
      nodeId: OR,
      title: "另一主题的起点",
      from: null,
      flow: "root",
      body: "另一棵树。" + LONG.repeat(2),
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
      const value = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(value));
    });
  });
}

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

interface JsonResult<T> {
  status: number;
  body: T;
}

async function getJson<T>(url: string): Promise<JsonResult<T>> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as T };
}

function readUrl(url: string, query: string): string {
  return url + "/api/agent/read?" + query;
}

function pageUrl(base: string, budget: number): string {
  return base + (base.includes("?") ? "&" : "?") + "budget=" + String(budget);
}

function cursorUrl(url: string, budget: number, cursor: string): string {
  // cursor 已包含 view/scope/topic/meta；续读只允许另带 budget。
  return url + "/api/agent/read?budget=" + String(budget) +
    "&cursor=" + encodeURIComponent(cursor);
}

/** 跟随 page.next 直到结束；每页预算必须被遵守。 */
async function collectPages(base: string, budget: number): Promise<ReadViewResponse[]> {
  const pages: ReadViewResponse[] = [];
  const url = new URL(base).origin;
  let cursor: string | undefined;
  for (let index = 0; index < 100; index += 1) {
    const result = await getJson<ReadViewResponse>(
      cursor === undefined ? pageUrl(base, budget) : cursorUrl(url, budget, cursor),
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const page = result.body;
    expect(page.budget.used).toBeLessThanOrEqual(budget);
    expect(JSON.stringify(page).length).toBe(page.budget.used);
    pages.push(page);
    if (!page.page.hasMore) return pages;
    expect(page.page.next).toBeTruthy();
    cursor = page.page.next;
  }
  throw new Error("分页次数超出预期");
}

async function waitForRevision(url: string, previous: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const graph = await getJson<{ revision: number }>(url + "/api/graph");
    if (graph.body.revision > previous) return graph.body.revision;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("watcher 未在预期时间内发布新快照");
}

function itemIds(response: ReadViewResponse): string[] {
  return response.items.map((item) => {
    if ("node" in item) return item.node.id;
    return item.id;
  });
}

describe("GET /api/agent/read", () => {
  it("overview：主线与直接分支入口、subtree 计数、read 入口与预算分页", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const full = await getJson<ReadViewResponse>(
      readUrl(handle.url, "topic=" + MAIN_TOPIC + "&budget=20000"),
    );
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    const body = full.body;
    expect(body.ok).toBe(true);
    expect(body.command).toBe("read");
    expect(body.view).toBe("overview");
    expect(body.source).toBe("online");
    expect(body.online).toMatchObject({
      available: true,
      instanceId: handle.instanceId,
      workspaceId: handle.workspaceId,
    });
    expect(body.topicId).toBe(MAIN_TOPIC);
    expect(body.topicTitle).toBe("主线主题");
    expect(body.scope).toMatchObject({ kind: "topic", nodeCount: 6 });
    expect(body.page.hasMore).toBe(false);
    expect(body.budget.used).toBe(JSON.stringify(body).length);

    const items = body.items as ReadOverviewItem[];
    expect(items.map((item) => item.role + ":" + item.id)).toEqual([
      "mainline:" + R,
      "branch:" + B1,
      "mainline:" + N1,
      "mainline:" + N2,
    ]);
    const branch = items.find((item) => item.id === B1);
    expect(branch).toBeDefined();
    expect(branch?.subtreeNodeCount).toBe(3);
    expect(branch?.read).toEqual({ view: "structure", from: B1 });
    expect(branch?.description).toBe("从起点展开一条侧枝");

    // overview 不携带正文、真实路径、哈希或凭据。
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('"body"');
    expect(wire).not.toContain('"fileHash"');
    expect(wire).not.toContain('"editRef"');
    expect(wire).not.toContain('"path"');

    const pages = await collectPages(readUrl(handle.url, "topic=" + MAIN_TOPIC), 1600);
    expect(pages.length).toBeGreaterThan(1);
    const pagedIds = pages.flatMap((page) => itemIds(page));
    expect(pagedIds).toEqual(items.map((item) => item.id));
    expect(new Set(pagedIds).size).toBe(pagedIds.length);
  });

  it("structure：主题与 subtree 字段、边界连接、无正文与凭据、分页", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const topicResult = await getJson<ReadViewResponse>(
      readUrl(
        handle.url,
        "view=structure&topic=" + MAIN_TOPIC + "&budget=20000",
      ),
    );
    expect(topicResult.status, JSON.stringify(topicResult.body)).toBe(200);
    const topicBody = topicResult.body;
    expect(topicBody.view).toBe("structure");
    expect(topicBody.scope).toMatchObject({ kind: "topic", nodeCount: 6 });
    expect(topicBody.boundaries).toBeUndefined();
    const topicItems = topicBody.items as ReadStructureItem[];
    expect(new Set(topicItems.map((item) => item.id))).toEqual(
      new Set([R, N1, N2, B1, B1N, B1B]),
    );
    const branchEntry = topicItems.find((item) => item.id === B1);
    expect(branchEntry).toMatchObject({
      from: R,
      flow: "branch",
      side: "right",
      order: 10,
      description: "从起点展开一条侧枝",
    });
    const wire = JSON.stringify(topicBody);
    expect(wire).not.toContain('"body"');
    expect(wire).not.toContain('"fileHash"');
    expect(wire).not.toContain('"editRef"');
    expect(wire).not.toContain('"path"');

    const subtreeResult = await getJson<ReadViewResponse>(
      readUrl(
        handle.url,
        "view=structure&topic=" + MAIN_TOPIC + "&from=" + B1 + "&budget=20000",
      ),
    );
    expect(subtreeResult.status, JSON.stringify(subtreeResult.body)).toBe(200);
    const subtree = subtreeResult.body;
    expect(subtree.scope).toMatchObject({ kind: "subtree", from: B1, nodeCount: 3 });
    expect(new Set(itemIds(subtree))).toEqual(new Set([B1, B1B, B1N]));
    expect(subtree.boundaries).toEqual([
      {
        from: R,
        to: B1,
        flow: "branch",
        description: "从起点展开一条侧枝",
        external: { id: R, title: "起点", topicId: MAIN_TOPIC },
      },
    ]);
    expect(JSON.stringify(subtree)).not.toContain('"editRef"');

    const pages = await collectPages(
      readUrl(handle.url, "view=structure&topic=" + MAIN_TOPIC),
      1600,
    );
    expect(pages.length).toBeGreaterThan(1);
    const pagedIds = pages.flatMap((page) => itemIds(page));
    expect(pagedIds).toEqual(topicItems.map((item) => item.id));
    expect(new Set(pagedIds).size).toBe(pagedIds.length);
  });

  it("content：多节点小预算分页覆盖全部正文、不重复，在线 editRef 逐项绑定", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    // 请求顺序保留、重复 node 去重。
    const requested = [N1, R, N2, B1N, B1B];
    const nodesQuery = requested.map((id) => "node=" + id).join("&");
    const base = readUrl(
      handle.url,
      "view=content&topic=" + MAIN_TOPIC + "&" + nodesQuery,
    );
    const pages = await collectPages(base, 4000);
    expect(pages.length).toBeGreaterThan(1);

    const collected = new Map<string, { text: string; total: number; path: string; fileHash: string }>();
    let itemCount = 0;
    for (const page of pages) {
      expect(page.view).toBe("content");
      expect(page.source).toBe("online");
      expect(page.topicId).toBe(MAIN_TOPIC);
      for (const item of page.items as ReadContentItem[]) {
        itemCount += 1;
        const id = item.node.id;
        const entry = collected.get(id) ?? { text: "", total: 0, path: item.path, fileHash: item.fileHash };
        // 续读从上一片段末尾开始：既无重复也没有缺口。
        expect(item.range.start).toBe(entry.text.length);
        expect(item.range.unit).toBe("utf16");
        expect(item.range.end).toBe(item.range.start + item.body.length);
        expect(item.path).toMatch(/^topics\//);
        expect(item.fileHash).toHaveLength(64);
        expect(item.editRef).not.toBeNull();
        expect(item.editRef?.nodeId).toBe(id);
        expect(item.editRef?.path).toBe(item.path);
        expect(item.editRef?.fileHash).toBe(item.fileHash);
        expect(item.editRef?.instanceId).toBe(handle.instanceId);
        if (page.online.available) expect(item.editRef?.revision).toBe(page.online.revision);
        entry.text += item.body;
        entry.total = item.range.total;
        collected.set(id, entry);
      }
    }

    expect(itemCount).toBeGreaterThanOrEqual(requested.length);
    expect([...collected.keys()]).toEqual(requested);
    for (const id of requested) {
      const entry = collected.get(id);
      expect(entry).toBeDefined();
      expect(entry?.text.length).toBe(entry?.total);
      const full = await getJson<{ body: string }>(
        handle.url + "/api/agent/nodes/" + id + "?full=true",
      );
      expect(entry?.text).toBe(full.body.body);
    }

    // 重复 node：只保留第一次出现，顺序不变。
    const dedup = await getJson<ReadViewResponse>(
      readUrl(
        handle.url,
        "view=content&topic=" + MAIN_TOPIC + "&node=" + N1 + "&node=" + R + "&node=" + N1 + "&budget=30000",
      ),
    );
    expect(dedup.status, JSON.stringify(dedup.body)).toBe(200);
    expect(dedup.body.items.map((item) => (item as ReadContentItem).node.id)).toEqual([N1, R]);
  });

  it("content 显式切片/全文超预算 → BUDGET_EXCEEDED；meta 自动分页仍省略正文且有 editRef", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    for (const query of [
      "view=content&node=" + R + "&length=5&budget=300",
      "view=content&node=" + R + "&full=true&budget=300",
    ]) {
      const result = await getJson<{ error: { code: string; message: string; details?: unknown } }>(
        readUrl(handle.url, query),
      );
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("BUDGET_EXCEEDED");
      const details = result.body.error.details as { limit: number; required: number };
      expect(details.limit).toBe(300);
      expect(details.required).toBeGreaterThan(300);
    }

    const requested = [R, N1, N2, B1N, B1B];
    const metaQuery =
      "view=content&topic=" + MAIN_TOPIC + "&meta=true&" +
      requested.map((id) => "node=" + id).join("&");
    const pages = await collectPages(readUrl(handle.url, metaQuery), 3200);
    expect(pages.length).toBeGreaterThan(1);
    const ids: string[] = [];
    for (const page of pages) {
      for (const item of page.items as ReadContentItem[]) {
        ids.push(item.node.id);
        expect(item.bodyOmitted).toBe(true);
        expect(item.body).toBe("");
        expect(item.truncated).toBe(false);
        expect(item.range.start).toBe(0);
        expect(item.range.end).toBe(0);
        expect(item.range.total).toBeGreaterThan(0);
        expect(item.editRef).not.toBeNull();
        expect(item.editRef?.nodeId).toBe(item.node.id);
      }
    }
    expect(ids).toEqual(requested);
  });

  it("cursor 过期：相关节点变化 → 409 STALE_READ；无关主题变化不失效", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const requested = [R, N1, N2, B1N, B1B];
    const base = readUrl(
      handle.url,
      "view=content&topic=" + MAIN_TOPIC + "&" +
        requested.map((id) => "node=" + id).join("&"),
    );
    const first = await getJson<ReadViewResponse>(pageUrl(base, 3500));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.page.hasMore).toBe(true);
    const staleCursor = first.body.page.next as string;

    const before = await getJson<{ revision: number }>(handle.url + "/api/graph");
    const nodePath = path.join(root, "topics", MAIN_DIR, R + ".md");
    const original = await fs.readFile(nodePath, "utf8");
    await fs.writeFile(nodePath, original.replace("起点正文。", "起点正文（外部改动）。"), "utf8");
    await waitForRevision(handle.url, before.body.revision);

    const stale = await getJson<{ error: { code: string; message: string; details?: unknown } }>(
      cursorUrl(handle.url, 3500, staleCursor),
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("STALE_READ");
    expect(stale.body.error.message).toContain("重新读取");
    expect(stale.body.error.details).toBeDefined();

    // 重新读取拿到的新 token；此后只改另一个主题，不应让该 token 失效。
    const fresh = await getJson<ReadViewResponse>(pageUrl(base, 3500));
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.page.hasMore).toBe(true);
    const unrelatedCursor = fresh.body.page.next as string;

    const revisionBeforeOther = await getJson<{ revision: number }>(handle.url + "/api/graph");
    const otherPath = path.join(root, "topics", OTHER_DIR, OR + ".md");
    const otherText = await fs.readFile(otherPath, "utf8");
    await fs.writeFile(otherPath, otherText.replace("另一棵树。", "另一棵树，外部改过了。"), "utf8");
    await waitForRevision(handle.url, revisionBeforeOther.body.revision);

    const unaffected = await getJson<ReadViewResponse>(
      cursorUrl(handle.url, 3500, unrelatedCursor),
    );
    expect(unaffected.status, JSON.stringify(unaffected.body)).toBe(200);
    expect(unaffected.body.ok).toBe(true);
    expect(unaffected.body.view).toBe("content");
  });

  it("非法参数、跨主题集合、缺失范围与 cursor 冲突返回明确的 400/404/409", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    async function errorOf(
      query: string,
    ): Promise<{ status: number; code: string; message: string }> {
      const result = await getJson<{ error: { code: string; message: string } }>(
        readUrl(handle.url, query),
      );
      return { status: result.status, code: result.body.error.code, message: result.body.error.message };
    }

    const invalidCursor = await errorOf("cursor=not-a-cursor");
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.code).toBe("INVALID_CURSOR");

    const cursorConflict = await errorOf("cursor=abc&view=overview");
    expect(cursorConflict.status).toBe(400);

    const missingTopic = await errorOf("view=overview&topic=t_" + "f".repeat(32));
    expect(missingTopic.status).toBe(404);
    expect(missingTopic.code).toBe("TOPIC_NOT_FOUND");
    expect(missingTopic.message).toContain("t_" + "f".repeat(32));

    const missingNode = await errorOf("node=n_" + "f".repeat(32));
    expect(missingNode.status).toBe(404);
    expect(missingNode.code).toBe("NODE_NOT_FOUND");
    expect(missingNode.message).toContain("n_" + "f".repeat(32));

    const crossTopic = await errorOf("view=content&node=" + R + "&node=" + OR);
    expect(crossTopic.status).toBe(400);
    expect(crossTopic.code).toBe("INVALID_SCOPE");
    expect(crossTopic.message).toContain(R);
    expect(crossTopic.message).toContain(OR);

    const wrongTopic = await errorOf(
      "view=content&topic=" + OTHER_TOPIC + "&node=" + R,
    );
    expect(wrongTopic.status).toBe(400);
    expect(wrongTopic.code).toBe("INVALID_SCOPE");
    expect(wrongTopic.message).toContain(R);

    const metaConflict = await errorOf(
      "view=content&node=" + R + "&meta=true&length=5",
    );
    expect(metaConflict.status).toBe(400);
    expect(metaConflict.message).toContain("meta=true");

    const loneIndex = await errorOf("view=content&node=" + R + "&section-index=1");
    expect(loneIndex.status).toBe(400);
    expect(loneIndex.message).toContain("section-index");

    const overviewWithNode = await errorOf(
      "view=overview&topic=" + MAIN_TOPIC + "&node=" + R,
    );
    expect(overviewWithNode.status).toBe(400);

    const contentWithFrom = await errorOf("view=content&node=" + R + "&from=" + N1);
    expect(contentWithFrom.status).toBe(400);

    const missingTopicParam = await errorOf("view=overview");
    expect(missingTopicParam.status).toBe(400);
    const missingNodeParam = await errorOf("view=content&topic=" + MAIN_TOPIC);
    expect(missingNodeParam.status).toBe(400);
    const badBudget = await errorOf("topic=" + MAIN_TOPIC + "&budget=1000001");
    expect(badBudget.status).toBe(400);
    expect(badBudget.message).toContain("budget");

    const diskCursor = Buffer.from(
      JSON.stringify({
        version: 1,
        mode: "disk",
        workspaceId: handle.workspaceId,
        topicId: MAIN_TOPIC,
        view: "overview",
        scope: { kind: "topic" },
        fingerprint: "deadbeef",
        offset: 0,
      }),
      "utf8",
    ).toString("base64url");
    const diskResult = await errorOf("cursor=" + encodeURIComponent(diskCursor));
    expect(diskResult.status).toBe(409);
    expect(diskResult.code).toBe("STALE_READ");
    expect(diskResult.message).toContain("在线");
  });
});
