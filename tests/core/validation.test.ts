import { describe, expect, it } from "vitest";
import {
  nodeFromDocument,
  parseNodeDocument,
  parseTopicDocument,
  parseWorkspaceDocuments,
  validateWorkspace,
  type DiagnosticCode,
  type WorkspaceDocument,
  type WorkspaceMeta,
} from "../../src/core/index.js";

const N1 = "n_00000000000000000000000000000001";
const N2 = "n_00000000000000000000000000000002";
const N3 = "n_00000000000000000000000000000003";
const N4 = "n_00000000000000000000000000000004";
const T1 = "t_00000000000000000000000000000001";
const T2 = "t_00000000000000000000000000000002";

interface NodeSpec {
  id: string;
  title: string;
  body: string;
  from: string | null;
  flow: "root" | "next" | "branch";
  state?: "agreed" | "proposed" | "reference";
  description?: string;
  side?: "left" | "right";
  order?: number;
  summary?: string;
}

const CONTEXT = { topicId: T1, topicPath: "topics/测试/topic.md", dir: "测试" };

function renderNode(spec: NodeSpec, newline = "\n"): string {
  const lines: string[] = [
    "---",
    "nodeId: " + spec.id,
    "title: " + spec.title,
    "state: " + (spec.state ?? "agreed"),
    "from: " + (spec.from === null ? "null" : spec.from),
    "flow: " + spec.flow,
  ];
  const description = spec.description === undefined && spec.flow !== "root" ? "测试来源" : spec.description;
  if (description !== undefined) lines.push("description: " + description);
  if (spec.side !== undefined) lines.push("side: " + spec.side);
  if (spec.order !== undefined) lines.push("order: " + spec.order);
  if (spec.summary !== undefined) lines.push("summary: " + spec.summary);
  lines.push("---", "", spec.body, "");
  return lines.join(newline);
}

function renderTopic(topicId = T1, title = "测试主题", newline = "\n"): string {
  return ["---", "topicId: " + topicId, "title: " + title, "---", ""].join(newline);
}

function nodePath(dir: string, id: string): string {
  return "topics/" + dir + "/" + id + ".md";
}

function topicDocuments(options: {
  dir: string;
  topicId?: string;
  title?: string;
  nodes: readonly NodeSpec[];
  newline?: string;
}): WorkspaceDocument[] {
  const newline = options.newline ?? "\n";
  return [
    { path: "topics/" + options.dir + "/topic.md", text: renderTopic(options.topicId ?? T1, options.title ?? "测试主题", newline) },
    ...options.nodes.map((spec) => ({
      path: nodePath(options.dir, spec.id),
      text: renderNode(spec, newline),
    })),
  ];
}

function workspaceMeta(activeNode: string | null = null): WorkspaceMeta {
  return { schemaVersion: 2, workspaceId: "ws_test", name: "测试工作区", activeNode };
}

function codesOfTopics(topics: readonly (readonly WorkspaceDocument[])[], activeNode: string | null = null): DiagnosticCode[] {
  const result = parseWorkspaceDocuments({
    workspace: workspaceMeta(activeNode),
    documents: topics.flat(),
  });
  return result.diagnostics.map((item) => item.code);
}

function nodeCodesOf(text: string): DiagnosticCode[] {
  return parseNodeDocument(text, nodePath("测试", N1), CONTEXT).diagnostics.map((item) => item.code);
}

function entryCodesOf(text: string): DiagnosticCode[] {
  return parseTopicDocument(text, "topics/测试/topic.md").diagnostics.map((item) => item.code);
}

const baseNodes: NodeSpec[] = [
  { id: N1, title: "起点", body: "起点正文。", from: null, flow: "root" },
  { id: N2, title: "接着", body: "接着讨论。", from: N1, flow: "next" },
];

describe("frontmatter 受限 YAML 与 schema", () => {
  it("重复键、自定义标签、未知字段和非法取值都明确拒绝", () => {
    const rootDocument = renderNode(baseNodes[0]!);
    const duplicate = rootDocument.replace("state: agreed", "state: agreed\nstate: proposed");
    expect(nodeCodesOf(duplicate)).toContain("YAML_DUPLICATE_KEY");

    const tagged = rootDocument.replace("title: 起点", "title: !topic 起点");
    expect(nodeCodesOf(tagged)).toContain("YAML_CUSTOM_TAG");

    const unknown = rootDocument.replace("flow: root", "flow: root\ncolour: green");
    expect(nodeCodesOf(unknown)).toContain("SCHEMA_UNKNOWN_FIELD");

    const invalidState = rootDocument.replace("state: agreed", "state: accepted");
    expect(nodeCodesOf(invalidState)).toContain("SCHEMA_INVALID");

    const invalidSide = renderNode(baseNodes[1]!).replace("flow: next", "flow: next\nside: middle");
    expect(nodeCodesOf(invalidSide)).toContain("SCHEMA_INVALID");

    const notMapping = "---\n- 1\n- 2\n---\n";
    expect(nodeCodesOf(notMapping)).toContain("FRONTMATTER_NOT_MAPPING");

    const alias = rootDocument.replace("title: 起点", "title: &t 起点\nalias: *t");
    expect(nodeCodesOf(alias)).toContain("SCHEMA_UNKNOWN_FIELD");
  });

  it("缺少 frontmatter、未闭合 frontmatter 与空入口都报明确错误", () => {
    expect(nodeCodesOf("正文没有 frontmatter。\n")).toEqual(["FRONTMATTER_MISSING"]);
    expect(nodeCodesOf("---\nnodeId: " + N1 + "\n")).toEqual(["FRONTMATTER_UNCLOSED"]);
    expect(entryCodesOf("---\ntopicId: " + T1 + "\ntitle: 空\n---\n多余正文\n")).toEqual(["TOPIC_BODY_NOT_EMPTY"]);
  });

  it("主题入口只能写身份，节点头不能混入主题字段", () => {
    expect(entryCodesOf("---\nschemaVersion: 1\ntopicId: " + T1 + "\ntitle: 旧\nnodes: {}\n---\n")).toEqual(["FORMAT_MIXED"]);
    expect(nodeCodesOf(renderTopic())).toEqual(["FORMAT_MIXED"]);
  });
});

describe("目录分组与路径约束", () => {
  it("每个主题目录必须有 topic.md，节点文件直接放在目录下", () => {
    const documents = topicDocuments({ dir: "测试", nodes: baseNodes });
    expect(codesOfTopics([documents])).toEqual([]);

    const missingEntry = documents.filter((document) => !document.path.endsWith("/topic.md"));
    expect(codesOfTopics([missingEntry])).toContain("TOPIC_ENTRY_MISSING");

    const nested = [...documents, { path: "topics/测试/嵌套/x.md", text: renderNode(baseNodes[0]!) }];
    expect(codesOfTopics([nested])).toContain("DOCUMENT_PATH_INVALID");

    const orphan = [...documents, { path: "topics/散落.md", text: renderNode(baseNodes[0]!) }];
    expect(codesOfTopics([orphan])).toContain("TOPIC_ORPHAN_DOCUMENT");

    const duplicated = [...documents, documents[0]!];
    expect(codesOfTopics([duplicated])).toContain("DUPLICATE_DOCUMENT_PATH");
  });
});

describe("工作区图约束", () => {
  it("空工作区合法且返回空图", () => {
    const result = validateWorkspace({ workspace: workspaceMeta(null), topics: [] });
    expect(result.ok).toBe(true);
    expect(result.graph).toEqual({
      workspaceId: "ws_test",
      name: "测试工作区",
      activeNode: null,
      rootIds: [],
      topics: [],
      nodes: [],
    });
  });

  it("每个主题恰好一个 root，自连、断链、多 next、同源重复 order 与非法焦点都被拒绝", () => {
    expect(codesOfTopics([topicDocuments({ dir: "测一", nodes: baseNodes })])).toEqual([]);

    const noRoot = topicDocuments({ dir: "测一", nodes: [{ ...baseNodes[0]!, flow: "next" }] });
    const noRootCodes = codesOfTopics([noRoot]);
    expect(noRootCodes).toContain("NODE_ROOT_MISSING");
    expect(noRootCodes).toContain("NODE_FROM_MISSING");

    const twoRoots = topicDocuments({
      dir: "测一",
      nodes: [baseNodes[0]!, { ...baseNodes[1]!, flow: "root", from: null }],
    });
    expect(codesOfTopics([twoRoots])).toContain("NODE_ROOT_MULTIPLE");

    const rootFrom = topicDocuments({ dir: "测一", nodes: [{ ...baseNodes[0]!, from: N2 }] });
    expect(codesOfTopics([rootFrom])).toContain("NODE_ROOT_INVALID");

    const selfLink = topicDocuments({ dir: "测一", nodes: [baseNodes[0]!, { ...baseNodes[1]!, from: N2 }] });
    expect(codesOfTopics([selfLink])).toContain("NODE_SELF_LINK");

    const broken = topicDocuments({ dir: "测一", nodes: [baseNodes[0]!, { ...baseNodes[1]!, from: N4 }] });
    expect(codesOfTopics([broken])).toContain("NODE_FROM_UNKNOWN");

    const focus = topicDocuments({ dir: "测一", nodes: baseNodes });
    expect(codesOfTopics([focus], N4)).toContain("FOCUS_NODE_UNKNOWN");

    const twoNext = topicDocuments({
      dir: "测一",
      nodes: [baseNodes[0]!, baseNodes[1]!, { ...baseNodes[1]!, id: N3, title: "另一个下一张" }],
    });
    expect(codesOfTopics([twoNext])).toContain("NODE_NEXT_MULTIPLE");

    const duplicateOrder = topicDocuments({
      dir: "测一",
      nodes: [
        baseNodes[0]!,
        { id: N2, title: "左分支", body: "左。", from: N1, flow: "branch", side: "left", order: 10 },
        { id: N3, title: "右分支", body: "右。", from: N1, flow: "branch", side: "right", order: 10 },
      ],
    });
    expect(codesOfTopics([duplicateOrder])).toContain("NODE_BRANCH_ORDER_DUPLICATED");

    const nextSide = topicDocuments({ dir: "测一", nodes: [baseNodes[0]!, { ...baseNodes[1]!, side: "right" }] });
    expect(codesOfTopics([nextSide])).toContain("NODE_FLOW_FIELD_INVALID");

    const rootOrder = topicDocuments({ dir: "测一", nodes: [{ ...baseNodes[0]!, order: 10 }] });
    expect(codesOfTopics([rootOrder])).toContain("NODE_FLOW_FIELD_INVALID");
  });

  it("branch 省略 side／order 时仍校验通过，视图不补 side", () => {
    const documents = topicDocuments({
      dir: "测一",
      nodes: [
        baseNodes[0]!,
        { id: N2, title: "未写侧向", body: "侧向正文。", from: N1, flow: "branch" },
        { id: N3, title: "已写侧向", body: "另一侧向。", from: N1, flow: "branch", side: "left", order: 10 },
      ],
    });
    const result = parseWorkspaceDocuments({ workspace: workspaceMeta(), documents });
    expect(result.ok).toBe(true);
    const branches = result.graph!.nodes.filter((node) => node.flow === "branch");
    expect(branches.map((node) => node.side)).toEqual(["left", undefined]);
    expect(branches.map((node) => node.number)).toEqual(["01-01", "01-02"]);
    expect(result.graph!.nodes.find((node) => node.id === N2)?.order).toBeUndefined();
  });

  it("缺 order 的 branch 按 node.id 稳定排序，输入顺序不影响编号", () => {
    const nodes: NodeSpec[] = [
      baseNodes[0]!,
      { id: N3, title: "无 order B", body: "B。", from: N1, flow: "branch" },
      { id: N4, title: "无 order A", body: "A。", from: N1, flow: "branch" },
      { id: N2, title: "显式 order", body: "C。", from: N1, flow: "branch", order: 10 },
    ];
    const documents = topicDocuments({ dir: "测一", nodes });
    const reversed = topicDocuments({ dir: "测一", nodes: [...nodes].reverse() });
    const forward = parseWorkspaceDocuments({ workspace: workspaceMeta(), documents });
    const backward = parseWorkspaceDocuments({ workspace: workspaceMeta(), documents: reversed });
    expect(forward.ok).toBe(true);
    expect(backward.ok).toBe(true);
    const numbersOf = (graph: typeof forward.graph) =>
      Object.fromEntries((graph?.nodes ?? []).map((node) => [node.id, node.number]));
    expect(numbersOf(forward.graph)).toEqual(numbersOf(backward.graph));
    // 显式 order 先排；两个缺 order 的按 id 升序（N3 < N4），与输入顺序无关。
    expect(numbersOf(forward.graph)).toEqual({
      [N1]: "01",
      [N2]: "01-01",
      [N3]: "01-02",
      [N4]: "01-03",
    });
  });

  it("环与不可达节点被拒绝", () => {
    const cycle = topicDocuments({
      dir: "测一",
      nodes: [
        { ...baseNodes[0]!, from: N2, flow: "next" },
        { ...baseNodes[1]!, from: N1 },
      ],
    });
    expect(codesOfTopics([cycle])).toContain("GRAPH_CYCLE");

    const orphan = topicDocuments({
      dir: "测一",
      nodes: [baseNodes[0]!, baseNodes[1]!, { id: N3, title: "孤立", body: "孤立。", from: null, flow: "next" }],
    });
    const orphanCodes = codesOfTopics([orphan]);
    expect(orphanCodes).toContain("NODE_FROM_MISSING");
    expect(orphanCodes).toContain("NODE_UNREACHABLE");
  });

  it("全图重复 ID、重复主题 ID 与跨主题连接都被拒绝", () => {
    expect(codesOfTopics([
      topicDocuments({ dir: "测一", topicId: T1, nodes: baseNodes }),
      topicDocuments({ dir: "测二", topicId: T2, nodes: [{ ...baseNodes[0]! }] }),
    ])).toContain("NODE_ID_DUPLICATED");

    expect(codesOfTopics([
      topicDocuments({ dir: "测一", topicId: T1, nodes: baseNodes }),
      topicDocuments({ dir: "测二", topicId: T1, nodes: [{ ...baseNodes[0]!, id: N3 }] }),
    ])).toContain("TOPIC_ID_DUPLICATED");

    const crossTopic = codesOfTopics([
      topicDocuments({ dir: "测一", topicId: T1, nodes: baseNodes }),
      topicDocuments({
        dir: "测二",
        topicId: T2,
        nodes: [
          { id: N3, title: "另一主题根", body: "根。", from: null, flow: "root" },
          { id: N4, title: "跨主题", body: "跨主题连接。", from: N2, flow: "branch", order: 10 },
        ],
      }),
    ]);
    expect(crossTopic).toContain("NODE_CROSS_TOPIC");
  });

  it("隔离主题各自编号，rootIds 与节点顺序稳定", () => {
    const result = parseWorkspaceDocuments({
      workspace: workspaceMeta(),
      documents: [
        ...topicDocuments({ dir: "测一", topicId: T1, nodes: baseNodes }),
        ...topicDocuments({
          dir: "测二",
          topicId: T2,
          nodes: [
            { id: N3, title: "第二主题根", body: "根。", from: null, flow: "root" },
            { id: N4, title: "第二主题接着", body: "接着。", from: N3, flow: "next" },
          ],
        }),
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.graph!.rootIds).toEqual([N1, N3]);
    expect(result.graph!.nodes.map((node) => [node.id, node.number])).toEqual([
      [N1, "01"],
      [N2, "02"],
      [N3, "01"],
      [N4, "02"],
    ]);
  });
});

describe("源码范围与换行", () => {
  it("CRLF 与补充平面字符下 offset 仍可直接切片", () => {
    const spec: NodeSpec = {
      id: N1,
      title: "起点",
      body: "😀 表情与中文正文。\r\n\r\n第二段。",
      from: null,
      flow: "root",
    };
    const text = renderNode(spec, "\r\n");
    const parsed = parseNodeDocument(text, nodePath("测试", N1), CONTEXT);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.newline).toBe("crlf");
    const node = parsed.header!;
    expect(node.title).toBe("起点");
    expect(parsed.document.text.slice(parsed.document.bodyRange!.start).trim()).toBe(spec.body);

    const assembled = nodeFromDocument(parsed.document, node, CONTEXT);
    expect(assembled.body.startsWith("😀")).toBe(true);
    expect(assembled.body).toContain("\r\n");
    expect(text.slice(assembled.ranges.body.start, assembled.ranges.body.end)).toBe(assembled.body);
    expect(text.slice(0, assembled.ranges.body.start)).toContain("nodeId: " + N1);
  });

  it("摘要在 Unicode 码点边界截断", () => {
    const documents = topicDocuments({
      dir: "测试",
      nodes: [{ ...baseNodes[0]!, body: "汉".repeat(130) }],
    });
    const result = parseWorkspaceDocuments({ workspace: workspaceMeta(), documents });
    expect(result.ok).toBe(true);
    expect(Array.from(result.topics[0]!.nodes[0]!.summary)).toHaveLength(120);
  });
});
