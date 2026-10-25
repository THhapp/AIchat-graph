/**
 * 回归：重要标记（important）必须参与导出内容指纹。
 *
 * 复现过的缺口：POST /api/importance 成功、图里已生效，但已绑定的离线 HTML
 * 不重建（lastSuccessAt 不变、成品仍是 important:false），使"图和独立 HTML"不一致。
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import { computeContentFingerprint, renderTopicHtml } from "../../src/export/index.js";
import type { GraphNode, OfflineTopicDocument } from "../../src/shared/protocol.js";

const temporaryRoots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

const ROOT_NODE = "n_" + "a".repeat(32);
const NEXT_NODE = "n_" + "b".repeat(32);
const TOPIC_ID = "t_" + "c".repeat(32);
const OTHER_NODE = "n_" + "d".repeat(32);
const OTHER_TOPIC_ID = "t_" + "e".repeat(32);
const DIR = "导出";
const OTHER_DIR = "无关主题";

function nodeFile(
  nodeId: string,
  title: string,
  flow: "root" | "next",
  from: string | null,
  body: string,
  important = false,
): string {
  const lines = [
    "---",
    "nodeId: " + nodeId,
    "title: " + title,
    "state: agreed",
    "from: " + (from ?? "null"),
    "flow: " + flow,
    "important: " + String(important),
  ];
  if (from !== null) lines.push("description: 承接上一张卡片");
  lines.push("---", "", body, "");
  return lines.join("\n");
}

async function newWorkspace(options: { importantRoot?: boolean } = {}): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-export-importance-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "export-importance-test" });
  const topicDir = path.join(root, "topics", DIR);
  await fs.mkdir(topicDir, { recursive: true });
  await fs.writeFile(
    path.join(topicDir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: 重要标记样例\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, ROOT_NODE + ".md"),
    nodeFile(ROOT_NODE, "起点", "root", null, "第一段正文。", options.importantRoot === true),
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, NEXT_NODE + ".md"),
    nodeFile(NEXT_NODE, "继续", "next", ROOT_NODE, "第二段正文。"),
    "utf8",
  );
  // 另一个无关主题：它的变化不能让已绑定的成品重写。
  const otherDir = path.join(root, "topics", OTHER_DIR);
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(
    path.join(otherDir, "topic.md"),
    "---\ntopicId: " + OTHER_TOPIC_ID + "\ntitle: 无关主题\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(otherDir, OTHER_NODE + ".md"),
    nodeFile(OTHER_NODE, "无关起点", "root", null, "与导出主题无关的正文。"),
    "utf8",
  );
  return fs.realpath(root);
}

async function newOutputDir(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-export-importance-out-"));
  temporaryRoots.push(parent);
  return fs.realpath(parent);
}

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

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function headers(): Record<string, string> {
  return { "content-type": "application/json", "x-aichat-client": "cli" };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error("等待导出状态超时");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface StatusView {
  topicId: string;
  state: string;
  sourceFingerprint: string | null;
  exportedFingerprint: string | null;
  lastSuccessAt: string | null;
  error: string | null;
}

async function statusOf(url: string, topicId: string): Promise<StatusView> {
  const body = (await (await fetch(url + "/api/exports")).json()) as { topics: StatusView[] };
  const status = body.topics.find((entry) => entry.topicId === topicId);
  if (status === undefined) throw new Error("缺少主题状态");
  return status;
}

async function setImportant(url: string, nodeId: string, important: boolean): Promise<void> {
  const response = await fetch(url + "/api/importance", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ topicId: TOPIC_ID, nodeId, important }),
  });
  expect(response.status).toBe(200);
}

/** 成品里该节点的 important 值（直接从内嵌数据块读，不靠文案推断）。 */
function importantOf(html: string, nodeId: string): boolean | null {
  const match = new RegExp(
    '\\{"id":"' + nodeId + '"[^}]*?"important":(true|false)',
  ).exec(html);
  if (match === null) return null;
  return match[1] === "true";
}

interface SyncedFixture {
  readonly root: string;
  readonly target: string;
  readonly handle: { url: string };
  /** 绑定后第一次导出完成时的状态；后续用例都以它为基线。 */
  readonly initial: StatusView;
}

/**
 * 每个用例各自建一次现场：独立工作区 + 独立输出目录 + 独立服务实例与端口。
 *
 * 用例之间不共享任何运行时状态（工作区、端口、导出配置、监听器），
 * 因此可以与其他测试文件并行执行，不会互相占用同一份 writer.lock 或端口。
 */
async function bindAndSync(options: { importantRoot?: boolean } = {}): Promise<SyncedFixture> {
  const root = await newWorkspace(options);
  const output = await newOutputDir();
  const handle = await startService({ root, port: await freePort() });
  running.push(handle);

  const target = path.join(output, "topic.html");
  const bound = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ path: target }),
  });
  expect(bound.status).toBe(200);
  await waitFor(async () => (await statusOf(handle.url, TOPIC_ID)).state === "ready");

  return { root, target, handle, initial: await statusOf(handle.url, TOPIC_ID) };
}

/** 等到成品文件不再变化（连续两次采样 mtime+size 相同），用于断言"没有发生重写"。 */
async function waitUntilFileQuiet(
  absolute: string,
  quietMs = 300,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStamp = "";
  let stableSince = 0;
  for (;;) {
    const stat = await fs.stat(absolute).catch(() => null);
    const stamp =
      stat === null ? "missing" : String(stat.mtimeMs) + ":" + String(stat.size);
    const now = Date.now();
    if (stamp !== lastStamp) {
      lastStamp = stamp;
      stableSince = now;
    } else if (now - stableSince >= quietMs) {
      return;
    }
    if (now > deadline) throw new Error("等待成品文件稳定超时");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("重要标记与离线导出", () => {
  it("设为重要会重建成品，指纹随之改变", async () => {
    const { target, handle, initial } = await bindAndSync();

    const firstHtml = await fs.readFile(target, "utf8");
    expect(importantOf(firstHtml, ROOT_NODE)).toBe(false);
    expect(initial.exportedFingerprint).toBe(initial.sourceFingerprint);

    // 设为重要：成品必须重建，节点变成 important:true。
    // 等到"这一次变更后的成品"用完成为止：状态 ready、文件里已是新值、
    // 已导出指纹追平源指纹。只看 ready 会在上一次导出的状态上立即满足。
    await setImportant(handle.url, ROOT_NODE, true);
    await waitFor(async () => {
      const status = await statusOf(handle.url, TOPIC_ID);
      return (
        status.state === "ready" &&
        status.exportedFingerprint === status.sourceFingerprint &&
        importantOf(await fs.readFile(target, "utf8"), ROOT_NODE) === true
      );
    });
    const afterSet = await statusOf(handle.url, TOPIC_ID);
    expect(afterSet.state).toBe("ready");
    expect(afterSet.exportedFingerprint).toBe(afterSet.sourceFingerprint);
    // lastSuccessAt 只是秒/毫秒级时间戳，两次导出可能同值；重建的判据用内容指纹。
    expect(afterSet.exportedFingerprint).not.toBe(initial.exportedFingerprint);
    const setHtml = await fs.readFile(target, "utf8");
    expect((setHtml.match(/"important":true/g) ?? []).length).toBe(1);
  });

  it("取消重要会重建成品并回到 false，指纹也随之改变", async () => {
    const { target, handle, initial } = await bindAndSync({ importantRoot: true });

    const markedHtml = await fs.readFile(target, "utf8");
    expect(importantOf(markedHtml, ROOT_NODE)).toBe(true);
    expect((markedHtml.match(/"important":true/g) ?? []).length).toBe(1);
    expect(initial.exportedFingerprint).toBe(initial.sourceFingerprint);

    await setImportant(handle.url, ROOT_NODE, false);
    await waitFor(async () => {
      const status = await statusOf(handle.url, TOPIC_ID);
      return (
        status.state === "ready" &&
        status.exportedFingerprint === status.sourceFingerprint &&
        importantOf(await fs.readFile(target, "utf8"), ROOT_NODE) === false
      );
    });
    const afterUnset = await statusOf(handle.url, TOPIC_ID);
    expect(afterUnset.state).toBe("ready");
    expect(afterUnset.exportedFingerprint).toBe(afterUnset.sourceFingerprint);
    expect(afterUnset.exportedFingerprint).not.toBe(initial.exportedFingerprint);
    expect((await fs.readFile(target, "utf8")).match(/"important":true/g) ?? []).toHaveLength(0);
  });

  it("重复提交同一 important 值不改文件、不重导", async () => {
    const { target, handle, initial } = await bindAndSync();
    const stableHtml = await fs.readFile(target, "utf8");

    // 值与当前一致：不改文件、不产生事务、不改基线。
    await setImportant(handle.url, ROOT_NODE, false);
    // 先等成品文件稳定，再比较，避免并行慢时把"还没跑完的重写"当成"没重写"。
    await waitUntilFileQuiet(target);
    const afterNoop = await statusOf(handle.url, TOPIC_ID);
    expect(afterNoop.exportedFingerprint).toBe(initial.exportedFingerprint);
    expect(afterNoop.lastSuccessAt).toBe(initial.lastSuccessAt);
    expect(await fs.readFile(target, "utf8")).toBe(stableHtml);
  });

  it("无关主题发布不重写已同步的成品", async () => {
    const { root, target, handle, initial } = await bindAndSync();
    const stableHtml = await fs.readFile(target, "utf8");

    // 无关主题发布：revision 变化，但本主题内容指纹不变，不重写已同步的成品。
    const otherBefore = await statusOf(handle.url, OTHER_TOPIC_ID);
    await fs.writeFile(
      path.join(root, "topics", OTHER_DIR, OTHER_NODE + ".md"),
      nodeFile(OTHER_NODE, "无关起点", "root", null, "无关主题的新正文。"),
      "utf8",
    );
    await waitFor(async () => {
      const other = await statusOf(handle.url, OTHER_TOPIC_ID);
      return other.sourceFingerprint !== otherBefore.sourceFingerprint;
    });
    // 等到本主题成品不再变化，再断言"没有被重写"，避免并行慢时把进行中的写入当成已完成。
    await waitUntilFileQuiet(target);
    const afterOther = await statusOf(handle.url, TOPIC_ID);
    expect(afterOther.lastSuccessAt).toBe(initial.lastSuccessAt);
    expect(afterOther.exportedFingerprint).toBe(initial.exportedFingerprint);
    expect(await fs.readFile(target, "utf8")).toBe(stableHtml);
  });
});

describe("内容指纹与重要标记", () => {
  function document(important: boolean, extra: { from?: string | null } = {}): OfflineTopicDocument {
    const node: GraphNode = {
      id: ROOT_NODE,
      topicId: TOPIC_ID,
      title: "起点",
      summary: "",
      number: "01",
      from: extra.from ?? null,
      flow: "root",
      state: "agreed",
      important,
      sourcePath: "topics/" + DIR + "/" + ROOT_NODE + ".md",
    };
    return {
      format: 1,
      workspaceId: "ws-important",
      workspaceName: "重要标记样例",
      instanceId: "inst-important",
      revision: 1,
      fingerprint: "",
      generatedAt: "2026-10-24T00:00:00.000Z",
      topic: {
        id: TOPIC_ID,
        title: "重要标记样例",
        path: "topics/" + DIR + "/topic.md",
        nodeIds: [ROOT_NODE],
        fileHash: "a".repeat(64),
        contentHash: "b".repeat(64),
      },
      nodes: [{ ...node, body: "正文。", path: node.sourcePath ?? "", fileHash: "c".repeat(64) }],
      boundaryNodes: [],
      resources: {},
      resourceDiagnostics: [],
    };
  }

  it("只有 important 不同时内容指纹必须不同；其余字段不变时稳定", () => {
    const off = computeContentFingerprint(document(false));
    const on = computeContentFingerprint(document(true));
    expect(on).not.toBe(off);
    // 同一输入重复计算稳定（与运行字段无关）。
    expect(computeContentFingerprint(document(false))).toBe(off);
    expect(computeContentFingerprint(document(true))).toBe(on);
  });

  it("节点漏掉 important 时导出直接报错，而不是悄悄产出过期成品", () => {
    const broken = document(false);
    const nodes = broken.nodes as unknown as Array<Record<string, unknown>>;
    delete nodes[0]!["important"];
    broken.fingerprint = computeContentFingerprint(broken);
    expect(() =>
      renderTopicHtml({ document: broken, readerScript: "void 0;", readerStyles: "body{margin:0}" }),
    ).toThrow(/important/);
  });
});
