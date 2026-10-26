/**
 * CLI 渐进读取（overview / structure / content）的端到端契约。
 *
 * 合成临时工作区 + 真实 startService + main CLI；覆盖默认视图、在线凭据、
 * 离线 envelope、预算分页、cursor 续读、过期检测与参数冲突。
 * 不接触真实资料，也不修改此前的旧读取测试。
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/cli/index.js";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";
import type {
  ReadContentItem,
  ReadOverviewItem,
  ReadStructureItem,
  ReadViewResponse,
} from "../../src/shared/protocol.js";

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
const BODY_R = "起点正文。" + LONG.repeat(180);
const BODY_N1 = "第二张正文。" + LONG.repeat(160);
const BODY_N2 = "第三张正文。" + LONG.repeat(150);
const BODY_B1N = "侧枝延续正文。" + LONG.repeat(170);
const BODY_B1 = "侧枝正文。" + LONG.repeat(4);
const BODY_B1B = "小分支正文。" + LONG.repeat(3);
const BODY_OR = "另一棵树。" + LONG.repeat(3);

const temporaryRoots: string[] = [];
const running: ServiceHandle[] = [];

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

async function newWorkspace(name = "cli-read-views"): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-read-views-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name });

  const mainDir = path.join(root, "topics", MAIN_DIR);
  await fs.mkdir(mainDir, { recursive: true });
  await fs.writeFile(
    path.join(mainDir, "topic.md"),
    "---\ntopicId: " + MAIN_TOPIC + "\ntitle: 主线主题\n---\n",
    "utf8",
  );
  const mainNodes = [
    { id: R, title: "起点", from: null, flow: "root" as const, body: BODY_R },
    {
      id: N1,
      title: "主线第二张",
      from: R,
      flow: "next" as const,
      description: "先从起点进入维护方式",
      body: BODY_N1,
    },
    {
      id: N2,
      title: "主线第三张",
      from: N1,
      flow: "next" as const,
      description: "沿主线继续",
      body: BODY_N2,
    },
    {
      id: B1,
      title: "起点侧枝",
      from: R,
      flow: "branch" as const,
      description: "从起点展开一条侧枝",
      side: "right" as const,
      order: 10,
      body: BODY_B1,
    },
    {
      id: B1N,
      title: "侧枝延续",
      from: B1,
      flow: "next" as const,
      description: "侧枝内部继续",
      body: BODY_B1N,
    },
    {
      id: B1B,
      title: "侧枝的小分支",
      from: B1,
      flow: "branch" as const,
      description: "侧枝内部再分出一条",
      side: "left" as const,
      order: 5,
      body: BODY_B1B,
    },
  ];
  for (const node of mainNodes) {
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
      body: BODY_OR,
    }),
    "utf8",
  );

  return fs.realpath(root);
}

async function start(root: string): Promise<ServiceHandle> {
  const handle = await startService({ root, port: await freePort() });
  running.push(handle);
  return handle;
}

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function cli(args: readonly string[], root: string): Promise<CliRun> {
  return main(["read", ...args, "--workspace", root]);
}

function payloadOf(result: CliRun): ReadViewResponse {
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ReadViewResponse;
}

function errorOf(result: CliRun): { code: string; message: string; details?: unknown } {
  const parsed = JSON.parse(result.stderr) as {
    error: { code: string; message: string; details?: unknown };
  };
  return parsed.error;
}

function idsOf(page: ReadViewResponse): string[] {
  return page.items.map((item) => ("node" in item ? item.node.id : item.id));
}

/** 跟随 cursor 直到结束；每页预算必须被遵守，记录顺序稳定且不重复。 */
async function collectPages(
  root: string,
  args: readonly string[],
  budget: number | undefined,
  offline = false,
): Promise<ReadViewResponse[]> {
  const budgetArgs = budget === undefined ? [] : ["--budget", String(budget)];
  const offlineArgs = offline ? ["--offline"] : [];
  const pages: ReadViewResponse[] = [];
  let result = await cli([...args, ...budgetArgs, ...offlineArgs], root);
  for (let index = 0; index < 100; index += 1) {
    const page = payloadOf(result);
    if (budget !== undefined) {
      // budget.used 与实际 stdout（紧凑 JSON + 换行）逐字符一致。
      expect(result.stdout.length).toBe(page.budget.used);
      expect(result.stdout.length).toBeLessThanOrEqual(budget);
    }
    pages.push(page);
    if (!page.page.hasMore) return pages;
    expect(page.page.next).toBeTruthy();
    result = await cli(
      [
        "--cursor",
        page.page.next as string,
        ...budgetArgs,
        ...offlineArgs,
      ],
      root,
    );
  }
  throw new Error("分页次数超出预期");
}

async function waitForRevision(baseUrl: string, previous: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(baseUrl + "/api/graph");
    const graph = (await response.json()) as { revision: number };
    if (graph.revision > previous) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("watcher 未在预期时间内发布新快照");
}

async function revisionOf(baseUrl: string): Promise<number> {
  const response = await fetch(baseUrl + "/api/graph");
  const graph = (await response.json()) as { revision: number };
  return graph.revision;
}

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("aichat read 渐进读取", () => {
  it("默认 overview：主线/直接 branch、subtree 数与 read 入口；大小预算都能覆盖导航记录", async () => {
    const root = await newWorkspace();
    await start(root);

    const defaultRun = await cli([MAIN_TOPIC], root);
    const payload = payloadOf(defaultRun);
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("read");
    expect(payload.view).toBe("overview");
    expect(payload.source).toBe("online");
    expect(payload.online.available).toBe(true);
    expect(payload.topicId).toBe(MAIN_TOPIC);
    expect(payload.topicTitle).toBe("主线主题");
    expect(payload.scope).toMatchObject({ kind: "topic", nodeCount: 6 });
    expect(payload.budget.limit).toBe(12000);
    expect(payload.budget.used).toBeLessThanOrEqual(12000);
    expect(defaultRun.stdout.length).toBe(payload.budget.used);
    expect(defaultRun.stdout.endsWith("\n")).toBe(true);
    expect(defaultRun.stdout.slice(0, -1)).not.toContain("\n");

    const items = payload.items as ReadOverviewItem[];
    expect(items.map((item) => item.role + ":" + item.id)).toEqual([
      "mainline:" + R,
      "branch:" + B1,
      "mainline:" + N1,
      "mainline:" + N2,
    ]);
    const branch = items.find((item) => item.id === B1);
    expect(branch).toMatchObject({
      role: "branch",
      subtreeNodeCount: 3,
      read: { view: "structure", from: B1 },
      description: "从起点展开一条侧枝",
    });

    // overview 不含正文、真实路径、哈希或凭据。
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain('"body"');
    expect(wire).not.toContain('"fileHash"');
    expect(wire).not.toContain('"editRef"');
    expect(wire).not.toContain('"path"');

    // 默认预算一次覆盖；小预算页也能无损覆盖同一批记录。
    const defaultPages = await collectPages(root, [MAIN_TOPIC], undefined);
    expect(defaultPages.flatMap(idsOf)).toEqual(items.map((item) => item.id));

    const smallPages = await collectPages(root, [MAIN_TOPIC], 1600);
    expect(smallPages.length).toBeGreaterThan(1);
    const pagedIds = smallPages.flatMap(idsOf);
    expect(pagedIds).toEqual(items.map((item) => item.id));
    expect(new Set(pagedIds).size).toBe(pagedIds.length);

    const text = await cli([MAIN_TOPIC, "--text"], root);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain("read overview");
    expect(text.stdout).toContain("mainline");
    expect(text.stdout).toContain("branch");
    expect(text.stdout).toContain(
      `read ${MAIN_TOPIC} --view structure --from ${B1}`,
    );
    expect(text.stdout).not.toContain(BODY_R.slice(0, 20));
  });

  it("structure：真实记录、子树边界、无正文/路径/哈希/凭据，并可分页", async () => {
    const root = await newWorkspace();
    await start(root);

    const topicPage = payloadOf(
      await cli([MAIN_TOPIC, "--view", "structure", "--budget", "20000"], root),
    );
    expect(topicPage.view).toBe("structure");
    expect(topicPage.scope).toMatchObject({ kind: "topic", nodeCount: 6 });
    expect(topicPage.boundaries).toBeUndefined();
    const topicItems = topicPage.items as ReadStructureItem[];
    expect(new Set(topicItems.map((item) => item.id))).toEqual(
      new Set([R, N1, N2, B1, B1N, B1B]),
    );
    expect(topicItems.find((item) => item.id === B1)).toMatchObject({
      from: R,
      flow: "branch",
      side: "right",
      order: 10,
      description: "从起点展开一条侧枝",
    });
    const topicWire = JSON.stringify(topicPage);
    expect(topicWire).not.toContain('"body"');
    expect(topicWire).not.toContain('"fileHash"');
    expect(topicWire).not.toContain('"editRef"');
    expect(topicWire).not.toContain('"path"');

    const subtree = payloadOf(
      await cli(
        [MAIN_TOPIC, "--view", "structure", "--from", B1, "--budget", "20000"],
        root,
      ),
    );
    expect(subtree.scope).toMatchObject({ kind: "subtree", from: B1, nodeCount: 3 });
    expect(new Set(idsOf(subtree))).toEqual(new Set([B1, B1B, B1N]));
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
      root,
      [MAIN_TOPIC, "--view", "structure"],
      1600,
    );
    expect(pages.length).toBeGreaterThan(1);
    const pagedIds = pages.flatMap(idsOf);
    expect(new Set(pagedIds)).toEqual(new Set(topicItems.map((item) => item.id)));
    expect(new Set(pagedIds).size).toBe(pagedIds.length);

    const text = await cli(
      [MAIN_TOPIC, "--view", "structure", "--from", B1, "--text"],
      root,
    );
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain("boundary " + R + " -> " + B1);
    expect(text.stdout).toContain(B1);
    expect(text.stdout).toContain(B1N);
  });

  it("content：小预算跟随 --cursor 覆盖全部正文；在线 refs，离线为空", async () => {
    const root = await newWorkspace();
    await start(root);

    const requested = [B1N, R, N2];
    const args = requested.flatMap((id) => ["--node", id]);
    const onlinePages = await collectPages(root, args, 4000);
    expect(onlinePages.length).toBeGreaterThan(1);

    const collected = new Map<string, string>();
    for (const page of onlinePages) {
      expect(page.view).toBe("content");
      expect(page.source).toBe("online");
      for (const item of page.items as ReadContentItem[]) {
        const id = item.node.id;
        const before = collected.get(id) ?? "";
        expect(item.range.start).toBe(before.length);
        expect(item.range.end).toBe(item.range.start + item.body.length);
        // 凭据统一在顶层 refs；content item 不再内嵌 editRef。
        expect(item).not.toHaveProperty("editRef");
        expect(page.refs[id]).toMatch(/^er_/);
        collected.set(id, before + item.body);
      }
    }
    expect([...collected.keys()]).toEqual(requested);
    expect(collected.get(R)).toBe(BODY_R);
    expect(collected.get(N2)).toBe(BODY_N2);
    expect(collected.get(B1N)).toBe(BODY_B1N);

    const offlinePages = await collectPages(root, args, 4000, true);
    expect(offlinePages.length).toBeGreaterThan(1);
    const offlineCollected = new Map<string, string>();
    for (const page of offlinePages) {
      expect(page.source).toBe("disk");
      expect(page.online).toMatchObject({
        available: false,
        code: "OFFLINE_REQUESTED",
      });
      expect(page.refs).toEqual({});
      for (const item of page.items as ReadContentItem[]) {
        expect(item).not.toHaveProperty("editRef");
        const before = offlineCollected.get(item.node.id) ?? "";
        expect(item.range.start).toBe(before.length);
        offlineCollected.set(item.node.id, before + item.body);
      }
    }
    expect(offlineCollected.get(R)).toBe(BODY_R);
    expect(offlineCollected.get(N2)).toBe(BODY_N2);
    expect(offlineCollected.get(B1N)).toBe(BODY_B1N);

    // 没有服务时回退磁盘，并在 envelope 中给出实际原因。
    const offlineRoot = await newWorkspace("cli-read-views-noservice");
    const fallback = payloadOf(
      await cli(["--node", R, "--node", N1, "--budget", "4000"], offlineRoot),
    );
    expect(fallback.source).toBe("disk");
    expect(fallback.online.available).toBe(false);
    if (fallback.online.available) throw new Error("expected offline");
    expect(fallback.online.code).toBe("SERVICE_NOT_RUNNING");
    expect(fallback.online.reason).toBeTruthy();
    expect(fallback.refs).toEqual({});
    for (const item of fallback.items as ReadContentItem[]) {
      expect(item).not.toHaveProperty("editRef");
    }
  });

  it("--meta 多卡跨页仍省略正文且有 refs；显式 --full/--length 超小预算返回 BUDGET_EXCEEDED", async () => {
    const root = await newWorkspace();
    await start(root);

    const requested = [R, N1, B1N];
    const args = requested.flatMap((id) => ["--node", id]);
    const metaPages = await collectPages(root, [...args, "--meta"], 2600);
    expect(metaPages.length).toBeGreaterThan(1);
    const ids: string[] = [];
    for (const page of metaPages) {
      for (const item of page.items as ReadContentItem[]) {
        ids.push(item.node.id);
        expect(item.bodyOmitted).toBe(true);
        expect(item.body).toBe("");
        expect(item.truncated).toBe(false);
        expect(item.range.start).toBe(0);
        expect(item.range.end).toBe(0);
        expect(item.range.total).toBeGreaterThan(0);
        expect(page.refs[item.node.id]).toMatch(/^er_/);
      }
    }
    expect(ids).toEqual(requested);

    for (const extra of [
      ["--full"],
      ["--length", "5000"],
    ]) {
      const result = await cli(["--node", R, ...extra, "--budget", "300"], root);
      expect(result.exitCode, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
      const error = errorOf(result);
      expect(error.code).toBe("BUDGET_EXCEEDED");
      expect(error.message).toContain("budget");
      expect(result.stderr).not.toContain('"items"');

      // 离线引擎走同一退出码与错误码，不回退成半份正文。
      const offline = await cli(
        ["--node", R, ...extra, "--budget", "300", "--offline"],
        root,
      );
      expect(offline.exitCode, offline.stderr).toBe(2);
      expect(errorOf(offline).code).toBe("BUDGET_EXCEEDED");
    }
  });

  it("相关节点变化后 cursor → 409 STALE_READ（退出码 5）", async () => {
    const root = await newWorkspace();
    const handle = await start(root);

    const first = payloadOf(
      await cli(["--node", R, "--node", N1, "--budget", "3000"], root),
    );
    expect(first.page.hasMore).toBe(true);
    const cursor = first.page.next as string;

    const before = await revisionOf(handle.url);
    const nodePath = path.join(root, "topics", MAIN_DIR, R + ".md");
    const original = await fs.readFile(nodePath, "utf8");
    await fs.writeFile(
      nodePath,
      original.replace("起点正文。", "起点正文（外部改动）。"),
      "utf8",
    );
    await waitForRevision(handle.url, before);

    const stale = await cli(["--cursor", cursor, "--budget", "3000"], root);
    expect(stale.exitCode, stale.stderr).toBe(5);
    expect(stale.stdout).toBe("");
    const error = errorOf(stale);
    expect(error.code).toBe("STALE_READ");
    expect(error.message).toContain("重新读取");
    expect(error.details).toBeDefined();
  });

  it("参数冲突、content 无 node、overview 带 node、meta/heading 冲突与非法预算 → 退出码 2", async () => {
    const root = await newWorkspace();

    const cases: Array<{ args: string[]; messageIncludes?: string }> = [
      { args: [MAIN_TOPIC, "--cursor", "abc"] },
      { args: ["--cursor", "abc", "--node", R] },
      { args: ["--cursor", "abc", "--view", "overview"] },
      { args: ["--cursor", "abc", "--offline", "--from", R] },
      { args: [MAIN_TOPIC, "--view", "content"], messageIncludes: "--node" },
      { args: [MAIN_TOPIC, "--view", "overview", "--node", R] },
      { args: ["--node", R, "--from", N1] },
      { args: ["--node", R, "--meta", "--length", "10"], messageIncludes: "--meta" },
      { args: ["--node", R, "--occurrence", "0"], messageIncludes: "--from-heading" },
      { args: [MAIN_TOPIC, "--view", "structure", "--start", "0"] },
      { args: [MAIN_TOPIC, "--budget", "0"] },
      { args: [MAIN_TOPIC, "--budget", "1000001"] },
      { args: [MAIN_TOPIC, "--view", "bogus"] },
      { args: ["--node", R, "--budget", "1"] },
      { args: [] },
    ];

    for (const entry of cases) {
      const result = await cli(entry.args, root);
      expect(result.exitCode, entry.args.join(" ")).toBe(2);
      expect(result.stdout).toBe("");
      const error = errorOf(result);
      if (entry.messageIncludes !== undefined) {
        expect(error.message, entry.args.join(" ")).toContain(entry.messageIncludes);
      }
    }
  });

  it("离线工作区无效时返回带 diagnostics 的错误（退出码 6），不伪造图", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-read-views-bad-"));
    temporaryRoots.push(parent);
    const root = path.join(parent, "workspace");
    await initWorkspace({ root, name: "bad-workspace" });
    const dir = path.join(root, "topics", "坏图");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "topic.md"),
      "---\ntopicId: " + MAIN_TOPIC + "\ntitle: 坏图\n---\n",
      "utf8",
    );
    // 同一主题两个 root：core 判定 NODE_ROOT_MULTIPLE，有效图为空。
    for (const id of [R, N1]) {
      await fs.writeFile(
        path.join(dir, id + ".md"),
        nodeFile({ nodeId: id, title: "重复根", from: null, flow: "root", body: "正文。" }),
        "utf8",
      );
    }

    for (const args of [
      ["--node", R, "--offline"],
      [MAIN_TOPIC, "--offline"],
    ]) {
      const result = await cli(args, root);
      expect(result.exitCode, result.stderr).toBe(6);
      expect(result.stdout).toBe("");
      const parsed = JSON.parse(result.stderr) as {
        error: { code: string; diagnostics?: unknown[] };
      };
      expect(parsed.error.code).toBe("WORKSPACE_INVALID");
      expect(Array.isArray(parsed.error.diagnostics)).toBe(true);
      expect((parsed.error.diagnostics ?? []).length).toBeGreaterThan(0);
    }
  });
});
