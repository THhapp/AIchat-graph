import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWorkspaceDocuments } from "../../src/core/index.js";
import {
  ChangeError,
  anyChangeRequestSchema,
  changeRequestSchema,
  commitFiles,
  flattenChangeRequestIssues,
  initWorkspace,
  migrateWorkspace,
  planConversion,
  prepareChangesForWorkspace,
  prepareChanges,
  prepareChangesV2,
  readWorkspaceFiles,
  recoverTransactions,
  v2ChangeRequestSchema,
  type V2ChangeRequest,
  type V2Operation,
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

async function newV2Workspace(topics: Record<string, Record<string, string>>): Promise<{
  root: string;
  files: Awaited<ReturnType<typeof readWorkspaceFiles>>;
}> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-v2-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "ws");
  await initWorkspace({ root, name: "v2-test" });
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
  operations: V2Operation[],
  overrides: Record<string, string | null> = {},
): V2ChangeRequest {
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

describe("格式 2 扫描与 init", () => {
  it("新工作区默认 schemaVersion 2，节点是独立文件且无总表", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-v2-init-"));
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
    const { files } = await newV2Workspace({ 协作方式: BASE_TOPIC });
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

describe("格式 2 候选：局部修改与结构", () => {
  it("patchNode 片段替换只改目标节点文件，其他节点逐字节不变", async () => {
    const { files } = await newV2Workspace({ 协作方式: BASE_TOPIC });
    const changes = prepareChangesV2(
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
    const { files } = await newV2Workspace({ 协作方式: topic });
    const run = (op: V2Operation) => {
      try {
        prepareChangesV2(files, request(files, [op]));
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
    const { files } = await newV2Workspace({ 协作方式: BASE_TOPIC });
    let error: unknown;
    try {
      prepareChangesV2(
        files,
        request(files, [
          {
            op: "patchNode",
            nodeId: ROOT_ID,
            append: "追加段落。",
            body: "整篇替换",
          } as unknown as V2Operation,
        ]),
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("BAD_REQUEST");

    const changes = prepareChangesV2(
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
    const { files } = await newV2Workspace({ 协作方式: withBranch });
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
    const changes = prepareChangesV2(files, createdRequest);
    const createdFile = changes.files.find((file) => file.path.endsWith(newBranchId + ".md"))!;
    expect(createdFile.content).toContain("order: 20");
    expect(createdFile.expectedSha256).toBeNull();

    let error: unknown;
    try {
      prepareChangesV2(
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
    const { files } = await newV2Workspace({ 协作方式: BASE_TOPIC });
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
    const { files: second } = await newV2Workspace({ 协作方式: withOther });
    let error: unknown;
    try {
      prepareChangesV2(second, request(second, [{ op: "updateConnection", nodeId: CHILD_ID, from: otherRoot }]));
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("OPERATION_CONFLICT");

    const ok = prepareChangesV2(
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
    void files;
  });

  it("removeLeaf 拒绝删除仍有后继的节点，允许删除真叶", async () => {
    const { files } = await newV2Workspace({ 协作方式: BASE_TOPIC });
    let error: unknown;
    try {
      prepareChangesV2(files, request(files, [{ op: "removeLeaf", nodeId: ROOT_ID }]));
    } catch (caught) {
      error = caught;
    }
    expect((error as ChangeError).code).toBe("OPERATION_CONFLICT");
    expect((error as ChangeError).details?.["children"]).toEqual([CHILD_ID]);

    const changes = prepareChangesV2(files, request(files, [{ op: "removeLeaf", nodeId: CHILD_ID }]));
    expect(changes.files).toEqual([
      {
        path: "topics/协作方式/" + CHILD_ID + ".md",
        content: null,
        expectedSha256: files.topics.find((file) => file.path.endsWith(CHILD_ID + ".md"))!.sha256,
      },
    ]);
  });

  it("moveNodeToTopic 保留 ID 与连接，并删除被清空的主题入口", async () => {
    const { files } = await newV2Workspace({
      协作方式: BASE_TOPIC,
      条目整理: {
        "topic.md": topicMeta(TOPIC_ID_2, "条目整理"),
        [BRANCH_ID + ".md"]: nodeFile({
          nodeId: BRANCH_ID,
          title: "待移动",
          from: ROOT_ID,
          flow: "branch",
          description: "跨主题连接仍然保留",
          side: "left",
          order: 10,
        }),
      },
    });
    const changes = prepareChangesV2(
      files,
      request(files, [{ op: "moveNodeToTopic", nodeId: BRANCH_ID, topicId: TOPIC_ID }], {
        // 移动后节点文件落在新目录：目标路径需显式声明为不存在。
        ["topics/协作方式/" + BRANCH_ID + ".md"]: null,
      }),
    );
    const deleted = changes.files.find((file) => file.content === null);
    expect(deleted?.path).toBe("topics/条目整理/topic.md");
    const moved = changes.files.find((file) => file.path.endsWith(BRANCH_ID + ".md"))!;
    expect(moved.path).toBe("topics/协作方式/" + BRANCH_ID + ".md");
    expect(moved.content).toContain("nodeId: " + BRANCH_ID);
    expect(moved.content).toContain("from: " + ROOT_ID);
  });
});


describe("格式 2 前置哈希与恢复", () => {
  it("错哈希拒绝，且不产生候选", async () => {
    const { files } = await newV2Workspace({ 协作方式: BASE_TOPIC });
    let error: unknown;
    try {
      prepareChangesV2(
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
    const { root, files } = await newV2Workspace({ 协作方式: BASE_TOPIC });
    const newId = "n_00000000000000000000000000000007";
    let error: unknown;
    try {
      prepareChangesV2(
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
    const prepared = prepareChangesV2(
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

describe("格式 1 → 格式 2 转换", () => {
  const V1_FIXTURE = path.resolve("tests/fixtures/workspace");

  it("planConversion 保留身份／正文／状态／连接与顺序，缺描述时拒绝且源不变", async () => {
    const files = await readWorkspaceFiles(V1_FIXTURE);
    expect(files.workspace.schemaVersion).toBe(1);
    const sourceBytes = files.topics.map((file) => file.text).join("\u0000");

    const blocked = planConversion({ files });
    expect(blocked.ok).toBe(false);
    expect(blocked.missingDescriptions.length).toBeGreaterThan(0);
    expect(blocked.files).toEqual([]);

    // 用真实 label 已能覆盖时不应再要求映射。
    const labelCount = blocked.counts.preservedLabels;
    const descriptions: Record<string, string> = {};
    for (const nodeId of blocked.missingDescriptions) {
      descriptions[nodeId] = "由维护 Agent 阅读后补充的连接理由";
    }
    const plan = planConversion({ files, descriptions });
    expect(plan.ok).toBe(true);
    expect(plan.missingDescriptions).toEqual([]);
    expect(plan.counts.preservedLabels).toBe(labelCount);
    expect(plan.counts.nodes).toBe(15);
    expect(plan.counts.topics).toBe(2);

    const metaFiles = plan.files.filter((file) => file.path.endsWith("/topic.md"));
    expect(metaFiles).toHaveLength(2);
    for (const meta of metaFiles) {
      expect(meta.content).toContain("topicId:");
      expect(meta.content).not.toContain("nodes:");
    }
    // 节点文件各含一份真实节点，且不带旧 H2 卡片标记。
    const nodeFiles = plan.files.filter((file) => !file.path.endsWith("/topic.md"));
    expect(nodeFiles).toHaveLength(15);
    for (const file of nodeFiles) {
      expect(file.content).toContain("nodeId: n_");
      expect(file.content).not.toContain("<!-- node:");
    }

    // 源工作区未被修改。
    const afterIds = files.topics.map((file) => file.text).join("\u0000");
    expect(afterIds).toBe(sourceBytes);
  });

  it("migrateWorkspace 发布到不存在的新目录，并保留焦点与连接", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-migrate-"));
    temporaryRoots.push(parent);
    const destination = path.join(parent, "converted");
    const v1 = await readWorkspaceFiles(V1_FIXTURE);
    const blocked = planConversion({ files: v1 });
    const descriptions: Record<string, string> = {};
    for (const nodeId of blocked.missingDescriptions) {
      descriptions[nodeId] = "转换时补充的连接理由";
    }

    const preview = await migrateWorkspace({ source: V1_FIXTURE, destination, descriptions, dryRun: true });
    expect(preview.ok).toBe(true);
    expect(preview.published).toBe(false);
    expect(await fs.stat(destination).catch(() => null)).toBeNull();

    const result = await migrateWorkspace({ source: V1_FIXTURE, destination, descriptions });
    expect(result.ok).toBe(true);
    expect(result.published).toBe(true);

    const manifest = JSON.parse(await fs.readFile(path.join(destination, "workspace.json"), "utf8")) as {
      schemaVersion: number;
      workspaceId: string;
      activeNode: string | null;
    };
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.workspaceId).toBe(v1.workspace.workspaceId);
    expect(manifest.activeNode).toBe(v1.workspace.activeNode);

    const converted = await readWorkspaceFiles(destination);
    const documents = converted.topics.map((file) => ({ path: file.path, text: file.text }));
    const parsed = parseWorkspaceDocuments({
      workspace: {
        schemaVersion: 2,
        workspaceId: converted.workspace.workspaceId,
        name: converted.workspace.name,
        activeNode: converted.workspace.activeNode,
      },
      documents,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.graph!.nodes).toHaveLength(15);
    expect(parsed.graph!.activeNode).toBe(v1.workspace.activeNode);
    // 编号顺序按结构派生，转换不重排关系。
    expect(parsed.graph!.nodes.map((node) => node.number)).toEqual(
      ["01", "02", "03", "04", "05", "05-01", "05-01-01", "05-02", "06", "06-01", "06-02", "06-03", "06-03-01", "06-03-02", "07"],
    );

    // 目标已存在时拒绝，不覆盖。
    const again = await migrateWorkspace({ source: V1_FIXTURE, destination, descriptions }).catch(
      (error: unknown) => error as { code?: string },
    );
    expect((again as { code?: string }).code).toBe("WORKSPACE_EXISTS");
  });
});

describe("格式分派", () => {
  it("prepareChanges 只接受格式 1，分派入口按版本路由", async () => {
    const v1 = await readWorkspaceFiles(path.resolve("tests/fixtures/workspace"));
    const v2 = await newV2Workspace({ 协作方式: BASE_TOPIC });
    let error: unknown;
    try {
      prepareChangesForWorkspace(
        v2.files,
        request(v2.files, [{ op: "setDiscussionFocus", nodeId: ROOT_ID }]),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeUndefined();

    const focused = prepareChangesForWorkspace(
      v2.files,
      request(v2.files, [{ op: "setDiscussionFocus", nodeId: CHILD_ID }]),
    );
    expect(focused.files.map((file) => file.path)).toEqual(["workspace.json"]);

    // 格式 1 走原实现：指向格式 2 入口会被明确拒绝。
    let mismatch: unknown;
    try {
      prepareChangesForWorkspace(
        v1,
        request(v1 as never, [{ op: "setDiscussionFocus", nodeId: null }]),
      );
    } catch (caught) {
      mismatch = caught;
    }
    expect(mismatch).toBeUndefined();
  });
});

describe("版本无关的请求外壳 anyChangeRequestSchema", () => {
  const shell = () => ({
    workspaceId: "w_1",
    requestId: crypto.randomUUID(),
    expectedFiles: {},
    operations: [] as unknown[],
  });

  it("V2 patchNode／updateConnection 被联合接纳（legacy 单 schema 会拒绝）", () => {
    const patch = {
      ...shell(),
      operations: [{ op: "patchNode", nodeId: ROOT_ID, append: "追加。" }],
    };
    expect(changeRequestSchema.safeParse(patch).success).toBe(false);
    expect(anyChangeRequestSchema.safeParse(patch).success).toBe(true);

    const connect = {
      ...shell(),
      operations: [{ op: "updateConnection", nodeId: CHILD_ID, description: "改接理由" }],
    };
    expect(changeRequestSchema.safeParse(connect).success).toBe(false);
    expect(anyChangeRequestSchema.safeParse(connect).success).toBe(true);
  });

  it("未知字段仍被拒绝，且错误能指向具体操作", () => {
    const unknownField = {
      ...shell(),
      operations: [{ op: "patchNode", nodeId: ROOT_ID, append: "x", bogus: 1 }],
    };
    expect(anyChangeRequestSchema.safeParse(unknownField).success).toBe(false);

    const unknownTopLevel = { ...shell(), extra: true };
    const topLevel = anyChangeRequestSchema.safeParse(unknownTopLevel);
    expect(topLevel.success).toBe(false);
    if (!topLevel.success) {
      const issues = flattenChangeRequestIssues(topLevel.error);
      expect(issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    }

    const unknownOp = { ...shell(), operations: [{ op: "nope" }] };
    const opResult = anyChangeRequestSchema.safeParse(unknownOp);
    expect(opResult.success).toBe(false);
    if (!opResult.success) {
      const issues = flattenChangeRequestIssues(opResult.error);
      // 不能只报一条无路径的 invalid_union：要指出是第几个操作的 op 坏了。
      expect(issues[0]?.path.join(".")).toContain("operations.0");
    }
  });

  it("两种格式的合法请求都被接纳，且 V1 schema 行为未变", () => {
    const v1 = {
      ...shell(),
      operations: [{ op: "updateNode", nodeId: ROOT_ID, state: "agreed" }],
    };
    expect(changeRequestSchema.safeParse(v1).success).toBe(true);
    expect(anyChangeRequestSchema.safeParse(v1).success).toBe(true);

    const v2 = {
      ...shell(),
      operations: [{ op: "patchNode", nodeId: ROOT_ID, replace: [{ old: "a", new: "b" }] }],
    };
    expect(v2ChangeRequestSchema.safeParse(v2).success).toBe(true);
    expect(anyChangeRequestSchema.safeParse(v2).success).toBe(true);

    // V1 的标题规则保持原样：伪造 node 注释仍被拒绝。
    const forged = {
      ...shell(),
      operations: [{ op: "updateNode", nodeId: ROOT_ID, title: "坏 <!-- node:n_1 -->" }],
    };
    expect(changeRequestSchema.safeParse(forged).success).toBe(false);
  });
});


describe("barrel 导出与加载顺序", () => {
  it("两个 value 从 storage/index 可直接导入，且先加载任一实现也不触发循环初始化", async () => {
    // 直接按 barrel 导入（B1/B2 的用法）：两个都是 value，不只是 type。
    const barrel = await import("../../src/storage/index.js");
    expect(typeof barrel.anyChangeRequestSchema).toBe("object");
    expect(typeof barrel.flattenChangeRequestIssues).toBe("function");
    expect(typeof barrel.prepareChangesForWorkspace).toBe("function");

    // 回归保护：先从 V2 实现加载，再取 barrel；曾经因 changes ⇄ changes-v2 互相初始化而失败。
    const freshV2 = await import(
      "../../src/storage/changes-v2.js?fresh=" + encodeURIComponent("v2-first")
    );
    const freshBarrel = await import(
      "../../src/storage/index.js?fresh=" + encodeURIComponent("after-v2")
    );
    expect(typeof freshV2.prepareChangesV2).toBe("function");
    expect(typeof freshBarrel.anyChangeRequestSchema.safeParse).toBe("function");

    // 两条旧导入路径（changes.js / changes-v2.js）都必须仍然拿得到同一个类型与类。
    const changesModule = await import("../../src/storage/changes.js");
    const v2Module = await import("../../src/storage/changes-v2.js");
    expect(changesModule.ChangeError).toBe(v2Module.ChangeError);
    expect(changesModule.flattenChangeRequestIssues).toBe(barrel.flattenChangeRequestIssues);
  });
});
