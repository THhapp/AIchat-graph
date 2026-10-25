import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type { ServiceHandle } from "../../src/service/index.js";

/**
 * lastChanges：每个稳定 topicId 独立保留最近一批真实写盘的节点。
 *
 * 全部用真实 startService + 真实磁盘。重点证明：
 * - 更新主题 B 不清除／覆盖主题 A；
 * - 同一批 apply 涉及多个主题时分别记录，共用同一个 at；
 * - 读取、重要性、导出、noop 与无变化重启都不重写记录；
 * - 文件跨重启恢复。
 */

const TOPIC_A = "t_" + "a".repeat(32);
const TOPIC_B = "t_" + "b".repeat(32);
const A_ROOT = "n_" + "1".repeat(32);
const B_ROOT = "n_" + "2".repeat(32);
const DIR_A = "主题甲";
const DIR_B = "主题乙";
const A_PATH = "topics/" + DIR_A + "/" + A_ROOT + ".md";
const B_PATH = "topics/" + DIR_B + "/" + B_ROOT + ".md";
const A_BODY = "甲主题的正文。";
const B_BODY = "乙主题的正文。";

interface TopicRecord {
  at: string;
  nodeIds: string[];
}

interface GraphBody {
  lastChanges?: Record<string, TopicRecord>;
}

const temporaryRoots: string[] = [];
const running: ServiceHandle[] = [];

function nodeFile(nodeId: string, title: string, body: string): string {
  return [
    "---",
    "nodeId: " + nodeId,
    "title: " + title,
    "state: agreed",
    "from: null",
    "flow: root",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function newTwoTopicWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-lastchange-topics-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "lastchange-topics" });

  await fs.mkdir(path.join(root, "topics", DIR_A), { recursive: true });
  await fs.writeFile(
    path.join(root, "topics", DIR_A, "topic.md"),
    "---\ntopicId: " + TOPIC_A + "\ntitle: " + DIR_A + "\n---\n",
    "utf8",
  );
  await fs.writeFile(path.join(root, ...A_PATH.split("/")), nodeFile(A_ROOT, "甲起点", A_BODY), "utf8");

  await fs.mkdir(path.join(root, "topics", DIR_B), { recursive: true });
  await fs.writeFile(
    path.join(root, "topics", DIR_B, "topic.md"),
    "---\ntopicId: " + TOPIC_B + "\ntitle: " + DIR_B + "\n---\n",
    "utf8",
  );
  await fs.writeFile(path.join(root, ...B_PATH.split("/")), nodeFile(B_ROOT, "乙起点", B_BODY), "utf8");

  return fs.realpath(root);
}

function lastChangePath(root: string): string {
  return path.join(root, ".aichat", "runtime", "last-change.json");
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

async function start(root: string): Promise<ServiceHandle> {
  const handle = await startService({ root, port: await freePort() });
  running.push(handle);
  return handle;
}

async function stop(handle: ServiceHandle): Promise<void> {
  const index = running.indexOf(handle);
  if (index >= 0) running.splice(index, 1);
  await handle.stop();
}

function clientHeaders(): Record<string, string> {
  return { "content-type": "application/json", "x-aichat-client": "cli" };
}

async function graphOf(handle: ServiceHandle): Promise<GraphBody> {
  const response = await fetch(handle.url + "/api/graph");
  expect(response.status).toBe(200);
  return (await response.json()) as GraphBody;
}

interface Edit {
  readonly nodeId: string;
  readonly relativePath: string;
  readonly operation: Record<string, unknown>;
}

/** 用真实低层 apply 提交一批 patchNode；expectedFiles 从当前磁盘读取。 */
async function applyEdits(
  handle: ServiceHandle,
  root: string,
  edits: readonly Edit[],
): Promise<{ state: string; changedNodeIds: string[] }> {
  const expectedFiles: Record<string, string> = {};
  for (const edit of edits) {
    const absolute = path.join(root, ...edit.relativePath.split("/"));
    expectedFiles[edit.relativePath] = sha256Hex(await fs.readFile(absolute, "utf8"));
  }
  const response = await fetch(handle.url + "/api/changes", {
    method: "POST",
    headers: clientHeaders(),
    body: JSON.stringify({
      workspaceId: handle.workspaceId,
      requestId: randomUUID(),
      expectedFiles,
      operations: edits.map((edit) => ({
        op: "patchNode",
        nodeId: edit.nodeId,
        ...edit.operation,
      })),
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { state: string; changedNodeIds: string[] };
}

function bodyEdit(nodeId: string, relativePath: string, oldText: string, newText: string): Edit {
  return { nodeId, relativePath, operation: { replace: [{ old: oldText, new: newText }] } };
}

async function readRecordFile(root: string): Promise<{
  schemaVersion: number;
  topics: Record<string, TopicRecord>;
}> {
  return JSON.parse(await fs.readFile(lastChangePath(root), "utf8")) as {
    schemaVersion: number;
    topics: Record<string, TopicRecord>;
  };
}

afterEach(async () => {
  for (const handle of running.splice(0)) {
    await handle.stop().catch(() => undefined);
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("lastChanges 按主题独立保留", () => {
  it("先改 A 再改 B：A 的原记录保持不变，B 新增", async () => {
    const root = await newTwoTopicWorkspace();
    const handle = await start(root);

    expect((await graphOf(handle)).lastChanges).toBeUndefined();

    const first = await applyEdits(handle, root, [bodyEdit(A_ROOT, A_PATH, A_BODY, "甲主题改过一次。")]);
    expect(first.state).toBe("committed");

    const afterA = await graphOf(handle);
    expect(afterA.lastChanges?.[TOPIC_A]?.nodeIds).toEqual([A_ROOT]);
    expect(afterA.lastChanges?.[TOPIC_B]).toBeUndefined();
    const recordA = afterA.lastChanges?.[TOPIC_A];
    expect(recordA).toBeDefined();

    const second = await applyEdits(handle, root, [bodyEdit(B_ROOT, B_PATH, B_BODY, "乙主题改过一次。")]);
    expect(second.state).toBe("committed");

    const afterB = await graphOf(handle);
    // 更新 B 不清除或覆盖 A。
    expect(afterB.lastChanges?.[TOPIC_A]).toEqual(recordA);
    expect(afterB.lastChanges?.[TOPIC_B]?.nodeIds).toEqual([B_ROOT]);
  });

  it("同一批 apply 改 A、B：两个主题都有记录，共用同一个 at，各含本主题节点", async () => {
    const root = await newTwoTopicWorkspace();
    const handle = await start(root);

    const applied = await applyEdits(handle, root, [
      bodyEdit(A_ROOT, A_PATH, A_BODY, "同一批里改甲。"),
      bodyEdit(B_ROOT, B_PATH, B_BODY, "同一批里改乙。"),
    ]);
    expect(applied.state).toBe("committed");
    expect(new Set(applied.changedNodeIds)).toEqual(new Set([A_ROOT, B_ROOT]));

    const changes = (await graphOf(handle)).lastChanges;
    expect(changes).toBeDefined();
    expect(Object.keys(changes ?? {}).sort()).toEqual([TOPIC_A, TOPIC_B].sort());
    expect(changes?.[TOPIC_A]?.nodeIds).toEqual([A_ROOT]);
    expect(changes?.[TOPIC_B]?.nodeIds).toEqual([B_ROOT]);
    expect(changes?.[TOPIC_A]?.at).toBe(changes?.[TOPIC_B]?.at);

    const file = await readRecordFile(root);
    expect(file.schemaVersion).toBe(2);
    expect(file.topics[TOPIC_A]?.nodeIds).toEqual([A_ROOT]);
    expect(file.topics[TOPIC_B]?.nodeIds).toEqual([B_ROOT]);
    expect(file.topics[TOPIC_A]?.at).toBe(file.topics[TOPIC_B]?.at);
  });

  it("重要性、读取、导出、noop 与无变化重启都不改变记录，也不重写文件", async () => {
    const root = await newTwoTopicWorkspace();
    const handle = await start(root);

    await applyEdits(handle, root, [bodyEdit(A_ROOT, A_PATH, A_BODY, "记录之后不乱动。")]);
    const recorded = (await graphOf(handle)).lastChanges;
    expect(recorded?.[TOPIC_A]?.nodeIds).toEqual([A_ROOT]);

    // 给 mtime 留出可观察间隔；任何重写都会改变它。
    await new Promise((resolve) => setTimeout(resolve, 25));
    const beforeText = await fs.readFile(lastChangePath(root), "utf8");
    const beforeStat = await fs.stat(lastChangePath(root));

    // 仅元数据：不产生也不替换内容记录。
    const importance = await fetch(handle.url + "/api/importance", {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ topicId: TOPIC_A, nodeId: A_ROOT, important: true }),
    });
    expect(importance.status).toBe(200);

    // 只读路径。
    await graphOf(handle);
    await fetch(handle.url + "/api/nodes/" + A_ROOT);
    await fetch(handle.url + "/api/topics/" + TOPIC_A);
    const exportStatus = await fetch(handle.url + "/api/exports");
    expect(exportStatus.status).toBe(200);

    // 真实导出：绑定一个临时目标并重试；导出只读快照，不写内容记录。
    const target = path.join(path.dirname(root), "export-a.html");
    const bind = await fetch(handle.url + "/api/exports/" + TOPIC_A + "/target", {
      method: "PUT",
      headers: clientHeaders(),
      body: JSON.stringify({ path: target }),
    });
    expect(bind.status).toBe(200);
    const retry = await fetch(handle.url + "/api/exports/" + TOPIC_A + "/retry", {
      method: "POST",
      headers: clientHeaders(),
    });
    expect(retry.status).toBe(200);

    // 无实际改动的提交：noop，不重写记录。
    const noop = await applyEdits(handle, root, [
      { nodeId: A_ROOT, relativePath: A_PATH, operation: { title: "甲起点" } },
    ]);
    expect(noop.state).toBe("noop");

    expect((await graphOf(handle)).lastChanges).toEqual(recorded);

    // 无变化重启（重连）只读回记录，不写文件。
    await stop(handle);
    const again = await start(root);
    expect((await graphOf(again)).lastChanges).toEqual(recorded);

    expect(await fs.readFile(lastChangePath(root), "utf8")).toBe(beforeText);
    expect((await fs.stat(lastChangePath(root))).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("重启后从文件恢复各主题记录", async () => {
    const root = await newTwoTopicWorkspace();
    const first = await start(root);
    await applyEdits(first, root, [bodyEdit(A_ROOT, A_PATH, A_BODY, "重启前改甲。")]);
    await applyEdits(first, root, [bodyEdit(B_ROOT, B_PATH, B_BODY, "重启前改乙。")]);
    const recorded = (await graphOf(first)).lastChanges;
    expect(recorded?.[TOPIC_A]?.nodeIds).toEqual([A_ROOT]);
    expect(recorded?.[TOPIC_B]?.nodeIds).toEqual([B_ROOT]);
    await stop(first);

    const again = await start(root);
    expect((await graphOf(again)).lastChanges).toEqual(recorded);
  });

  it("损坏的记录文件按空记录处理，不阻断启动也不写回", async () => {
    const root = await newTwoTopicWorkspace();
    await fs.mkdir(path.dirname(lastChangePath(root)), { recursive: true });
    const corrupt = "{ not json";
    await fs.writeFile(lastChangePath(root), corrupt, "utf8");

    const handle = await start(root);
    const graph = await graphOf(handle);
    expect(graph.lastChanges).toBeUndefined();
    expect(await fs.readFile(lastChangePath(root), "utf8")).toBe(corrupt);
  });
});
