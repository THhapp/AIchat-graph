import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { main } from "../../src/cli/index.js";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";

/**
 * A01：在"来源最多一个 next"的保护下，用现有 connect／next 完成整体重连。
 *
 * 目标结构：A → B → D 改成 A → C → B → D。
 * 顺序必须"先腾空目标来源的 next，再接入"：把 B 降为 A 的 branch → 给 A 建 next C →
 * 把 B 接到 C 后面。每一步都是合法图，不需要临时 branch 之外的任何新 API。
 */

const TOPIC_ID = "t_" + "3".repeat(32);
const A = "n_" + "1".repeat(32);
const B = "n_" + "2".repeat(32);
const D = "n_" + "4".repeat(32);
const DIR = "重连";

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

let parent: string;
let root: string;
let handle: ServiceHandle;

beforeAll(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-rewire-"));
  root = path.join(parent, "workspace");
  const files: Record<string, string> = {
    "workspace.json":
      JSON.stringify({ schemaVersion: 2, workspaceId: "w_cli_rewire", name: "rewire", activeNode: null }, null, 2) +
      "\n",
    ["topics/" + DIR + "/topic.md"]: ["---", "topicId: " + TOPIC_ID, "title: " + DIR, "---", ""].join("\n"),
    ["topics/" + DIR + "/" + A + ".md"]: nodeFile({
      nodeId: A,
      title: "起点",
      from: null,
      flow: "root",
      body: "起点正文。",
    }),
    ["topics/" + DIR + "/" + B + ".md"]: nodeFile({
      nodeId: B,
      title: "中间",
      from: A,
      flow: "next",
      description: "从起点继续",
      body: "中间正文。",
    }),
    ["topics/" + DIR + "/" + D + ".md"]: nodeFile({
      nodeId: D,
      title: "结尾",
      from: B,
      flow: "next",
      description: "从中间继续",
      body: "结尾正文。",
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

interface NodeView {
  id: string;
  number: string;
  from: string | null;
  flow: string;
}

async function graphNodes(): Promise<NodeView[]> {
  const response = await fetch(handle.url + "/api/graph");
  const body = (await response.json()) as {
    nodes: Array<{ id: string; number: string; from: string | null; flow: string }>;
  };
  return body.nodes.map((node) => ({
    id: node.id,
    number: node.number,
    from: node.from,
    flow: node.flow,
  }));
}

/** 后继只能从 from+flow 反查：GraphNode DTO 不导出 nextId。 */
function nextOf(nodes: readonly NodeView[], nodeId: string): string | null {
  return nodes.find((node) => node.from === nodeId && node.flow === "next")?.id ?? null;
}

async function refOf(nodeId: string): Promise<string> {
  const result = await main(["read", "--node", nodeId, "--workspace", root]);
  expect(result.exitCode).toBe(0);
  const body = JSON.parse(result.stdout) as { nodes: Array<{ editRef?: { ref?: string } }> };
  const ref = body.nodes[0]?.editRef?.ref;
  expect(typeof ref).toBe("string");
  return ref as string;
}

async function run(args: string[]): Promise<number> {
  const result = await main([...args, "--workspace", root]);
  return result.exitCode;
}

describe("A01：整体重连的受控顺序", () => {
  it("先腾空来源的 next，再接入：A→B→D 变为 A→C→B→D", async () => {
    // 反例：A 已有 next B 时，直接给 A 建 next 必须是 409，不自动插入。
    const blocked = await main([
      "next",
      "--from-ref",
      await refOf(A),
      "--title",
      "提前插入",
      "--description",
      "直接插到 A 后面",
      "--body",
      "不该成功。",
      "--workspace",
      root,
    ]);
    expect(blocked.exitCode).toBe(5);
    const error = JSON.parse(blocked.stderr) as { error: { code: string } };
    expect(error.error.code).toBe("OPERATION_CONFLICT");

    // 1) 把 B 降为 A 的旁支：A 的 next 被腾空，旧连线自动解除。
    expect(
      await run([
        "connect",
        "--ref",
        await refOf(B),
        "--from-ref",
        await refOf(A),
        "--flow",
        "branch",
        "--description",
        "暂作旁支以便插入新的一步",
      ]),
    ).toBe(0);
    const afterDetach = await graphNodes();
    expect(afterDetach.find((node) => node.id === B)?.flow).toBe("branch");
    expect(nextOf(afterDetach, A)).toBeNull();
    // B 的后继不受影响。
    expect(nextOf(afterDetach, B)).toBe(D);

    // 2) 给 A 建一条新的 next：C。
    expect(
      await run([
        "next",
        "--from-ref",
        await refOf(A),
        "--title",
        "插入的一步",
        "--description",
        "在起点与中间之间补一步",
        "--body",
        "插入正文。",
      ]),
    ).toBe(0);
    const graph = await graphNodes();
    const c = graph.find((node) => node.flow === "next" && node.from === A);
    expect(c).toBeDefined();
    const cId = c?.id as string;
    expect(nextOf(graph, A)).toBe(cId);
    expect(graph.find((node) => node.id === cId)?.number).toBe("02");
    // B 此时仍是旁支（01-01），编号在最后接回主线后才回到 03。
    expect(graph.find((node) => node.id === B)?.flow).toBe("branch");

    // 3) 把 B 接到 C 后面：现在 C 没有 next，接得上。
    expect(
      await run([
        "connect",
        "--ref",
        await refOf(B),
        "--from-ref",
        await refOf(cId),
        "--flow",
        "next",
        "--description",
        "接在插入的一步之后",
      ]),
    ).toBe(0);

    const final = await graphNodes();
    expect(nextOf(final, A)).toBe(cId);
    expect(nextOf(final, cId)).toBe(B);
    expect(nextOf(final, B)).toBe(D);
    expect(final.find((node) => node.id === B)?.from).toBe(cId);
    expect(final.map((node) => node.number).sort()).toEqual(["01", "02", "03", "04"]);
  });
});
