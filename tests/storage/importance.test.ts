import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitFiles,
  initWorkspace,
  prepareChangesV2,
  readWorkspaceFiles,
  type V2ChangeRequest,
  type V2Operation,
} from "../../src/storage/index.js";

/**
 * setImportance 的候选层契约：
 * - 只写一项元数据，true 写字段、false 删字段；
 * - 计入 changedNodeIds（快照要刷新），但不计入 contentNodeIds（不算内容更新）。
 */

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const TOPIC_ID = "t_" + "a".repeat(32);
const ROOT_ID = "n_" + "1".repeat(32);
const CHILD_ID = "n_" + "2".repeat(32);
const DIR = "讨论";
const CHILD_PATH = "topics/" + DIR + "/" + CHILD_ID + ".md";

function nodeFile(options: {
  nodeId: string;
  title: string;
  from: string | null;
  flow: "root" | "next" | "branch";
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

async function newWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-importance-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "ws");
  await initWorkspace({ root, name: "importance-test" });
  const topicDir = path.join(root, "topics", DIR);
  await fs.mkdir(topicDir, { recursive: true });
  await fs.writeFile(
    path.join(topicDir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: 条目整理\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, ROOT_ID + ".md"),
    nodeFile({ nodeId: ROOT_ID, title: "记录的目的", from: null, flow: "root", body: "根节点正文。" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, CHILD_ID + ".md"),
    nodeFile({
      nodeId: CHILD_ID,
      title: "维护方式",
      from: ROOT_ID,
      flow: "next",
      description: "先记录目的，再说明维护方式",
      body: "默认更新现有内容。",
    }),
    "utf8",
  );
  return fs.realpath(root);
}

async function prepare(root: string, operations: V2Operation[]) {
  const files = await readWorkspaceFiles(root);
  const request: V2ChangeRequest = {
    workspaceId: files.workspace.workspaceId,
    requestId: "00000000-0000-4000-8000-000000000001",
    expectedFiles: {
      "workspace.json": files.workspaceFile.sha256,
      [CHILD_PATH]: files.topics.find((file) => file.path === CHILD_PATH)?.sha256 ?? "",
    },
    operations,
  };
  return { files, prepared: prepareChangesV2(files, request) };
}

describe("setImportance 候选变换", () => {
  it("置为 true 只改头字段，不算内容更新", async () => {
    const root = await newWorkspace();
    const { prepared } = await prepare(root, [{ op: "setImportance", nodeId: CHILD_ID, important: true }]);
    expect(prepared.files.map((file) => file.path)).toEqual([CHILD_PATH]);
    expect(prepared.changedNodeIds).toEqual([CHILD_ID]);
    expect(prepared.contentNodeIds).toEqual([]);
    const text = prepared.files[0]?.content ?? "";
    expect(text).toContain("important: true");
    // 正文与连接字段原样保留。
    expect(text).toContain("默认更新现有内容。");
    expect(text).toContain("from: " + ROOT_ID);
  });

  it("置为 false 时整个字段消失，文件回到干净状态", async () => {
    const root = await newWorkspace();
    const first = await prepare(root, [{ op: "setImportance", nodeId: CHILD_ID, important: true }]);
    await commitFiles({ root, files: first.prepared.files, cleanupJournal: true });

    const second = await prepare(root, [{ op: "setImportance", nodeId: CHILD_ID, important: false }]);
    expect(second.prepared.files.map((file) => file.path)).toEqual([CHILD_PATH]);
    const text = second.prepared.files[0]?.content ?? "";
    expect(text).not.toContain("important");
    expect(second.prepared.contentNodeIds).toEqual([]);
  });

  it("值未变化时不产生文件变化", async () => {
    const root = await newWorkspace();
    const { prepared, files } = await prepare(root, [
      { op: "setImportance", nodeId: CHILD_ID, important: false },
    ]);
    expect(prepared.files).toEqual([]);
    expect(prepared.changedNodeIds).toEqual([]);
    expect(prepared.summary).toContain("setImportance(no-op)");
    expect(files).toBeDefined();
  });

  it("标题修改仍然计入内容更新", async () => {
    const root = await newWorkspace();
    const { prepared } = await prepare(root, [{ op: "updateNode", nodeId: CHILD_ID, title: "维护方式（改）" }]);
    expect(prepared.changedNodeIds).toEqual([CHILD_ID]);
    expect(prepared.contentNodeIds).toEqual([CHILD_ID]);
  });

  it("删除节点只计入 changedNodeIds，不算内容更新", async () => {
    const root = await newWorkspace();
    const files = await readWorkspaceFiles(root);
    const prepared = prepareChangesV2(files, {
      workspaceId: files.workspace.workspaceId,
      requestId: "00000000-0000-4000-8000-000000000002",
      expectedFiles: {
        "workspace.json": files.workspaceFile.sha256,
        [CHILD_PATH]: files.topics.find((file) => file.path === CHILD_PATH)?.sha256 ?? "",
      },
      operations: [{ op: "removeLeaf", nodeId: CHILD_ID }],
    });
    expect(prepared.changedNodeIds).toEqual([CHILD_ID]);
    expect(prepared.contentNodeIds).toEqual([]);
  });
});
