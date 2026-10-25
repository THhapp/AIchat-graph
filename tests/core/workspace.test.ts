import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatDiagnostic,
  parseWorkspaceDocuments,
  type WorkspaceDocument,
  type WorkspaceMeta,
} from "../../src/core/index.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const workspaceRoot = join(fixturesRoot, "workspace");
const COLLAB_DIR = "topics/协作方式";

function documentOf(root: string, relativePath: string): WorkspaceDocument {
  return { path: relativePath, text: readFileSync(join(root, ...relativePath.split("/")), "utf8") };
}

function listMarkdown(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        if (entry === "node_modules") continue;
        walk(absolute);
      } else if (entry.toLowerCase().endsWith(".md")) {
        found.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** “协作方式”单独取用时仍是自足的 isolated 主题。 */
function collaborationDocuments(): WorkspaceDocument[] {
  return listMarkdown(workspaceRoot)
    .filter((path) => path.startsWith(COLLAB_DIR + "/"))
    .map((path) => documentOf(workspaceRoot, path));
}

const fixtureWorkspace = JSON.parse(readFileSync(join(workspaceRoot, "workspace.json"), "utf8")) as WorkspaceMeta;

function collabResult(documents: readonly WorkspaceDocument[] = collaborationDocuments()) {
  const result = parseWorkspaceDocuments({ workspace: fixtureWorkspace, documents });
  if (!result.ok || !result.graph) {
    throw new Error("夹具未通过：" + result.diagnostics.map(formatDiagnostic).join(" | "));
  }
  return result;
}

describe("目录分组与身份", () => {
  it("一节点一份 Markdown，标题与身份来自元数据", () => {
    const result = collabResult();
    expect(result.schemaVersion).toBe(2);
    expect(result.topics.map((topic) => topic.dir)).toEqual(["协作方式"]);
    const collaboration = result.topics[0]!;
    expect(collaboration.schemaVersion).toBe(2);
    expect(collaboration.document.path).toBe("topics/协作方式/topic.md");
    expect(collaboration.sourcePaths).toHaveLength(collaboration.nodes.length + 1);
    expect(
      collaboration.sourcePaths.every((path) =>
        statSync(join(workspaceRoot, ...path.split("/"))).isFile(),
      ),
    ).toBe(true);
    expect(collaboration.sourcePaths).toContain("topics/协作方式/topic.md");
    expect(collaboration.nodes.map((node) => node.title)).toContain("整理目标");

    const root = collaboration.nodes.find((node) => node.flow === "root")!;
    expect(root.sourcePath).toBe("topics/协作方式/n_6fe284797b7d4f249440c5e8596f715d.md");
    expect(root.topicPath).toBe("topics/协作方式/topic.md");
    expect(root.description).toBeUndefined();
    expect(Object.keys(root.ranges).sort()).toEqual(["body", "node"]);
    expect(root.ranges.node.start).toBe(0);
    expect(root.ranges.body.start).toBeGreaterThan(0);
    expect(root.ranges.body.end).toBeLessThan(root.ranges.node.end);

    const skill = collaboration.nodes.find((node) => node.title === "模板方案与准备材料")!;
    expect(skill.state).toBe("proposed");
    expect(skill.description).toContain("把模板路线单独列为待讨论方案");
    const text = readFileSync(join(workspaceRoot, ...skill.sourcePath.split("/")), "utf8");
    expect(text.slice(skill.ranges.body.start, skill.ranges.body.end)).toBe(skill.body);
    expect(skill.body.startsWith("一种复用方式")).toBe(true);
    expect(text.slice(skill.ranges.node.start, skill.ranges.node.end)).toBe(text);
  });

  it("编号与主分支语义稳定", () => {
    const graph = collabResult().graph!;
    const byTitle = (title: string) => graph.nodes.find((node) => node.title === title)!;
    expect(byTitle("整理目标").number).toBe("01");
    expect(byTitle("排版约定").number).toBe("06");
    expect(byTitle("参考外部规范").number).toBe("07");
    expect(byTitle("排版约定").nextId).toBe(byTitle("参考外部规范").id);
    expect(byTitle("跨批次沿用约定").number).toBe("06-03");
    expect(byTitle("模板方案与准备材料").number).toBe("06-03-01");
    expect(byTitle("独立清单的设计思路").number).toBe("06-03-02");
    expect(graph.rootIds).toEqual([byTitle("整理目标").id]);
  });

  it("CRLF 与 BOM 保留，节点正文范围取自真实文件", () => {
    const path = "topics/协作方式/n_6fe284797b7d4f249440c5e8596f715d.md";
    const raw = readFileSync(join(workspaceRoot, ...path.split("/")), "utf8");
    const crlf = "﻿" + raw.replace(/\n/g, "\r\n");
    const documents = collaborationDocuments().map((document) =>
      document.path === path ? { ...document, text: crlf } : document,
    );
    const result = collabResult(documents);
    const root = result.topics[0]!.nodes.find((node) => node.flow === "root")!;
    expect(root.sourcePath).toBe(path);
    expect(crlf.slice(root.ranges.body.start, root.ranges.body.end)).toBe(root.body);
    expect(root.body).not.toContain("\r");
    expect(root.ranges.node.end).toBe(crlf.length);
  });

  it("跨主题 from 与无 root 的主题在 isolated 下都被拒绝", () => {
    const noRootNodeId = "n_11111111111111111111111111111111";
    const crossRootId = "n_22222222222222222222222222222222";
    const crossChildId = "n_33333333333333333333333333333333";
    const documents: WorkspaceDocument[] = [
      {
        path: "topics/无根主题/topic.md",
        text: "---\ntopicId: t_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ntitle: 无根主题\n---\n",
      },
      {
        path: "topics/无根主题/" + noRootNodeId + ".md",
        text:
          "---\nnodeId: " +
          noRootNodeId +
          "\ntitle: 缺少 root 的节点\nstate: proposed\nfrom: null\nflow: next\ndescription: 用于校验无 root 主题的诊断\n---\n\n正文。\n",
      },
      {
        path: "topics/跨主题/topic.md",
        text: "---\ntopicId: t_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\ntitle: 跨主题\n---\n",
      },
      {
        path: "topics/跨主题/" + crossRootId + ".md",
        text:
          "---\nnodeId: " +
          crossRootId +
          "\ntitle: 跨主题的根\nstate: proposed\nfrom: null\nflow: root\n---\n\n根正文。\n",
      },
      {
        path: "topics/跨主题/" + crossChildId + ".md",
        text:
          "---\nnodeId: " +
          crossChildId +
          "\ntitle: 接错主题的节点\nstate: proposed\nfrom: " +
          noRootNodeId +
          "\nflow: next\ndescription: 指向另一主题的节点，应被拒绝\n---\n\n子节点正文。\n",
      },
    ];

    const result = parseWorkspaceDocuments({
      workspace: {
        schemaVersion: 2,
        workspaceId: "ws_invalid_memory",
        name: "内存构造的非法样例",
        activeNode: null,
        topicMode: "isolated",
      },
      documents,
    });
    expect(result.ok).toBe(false);
    expect(result.schemaVersion).toBe(2);
    expect(result.topics).toEqual([]);
    const codes = result.diagnostics.map((item) => item.code);
    expect(codes).toContain("NODE_CROSS_TOPIC");
    expect(codes).toContain("NODE_ROOT_MISSING");
  });
});

describe("严格校验", () => {
  const nodesPath = (id: string) => "topics/协作方式/" + id + ".md";
  const rootId = "n_6fe284797b7d4f249440c5e8596f715d";
  const nextId = "n_eff864e24a9044eab734bdb3f0f8ecdd";

  function withDocument(path: string, text: string): WorkspaceDocument[] {
    return collaborationDocuments().map((document) => (document.path === path ? { ...document, text } : document));
  }

  function codes(documents: readonly WorkspaceDocument[]): string[] {
    return parseWorkspaceDocuments({ workspace: fixtureWorkspace, documents }).diagnostics.map((item) => item.code);
  }

  it("非 root 缺 description 或 root 写 description 都拒绝", () => {
    const text = readFileSync(join(workspaceRoot, ...nodesPath(nextId).split("/")), "utf8");
    const withoutDescription = text.replace(/^description:.*\r?\n/m, "");
    expect(codes(withDocument(nodesPath(nextId), withoutDescription))).toContain("NODE_DESCRIPTION_REQUIRED");

    const rootText = readFileSync(join(workspaceRoot, ...nodesPath(rootId).split("/")), "utf8");
    const withDescription = rootText.replace("flow: root", "flow: root\ndescription: 不该有");
    expect(codes(withDocument(nodesPath(rootId), withDescription))).toContain("NODE_DESCRIPTION_FORBIDDEN");
  });

  it("topic.md 正文必须为空，且不得写旧格式的节点清单", () => {
    const entry = "topics/协作方式/topic.md";
    const text = readFileSync(join(workspaceRoot, ...entry.split("/")), "utf8");
    expect(codes(withDocument(entry, text + "多余正文\n"))).toContain("TOPIC_BODY_NOT_EMPTY");
    const asLegacy = "---\nschemaVersion: 1\ntopicId: t_e2fc1361dd974f0ebedb4b1e3e15bfc5\ntitle: 资料整理的方法\nnodes: {}\n---\n";
    expect(codes(withDocument(entry, asLegacy))).toContain("FORMAT_MIXED");
  });

  it("节点文件不得写成主题头；未知字段与自定义标签仍拒绝", () => {
    const path = nodesPath(nextId);
    const text = readFileSync(join(workspaceRoot, ...path.split("/")), "utf8");
    const asTopic = text.replace("nodeId: " + nextId, "schemaVersion: 1\ntopicId: t_e2fc1361dd974f0ebedb4b1e3e15bfc5");
    expect(codes(withDocument(path, asTopic))).toContain("FORMAT_MIXED");

    const unknownField = text.replace("flow: next", "flow: next\ncolour: green");
    expect(codes(withDocument(path, unknownField))).toContain("SCHEMA_UNKNOWN_FIELD");

    const tagged = text.replace("title: 手工汇总的负担", "title: !t 手工汇总的负担");
    expect(codes(withDocument(path, tagged))).toContain("YAML_CUSTOM_TAG");

    const duplicated = text.replace("state: agreed", "state: agreed\nstate: proposed");
    expect(codes(withDocument(path, duplicated))).toContain("YAML_DUPLICATE_KEY");
  });

  it("孤立 Markdown、错误归属、孤立目录与重复路径都明确诊断", () => {
    const documents = collaborationDocuments();
    expect(codes([...documents, { path: "topics/散落.md", text: "---\nnodeId: n_00000000000000000000000000000001\n---\n" }]))
      .toContain("TOPIC_ORPHAN_DOCUMENT");
    expect(codes([...documents, { path: "topics/协作方式/嵌套/x.md", text: "---\nnodeId: n_00000000000000000000000000000001\n---\n" }]))
      .toContain("DOCUMENT_PATH_INVALID");
    expect(codes([...documents, { path: "topics/空目录/other.md", text: "---\nnodeId: n_00000000000000000000000000000001\n---\n" }]))
      .toContain("TOPIC_ENTRY_MISSING");
    expect(codes([...documents, documents[0]!])).toContain("DUPLICATE_DOCUMENT_PATH");
  });

  it("不支持的工作区版本被明确拒绝", () => {
    const unsupported = parseWorkspaceDocuments({
      workspace: { ...fixtureWorkspace, schemaVersion: 3 as unknown as 2 },
      documents: collaborationDocuments(),
    });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.schemaVersion).toBeNull();
    expect(unsupported.diagnostics.map((item) => item.code)).toEqual(["WORKSPACE_VERSION_UNSUPPORTED"]);

    const legacy = parseWorkspaceDocuments({
      workspace: { ...fixtureWorkspace, schemaVersion: 1 as unknown as 2 },
      documents: collaborationDocuments(),
    });
    expect(legacy.ok).toBe(false);
    expect(legacy.schemaVersion).toBeNull();
    expect(legacy.diagnostics.map((item) => item.code)).toEqual(["WORKSPACE_VERSION_UNSUPPORTED"]);
  });

  it("空工作区合法", () => {
    const empty = parseWorkspaceDocuments({
      workspace: { schemaVersion: 2, workspaceId: "w_empty", name: "空", activeNode: null },
      documents: [],
    });
    expect(empty.ok).toBe(true);
    expect(empty.graph).toMatchObject({ rootIds: [], nodes: [], topics: [] });
    expect(empty.graph && "rootId" in empty.graph).toBe(false);
  });
});

describe("主题模式固定 isolated", () => {
  it("显式 isolated 仍合法，shared 与旧版本不再接受", () => {
    const isolated = parseWorkspaceDocuments({
      workspace: { ...fixtureWorkspace, topicMode: "isolated" },
      documents: collaborationDocuments(),
    });
    expect(isolated.ok).toBe(true);

    const shared = parseWorkspaceDocuments({
      workspace: { ...fixtureWorkspace, topicMode: "shared" as unknown as "isolated" },
      documents: collaborationDocuments(),
    });
    expect(shared.ok).toBe(false);
    expect(shared.diagnostics[0]?.code).toBe("WORKSPACE_SCHEMA_INVALID");

    const legacy = parseWorkspaceDocuments({
      workspace: { schemaVersion: 1 as unknown as 2, workspaceId: "w", name: "n", activeNode: null },
      documents: [],
    });
    expect(legacy.ok).toBe(false);
    expect(legacy.diagnostics[0]?.code).toBe("WORKSPACE_VERSION_UNSUPPORTED");
  });
});

describe("branch 的 side 只表示来源显式声明", () => {
  const workspace: WorkspaceMeta = { schemaVersion: 2, workspaceId: "ws_side", name: "方向", activeNode: null };
  const dir = "topics/方向";
  const topicId = "t_00000000000000000000000000000001";
  const rootId = "n_00000000000000000000000000000001";
  const plainId = "n_00000000000000000000000000000002";
  const leftId = "n_00000000000000000000000000000003";

  function nodeDocument(id: string, title: string, fields: readonly string[]): WorkspaceDocument {
    return {
      path: dir + "/" + id + ".md",
      text: "---\n" + ["nodeId: " + id, "title: " + title, "state: agreed", ...fields].join("\n") + "\n---\n\n" + title + "的正文。\n",
    };
  }

  /** explicitRight 为 true 时给缺省分支补一个显式 side，用来证明 side 不参与编号。 */
  function documents(explicitRight = false): WorkspaceDocument[] {
    return [
      { path: dir + "/topic.md", text: "---\ntopicId: " + topicId + "\ntitle: 方向\n---\n" },
      nodeDocument(rootId, "根", ["from: null", "flow: root"]),
      nodeDocument(plainId, "未写方向", [
        "from: " + rootId,
        "flow: branch",
        "description: 来源没有指定方向",
        ...(explicitRight ? ["side: right"] : []),
        "order: 10",
      ]),
      nodeDocument(leftId, "写了左侧", [
        "from: " + rootId,
        "flow: branch",
        "description: 来源指定左侧",
        "side: left",
        "order: 20",
      ]),
    ];
  }

  it("缺省分支不输出 side，显式 side 原样保留，编号与补 side 前一致", () => {
    const result = parseWorkspaceDocuments({ workspace, documents: documents() });
    if (!result.ok || !result.graph) {
      throw new Error("方向用例未通过：" + result.diagnostics.map(formatDiagnostic).join(" | "));
    }
    const plain = result.graph.nodes.find((node) => node.id === plainId)!;
    expect("side" in plain).toBe(false);
    expect(plain.number).toBe("01-01");
    const left = result.graph.nodes.find((node) => node.id === leftId)!;
    expect(left.side).toBe("left");
    expect(left.number).toBe("01-02");

    const explicit = parseWorkspaceDocuments({ workspace, documents: documents(true) });
    expect(explicit.ok).toBe(true);
    const numbers = (nodes: readonly { id: string; number: string }[]) =>
      Object.fromEntries(nodes.map((node) => [node.id, node.number]));
    expect(numbers(explicit.graph!.nodes)).toEqual(numbers(result.graph.nodes));
    const explicitPlain = explicit.graph!.nodes.find((node) => node.id === plainId)!;
    expect(explicitPlain.side).toBe("right");
  });
});
