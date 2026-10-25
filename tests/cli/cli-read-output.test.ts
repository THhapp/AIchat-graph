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
  ReadViewResponse,
} from "../../src/shared/protocol.js";

/**
 * read --node 的统一输出：在线与离线同形状；meta／section／多卡预算。
 * 全部使用合成临时工作区与真实服务，不接触真实资料。
 */

const TOPIC_ID = "t_" + "5".repeat(32);
const TOPIC_DIR = "读取输出";
const NODE_A = "n_" + "a".repeat(32);
const NODE_B = "n_" + "b".repeat(32);
const NODE_C = "n_" + "c".repeat(32);
const NODE_D = "n_" + "d".repeat(32);
const NODE_E = "n_" + "e".repeat(32);

const LONG = 5000;
const BODY_A = "甲".repeat(LONG);
const BODY_B = "乙".repeat(LONG);
const BODY_C = "丙".repeat(LONG);
const BODY_D = "丁".repeat(LONG);
const SECTION_BODY = [
  "开头段落。",
  "",
  "## 第一节",
  "第一节第一句。第一节后续。",
  "",
  "## 第二节",
  "第二节第一句；这里是章节起点之后的内容。",
  "",
  "结尾段落。",
].join("\n");

const temporaryRoots: string[] = [];
const running: ServiceHandle[] = [];

function nodeFile(options: {
  nodeId: string;
  title: string;
  from: string | null;
  flow: "root" | "next";
  body: string;
  description?: string;
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

async function newWorkspace(name = "cli-read-output"): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-read-output-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name });
  const dir = path.join(root, "topics", TOPIC_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: " + TOPIC_DIR + "\n---\n",
    "utf8",
  );
  const nodes = [
    { id: NODE_A, title: "甲卡", from: null, flow: "root" as const, body: BODY_A },
    {
      id: NODE_B,
      title: "乙卡",
      from: NODE_A,
      flow: "next" as const,
      body: BODY_B,
      description: "甲到乙",
    },
    {
      id: NODE_C,
      title: "丙卡",
      from: NODE_B,
      flow: "next" as const,
      body: BODY_C,
      description: "乙到丙",
    },
    {
      id: NODE_D,
      title: "丁卡",
      from: NODE_C,
      flow: "next" as const,
      body: BODY_D,
      description: "丙到丁",
    },
    {
      id: NODE_E,
      title: "章节卡",
      from: NODE_D,
      flow: "next" as const,
      body: SECTION_BODY,
      description: "丁到章节卡",
    },
  ];
  for (const node of nodes) {
    await fs.writeFile(
      path.join(dir, node.id + ".md"),
      nodeFile({
        nodeId: node.id,
        title: node.title,
        from: node.from,
        flow: node.flow,
        body: node.body,
        ...(node.description !== undefined ? { description: node.description } : {}),
      }),
      "utf8",
    );
  }
  return fs.realpath(root);
}

async function start(root: string): Promise<ServiceHandle> {
  const handle = await startService({ root, port: await freePort() });
  running.push(handle);
  return handle;
}

function contentItems(payload: ReadViewResponse): ReadContentItem[] {
  return payload.items as ReadContentItem[];
}

function jsonOf(stdout: string): ReadViewResponse {
  return JSON.parse(stdout) as ReadViewResponse;
}

function cli(args: readonly string[], root: string) {
  return main(["read", ...args, "--workspace", root]);
}

async function read(args: string[], root: string): Promise<ReadViewResponse> {
  const result = await cli(args, root);
  expect(result.exitCode, result.stderr).toBe(0);
  return jsonOf(result.stdout);
}

/** 跟随 page.next 直到结束；每页预算必须被遵守，且 used 与序列化长度一致。 */
async function collectPages(
  args: readonly string[],
  root: string,
  options: { budget?: number; offline?: boolean } = {},
): Promise<ReadViewResponse[]> {
  const budgetArgs =
    options.budget === undefined ? [] : ["--budget", String(options.budget)];
  const offlineArgs = options.offline === true ? ["--offline"] : [];
  const pages: ReadViewResponse[] = [];
  let result = await cli([...args, ...budgetArgs, ...offlineArgs], root);
  for (let index = 0; index < 100; index += 1) {
    expect(result.exitCode, result.stderr).toBe(0);
    const page = jsonOf(result.stdout);
    expect(JSON.stringify(page).length).toBe(page.budget.used);
    if (options.budget !== undefined) {
      expect(page.budget.used).toBeLessThanOrEqual(options.budget);
    }
    pages.push(page);
    if (!page.page.hasMore) return pages;
    expect(page.page.next).toBeTruthy();
    result = await cli(
      ["--cursor", page.page.next as string, ...budgetArgs, ...offlineArgs],
      root,
    );
  }
  throw new Error("分页次数超出预期");
}

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("read --node 统一输出", () => {
  it("同一节点在线与离线的 content 形状一致，editRef 只在在线可用", async () => {
    const root = await newWorkspace();
    await start(root);

    const online = await read(["--node", NODE_B], root);
    const offline = await read(["--node", NODE_B, "--offline"], root);

    expect(online.view).toBe("content");
    expect(online.source).toBe("online");
    expect(online.online.available).toBe(true);
    if (!online.online.available) throw new Error("expected online");
    expect(online.online.instanceId).toBeTruthy();
    expect(online.online.workspaceId).toBeTruthy();
    expect(typeof online.online.revision).toBe("number");

    expect(offline.view).toBe("content");
    expect(offline.source).toBe("disk");
    expect(offline.online.available).toBe(false);
    if (offline.online.available) throw new Error("expected offline");
    expect(offline.online.code).toBe("OFFLINE_REQUESTED");

    expect(contentItems(online)).toHaveLength(1);
    expect(contentItems(offline)).toHaveLength(1);
    const onlineItem = contentItems(online)[0];
    const offlineItem = contentItems(offline)[0];
    expect(onlineItem).toBeDefined();
    expect(offlineItem).toBeDefined();
    if (!onlineItem || !offlineItem) throw new Error("missing content item");

    // 在线与离线的节点视图完全同一形状与内容。
    expect(onlineItem.node).toEqual(offlineItem.node);
    expect(onlineItem.node).toMatchObject({
      id: NODE_B,
      topicId: TOPIC_ID,
      title: "乙卡",
      summary: expect.any(String),
      number: expect.any(String),
      from: NODE_A,
      flow: "next",
      state: "agreed",
      important: false,
      description: "甲到乙",
      sourcePath: "topics/" + TOPIC_DIR + "/" + NODE_B + ".md",
    });

    // 在线凭据可用且指向该节点；离线必须显式 null，不伪造。
    expect(onlineItem.editRef?.ref).toMatch(/^er_/);
    expect(onlineItem.editRef?.nodeId).toBe(NODE_B);
    expect(offlineItem.editRef).toBeNull();
    expect(offlineItem.path).toBe(onlineItem.path);
    expect(offlineItem.fileHash).toBe(onlineItem.fileHash);
    expect(offlineItem.range).toEqual(onlineItem.range);
    expect(offlineItem.truncated).toBe(onlineItem.truncated);
    expect(offlineItem.body).toBe(onlineItem.body);

    // 预算与分页在顶层；items 只保留内容阅读所需的字段。
    expect(online.budget).toMatchObject({ unit: "utf16", limit: 12000, mode: "auto" });
    expect(online.budget.used).toBe(JSON.stringify(online).length);
    expect(online.page.hasMore).toBe(true);
    expect(online.page.next).toBeTruthy();

    // 旧摊平字段与来源字段不再出现在 item 上。
    for (const key of [
      "source",
      "topicPath",
      "summaryExplicit",
      "byteLength",
      "schemaVersion",
      "file",
      "online",
      "workspaceId",
      "instanceId",
      "revision",
      "section",
    ]) {
      expect(onlineItem).not.toHaveProperty(key);
      expect(offlineItem).not.toHaveProperty(key);
    }
    for (const key of ["title", "id", "topicId"]) {
      expect(onlineItem).not.toHaveProperty(key);
      expect(offlineItem).not.toHaveProperty(key);
    }
    // 顶层的旧扁平结构不再出现。
    for (const key of ["nodes", "topic", "text", "textOmitted"]) {
      expect(online).not.toHaveProperty(key);
      expect(offline).not.toHaveProperty(key);
    }
  });

  it("--meta 在线只返回元数据与 editRef；离线同样无正文且 editRef 为 null", async () => {
    const root = await newWorkspace();
    await start(root);

    const online = await read(["--node", NODE_B, "--meta"], root);
    const offline = await read(["--node", NODE_B, "--meta", "--offline"], root);

    const onlineItem = contentItems(online)[0];
    const offlineItem = contentItems(offline)[0];
    if (!onlineItem || !offlineItem) throw new Error("missing content item");

    for (const item of [onlineItem, offlineItem]) {
      expect(item.body).toBe("");
      expect(item.bodyOmitted).toBe(true);
      expect(item.range.start).toBe(0);
      expect(item.range.end).toBe(0);
      expect(item.range.unit).toBe("utf16");
      expect(item.range.total).toBeGreaterThan(0);
      expect(item.truncated).toBe(false);
    }
    expect(onlineItem.range.total).toBe(offlineItem.range.total);
    expect(onlineItem.body).not.toContain("乙");
    expect(onlineItem.editRef?.ref).toMatch(/^er_/);
    expect(onlineItem.editRef?.nodeId).toBe(NODE_B);
    expect(onlineItem.editRef?.path).toBe(onlineItem.path);
    expect(offlineItem.editRef).toBeNull();
    expect(online.budget.mode).toBe("auto");
    expect(offline.source).toBe("disk");
  });

  it("4 张长卡默认共用 12000 总预算：自动分页，--cursor 续读能取回完整正文", async () => {
    const root = await newWorkspace();
    await start(root);

    const args = ["--node", NODE_A, "--node", NODE_B, "--node", NODE_C, "--node", NODE_D];
    const pages = await collectPages(args, root, { budget: 12000 });
    // 四张长卡共享一个预算，必须分多页取回。
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]?.budget).toMatchObject({ unit: "utf16", limit: 12000, mode: "auto" });
    for (const page of pages) expect(page.view).toBe("content");

    const collected = new Map<string, string>();
    for (const page of pages) {
      for (const item of contentItems(page)) {
        const before = collected.get(item.node.id) ?? "";
        expect(item.range.start).toBe(before.length);
        expect(item.range.end).toBe(item.range.start + item.body.length);
        expect(item.body.length).toBeLessThanOrEqual(4000);
        collected.set(item.node.id, before + item.body);
      }
    }
    expect([...collected.keys()]).toEqual([NODE_A, NODE_B, NODE_C, NODE_D]);
    expect(collected.get(NODE_A)).toBe(BODY_A);
    expect(collected.get(NODE_B)).toBe(BODY_B);
    expect(collected.get(NODE_C)).toBe(BODY_C);
    expect(collected.get(NODE_D)).toBe(BODY_D);

    // 离线走同一预算分页路径，正文一致且没有凭据。
    const offlinePages = await collectPages(args, root, { budget: 12000, offline: true });
    expect(offlinePages.length).toBeGreaterThan(1);
    const offlineCollected = new Map<string, string>();
    for (const page of offlinePages) {
      expect(page.source).toBe("disk");
      for (const item of contentItems(page)) {
        expect(item.editRef).toBeNull();
        const before = offlineCollected.get(item.node.id) ?? "";
        offlineCollected.set(item.node.id, before + item.body);
      }
    }
    expect(offlineCollected.get(NODE_A)).toBe(BODY_A);
    expect(offlineCollected.get(NODE_D)).toBe(BODY_D);
  });

  it("显式 --length 或 --full 超出 budget 返回 BUDGET_EXCEEDED；足够预算时完整返回", async () => {
    const root = await newWorkspace();
    await start(root);

    for (const extra of [
      ["--length", "5000"],
      ["--full"],
    ]) {
      // 两张 5000 字的卡无法放进最小预算：明确拒绝，不返回半份数据。
      const result = await cli(
        ["--node", NODE_A, "--node", NODE_B, ...extra, "--budget", "300"],
        root,
      );
      expect(result.exitCode, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
      const error = JSON.parse(result.stderr) as { error: { code: string; message: string } };
      expect(error.error.code).toBe("BUDGET_EXCEEDED");
      expect(error.error.message).toContain("budget");
      expect(result.stderr).not.toContain('"items"');

      // 离线引擎走同一退出码与错误码，不回退成半份正文。
      const offline = await cli(
        ["--node", NODE_A, "--node", NODE_B, ...extra, "--budget", "300", "--offline"],
        root,
      );
      expect(offline.exitCode, offline.stderr).toBe(2);
      expect(
        (JSON.parse(offline.stderr) as { error: { code: string } }).error.code,
      ).toBe("BUDGET_EXCEEDED");
    }

    const paged = await read(
      ["--node", NODE_A, "--node", NODE_B, "--length", "5000", "--budget", "60000"],
      root,
    );
    expect(paged.budget).toMatchObject({
      unit: "utf16",
      limit: 60000,
      mode: "explicit",
    });
    expect(paged.budget.used).toBe(JSON.stringify(paged).length);
    expect(paged.page).toEqual({ hasMore: false });
    expect(contentItems(paged)).toHaveLength(2);
    for (const item of contentItems(paged)) {
      expect(item.body.length).toBe(5000);
      expect(item.range).toEqual({ start: 0, end: 5000, total: 5000, unit: "utf16" });
      expect(item.truncated).toBe(false);
    }

    const full = await read(
      ["--node", NODE_A, "--node", NODE_B, "--full", "--budget", "60000"],
      root,
    );
    expect(full.budget.mode).toBe("explicit");
    for (const item of contentItems(full)) {
      expect(item.body.length).toBe(LONG);
      expect(item.range.end - item.range.start).toBe(LONG);
      expect(item.truncated).toBe(false);
    }
  });

  it("--start 是显式读取：多卡从该偏移切片，整个响应仍须满足 budget", async () => {
    const root = await newWorkspace();
    await start(root);

    const payload = await read(
      ["--node", NODE_A, "--node", NODE_B, "--start", "100"],
      root,
    );
    expect(payload.budget).toMatchObject({
      unit: "utf16",
      limit: 12000,
      mode: "explicit",
    });
    expect(payload.budget.used).toBe(JSON.stringify(payload).length);
    expect(payload.page).toEqual({ hasMore: false });
    expect(contentItems(payload)).toHaveLength(2);
    for (const item of contentItems(payload)) {
      expect(item.range.start).toBe(100);
      expect(item.range.end - item.range.start).toBe(4000);
      expect(item.truncated).toBe(true);
    }
  });

  it("--section 在线与离线从同一起点切片", async () => {
    const root = await newWorkspace();
    await start(root);

    const online = await read(["--node", NODE_E, "--section", "第二节", "--length", "20"], root);
    const offline = await read(
      ["--node", NODE_E, "--section", "第二节", "--length", "20", "--offline"],
      root,
    );
    const onlineItem = contentItems(online)[0];
    const offlineItem = contentItems(offline)[0];
    if (!onlineItem || !offlineItem) throw new Error("missing content item");

    const sectionStart = SECTION_BODY.indexOf("## 第二节");
    expect(sectionStart).toBeGreaterThan(0);
    expect(onlineItem.range.start).toBe(sectionStart);
    expect(offlineItem.range.start).toBe(sectionStart);
    expect(onlineItem.body).toBe(offlineItem.body);
    expect(onlineItem.body.startsWith("## 第二节")).toBe(true);
    expect(onlineItem.body).toContain("第二节第一句");
    expect(onlineItem.range.end - onlineItem.range.start).toBe(20);
    expect(online.budget.mode).toBe("explicit");
    expect(offline.budget.mode).toBe("explicit");

    // --full 从章节起点取到底；--start 被忽略。
    const full = await read(
      ["--node", NODE_E, "--section", "第二节", "--start", "0", "--full"],
      root,
    );
    const fullItem = contentItems(full)[0];
    if (!fullItem) throw new Error("missing full item");
    expect(fullItem.range.start).toBe(sectionStart);
    expect(fullItem.range.end).toBe(SECTION_BODY.length);
    expect(fullItem.body).toBe(SECTION_BODY.slice(sectionStart));
  });

  it("--meta 与切片参数组合、主题 --meta 都是用法错误", async () => {
    const root = await newWorkspace();
    await start(root);

    const cases = [
      ["--node", NODE_B, "--meta", "--length", "10"],
      ["--node", NODE_B, "--meta", "--start", "0"],
      ["--node", NODE_B, "--meta", "--full"],
      ["--node", NODE_B, "--meta", "--section", "第二节"],
      ["--node", NODE_B, "--meta", "--section", "第二节", "--section-index", "0"],
      [TOPIC_ID, "--meta"],
    ];
    for (const args of cases) {
      const result = await cli(args, root);
      expect(result.exitCode, args.join(" ")).toBe(2);
    }
  });

  it("主题默认 overview：带派生编号，只给入口记录，不重复主题字段", async () => {
    const root = await newWorkspace();

    const result = await cli([TOPIC_ID], root);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = jsonOf(result.stdout);
    expect(payload.view).toBe("overview");
    expect(payload.source).toBe("disk");
    expect(payload.topicId).toBe(TOPIC_ID);
    expect(payload.topicTitle).toBe(TOPIC_DIR);
    expect(payload.scope).toMatchObject({ kind: "topic", nodeCount: 5 });

    const items = payload.items as ReadOverviewItem[];
    expect(items.every((item) => item.role === "mainline")).toBe(true);
    expect(items.map((item) => item.number)).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
    ]);
    expect(items.map((item) => item.id)).toEqual([
      NODE_A,
      NODE_B,
      NODE_C,
      NODE_D,
      NODE_E,
    ]);
    for (const item of items) {
      expect(item).not.toHaveProperty("topicId");
      expect(item).not.toHaveProperty("topicPath");
      expect(item).not.toHaveProperty("summaryExplicit");
      expect(item).not.toHaveProperty("schemaVersion");
      expect(item).not.toHaveProperty("byteLength");
      // overview 不返回正文、真实路径、哈希或凭据。
      expect(item).not.toHaveProperty("body");
      expect(item).not.toHaveProperty("path");
      expect(item).not.toHaveProperty("fileHash");
      expect(item).not.toHaveProperty("editRef");
    }
    for (const key of ["nodes", "topic", "text", "textOmitted"]) {
      expect(payload).not.toHaveProperty(key);
    }

    const text = await cli([TOPIC_ID, "--text"], root);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain("read overview");
    expect(text.stdout).toContain("mainline 01 " + NODE_A);
    expect(text.stdout).toContain("mainline 05 " + NODE_E);
    expect(text.stdout).not.toContain("## 第一节");
  });

  it("--section-index 单独出现时统一拒绝（节点与主题、离线同样生效）", async () => {
    // 不启动服务：若校验缺失，节点读取会静默回退磁盘而不是退出码 2。
    const root = await newWorkspace();

    const cases = [
      ["--node", NODE_E, "--section-index", "0"],
      [TOPIC_ID, "--section-index", "0"],
    ];
    for (const args of cases) {
      const result = await cli(args, root);
      expect(result.exitCode, args.join(" ")).toBe(2);
      const error = JSON.parse(result.stderr) as { error: { message: string } };
      expect(error.error.message).toContain("--section");
    }
  });

  it("服务不可达时全部磁盘读取，顶层给出原因且 editRef 为 null", async () => {
    const root = await newWorkspace();

    const pages = await collectPages(["--node", NODE_A, "--node", NODE_B], root, {
      budget: 12000,
    });
    // 多卡预算在离线回退时同样生效；可能跨页续读。
    const collected = new Map<string, string>();
    for (const payload of pages) {
      expect(payload.view).toBe("content");
      expect(payload.source).toBe("disk");
      expect(payload.online.available).toBe(false);
      if (payload.online.available) throw new Error("expected offline");
      expect(payload.online.code).toBe("SERVICE_NOT_RUNNING");
      expect(payload.online.reason).toBeTruthy();
      expect(payload.budget).toMatchObject({ unit: "utf16", limit: 12000, mode: "auto" });
      for (const item of contentItems(payload)) {
        const before = collected.get(item.node.id) ?? "";
        expect(item.editRef).toBeNull();
        expect(item.range.start).toBe(before.length);
        expect(item.body.length).toBeLessThanOrEqual(4000);
        expect(item.range.end - item.range.start).toBe(item.body.length);
        collected.set(item.node.id, before + item.body);
      }
    }
    expect([...collected.keys()]).toEqual([NODE_A, NODE_B]);
    expect(collected.get(NODE_A)).toBe(BODY_A);
    expect(collected.get(NODE_B)).toBe(BODY_B);
  });
});
