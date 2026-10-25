import { describe, expect, it } from "vitest";
import {
  nodeFromV2Document,
  parseTopicDocument,
  parseV2NodeDocument,
  parseWorkspaceDocuments,
} from "../../src/core/index.js";

/**
 * 重要标记（P11）在 core 的读侧契约：
 * 格式 2 节点头可选 `important`，缺省视为 false；格式 1 没有该字段，读侧恒为 false。
 */

const NODE_ID = "n_" + "1".repeat(32);
const TOPIC_ID = "t_" + "2".repeat(32);
const CONTEXT = { topicId: TOPIC_ID, topicPath: "topics/讨论/topic.md", dir: "讨论" };

function nodeFile(extra: readonly string[] = []): string {
  return [
    "---",
    "nodeId: " + NODE_ID,
    "title: 记录的目的",
    "state: agreed",
    "from: null",
    "flow: root",
    ...extra,
    "---",
    "",
    "保留有用的思路来路。",
    "",
  ].join("\n");
}

function parsedNode(extra: readonly string[] = []) {
  const parsed = parseV2NodeDocument(nodeFile(extra), "topics/讨论/" + NODE_ID + ".md", CONTEXT);
  if (!parsed.header) throw new Error("节点头未通过：" + JSON.stringify(parsed.diagnostics));
  return nodeFromV2Document(parsed.document, parsed.header, CONTEXT);
}

describe("格式 2 的 important", () => {
  it("缺省为 false，而不是缺字段", () => {
    const node = parsedNode();
    expect(node.important).toBe(false);
  });

  it("important: true 被读成 true", () => {
    expect(parsedNode(["important: true"]).important).toBe(true);
  });

  it("显式 false 与缺省等价", () => {
    expect(parsedNode(["important: false"]).important).toBe(false);
  });

  it("非布尔值按 schema 错误拒绝", () => {
    const parsed = parseV2NodeDocument(
      nodeFile(['important: "yes"']),
      "topics/讨论/" + NODE_ID + ".md",
      CONTEXT,
    );
    expect(parsed.header).toBeUndefined();
    expect(parsed.diagnostics.some((item) => item.code === "SCHEMA_INVALID")).toBe(true);
  });

  it("未知字段仍然拒绝（不因为新增了 important 就放宽）", () => {
    const parsed = parseV2NodeDocument(
      nodeFile(["starred: true"]),
      "topics/讨论/" + NODE_ID + ".md",
      CONTEXT,
    );
    expect(parsed.header).toBeUndefined();
    const codes = parsed.diagnostics.map((item) => item.code);
    expect(codes).toContain("SCHEMA_UNKNOWN_FIELD");
  });
});

describe("格式 1 的 important", () => {
  it("读侧恒为 false，不新增写入口", () => {
    const text = [
      "---",
      "schemaVersion: 1",
      "topicId: " + TOPIC_ID,
      "title: 条目整理",
      "nodes:",
      "  " + NODE_ID + ":",
      "    from: null",
      "    flow: root",
      "    state: agreed",
      "---",
      "",
      "## 记录的目的 <!-- node:" + NODE_ID + " -->",
      "",
      "保留有用的思路来路。",
      "",
    ].join("\n");
    const parsed = parseTopicDocument(text, { path: "topics/topic.md" });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.topic?.nodes[0]?.important).toBe(false);
  });
});

describe("important 不影响结构与编号", () => {
  const workspace = { schemaVersion: 2 as const, workspaceId: "w_important", name: "重要标记", activeNode: null };
  const rootId = "n_" + "8".repeat(32);
  const childId = "n_" + "9".repeat(32);

  function documents(): Parameters<typeof parseWorkspaceDocuments>[0]["documents"] {
    const file = (lines: readonly string[], body: string): string =>
      ["---", ...lines, "---", "", body, ""].join("\n");
    return [
      { path: "topics/标记/topic.md", text: "---\ntopicId: " + TOPIC_ID + "\ntitle: 标记\n---\n" },
      {
        path: "topics/标记/" + rootId + ".md",
        text: file(
          ["nodeId: " + rootId, "title: 根节点", "state: agreed", "from: null", "flow: root"],
          "根节点正文。",
        ),
      },
      {
        path: "topics/标记/" + childId + ".md",
        text: file(
          [
            "nodeId: " + childId,
            "title: 子节点",
            "state: proposed",
            "from: " + rootId,
            "flow: next",
            "description: 从根节点继续",
            "important: true",
          ],
          "子节点正文。",
        ),
      },
    ];
  }

  it("只是多一个标记：编号、来源与连接类型都不变", () => {
    const result = parseWorkspaceDocuments({ workspace, documents: documents() });
    if (!result.ok || !result.graph) {
      throw new Error("工作区未通过：" + JSON.stringify(result.diagnostics));
    }
    const child = result.graph.nodes.find((node) => node.id === childId)!;
    expect(child.important).toBe(true);
    expect(child.number).toBe("02");
    expect(child.from).toBe(rootId);
    expect(child.flow).toBe("next");
    expect(result.graph.nodes.find((node) => node.id === rootId)!.important).toBe(false);
  });
});
