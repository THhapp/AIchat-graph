import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { main } from "../../src/cli/index.js";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";

/**
 * rearrange CLI：调用方只写最终关系与说明；requestId 由客户端生成，
 * 服务端在同一批候选里安全排序，响应带回刷新后的 editRefs。
 */

const TOPIC_ID = "t_" + "1".repeat(32);
const TOPIC_DIR = "链条";
const NODE_A = "n_" + "a".repeat(32);
const NODE_B = "n_" + "b".repeat(32);
const NODE_C = "n_" + "c".repeat(32);
const NODE_D = "n_" + "d".repeat(32);

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

async function newChainWorkspace(): Promise<{ root: string; parent: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-rearrange-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "cli-rearrange" });
  const dir = path.join(root, "topics", TOPIC_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: 链条\n---\n",
    "utf8",
  );
  const nodes = [
    { id: NODE_A, title: "起点", from: null, flow: "root" as const, description: undefined, body: "A。" },
    { id: NODE_B, title: "第二张", from: NODE_A, flow: "next" as const, description: "一到二", body: "B。" },
    { id: NODE_C, title: "第三张", from: NODE_B, flow: "next" as const, description: "二到三", body: "C。" },
    { id: NODE_D, title: "第四张", from: NODE_C, flow: "next" as const, description: "三到四", body: "D。" },
  ];
  for (const node of nodes) {
    await fs.writeFile(
      path.join(dir, node.id + ".md"),
      nodeFile({
        nodeId: node.id,
        title: node.title,
        from: node.from,
        flow: node.flow,
        ...(node.description !== undefined ? { description: node.description } : {}),
        body: node.body,
      }),
      "utf8",
    );
  }
  return { root: await fs.realpath(root), parent };
}

async function start(root: string): Promise<ServiceHandle> {
  const handle = await startService({ root, port: await freePort() });
  running.push(handle);
  return handle;
}

async function agentRef(handle: ServiceHandle, nodeId: string): Promise<string> {
  const response = await fetch(handle.url + "/api/agent/nodes/" + nodeId + "?meta=true");
  expect(response.status).toBe(200);
  return ((await response.json()) as { editRef: { ref: string } }).editRef.ref;
}

async function graphNumbers(handle: ServiceHandle): Promise<Record<string, string>> {
  const graph = (await (await fetch(handle.url + "/api/graph")).json()) as {
    nodes: Array<{ id: string; number: string; from: string | null }>;
  };
  return Object.fromEntries(graph.nodes.map((node) => [node.id, node.number + ":" + String(node.from)]));
}

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("aichat rearrange", () => {
  it("从 spec.json 一次提交最终入边，输出顶层 refs 与请求身份", async () => {
    const { root, parent } = await newChainWorkspace();
    const handle = await start(root);
    const refs = {
      a: await agentRef(handle, NODE_A),
      b: await agentRef(handle, NODE_B),
      c: await agentRef(handle, NODE_C),
      d: await agentRef(handle, NODE_D),
    };
    const specPath = path.join(parent, "rearrange.json");
    await fs.writeFile(
      specPath,
      JSON.stringify(
        {
          edits: [
            { ref: refs.c, fromRef: refs.a, flow: "next", description: "从一到三（新）" },
            { ref: refs.b, fromRef: refs.c, flow: "next", description: "从三到二（新）" },
            { ref: refs.d, fromRef: refs.b, flow: "next", description: "从二到四（新）" },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    // --verbose：默认精简结果之外才输出 touchedFiles 与事务诊断。
    const outcome = await main([
      "rearrange",
      "--input",
      specPath,
      "--workspace",
      root,
      "--verbose",
    ]);
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    const body = JSON.parse(outcome.stdout) as {
      ok: boolean;
      command: string;
      workspaceId: string;
      topicId: string;
      requestId: string;
      state: string;
      revision: number;
      changedNodeIds: string[];
      refs: Record<string, string>;
      touchedFiles: Array<{ path: string }>;
      httpStatus: number;
      result?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.command).toBe("rearrange");
    expect(body.workspaceId).toBeTruthy();
    expect(body.topicId).toBe(TOPIC_ID);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // 统一结果在顶层：不再套 result，也不再给单节点 editRef。
    expect(body["result"]).toBeUndefined();
    expect(body.state).toBe("committed");
    expect(body.revision).toBeGreaterThan(0);
    expect(body.changedNodeIds.slice().sort()).toEqual([NODE_B, NODE_C, NODE_D].sort());
    expect(Object.keys(body.refs).sort()).toEqual([NODE_B, NODE_C, NODE_D].sort());
    expect(body.refs[NODE_C]).toMatch(/^er_/);
    expect(body.httpStatus).toBe(200);
    expect(body.touchedFiles.map((file) => file.path).sort()).toEqual(
      [NODE_B, NODE_C, NODE_D]
        .map((id) => "topics/" + TOPIC_DIR + "/" + id + ".md")
        .sort(),
    );

    expect(await graphNumbers(handle)).toEqual({
      [NODE_A]: "01:null",
      [NODE_C]: "02:" + NODE_A,
      [NODE_B]: "03:" + NODE_C,
      [NODE_D]: "04:" + NODE_B,
    });
    const textC = await fs.readFile(
      path.join(root, "topics", TOPIC_DIR, NODE_C + ".md"),
      "utf8",
    );
    expect(textC).toContain("description: 从一到三（新）");
    expect(textC).not.toContain("flow: branch");
  });

  it("spec 缺字段／未知字段／flow／side／order 非法与 --input 互斥 → 退出码 2", async () => {
    const { root } = await newChainWorkspace();
    const specPath = path.join(os.tmpdir(), "aichat-rearrange-" + randomUUID() + ".json");
    temporaryRoots.push(specPath); // rm recursive 对文件同样有效

    const runSpec = async (value: unknown): Promise<{ code: number; stderr: string }> => {
      await fs.writeFile(specPath, JSON.stringify(value), "utf8");
      const outcome = await main(["rearrange", "--input", specPath, "--workspace", root]);
      return { code: outcome.exitCode, stderr: outcome.stderr };
    };

    const base = { ref: "r", fromRef: "f", flow: "next", description: "说明" };
    const cases: Array<[string, unknown, string]> = [
      ["顶层未知字段", { edits: [], extra: 1 }, "未知字段"],
      ["edits 为空", { edits: [] }, "非空数组"],
      ["缺 fromRef", { edits: [{ ref: "r", flow: "next", description: "d" }] }, "edits[0].fromRef"],
      ["flow 非法", { edits: [{ ...base, flow: "root" }] }, "edits[0].flow"],
      ["next 带 side", { edits: [{ ...base, side: "left" }] }, "edits[0].side"],
      ["order 为负", { edits: [{ ...base, flow: "branch", order: -1 }] }, "edits[0].order"],
      ["条目未知字段", { edits: [{ ...base, bogus: true }] }, "edits[0] 未知字段"],
    ];
    for (const [label, value, message] of cases) {
      const outcome = await runSpec(value);
      expect(outcome.code, label).toBe(2);
      expect(JSON.parse(outcome.stderr).error.message, label).toContain(message);
    }

    await fs.writeFile(specPath, "{", "utf8");
    const badJson = await main(["rearrange", "--input", specPath, "--workspace", root]);
    expect(badJson.exitCode).toBe(2);
    expect(JSON.parse(badJson.stderr).error.message).toContain("不是合法 JSON");

    const both = await main([
      "rearrange",
      "--input",
      specPath,
      "--input-stdin",
      "--workspace",
      root,
    ]);
    expect(both.exitCode).toBe(2);
    expect(JSON.parse(both.stderr).error.message).toContain("互斥");

    const neither = await main(["rearrange", "--workspace", root]);
    expect(neither.exitCode).toBe(2);
    expect(JSON.parse(neither.stderr).error.message).toContain("--input");
  });
});
