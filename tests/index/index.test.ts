import { describe, expect, it } from "vitest";
import { parseWorkspaceDocuments, type WorkspaceDocument, type WorkspaceMeta } from "../../src/core/index.js";
import { buildIndex, searchIndex, searchDocuments, MAX_QUERY_LENGTH } from "../../src/index/index.js";
import type { SearchDocument } from "../../src/index/index.js";

const N = (n: number): string => "n_" + String(n).padStart(32, "0");
const T = "t_" + "0".repeat(31) + "1";
const DIR = "topic";
const META_PATH = "topics/" + DIR + "/topic.md";

function nodeFile(id: number, title: string, from: string, flow: string, body: string, extra: string[] = []): string {
  return [
    "---",
    "nodeId: " + N(id),
    "title: " + title,
    "state: " + (flow === "root" ? "agreed" : flow === "next" ? "proposed" : "reference"),
    "from: " + from,
    "flow: " + flow,
    ...extra,
    "---",
    "",
    ...body.split("\n"),
    "",
  ].join("\n");
}

function documentsFixture(): WorkspaceDocument[] {
  return [
    {
      path: META_PATH,
      text: ["---", "topicId: " + T, "title: 条目整理", "---", ""].join("\n"),
    },
    {
      path: "topics/" + DIR + "/" + N(1) + ".md",
      text: nodeFile(1, "整理约定", "null", "root", "默认更新现有条目。"),
    },
    {
      path: "topics/" + DIR + "/" + N(2) + ".md",
      text: nodeFile(2, "条目整理", N(1), "next", "按主题归档，避免复述整段资料。", [
        "description: 沿主链继续",
      ]),
    },
    {
      path: "topics/" + DIR + "/" + N(3) + ".md",
      text: nodeFile(
        3,
        "背景资料",
        N(1),
        "branch",
        "这里提一句整理约定的历史。\n\n补充说明只在正文出现的线索。",
        ["description: 从根展开背景", "side: right", "order: 10"],
      ),
    },
  ];
}

function build(): ReturnType<typeof buildIndex> {
  const documents = documentsFixture();
  const workspace: WorkspaceMeta = {
    schemaVersion: 2,
    workspaceId: "w_test",
    name: "test",
    activeNode: N(2),
  };
  const parsed = parseWorkspaceDocuments({ workspace, documents });
  if (!parsed.ok || !parsed.graph) throw new Error("fixture invalid");
  const fileHashes: Record<string, string> = {};
  for (const document of documents) fileHashes[document.path] = "a".repeat(64);
  return buildIndex({
    workspaceId: "w_test",
    graph: parsed.graph,
    topics: parsed.topics.map((topic) => ({
      topicId: topic.topicId,
      path: topic.document.path,
      fileHash: "a".repeat(64),
      nodes: topic.nodes,
      sourcePaths: topic.sourcePaths,
      fileHashes,
    })),
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("索引 manifest", () => {
  it("保存结构、反向引用与文件哈希，不保存正文", () => {
    const { manifest } = build();
    expect(manifest.workspaceId).toBe("w_test");
    expect(manifest.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(manifest.fileHashes).toEqual({
      [META_PATH]: "a".repeat(64),
      ["topics/" + DIR + "/" + N(1) + ".md"]: "a".repeat(64),
      ["topics/" + DIR + "/" + N(2) + ".md"]: "a".repeat(64),
      ["topics/" + DIR + "/" + N(3) + ".md"]: "a".repeat(64),
    });
    expect(manifest.topics).toEqual([
      {
        topicId: T,
        title: "条目整理",
        path: META_PATH,
        fileHash: "a".repeat(64),
        sourcePaths: [
          META_PATH,
          "topics/" + DIR + "/" + N(1) + ".md",
          "topics/" + DIR + "/" + N(2) + ".md",
          "topics/" + DIR + "/" + N(3) + ".md",
        ],
        fileHashes: {
          [META_PATH]: "a".repeat(64),
          ["topics/" + DIR + "/" + N(1) + ".md"]: "a".repeat(64),
          ["topics/" + DIR + "/" + N(2) + ".md"]: "a".repeat(64),
          ["topics/" + DIR + "/" + N(3) + ".md"]: "a".repeat(64),
        },
        nodeIds: [N(1), N(2), N(3)],
      },
    ]);
    // 编号是派生展示顺序：主链 01 → 侧枝 01-01 → 下一个纵向 02。
    expect(manifest.nodes.map((node) => node.number)).toEqual(["01", "01-01", "02"]);
    // links 按派生编号顺序排列：01 → 01-01（branch）→ 02（next）。
    expect(manifest.links).toEqual([
      { from: N(1), to: N(3), flow: "branch" },
      { from: N(1), to: N(2), flow: "next" },
    ]);
    expect([...(manifest.backlinks[N(1)] ?? [])].sort()).toEqual([N(2), N(3)].sort());
    expect(manifest.roots).toEqual([N(1)]);
    // manifest 只带摘要，不整个正文：只出现在正文第二段的文字不应出现。
    expect(JSON.stringify(manifest)).not.toContain("补充说明只在正文出现的线索");
  });
});

describe("检索排序与范围", () => {
  it("标题精确优先于标题包含、摘要、正文", () => {
    const { search } = build();
    const exact = searchIndex(search, "条目整理");
    expect(exact.hits[0]).toMatchObject({ nodeId: N(2), field: "title", path: "topics/" + DIR + "/" + N(2) + ".md" });
    expect(exact.truncated).toBe(false);

    const partial = searchIndex(search, "整理约定");
    expect(partial.hits[0]).toMatchObject({ nodeId: N(1), field: "title" });
    // 第二命中来自摘要（摘要默认取自正文首段），不是正文兜底。
    expect(partial.hits.map((hit) => hit.field)).toEqual(["title", "summary"]);

    // 摘要默认取正文首段；要命中"仅正文"必须匹配首段之后的文字。
    const bodyOnly = searchIndex(search, "线索");
    expect(bodyOnly.hits).toEqual([
      expect.objectContaining({ nodeId: N(3), field: "body", snippet: expect.stringContaining("线索") }),
    ]);

    const summaryOnly = searchIndex(search, "条目整理");
    expect(summaryOnly.hits.every((hit) => hit.field === "title")).toBe(true);

    // 空查询返回空结果，不返回整库。
    expect(searchIndex(search, "   ")).toEqual({ hits: [], totalHits: 0, truncated: false });

    // 超长查询直接拒绝，由接口映射 400。
    expect(() => searchIndex(search, "字".repeat(MAX_QUERY_LENGTH + 1))).toThrow(
      /搜索关键词过长/,
    );
  });
});

describe("searchDocuments 窗口", () => {
  it("offset/limit 切片、totalHits 与 truncated", () => {
    const { search } = build();
    const all = searchDocuments(search.documents, "整理");
    expect(all.totalHits).toBe(3);
    expect(all.hits.map((hit) => hit.nodeId)).toEqual([N(1), N(2), N(3)]);
    expect(all.truncated).toBe(false);

    const second = searchDocuments(search.documents, "整理", { offset: 1, limit: 1 });
    expect(second.totalHits).toBe(3);
    expect(second.hits.map((hit) => hit.nodeId)).toEqual([N(2)]);
    expect(second.truncated).toBe(true);

    const tail = searchDocuments(search.documents, "整理", { offset: 1 });
    expect(tail.hits.map((hit) => hit.nodeId)).toEqual([N(2), N(3)]);
    expect(tail.truncated).toBe(false);

    const beyond = searchDocuments(search.documents, "整理", { offset: 3, limit: 10 });
    expect(beyond.hits).toEqual([]);
    expect(beyond.totalHits).toBe(3);
    expect(beyond.truncated).toBe(false);

    expect(searchDocuments(search.documents, "   ")).toEqual({
      hits: [],
      totalHits: 0,
      truncated: false,
    });
  });

  it("searchIndex 默认最多返回 50 条", () => {
    const documents: SearchDocument[] = Array.from({ length: 60 }, (_, index) => ({
      id: N(index + 1),
      topicId: T,
      title: "批量命中",
      summary: "",
      number: String(index + 1),
      path: `topics/topic/${index + 1}.md`,
      body: "批量命中",
    }));
    const outcome = searchIndex({ format: 1, workspaceId: "w_test", documents }, "批量命中");
    expect(outcome.hits).toHaveLength(50);
    expect(outcome.totalHits).toBe(60);
    expect(outcome.truncated).toBe(true);
  });
});
