import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { main as runCli } from "../../src/cli/index.js";
import { loadWorkspace } from "../../src/cli/workspace.js";
import { initWorkspace } from "../../src/storage/index.js";
import { locateSection } from "../../src/core/index.js";
import { startService } from "../../src/service/index.js";
import { createApp } from "../../src/service/server.js";
import { WorkspaceRuntime } from "../../src/service/workspace.js";

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

  async function readAgent(url: string, nodeId: string): Promise<{ editRef: { ref: string } }> {
    return await (await fetch(url + "/api/agent/nodes/" + nodeId)).json() as { editRef: { ref: string } };
  }

  it("isolated 主题各自起点、搜索隔离、重放与目录碰撞保护", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const beforeWorkspace = await fs.readFile(path.join(root, "workspace.json"), "utf8");

    const command = ["create-topic", "--workspace", root, "--topic-title", "第二主题", "--directory", "自定义目录", "--body", "默认更新现有内容，但属于另一个主题。"];
    const created = await runCli(command);
    expect(created.exitCode, created.stderr).toBe(0);
    const result = JSON.parse(created.stdout) as { created: { topicId: string; nodeIds: string[] } };
    const secondId = result.created.topicId;
    const secondRoot = result.created.nodeIds[0]!;
    expect(await fs.readFile(path.join(root, "topics", "自定义目录", "topic.md"), "utf8")).toContain(secondId);
    const workspace = await (await fetch(handle.url + "/api/workspace")).json() as { agentEntry: { cliPath: string; skillPath: string } };
    expect(workspace.agentEntry.cliPath.replaceAll("\\", "/")).toMatch(/\/dist\/cli\/index\.js$/);
    expect(workspace.agentEntry.skillPath.replaceAll("\\", "/")).toMatch(/\/skills\/aichat-graph\/SKILL\.md$/);
    const graph = await (await fetch(handle.url + "/api/graph")).json() as { nodes: Array<{ id: string; topicId: string; flow: string; number: string }> };
    expect(graph.nodes.filter((node) => node.flow === "root").map((node) => node.number)).toEqual(["01", "01"]);
    const snapshot = await loadWorkspace(root);
    expect(snapshot.graph?.rootIds).toHaveLength(2);
    const manifest = JSON.parse(await fs.readFile(path.join(root, ".aichat/cache/manifest.json"), "utf8"));
    expect(manifest.roots).toHaveLength(2);

    const search = await runCli(["search", "默认更新", "--workspace", root, "--topic", TOPIC_ID, "--limit", "1"]);
    expect(search.exitCode, search.stderr).toBe(0);
    const searchBody = JSON.parse(search.stdout);
    expect(searchBody.totalHits).toBe(1);
    expect(searchBody.hits[0].topicId).toBe(TOPIC_ID);
    expect(searchBody.hasMore).toBe(false);
    const webSearch = await (await fetch(handle.url + "/api/search?q=" + encodeURIComponent("默认更新") + "&topic=" + secondId)).json() as { hits: Array<{ topicId: string }> };
    expect(webSearch.hits.map((hit) => hit.topicId)).toEqual([secondId]);
    const invalidTopic = await runCli(["search", "默认", "--workspace", root, "--topic", "第二主题"]);
    expect(invalidTopic.exitCode).not.toBe(0);

    const beforeNode = await fs.readFile(path.join(root, "topics", DIR, NEXT_NODE + ".md"), "utf8");
    const firstRef = await readAgent(handle.url, NEXT_NODE);
    const secondRef = await readAgent(handle.url, secondRoot);
    const cross = await postAgent(handle.url, { workspaceId: handle.workspaceId, requestId: randomUUID(), action: {
      action: "updateConnection", editRef: firstRef.editRef.ref, fromRef: secondRef.editRef.ref, description: "不应跨主题连接",
    } });
    expect(cross.status).toBe(422);
    expect(await fs.readFile(path.join(root, "topics", DIR, NEXT_NODE + ".md"), "utf8")).toBe(beforeNode);
    expect(await fs.readFile(path.join(root, "workspace.json"), "utf8")).toBe(beforeWorkspace);
    const crossChild = await postAgent(handle.url, { workspaceId: handle.workspaceId, requestId: randomUUID(), action: {
      action: "createBranch", editRef: firstRef.editRef.ref, topicId: secondId, title: "错误跨主题分支", body: "不能落盘", description: "不应跨主题",
    } });
    expect(crossChild.status).toBe(409);

    const collision = await runCli(command);
    expect(collision.exitCode).not.toBe(0);
    expect(collision.stderr).toContain("409");
    await fs.mkdir(path.join(root, "topics", "空目录"));
    const emptyCollision = await runCli(["create-topic", "--workspace", root, "--topic-title", "空目录", "--body", "不能复用"]);
    expect(emptyCollision.exitCode).not.toBe(0);
    expect(await fs.readdir(path.join(root, "topics", "空目录"))).toEqual([]);
    const illegal = await runCli(["create-topic", "--workspace", root, "--topic-title", "越界", "--directory", "../bad", "--body", "不能写入"]);
    expect(illegal.exitCode).not.toBe(0);

    const payload = { workspaceId: handle.workspaceId, requestId: randomUUID(), action: { action: "createTopic", topicTitle: "重放主题", body: "只有一个起点" } };
    const once = await postAgent(handle.url, payload);
    expect(once.status).toBe(200);
    const onceBody = await once.json() as { created: unknown };
    const replay = await postAgent(handle.url, payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ created: onceBody.created, replayed: true });

    const focus = await fetch(handle.url + "/api/changes", {
      method: "POST", headers: agentHeaders(), body: JSON.stringify({
        workspaceId: handle.workspaceId, requestId: randomUUID(),
        expectedFiles: { "workspace.json": sha256Hex(beforeWorkspace) },
        operations: [{ op: "setDiscussionFocus", nodeId: secondRoot }],
      }),
    });
    expect(focus.status).toBe(200);
    expect(JSON.parse(await fs.readFile(path.join(root, "workspace.json"), "utf8"))).toMatchObject({ activeNode: secondRoot });
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
      refs: Record<string, string>;
    };
    expect(body.created.topicId).toMatch(/^t_[0-9a-f]{32}$/);
    expect(body.created.nodeIds[0]).toMatch(/^n_[0-9a-f]{32}$/);
    expect(body.refs[body.created.nodeIds[0] as string]).toMatch(/^er_/);
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
    // 第二个隔离主题有自己的根，用来制造"无关发布"。
    const otherDir = path.join(root, "topics", "别的主题");
    await fs.mkdir(otherDir, { recursive: true });
    const otherTopic = "t_" + "7".repeat(32);
    const otherRoot = "n_" + "8".repeat(32);
    await fs.writeFile(otherDir + "/topic.md", "---\ntopicId: " + otherTopic + "\ntitle: 别的主题\n---\n", "utf8");
    const otherNode = (title: string, body: string): string =>
      [
        "---",
        "nodeId: " + otherRoot,
        "title: " + title,
        "state: agreed",
        "from: null",
        "flow: root",
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

/* ------------------------------------------------------------------ *
 * rearrange / setImportance / meta 与 section 读取
 * ------------------------------------------------------------------ */

const CHAIN_TOPIC_ID = "t_" + "e".repeat(32);
const CHAIN_DIR = "链条";
const LINK_A = "n_" + "a".repeat(32);
const LINK_B = "n_" + "b".repeat(32);
const LINK_C = "n_" + "c".repeat(32);
const LINK_D = "n_" + "d".repeat(32);

/** A→B→C→D（全部 next，A 为 root）的合成工作区。 */
async function newChainWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-agent-chain-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "chain-test" });
  const topicDir = path.join(root, "topics", CHAIN_DIR);
  await fs.mkdir(topicDir, { recursive: true });
  await fs.writeFile(
    path.join(topicDir, "topic.md"),
    "---\ntopicId: " + CHAIN_TOPIC_ID + "\ntitle: 链条\n---\n",
    "utf8",
  );
  const nodes = [
    { id: LINK_A, title: "起点", from: null, flow: "root" as const, description: undefined, body: "A 的正文。" },
    { id: LINK_B, title: "第二张", from: LINK_A, flow: "next" as const, description: "一到二", body: "B 的正文。" },
    { id: LINK_C, title: "第三张", from: LINK_B, flow: "next" as const, description: "二到三", body: "C 的正文。" },
    { id: LINK_D, title: "第四张", from: LINK_C, flow: "next" as const, description: "三到四", body: "D 的正文。" },
  ];
  for (const node of nodes) {
    await fs.writeFile(
      path.join(topicDir, node.id + ".md"),
      nodeFile({
        nodeId: node.id,
        title: node.title,
        state: "agreed",
        from: node.from,
        flow: node.flow,
        ...(node.description !== undefined ? { description: node.description } : {}),
        body: node.body,
      }),
      "utf8",
    );
  }
  return fs.realpath(root);
}

interface ChainGraph {
  instanceId: string;
  revision: number;
  nodes: Array<{
    id: string;
    number: string;
    from: string | null;
    flow: string;
    description?: string;
  }>;
}

async function chainGraph(url: string): Promise<ChainGraph> {
  return (await (await fetch(url + "/api/graph")).json()) as ChainGraph;
}

async function chainRef(url: string, nodeId: string): Promise<string> {
  const response = await fetch(url + "/api/agent/nodes/" + nodeId + "?meta=true");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { body: string; editRef: { ref: string } };
  expect(body.body).toBe("");
  return body.editRef.ref;
}

async function postRearrange(
  url: string,
  workspaceId: string,
  requestId: string,
  edits: unknown[],
): Promise<Response> {
  return fetch(url + "/api/agent/changes", {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({
      workspaceId,
      requestId,
      action: { action: "rearrange", edits },
    }),
  });
}

describe("rearrange：一次表达最终入边", () => {
  it("A→B→C→D 一次改为 A→C→B→D，并可凭返回的 editRefs 改回", async () => {
    const root = await newChainWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const refs = {
      a: await chainRef(handle.url, LINK_A),
      b: await chainRef(handle.url, LINK_B),
      c: await chainRef(handle.url, LINK_C),
      d: await chainRef(handle.url, LINK_D),
    };
    const first = await postRearrange(handle.url, handle.workspaceId, randomUUID(), [
      { editRef: refs.c, fromRef: refs.a, flow: "next", description: "从一到三（新）" },
      { editRef: refs.b, fromRef: refs.c, flow: "next", description: "从三到二（新）" },
      { editRef: refs.d, fromRef: refs.b, flow: "next", description: "从二到四（新）" },
    ]);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      state: string;
      action: string;
      created: { nodeIds: string[]; paths: string[] };
      changedNodeIds: string[];
      refs: Record<string, string>;
    };
    expect(firstBody.state).toBe("committed");
    expect(firstBody.action).toBe("rearrange");
    expect(firstBody.created.nodeIds).toEqual([]);
    expect(firstBody.created.paths).toEqual([]);
    // 刷新凭据统一在顶层 refs：覆盖 changedNodeIds，且值是 opaque token。
    expect(Object.keys(firstBody.refs).sort()).toEqual(
      [LINK_B, LINK_C, LINK_D].sort(),
    );
    expect(firstBody.refs[LINK_C]).toMatch(/^er_/);

    const graph = await chainGraph(handle.url);
    const byId = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
    expect(byId[LINK_A]?.number).toBe("01");
    expect(byId[LINK_C]?.number).toBe("02");
    expect(byId[LINK_B]?.number).toBe("03");
    expect(byId[LINK_D]?.number).toBe("04");
    expect(byId[LINK_C]?.from).toBe(LINK_A);
    expect(byId[LINK_B]?.from).toBe(LINK_C);
    expect(byId[LINK_D]?.from).toBe(LINK_B);
    for (const id of [LINK_B, LINK_C, LINK_D]) expect(byId[id]?.flow).toBe("next");

    // 中间"腾空"只在内存：最终文件只有最终说明，没有临时 branch 痕迹。
    for (const [id, description] of [
      [LINK_C, "从一到三（新）"],
      [LINK_B, "从三到二（新）"],
      [LINK_D, "从二到四（新）"],
    ] as const) {
      const text = await fs.readFile(path.join(root, "topics", CHAIN_DIR, id + ".md"), "utf8");
      expect(text).toContain("description: " + description);
      expect(text).not.toContain("flow: branch");
      for (const legacy of ["一到二", "二到三", "三到四"]) {
        expect(text).not.toContain(legacy);
      }
    }

    // 用响应里的 fresh refs 直接改回，不重新读取。
    const fresh = firstBody.refs;
    const back = await postRearrange(handle.url, handle.workspaceId, randomUUID(), [
      { editRef: fresh[LINK_B]!, fromRef: refs.a, flow: "next", description: "一到二" },
      { editRef: fresh[LINK_C]!, fromRef: fresh[LINK_B]!, flow: "next", description: "二到三" },
      { editRef: fresh[LINK_D]!, fromRef: fresh[LINK_C]!, flow: "next", description: "三到四" },
    ]);
    expect(back.status).toBe(200);
    const restored = await chainGraph(handle.url);
    const restoredById = Object.fromEntries(restored.nodes.map((node) => [node.id, node]));
    expect(restoredById[LINK_A]?.number).toBe("01");
    expect(restoredById[LINK_B]?.number).toBe("02");
    expect(restoredById[LINK_C]?.number).toBe("03");
    expect(restoredById[LINK_D]?.number).toBe("04");
    expect(restoredById[LINK_B]?.from).toBe(LINK_A);
    expect(restoredById[LINK_C]?.from).toBe(LINK_B);
    expect(restoredById[LINK_D]?.from).toBe(LINK_C);
  });

  it("未把占用 next 的旧后继纳入 edits → 409，且源文件字节不变", async () => {
    const root = await newChainWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const paths = [LINK_A, LINK_B, LINK_C, LINK_D].map((id) =>
      path.join(root, "topics", CHAIN_DIR, id + ".md"),
    );
    const before = await Promise.all(paths.map((file) => fs.readFile(file)));

    const response = await postRearrange(handle.url, handle.workspaceId, randomUUID(), [
      {
        editRef: await chainRef(handle.url, LINK_C),
        fromRef: await chainRef(handle.url, LINK_A),
        flow: "next",
        description: "只想把 C 接到 A",
      },
    ]);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "OPERATION_CONFLICT",
    );
    const after = await Promise.all(paths.map((file) => fs.readFile(file)));
    for (const [index, bytes] of after.entries()) expect(bytes).toEqual(before[index]);
  });

  it("读取后源文件被外部改动 → 412，磁盘不被旧凭据覆盖", async () => {
    const root = await newChainWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const cRef = await chainRef(handle.url, LINK_C);
    const aRef = await chainRef(handle.url, LINK_A);
    const cPath = path.join(root, "topics", CHAIN_DIR, LINK_C + ".md");
    const external = (await fs.readFile(cPath, "utf8")) + "\n外部追加。\n";
    await fs.writeFile(cPath, external, "utf8");
    const externalBytes = await fs.readFile(cPath);

    const response = await postRearrange(handle.url, handle.workspaceId, randomUUID(), [
      { editRef: cRef, fromRef: aRef, flow: "next", description: "过期凭据不应写入" },
    ]);
    expect(response.status).toBe(412);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "VERSION_CONFLICT",
    );
    expect(await fs.readFile(cPath)).toEqual(externalBytes);
  });

  it("同一 requestId 与同一请求体重放：replayed 且最终图不变", async () => {
    const root = await newChainWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = {
      a: await chainRef(handle.url, LINK_A),
      b: await chainRef(handle.url, LINK_B),
      c: await chainRef(handle.url, LINK_C),
      d: await chainRef(handle.url, LINK_D),
    };
    const edits = [
      { editRef: refs.c, fromRef: refs.a, flow: "next", description: "一到三" },
      { editRef: refs.b, fromRef: refs.c, flow: "next", description: "三到二" },
      { editRef: refs.d, fromRef: refs.b, flow: "next", description: "二到四" },
    ];
    const requestId = randomUUID();
    const first = await postRearrange(handle.url, handle.workspaceId, requestId, edits);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { revision: number; state: string };
    const afterFirst = await chainGraph(handle.url);

    const replay = await postRearrange(handle.url, handle.workspaceId, requestId, edits);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { revision: number; replayed?: boolean };
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.revision).toBe(firstBody.revision);
    expect(await chainGraph(handle.url)).toEqual(afterFirst);
  });

  it("最终结构成环 → 422，且源文件不变", async () => {
    const root = await newChainWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const bPath = path.join(root, "topics", CHAIN_DIR, LINK_B + ".md");
    const cPath = path.join(root, "topics", CHAIN_DIR, LINK_C + ".md");
    const dPath = path.join(root, "topics", CHAIN_DIR, LINK_D + ".md");
    const before = [
      await fs.readFile(bPath),
      await fs.readFile(cPath),
      await fs.readFile(dPath),
    ];
    const aRef = await chainRef(handle.url, LINK_A);
    const bRef = await chainRef(handle.url, LINK_B);
    const cRef = await chainRef(handle.url, LINK_C);
    const dRef = await chainRef(handle.url, LINK_D);

    // B 改接到 C；D 让出 C 的 next 槽位，最终 B→C→B 成环。
    const response = await postRearrange(handle.url, handle.workspaceId, randomUUID(), [
      {
        editRef: bRef,
        fromRef: cRef,
        flow: "next",
        description: "形成环的连接",
      },
      {
        editRef: dRef,
        fromRef: aRef,
        flow: "branch",
        side: "left",
        order: 10,
        description: "D 改挂到 A 的旁支",
      },
    ]);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(await fs.readFile(bPath)).toEqual(before[0]);
    expect(await fs.readFile(cPath)).toEqual(before[1]);
    expect(await fs.readFile(dPath)).toEqual(before[2]);
  });
});

describe("服务读取契约：meta 与 section", () => {
  it("meta 无正文但有 editRef，range.total 是真实正文长度；冲突参数 400", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const full = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?full=true")
    ).json()) as { body: string; fileHash: string };
    const metaResponse = await fetch(
      handle.url + "/api/agent/nodes/" + NEXT_NODE + "?meta=true",
    );
    expect(metaResponse.status).toBe(200);
    const meta = (await metaResponse.json()) as {
      body: string;
      bodyOmitted?: boolean;
      truncated: boolean;
      range: { start: number; end: number; total: number; unit: string };
      section: unknown;
      fileHash: string;
      editRef: { ref: string; nodeId: string; path: string };
    };
    expect(meta.body).toBe("");
    expect(meta.bodyOmitted).toBe(true);
    expect(meta.truncated).toBe(false);
    expect(meta.range).toEqual({
      start: 0,
      end: 0,
      total: full.body.length,
      unit: "utf16",
    });
    expect(meta.section).toBeNull();
    expect(meta.fileHash).toBe(full.fileHash);
    expect(meta.editRef.ref).toMatch(/^er_/);
    expect(meta.editRef.nodeId).toBe(NEXT_NODE);
    expect(meta.editRef.path).toBe("topics/" + DIR + "/" + NEXT_NODE + ".md");

    const withLength = await fetch(
      handle.url + "/api/agent/nodes/" + NEXT_NODE + "?meta=true&length=10",
    );
    expect(withLength.status).toBe(400);
    const badIndex = await fetch(
      handle.url + "/api/agent/nodes/" + NEXT_NODE + "?section-index=1",
    );
    expect(badIndex.status).toBe(400);
    const blankSection = await fetch(
      handle.url + "/api/agent/nodes/" + NEXT_NODE + "?section=%20%20",
    );
    expect(blankSection.status).toBe(400);
    const missingSection = await fetch(
      handle.url + "/api/agent/nodes/" + NEXT_NODE + "?section=" + encodeURIComponent("不存在"),
    );
    expect(missingSection.status).toBe(400);
    expect(((await missingSection.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_SECTION",
    );
  });

  it("section 从章节起点切片，且与 core 的离线定位一致", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const file = path.join(root, "topics", DIR, NEXT_NODE + ".md");
    const text = await fs.readFile(file, "utf8");
    const body = [
      "## 小节一",
      "",
      "默认更新现有内容。",
      "",
      "## 小节二",
      "",
      "第二段补充说明。",
      "",
      "## 同名",
      "",
      "第一处。",
      "",
      "## 同名",
      "",
      "第二处。",
      "",
    ].join("\n");
    await fs.writeFile(
      file,
      text.replace(
        "默认更新现有内容。\n\n第二段补充说明。\n",
        body,
      ),
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 1600));

    const full = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?full=true")
    ).json()) as { body: string };
    // 离线读取用同一份 core helper；在线结果必须与它一致。
    const offline = locateSection(full.body, "小节一");
    const first = (await (
      await fetch(
        handle.url + "/api/agent/nodes/" + NEXT_NODE + "?section=" + encodeURIComponent("小节一"),
      )
    ).json()) as {
      body: string;
      range: { start: number; end: number; total: number };
      section: { title: string; level: number; start: number } | null;
    };
    expect(first.range.start).toBe(offline.start);
    expect(first.body.startsWith("## 小节一")).toBe(true);
    expect(first.section?.title).toBe("小节一");
    expect(first.section?.level).toBe(2);
    expect(first.section?.start).toBe(offline.start);

    const secondStart = full.body.indexOf("## 小节二");
    const second = (await (
      await fetch(
        handle.url +
          "/api/agent/nodes/" +
          NEXT_NODE +
          "?section=" +
          encodeURIComponent("小节二") +
          "&full=true",
      )
    ).json()) as { body: string; section: { title: string } | null };
    expect(second.body).toBe(full.body.slice(secondStart));
    expect(second.section?.title).toBe("小节二");

    // 重名标题：不猜第几个；显式 index 后与 core 的离线定位一致。
    const ambiguous = await fetch(
      handle.url + "/api/agent/nodes/" + NEXT_NODE + "?section=" + encodeURIComponent("同名"),
    );
    expect(ambiguous.status).toBe(400);
    const indexed = (await (
      await fetch(
        handle.url +
          "/api/agent/nodes/" +
          NEXT_NODE +
          "?section=" +
          encodeURIComponent("同名") +
          "&section-index=1",
      )
    ).json()) as { range: { start: number }; section: { title: string } | null };
    expect(indexed.range.start).toBe(locateSection(full.body, "同名", 1).start);
    expect(indexed.section?.title).toBe("同名");
  });

  it("缩进标题与围栏代码共用 AST 章节表，index 是全文标题顺序", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const file = path.join(root, "topics", DIR, NEXT_NODE + ".md");
    const text = await fs.readFile(file, "utf8");
    const body = [
      "   ## 缩进标题",
      "",
      "第一段。",
      "",
      "```md",
      "# 围栏里的假标题",
      "```",
      "",
      "## 第二个标题",
      "",
      "第二段。",
      "",
    ].join("\n");
    await fs.writeFile(
      file,
      text.replace("默认更新现有内容。\n\n第二段补充说明。\n", body),
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 1600));

    const full = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?full=true")
    ).json()) as { body: string };

    // 缩进标题由 AST 识别；start 从 `#` 起算，与离线 locateSection 一致。
    const indented = (await (
      await fetch(
        handle.url +
          "/api/agent/nodes/" +
          NEXT_NODE +
          "?section=" +
          encodeURIComponent("缩进标题") +
          "&full=true",
      )
    ).json()) as {
      body: string;
      range: { start: number };
      section: { index: number; title: string; level: number; start: number } | null;
    };
    expect(indented.range.start).toBe(locateSection(full.body, "缩进标题").start);
    expect(indented.body.startsWith("## 缩进标题")).toBe(true);
    expect(indented.section).toMatchObject({ index: 0, title: "缩进标题", level: 2 });

    // 围栏里的 "#" 不是章节。
    const fenced = await fetch(
      handle.url +
        "/api/agent/nodes/" +
        NEXT_NODE +
        "?section=" +
        encodeURIComponent("围栏里的假标题"),
    );
    expect(fenced.status).toBe(400);
    expect(((await fenced.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_SECTION",
    );

    // 假标题不占 index：第二个真实标题是全文第 1 个章节（0 起）。
    const second = (await (
      await fetch(
        handle.url +
          "/api/agent/nodes/" +
          NEXT_NODE +
          "?section=" +
          encodeURIComponent("第二个标题") +
          "&full=true",
      )
    ).json()) as {
      range: { start: number };
      section: { index: number; title: string } | null;
    };
    expect(second.range.start).toBe(full.body.indexOf("## 第二个标题"));
    expect(second.section).toMatchObject({ index: 1, title: "第二个标题" });
  });
});
describe("提交刷新失败", () => {
  it("源文件已提交但快照刷新失败：返回 pending、保留日志、停用写入并给出统一诊断", async () => {
    const root = await newWorkspace();
    const runtime = await WorkspaceRuntime.create(root);
    running.push(runtime);
    runtime.port = 4399;
    vi.spyOn(runtime, "reloadFromDisk").mockResolvedValue({
      ok: false,
      diagnostics: [
        { code: "DISK_UNREADABLE", message: "测试用无法重建快照", severity: "error" },
      ],
      snapshot: null,
      revision: runtime.revision,
      published: false,
    });

    const app = createApp({ runtime, webRoot: null });
    const response = await app.request("http://127.0.0.1:4399/api/agent/changes", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4399",
        "content-type": "application/json",
        "x-aichat-client": "cli",
      },
      body: JSON.stringify({
        workspaceId: runtime.workspaceId,
        requestId: randomUUID(),
        action: { action: "createTopic", topicTitle: "刷新失败主题", body: "仍应落盘。" },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      state: string;
      transactionId: string | null;
      journalCleaned: boolean;
      diagnostics: Array<{ code: string; message: string }>;
      created: { topicPath: string | null; nodeIds: string[] };
      refs: unknown;
    };
    expect(body.state).toBe("committed_refresh_pending");
    expect(body.transactionId).not.toBeNull();
    expect(body.journalCleaned).toBe(false);
    // 与低层 apply 一致：刷新失败诊断 + 明确的保留日志说明。
    expect(body.diagnostics.map((item) => item.code)).toContain("DISK_UNREADABLE");
    const pending = body.diagnostics.filter(
      (item) => item.code === "COMMITTED_REFRESH_PENDING",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.message).toContain("源文件已提交并保留事务日志");
    expect(body.refs).toEqual({});

    // 不回滚：新节点文件已落盘；写入停用；事务日志仍在等待重启核对。
    const topicDir = (body.created.topicPath ?? "").split("/")[1] ?? "";
    expect(
      await fs.readFile(
        path.join(root, ...(body.created.topicPath ?? "").split("/")),
        "utf8",
      ),
    ).toContain("刷新失败主题");
    const nodePath = path.join(
      root,
      "topics",
      topicDir,
      (body.created.nodeIds[0] ?? "") + ".md",
    );
    expect(await fs.readFile(nodePath, "utf8")).toContain("仍应落盘。");
    expect(runtime.writable).toBe(false);
    expect(runtime.writableReason).toBe("COMMITTED_REFRESH_PENDING");
    const journals = await fs.readdir(path.join(root, ".aichat", "runtime", "transactions"));
    expect(journals.length).toBeGreaterThan(0);
  });
});

describe("edit 复合动作：内容／入边／重要性同一事务", () => {
  interface AgentGraphBody {
    nodes: Array<{
      id: string;
      from: string | null;
      flow: string;
      description?: string;
      important: boolean;
      title: string;
      state: string;
    }>;
    lastChanges?: Record<string, { at: string; nodeIds: string[] }>;
  }

  async function graphBody(url: string): Promise<AgentGraphBody> {
    return (await (await fetch(url + "/api/graph")).json()) as AgentGraphBody;
  }

  async function nodeRef(url: string, nodeId: string): Promise<string> {
    const response = await fetch(url + "/api/agent/nodes/" + nodeId + "?meta=true");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { body: string; editRef: { ref: string } };
    expect(body.body).toBe("");
    return body.editRef.ref;
  }

  async function postEdit(
    url: string,
    workspaceId: string,
    requestId: string,
    action: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(url + "/api/agent/changes", {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({ workspaceId, requestId, action }),
    });
  }

  async function nextNodeFile(root: string): Promise<string> {
    return fs.readFile(path.join(root, "topics", DIR, NEXT_NODE + ".md"), "utf8");
  }

  it("内容＋入边说明＋重要性一次请求提交，生成单一事务并更新图与最近更新", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const nextRef = await nodeRef(handle.url, NEXT_NODE);

    const response = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: nextRef,
      title: "复合后的标题",
      append: "复合追加的正文。",
      description: "复合后的入边说明",
      important: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      state: string;
      action: string;
      changedNodeIds: string[];
      refs: Record<string, string>;
      transactionId: string | null;
      summary: string;
      created: { nodeIds: string[] };
    };
    expect(body.state).toBe("committed");
    expect(body.action).toBe("patchNode");
    expect(body.changedNodeIds).toEqual([NEXT_NODE]);
    expect(body.refs[NEXT_NODE]).toMatch(/^er_/);
    expect(body.transactionId).not.toBeNull();
    expect(body.created.nodeIds).toEqual([]);
    // 同一请求编译出三个操作，按内容→入边→重要性顺序。
    expect(body.summary).toContain("patchNode");
    expect(body.summary).toContain("updateConnection");
    expect(body.summary).toContain("setImportance");

    const text = await nextNodeFile(root);
    expect(text).toContain("title: 复合后的标题");
    expect(text).toContain("复合追加的正文。");
    expect(text).toContain("description: 复合后的入边说明");
    expect(text).toContain("important: true");

    const graph = await graphBody(handle.url);
    const node = graph.nodes.find((entry) => entry.id === NEXT_NODE);
    expect(node).toMatchObject({
      title: "复合后的标题",
      description: "复合后的入边说明",
      from: ROOT_NODE,
      flow: "next",
      important: true,
    });
    expect(graph.lastChanges?.[TOPIC_ID]?.nodeIds).toEqual([NEXT_NODE]);
  });

  it("只改说明 / 只改关系类型：各自一条 updateConnection，来源保持不变", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const firstRef = await nodeRef(handle.url, NEXT_NODE);
    const described = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: firstRef,
      description: "只改入边说明",
    });
    expect(described.status).toBe(200);
    const describedBody = (await described.json()) as { refs: Record<string, string>; state: string };
    expect(describedBody.state).toBe("committed");
    let graph = await graphBody(handle.url);
    expect(graph.nodes.find((entry) => entry.id === NEXT_NODE)).toMatchObject({
      from: ROOT_NODE,
      flow: "next",
      description: "只改入边说明",
    });

    const secondRef = describedBody.refs[NEXT_NODE] as string;
    const retyped = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: secondRef,
      flow: "branch",
      description: "只把关系类型改为侧枝",
    });
    expect(retyped.status).toBe(200);
    graph = await graphBody(handle.url);
    expect(graph.nodes.find((entry) => entry.id === NEXT_NODE)).toMatchObject({
      from: ROOT_NODE,
      flow: "branch",
      description: "只把关系类型改为侧枝",
    });
    const text = await nextNodeFile(root);
    expect(text).toContain("flow: branch");
    expect(text).not.toContain("flow: next");
  });

  it("fromRef＋flow＋description 改接来源；来源读取后改动时 412 且不覆盖目标", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    // 先在根下建一个可作为新来源的侧枝。
    const rootRef = await nodeRef(handle.url, ROOT_NODE);
    const created = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "createBranch",
      editRef: rootRef,
      title: "新的来源",
      body: "新来源正文。",
      description: "先建一个可改接的来源",
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      created: { nodeIds: string[] };
      refs: Record<string, string>;
    };
    const sourceId = createdBody.created.nodeIds[0] as string;
    const sourceRef = createdBody.refs[sourceId] as string;

    const targetRef = await nodeRef(handle.url, NEXT_NODE);
    const targetBefore = await nextNodeFile(root);
    const response = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: targetRef,
      fromRef: sourceRef,
      flow: "branch",
      description: "改接到新的来源",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const graph = await graphBody(handle.url);
    expect(graph.nodes.find((entry) => entry.id === NEXT_NODE)).toMatchObject({
      from: sourceId,
      flow: "branch",
      description: "改接到新的来源",
    });
    expect(await nextNodeFile(root)).not.toBe(targetBefore);

    // 再读一次来源与目标；只改来源文件并等发布，来源旧哈希必须 412，目标不被覆盖。
    const freshTarget = (await (
      await fetch(handle.url + "/api/agent/nodes/" + NEXT_NODE + "?meta=true")
    ).json()) as { editRef: { ref: string } };
    const freshSource = (await (
      await fetch(handle.url + "/api/agent/nodes/" + sourceId + "?meta=true")
    ).json()) as { editRef: { ref: string } };
    const targetBytes = await nextNodeFile(root);
    const sourcePath = path.join(root, "topics", DIR, sourceId + ".md");
    await fs.writeFile(
      sourcePath,
      (await fs.readFile(sourcePath, "utf8")) + "\n外部追加。\n",
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const stale = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: freshTarget.editRef.ref,
      fromRef: freshSource.editRef.ref,
      flow: "branch",
      description: "来源已变，不应写入",
    });
    expect(stale.status).toBe(412);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("VERSION_CONFLICT");
    expect(await nextNodeFile(root)).toBe(targetBytes);
  });

  it("根节点不接受 description／fromRef／flow：422 结构错误且不落盘", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const rootRef = await nodeRef(handle.url, ROOT_NODE);
    const nextRef = await nodeRef(handle.url, NEXT_NODE);
    const rootPath = path.join(root, "topics", DIR, ROOT_NODE + ".md");
    const before = await fs.readFile(rootPath, "utf8");

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ description: "根没有入边" }, "description"],
      [{ flow: "branch", description: "根没有入边" }, "flow"],
      [{ fromRef: nextRef, flow: "branch", description: "根没有入边" }, "fromRef"],
    ];
    for (const [fields, field] of cases) {
      const response = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
        action: "patchNode",
        editRef: rootRef,
        ...fields,
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as {
        error: { code: string; message: string; details?: Record<string, unknown> };
      };
      expect(body.error.code).toBe("VALIDATION_FAILED");
      expect(body.error.details?.["category"]).toBe("structure");
      expect(body.error.details?.["nodeId"]).toBe(ROOT_NODE);
      expect(body.error.details?.["field"]).toBe(field);
      expect(body.error.message).toContain("根节点没有入边");
      expect(body.error.message).toContain("aichat help edit --json");
    }
    expect(await fs.readFile(rootPath, "utf8")).toBe(before);

    // 根节点只改内容／重要标记仍允许。
    const allowed = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: rootRef,
      title: "根的标题可以改",
      important: true,
    });
    expect(allowed.status).toBe(200);
  });

  it("跨主题来源／自连是 422 结构错误，不落盘", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const nextRef = await nodeRef(handle.url, NEXT_NODE);
    const targetBefore = await nextNodeFile(root);

    // 自连。
    const self = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: nextRef,
      fromRef: nextRef,
      flow: "next",
      description: "不能自连",
    });
    expect(self.status).toBe(422);
    const selfBody = (await self.json()) as {
      error: { details?: Record<string, unknown> };
    };
    expect(selfBody.error.details?.["category"]).toBe("structure");
    expect(selfBody.error.details?.["field"]).toBe("fromRef");

    // 另建主题，再跨主题改接。
    const topicCreated = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "createTopic",
      topicTitle: "另一个主题",
      body: "另一个主题的起点。",
    });
    expect(topicCreated.status).toBe(200);
    const topicBody = (await topicCreated.json()) as {
      created: { nodeIds: string[] };
      refs: Record<string, string>;
    };
    const otherRoot = topicBody.created.nodeIds[0] as string;
    const otherRef = topicBody.refs[otherRoot] as string;

    const cross = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: nextRef,
      fromRef: otherRef,
      flow: "branch",
      description: "不能跨主题",
    });
    expect(cross.status).toBe(422);
    const crossBody = (await cross.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(crossBody.error.code).toBe("VALIDATION_FAILED");
    expect(crossBody.error.details?.["category"]).toBe("structure");
    expect(crossBody.error.details?.["field"]).toBe("fromRef");
    expect(crossBody.error.details?.["sourceTopicId"]).toBeTypeOf("string");
    expect(await nextNodeFile(root)).toBe(targetBefore);
  });

  it("仅 important 不替换最近内容更新；内容与入边改写计入", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    // 先制造一次真实内容更新作为基线。
    const baselineRef = await nodeRef(handle.url, NEXT_NODE);
    const baselineResponse = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: baselineRef,
      title: "基线标题",
    });
    expect(baselineResponse.status).toBe(200);
    const baseline = (await graphBody(handle.url)).lastChanges?.[TOPIC_ID];
    expect(baseline?.nodeIds).toEqual([NEXT_NODE]);

    // 只改 important：文件改写但不替换最近内容更新。
    const importantRef = await nodeRef(handle.url, NEXT_NODE);
    const importantOnly = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: importantRef,
      important: true,
    });
    expect(importantOnly.status).toBe(200);
    const importantBody = (await importantOnly.json()) as {
      state: string;
      changedNodeIds: string[];
      refs: Record<string, string>;
    };
    expect(importantBody.state).toBe("committed");
    expect(importantBody.changedNodeIds).toEqual([NEXT_NODE]);
    expect(importantBody.refs[NEXT_NODE]).toMatch(/^er_/);
    expect((await graphBody(handle.url)).lastChanges?.[TOPIC_ID]).toEqual(baseline);
    expect(await nextNodeFile(root)).toContain("important: true");

    // 混合入边改写：真实写文件，计入最近内容更新。
    const mixedRef = importantBody.refs[NEXT_NODE] as string;
    const mixed = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: mixedRef,
      description: "混合改写的入边说明",
      important: false,
    });
    expect(mixed.status).toBe(200);
    expect((await graphBody(handle.url)).lastChanges?.[TOPIC_ID]?.nodeIds).toEqual([NEXT_NODE]);
    expect(await nextNodeFile(root)).toContain("description: 混合改写的入边说明");
  });

  it("schema 连带校验：fromRef 缺 flow／缺 description、空 description、无修改都 400", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const nextRef = await nodeRef(handle.url, NEXT_NODE);

    const cases: Array<Record<string, unknown>> = [
      { fromRef: nextRef, description: "缺 flow" },
      { flow: "branch" },
      { description: "   " },
      {},
      { side: "left", description: "batch 才有的字段" },
      { flow: "root", description: "root 不是允许的关系类型" },
    ];
    for (const fields of cases) {
      const response = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
        action: "patchNode",
        editRef: nextRef,
        ...fields,
      });
      expect(response.status, JSON.stringify(fields)).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("BAD_REQUEST");
    }
  });

  it("占位后继：目标改 next 但来源已有 next → 409，不挤掉旧后继", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const rootRef = await nodeRef(handle.url, ROOT_NODE);
    const source = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "createBranch",
      editRef: rootRef,
      title: "来源 S",
      body: "来源 S 的正文。",
      description: "作为改接来源",
    });
    expect(source.status).toBe(200);
    const sourceBody = (await source.json()) as {
      created: { nodeIds: string[] };
      refs: Record<string, string>;
    };
    const sourceId = sourceBody.created.nodeIds[0] as string;
    const sourceRef = sourceBody.refs[sourceId] as string;

    // 让 NEXT 成为 S 的 next（S 之前没有 next）。
    const nextRef = await nodeRef(handle.url, NEXT_NODE);
    const attached = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: nextRef,
      fromRef: sourceRef,
      flow: "next",
      description: "先挂到来源 S 下",
    });
    expect(attached.status).toBe(200);

    // 再建一个侧枝，想抢 S 的 next：必须 409，不自动挤掉 NEXT。
    const second = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "createBranch",
      editRef: rootRef,
      title: "第二条",
      body: "第二条正文。",
      description: "再建一张",
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      created: { nodeIds: string[] };
      refs: Record<string, string>;
    };
    const secondId = secondBody.created.nodeIds[0] as string;
    const secondRef = secondBody.refs[secondId] as string;
    const secondPath = path.join(root, "topics", DIR, secondId + ".md");
    const secondBefore = await fs.readFile(secondPath, "utf8");

    const conflict = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: secondRef,
      fromRef: sourceRef,
      flow: "next",
      description: "不应挤掉已有 next",
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(conflictBody.error.code).toBe("OPERATION_CONFLICT");
    expect(await fs.readFile(secondPath, "utf8")).toBe(secondBefore);
    const graph = await graphBody(handle.url);
    expect(graph.nodes.find((entry) => entry.id === sourceId)).toMatchObject({ flow: "branch" });
  });

  it("改入边形成环 → 422 且不落盘", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    // 在 NEXT 下建一个子节点，再把 NEXT 的来源改成该子节点，形成环。
    const nextRef = await nodeRef(handle.url, NEXT_NODE);
    const child = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "createBranch",
      editRef: nextRef,
      title: "子节点",
      body: "子节点正文。",
      description: "NEXT 的子节点",
    });
    expect(child.status).toBe(200);
    const childBody = (await child.json()) as {
      created: { nodeIds: string[] };
      refs: Record<string, string>;
    };
    const childId = childBody.created.nodeIds[0] as string;
    const childRef = childBody.refs[childId] as string;
    const nextPath = path.join(root, "topics", DIR, NEXT_NODE + ".md");
    const childPath = path.join(root, "topics", DIR, childId + ".md");
    const nextBefore = await fs.readFile(nextPath, "utf8");
    const childBefore = await fs.readFile(childPath, "utf8");

    const cycle = await postEdit(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: nextRef,
      fromRef: childRef,
      flow: "next",
      description: "不应形成环",
    });
    expect(cycle.status).toBe(422);
    expect(((await cycle.json()) as { error: { code: string } }).error.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(await fs.readFile(nextPath, "utf8")).toBe(nextBefore);
    expect(await fs.readFile(childPath, "utf8")).toBe(childBefore);
  });
});
