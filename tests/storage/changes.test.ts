import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTopicDocument } from "../../src/core/index.js";
import {
  ChangeError,
  prepareChanges,
  type ChangeRequest,
  type Operation,
} from "../../src/storage/changes.js";
import { initWorkspace, readWorkspaceFiles, sha256Bytes } from "../../src/storage/index.js";
import type { WorkspaceFiles } from "../../src/storage/workspace.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const ROOT_ID = "n_00000000000000000000000000000001";
const CHILD_ID = "n_00000000000000000000000000000002";
const NEXT_ID = "n_00000000000000000000000000000003";
const BRANCH_ID = "n_00000000000000000000000000000004";
const OTHER_ID = "n_00000000000000000000000000000005";
const TOPIC_A = "t_0000000000000000000000000000000a";
const TOPIC_B = "t_0000000000000000000000000000000b";

interface TopicNodeFixture {
  id: string;
  title: string;
  body?: string;
  from?: string | null;
  flow?: "root" | "next" | "branch";
  state?: "agreed" | "proposed" | "reference";
  side?: "left" | "right";
  order?: number;
  label?: string;
  summary?: string;
}

function buildTopic(options: {
  topicId: string;
  title: string;
  nodes: TopicNodeFixture[];
  nl?: string;
  bom?: boolean;
}): string {
  const nl = options.nl ?? "\n";
  const lines: string[] = ["schemaVersion: 1", "topicId: " + options.topicId, "title: " + options.title];
  if (options.nodes.length === 0) lines.push("nodes: {}");
  else {
    lines.push("nodes:");
    for (const node of options.nodes) {
      lines.push("  " + node.id + ":");
      lines.push("    from: " + (node.from === undefined || node.from === null ? "null" : node.from));
      lines.push("    flow: " + (node.flow ?? "next"));
      lines.push("    state: " + (node.state ?? "proposed"));
      if (node.side !== undefined) lines.push("    side: " + node.side);
      if (node.order !== undefined) lines.push("    order: " + node.order);
      if (node.label !== undefined) lines.push("    label: " + JSON.stringify(node.label));
      if (node.summary !== undefined) lines.push("    summary: " + JSON.stringify(node.summary));
    }
  }
  const parts = ["---", ...lines, "---", ""];
  for (const node of options.nodes) {
    parts.push("## " + node.title + " <!-- node:" + node.id + " -->", "");
    if (node.body !== undefined) parts.push(node.body, "");
  }
  const text = parts.join(nl) + nl;
  return (options.bom ? "\uFEFF" : "") + text;
}

const ROOT_NODE: TopicNodeFixture = {
  id: ROOT_ID,
  title: "根节点",
  body: "根节点正文。",
  flow: "root",
  from: null,
  state: "agreed",
};

const CHILD_NODE: TopicNodeFixture = {
  id: CHILD_ID,
  title: "子节点",
  body: "子节点正文。",
  from: ROOT_ID,
  flow: "next",
  state: "agreed",
};

async function newFiles(
  topics: Record<string, string>,
  workspaceOverride?: Record<string, unknown>,
): Promise<{ files: WorkspaceFiles; root: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-changes-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "ws");
  // 本文件全部是格式 1（一个主题文件内多张卡）的候选用例：显式要求格式 1。
  const { workspaceId } = await initWorkspace({ root, name: "changes-test", schemaVersion: 1 });
  for (const [relative, content] of Object.entries(topics)) {
    const target = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  if (workspaceOverride) {
    const identity = JSON.parse(await fs.readFile(path.join(root, "workspace.json"), "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      path.join(root, "workspace.json"),
      JSON.stringify({ ...identity, ...workspaceOverride }, null, 2) + "\n",
      "utf8",
    );
  }
  const files = await readWorkspaceFiles(root);
  expect(files.workspace.workspaceId).toBe(workspaceId);
  return { files, root };
}

function expectedAll(files: WorkspaceFiles, overrides: Record<string, string | null> = {}): Record<string, string | null> {
  const declared: Record<string, string | null> = { "workspace.json": files.workspaceFile.sha256 };
  for (const topic of files.topics) declared[topic.path] = topic.sha256;
  return { ...declared, ...overrides };
}

function request(
  files: WorkspaceFiles,
  operations: Operation[],
  options: { expectedFiles?: Record<string, string | null>; workspaceId?: string } = {},
): ChangeRequest {
  return {
    workspaceId: options.workspaceId ?? files.workspace.workspaceId,
    requestId: crypto.randomUUID(),
    expectedFiles: options.expectedFiles ?? expectedAll(files),
    operations,
  };
}

function fileOf(changes: ReturnType<typeof prepareChanges>, filePath: string) {
  return changes.files.find((file) => file.path === filePath);
}

function nodeBlock(text: string, nodeId: string): string {
  const parsed = parseTopicDocument(text);
  expect(parsed.ok).toBe(true);
  const node = parsed.topic?.nodes.find((entry) => entry.id === nodeId);
  expect(node).toBeDefined();
  return text.slice(node!.ranges.node.start, node!.ranges.node.end);
}

describe("prepareChanges：局部更新保持相邻正文", () => {
  it("中文😀与 CRLF 文件的正文局部更新不影响相邻卡片", async () => {
    const topicText = buildTopic({
      topicId: TOPIC_A,
      title: "主题甲",
      nl: "\r\n",
      bom: true,
      nodes: [
        { ...ROOT_NODE, title: "根节点 😀", body: "第一段中文😀内容。\r\n\r\n- 列表项一\r\n- 列表项二" },
        { ...CHILD_NODE, title: "子节点", body: "子节点正文，保持原样。" },
      ],
    });
    const { files } = await newFiles({ "topics/a.md": topicText });
    const before = nodeBlock(topicText, CHILD_ID);

    const updated = "改写后的中文😀正文。\n\n### 内部三级标题\n\n细节说明。";
    const changes = prepareChanges(
      files,
      request(files, [{ op: "updateNode", nodeId: ROOT_ID, body: updated, title: "根节点 😀 v2" }]),
    );

    const output = fileOf(changes, "topics/a.md");
    expect(output?.content).toBeTypeOf("string");
    const text = output!.content as string;
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text).toContain("\r\n");
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text).toContain("根节点 😀 v2");
    expect(text).toContain("### 内部三级标题");
    expect(nodeBlock(text, CHILD_ID)).toBe(before);
    expect(changes.changedNodeIds).toEqual([ROOT_ID]);
    expect(changes.files).toHaveLength(1);
    expect(output?.expectedSha256).toBe(files.topics[0]?.sha256);
  });

  it("无实际变化的 updateNode 返回空文件列表", async () => {
    const { files } = await newFiles({
      "topics/a.md": buildTopic({ topicId: TOPIC_A, title: "甲", nodes: [ROOT_NODE] }),
    });
    const changes = prepareChanges(files, request(files, [{ op: "updateNode", nodeId: ROOT_ID }]));
    expect(changes.files).toEqual([]);
    expect(changes.changedNodeIds).toEqual([]);
  });
});

describe("prepareChanges：insertNext 跨文件重新连接", () => {
  it("跨文件插入新节点时把原后继接回新节点", async () => {
    const topicA = buildTopic({ topicId: TOPIC_A, title: "甲", nodes: [ROOT_NODE] });
    const topicB = buildTopic({ topicId: TOPIC_B, title: "乙", nodes: [CHILD_NODE] });
    const { files } = await newFiles({ "topics/a.md": topicA, "topics/b.md": topicB });

    const changes = prepareChanges(
      files,
      request(files, [
        {
          op: "insertNext",
          sourceId: ROOT_ID,
          node: {
            nodeId: NEXT_ID,
            topicId: TOPIC_A,
            title: "插入节点",
            body: "插入正文。",
            state: "proposed",
          },
        },
      ]),
    );

    const changedA = parseTopicDocument(fileOf(changes, "topics/a.md")!.content as string);
    const changedB = parseTopicDocument(fileOf(changes, "topics/b.md")!.content as string);
    expect(changedA.ok && changedB.ok).toBe(true);
    const inserted = changedA.topic!.nodes.find((node) => node.id === NEXT_ID);
    const reconnected = changedB.topic!.nodes.find((node) => node.id === CHILD_ID);
    expect(inserted?.from).toBe(ROOT_ID);
    expect(inserted?.flow).toBe("next");
    expect(reconnected?.from).toBe(NEXT_ID);
    expect(changes.changedNodeIds).toEqual([NEXT_ID, CHILD_ID]);
    expect(changes.files.map((file) => file.path).sort()).toEqual(["topics/a.md", "topics/b.md"]);
  });
});

describe("prepareChanges：moveNodeToTopic 与空主题删除", () => {
  it("保留节点 ID 并显式删除被清空的主题文件", async () => {
    const topicA = buildTopic({ topicId: TOPIC_A, title: "甲", nodes: [ROOT_NODE] });
    const topicB = buildTopic({ topicId: TOPIC_B, title: "乙", nodes: [CHILD_NODE] });
    const { files } = await newFiles({ "topics/a.md": topicA, "topics/b.md": topicB });

    const changes = prepareChanges(
      files,
      request(files, [{ op: "moveNodeToTopic", nodeId: CHILD_ID, topicId: TOPIC_A }]),
    );

    expect(fileOf(changes, "topics/b.md")).toEqual({
      path: "topics/b.md",
      content: null,
      expectedSha256: files.topics.find((file) => file.path === "topics/b.md")!.sha256,
    });
    const merged = parseTopicDocument(fileOf(changes, "topics/a.md")!.content as string);
    expect(merged.ok).toBe(true);
    expect(merged.topic!.nodes.map((node) => node.id)).toEqual([ROOT_ID, CHILD_ID]);
    expect(merged.topic!.nodes[1]?.from).toBe(ROOT_ID);
  });
});

describe("prepareChanges：前置哈希", () => {
  it("缺少 workspace.json 声明时拒绝（409 details.missingFiles）", async () => {
    const topicText = buildTopic({ topicId: TOPIC_A, title: "甲", nodes: [ROOT_NODE] });
    const { files } = await newFiles({ "topics/a.md": topicText });
    const expected = expectedAll(files);
    delete expected["workspace.json"];

    let error: unknown;
    try {
      prepareChanges(
        files,
        request(files, [{ op: "setDiscussionFocus", nodeId: ROOT_ID }], { expectedFiles: expected }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChangeError);
    expect((error as ChangeError).code).toBe("OPERATION_CONFLICT");
    expect((error as ChangeError).details?.["missingFiles"]).toEqual(["workspace.json"]);
  });

  it("哈希不符时返回 412 冲突明细且不产生候选", async () => {
    const topicText = buildTopic({ topicId: TOPIC_A, title: "甲", nodes: [ROOT_NODE] });
    const { files } = await newFiles({ "topics/a.md": topicText });
    const expected = expectedAll(files, { "topics/a.md": sha256Bytes("stale") });

    let error: unknown;
    try {
      prepareChanges(
        files,
        request(files, [{ op: "setDiscussionFocus", nodeId: null }], { expectedFiles: expected }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChangeError);
    const changeError = error as ChangeError;
    expect(changeError.code).toBe("VERSION_CONFLICT");
    const conflicts = changeError.details?.["conflicts"] as Array<Record<string, unknown>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      path: "topics/a.md",
      expectedSha256: sha256Bytes("stale"),
      actualSha256: files.topics[0]?.sha256,
    });
  });

  it("未声明的新建文件目标路径与 workspaceId 不符都被拒绝", async () => {
    const { files } = await newFiles({});
    let mismatch: unknown;
    try {
      prepareChanges(files, request(files, [], { workspaceId: "w_other" }));
    } catch (caught) {
      mismatch = caught;
    }
    expect((mismatch as ChangeError).code).toBe("BAD_REQUEST");

    let unknownField: unknown;
    try {
      prepareChanges(files, {
        ...request(files, []),
        extra: true,
      } as unknown as ChangeRequest);
    } catch (caught) {
      unknownField = caught;
    }
    expect((unknownField as ChangeError).code).toBe("BAD_REQUEST");
  });
});

describe("prepareChanges：replaceTopic 修复坏主题", () => {
  it("用合法原文替换无法解析的主题，其他操作不得基于旧快照", async () => {
    const broken = "---\nschemaVersion: 1\ntopicId: " + TOPIC_A + "\ntitle: 坏主题\nnodes:\n  " + ROOT_ID + ":\n    from: null\n    flow: root\n    state: agreed\n---\n\n## 缺注释的标题\n\n正文\n";
    const { files } = await newFiles({ "topics/a.md": broken });
    expect(files.topics).toHaveLength(1);

    let blocked: unknown;
    try {
      prepareChanges(files, request(files, [{ op: "setDiscussionFocus", nodeId: ROOT_ID }]));
    } catch (caught) {
      blocked = caught;
    }
    expect((blocked as ChangeError).code).toBe("VALIDATION_FAILED");

    const raw = buildTopic({
      topicId: TOPIC_A,
      title: "修好的主题",
      nodes: [ROOT_NODE],
    });
    const changes = prepareChanges(
      files,
      request(files, [{ op: "replaceTopic", topicId: TOPIC_A, path: "topics/a.md", raw }]),
    );
    expect(fileOf(changes, "topics/a.md")?.content).toBe(raw);
    expect(changes.changedNodeIds).toEqual([ROOT_ID]);
  });
});

describe("prepareChanges：mergeNodes 必须显式重接", () => {
  const survivor = { ...ROOT_NODE, id: "n_0000000000000000000000000000000a", title: "幸存者" };
  const merged = { ...CHILD_NODE, id: "n_0000000000000000000000000000000b", title: "被合并", from: survivor.id };
  const orphan = { ...ROOT_NODE, id: "n_0000000000000000000000000000000c", title: "后继", flow: "next" as const, from: merged.id };

  it("未重接被合并节点的后继时拒绝，重接后保留 survivor ID", async () => {
    const topicText = buildTopic({ topicId: TOPIC_A, title: "甲", nodes: [survivor, merged, orphan] });
    const { files } = await newFiles({ "topics/a.md": topicText });

    let error: unknown;
    try {
      prepareChanges(
        files,
        request(files, [
          {
            op: "mergeNodes",
            survivorId: survivor.id,
            mergedNodeIds: [merged.id],
            body: "合并后的正文。",
            reconnect: [],
            activeNode: survivor.id,
          },
        ]),
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("OPERATION_CONFLICT");
    expect((error as ChangeError).details?.["missingReconnect"]).toEqual([orphan.id]);

    const changes = prepareChanges(
      files,
      request(files, [
        {
          op: "mergeNodes",
          survivorId: survivor.id,
          mergedNodeIds: [merged.id],
          body: "合并后的正文。",
          reconnect: [{ nodeId: orphan.id, from: survivor.id, flow: "next" }],
          activeNode: survivor.id,
        },
      ]),
    );
    const result = parseTopicDocument(fileOf(changes, "topics/a.md")!.content as string);
    expect(result.ok).toBe(true);
    expect(result.topic!.nodes.map((node) => node.id)).toEqual([survivor.id, orphan.id]);
    expect(result.topic!.nodes[0]?.body).toBe("合并后的正文。");
    expect(result.topic!.nodes[1]?.from).toBe(survivor.id);
  });
});

describe("prepareChanges：removeLeaf 与结构校验", () => {
  it("拒绝删除仍有后继的节点", async () => {
    const topicText = buildTopic({ topicId: TOPIC_A, title: "甲", nodes: [ROOT_NODE, CHILD_NODE] });
    const { files } = await newFiles({ "topics/a.md": topicText });
    let error: unknown;
    try {
      prepareChanges(files, request(files, [{ op: "removeLeaf", nodeId: ROOT_ID }]));
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("OPERATION_CONFLICT");
    expect((error as ChangeError).details?.["children"]).toEqual([CHILD_ID]);
  });

  it("删除真正的叶节点并保留其余结构", async () => {
    const leaf = { ...CHILD_NODE, id: "n_0000000000000000000000000000000d", title: "叶子" };
    const topicText = buildTopic({ topicId: TOPIC_A, title: "甲", nodes: [ROOT_NODE, leaf] });
    const { files } = await newFiles({ "topics/a.md": topicText });
    const changes = prepareChanges(files, request(files, [{ op: "removeLeaf", nodeId: leaf.id }]));
    const result = parseTopicDocument(fileOf(changes, "topics/a.md")!.content as string);
    expect(result.ok).toBe(true);
    expect(result.topic!.nodes.map((node) => node.id)).toEqual([ROOT_ID]);
  });
});

describe("prepareChanges：createTopic 必须同批带首卡", () => {
  it("只有 createTopic 时拒绝，带 createNode 时新建文件", async () => {
    const { files } = await newFiles({});
    const expected = { "workspace.json": files.workspaceFile.sha256, "topics/new.md": null };
    let error: unknown;
    try {
      prepareChanges(
        files,
        request(files, [{ op: "createTopic", topicId: TOPIC_B, path: "topics/new.md", title: "新主题" }], {
          expectedFiles: expected,
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("OPERATION_CONFLICT");

    const changes = prepareChanges(
      files,
      request(
        files,
        [
          { op: "createTopic", topicId: TOPIC_B, path: "topics/new.md", title: "新主题" },
          {
            op: "createNode",
            nodeId: ROOT_ID,
            topicId: TOPIC_B,
            title: "首卡",
            body: "首卡正文。",
            from: null,
            flow: "root",
            state: "proposed",
          },
        ],
        { expectedFiles: expected },
      ),
    );
    const created = fileOf(changes, "topics/new.md");
    expect(created?.expectedSha256).toBeNull();
    const result = parseTopicDocument(created!.content as string, { path: "topics/new.md" });
    expect(result.ok).toBe(true);
    expect(result.topic!.topicId).toBe(TOPIC_B);
    expect(result.topic!.nodes[0]?.id).toBe(ROOT_ID);
  });
});

describe("prepareChanges：标题与元数据约束", () => {
  it("标题含伪 ID 标记或换行时拒绝，摘要 null 删除显式摘要", async () => {
    const topicText = buildTopic({
      topicId: TOPIC_A,
      title: "甲",
      nodes: [{ ...ROOT_NODE, summary: "显式摘要" }],
    });
    const { files } = await newFiles({ "topics/a.md": topicText });

    for (const title of ["坏 <!-- node:n_0000000000000000000000000000000f -->", "多\n行"]) {
      let error: unknown;
      try {
        prepareChanges(files, request(files, [{ op: "updateNode", nodeId: ROOT_ID, title }]));
      } catch (caught) {
        error = caught;
      }
      expect((error as ChangeError).code).toBe("BAD_REQUEST");
    }

    const changes = prepareChanges(
      files,
      request(files, [{ op: "updateNode", nodeId: ROOT_ID, summary: null }]),
    );
    const result = parseTopicDocument(fileOf(changes, "topics/a.md")!.content as string);
    expect(result.ok).toBe(true);
    expect(result.topic!.nodes[0]?.summaryExplicit).toBe(false);
  });

  it("新增 branch 缺 order 时按 core 规则默认 max+10，并持久化该值", async () => {
    const existingBranch = {
      ...ROOT_NODE,
      id: "n_0000000000000000000000000000000e",
      title: "既有分支",
      flow: "branch" as const,
      from: ROOT_ID,
      side: "left" as const,
      order: 10,
    };
    const { files } = await newFiles({
      "topics/a.md": buildTopic({ topicId: TOPIC_A, title: "甲", nodes: [ROOT_NODE, existingBranch] }),
    });
    const changes = prepareChanges(
      files,
      request(files, [
        {
          op: "createNode",
          nodeId: BRANCH_ID,
          topicId: TOPIC_A,
          title: "分支",
          body: "",
          from: ROOT_ID,
          flow: "branch",
          state: "proposed",
          side: "right",
        },
      ]),
    );
    const result = parseTopicDocument(fileOf(changes, "topics/a.md")!.content as string);
    expect(result.ok).toBe(true);
    const created = result.topic!.nodes.find((node) => node.id === BRANCH_ID);
    expect(created?.order).toBe(20);
    expect(created?.side).toBe("right");
  });

  it("全局图校验兜底：next 冲突被拒绝", async () => {
    const secondNext = { ...CHILD_NODE, id: OTHER_ID, title: "第二个后继" };
    const topicText = buildTopic({ topicId: TOPIC_A, title: "甲", nodes: [ROOT_NODE, CHILD_NODE] });
    const { files } = await newFiles({ "topics/a.md": topicText });
    let error: unknown;
    try {
      prepareChanges(
        files,
        request(files, [
          {
            op: "createNode",
            nodeId: OTHER_ID,
            topicId: TOPIC_A,
            title: secondNext.title,
            body: "x",
            from: ROOT_ID,
            flow: "next",
            state: "proposed",
          },
        ]),
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("OPERATION_CONFLICT");
  });
});
const FIXTURE = path.resolve("tests/fixtures/workspace");

describe("prepareChanges：真实样例工作区", () => {
  it("moveBranch 只移动入口节点自身，后代保持原 from，其他卡片正文不变", async () => {
    const files = await readWorkspaceFiles(FIXTURE);
    expect(files.topics.length).toBe(2);
    const topicFile = files.topics.find((file) => file.path.includes("记录的分寸"))!;
    const parsed = parseTopicDocument(topicFile.text, { path: topicFile.path });
    expect(parsed.ok).toBe(true);
    const branch = parsed.topic!.nodes.find((node) => node.flow === "branch")!;
    const descendants = parsed.topic!.nodes.filter((node) => node.from === branch.id);
    expect(descendants.length).toBeGreaterThan(0);

    // 改挂到工作区根节点（不在该分支的子树内，不会成环）。
    const rootId = "n_6fe284797b7d4f249440c5e8596f715d";
    const changes = prepareChanges(files, request(files, [{ op: "moveBranch", nodeId: branch.id, from: rootId, side: "left", order: 30 }]),
    );

    const output = changes.files.find((file) => file.path === topicFile.path)!;
    const text = output.content as string;
    const after = parseTopicDocument(text, { path: topicFile.path });
    expect(after.ok).toBe(true);
    expect(after.topic!.nodes.map((node) => node.id)).toEqual(
      parsed.topic!.nodes.map((node) => node.id),
    );
    for (const node of parsed.topic!.nodes) {
      if (node.id === branch.id) continue;
      const now = after.topic!.nodes.find((entry) => entry.id === node.id)!;
      expect(text.slice(now.ranges.node.start, now.ranges.node.end)).toBe(
        topicFile.text.slice(node.ranges.node.start, node.ranges.node.end),
      );
    }
    const moved = after.topic!.nodes.find((node) => node.id === branch.id)!;
    expect(moved.from).toBe(rootId);
    expect(moved.side).toBe("left");
    expect(moved.order).toBe(30);
    for (const child of descendants) {
      const now = after.topic!.nodes.find((node) => node.id === child.id)!;
      expect(now.from).toBe(branch.id);
    }
    expect(changes.changedNodeIds).toEqual([branch.id]);
  });

  it("setDiscussionFocus 只改 workspace.json，同值视为 no-op", async () => {
    const files = await readWorkspaceFiles(FIXTURE);
    const current = files.workspace.activeNode!;
    expect(current).toBeTruthy();

    const unchanged = prepareChanges(files, request(files, [{ op: "setDiscussionFocus", nodeId: current }]));
    expect(unchanged.files).toEqual([]);
    expect(unchanged.changedNodeIds).toEqual([]);

    const cleared = prepareChanges(files, request(files, [{ op: "setDiscussionFocus", nodeId: null }]));
    expect(cleared.files.map((file) => file.path)).toEqual(["workspace.json"]);
    const output = cleared.files[0]!;
    expect(output.expectedSha256).toBe(files.workspaceFile.sha256);
    expect(JSON.parse(output.content as string)).toMatchObject({
      schemaVersion: 1,
      workspaceId: files.workspace.workspaceId,
      name: files.workspace.name,
      activeNode: null,
    });
  });
});