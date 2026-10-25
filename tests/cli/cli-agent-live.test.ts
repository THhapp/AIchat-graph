import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";
import { main } from "../../src/cli/index.js";
import { EXIT_CODES } from "../../src/cli/errors.js";

/**
 * 真实服务上的低摩擦 Agent 链路：read --node 取 editRef → edit／next／connect。
 *
 * 这些用例证明 CLI 与服务端的共享 DTO 拼写一致、凭据真的能写回真实文件，
 * 而不是只在 fake fetch 上成立。用进程内 startService + 真实磁盘，不 mock HTTP。
 */

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

let parent: string;
let root: string;
let handle: ServiceHandle;
let workspaceId: string;

beforeAll(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-agent-live-"));
  root = path.join(parent, "workspace");
  await fs.mkdir(root);
  workspaceId = "w_agent_live";
  const files: Record<string, string> = {
    "workspace.json":
      JSON.stringify({ schemaVersion: 2, workspaceId, name: "agent live", activeNode: null }, null, 2) +
      "\n",
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
  handle = await startService({ root, port: await freePort() });
});

afterAll(async () => {
  await handle?.stop();
  await fs.rm(parent, { recursive: true, force: true });
});

interface OnlineNode {
  readonly id?: string;
  readonly source: string;
  readonly body: string;
  readonly truncated: boolean;
  readonly path: string;
  readonly fileHash: string;
  readonly editRef?: { ref: string };
  readonly range: { start: number; end: number; total: number; unit: string };
}

async function readNodeJson(nodeId: string, extra: string[] = []): Promise<OnlineNode> {
  const result = await main(["read", "--node", nodeId, "--workspace", root, ...extra]);
  expect(result.exitCode).toBe(0);
  const body = JSON.parse(result.stdout) as {
    source: string;
    items: OnlineNode[];
  };
  const node = body.items[0];
  expect(node).toBeDefined();
  // source 现在只出现在顶层；helper 把它带进返回值，保持旧用例的阅读方式。
  return { ...(node as OnlineNode), source: body.source };
}

async function textOf(relativePath: string): Promise<string> {
  return fs.readFile(path.join(root, ...relativePath.split("/")), "utf8");
}

describe("低摩擦 Agent 链路（真实服务）", () => {
  it("read --node 取到 editRef，并用它原位追加", async () => {
    const before = await textOf(CHILD_PATH);
    const node = await readNodeJson(CHILD_NODE);
    expect(node.source).toBe("online");
    expect(node.path).toBe(CHILD_PATH);
    expect(node.range.unit).toBe("utf16");
    const ref = node.editRef?.ref;
    expect(typeof ref).toBe("string");
    expect(ref?.length ?? 0).toBeGreaterThan(0);

    const appendFile = path.join(parent, "append.md");
    await fs.writeFile(appendFile, "真机追加的一段。", "utf8");
    const edit = await main([
      "edit",
      "--ref",
      ref as string,
      "--append-file",
      appendFile,
      "--workspace",
      root,
    ]);
    expect(edit.exitCode).toBe(0);
    const editBody = JSON.parse(edit.stdout) as Record<string, unknown>;
    const result = editBody["result"] as Record<string, unknown>;
    expect(result["state"]).toBe("committed");
    expect(result["changedNodeIds"]).toContain(CHILD_NODE);

    const after = await textOf(CHILD_PATH);
    expect(after).toContain("真机追加的一段。");
    expect(after).toContain(before.trim().split("\n").slice(-1)[0] as string);
    // 返回的新凭据可用，说明服务确实按节点文件发行。
    expect((result["editRef"] as Record<string, unknown>)["ref"]).toBeTruthy();
  });

  it("旧凭据在文件变化后被拒绝（412），不静默覆盖", async () => {
    const node = await readNodeJson(CHILD_NODE);
    const staleRef = node.editRef?.ref as string;
    // 用另一条路径改同一文件，使旧凭据绑定的哈希过期。
    // 用同一凭据做一次真实修改（标题变了，文件哈希随之变化）。
    const again = await main([
      "edit",
      "--ref",
      staleRef,
      "--title",
      "可以回查的现场（已更新）",
      "--workspace",
      root,
    ]);
    expect(again.exitCode).toBe(0);
    expect(await textOf(CHILD_PATH)).toContain("title: 可以回查的现场（已更新）");
    const stale = await main([
      "edit",
      "--ref",
      staleRef,
      "--title",
      "过期的凭据不该生效",
      "--workspace",
      root,
    ]);
    expect(stale.exitCode).toBe(4);
    expect(JSON.parse(stale.stderr).error.code).toBe("VERSION_CONFLICT");
    const text = await textOf(CHILD_PATH);
    expect(text).not.toContain("过期的凭据不该生效");
  });

  it("branch 新建旁支并返回新节点 ID 与真实文件", async () => {
    const node = await readNodeJson(CHILD_NODE);
    const bodyFile = path.join(parent, "branch.md");
    await fs.writeFile(bodyFile, "旁支正文。", "utf8");
    const result = await main([
      "branch",
      "--from-ref",
      node.editRef?.ref as string,
      "--title",
      "真机旁支",
      "--description",
      "这里出现了不同的取舍",
      "--body-file",
      bodyFile,
      "--workspace",
      root,
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const committed = payload["result"] as Record<string, unknown>;
    const created = committed["created"] as Record<string, unknown>;
    const nodeIds = created["nodeIds"] as string[];
    expect(nodeIds.length).toBe(1);
    const newId = nodeIds[0] as string;
    expect(newId).toMatch(/^n_[0-9a-f]{32}$/);
    const newPath = (created["paths"] as string[])[0] as string;
    const created_text = await textOf(newPath);
    expect(created_text).toContain(`nodeId: ${newId}`);
    expect(created_text).toContain("description: 这里出现了不同的取舍");
    expect(created_text).toContain("旁支正文。");
    // 分支入口是 branch，不吞掉原主线。
    expect(created_text).toContain("flow: branch");

    const validated = await main(["validate", "--workspace", root]);
    expect(validated.exitCode).toBe(0);
  });

  it("next 新建纵向后继；来源已有 next 时明确 409", async () => {
    // 根节点的 next 已经是既有卡片：在这里建后继必须被拒绝。
    const node = await readNodeJson(ROOT_NODE);
    const bodyFile = path.join(parent, "next.md");
    await fs.writeFile(bodyFile, "纵向后继正文。", "utf8");
    const result = await main([
      "next",
      "--from-ref",
      node.editRef?.ref as string,
      "--title",
      "真机后继",
      "--description",
      "同一条线继续",
      "--body-file",
      bodyFile,
      "--workspace",
      root,
    ]);
    // 该来源已有 next：明确 409，不插队、不挤掉旧主线。
    expect(result.exitCode).toBe(5);
    expect(JSON.parse(result.stderr).error.code).toBe("OPERATION_CONFLICT");
    expect(await textOf(CHILD_PATH)).not.toContain("纵向后继正文。");

    // 叶子节点（没有 next）可以正常建立纵向后继。
    const leafNode = await readNodeJson(CHILD_NODE);
    const ok = await main([
      "next",
      "--from-ref",
      leafNode.editRef?.ref as string,
      "--title",
      "真机后继",
      "--description",
      "同一条线继续",
      "--body-file",
      bodyFile,
      "--workspace",
      root,
    ]);
    expect(ok.exitCode).toBe(0);
    const created = (JSON.parse(ok.stdout)["result"] as Record<string, unknown>)[
      "created"
    ] as Record<string, unknown>;
    const newPath = (created["paths"] as string[])[0] as string;
    const newText = await textOf(newPath);
    expect(newText).toContain("flow: next");
    expect(newText).toContain(`from: ${CHILD_NODE}`);
    // 纵向后继不带 branch 的排布字段。
    expect(newText).not.toContain("side:");
    expect(newText).not.toContain("order:");

    // 再来一次：该来源现在已有 next，必须 409。
    const leafAgain = await readNodeJson(CHILD_NODE);
    const second = await main([
      "next",
      "--from-ref",
      leafAgain.editRef?.ref as string,
      "--title",
      "第二个后继",
      "--description",
      "不该成功",
      "--body-file",
      bodyFile,
      "--workspace",
      root,
    ]);
    expect(second.exitCode).toBe(5);
    expect(JSON.parse(second.stderr).error.code).toBe("OPERATION_CONFLICT");
  });

  it("connect 改接来源需要 description，并写回真实文件", async () => {
    const node = await readNodeJson(CHILD_NODE);
    const missing = await main([
      "connect",
      "--ref",
      node.editRef?.ref as string,
      "--flow",
      "branch",
      "--workspace",
      root,
    ]);
    expect(missing.exitCode).toBe(2);

    // 只改 description 也是合法维护动作（改好一句说不清的理由）。
    const descriptionOnly = await main([
      "connect",
      "--ref",
      node.editRef?.ref as string,
      "--description",
      "只改描述说明",
      "--workspace",
      root,
    ]);
    expect(descriptionOnly.exitCode).toBe(0);
    expect(await textOf(CHILD_PATH)).toContain("description: 只改描述说明");

    // 结构变化：把 next 改成 branch 并给出排布字段。
    const refreshed = await readNodeJson(CHILD_NODE);
    const ok = await main([
      "connect",
      "--ref",
      refreshed.editRef?.ref as string,
      "--flow",
      "branch",
      "--side",
      "right",
      "--order",
      "10",
      "--description",
      "改得更准确的来源说明",
      "--workspace",
      root,
    ]);
    expect(ok.exitCode).toBe(0);
    const text = await textOf(CHILD_PATH);
    expect(text).toContain("description: 改得更准确的来源说明");
    expect(text).toContain("flow: branch");
  });

  it("create-root 在非空工作区被明确拒绝", async () => {
    const result = await main([
      "create-root",
      "--topic-title",
      "不该创建",
      "--title",
      "不该创建",
      "--body",
      "正文",
      "--workspace",
      root,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).not.toBe(0);
  });
});
/**
 * A03：`read --length 0` 是参数错误，不是 INTERNAL。
 * 在线与离线都在 CLI 本地判定（不发出注定失败的请求），退出码为 usage；
 * 服务端对直接 GET 的 length=0 仍自行返回 400。
 */
describe("A03 非法读取参数（真实 CLI）", () => {
  it("length=0 在线与离线都退出 2，并给出有效范围", async () => {
    const online = await main(["read", "--node", CHILD_NODE, "--length", "0", "--workspace", root]);
    expect(online.exitCode).toBe(EXIT_CODES.usage);
    const onlineBody = JSON.parse(online.stderr) as { error: { code: string; message: string } };
    expect(onlineBody.error.code).toBe("INVALID_ARGUMENT");
    expect(onlineBody.error.message).toContain("1-16000");

    const offline = await main([
      "read",
      "--node",
      CHILD_NODE,
      "--length",
      "0",
      "--offline",
      "--workspace",
      root,
    ]);
    expect(offline.exitCode).toBe(EXIT_CODES.usage);
    const offlineBody = JSON.parse(offline.stderr) as {
      error: { code: string; message: string; details?: { min?: number; max?: number } };
    };
    expect(offlineBody.error.code).toBe("INVALID_ARGUMENT");
    expect(offlineBody.error.message).toContain("1-16000");
    expect(offlineBody.error.details?.min).toBe(1);
    expect(offlineBody.error.details?.max).toBe(16000);
  });

  it("length=1 是合法下界，仍可正常读取", async () => {
    const node = await readNodeJson(CHILD_NODE, ["--length", "1"]);
    expect(node.range.end - node.range.start).toBe(1);
    expect(node.body.length).toBe(1);
  });
});
