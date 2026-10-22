import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatDiagnostic,
  parseTopicDocument,
  parseWorkspaceDocuments,
  validateWorkspace,
  type ParsedTopic,
  type WorkspaceDocument,
  type WorkspaceMeta,
} from "../../src/core/index.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const v1Root = join(fixturesRoot, "workspace");
const v2Root = join(fixturesRoot, "workspace-v2");

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

function v2Documents(): WorkspaceDocument[] {
  return listMarkdown(v2Root).map((path) => documentOf(v2Root, path));
}

const v2Workspace = JSON.parse(readFileSync(join(v2Root, "workspace.json"), "utf8")) as WorkspaceMeta;

function v2Result(documents: readonly WorkspaceDocument[] = v2Documents()) {
  const result = parseWorkspaceDocuments({ workspace: v2Workspace, documents });
  if (!result.ok || !result.graph) {
    throw new Error("V2 fixture 未通过：" + result.diagnostics.map(formatDiagnostic).join(" | "));
  }
  return result;
}

function v1Result() {
  const workspace = JSON.parse(readFileSync(join(v1Root, "workspace.json"), "utf8")) as WorkspaceMeta;
  const documents = listMarkdown(v1Root).map((path) => documentOf(v1Root, path));
  const result = parseWorkspaceDocuments({ workspace, documents });
  if (!result.ok || !result.graph) {
    throw new Error("V1 fixture 未通过：" + result.diagnostics.map(formatDiagnostic).join(" | "));
  }
  return result;
}

describe("格式 2：目录分组与身份", () => {
  it("一节点一份 Markdown，标题与身份来自元数据", () => {
    const result = v2Result();
    expect(result.schemaVersion).toBe(2);
    expect(result.topics.map((topic) => topic.dir)).toEqual(["协作方式", "记录的分寸"].sort());
    const collaboration = result.topics.find((topic) => topic.dir === "协作方式")!;
    expect(collaboration.document.path).toBe("topics/协作方式/topic.md");
    expect(collaboration.sourcePaths).toHaveLength(13);
    expect(collaboration.sourcePaths).toContain("topics/协作方式/topic.md");
    expect(collaboration.nodes.map((node) => node.title)).toContain("整理目标");

    const root = collaboration.nodes.find((node) => node.flow === "root")!;
    expect(root.sourcePath).toBe("topics/协作方式/n_6fe284797b7d4f249440c5e8596f715d.md");
    expect(root.topicPath).toBe("topics/协作方式/topic.md");
    expect(root.description).toBeUndefined();
    expect(root.ranges.heading).toBeUndefined();
    expect(root.ranges.comment).toBeUndefined();
    const rootText = readFileSync(join(v2Root, ...root.sourcePath.split("/")), "utf8");
    expect(root.ranges.node).toEqual({ start: 0, end: rootText.length });
    expect(root.ranges.body.start).toBeGreaterThan(0);
    expect(root.ranges.body.end).toBeLessThan(root.ranges.node.end);

    const skill = collaboration.nodes.find((node) => node.title === "模板方案与准备材料")!;
    expect(skill.state).toBe("proposed");
    expect(skill.description).toContain("把模板路线单独列为待讨论方案");
    const text = readFileSync(join(v2Root, ...skill.sourcePath.split("/")), "utf8");
    expect(text.slice(skill.ranges.body.start, skill.ranges.body.end)).toBe(skill.body);
    expect(skill.body.startsWith("一种复用方式")).toBe(true);
    expect(text.slice(skill.ranges.node.start, skill.ranges.node.end)).toBe(text);
  });

  it("编号与主分支语义和格式 1 完全一致", () => {
    const v1 = v1Result();
    const v2 = v2Result();
    const numbers = (nodes: readonly { title: string; number: string }[]) =>
      Object.fromEntries(nodes.map((node) => [node.title, node.number]));
    expect(numbers(v2.graph!.nodes)).toEqual(numbers(v1.graph!.nodes));
    const canvas = v2.graph!.nodes.find((node) => node.title === "排版约定")!;
    const reference = v2.graph!.nodes.find((node) => node.title === "参考外部规范")!;
    expect(canvas.number).toBe("06");
    expect(reference.number).toBe("07");
    expect(canvas.nextId).toBe(reference.id);
    expect(v2.graph!.nodes.find((node) => node.title === "跨批次沿用约定")!.number).toBe("06-03");
    expect(v2.graph!.nodes.find((node) => node.title === "模板方案与准备材料")!.number).toBe("06-03-01");
    expect(v2.graph!.nodes.find((node) => node.title === "独立清单的设计思路")!.number).toBe("06-03-02");
  });

  it("CRLF 与 BOM 保留，节点正文范围取自真实文件", () => {
    const path = "topics/协作方式/n_6fe284797b7d4f249440c5e8596f715d.md";
    const raw = readFileSync(join(v2Root, ...path.split("/")), "utf8");
    const crlf = "\uFEFF" + raw.replace(/\n/g, "\r\n");
    const documents = v2Documents().map((document) =>
      document.path === path ? { ...document, text: crlf } : document,
    );
    const result = v2Result(documents);
    const root = result.topics.find((topic) => topic.dir === "协作方式")!.nodes.find((node) => node.flow === "root")!;
    expect(root.sourcePath).toBe(path);
    expect(crlf.slice(root.ranges.body.start, root.ranges.body.end)).toBe(root.body);
    expect(root.body).not.toContain("\r");
    expect(root.ranges.node.end).toBe(crlf.length);
  });

  it("跨主题 from 在格式 2 同样合法", () => {
    const result = v2Result();
    const record = result.graph!.nodes.find((node) => node.title === "记录的取舍")!;
    expect(record.topicId).toBe("t_64e917c597fb4da4abd5467512fab596");
    expect(record.number).toBe("05-01");
    expect(result.graph!.nodes.find((node) => node.id === record.from)!.topicId).not.toBe(record.topicId);
  });
});

describe("格式 2：严格校验", () => {
  const nodesPath = (id: string) => "topics/协作方式/" + id + ".md";
  const rootId = "n_6fe284797b7d4f249440c5e8596f715d";
  const nextId = "n_eff864e24a9044eab734bdb3f0f8ecdd";

  function withDocument(path: string, text: string): WorkspaceDocument[] {
    return v2Documents().map((document) => (document.path === path ? { ...document, text } : document));
  }

  function codes(documents: readonly WorkspaceDocument[]): string[] {
    return parseWorkspaceDocuments({ workspace: v2Workspace, documents }).diagnostics.map((item) => item.code);
  }

  it("非 root 缺 description 或 root 写 description 都拒绝", () => {
    const text = readFileSync(join(v2Root, ...nodesPath(nextId).split("/")), "utf8");
    const withoutDescription = text.replace(/^description:.*\r?\n/m, "");
    expect(codes(withDocument(nodesPath(nextId), withoutDescription))).toContain("NODE_DESCRIPTION_REQUIRED");

    const rootText = readFileSync(join(v2Root, ...nodesPath(rootId).split("/")), "utf8");
    const withDescription = rootText.replace("flow: root", "flow: root\ndescription: 不该有");
    expect(codes(withDocument(nodesPath(rootId), withDescription))).toContain("NODE_DESCRIPTION_FORBIDDEN");
  });

  it("topic.md 正文必须为空，且不得写格式 1 的节点清单", () => {
    const entry = "topics/协作方式/topic.md";
    const text = readFileSync(join(v2Root, ...entry.split("/")), "utf8");
    expect(codes(withDocument(entry, text + "多余正文\n"))).toContain("V2_TOPIC_BODY_NOT_EMPTY");
    const asV1 = "---\nschemaVersion: 1\ntopicId: t_e2fc1361dd974f0ebedb4b1e3e15bfc5\ntitle: 资料整理的方法\nnodes: {}\n---\n";
    expect(codes(withDocument(entry, asV1))).toContain("FORMAT_MIXED");
  });

  it("节点文件不得写成格式 1 主题头；未知字段与自定义标签仍拒绝", () => {
    const path = nodesPath(nextId);
    const text = readFileSync(join(v2Root, ...path.split("/")), "utf8");
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
    const documents = v2Documents();
    expect(codes([...documents, { path: "topics/散落.md", text: "---\nnodeId: n_00000000000000000000000000000001\n---\n" }]))
      .toContain("V2_ORPHAN_DOCUMENT");
    expect(codes([...documents, { path: "topics/协作方式/嵌套/x.md", text: "---\nnodeId: n_00000000000000000000000000000001\n---\n" }]))
      .toContain("DOCUMENT_PATH_INVALID");
    expect(codes([...documents, { path: "topics/空目录/other.md", text: "---\nnodeId: n_00000000000000000000000000000001\n---\n" }]))
      .toContain("V2_TOPIC_MISSING");
    expect(codes([...documents, documents[0]!])).toContain("DUPLICATE_DOCUMENT_PATH");
  });

  it("不支持的工作区版本与格式 1／2 混用", () => {
    const unsupported = parseWorkspaceDocuments({
      workspace: { ...v2Workspace, schemaVersion: 3 as unknown as 2 },
      documents: v2Documents(),
    });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.schemaVersion).toBeNull();
    expect(unsupported.diagnostics.map((item) => item.code)).toEqual(["WORKSPACE_VERSION_UNSUPPORTED"]);

    const mixed = parseWorkspaceDocuments({
      workspace: { ...v2Workspace, schemaVersion: 1 },
      documents: v2Documents(),
    });
    expect(mixed.ok).toBe(false);
    expect(mixed.schemaVersion).toBe(1);
    expect(mixed.topics).toEqual([]);
    expect(mixed.diagnostics.every((item) => item.code === "FORMAT_MIXED")).toBe(true);

    // 反向：格式 2 工作区混入格式 1 主题文件。
    const v1Topic = readFileSync(join(v1Root, "topics", "协作方式.md"), "utf8");
    const mixedBack = parseWorkspaceDocuments({
      workspace: v2Workspace,
      documents: [...v2Documents(), { path: "topics/协作方式/旧主题.md", text: v1Topic }],
    });
    expect(mixedBack.ok).toBe(false);
    expect(mixedBack.diagnostics.map((item) => item.code)).toContain("FORMAT_MIXED");
  });

  it("空工作区合法；格式 1 仍走原有解析器", () => {
    const empty = parseWorkspaceDocuments({
      workspace: { schemaVersion: 2, workspaceId: "w_empty", name: "空", activeNode: null },
      documents: [],
    });
    expect(empty.ok).toBe(true);
    expect(empty.graph).toMatchObject({ rootId: null, nodes: [], topics: [] });

    const v1 = v1Result();
    expect(v1.schemaVersion).toBe(1);
    expect(v1.topics.every((topic: ParsedTopic) => topic.schemaVersion === 1)).toBe(true);
    expect(v1.topics.every((topic) => topic.sourcePaths.length === 1 && topic.sourcePaths[0] === topic.document.path)).toBe(true);
    expect(v1.graph!.nodes.every((node) => node.sourcePath === node.topicPath)).toBe(true);
    expect(validateWorkspace({ workspace: { schemaVersion: 1, workspaceId: "w", name: "n", activeNode: null }, topics: [] }).ok).toBe(true);
  });
});

describe("主题模式兼容", () => {
  it("旧格式 1/2 未声明主题模式仍接受共享根与跨主题连接", () => {
    expect(v1Result().graph?.rootIds).toHaveLength(1);
    expect(v2Result().graph?.rootIds).toHaveLength(1);
    const explicit = parseWorkspaceDocuments({ workspace: { ...v2Workspace, topicMode: "shared" }, documents: v2Documents() });
    expect(explicit.ok).toBe(true);
    const isolated = parseWorkspaceDocuments({ workspace: { ...v2Workspace, topicMode: "isolated" }, documents: v2Documents() });
    expect(isolated.ok).toBe(false);
    expect(isolated.diagnostics.some((item) => item.code === "NODE_CROSS_TOPIC")).toBe(true);
  });
  it("格式1不能伪装成隔离模式", () => {
    const invalid = parseWorkspaceDocuments({ workspace: { ...v2Workspace, schemaVersion: 1, topicMode: "isolated" }, documents: [] });
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics[0]?.code).toBe("WORKSPACE_SCHEMA_INVALID");
  });
});
