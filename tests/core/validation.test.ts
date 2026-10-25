import { describe, expect, it } from "vitest";
import {
  formatDiagnostic,
  parseTopicDocument,
  validateWorkspace,
  type DiagnosticCode,
  type WorkspaceMeta,
} from "../../src/core/index.js";

const N1 = "n_00000000000000000000000000000001";
const N2 = "n_00000000000000000000000000000002";
const N3 = "n_00000000000000000000000000000003";
const N4 = "n_00000000000000000000000000000004";
const T1 = "t_00000000000000000000000000000001";
const T2 = "t_00000000000000000000000000000002";
const FENCE = String.fromCharCode(96, 96, 96);

interface NodeSpec {
  id: string;
  title: string;
  body: string;
  from: string | null;
  flow: "root" | "next" | "branch";
  state?: "agreed" | "proposed" | "reference";
  side?: "left" | "right";
  order?: number;
  summary?: string;
}

function renderTopic(options: {
  topicId?: string;
  title?: string;
  nodes: readonly NodeSpec[];
  extraFrontmatter?: string;
  newline?: string;
  beforeFirstCard?: string;
  bodyAt?: (node: NodeSpec) => string;
}): string {
  const newline = options.newline ?? "\n";
  const lines: string[] = [
    "---",
    "schemaVersion: 1",
    "topicId: " + (options.topicId ?? T1),
    "title: " + (options.title ?? "测试主题"),
  ];
  if (options.extraFrontmatter) lines.push(options.extraFrontmatter);
  lines.push("nodes:");
  for (const node of options.nodes) {
    lines.push("  " + node.id + ":");
    lines.push("    from: " + (node.from === null ? "null" : node.from));
    lines.push("    flow: " + node.flow);
    lines.push("    state: " + (node.state ?? "agreed"));
    if (node.side) lines.push("    side: " + node.side);
    if (node.order !== undefined) lines.push("    order: " + node.order);
    if (node.summary) lines.push("    summary: " + node.summary);
  }
  lines.push("---", "");
  if (options.beforeFirstCard) lines.push(options.beforeFirstCard, "");
  for (const node of options.nodes) {
    lines.push("## " + node.title + " <!-- node:" + node.id + " -->", "");
    lines.push(options.bodyAt ? options.bodyAt(node) : node.body, "");
  }
  return lines.join(newline);
}

function codesOf(text: string): DiagnosticCode[] {
  return parseTopicDocument(text, { path: "topics/test.md" }).diagnostics.map((item) => item.code);
}

const baseNodes: NodeSpec[] = [
  { id: N1, title: "起点", body: "起点正文。", from: null, flow: "root" },
  { id: N2, title: "接着", body: "接着讨论。", from: N1, flow: "next" },
];

function workspaceMeta(activeNode: string | null = null): WorkspaceMeta {
  return { schemaVersion: 1, workspaceId: "ws_test", name: "测试工作区", activeNode };
}

function topicOf(text: string) {
  const result = parseTopicDocument(text, { path: "topics/test.md" });
  if (!result.ok || !result.topic) {
    throw new Error("预期解析成功：" + result.diagnostics.map(formatDiagnostic).join(" | "));
  }
  return result.topic;
}

function graphCodes(texts: readonly string[], activeNode: string | null = null): DiagnosticCode[] {
  const topics = texts.map(topicOf);
  return validateWorkspace({ workspace: workspaceMeta(activeNode), topics }).diagnostics.map((item) => item.code);
}

describe("frontmatter 受限 YAML 与 schema", () => {
  it("重复键、自定义标签、未知字段和高版本都明确拒绝", () => {
    const duplicate = renderTopic({ nodes: baseNodes, extraFrontmatter: "title: 另一个" });
    expect(codesOf(duplicate)).toContain("YAML_DUPLICATE_KEY");

    const tagged = renderTopic({ nodes: baseNodes }).replace("title: 测试主题", "title: !topic 测试主题");
    expect(codesOf(tagged)).toContain("YAML_CUSTOM_TAG");

    const unknown = renderTopic({ nodes: [{ ...baseNodes[0]!, state: "agreed" }] }).replace(
      "    state: agreed",
      "    state: agreed\n    colour: green",
    );
    expect(codesOf(unknown)).toContain("SCHEMA_UNKNOWN_FIELD");

    const higher = renderTopic({ nodes: baseNodes }).replace("schemaVersion: 1", "schemaVersion: 2");
    expect(codesOf(higher)).toContain("SCHEMA_VERSION_UNSUPPORTED");

    const notMapping = "---\n- 1\n- 2\n---\n\n## x <!-- node:" + N1 + " -->\n";
    expect(codesOf(notMapping)).toContain("FRONTMATTER_NOT_MAPPING");

    const alias = renderTopic({ nodes: baseNodes }).replace("title: 测试主题", "title: &t 测试主题\nalias: *t");
    expect(codesOf(alias)).toContain("SCHEMA_UNKNOWN_FIELD");
  });

  it("缺少 frontmatter 与未闭合 frontmatter 报明确错误", () => {
    expect(codesOf("## 标题 <!-- node:" + N1 + " -->\n\n正文\n")).toEqual(["FRONTMATTER_MISSING"]);
    expect(codesOf("---\nschemaVersion: 1\n\n## 标题\n")).toEqual(["FRONTMATTER_UNCLOSED"]);
  });
});

describe("AST 卡片识别与正文约束", () => {
  it("代码围栏里的假标题和假 ID 不生成节点", () => {
    const text = renderTopic({
      nodes: baseNodes,
      bodyAt: (node) =>
        node.id === N1
          ? "正文。\n\n" + FENCE + "md\n## 假标题 <!-- node:" + N3 + " -->\n" + FENCE + "\n\n仍是同一张卡片。"
          : node.body,
    });
    const topic = topicOf(text);
    expect(topic.nodes.map((node) => node.id)).toEqual([N1, N2]);
    expect(topic.nodes[0]?.body).toContain("假标题");
    expect(topic.nodes[0]!.ranges.body.end - topic.nodes[0]!.ranges.body.start).toBeGreaterThan(20);
    expect(topic.nodes[0]?.body).not.toContain("## 假标题 <!-- node:" + N3 + " -->\n\n仍是");
  });

  it("注释与正文 ID 必须一一对应", () => {
    const missingMeta = renderTopic({ nodes: baseNodes }).replace("  " + N2 + ":", "  " + N3 + ":");
    expect(codesOf(missingMeta)).toEqual(expect.arrayContaining(["NODE_META_MISSING", "NODE_BLOCK_MISSING"]));

    const missingBody = renderTopic({ nodes: baseNodes }).replace(
      "## 接着 <!-- node:" + N2 + " -->",
      "## 接着 ",
    );
    expect(codesOf(missingBody)).toEqual(expect.arrayContaining(["CARD_MISSING_NODE_COMMENT"]));

    const duplicateBody = renderTopic({ nodes: baseNodes }).replace(
      "## 接着 <!-- node:" + N2 + " -->",
      "## 接着 <!-- node:" + N2 + " --> <!-- node:" + N2 + " -->",
    );
    expect(codesOf(duplicateBody)).toContain("CARD_DUPLICATE_NODE_COMMENT");

    const extraComment = renderTopic({ nodes: baseNodes }).replace(
      "## 接着 <!-- node:" + N2 + " -->",
      "## 接着 <!-- node:" + N2 + " --> 补充",
    );
    expect(codesOf(extraComment)).toContain("CARD_VISIBLE_TEXT_AFTER_COMMENT");
  });

  it("首个卡片前只允许空白和格式注释；内部标题不得回退到二级", () => {
    const leading = renderTopic({ nodes: baseNodes, beforeFirstCard: "未纳入 graph 的正文。" });
    expect(codesOf(leading)).toContain("CONTENT_BEFORE_FIRST_CARD");

    const commentOnly = renderTopic({ nodes: baseNodes, beforeFirstCard: "<!-- format: card -->" });
    expect(codesOf(commentOnly)).toEqual([]);

    const internal = renderTopic({
      nodes: baseNodes,
      bodyAt: (node) => (node.id === N1 ? "正文。\n\n# 一级子标题\n\n更多。" : node.body),
    });
    expect(codesOf(internal)).toContain("CARD_INTERNAL_HEADING_LEVEL");

    // 顶层二级标题必然是下一张卡片，没有 node 注释就报缺少注释，而不是悄悄并入正文。
    const newCard = renderTopic({
      nodes: baseNodes,
      bodyAt: (node) => (node.id === N1 ? "正文。\n\n## 二级子标题\n\n更多。" : node.body),
    });
    expect(codesOf(newCard)).toContain("CARD_MISSING_NODE_COMMENT");

    const thirdLevel = renderTopic({
      nodes: baseNodes,
      bodyAt: (node) => (node.id === N1 ? "正文。\n\n### 三级子标题\n\n更多。" : node.body),
    });
    expect(codesOf(thirdLevel)).toEqual([]);
  });

  it("首卡前只接受完整注释，注释旁的可见文字或 HTML 必须报错", () => {
    const textAfterComment = renderTopic({
      nodes: baseNodes,
      beforeFirstCard: "<!-- 注释 --> 想保留的讨论正文",
    });
    expect(codesOf(textAfterComment)).toContain("CONTENT_BEFORE_FIRST_CARD");

    const htmlAfterComment = renderTopic({
      nodes: baseNodes,
      beforeFirstCard: "<!-- x --> <div>visible</div>",
    });
    expect(codesOf(htmlAfterComment)).toContain("CONTENT_BEFORE_FIRST_CARD");

    const htmlOnly = renderTopic({ nodes: baseNodes, beforeFirstCard: "<div>visible</div>" });
    expect(codesOf(htmlOnly)).toContain("CONTENT_BEFORE_FIRST_CARD");

    const unterminated = renderTopic({ nodes: baseNodes, beforeFirstCard: "<!-- 未闭合注释" });
    expect(codesOf(unterminated)).toContain("CONTENT_BEFORE_FIRST_CARD");

    const multilineComments = renderTopic({
      nodes: baseNodes,
      beforeFirstCard: "<!-- 格式说明\n第二行 -->\n<!-- second -->",
    });
    expect(codesOf(multilineComments)).toEqual([]);

    const tightComments = renderTopic({ nodes: baseNodes, beforeFirstCard: "<!-- a --><!-- b -->" });
    expect(codesOf(tightComments)).toEqual([]);
  });

  it("空主题与无卡片文件被拒绝", () => {
    expect(codesOf("---\nschemaVersion: 1\ntopicId: " + T1 + "\ntitle: 空\nnodes: {}\n---\n")).toContain("TOPIC_EMPTY");
  });
});

describe("源码范围与换行", () => {
  it("CRLF 与补充平面字符下 offset 仍可直接切片", () => {
    const text = renderTopic({
      nodes: baseNodes,
      newline: "\r\n",
      bodyAt: (node) => (node.id === N1 ? "😀 表情与中文正文。\r\n\r\n第二段。" : node.body),
    });
    const result = parseTopicDocument(text, { path: "topics/crlf.md" });
    expect(result.document.newline).toBe("crlf");
    const topic = result.topic!;
    const first = topic.nodes[0]!;
    // 格式 1 的标题与注释范围恒存在；格式 2 才缺省。
    const heading = first.ranges.heading!;
    const comment = first.ranges.comment!;
    expect(heading).toBeDefined();
    expect(comment).toBeDefined();
    expect(text.slice(heading.start, heading.end)).toContain("## 起点");
    expect(text.slice(comment.start, comment.end)).toBe("<!-- node:" + N1 + " -->");
    expect(text.slice(first.ranges.body.start, first.ranges.body.end)).toBe(first.body);
    expect(first.body.startsWith("😀")).toBe(true);
    expect(text.slice(first.ranges.node.start, first.ranges.node.end)).toContain("😀 表情与中文正文。");

    const replaced =
      text.slice(0, first.ranges.node.start) +
      "## 新起点 <!-- node:" + N1 + " -->\r\n\r\n新的正文。\r\n\r\n" +
      text.slice(first.ranges.node.end);
    const reparsed = parseTopicDocument(replaced, { path: "topics/crlf.md" });
    expect(reparsed.ok).toBe(true);
    expect(reparsed.topic?.nodes[0]?.body).toBe("新的正文。");
    expect(reparsed.topic?.nodes[1]?.body).toBe("接着讨论。");
    expect(reparsed.document.newline).toBe("crlf");
  });

  it("摘要在 Unicode 码点边界截断", () => {
    const text = renderTopic({
      nodes: [{ ...baseNodes[0]!, body: "汉".repeat(130) }],
    });
    expect(Array.from(topicOf(text).nodes[0]!.summary)).toHaveLength(120);
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
      rootId: null,
      rootIds: [],
      topics: [],
      nodes: [],
    });
  });

  it("单根、自连、断链、多 next、同源重复 order 与非法焦点", () => {
    expect(graphCodes([renderTopic({ nodes: baseNodes })])).toEqual([]);

    const noRoot = renderTopic({ nodes: [{ ...baseNodes[0]!, flow: "next" }] });
    expect(graphCodes([noRoot])).toContain("NODE_ROOT_MISSING");

    const twoRoots = renderTopic({ nodes: [baseNodes[0]!, { ...baseNodes[1]!, flow: "root", from: null }] });
    expect(graphCodes([twoRoots])).toContain("NODE_ROOT_MULTIPLE");

    const rootFrom = renderTopic({ nodes: [{ ...baseNodes[0]!, from: N2 }] });
    expect(graphCodes([rootFrom])).toContain("NODE_ROOT_INVALID");

    const selfLink = renderTopic({ nodes: [baseNodes[0]!, { ...baseNodes[1]!, from: N2 }] });
    expect(graphCodes([selfLink])).toContain("NODE_SELF_LINK");

    const broken = renderTopic({ nodes: [baseNodes[0]!, { ...baseNodes[1]!, from: N4 }] });
    expect(graphCodes([broken])).toContain("NODE_FROM_UNKNOWN");

    const focus = renderTopic({ nodes: baseNodes });
    expect(graphCodes([focus], N4)).toContain("FOCUS_NODE_UNKNOWN");

    const twoNext = renderTopic({
      nodes: [baseNodes[0]!, baseNodes[1]!, { ...baseNodes[1]!, id: N3, title: "另一个下一张" }],
    });
    expect(graphCodes([twoNext])).toContain("NODE_NEXT_MULTIPLE");

    const duplicateOrder = renderTopic({
      nodes: [
        baseNodes[0]!,
        { id: N2, title: "左分支", body: "左。", from: N1, flow: "branch", side: "left", order: 10 },
        { id: N3, title: "右分支", body: "右。", from: N1, flow: "branch", side: "right", order: 10 },
      ],
    });
    expect(graphCodes([duplicateOrder])).toContain("NODE_BRANCH_ORDER_DUPLICATED");

    const nextSide = renderTopic({ nodes: [baseNodes[0]!, { ...baseNodes[1]!, side: "right" }] });
    expect(graphCodes([nextSide])).toContain("NODE_FLOW_FIELD_INVALID");

    const rootOrder = renderTopic({ nodes: [{ ...baseNodes[0]!, order: 10 }] });
    expect(graphCodes([rootOrder])).toContain("NODE_FLOW_FIELD_INVALID");
  });

  it("branch 省略 side／order 时仍校验通过，视图不补 side", () => {
    const text = renderTopic({
      nodes: [
        baseNodes[0]!,
        { id: N2, title: "未写侧向", body: "侧向正文。", from: N1, flow: "branch" },
        { id: N3, title: "已写侧向", body: "另一侧向。", from: N1, flow: "branch", side: "left", order: 10 },
      ],
    });
    const result = validateWorkspace({ workspace: workspaceMeta(null), topics: [topicOf(text)] });
    expect(result.ok).toBe(true);
    const branches = result.graph!.nodes.filter((node) => node.flow === "branch");
    expect(branches.map((node) => node.side)).toEqual(["left", undefined]);
    expect(branches.map((node) => node.number)).toEqual(["01-01", "01-02"]);
    expect(result.graph!.nodes.find((node) => node.id === N2)?.order).toBeUndefined();
  });

  it("缺 order 的 branch 按 node.id 稳定排序，重排 topics 输入不改变编号", () => {
    const topicA = renderTopic({
      topicId: T1,
      nodes: [
        baseNodes[0]!,
        { id: N3, title: "无 order B", body: "B。", from: N1, flow: "branch" },
      ],
    });
    const topicB = renderTopic({
      topicId: T2,
      nodes: [
        { id: N4, title: "无 order A", body: "A。", from: N1, flow: "branch" },
        { id: N2, title: "显式 order", body: "C。", from: N1, flow: "branch", order: 10 },
      ],
    });
    const forward = validateWorkspace({ workspace: workspaceMeta(null), topics: [topicOf(topicA), topicOf(topicB)] });
    const backward = validateWorkspace({ workspace: workspaceMeta(null), topics: [topicOf(topicB), topicOf(topicA)] });
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
    const cycle = renderTopic({
      nodes: [baseNodes[0]!, { ...baseNodes[1]!, from: N1 }].map((node) =>
        node.id === N1 ? { ...node, from: N2 } : node,
      ),
    });
    expect(graphCodes([cycle])).toContain("GRAPH_CYCLE");

    const orphan = renderTopic({
      nodes: [baseNodes[0]!, baseNodes[1]!, { id: N3, title: "孤立", body: "孤立。", from: null, flow: "next" }],
    });
    const orphanCodes = graphCodes([orphan]);
    expect(orphanCodes).toContain("NODE_FROM_MISSING");
    expect(orphanCodes).toContain("NODE_UNREACHABLE");
  });

  it("全图重复 ID 与跨主题 from", () => {
    const topicA = renderTopic({ topicId: T1, nodes: baseNodes });
    const duplicated = renderTopic({ topicId: T2, nodes: [baseNodes[0]!] });
    expect(graphCodes([topicA, duplicated])).toContain("NODE_ID_DUPLICATED");
    expect(graphCodes([topicA, renderTopic({ topicId: T1, nodes: [baseNodes[0]!] })])).toContain("TOPIC_ID_DUPLICATED");

    const acrossTopics = renderTopic({
      topicId: T2,
      nodes: [{ id: N3, title: "跨主题", body: "跨主题连接。", from: N2, flow: "branch", order: 10 }],
    });
    const result = validateWorkspace({
      workspace: workspaceMeta(null),
      topics: [topicOf(topicA), topicOf(acrossTopics)],
    });
    expect(result.ok).toBe(true);
    expect(result.graph?.nodes.map((node) => node.title)).toEqual(["起点", "接着", "跨主题"]);
    expect(result.graph?.nodes[2]?.number).toBe("02-01");
  });
});