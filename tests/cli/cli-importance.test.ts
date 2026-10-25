import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { main } from "../../src/cli/index.js";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";

/** important CLI：--node 先做真实在线读取拿 editRef；--ref 原样提交。 */

const TOPIC_ID = "t_" + "2".repeat(32);
const ROOT_NODE = "n_" + "3".repeat(32);
const NEXT_NODE = "n_" + "4".repeat(32);
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
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-important-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "cli-important" });
  const dir = path.join(root, "topics", DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: " + DIR + "\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, ROOT_NODE + ".md"),
    nodeFile({
      nodeId: ROOT_NODE,
      title: "记录的目的",
      from: null,
      flow: "root",
      body: "保留有用的思路来路。",
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, NEXT_NODE + ".md"),
    nodeFile({
      nodeId: NEXT_NODE,
      title: "原位维护",
      from: ROOT_NODE,
      flow: "next",
      description: "先记录目的，再说明维护方式",
      body: "默认更新现有内容。",
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

async function agentRef(handle: ServiceHandle, nodeId: string): Promise<string> {
  const response = await fetch(handle.url + "/api/agent/nodes/" + nodeId);
  expect(response.status).toBe(200);
  return ((await response.json()) as { editRef: { ref: string } }).editRef.ref;
}

interface GraphBody {
  lastChanges?: Record<string, { at: string; nodeIds: string[] }>;
  nodes: Array<{ id: string; important: boolean }>;
}

async function graphOf(handle: ServiceHandle): Promise<GraphBody> {
  return (await (await fetch(handle.url + "/api/graph")).json()) as GraphBody;
}

function nodePath(root: string, nodeId: string): string {
  return path.join(root, "topics", DIR, nodeId + ".md");
}

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("aichat important", () => {
  it("--node --on 写入真实文件，且不替换「最近一次内容更新」", async () => {
    const root = await newWorkspace();
    const handle = await start(root);

    const ref = await agentRef(handle, NEXT_NODE);
    const edited = await main([
      "edit",
      "--ref",
      ref,
      "--body",
      "新的正文。",
      "--workspace",
      root,
    ]);
    expect(edited.exitCode, edited.stderr).toBe(0);
    const recorded = (await graphOf(handle)).lastChanges?.[TOPIC_ID];
    expect(recorded?.nodeIds).toEqual([NEXT_NODE]);

    const outcome = await main(["important", "--node", NEXT_NODE, "--on", "--workspace", root]);
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    const body = JSON.parse(outcome.stdout) as {
      command: string;
      nodeId: string;
      important: boolean;
      result: {
        state: string;
        editRef: { ref: string; nodeId: string } | null;
        editRefs?: Record<string, { ref: string }>;
      };
    };
    expect(body.command).toBe("important");
    expect(body.nodeId).toBe(NEXT_NODE);
    expect(body.important).toBe(true);
    expect(body.result.state).toBe("committed");
    expect(body.result.editRef?.ref).toMatch(/^er_/);
    expect(body.result.editRef?.nodeId).toBe(NEXT_NODE);
    expect(body.result.editRefs?.[NEXT_NODE]?.ref).toMatch(/^er_/);

    const text = await fs.readFile(nodePath(root, NEXT_NODE), "utf8");
    expect(text).toContain("important: true");
    expect(text).toContain("新的正文。");
    const graph = await graphOf(handle);
    expect(graph.nodes.find((node) => node.id === NEXT_NODE)?.important).toBe(true);
    // 重要性只是元数据：最近一次内容更新仍是刚才那次正文修改。
    expect(graph.lastChanges?.[TOPIC_ID]).toEqual(recorded);
  });

  it("读取后源文件被外部改动，旧 --ref 设置重要标记 → 412 且不覆盖", async () => {
    const root = await newWorkspace();
    const handle = await start(root);
    const ref = await agentRef(handle, NEXT_NODE);
    const file = nodePath(root, NEXT_NODE);
    const external = (await fs.readFile(file, "utf8")).replace(
      "默认更新现有内容。",
      "外部已经改成的新内容。",
    );
    await fs.writeFile(file, external, "utf8");
    const externalBytes = await fs.readFile(file);

    const outcome = await main(["important", "--ref", ref, "--off", "--workspace", root]);
    expect(outcome.exitCode).toBe(4);
    const error = JSON.parse(outcome.stderr) as { error: { code: string } };
    expect(error.error.code).toBe("VERSION_CONFLICT");
    expect(await fs.readFile(file)).toEqual(externalBytes);
  });

  it("用刷新后的 --ref --off 清除字段，文件不留 important", async () => {
    const root = await newWorkspace();
    const handle = await start(root);

    const on = await main(["important", "--node", NEXT_NODE, "--on", "--workspace", root]);
    expect(on.exitCode, on.stderr).toBe(0);
    expect(await fs.readFile(nodePath(root, NEXT_NODE), "utf8")).toContain("important: true");

    const fresh = await agentRef(handle, NEXT_NODE);
    const off = await main(["important", "--ref", fresh, "--off", "--workspace", root]);
    expect(off.exitCode, off.stderr).toBe(0);
    const payload = JSON.parse(off.stdout) as {
      nodeId: string;
      important: boolean;
      result: { editRef: { nodeId: string } | null };
    };
    expect(payload.nodeId).toBe(NEXT_NODE);
    expect(payload.important).toBe(false);
    expect(payload.result.editRef?.nodeId).toBe(NEXT_NODE);

    const cleared = await fs.readFile(nodePath(root, NEXT_NODE), "utf8");
    expect(cleared).not.toContain("important");
    expect((await graphOf(handle)).nodes.find((node) => node.id === NEXT_NODE)?.important).toBe(
      false,
    );
  });

  it("参数互斥错误退出码 2；无服务时 --node 明确退出 7", async () => {
    const root = await newWorkspace();

    const bothTargets = await main([
      "important",
      "--ref",
      "r",
      "--node",
      NEXT_NODE,
      "--on",
      "--workspace",
      root,
    ]);
    expect(bothTargets.exitCode).toBe(2);
    expect(JSON.parse(bothTargets.stderr).error.message).toContain("--ref");

    const noTarget = await main(["important", "--on", "--workspace", root]);
    expect(noTarget.exitCode).toBe(2);
    expect(JSON.parse(noTarget.stderr).error.message).toContain("--ref");

    const noMode = await main(["important", "--ref", "r", "--workspace", root]);
    expect(noMode.exitCode).toBe(2);
    expect(JSON.parse(noMode.stderr).error.message).toContain("--on");

    const bothModes = await main([
      "important",
      "--ref",
      "r",
      "--on",
      "--off",
      "--workspace",
      root,
    ]);
    expect(bothModes.exitCode).toBe(2);

    const offline = await main(["important", "--node", NEXT_NODE, "--on", "--workspace", root]);
    expect(offline.exitCode).toBe(7);
    expect(JSON.parse(offline.stderr).error.message).toContain("serve");
  });
});
