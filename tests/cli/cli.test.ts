import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initWorkspace, sha256Bytes } from "../../src/storage/index.js";
import { parseOptions } from "../../src/cli/args.js";
import { readChangeRequestFile, validateChangeRequestShape } from "../../src/cli/changes.js";
import { assertIdentity, assertLoopbackUrl, parseServiceDescriptor } from "../../src/cli/service-client.js";
import { main } from "../../src/cli/index.js";
import { sliceBody, locateSection, DEFAULT_READ_LENGTH, MAX_READ_SEGMENT } from "../../src/cli/text.js";

const temporaryRoots: string[] = [];

async function newParent(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-"));
  temporaryRoots.push(parent);
  return parent;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const TOPIC_ID = "t_64e917c597fb4da4abd5467512fab596";
const ROOT_NODE = "n_ac6022c7b25c40c7bd5f849bf6cd36ef";
const CHILD_NODE = "n_0d2f6687895d435f8bd389558b0820f3";

const ROOT_BODY = "保留有用的思路来路与关键转折。";
const CHILD_BODY = "记录既包括讨论过什么，也包括想法怎样走到这里。";

/** 格式 2：一节点一份 Markdown，标题与连接都在各自 YAML 头里。 */
function nodeFile(options: {
  nodeId: string;
  title: string;
  state: "agreed" | "proposed" | "reference";
  from: string | null;
  flow: "root" | "next" | "branch";
  body: string;
  description?: string;
}): string {
  const lines = [
    "---",
    `nodeId: ${options.nodeId}`,
    `title: ${options.title}`,
    `state: ${options.state}`,
    `from: ${options.from ?? "null"}`,
    `flow: ${options.flow}`,
  ];
  if (options.description !== undefined) lines.push(`description: ${options.description}`);
  lines.push("---", "", options.body, "");
  return lines.join("\n");
}

function topicMeta(topicId: string, title: string): string {
  return ["---", `topicId: ${topicId}`, `title: ${title}`, "---", ""].join("\n");
}

async function writeFileAt(root: string, relativePath: string, text: string): Promise<void> {
  const absolute = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, text, "utf8");
}

/** 新建格式 2 工作区并写入一个两节点主题；返回各文件哈希。 */
async function newV2Workspace(
  name = "cli-v2",
): Promise<{ root: string; workspaceId: string; hashes: Record<string, string> }> {
  const parent = await newParent();
  const root = path.join(parent, "workspace");
  const created = await initWorkspace({ root, name });
  const dir = "topics/条目整理";
  const files: Record<string, string> = {
    [`${dir}/topic.md`]: topicMeta(TOPIC_ID, "条目整理"),
    [`${dir}/${ROOT_NODE}.md`]: nodeFile({
      nodeId: ROOT_NODE,
      title: "条目整理",
      state: "agreed",
      from: null,
      flow: "root",
      body: ROOT_BODY,
    }),
    [`${dir}/${CHILD_NODE}.md`]: nodeFile({
      nodeId: CHILD_NODE,
      title: "可以回查的现场",
      state: "proposed",
      from: ROOT_NODE,
      flow: "next",
      body: CHILD_BODY,
      description: "承接上一条关于记录分寸的讨论",
    }),
  };
  const hashes: Record<string, string> = {};
  for (const [relativePath, text] of Object.entries(files)) {
    await writeFileAt(root, relativePath, text);
    hashes[relativePath] = sha256Bytes(text);
  }
  return { root, workspaceId: created.workspaceId, hashes };
}

/** 格式 1 工作区：单文件多卡片，仅用于兼容路径。 */
async function newV1Workspace(): Promise<{ root: string; topicText: string }> {
  const parent = await newParent();
  const root = path.join(parent, "workspace-v1");
  await initWorkspace({ root, name: "cli-v1", schemaVersion: 1 });
  const topicText = [
    "---",
    "schemaVersion: 1",
    `topicId: ${TOPIC_ID}`,
    "title: 条目整理",
    "nodes:",
    `  ${ROOT_NODE}:`,
    "    from: null",
    "    flow: root",
    "    state: agreed",
    `  ${CHILD_NODE}:`,
    `    from: ${ROOT_NODE}`,
    "    flow: next",
    "    state: proposed",
    "---",
    "",
    `## 条目整理 <!-- node:${ROOT_NODE} -->`,
    "",
    ROOT_BODY,
    "",
    `## 可以回查的现场 <!-- node:${CHILD_NODE} -->`,
    "",
    CHILD_BODY,
    "",
  ].join("\n");
  await writeFileAt(root, "topics/条目整理.md", topicText);
  return { root, topicText };
}

function jsonOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function errorOf(stderr: string): { code: string; details?: Record<string, unknown> } {
  return (JSON.parse(stderr) as { error: { code: string; details?: Record<string, unknown> } }).error;
}

describe("参数解析", () => {
  it("接受 --name value 与 --name=value，并拒绝未知／重复／缺值", () => {
    const parsed = parseOptions(
      ["--workspace", "D:/a b", "--name=x", "--text"],
      [{ name: "workspace" }, { name: "name" }, { name: "text", boolean: true }],
    );
    expect(parsed.values.get("workspace")).toBe("D:/a b");
    expect(parsed.values.get("name")).toBe("x");
    expect(parsed.values.get("text")).toBe("true");
    expect(() => parseOptions(["--nope"], [])).toThrow(/未知选项/);
    expect(() => parseOptions(["--name", "a", "--name", "b"], [{ name: "name" }])).toThrow(/不能重复/);
    expect(() => parseOptions(["--name"], [{ name: "name" }])).toThrow(/需要一个值/);
    expect(() => parseOptions(["a", "b"], [], 1)).toThrow(/多余的参数/);
  });
});

describe("有界正文切片", () => {
  it("默认 4000 UTF-16，给出 range 与 truncated", () => {
    const long = "甲".repeat(DEFAULT_READ_LENGTH + 500);
    const slice = sliceBody(long);
    expect(slice.text.length).toBe(DEFAULT_READ_LENGTH);
    expect(slice.range).toEqual({
      start: 0,
      end: DEFAULT_READ_LENGTH,
      total: long.length,
      unit: "utf16",
    });
    expect(slice.truncated).toBe(true);

    const full = sliceBody(long, { full: true });
    expect(full.text.length).toBe(long.length);
    expect(full.truncated).toBe(false);
  });

  it("上限 16000，且不切断代理对", () => {
    const emoji = "😀";
    const text = "a" + emoji.repeat(10) + "b";
    // 从代理对中间开始：应向前退到 high surrogate 之前，避免半个字符。
    const fromMiddle = sliceBody(text, { start: 2, length: 3 });
    expect(fromMiddle.range.start).toBe(1);
    expect(fromMiddle.text).toBe(emoji.repeat(2));

    // 长度截断落在代理对中间：允许包含完整字符（不留下孤立代理）。
    const cutInPair = sliceBody(text, { start: 1, length: 3 });
    expect(cutInPair.text).toBe(emoji.repeat(2));
    expect(/[\uD800-\uDBFF]$/.test(cutInPair.text)).toBe(false);
    expect(sliceBody("x".repeat(MAX_READ_SEGMENT + 10), { length: 999999 }).text.length).toBe(
      MAX_READ_SEGMENT,
    );
  });

  it("start>0 读到尾部也标 truncated；围栏里的 # 不算章节", () => {
    const text = "abcdef";
    const tail = sliceBody(text, { start: 3, length: 100 });
    expect(tail.text).toBe("def");
    expect(tail.range).toEqual({ start: 3, end: 6, total: 6, unit: "utf16" });
    // 前面还有内容，不能因为 end===total 就声称完整。
    expect(tail.truncated).toBe(true);

    const onlyTail = sliceBody(text, { start: 6, length: 10 });
    expect(onlyTail.text).toBe("");
    expect(onlyTail.truncated).toBe(true);

    const body = [
      "# 真章节",
      "正文",
      "```md",
      "# 这是代码里的井号",
      "```",
      "# 另一个真章节",
      "正文",
    ].join("\n");
    expect(locateSection(body, "真章节").start).toBe(0);
    expect(locateSection(body, "另一个真章节").start).toBe(body.indexOf("# 另一个真章节"));
    expect(() => locateSection(body, "这是代码里的井号")).toThrow(/没有标题/);
  });

  it("识别缩进 0–3 格的标题，忽略波浪线围栏内内容", () => {
    const body = ["   ## 缩进两格", "正文", "~~~md", "## 围栏里", "~~~", "## 正常"].join("\n");
    expect(locateSection(body, "缩进两格").level).toBe(2);
    expect(locateSection(body, "正常").start).toBe(body.indexOf("## 正常"));
    expect(() => locateSection(body, "围栏里")).toThrow(/没有标题/);
  });

  it("按标题定位，重名必须显式指定序号", () => {
    const body = ["## 甲", "一", "## 乙", "二", "## 甲", "三"].join("\n");
    expect(locateSection(body, "乙").start).toBe(body.indexOf("## 乙"));
    expect(() => locateSection(body, "甲")).toThrow(/出现 2 次/);
    expect(locateSection(body, "甲", 1).start).toBe(body.lastIndexOf("## 甲"));
    expect(() => locateSection(body, "甲", 5)).toThrow(/超出范围/);
    expect(() => locateSection(body, "丙")).toThrow(/没有标题/);
  });
});

describe("格式 2 工作区", () => {
  it("init 默认写 schemaVersion 2 且不创建示例主题", async () => {
    const parent = await newParent();
    const root = path.join(parent, "fresh");
    const init = await main(["init", root, "--name", "样例"]);
    expect(init.exitCode).toBe(0);
    const body = jsonOf(init.stdout);
    expect(body["schemaVersion"]).toBe(2);
    expect(body["root"]).toBe(await fs.realpath(root));
    expect((await fs.readdir(root)).sort()).toEqual([
      ".aichat",
      ".gitignore",
      "AGENTS.md",
      "topics",
      "workspace.json",
    ]);
    const meta = JSON.parse(await fs.readFile(path.join(root, "workspace.json"), "utf8"));
    expect(meta.schemaVersion).toBe(2);

    const again = await main(["init", root]);
    expect(again.exitCode).not.toBe(0);
    expect(errorOf(again.stderr).code).toBe("WORKSPACE_EXISTS");
  });

  it("topics 按主题目录分组，不把每个 md 当主题", async () => {
    const { root } = await newV2Workspace();
    const result = await main(["topics", "--workspace", root]);
    expect(result.exitCode).toBe(0);
    const body = jsonOf(result.stdout);
    expect(body["schemaVersion"]).toBe(2);
    const topics = body["topics"] as Array<Record<string, unknown>>;
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({
      topicId: TOPIC_ID,
      title: "条目整理",
      dir: "条目整理",
      path: "topics/条目整理/topic.md",
      nodeCount: 2,
    });
    expect((topics[0]?.["sourcePaths"] as string[]).length).toBe(3);
  });

  it("read 默认返回有界片段并带真实节点文件哈希", async () => {
    const { root, hashes } = await newV2Workspace();
    const result = await main(["read", "--node", CHILD_NODE, "--workspace", root]);
    expect(result.exitCode).toBe(0);
    const body = jsonOf(result.stdout);
    const node = (body["nodes"] as Array<Record<string, unknown>>)[0];
    expect(node).toMatchObject({
      source: "disk",
      id: CHILD_NODE,
      path: `topics/条目整理/${CHILD_NODE}.md`,
      body: CHILD_BODY,
      schemaVersion: 2,
    });
    expect((node?.["range"] as Record<string, unknown>).unit).toBe("utf16");
    expect((node?.["file"] as Record<string, unknown>)["sha256"]).toBe(
      hashes[`topics/条目整理/${CHILD_NODE}.md`],
    );
  });

  it("长正文默认截断，--length 与 --full 按预期生效", async () => {
    const { root } = await newV2Workspace();
    const longBody = "长".repeat(9000);
    await writeFileAt(
      root,
      `topics/条目整理/${CHILD_NODE}.md`,
      nodeFile({
        nodeId: CHILD_NODE,
        title: "可以回查的现场",
        state: "proposed",
        from: ROOT_NODE,
        flow: "next",
        body: longBody,
        description: "承接讨论",
      }),
    );
    const defaultRead = await main(["read", "--node", CHILD_NODE, "--workspace", root]);
    const defaultNode = (jsonOf(defaultRead.stdout)["nodes"] as Array<Record<string, unknown>>)[0];
    expect((defaultNode?.["body"] as string).length).toBe(DEFAULT_READ_LENGTH);
    expect(defaultNode?.["truncated"]).toBe(true);

    const paged = await main([
      "read",
      "--node",
      CHILD_NODE,
      "--start",
      "4000",
      "--length",
      "100",
      "--workspace",
      root,
    ]);
    const pagedNode = (jsonOf(paged.stdout)["nodes"] as Array<Record<string, unknown>>)[0];
    expect(pagedNode?.["range"]).toEqual({ start: 4000, end: 4100, total: longBody.length, unit: "utf16" });

    const full = await main(["read", "--node", CHILD_NODE, "--full", "--workspace", root]);
    const fullNode = (jsonOf(full.stdout)["nodes"] as Array<Record<string, unknown>>)[0];
    expect((fullNode?.["body"] as string).length).toBe(longBody.length);
    expect(fullNode?.["truncated"]).toBe(false);
  });

  it("read 主题返回主题元数据与节点清单，不把节点正文当主题全文", async () => {
    const { root, hashes } = await newV2Workspace();
    const byId = await main(["read", TOPIC_ID, "--workspace", root]);
    expect(byId.exitCode).toBe(0);
    const body = jsonOf(byId.stdout);
    expect((body["topic"] as Record<string, unknown>)["path"]).toBe(
      "topics/条目整理/topic.md",
    );
    expect((body["file"] as Record<string, unknown>)["sha256"]).toBe(
      hashes["topics/条目整理/topic.md"],
    );
    const nodes = body["nodes"] as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node["path"])).toEqual([
      `topics/条目整理/${ROOT_NODE}.md`,
      `topics/条目整理/${CHILD_NODE}.md`,
    ]);
    // 默认不返回入口文件正文，节点也不带 body（有界读取不被 outline 绕过）。
    expect(body["text"]).toBeUndefined();
    expect(typeof body["textOmitted"]).toBe("string");
    for (const node of nodes) {
      expect(node["body"]).toBeUndefined();
    }

    // 显式 --full 时才返回入口文本，并说明它是入口文件本身。
    const full = await main(["read", TOPIC_ID, "--full", "--workspace", root]);
    const fullBody = jsonOf(full.stdout);
    expect(fullBody["text"]).toContain("topicId: " + TOPIC_ID);
    expect(fullBody["text"]).not.toContain(ROOT_BODY);
    expect(fullBody["truncated"]).toBe(false);
  });

  it("search 指向节点真实文件、默认 10 项并支持分页", async () => {
    const { root } = await newV2Workspace();
    const many = Array.from({ length: 12 }, (_, index) => index);
    for (const index of many) {
      const nodeId = `n_${String(index).padStart(32, "a")}`;
      await writeFileAt(
        root,
        `topics/条目整理/${nodeId}.md`,
        nodeFile({
          nodeId,
          title: `批量节点 ${index}`,
          state: "proposed",
          from: ROOT_NODE,
          flow: "branch",
          body: "分页检索测试正文",
          description: "分页用例",
        }),
      );
    }
    const first = await main(["search", "分页检索", "--workspace", root]);
    expect(first.exitCode).toBe(0);
    const firstBody = jsonOf(first.stdout);
    expect((firstBody["hits"] as unknown[]).length).toBe(10);
    expect(firstBody["limit"]).toBe(10);
    expect(firstBody["hasMore"]).toBe(true);
    expect(firstBody["totalHits"]).toBe(12);
    const firstHit = (firstBody["hits"] as Array<Record<string, unknown>>)[0];
    expect(firstHit?.["path"]).toMatch(/^topics\/条目整理\/n_/);
    expect(typeof firstHit?.["fileHash"]).toBe("string");

    const second = await main(["search", "分页检索", "--workspace", root, "--page", "1"]);
    const secondBody = jsonOf(second.stdout);
    expect((secondBody["hits"] as unknown[]).length).toBe(2);
    expect(secondBody["hasMore"]).toBe(false);

    const badLimit = await main(["search", "分页检索", "--workspace", root, "--limit", "101"]);
    expect(badLimit.exitCode).toBe(2);
  });

  it("validate 通过并给出 graph；坏节点文件逐个报告且不虚报全图", async () => {
    const { root } = await newV2Workspace();
    const ok = await main(["validate", "--workspace", root]);
    expect(ok.exitCode).toBe(0);
    const okBody = jsonOf(ok.stdout);
    expect(okBody["ok"]).toBe(true);
    expect((okBody["graph"] as { nodes: unknown[] }).nodes).toHaveLength(2);
    expect((okBody["graph"] as { nodes: Array<Record<string, unknown>> }).nodes[1]).toMatchObject({
      id: CHILD_NODE,
      description: "承接上一条关于记录分寸的讨论",
      sourcePath: `topics/条目整理/${CHILD_NODE}.md`,
    });

    await writeFileAt(root, "topics/条目整理/n_bad.md", "---\nnodeId: nope\n---\n正文\n");
    const broken = await main(["validate", "--workspace", root]);
    expect(broken.exitCode).toBe(6);
    const brokenBody = jsonOf(broken.stdout);
    expect(brokenBody["ok"]).toBe(false);
    expect(brokenBody["graph"]).toBeNull();
    expect(brokenBody["graphSkipped"]).toBe(true);
    const diagnostics = brokenBody["diagnostics"] as Array<Record<string, unknown>>;
    expect(diagnostics.some((item) => item["topicPath"] === "topics/条目整理/n_bad.md")).toBe(true);
  });

  it("省略 --workspace 时使用当前目录；serve 必须显式给出", async () => {
    const { root } = await newV2Workspace();
    const fromCwd = await main(["validate"], { cwd: root });
    expect(fromCwd.exitCode).toBe(0);
    expect(jsonOf(fromCwd.stdout)["root"]).toBe(await fs.realpath(root));

    const serveWithoutWorkspace = await main(["serve"], {
      cwd: root,
      startService: async () => {
        throw new Error("不应被调用");
      },
    });
    expect(serveWithoutWorkspace.exitCode).toBe(2);
    expect(JSON.parse(serveWithoutWorkspace.stderr).error.message).toContain("--workspace");
  });

  it("找不到的节点／主题返回明确错误码", async () => {
    const { root } = await newV2Workspace();
    const missingNode = await main([
      "read",
      "--node",
      "n_00000000000000000000000000000000",
      "--workspace",
      root,
    ]);
    expect(missingNode.exitCode).toBe(11);
    expect(errorOf(missingNode.stderr).code).toBe("NODE_NOT_FOUND");

    const missingTopic = await main([
      "read",
      "t_00000000000000000000000000000000",
      "--workspace",
      root,
    ]);
    expect(missingTopic.exitCode).toBe(11);
    expect(errorOf(missingTopic.stderr).code).toBe("TOPIC_NOT_FOUND");

    const traversal = await main(["read", "../outside.md", "--workspace", root]);
    expect(traversal.exitCode).toBe(11);
  });

  it("--json 与 --text 互斥；--text 模式错误是人类可读文本", async () => {
    const { root } = await newV2Workspace();
    const result = await main(["topics", "--workspace", root, "--json", "--text"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--json 与 --text 不能同时使用");
    expect(result.stderr).toContain("Usage: aichat topics");

    const textMode = await main(["topics", "--nope", "x", "--text"]);
    expect(textMode.exitCode).toBe(2);
    expect(textMode.stderr.startsWith("未知选项 --nope")).toBe(true);
    expect(() => JSON.parse(textMode.stderr)).toThrow();
  });
});

describe("格式 1 兼容读取", () => {
  it("仍按单文件多卡片读取，节点 sourcePath 回退主题文件", async () => {
    const { root, topicText } = await newV1Workspace();
    const topics = await main(["topics", "--workspace", root]);
    expect(topics.exitCode).toBe(0);
    const topicsBody = jsonOf(topics.stdout);
    expect(topicsBody["schemaVersion"]).toBe(1);
    const list = topicsBody["topics"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ topicId: TOPIC_ID, path: "topics/条目整理.md", nodeCount: 2 });

    const read = await main(["read", "--node", CHILD_NODE, "--workspace", root]);
    expect(read.exitCode).toBe(0);
    const node = (jsonOf(read.stdout)["nodes"] as Array<Record<string, unknown>>)[0];
    expect(node).toMatchObject({
      path: "topics/条目整理.md",
      body: CHILD_BODY,
      schemaVersion: 1,
    });
    expect((node?.["file"] as Record<string, unknown>)["sha256"]).toBe(sha256Bytes(topicText));

    const validate = await main(["validate", "--workspace", root]);
    expect(validate.exitCode).toBe(0);
  });
});

describe("变更请求形状", () => {
  const valid = {
    workspaceId: "w_1",
    requestId: "3f0f6f1c-7f0e-4d5b-9a3e-1c2d3e4f5a6b",
    expectedFiles: { "topics/a.md": null },
    operations: [{ op: "setDiscussionFocus", nodeId: null }],
  };

  function issuesOf(value: unknown): Array<{ path: string; message: string }> {
    try {
      validateChangeRequestShape(value);
    } catch (error) {
      const details = (error as { details?: { issues?: Array<{ path: string; message: string }> } })
        .details;
      return details?.issues ?? [];
    }
    return [];
  }

  it("接受基本形状并保留字段值", () => {
    expect(validateChangeRequestShape(valid)).toEqual(valid);
  });

  it("拒绝缺字段、坏 UUID 与坏哈希，且不补哈希", () => {
    expect(issuesOf({ ...valid, requestId: "nope" }).map((issue) => issue.path)).toContain("requestId");
    expect(
      issuesOf({ ...valid, expectedFiles: { "topics/a.md": "ABC" } }).map((issue) => issue.path),
    ).toContain("expectedFiles.topics/a.md");
    expect(issuesOf({ ...valid, expectedFiles: [] }).map((issue) => issue.path)).toContain("expectedFiles");
    expect(issuesOf({ ...valid, operations: "x" }).map((issue) => issue.path)).toContain("operations");
    expect(issuesOf({ ...valid, operations: [{ nope: 1 }] }).map((issue) => issue.path)).toContain(
      "operations.0.op",
    );
    expect(issuesOf({ ...valid, workspaceId: "" }).map((issue) => issue.path)).toContain("workspaceId");
  });

  it("接受 V2 操作（patchNode／updateConnection 带 description），不按 V1 误拒", () => {
    const v2 = {
      workspaceId: "w_1",
      requestId: "3f0f6f1c-7f0e-4d5b-9a3e-1c2d3e4f5a6b",
      expectedFiles: { "topics/t/n_abc.md": null },
      operations: [
        {
          op: "patchNode",
          nodeId: "n_ac6022c7b25c40c7bd5f849bf6cd36ef",
          append: "补充一段。",
        },
      ],
    };
    expect(validateChangeRequestShape(v2)).toEqual(v2);

    const connection = {
      ...v2,
      operations: [
        {
          op: "updateConnection",
          nodeId: "n_ac6022c7b25c40c7bd5f849bf6cd36ef",
          from: "n_0d2f6687895d435f8bd389558b0820f3",
          description: "改接到这个来源更准确",
        },
      ],
    };
    expect(validateChangeRequestShape(connection)).toEqual(connection);

    // V1 的 label／旧字段仍被 V1 分支接受；未知 op 两边都拒绝。
    expect(issuesOf({ ...v2, operations: [{ op: "mergeNodes" }] }).length).toBeGreaterThan(0);
  });

  it("从文件读取时保留原始 JSON 文本（不重写 workspaceId）", async () => {
    const parent = await newParent();
    const file = path.join(parent, "request.json");
    const raw = JSON.stringify(valid, null, 2);
    await fs.writeFile(file, raw, "utf8");
    const loaded = await readChangeRequestFile(file);
    expect(loaded.text).toBe(raw);
    expect(loaded.request.workspaceId).toBe("w_1");
    await expect(readChangeRequestFile(path.join(parent, "missing.json"))).rejects.toMatchObject({
      code: "INPUT_UNREADABLE",
    });
  });
});

describe("服务描述与身份", () => {
  const descriptor = {
    url: "http://127.0.0.1:4400",
    rootPath: "C:\\ws",
    workspaceId: "w_1",
    instanceId: "inst-1",
    pid: 1234,
  };

  it("只接受 loopback http 且无凭据／路径", () => {
    expect(assertLoopbackUrl("http://127.0.0.1:4317").port).toBe("4317");
    expect(assertLoopbackUrl("http://localhost:4317").hostname).toBe("localhost");
    for (const url of [
      "https://127.0.0.1:4317",
      "http://evil.example:4317",
      "http://user:pass@127.0.0.1:4317",
      "http://127.0.0.1:4317/api",
      "http://127.0.0.1:4317/?x=1",
    ]) {
      expect(() => assertLoopbackUrl(url)).toThrow();
    }
  });

  it("descriptor 缺字段即视为陈旧", () => {
    expect(parseServiceDescriptor(descriptor).instanceId).toBe("inst-1");
    expect(() => parseServiceDescriptor({ ...descriptor, pid: "1234" })).toThrow(/pid/);
    expect(() => parseServiceDescriptor({ ...descriptor, instanceId: "" })).toThrow(/instanceId/);
    expect(() => parseServiceDescriptor(null)).toThrow(/JSON 对象/);
  });

  it("服务身份与当前工作区不一致时明确拒绝", () => {
    const rootPath = process.platform === "win32" ? "C:\\ws" : "/ws";
    const identity = {
      workspaceId: "w_2",
      instanceId: "inst-1",
      rootPath,
      url: "http://127.0.0.1:4400/",
    };
    expect(() => assertIdentity(identity, { ...descriptor, rootPath }, rootPath)).toThrow(/不一致/);
    try {
      assertIdentity(identity, { ...descriptor, rootPath }, rootPath);
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details;
      const mismatches = (details?.["mismatches"] as string[]) ?? [];
      expect(mismatches.some((item) => item.startsWith("workspaceId"))).toBe(true);
    }
    const matching = {
      workspaceId: "w_1",
      instanceId: "inst-1",
      rootPath,
      url: "http://127.0.0.1:4400/",
    };
    expect(() => assertIdentity(matching, { ...descriptor, rootPath }, rootPath)).not.toThrow();
  });
});