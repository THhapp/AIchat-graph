import { describe, expect, it } from "vitest";
import { parseTopicDocument, validateWorkspace } from "../../src/core/index.js";
import { buildIndex, searchIndex, isIndexManifest, MAX_QUERY_LENGTH } from "../../src/index/index.js";

const N = (n: number): string => "n_" + String(n).padStart(32, "0");
const T = "t_" + "0".repeat(31) + "1";

function topic(): string {
  return [
    "---",
    "schemaVersion: 1",
    "topicId: " + T,
    "title: 条目整理",
    "nodes:",
    "  " + N(1) + ":",
    "    from: null",
    "    flow: root",
    "    state: agreed",
    "  " + N(2) + ":",
    "    from: " + N(1),
    "    flow: next",
    "    state: proposed",
    "  " + N(3) + ":",
    "    from: " + N(1),
    "    flow: branch",
    "    side: right",
    "    order: 10",
    "    state: reference",
    "---",
    "",
    "## 整理约定 <!-- node:" + N(1) + " -->",
    "",
    "默认更新现有条目。",
    "",
    "## 条目整理 <!-- node:" + N(2) + " -->",
    "",
    "按主题归档，避免复述整段资料。",
    "",
    "## 背景资料 <!-- node:" + N(3) + " -->",
    "",
    "这里提一句整理约定的历史。",
    "",
    "补充说明只在正文出现的线索。",
    "",
  ].join("\n");
}

function build(): ReturnType<typeof buildIndex> {
  const text = topic();
  const parsed = parseTopicDocument(text, { path: "topics/topic.md" });
  if (!parsed.ok || !parsed.topic) throw new Error("fixture invalid");
  const validation = validateWorkspace({
    workspace: { schemaVersion: 1, workspaceId: "w_test", name: "test", activeNode: N(2) },
    topics: [parsed.topic],
  });
  if (!validation.ok || !validation.graph) throw new Error("graph invalid");
  return buildIndex({
    workspaceId: "w_test",
    graph: validation.graph,
    topics: [
      {
        topicId: T,
        title: parsed.topic.title,
        path: "topics/topic.md",
        fileHash: "a".repeat(64),
        raw: text,
        nodes: parsed.topic.nodes,
      },
    ],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("索引 manifest", () => {
  it("保存结构、反向引用与文件哈希，不保存正文", () => {
    const { manifest } = build();
    expect(manifest.workspaceId).toBe("w_test");
    expect(manifest.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(manifest.fileHashes).toEqual({ "topics/topic.md": "a".repeat(64) });
    expect(manifest.topics).toEqual([
      {
        topicId: T,
        title: "条目整理",
        path: "topics/topic.md",
        fileHash: "a".repeat(64),
        sourcePaths: ["topics/topic.md"],
        fileHashes: { "topics/topic.md": "a".repeat(64) },
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
    // manifest 只带摘要，不整个正文：只出现在正文段落里的文字不应出现。
    expect(JSON.stringify(manifest)).not.toContain("补充说明只在正文出现的线索");
    expect(isIndexManifest(manifest, "w_test")).toBe(true);
    expect(isIndexManifest(manifest, "w_other")).toBe(false);
    expect(isIndexManifest({ ...manifest, format: 99 }, "w_test")).toBe(false);
  });
});

describe("检索排序与范围", () => {
  it("标题精确优先于标题包含、摘要、正文", () => {
    const { search } = build();
    const exact = searchIndex(search, "条目整理");
    expect(exact.hits[0]).toMatchObject({ nodeId: N(2), field: "title", path: "topics/topic.md" });
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
    expect(searchIndex(search, "   ")).toEqual({ hits: [], truncated: false });

    // 超长查询直接拒绝，由接口映射 400。
    expect(() => searchIndex(search, "字".repeat(MAX_QUERY_LENGTH + 1))).toThrow(
      /搜索关键词过长/,
    );
  });
});