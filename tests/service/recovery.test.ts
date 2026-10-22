import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { initWorkspace, sha256Bytes } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";

const temporaryRoots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

const NODE = "n_" + "a".repeat(32);
const TOPIC_ID = "t_" + "b".repeat(32);
const TOPIC_PATH = "topics/topic.md";
const TOPIC_TEXT = [
  "---",
  "schemaVersion: 1",
  "topicId: " + TOPIC_ID,
  "title: 恢复样例",
  "nodes:",
  "  " + NODE + ":",
  "    from: null",
  "    flow: root",
  "    state: agreed",
  "---",
  "",
  "## 首卡 <!-- node:" + NODE + " -->",
  "",
  "恢复后的正文。",
  "",
].join("\n");

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

async function newWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-recovery-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "recovery", schemaVersion: 1 });
  await fs.writeFile(path.join(root, ...TOPIC_PATH.split("/")), TOPIC_TEXT, "utf8");
  return fs.realpath(root);
}

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("committed 日志的启动核对", () => {
  it("已提交且磁盘可重建时，先重建有效快照再清理日志", async () => {
    const root = await newWorkspace();
    const transactionId = "20260101T000000Z-recoveryaaaa";
    const dir = path.join(root, ".aichat", "runtime", "transactions", transactionId);
    await fs.mkdir(path.join(dir, "before"), { recursive: true });
    await fs.mkdir(path.join(dir, "after"), { recursive: true });
    const beforeText = "旧内容\n";
    await fs.writeFile(
      path.join(dir, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        transactionId,
        state: "committed",
        createdAt: "2026-01-01T00:00:00.000Z",
        requestId: "8f8fad5b-d9cb-469f-a165-70867728950e",
        files: [
          {
            path: TOPIC_PATH,
            existedBefore: true,
            beforeSha256: sha256Bytes(beforeText),
            beforeBytes: Buffer.byteLength(beforeText),
            afterSha256: sha256Bytes(TOPIC_TEXT),
            afterBytes: Buffer.byteLength(TOPIC_TEXT),
          },
        ],
      }),
      "utf8",
    );

    const port = await freePort();
    const handle = await startService({ root, port });
    running.push(handle);
    // 日志在快照可用后被清理。
    await expect(fs.access(dir)).rejects.toBeTruthy();
    const graph = (await (await fetch(handle.url + "/api/graph")).json()) as {
      nodes: Array<{ id: string }>;
      stale: boolean;
    };
    expect(graph.nodes.map((node) => node.id)).toEqual([NODE]);
    expect(graph.stale).toBe(false);
  });

  it("已提交但当前磁盘无法重建时保留日志并停用写入", async () => {
    const root = await newWorkspace();
    const transactionId = "20260101T000000Z-recoverybbbb";
    const dir = path.join(root, ".aichat", "runtime", "transactions", transactionId);
    await fs.mkdir(path.join(dir, "after"), { recursive: true });
    const broken = "---\nschemaVersion: 1\n";
    await fs.writeFile(path.join(root, ...TOPIC_PATH.split("/")), broken, "utf8");
    await fs.writeFile(
      path.join(dir, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        transactionId,
        state: "committed",
        createdAt: "2026-01-01T00:00:00.000Z",
        files: [
          {
            path: TOPIC_PATH,
            existedBefore: true,
            beforeSha256: sha256Bytes("old"),
            beforeBytes: 3,
            afterSha256: sha256Bytes(broken),
            afterBytes: Buffer.byteLength(broken),
          },
        ],
      }),
      "utf8",
    );

    const port = await freePort();
    const handle = await startService({ root, port });
    running.push(handle);
    await fs.access(dir);
    const workspace = (await (await fetch(handle.url + "/api/workspace")).json()) as {
      stale: boolean;
      diagnostics: Array<{ code: string }>;
    };
    expect(workspace.stale).toBe(true);
    expect(
      workspace.diagnostics.some((item) => item.code === "COMMITTED_REFRESH_PENDING"),
    ).toBe(true);

    const apply = await fetch(handle.url + "/api/changes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-aichat-client": "cli" },
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: "9f8fad5b-d9cb-469f-a165-70867728950e",
        expectedFiles: { [TOPIC_PATH]: sha256Bytes(broken) },
        operations: [{ op: "updateNode", nodeId: NODE, body: "不应写入" }],
      }),
    });
    expect(apply.status).toBe(409);
    expect(((await apply.json()) as { error: { code: string } }).error.code).toBe("WRITE_DISABLED");
    expect(await fs.readFile(path.join(root, ...TOPIC_PATH.split("/")), "utf8")).toBe(broken);
  });
});