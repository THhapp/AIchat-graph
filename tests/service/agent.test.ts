import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";

const temporaryRoots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

const ROOT_NODE = "n_" + "1".repeat(32);
const NEXT_NODE = "n_" + "2".repeat(32);
const TOPIC_ID = "t_" + "3".repeat(32);
const DIR = "讨论";

function nodeFile(options: {
  nodeId: string;
  title: string;
  state: string;
  from: string | null;
  flow: "root" | "next" | "branch";
  description?: string;
  side?: "left" | "right";
  order?: number;
  body: string;
}): string {
  const lines = [
    "---",
    "nodeId: " + options.nodeId,
    "title: " + options.title,
    "state: " + options.state,
    "from: " + (options.from ?? "null"),
    "flow: " + options.flow,
  ];
  if (options.description !== undefined) lines.push("description: " + options.description);
  if (options.side !== undefined) lines.push("side: " + options.side);
  if (options.order !== undefined) lines.push("order: " + options.order);
  lines.push("---", "", options.body, "");
  return lines.join("\n");
}

async function newWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-agent-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "agent-test" });
  const topicDir = path.join(root, "topics", DIR);
  await fs.mkdir(topicDir, { recursive: true });
  await fs.writeFile(
    path.join(topicDir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: 条目整理\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, ROOT_NODE + ".md"),
    nodeFile({
      nodeId: ROOT_NODE,
      title: "记录的目的",
      state: "agreed",
      from: null,
      flow: "root",
      body: "保留有用的思路来路和关键转折。",
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, NEXT_NODE + ".md"),
    nodeFile({
      nodeId: NEXT_NODE,
      title: "原位维护",
      state: "proposed",
      from: ROOT_NODE,
      flow: "next",
      description: "先记录目的，再说明维护方式",
      body: "默认更新现有内容。\n\n第二段补充说明。",
    }),
    "utf8",
  );
  return fs.realpath(root);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

function agentHeaders(): Record<string, string> {
  return { "content-type": "application/json", "x-aichat-client": "cli" };
}

describe("格式 2 快照与详情", () => {
  it("graph/topic/node 详情使用节点真实文件与哈希，且带 description 与 contentHash", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const graph = (await (await fetch(handle.url + "/api/graph")).json()) as {
      nodes: Array<{ id: string; description?: string; sourcePath?: string; number: string }>;
      topics: Array<{ id: string; contentHash?: string; fileHash: string; path: string }>;
    };
    expect(graph.nodes.map((node) => node.number)).toEqual(["01", "02"]);
    expect(graph.nodes[1]?.description).toBe("先记录目的，再说明维护方式");
    expect(graph.nodes[1]?.sourcePath).toBe("topics/" + DIR + "/" + NEXT_NODE + ".md");
    expect(graph.topics[0]?.path).toBe("topics/" + DIR + "/topic.md");
    expect(graph.topics[0]?.contentHash).toHaveLength(64);

    // 节点详情：正文版本是节点文件自己的哈希，不是 topic.md。
    const nodeDetail = (await (
      await fetch(handle.url + "/api/nodes/" + NEXT_NODE)
    ).json()) as { path: string; fileHash: string; body: string };
    const nodeBytes = await fs.readFile(path.join(root, "topics", DIR, NEXT_NODE + ".md"));
    expect(nodeDetail.path).toBe("topics/" + DIR + "/" + NEXT_NODE + ".md");
    expect(nodeDetail.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(nodeDetail.body).toContain("第二段补充说明");
    expect(nodeDetail.fileHash).not.toBe(graph.topics[0]?.fileHash);
    expect(nodeBytes.length).toBeGreaterThan(0);

    // 主题详情：raw 只是 topic.md，nodes 带真实 path/fileHash。
    const topicDetail = (await (
      await fetch(handle.url + "/api/topics/" + TOPIC_ID)
    ).json()) as {
      raw: string;
      nodes: Array<{ id: string; path: string; fileHash: string; body: string }>;
      topic: { contentHash?: string };
    };
    expect(topicDetail.raw).toContain("title: 条目整理");
    expect(topicDetail.raw).not.toContain("保留有用的思路来路");
    expect(topicDetail.nodes.map((node) => node.id)).toEqual([ROOT_NODE, NEXT_NODE]);
    for (const node of topicDetail.nodes) {
      expect(node.path).toMatch(/^topics\//);
      expect(node.fileHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(topicDetail.nodes[1]?.body).toContain("默认更新现有内容");
  });

  it("节点文件被外部改动后发布新版本；只有该节点变化", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const before = (await (await fetch(handle.url + "/api/graph")).json()) as {
      revision: number;
      instanceId: string;
    };
    const file = path.join(root, "topics", DIR, NEXT_NODE + ".md");
    const text = await fs.readFile(file, "utf8");
    await fs.writeFile(
      file,
      text.replace("默认更新现有内容。", "外部修改后的正文。"),
      "utf8",
    );
    // 等 watcher 批处理窗口。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = (await (await fetch(handle.url + "/api/graph")).json()) as {
      revision: number;
      stale: boolean;
    };
    expect(after.revision).toBe(before.revision + 1);
    expect(after.stale).toBe(false);
    const detail = (await (
      await fetch(
        handle.url +
          "/api/nodes/" +
          NEXT_NODE +
          "?instanceId=" +
          before.instanceId +
          "&revision=" +
          String(after.revision),
      )
    ).json()) as { body: string };
    expect(detail.body).toContain("外部修改后的正文。");
  });
});

describe("Agent 有界读取与 editRef", () => {
  it("默认有界、full 取全文、editRef 绑定真实文件与版本", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const bounded = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?start=0&length=6")
    ).json()) as {
      body: string;
      range: { start: number; end: number; total: number; unit: string };
      truncated: boolean;
      path: string;
      fileHash: string;
      editRef: { ref: string; nodeId: string; path: string; fileHash: string; instanceId: string };
      section: { title: string } | null;
    };
    expect(bounded.range.unit).toBe("utf16");
    // length 是 UTF-16 单元数（与 range 一致）。
    expect(bounded.body).toBe("默认更新现有");
    expect(bounded.range.end - bounded.range.start).toBe(6);
    expect(bounded.body.length).toBe(6);
    expect(bounded.truncated).toBe(true);
    expect(bounded.path).toBe("topics/" + DIR + "/" + NEXT_NODE + ".md");
    expect(bounded.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bounded.editRef.nodeId).toBe(NEXT_NODE);
    expect(bounded.editRef.path).toBe(bounded.path);
    expect(bounded.editRef.fileHash).toBe(bounded.fileHash);

    const full = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?full=true")
    ).json()) as { body: string; truncated: boolean };
    expect(full.truncated).toBe(false);
    expect(full.body).toContain("第二段补充说明。");

    // 从中间读到底：仍不是全文，truncated 必须为 true。
    const tail = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?full=true&start=6")
    ).json()) as { body: string; truncated: boolean; range: { start: number; total: number } };
    expect(tail.range.start).toBe(6);
    expect(tail.truncated).toBe(true);
    expect(tail.body.length).toBeLessThan(full.body.length);

    // 给正文加一个标题，验证可选章节定位。
    const file = path.join(root, "topics", DIR, NEXT_NODE + ".md");
    const text = await fs.readFile(file, "utf8");
    await fs.writeFile(file, text.replace("默认更新现有内容。", "## 小节一\n\n默认更新现有内容。"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const withSection = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?full=true")
    ).json()) as { section: { title: string; level: number } | null };
    expect(withSection.section?.title).toBe("小节一");
    expect(withSection.section?.level).toBe(2);
  });

  it("非法参数与服务重启后的旧 editRef 被拒绝", async () => {
    const root = await newWorkspace();
    const port = await freePort();
    const handle = await startService({ root, port });
    running.push(handle);

    const tooLong = await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?length=99999");
    expect(tooLong.status).toBe(400);
    const badQuery = await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?start=abc");
    expect(badQuery.status).toBe(400);
    const missing = await fetch(handle.url + "/api/agent/nodes/n_" + "9".repeat(32));
    expect(missing.status).toBe(404);

    const read = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE)
    ).json()) as { editRef: { ref: string } };
    await handle.stop();
    running.splice(running.indexOf(handle), 1);

    const again = await startService({ root, port: await freePort() });
    running.push(again);
    const staleRef = await fetch(again.url + "/api/agent/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        workspaceId: again.workspaceId,
        requestId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        action: { action: "patchNode", editRef: read.editRef.ref, append: "\n追加" },
      }),
    });
    expect(staleRef.status).toBe(409);
    expect(((await staleRef.json()) as { error: { code: string } }).error.code).toBe("STALE_EDIT_REF");
  });
});

describe("Agent 动作编译", () => {
  async function postAgent(
    url: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(url + "/api/agent/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify(body),
    });
  }

  it("patchNode 片段修改只改目标文件，重放返回同一结果", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const nodePath = path.join(root, "topics", DIR, NEXT_NODE + ".md");
    const rootPath = path.join(root, "topics", DIR, ROOT_NODE + ".md");
    const rootBefore = await fs.readFile(rootPath, "utf8");

    const read = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?full=true")
    ).json()) as { editRef: { ref: string }; body: string };
    const requestId = "1f8fad5b-d9cb-469f-a165-70867728950e";
    const payload = {
      workspaceId: handle.workspaceId,
      requestId,
      action: {
        action: "patchNode",
        editRef: read.editRef.ref,
        replace: [{ old: "默认更新现有内容。", new: "改为片段替换后的正文。" }],
      },
    };
    const first = await postAgent(handle.url, payload);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      state: string;
      changedNodeIds: string[];
      touchedFiles: Array<{ path: string }>;
      revision: number;
    };
    expect(firstBody.state).toBe("committed");
    expect(firstBody.changedNodeIds).toEqual([NEXT_NODE]);
    expect(firstBody.touchedFiles.map((file) => file.path)).toEqual([
      "topics/" + DIR + "/" + NEXT_NODE + ".md",
    ]);
    const text = await fs.readFile(nodePath, "utf8");
    expect(text).toContain("改为片段替换后的正文。");
    expect(text).not.toContain("默认更新现有内容。");
    expect(await fs.readFile(rootPath, "utf8")).toBe(rootBefore);

    // exact 片段允许跨行并原样保留首尾空白：整段被完整替换，前后其他字节不动。
    // 锚点取正文内部（段落之间的空行属于被匹配的旧文本），首尾空白也原样带进匹配。
    const textBeforeMultiline = await fs.readFile(nodePath, "utf8");
    const multilineOld = "\n\n第二段补充说明。";
    expect(textBeforeMultiline).toContain(multilineOld);
    const multilineRead = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE)
    ).json()) as { editRef: { ref: string } };
    const multiline = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "1a2fad5b-d9cb-469f-a165-70867728951e",
      action: {
        action: "patchNode",
        editRef: multilineRead.editRef.ref,
        replace: [{ old: multilineOld, new: "\n\n替换后的第二段，含首尾空行。" }],
      },
    });
    expect(multiline.status).toBe(200);
    const textAfterMultiline = await fs.readFile(nodePath, "utf8");
    // 前后其他字节完全不动：只有这一段被换成新文本。
    const anchorAt = textBeforeMultiline.indexOf(multilineOld);
    expect(textAfterMultiline).toBe(
      textBeforeMultiline.slice(0, anchorAt) +
        "\n\n替换后的第二段，含首尾空行。" +
        textBeforeMultiline.slice(anchorAt + multilineOld.length),
    );
    // YAML 头与尾随换行保持原样（只动被匹配的正文片段）。
    const headerEnd = textBeforeMultiline.indexOf("\n---\n") + "\n---\n".length;
    expect(textAfterMultiline.slice(0, headerEnd)).toBe(textBeforeMultiline.slice(0, headerEnd));
    expect(textAfterMultiline.endsWith("\n")).toBe(true);
    expect(textAfterMultiline.length).toBe(
      textBeforeMultiline.length -
        multilineOld.length +
        "\n\n替换后的第二段，含首尾空行。".length,
    );

    // 空 old 仍被结构校验拒绝（不会变成"插在开头"之类）。
    const emptyRef = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE)
    ).json()) as { editRef: { ref: string } };
    const emptyOld = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "1b2fad5b-d9cb-469f-a165-70867728951e",
      action: { action: "patchNode", editRef: emptyRef.editRef.ref, replace: [{ old: "", new: "x" }] },
    });
    expect(emptyOld.status).toBe(400);
    expect(await fs.readFile(nodePath, "utf8")).toBe(textAfterMultiline);

    // 重复 old 仍由候选层拒绝，且不改文件。
    const dupRead = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE)
    ).json()) as { editRef: { ref: string } };
    const dupOld = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "1c2fad5b-d9cb-469f-a165-70867728951e",
      action: { action: "patchNode", editRef: dupRead.editRef.ref, replace: [{ old: "\n", new: "x" }] },
    });
    expect(dupOld.status).toBe(409);
    expect(((await dupOld.json()) as { error: { code: string } }).error.code).toBe(
      "OPERATION_CONFLICT",
    );
    expect(await fs.readFile(nodePath, "utf8")).toBe(textAfterMultiline);

    // 相同 requestId 相同 body：原结果，不重复写。
    const replay = await postAgent(handle.url, payload);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { replayed?: boolean; revision: number };
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.revision).toBe(firstBody.revision);
    // 重放的是最初那次替换；此后跨行替换已发生，所以比对当前字节而非最早的 text。
    expect(await fs.readFile(nodePath, "utf8")).toBe(textAfterMultiline);

    // replace 的 old 不存在 → 409，且不改文件（语义冲突，不做全局替换）。
    const fresh = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE)
    ).json()) as { editRef: { ref: string } };
    const bad = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "2f8fad5b-d9cb-469f-a165-70867728950e",
      action: { action: "patchNode", editRef: fresh.editRef.ref, replace: [{ old: "不存在的片段", new: "x" }] },
    });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      "OPERATION_CONFLICT",
    );
    expect(await fs.readFile(nodePath, "utf8")).toBe(textAfterMultiline);
  });

  it("createBranch 创建侧枝；createNext 复用同一路径且拒绝已有 next", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const read = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE)
    ).json()) as { editRef: { ref: string } };

    const branch = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "3f8fad5b-d9cb-469f-a165-70867728950e",
      action: {
        action: "createBranch",
        editRef: read.editRef.ref,
        title: "一个侧枝",
        body: "侧枝正文。",
        description: "从维护方式展开一个具体情境",
      },
    });
    expect(branch.status).toBe(200);
    const branchBody = (await branch.json()) as {
      created: { nodeIds: string[]; paths: string[] };
      changedNodeIds: string[];
      editRef: { ref: string } | null;
    };
    const branchId = branchBody.created.nodeIds[0] as string;
    expect(branchId).toMatch(/^n_[0-9a-f]{32}$/);
    const branchFile = path.join(root, "topics", DIR, branchId + ".md");
    const branchText = await fs.readFile(branchFile, "utf8");
    expect(branchText).toContain("flow: branch");
    expect(branchText).toContain("from: " + NEXT_NODE);
    expect(branchText).toContain("description: 从维护方式展开一个具体情境");

    // 重放同一请求：created 值不变，不新建第二个节点。
    const replay = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "3f8fad5b-d9cb-469f-a165-70867728950e",
      action: {
        action: "createBranch",
        editRef: read.editRef.ref,
        title: "一个侧枝",
        body: "侧枝正文。",
        description: "从维护方式展开一个具体情境",
      },
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { created: { nodeIds: string[] } };
    expect(replayBody.created.nodeIds).toEqual([branchId]);
    const files = await fs.readdir(path.join(root, "topics", DIR));
    expect(files.filter((file) => file.endsWith(".md"))).toHaveLength(4);

    // 同 requestId 不同 body：409，不执行。
    const conflict = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "3f8fad5b-d9cb-469f-a165-70867728950e",
      action: {
        action: "createBranch",
        editRef: read.editRef.ref,
        title: "另一个标题",
        body: "另一份正文。",
        description: "不同请求体",
      },
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
      "OPERATION_CONFLICT",
    );

    // 来源已有 next：createNext 拒绝，不挤走 02。
    const rootRead = (await (
      await fetch(handle.url + "/api/agent/nodes/" + ROOT_NODE)
    ).json()) as { editRef: { ref: string } };
    const blocked = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "4f8fad5b-d9cb-469f-a165-70867728950e",
      action: {
        action: "createNext",
        editRef: rootRead.editRef.ref,
        title: "新的纵向后继",
        body: "不应创建。",
        description: "已有后继时不应插入",
      },
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      "OPERATION_CONFLICT",
    );

    // 来源没有 next（侧枝末端）时可以用 createNext。
    const leafRead = (await (
      await fetch(handle.url + "/api/agent/nodes/" + branchId)
    ).json()) as { editRef: { ref: string } };
    const next = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "5f8fad5b-d9cb-469f-a165-70867728950e",
      action: {
        action: "createNext",
        editRef: leafRead.editRef.ref,
        title: "侧枝继续",
        body: "纵向继续。",
        description: "沿这条侧枝继续",
        state: "proposed",
      },
    });
    expect(next.status).toBe(200);
    const nextBody = (await next.json()) as { created: { nodeIds: string[] } };
    const nextId = nextBody.created.nodeIds[0] as string;
    const nextText = await fs.readFile(path.join(root, "topics", DIR, nextId + ".md"), "utf8");
    expect(nextText).toContain("flow: next");
    expect(nextText).toContain("from: " + branchId);
    expect(nextText).not.toContain("side:");
    expect(nextText).not.toContain("order:");
  });

  it("updateConnection 必须给出新 description，并正确改接来源", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const read = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE)
    ).json()) as { editRef: { ref: string } };
    const empty = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "6f8fad5b-d9cb-469f-a165-70867728950e",
      action: { action: "updateConnection", editRef: read.editRef.ref, description: "   " },
    });
    expect(empty.status).toBe(400);

    const branch = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "7f8fad5b-d9cb-469f-a165-70867728950e",
      action: {
        action: "createBranch",
        editRef: read.editRef.ref,
        title: "侧枝",
        body: "侧枝正文。",
        description: "侧枝说明",
      },
    });
    const branchId = ((await branch.json()) as { created: { nodeIds: string[] } }).created
      .nodeIds[0] as string;
    const branchRead = (await (
      await fetch(handle.url + "/api/agent/nodes/" + branchId)
    ).json()) as { editRef: { ref: string } };
    const updated = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "8f8fad5b-d9cb-469f-a165-70867728950e",
      action: {
        action: "updateConnection",
        editRef: branchRead.editRef.ref,
        flow: "branch",
        description: "改接后的新理由",
      },
    });
    expect(updated.status).toBe(200);
    const text = await fs.readFile(path.join(root, "topics", DIR, branchId + ".md"), "utf8");
    expect(text).toContain("description: 改接后的新理由");
  });

  it("createRoot 只用于空工作区，并在同一事务创建主题与根", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-agent-empty-"));
    temporaryRoots.push(parent);
    const root = path.join(parent, "workspace");
    await initWorkspace({ root, name: "empty" });
    const real = await fs.realpath(root);
    const handle = await startService({ root: real, port: await freePort() });
    running.push(handle);

    const created = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "9f8fad5b-d9cb-469f-a165-70867728950e",
      action: {
        action: "createRoot",
        topicTitle: "新的讨论",
        title: "起点",
        body: "第一段正文。",
      },
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      created: { topicId: string; topicPath: string; nodeIds: string[] };
      editRef: { ref: string } | null;
    };
    expect(body.created.topicId).toMatch(/^t_[0-9a-f]{32}$/);
    expect(body.created.nodeIds[0]).toMatch(/^n_[0-9a-f]{32}$/);
    expect(body.editRef?.ref).toMatch(/^er_/);
    const graph = (await (await fetch(handle.url + "/api/graph")).json()) as {
      nodes: Array<{ id: string; flow: string }>;
      topics: Array<{ id: string }>;
    };
    expect(graph.topics.map((topic) => topic.id)).toEqual([body.created.topicId]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.flow).toBe("root");

    // 再次 createRoot：工作区已非空，明确拒绝。
    const again = await postAgent(handle.url, {
      workspaceId: handle.workspaceId,
      requestId: "af8fad5b-d9cb-469f-a165-70867728950e",
      action: { action: "createRoot", topicTitle: "第二个", title: "根二", body: "不应创建" },
    });
    expect(again.status).toBe(409);
  });

  it("低层 check/apply 接受格式 2 的 patchNode/updateConnection/description", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const nodePath = "topics/" + DIR + "/" + NEXT_NODE + ".md";
    const nodeAbs = path.join(root, "topics", DIR, NEXT_NODE + ".md");
    const topicMetaPath = "topics/" + DIR + "/topic.md";
    const beforeNode = await fs.readFile(nodeAbs, "utf8");
    const nodeHash = sha256Hex(beforeNode);
    const topicHash = sha256Hex(
      await fs.readFile(path.join(root, "topics", DIR, "topic.md"), "utf8"),
    );

    // 低层 V2 patchNode：以前会被 legacy changeRequestSchema 直接 400。
    const payload = {
      workspaceId: handle.workspaceId,
      requestId: "df8fad5b-d9cb-469f-a165-70867728950e",
      expectedFiles: { [nodePath]: nodeHash, [topicMetaPath]: topicHash },
      operations: [
        {
          op: "patchNode",
          nodeId: NEXT_NODE,
          replace: [{ old: "默认更新现有内容。", new: "低层片段替换后的正文。" }],
        },
      ],
    };
    const check = await fetch(handle.url + "/api/changes/check", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify(payload),
    });
    expect(check.status).toBe(200);
    const checkBody = (await check.json()) as {
      dryRun: boolean;
      files: Array<{ path: string; nextSha256: string }>;
      changedNodeIds: string[];
    };
    expect(checkBody.dryRun).toBe(true);
    expect(checkBody.files.map((file) => file.path)).toEqual([nodePath]);
    expect(await fs.readFile(nodeAbs, "utf8")).toBe(beforeNode);

    const applied = await fetch(handle.url + "/api/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify(payload),
    });
    expect(applied.status).toBe(200);
    const appliedBody = (await applied.json()) as { state: string; changedNodeIds: string[] };
    expect(appliedBody.state).toBe("committed");
    expect(appliedBody.changedNodeIds).toEqual([NEXT_NODE]);
    const after = await fs.readFile(nodeAbs, "utf8");
    expect(after).toContain("低层片段替换后的正文。");

    // 低层 V2 updateConnection：改 description 与 side/order 也必须能过传输层。
    const refreshed = await fs.readFile(nodeAbs, "utf8");
    const second = {
      workspaceId: handle.workspaceId,
      requestId: "ef8fad5b-d9cb-469f-a165-70867728950e",
      expectedFiles: { [nodePath]: sha256Hex(refreshed), [topicMetaPath]: topicHash },
      operations: [
        {
          op: "updateConnection",
          nodeId: NEXT_NODE,
          flow: "branch",
          side: "left",
          order: 30,
          description: "低层更新后的连接说明",
        },
      ],
    };
    const updated = await fetch(handle.url + "/api/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify(second),
    });
    expect(updated.status).toBe(200);
    const updatedText = await fs.readFile(nodeAbs, "utf8");
    expect(updatedText).toContain("description: 低层更新后的连接说明");
    expect(updatedText).toContain("flow: branch");
    expect(updatedText).toContain("side: left");
    expect(updatedText).toContain("order: 30");

    // 旧哈希重放：412，不覆盖。
    const stale = await fetch(handle.url + "/api/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        ...second,
        requestId: "ff8fad5b-d9cb-469f-a165-70867728950e",
      }),
    });
    expect(stale.status).toBe(412);
    expect(await fs.readFile(nodeAbs, "utf8")).toBe(updatedText);
  });

  it("写请求仍要求 JSON 与本机客户端头，未知字段被拒绝", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const noHeader = await fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: handle.workspaceId, requestId: "bf8fad5b-d9cb-469f-a165-70867728950e", action: {} }),
    });
    expect(noHeader.status).toBe(403);
    const unknownField = await fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: "cf8fad5b-d9cb-469f-a165-70867728950e",
        action: { action: "createRoot", topicTitle: "x", title: "y", body: "z", extra: 1 },
      }),
    });
    expect(unknownField.status).toBe(400);
  });
});
describe("editRef 与读取后源变化", () => {
  it("读 H1 → 源改 H2 并发布 → 旧 ref 全文替换必须 412 且 H2 字节不变", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const nodePath = path.join(root, "topics", DIR, NEXT_NODE + ".md");

    const read = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?full=true")
    ).json()) as { editRef: { ref: string }; body: string; fileHash: string };
    const h1 = await fs.readFile(nodePath, "utf8");
    expect(read.fileHash).toBe(sha256Hex(h1));

    // 外部把源改成 H2（走 watcher + 发布，快照随之更新）。
    const h2 = h1.replace("默认更新现有内容。", "别人已经改成的新内容。");
    await fs.writeFile(nodePath, h2, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const h2Bytes = await fs.readFile(nodePath);
    expect(sha256Hex(h2Bytes.toString("utf8"))).not.toBe(read.fileHash);

    // 用旧 ref 做全文替换：必须 412，且磁盘保持 H2 字节不变。
    const stale = await fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: "0a8fad5b-d9cb-469f-a165-70867728950e",
        action: {
          action: "patchNode",
          editRef: read.editRef.ref,
          body: "用旧读取覆盖全文。",
        },
      }),
    });
    expect(stale.status).toBe(412);
    const body = (await stale.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe("VERSION_CONFLICT");
    expect(await fs.readFile(nodePath)).toEqual(h2Bytes);

    // 重读后可以正常写入（不因全局 revision 变化而拒绝无关节点更新）。
    const reread = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?full=true")
    ).json()) as { editRef: { ref: string } };
    const ok = await fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: "1a8fad5b-d9cb-469f-a165-70867728950e",
        action: { action: "patchNode", editRef: reread.editRef.ref, append: "重读后追加。" },
      }),
    });
    expect(ok.status).toBe(200);
    expect(await fs.readFile(nodePath, "utf8")).toContain("重读后追加。");
  });

  it("无关主题发布后旧 ref 仍可用（不以全局 revision 否决）", async () => {
    const root = await newWorkspace();
    // 第二个主题，用来制造"无关发布"。
    const otherDir = path.join(root, "topics", "别的主题");
    await fs.mkdir(otherDir, { recursive: true });
    const otherTopic = "t_" + "7".repeat(32);
    const otherRoot = "n_" + "8".repeat(32);
    await fs.writeFile(otherDir + "/topic.md", "---\ntopicId: " + otherTopic + "\ntitle: 别的主题\n---\n", "utf8");
    // 跨主题侧枝：保持单一 root 的合法图，同时让另一个主题成为"无关发布"来源。
    const otherNode = (title: string, body: string): string =>
      [
        "---",
        "nodeId: " + otherRoot,
        "title: " + title,
        "state: agreed",
        "from: " + ROOT_NODE,
        "flow: branch",
        "description: 从根展开的另一个主题",
        "side: left",
        "order: 10",
        "---",
        "",
        body,
        "",
      ].join("\n");
    await fs.writeFile(otherDir + "/" + otherRoot + ".md", otherNode("另一主题的卡片", "另一棵树。"), "utf8");
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const read = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE)
    ).json()) as { editRef: { ref: string } };

    await fs.writeFile(otherDir + "/" + otherRoot + ".md", otherNode("另一主题的卡片", "另一棵树，改了。"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const graph = (await (await fetch(handle.url + "/api/graph")).json()) as { revision: number };
    expect(graph.revision).toBeGreaterThan(1);

    const ok = await fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: "2a8fad5b-d9cb-469f-a165-70867728950e",
        action: { action: "patchNode", editRef: read.editRef.ref, append: "无关发布后追加。" },
      }),
    });
    expect(ok.status).toBe(200);
    expect(await fs.readFile(path.join(root, "topics", DIR, NEXT_NODE + ".md"), "utf8")).toContain(
      "无关发布后追加。",
    );
  });
});