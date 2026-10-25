import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";
import { main } from "../../src/cli/index.js";

/**
 * A01：纵向链的重排不需要临时 branch。
 *
 * 约束只有一条：来源最多一个 next。据此可执行顺序是"先腾空目标来源的 next，
 * 再从链尾往链头接回"；每一步都是现有 connect，且每一步都通过整图校验。
 * 这里用真实服务 + 真实 CLI 证明 A → B → C 能重排成 A → C → B。
 */

const TOPIC_ID = "t_" + "5".repeat(32);
const A = "n_" + "1".repeat(32);
const B = "n_" + "2".repeat(32);
const C = "n_" + "3".repeat(32);
const DIR = "讨论";

let parent = "";
let root = "";
let handle: ServiceHandle;

function nodeFile(options: {
  nodeId: string;
  title: string;
  from: string | null;
  flow: "root" | "next" | "branch";
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
  lines.push("---", "", options.title + "的正文。", "");
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

interface NodeView {
  id: string;
  from: string | null;
  flow: string;
}

async function graphNodes(): Promise<Map<string, NodeView>> {
  const body = (await (await fetch(handle.url + "/api/graph")).json()) as { nodes: NodeView[] };
  return new Map(body.nodes.map((node) => [node.id, node]));
}

async function refOf(nodeId: string): Promise<string> {
  const result = await main(["read", "--node", nodeId, "--workspace", root]);
  expect(result.exitCode).toBe(0);
  const body = JSON.parse(result.stdout) as { nodes: Array<{ editRef?: { ref?: string } }> };
  const ref = body.nodes[0]?.editRef?.ref;
  expect(typeof ref).toBe("string");
  return ref as string;
}

beforeAll(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-reconnect-"));
  root = path.join(parent, "workspace");
  const topicDir = path.join(root, "topics", DIR);
  await fs.mkdir(topicDir, { recursive: true });
  await fs.writeFile(
    path.join(root, "workspace.json"),
    JSON.stringify({ schemaVersion: 2, workspaceId: "w_reconnect", name: "reconnect", activeNode: null }, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: 条目整理\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, A + ".md"),
    nodeFile({ nodeId: A, title: "A", from: null, flow: "root" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, B + ".md"),
    nodeFile({ nodeId: B, title: "B", from: A, flow: "next", description: "A 之后先到 B" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, C + ".md"),
    nodeFile({ nodeId: C, title: "C", from: B, flow: "next", description: "B 之后到 C" }),
    "utf8",
  );
  handle = await startService({ root, port: await freePort() });
});

afterAll(async () => {
  await handle?.stop();
  await fs.rm(parent, { recursive: true, force: true });
});

describe("A01 纵向链重排（真实 CLI）", () => {
  it("直接插队会被明确拒绝，而不是静默挤掉旧 next", async () => {
    const cRef = await refOf(C);
    const aRef = await refOf(A);
    const result = await main([
      "connect",
      "--ref",
      cRef,
      "--from-ref",
      aRef,
      "--flow",
      "next",
      "--description",
      "想让 C 直接接在 A 后面",
      "--workspace",
      root,
    ]);
    expect(result.exitCode).toBe(5); // operationConflict
    expect(result.stderr).toContain("next");
    const nodes = await graphNodes();
    expect(nodes.get(B)?.from).toBe(A);
    expect(nodes.get(C)?.from).toBe(B);
  });

  it("先腾空、再接入：A→B→C 变成 A→C→B，全程只用 connect", async () => {
    // 1) 把 B 改成旁支，腾出 A 的 next。
    const bRef = await refOf(B);
    const branch = await main([
      "connect",
      "--ref",
      bRef,
      "--flow",
      "branch",
      "--description",
      "临时把 B 挪成旁支以腾出主线的 next",
      "--workspace",
      root,
    ]);
    expect(branch.exitCode).toBe(0);
    expect((await graphNodes()).get(B)?.flow).toBe("branch");

    // 2) C 接到 A 的 next（A 此时没有 next）。
    const cRef = await refOf(C);
    const aRef = await refOf(A);
    const attachC = await main([
      "connect",
      "--ref",
      cRef,
      "--from-ref",
      aRef,
      "--flow",
      "next",
      "--description",
      "C 现在成为主线头",
      "--workspace",
      root,
    ]);
    expect(attachC.exitCode).toBe(0);
    expect((await graphNodes()).get(C)?.from).toBe(A);

    // 3) B 接到 C 的 next（C 此时没有 next）。
    const bRef2 = await refOf(B);
    const cRef2 = await refOf(C);
    const attachB = await main([
      "connect",
      "--ref",
      bRef2,
      "--from-ref",
      cRef2,
      "--flow",
      "next",
      "--description",
      "B 回到主线，排在 C 之后",
      "--workspace",
      root,
    ]);
    expect(attachB.exitCode).toBe(0);

    const nodes = await graphNodes();
    expect(nodes.get(A)?.flow).toBe("root");
    expect(nodes.get(C)?.from).toBe(A);
    expect(nodes.get(C)?.flow).toBe("next");
    expect(nodes.get(B)?.from).toBe(C);
    expect(nodes.get(B)?.flow).toBe("next");
  });

  it("每一步之后都有一个成功提交，lastChanges 只指向该步真正改写的节点", async () => {
    const body = (await (await fetch(handle.url + "/api/graph")).json()) as {
      lastChanges?: Record<string, { nodeIds: string[] }>;
    };
    expect(body.lastChanges?.[TOPIC_ID]?.nodeIds).toEqual([B]);
  });
});
