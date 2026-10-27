/**
 * edit 复合动作在真实服务上的回归：内容＋入边说明／来源＋重要性一次事务，
 * metadata-only 不读 stdin，root 改入边由服务整体拒绝。
 *
 * 合成临时工作区 + 进程内 startService；不接触真实资料。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";
import { main } from "../../src/cli/index.js";
import { EXIT_CODES } from "../../src/cli/errors.js";

const TOPIC_ID = "t_" + "4".repeat(32);
const A = "n_" + "a".repeat(32);
const B = "n_" + "b".repeat(32);
const C = "n_" + "c".repeat(32);
const DIR = "编辑";
let parent: string;
let root: string;
let handle: ServiceHandle;

function nodeFile(options: {
  nodeId: string;
  title: string;
  from: string | null;
  flow: "root" | "next" | "branch";
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
  if (options.description !== undefined) {
    lines.push("description: " + options.description);
  }
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

function nodePath(nodeId: string): string {
  return path.join(root, "topics", DIR, nodeId + ".md");
}

async function textOf(nodeId: string): Promise<string> {
  return fs.readFile(nodePath(nodeId), "utf8");
}

async function refsOf(nodeIds: readonly string[]): Promise<Record<string, string>> {
  const args: string[] = [];
  for (const nodeId of nodeIds) args.push("--node", nodeId);
  const result = await main(["read", ...args, "--workspace", root]);
  expect(result.exitCode, result.stderr).toBe(0);
  const body = JSON.parse(result.stdout) as { refs: Record<string, string> };
  return body.refs;
}

function jsonOf(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

async function graphOf(): Promise<{
  nodes: Array<{
    id: string;
    title: string;
    flow: string;
    from: string | null;
    important: boolean;
    description?: string;
  }>;
  lastChanges?: Record<string, { nodeIds: string[] }>;
}> {
  return (await (await fetch(handle.url + "/api/graph")).json()) as {
    nodes: Array<{
      id: string;
      title: string;
      flow: string;
      from: string | null;
      important: boolean;
      description?: string;
    }>;
    lastChanges?: Record<string, { nodeIds: string[] }>;
  };
}

beforeAll(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-edit-live-"));
  const created = await initWorkspace({ root: path.join(parent, "workspace"), name: "edit live" });
  root = created.root;
  const dir = path.join(root, "topics", DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: 编辑\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, A + ".md"),
    nodeFile({ nodeId: A, title: "甲", from: null, flow: "root", body: "甲正文。" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, B + ".md"),
    nodeFile({
      nodeId: B,
      title: "乙",
      from: A,
      flow: "next",
      body: "乙正文。",
      description: "甲到乙",
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, C + ".md"),
    nodeFile({
      nodeId: C,
      title: "丙",
      from: B,
      flow: "next",
      body: "丙正文。",
      description: "乙到丙",
    }),
    "utf8",
  );
  handle = await startService({ root, port: await freePort() });
});

afterAll(async () => {
  await handle?.stop();
  await fs.rm(parent, { recursive: true, force: true });
});

describe("真实服务：edit 复合动作", () => {
  it("内容＋入边说明／来源＋重要性一次提交，文件与图同步", async () => {
    const refs = await refsOf([A, B]);
    const result = await main([
      "edit",
      "--ref",
      refs[B] as string,
      "--title",
      "乙（综合修改）",
      "--summary",
      "综合摘要",
      "--important",
      "true",
      "--from-ref",
      refs[A] as string,
      "--flow",
      "branch",
      "--description",
      "改成从甲旁出",
      "--workspace",
      root,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = jsonOf(result.stdout);
    expect(payload["state"]).toBe("committed");
    expect(payload["changedNodeIds"]).toContain(B);
    const refsOut = payload["refs"] as Record<string, string>;
    expect(typeof refsOut[B]).toBe("string");

    const text = await textOf(B);
    expect(text).toContain("title: 乙（综合修改）");
    expect(text).toContain("summary: 综合摘要");
    expect(text).toContain("important: true");
    expect(text).toContain("flow: branch");
    expect(text).toContain("from: " + A);
    expect(text).toContain("description: 改成从甲旁出");

    const graph = await graphOf();
    expect(graph.nodes.find((node) => node.id === B)).toMatchObject({
      title: "乙（综合修改）",
      flow: "branch",
      from: A,
      important: true,
      description: "改成从甲旁出",
    });
    // 内容真实改写进入最近更新。
    expect(graph.lastChanges?.[TOPIC_ID]?.nodeIds).toContain(B);

    const validated = await main(["validate", "--workspace", root]);
    expect(validated.exitCode, validated.stderr).toBe(0);
  });

  it("root 节点改入边整体 422（结构错误），源文件不变", async () => {
    const refs = await refsOf([A]);
    const before = await fs.readFile(nodePath(A));
    const result = await main([
      "edit",
      "--ref",
      refs[A] as string,
      "--description",
      "root 不该有入边",
      "--workspace",
      root,
    ]);
    expect(result.exitCode).toBe(EXIT_CODES.validation);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(payload.error.code).toBe("VALIDATION_FAILED");
    expect(payload.error.message).toContain("根节点");
    expect(payload.error.details["category"]).toBe("structure");
    expect(payload.error.details["field"]).toBe("description");
    expect(payload.error.details["nodeId"]).toBe(A);
    expect(await fs.readFile(nodePath(A))).toEqual(before);
  });

  it("metadata-only（--clear-summary）不读 stdin，只删显式摘要", async () => {
    const refs = await refsOf([B]);
    let stdinReads = 0;
    const result = await main(
      ["edit", "--ref", refs[B] as string, "--clear-summary", "--workspace", root],
      {
        stdin: async () => {
          stdinReads += 1;
          return "不应被读取";
        },
      },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(stdinReads).toBe(0);
    const text = await textOf(B);
    expect(text).not.toContain("summary:");
    // 其他字段保持：标题与重要标记仍是上一步的值。
    expect(text).toContain("title: 乙（综合修改）");
    expect(text).toContain("important: true");
  });

  it("只给 --flow + --description：保留当前来源，只改关系类型", async () => {
    const refs = await refsOf([B]);
    const result = await main([
      "edit",
      "--ref",
      refs[B] as string,
      "--flow",
      "next",
      "--description",
      "改回主线继续",
      "--workspace",
      root,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const text = await textOf(B);
    expect(text).toContain("flow: next");
    expect(text).toContain("from: " + A);
    expect(text).toContain("description: 改回主线继续");
  });
});
