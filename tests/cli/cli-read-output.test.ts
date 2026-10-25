import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/cli/index.js";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";

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

interface ReadNodeItem {
  source: "online" | "disk";
  node: Record<string, unknown>;
  body: string;
  bodyOmitted?: true;
  range: { start: number; end: number; total: number; unit: "utf16" };
  truncated: boolean;
  path: string;
  fileHash: string;
  editRef: Record<string, unknown> | null;
}

interface ReadPayload {
  ok: boolean;
  command: string;
  root: string;
  online:
    | { available: true; instanceId: string; revision: number; workspaceId: string }
    | { available: false; code: string; reason: string };
  budget?: { total: number; perNode: number; nodes: number };
  nodes: ReadNodeItem[];
}

function jsonOf(stdout: string): ReadPayload {
  return JSON.parse(stdout) as ReadPayload;
}

async function read(args: string[], root: string): Promise<ReadPayload> {
  const result = await main(["read", ...args, "--workspace", root]);
  expect(result.exitCode, result.stderr).toBe(0);
  return jsonOf(result.stdout);
}

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("read --node 统一输出", () => {
  it("同一节点在线与离线的 node 与顶层字段一致，editRef 只在在线可用", async () => {
    const root = await newWorkspace();
    await start(root);

    const online = await read(["--node", NODE_B], root);
    const offline = await read(["--node", NODE_B, "--offline"], root);

    expect(online.online.available).toBe(true);
    if (!online.online.available) throw new Error("expected online");
    expect(online.online.instanceId).toBeTruthy();
    expect(online.online.workspaceId).toBeTruthy();
    expect(typeof online.online.revision).toBe("number");

    expect(offline.online.available).toBe(false);
    if (offline.online.available) throw new Error("expected offline");
    expect(offline.online.code).toBe("OFFLINE_REQUESTED");

    const onlineItem = online.nodes[0];
    const offlineItem = offline.nodes[0];
    expect(onlineItem).toBeDefined();
    expect(offlineItem).toBeDefined();
    if (!onlineItem || !offlineItem) throw new Error("missing node item");

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
    expect(onlineItem.source).toBe("online");
    expect(onlineItem.editRef?.ref).toMatch(/^er_/);
    expect(onlineItem.editRef?.nodeId).toBe(NODE_B);
    expect(offlineItem.source).toBe("disk");
    expect(offlineItem.editRef).toBeNull();
    expect(offlineItem.path).toBe(onlineItem.path);
    expect(offlineItem.fileHash).toBe(onlineItem.fileHash);
    expect(offlineItem.range).toEqual(onlineItem.range);
    expect(offlineItem.truncated).toBe(onlineItem.truncated);
    expect(offlineItem.body).toBe(onlineItem.body);

    // 旧摊平字段不再出现。
    for (const key of [
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
  });

  it("--meta 在线只返回元数据与 editRef；离线同样无正文且 editRef 为 null", async () => {
    const root = await newWorkspace();
    await start(root);

    const online = await read(["--node", NODE_B, "--meta"], root);
    const offline = await read(["--node", NODE_B, "--meta", "--offline"], root);

    const onlineItem = online.nodes[0];
    const offlineItem = offline.nodes[0];
    if (!onlineItem || !offlineItem) throw new Error("missing node item");

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
  });

  it("4 张长卡默认应用整次预算 12000，每卡 3000", async () => {
    const root = await newWorkspace();
    await start(root);

    const payload = await read(
      ["--node", NODE_A, "--node", NODE_B, "--node", NODE_C, "--node", NODE_D],
      root,
    );

    expect(payload.budget).toEqual({ total: 12000, perNode: 3000, nodes: 4 });
    expect(payload.nodes).toHaveLength(4);
    let totalBody = 0;
    for (const item of payload.nodes) {
      expect(item.range.end - item.range.start).toBeLessThanOrEqual(3000);
      expect(item.range.end - item.range.start).toBe(3000);
      expect(item.body.length).toBe(3000);
      expect(item.truncated).toBe(true);
      totalBody += item.body.length;
    }
    expect(totalBody).toBeLessThanOrEqual(12000);
  });

  it("显式 --length 或 --full 覆盖预算且不输出 budget", async () => {
    const root = await newWorkspace();
    await start(root);

    const paged = await read(["--node", NODE_A, "--node", NODE_B, "--length", "5000"], root);
    expect(paged).not.toHaveProperty("budget");
    for (const item of paged.nodes) {
      expect(item.body.length).toBe(5000);
      expect(item.range).toEqual({ start: 0, end: 5000, total: 5000, unit: "utf16" });
      expect(item.truncated).toBe(false);
    }

    const full = await read(["--node", NODE_A, "--node", NODE_B, "--full"], root);
    expect(full).not.toHaveProperty("budget");
    for (const item of full.nodes) {
      expect(item.body.length).toBe(LONG);
      expect(item.truncated).toBe(false);
    }
  });

  it("--start 可与多卡预算共存，每卡从该偏移读 perNode 个单元", async () => {
    const root = await newWorkspace();
    await start(root);

    const payload = await read(
      ["--node", NODE_A, "--node", NODE_B, "--start", "100"],
      root,
    );
    expect(payload.budget).toEqual({ total: 12000, perNode: 4000, nodes: 2 });
    for (const item of payload.nodes) {
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
    const onlineItem = online.nodes[0];
    const offlineItem = offline.nodes[0];
    if (!onlineItem || !offlineItem) throw new Error("missing node item");

    const sectionStart = SECTION_BODY.indexOf("## 第二节");
    expect(sectionStart).toBeGreaterThan(0);
    expect(onlineItem.range.start).toBe(sectionStart);
    expect(offlineItem.range.start).toBe(sectionStart);
    expect(onlineItem.body).toBe(offlineItem.body);
    expect(onlineItem.body.startsWith("## 第二节")).toBe(true);
    expect(onlineItem.body).toContain("第二节第一句");
    expect(onlineItem.range.end - onlineItem.range.start).toBe(20);

    // --full 从章节起点取到底；--start 被忽略。
    const full = await read(
      ["--node", NODE_E, "--section", "第二节", "--start", "0", "--full"],
      root,
    );
    const fullItem = full.nodes[0];
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
      const result = await main(["read", ...args, "--workspace", root]);
      expect(result.exitCode, args.join(" ")).toBe(2);
    }
  });

  it("主题概览清单带派生编号，且不重复主题字段", async () => {
    const root = await newWorkspace();

    const result = await main(["read", TOPIC_ID, "--workspace", root]);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      nodes: Array<Record<string, unknown>>;
    };
    expect(payload.nodes.map((node) => node["number"])).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
    ]);
    expect(payload.nodes.map((node) => node["id"])).toEqual([
      NODE_A,
      NODE_B,
      NODE_C,
      NODE_D,
      NODE_E,
    ]);
    for (const node of payload.nodes) {
      expect(node).not.toHaveProperty("topicId");
      expect(node).not.toHaveProperty("topicPath");
      expect(node).not.toHaveProperty("summaryExplicit");
      expect(node).not.toHaveProperty("schemaVersion");
      expect(node).not.toHaveProperty("byteLength");
      expect(typeof node["fileHash"]).toBe("string");
      expect(typeof node["path"]).toBe("string");
    }

    const text = await main(["read", TOPIC_ID, "--text", "--workspace", root]);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain("01  " + NODE_A);
    expect(text.stdout).toContain("05  " + NODE_E);
  });

  it("--section-index 单独出现时统一拒绝（节点与主题、离线同样生效）", async () => {
    // 不启动服务：若校验缺失，节点读取会静默回退磁盘而不是退出码 2。
    const root = await newWorkspace();

    const cases = [
      ["--node", NODE_E, "--section-index", "0"],
      [TOPIC_ID, "--section-index", "0"],
    ];
    for (const args of cases) {
      const result = await main(["read", ...args, "--workspace", root]);
      expect(result.exitCode, args.join(" ")).toBe(2);
      const error = JSON.parse(result.stderr) as { error: { message: string } };
      expect(error.error.message).toContain("--section");
    }
  });

  it("服务不可达时全部磁盘读取，顶层给出原因且 editRef 为 null", async () => {
    const root = await newWorkspace();

    const result = await main(["read", "--node", NODE_A, "--node", NODE_B, "--workspace", root]);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = jsonOf(result.stdout);
    expect(payload.online.available).toBe(false);
    if (payload.online.available) throw new Error("expected offline");
    expect(payload.online.code).toBe("SERVICE_NOT_RUNNING");
    expect(payload.online.reason).toBeTruthy();
    expect(payload.nodes).toHaveLength(2);
    for (const item of payload.nodes) {
      expect(item.source).toBe("disk");
      expect(item.editRef).toBeNull();
      // 多卡预算在离线回退时同样生效。
      expect(item.body.length).toBeLessThanOrEqual(4000);
    }
    expect(payload.budget).toEqual({ total: 12000, perNode: 4000, nodes: 2 });
  });
});
