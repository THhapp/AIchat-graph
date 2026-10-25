import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChangeError,
  changeRequestSchema,
  commitFiles,
  flattenChangeRequestIssues,
  initWorkspace,
  prepareChanges,
  readWorkspaceFiles,
  recoverTransactions,
  type ChangeRequest,
  type Operation,
} from "../../src/storage/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const ROOT_ID = "n_00000000000000000000000000000001";
const CHILD_ID = "n_00000000000000000000000000000002";
const BRANCH_ID = "n_00000000000000000000000000000003";
const TOPIC_ID = "t_0000000000000000000000000000000a";
const TOPIC_ID_2 = "t_0000000000000000000000000000000b";

function nodeFile(options: {
  nodeId: string;
  title: string;
  state?: string;
  from?: string | null;
  flow?: "root" | "next" | "branch";
  description?: string;
  side?: "left" | "right";
  order?: number;
  body?: string;
  nl?: string;
}): string {
  const nl = options.nl ?? "\n";
  const lines = [
    "---",
    "nodeId: " + options.nodeId,
    "title: " + options.title,
    "state: " + (options.state ?? "proposed"),
    "from: " + (options.from ?? "null"),
    "flow: " + (options.flow ?? "next"),
  ];
  if (options.description !== undefined) lines.push("description: " + options.description);
  if (options.side !== undefined) lines.push("side: " + options.side);
  if (options.order !== undefined) lines.push("order: " + options.order);
  lines.push("---", "");
  if (options.body !== undefined) lines.push(options.body, "");
  return lines.join(nl) + nl;
}

function topicMeta(topicId: string, title: string): string {
  return "---\ntopicId: " + topicId + "\ntitle: " + title + "\n---\n";
}

async function newWorkspace(topics: Record<string, Record<string, string>>): Promise<{
  root: string;
  files: Awaited<ReturnType<typeof readWorkspaceFiles>>;
}> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-changes-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "ws");
  await initWorkspace({ root, name: "changes-test" });
  for (const [dir, files] of Object.entries(topics)) {
    const target = path.join(root, "topics", dir);
    await fs.mkdir(target, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(target, name), content, "utf8");
    }
  }
  return { root, files: await readWorkspaceFiles(root) };
}

function expectedAll(files: Awaited<ReturnType<typeof readWorkspaceFiles>>): Record<string, string | null> {
  const declared: Record<string, string | null> = { "workspace.json": files.workspaceFile.sha256 };
  for (const topic of files.topics) declared[topic.path] = topic.sha256;
  return declared;
}

function request(
  files: Awaited<ReturnType<typeof readWorkspaceFiles>>,
  operations: Operation[],
  overrides: Record<string, string | null> = {},
): ChangeRequest {
  return {
    workspaceId: files.workspace.workspaceId,
    requestId: crypto.randomUUID(),
    expectedFiles: { ...expectedAll(files), ...overrides },
    operations,
  };
}

const BASE_TOPIC = {
  "topic.md": topicMeta(TOPIC_ID, "协作方式"),
  [ROOT_ID + ".md"]: nodeFile({
    nodeId: ROOT_ID,
    title: "根节点",
    flow: "root",
    state: "agreed",
    body: "根节点正文。",
  }),
  [CHILD_ID + ".md"]: nodeFile({
    nodeId: CHILD_ID,
    title: "子节点",
    from: ROOT_ID,
    state: "agreed",
    description: "从根节点继续",
    body: "子节点正文。",
  }),
};

describe("当前格式扫描与 init", () => {
  it("新工作区默认 schemaVersion 2，节点是独立文件且无总表", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-changes-init-"));
    temporaryRoots.push(parent);
    const root = path.join(parent, "ws");
    await initWorkspace({ root, name: "新工作区" });
    const info = JSON.parse(await fs.readFile(path.join(root, "workspace.json"), "utf8")) as {
      schemaVersion: number;
    };
    expect(info.schemaVersion).toBe(2);
    expect(await fs.readdir(path.join(root, "topics"))).toEqual([]);
    const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("一个节点一份 Markdown");
    expect(agents).toContain("description");
    expect(agents).not.toContain("## 典型流程");
  });

  it("扫描把 topic.md 与节点文件都当作原始事实", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    expect(files.workspace.schemaVersion).toBe(2);
    expect(files.topics.map((file) => file.path).sort()).toEqual(
      [
        "topics/协作方式/" + CHILD_ID + ".md",
        "topics/协作方式/" + ROOT_ID + ".md",
        "topics/协作方式/topic.md",
      ].sort(),
    );
  });
});

describe("当前格式候选：局部修改与结构", () => {
  it("patchNode 片段替换只改目标节点文件，其他节点逐字节不变", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    const changes = prepareChanges(
      files,
      request(files, [{ op: "patchNode", nodeId: ROOT_ID, replace: [{ old: "根节点正文。", new: "改写后的根节点正文。" }] }]),
    );
    expect(changes.files.map((file) => file.path)).toEqual(["topics/协作方式/" + ROOT_ID + ".md"]);
    expect(changes.files[0]!.content).toContain("改写后的根节点正文。");
    expect(changes.changedNodeIds).toEqual([ROOT_ID]);
    const childFile = files.topics.find((file) => file.path.endsWith(CHILD_ID + ".md"))!;
    expect(changes.files.some((file) => file.path === childFile.path)).toBe(false);
  });

  it("patchNode 的 old 不唯一或找不到时拒绝", async () => {
    const topic = {
      ...BASE_TOPIC,
      [ROOT_ID + ".md"]: nodeFile({
        nodeId: ROOT_ID,
        title: "根节点",
        flow: "root",
        state: "agreed",
        body: "重复片段。\n\n重复片段。",
      }),
    };
    const { files } = await newWorkspace({ 协作方式: topic });
    const run = (op: Operation) => {
      try {
        prepareChanges(files, request(files, [op]));
        return null;
      } catch (error) {
        return error as ChangeError;
      }
    };
    expect(run({ op: "patchNode", nodeId: ROOT_ID, replace: [{ old: "重复片段。", new: "x" }] })?.code).toBe(
      "OPERATION_CONFLICT",
    );
    expect(run({ op: "patchNode", nodeId: ROOT_ID, replace: [{ old: "不存在的片段", new: "x" }] })?.code).toBe(
      "OPERATION_CONFLICT",
    );
  });

  it("patchNode 正文模式互斥，append 追加到正文末尾", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    let error: unknown;
    try {
      prepareChanges(
        files,
        request(files, [
          {
            op: "patchNode",
            nodeId: ROOT_ID,
            append: "追加段落。",
            body: "整篇替换",
          } as unknown as Operation,
        ]),
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("BAD_REQUEST");

    const changes = prepareChanges(
      files,
      request(files, [{ op: "patchNode", nodeId: ROOT_ID, append: "追加段落。" }]),
    );
    const text = changes.files[0]!.content as string;
    expect(text).toContain("根节点正文。\n\n追加段落。");
  });

  it("createNode 新增分支默认 max+10，description 必需非 root", async () => {
    const withBranch = {
      ...BASE_TOPIC,
      [BRANCH_ID + ".md"]: nodeFile({
        nodeId: BRANCH_ID,
        title: "既有分支",
        from: ROOT_ID,
        flow: "branch",
        description: "既有分支理由",
        side: "left",
        order: 10,
      }),
    };
    const { files } = await newWorkspace({ 协作方式: withBranch });
    const newBranchId = "n_00000000000000000000000000000004";
    // 新建文件必须由调用方显式声明"不存在"；候选不替调用者补前置值。
    const createdRequest = request(
      files,
      [
        {
          op: "createNode",
          nodeId: newBranchId,
          topicId: TOPIC_ID,
          title: "新分支",
          body: "新分支正文。",
          from: ROOT_ID,
          flow: "branch",
          state: "proposed",
          description: "从根节点展开的另一条线索",
          side: "right",
        },
      ],
      { ["topics/协作方式/" + newBranchId + ".md"]: null },
    );
    const changes = prepareChanges(files, createdRequest);
    const createdFile = changes.files.find((file) => file.path.endsWith(newBranchId + ".md"))!;
    expect(createdFile.content).toContain("order: 20");
    expect(createdFile.expectedSha256).toBeNull();

    let error: unknown;
    try {
      prepareChanges(
        files,
        request(files, [
          {
            op: "createNode",
            nodeId: "n_00000000000000000000000000000005",
            topicId: TOPIC_ID,
            title: "缺描述",
            body: "",
            from: ROOT_ID,
            flow: "next",
            state: "proposed",
          },
        ]),
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("VALIDATION_FAILED");
  });

  it("updateConnection 改接来源必须显式给 description，并拒绝挤掉 next", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    const otherRoot = "n_00000000000000000000000000000006";
    const withOther = {
      ...BASE_TOPIC,
      [otherRoot + ".md"]: nodeFile({
        nodeId: otherRoot,
        title: "另一分支",
        from: ROOT_ID,
        flow: "branch",
        description: "另一分支理由",
        side: "left",
        order: 10,
      }),
    };
    const { files: second } = await newWorkspace({ 协作方式: withOther });
    let error: unknown;
    try {
      prepareChanges(second, request(second, [{ op: "updateConnection", nodeId: CHILD_ID, from: otherRoot }]));
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("OPERATION_CONFLICT");

    const ok = prepareChanges(
      second,
      request(second, [
        {
          op: "updateConnection",
          nodeId: CHILD_ID,
          from: otherRoot,
          description: "改挂到另一分支后重新说明理由",
        },
      ]),
    );
    const text = ok.files[0]!.content as string;
    expect(text).toContain("from: " + otherRoot);
    expect(text).toContain("改挂到另一分支后重新说明理由");
    expect(ok.changedNodeIds).toEqual([CHILD_ID]);
    expect(ok.contentNodeIds).toEqual([CHILD_ID]);
    void files;
  });

  it("removeLeaf 拒绝删除仍有后继的节点，允许删除真叶", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    let error: unknown;
    try {
      prepareChanges(files, request(files, [{ op: "removeLeaf", nodeId: ROOT_ID }]));
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("OPERATION_CONFLICT");
    expect((error as ChangeError).details?.["children"]).toEqual([CHILD_ID]);

    const changes = prepareChanges(files, request(files, [{ op: "removeLeaf", nodeId: CHILD_ID }]));
    expect(changes.files).toEqual([
      {
        path: "topics/协作方式/" + CHILD_ID + ".md",
        content: null,
        expectedSha256: files.topics.find((file) => file.path.endsWith(CHILD_ID + ".md"))!.sha256,
      },
    ]);
  });

  it("moveNodeToTopic 保留 ID 与连接，并删除被清空的主题入口", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    // 迁移时整棵结构一起处理：root 与子节点都保留原 from，源主题随之清空。
    const changes = prepareChanges(
      files,
      request(
        files,
        [
          { op: "createTopic", topicId: TOPIC_ID_2, path: "条目整理", title: "条目整理" },
          { op: "moveNodeToTopic", nodeId: ROOT_ID, topicId: TOPIC_ID_2 },
          { op: "moveNodeToTopic", nodeId: CHILD_ID, topicId: TOPIC_ID_2 },
        ],
        {
          ["topics/条目整理/topic.md"]: null,
          ["topics/条目整理/" + ROOT_ID + ".md"]: null,
          ["topics/条目整理/" + CHILD_ID + ".md"]: null,
        },
      ),
    );
    const deleted = changes.files
      .filter((file) => file.content === null)
      .map((file) => file.path)
      .sort();
    expect(deleted).toEqual(
      [
        "topics/协作方式/topic.md",
        "topics/协作方式/" + ROOT_ID + ".md",
        "topics/协作方式/" + CHILD_ID + ".md",
      ].sort(),
    );
    const movedMeta = changes.files.find((file) => file.path === "topics/条目整理/topic.md")!;
    expect(movedMeta.content).toContain("topicId: " + TOPIC_ID_2);
    const movedRoot = changes.files.find(
      (file) => file.path === "topics/条目整理/" + ROOT_ID + ".md",
    )!;
    expect(movedRoot.content).toContain("flow: root");
    const movedChild = changes.files.find(
      (file) => file.path === "topics/条目整理/" + CHILD_ID + ".md",
    )!;
    expect(movedChild.content).toContain("nodeId: " + CHILD_ID);
    expect(movedChild.content).toContain("from: " + ROOT_ID);
  });
});

describe("内容节点：只记录最终真实写盘", () => {
  it("同批改正文再恢复原值：不写文件，也不计入最近内容更新", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    const changes = prepareChanges(
      files,
      request(files, [
        { op: "patchNode", nodeId: ROOT_ID, replace: [{ old: "根节点正文。", new: "临时正文。" }] },
        { op: "patchNode", nodeId: ROOT_ID, replace: [{ old: "临时正文。", new: "根节点正文。" }] },
      ]),
    );
    expect(changes.files).toEqual([]);
    expect(changes.changedNodeIds).toEqual([ROOT_ID]);
    expect(changes.contentNodeIds).toEqual([]);
  });

  it("setImportance 与另一节点真实正文修改同批：只记录真实改写的节点", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    const changes = prepareChanges(
      files,
      request(files, [
        { op: "setImportance", nodeId: ROOT_ID, important: true },
        {
          op: "patchNode",
          nodeId: CHILD_ID,
          replace: [{ old: "子节点正文。", new: "改写后的子节点正文。" }],
        },
      ]),
    );
    expect(changes.files.map((file) => file.path).sort()).toEqual(
      ["topics/协作方式/" + ROOT_ID + ".md", "topics/协作方式/" + CHILD_ID + ".md"].sort(),
    );
    expect(changes.changedNodeIds).toEqual([ROOT_ID, CHILD_ID]);
    expect(changes.contentNodeIds).toEqual([CHILD_ID]);
  });

  it("updateConnection 值不变不写入：只记录另一节点的真实正文修改", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    const changes = prepareChanges(
      files,
      request(files, [
        {
          op: "updateConnection",
          nodeId: CHILD_ID,
          from: ROOT_ID,
          flow: "next",
          description: "从根节点继续",
        },
        { op: "patchNode", nodeId: ROOT_ID, replace: [{ old: "根节点正文。", new: "改写后的根节点正文。" }] },
      ]),
    );
    expect(changes.files.map((file) => file.path)).toEqual(["topics/协作方式/" + ROOT_ID + ".md"]);
    expect(changes.changedNodeIds).toEqual([CHILD_ID, ROOT_ID]);
    expect(changes.contentNodeIds).toEqual([ROOT_ID]);
  });

  it("同批新建节点计入，删除真叶不计入", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    const newId = "n_00000000000000000000000000000008";
    const changes = prepareChanges(
      files,
      request(
        files,
        [
          {
            op: "createNode",
            nodeId: newId,
            topicId: TOPIC_ID,
            title: "新节点",
            body: "新节点正文。",
            from: ROOT_ID,
            flow: "branch",
            state: "proposed",
            description: "从根节点展开的新分支",
            side: "right",
          },
          { op: "removeLeaf", nodeId: CHILD_ID },
        ],
        { ["topics/协作方式/" + newId + ".md"]: null },
      ),
    );
    expect(changes.files.map((file) => file.path).sort()).toEqual(
      ["topics/协作方式/" + CHILD_ID + ".md", "topics/协作方式/" + newId + ".md"].sort(),
    );
    expect(changes.files.find((file) => file.path.endsWith(CHILD_ID + ".md"))?.content).toBeNull();
    expect(changes.files.find((file) => file.path.endsWith(newId + ".md"))?.content).toContain(
      "新节点正文。",
    );
    expect(changes.changedNodeIds).toEqual([newId, CHILD_ID]);
    expect(changes.contentNodeIds).toEqual([newId]);
  });
});


describe("前置哈希与恢复", () => {
  it("错哈希拒绝，且不产生候选", async () => {
    const { files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    let error: unknown;
    try {
      prepareChanges(
        files,
        request(files, [{ op: "patchNode", nodeId: ROOT_ID, append: "追加。" }], {
          ["topics/协作方式/" + ROOT_ID + ".md"]: "0".repeat(64),
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("VERSION_CONFLICT");
    const conflicts = (error as ChangeError).details?.["conflicts"] as Array<Record<string, unknown>>;
    expect(conflicts[0]?.["path"]).toBe("topics/协作方式/" + ROOT_ID + ".md");
    expect(conflicts[0]?.["expectedSha256"]).toBe("0".repeat(64));
  });

  it("缺少新文件声明时 409 missingFiles，提交后仍可用现有事务恢复", async () => {
    const { root, files } = await newWorkspace({ 协作方式: BASE_TOPIC });
    const newId = "n_00000000000000000000000000000007";
    let error: unknown;
    try {
      prepareChanges(
        files,
        request(files, [
          {
            op: "createNode",
            nodeId: newId,
            topicId: TOPIC_ID,
            title: "新节点",
            body: "内容。",
            from: ROOT_ID,
            flow: "branch",
            state: "proposed",
            description: "从根节点展开的新线索",
            side: "right",
          },
        ]),
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("OPERATION_CONFLICT");
    expect((error as ChangeError).details?.["missingFiles"]).toContain(
      "topics/协作方式/" + newId + ".md",
    );

    // 同一候选交给现有事务层：仍走 prepared／committed 与恢复，不另写提交栈。
    const prepared = prepareChanges(
      files,
      request(
        files,
        [
          {
            op: "createNode",
            nodeId: newId,
            topicId: TOPIC_ID,
            title: "新节点",
            body: "内容。",
            from: ROOT_ID,
            flow: "branch",
            state: "proposed",
            description: "从根节点展开的新线索",
            side: "right",
          },
        ],
        { ["topics/协作方式/" + newId + ".md"]: null },
      ),
    );
    const committed = await commitFiles({ root, files: prepared.files });
    expect(committed.committed).toBe(true);
    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(true);
    expect(recovered.committedPendingRefresh).toContain(committed.transactionId);
    const reread = await readWorkspaceFiles(root);
    expect(reread.workspace.schemaVersion).toBe(2);
    expect(reread.topics.some((file) => file.path.endsWith(newId + ".md"))).toBe(true);
  });
});

describe("请求 schema", () => {
  const shell = () => ({
    workspaceId: "w_1",
    requestId: crypto.randomUUID(),
    expectedFiles: {},
    operations: [] as unknown[],
  });

  it("当前操作被严格 schema 接纳，未知字段被拒绝且错误能指向具体操作", () => {
    const patch = {
      ...shell(),
      operations: [{ op: "patchNode", nodeId: ROOT_ID, append: "追加。" }],
    };
    expect(changeRequestSchema.safeParse(patch).success).toBe(true);

    const connect = {
      ...shell(),
      operations: [{ op: "updateConnection", nodeId: CHILD_ID, description: "改接理由" }],
    };
    expect(changeRequestSchema.safeParse(connect).success).toBe(true);

    const unknownField = {
      ...shell(),
      operations: [{ op: "patchNode", nodeId: ROOT_ID, append: "x", bogus: 1 }],
    };
    expect(changeRequestSchema.safeParse(unknownField).success).toBe(false);

    const unknownTopLevel = { ...shell(), extra: true };
    const topLevel = changeRequestSchema.safeParse(unknownTopLevel);
    expect(topLevel.success).toBe(false);
    if (!topLevel.success) {
      const issues = flattenChangeRequestIssues(topLevel.error);
      expect(issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }

    const unknownOp = { ...shell(), operations: [{ op: "nope" }] };
    const opResult = changeRequestSchema.safeParse(unknownOp);
    expect(opResult.success).toBe(false);
    if (!opResult.success) {
      const issues = flattenChangeRequestIssues(opResult.error);
      // 不能只报一条无路径的 invalid_union：要指出是第几个操作的 op 坏了。
      expect(issues[0]?.path.join(".")).toContain("operations.0");
    }
  });
});

describe("barrel 导出", () => {
  it("只暴露当前实现的入口，不保留旧格式分派与转换导出", async () => {
    const barrel = await import("../../src/storage/index.js");
    expect(typeof barrel.changeRequestSchema.safeParse).toBe("function");
    expect(typeof barrel.flattenChangeRequestIssues).toBe("function");
    expect(typeof barrel.prepareChanges).toBe("function");
    expect(typeof barrel.isTopicFilePath).toBe("function");
    expect("prepareChangesForWorkspace" in barrel).toBe(false);
    expect("anyChangeRequestSchema" in barrel).toBe(false);
    expect("planConversion" in barrel).toBe(false);
  });
});
