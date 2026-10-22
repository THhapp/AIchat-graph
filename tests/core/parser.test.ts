import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveSummary,
  formatDiagnostic,
  getNodeById,
  nextBranchOrder,
  parseTopicDocument,
  validateWorkspace,
  type ParsedTopic,
  type WorkspaceGraph,
  type WorkspaceMeta,
} from "../../src/core/index.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "workspace");

function readFixture(relativePath: string): string {
  return readFileSync(join(fixtureRoot, ...relativePath.split("/")), "utf8");
}

function parsed(relativePath: string): ParsedTopic {
  const result = parseTopicDocument(readFixture(relativePath), { path: relativePath });
  if (!result.ok || !result.topic) {
    throw new Error(
      "fixture 未通过解析：" + result.diagnostics.map((item) => formatDiagnostic(item)).join(" | "),
    );
  }
  return result.topic;
}

const workspace: WorkspaceMeta = JSON.parse(readFixture("workspace.json")) as WorkspaceMeta;
const topicPaths = ["topics/协作方式.md", "topics/记录的分寸.md"];

function buildGraph(): WorkspaceGraph {
  const result = validateWorkspace({ workspace, topics: topicPaths.map(parsed) });
  if (!result.ok || !result.graph) {
    throw new Error("fixture 未通过校验：" + result.diagnostics.map((item) => formatDiagnostic(item)).join(" | "));
  }
  return result.graph;
}

describe("真实讨论样例：解析", () => {
  it("识别多卡片、状态与正文", () => {
    const topic = parsed("topics/协作方式.md");
    expect(topic.title).toBe("资料整理的方法");
    expect(topic.nodes).toHaveLength(12);
    expect(topic.nodes[0]?.title).toBe("整理目标");
    expect(topic.nodes[0]?.state).toBe("agreed");
    expect(topic.nodes[0]?.body).toBe(
      "把分散的资料收进一处可回查的记录，便于复核来源、理清顺序，并在需要时继续补充。整理后的条目应保持统一的结构。",
    );
    const mixed = topic.nodes.find((node) => node.title === "模板方案与准备材料");
    expect(mixed?.state).toBe("proposed");
    expect(mixed?.body).toContain("实现载体尚可重新选择");
    const reference = parsed("topics/记录的分寸.md").nodes.find(
      (node) => node.title === "有选择地保留修订",
    );
    expect(reference?.state).toBe("proposed");
    expect(reference?.body).toContain("旧观点如何呈现，尚待讨论");
  });

  it("摘要显式优先，否则取正文首段并截断", () => {
    const topic = parsed("topics/协作方式.md");
    const explicit = topic.nodes.find((node) => node.title === "独立清单的设计思路");
    expect(explicit?.summaryExplicit).toBe(true);
    expect(explicit?.summary).toBe("仅有设计笔记，尚无独立实现");
    const derived = topic.nodes.find((node) => node.title === "记录的取舍");
    expect(derived).toBeUndefined();
    const again = parsed("topics/记录的分寸.md").nodes[0];
    expect(again?.summary).toBe(again?.body.slice(0, again?.summary.length));
    const long = deriveSummary([
      { type: "paragraph", children: [{ type: "text", value: "😀".repeat(200) }] },
    ]);
    expect(Array.from(long)).toHaveLength(120);
    expect(Array.from(long).every((char) => char === "😀")).toBe(true);
  });

  it("源码范围可直接切片且包含注释、正文与整块", () => {
    const text = readFixture("topics/协作方式.md");
    const topic = parsed("topics/协作方式.md");
    const node = topic.nodes[4]!;
    expect(text.slice(node.ranges.node.start, node.ranges.node.end)).toContain(
      "## 记录的用途 <!-- node:" + node.id,
    );
    expect(text.slice(node.ranges.title!.start, node.ranges.title!.end)).toBe("记录的用途");
    // 格式 1 的注释与 H2 范围恒存在；格式 2 才显式缺省。
    const comment = node.ranges.comment!;
    const heading = node.ranges.heading!;
    expect(comment).toBeDefined();
    expect(heading).toBeDefined();
    expect(text.slice(comment.start, comment.end)).toBe("<!-- node:" + node.id + " -->");
    expect(text.slice(node.ranges.body.start, node.ranges.body.end)).toBe(node.body);
    expect(node.ranges.node.start).toBe(heading.start);
    expect(heading.end).toBeLessThan(node.ranges.body.start);
    const last = topic.nodes[topic.nodes.length - 1]!;
    expect(last.ranges.node.end).toBe(text.length);
  });
});

describe("真实讨论样例：连接与编号", () => {
  it("06 的 next 仍是 07，06-03 侧向进入并拥有自己的 next 与三级分支", () => {
    const graph = buildGraph();
    const byTitle = (title: string) => {
      const node = graph.nodes.find((item) => item.title === title);
      if (!node) throw new Error("缺少节点：" + title);
      return node;
    };
    const canvas = byTitle("排版约定");
    const globalNext = byTitle("参考外部规范");
    const reuse = byTitle("跨批次沿用约定");
    const titleSplit = byTitle("标题与标注的分工");
    const localNext = byTitle("分支内的层级编号");
    const skill = byTitle("模板方案与准备材料");
    const design = byTitle("独立清单的设计思路");

    expect(canvas.number).toBe("06");
    expect(globalNext.number).toBe("07");
    expect(canvas.nextId).toBe(globalNext.id);
    expect(globalNext.from).toBe(canvas.id);

    expect(titleSplit.number).toBe("06-01");
    expect(localNext.number).toBe("06-02");
    expect(titleSplit.from).toBe(canvas.id);
    expect(titleSplit.flow).toBe("branch");
    expect(localNext.from).toBe(titleSplit.id);
    expect(localNext.flow).toBe("next");

    expect(reuse.number).toBe("06-03");
    expect(reuse.from).toBe(canvas.id);
    expect(reuse.flow).toBe("branch");
    expect(canvas.branchIds).toEqual([titleSplit.id, reuse.id]);

    expect(skill.number).toBe("06-03-01");
    expect(reuse.nextId).toBeNull();
    expect(reuse.branchIds).toEqual([skill.id]);
    expect(design.number).toBe("06-03-02");
    expect(design.from).toBe(skill.id);
    expect(design.flow).toBe("next");
    expect(skill.nextId).toBe(design.id);
  });

  it("协作方式.md 是自足子图，可单独作为合法 topic 读取", () => {
    const alone = validateWorkspace({
      workspace,
      topics: [parsed("topics/协作方式.md")],
    });
    expect(alone.ok).toBe(true);
    expect(alone.graph?.rootId).toBe("n_6fe284797b7d4f249440c5e8596f715d");
    // workspace.json 的 activeNode 也在这份主题里，因此单独复制一份主题即可读取。
    expect(alone.graph?.nodes.map((node) => node.number)).toEqual([
      "01", "02", "03", "04", "05", "06", "06-01", "06-02", "06-03", "06-03-01", "06-03-02", "07",
    ]);
    const recordOnly = validateWorkspace({
      workspace: { ...workspace, activeNode: null },
      topics: [parsed("topics/记录的分寸.md")],
    });
    // 记录的分寸.md 的 from 指向另一主题的 05，单独读取会报断链；它与 协作方式.md 一起才完整。
    expect(recordOnly.ok).toBe(false);
    expect(recordOnly.diagnostics.map((item) => item.code)).toContain("NODE_FROM_UNKNOWN");
  });

  it("全部主题合起来时每个节点有编号，且分支 order 缺省也可确定", () => {
    const graph = buildGraph();
    const titles = graph.nodes.map((node) => node.title);
    expect(titles).toContain("记录的取舍");
    expect(titles).toContain("有选择地保留修订");
    expect(graph.nodes.every((node) => /^\d{2}(-\d{2})*$/.test(node.number))).toBe(true);
    const reuse = graph.nodes.find((node) => node.title === "跨批次沿用约定");
    expect(reuse?.side).toBe("left");
    const skill = graph.nodes.find((node) => node.title === "模板方案与准备材料");
    expect(skill?.side).toBe("left");
    expect(skill?.order).toBe(10);
  });

  it("跨主题 from 合法，记录的分寸进入同一棵树", () => {
    const graph = buildGraph();
    const record = getNodeById(graph, "n_ac6022c7b25c40c7bd5f849bf6cd36ef");
    expect(record?.number).toBe("05-01");
    expect(record?.topicId).toBe("t_64e917c597fb4da4abd5467512fab596");
    expect(record?.from).toBe("n_ac2bde709333407bbdb49003bc22ba87");
    expect(graph.nodes.find((node) => node.id === record?.from)?.topicId).not.toBe(record?.topicId);
    // 与 06-01 → 06-02 同一规则：分支边界内的 next 继续该层序号。
    expect(getNodeById(graph, "n_0d2f6687895d435f8bd389558b0820f3")?.number).toBe("05-02");
    expect(getNodeById(graph, "n_92e5c04cafd54799bf296cb3689b5c0a")?.number).toBe("05-01-01");
    expect(graph.activeNode).toBe("n_1815f87dbd6a40ce9a0745db4cf5345d");
  });

  it("编号确定、唯一、不含源码；重排输入顺序不影响结果", () => {
    const first = buildGraph();
    const second = buildGraph();
    expect(first.nodes.map((node) => node.number)).toEqual(second.nodes.map((node) => node.number));
    const numbers = first.nodes.map((node) => node.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.slice(0, 12)).toEqual([
      "01", "02", "03", "04", "05", "05-01", "05-01-01", "05-02", "06", "06-01", "06-02", "06-03",
    ].sort((a, b) => {
      const left = a.split("-").map(Number);
      const right = b.split("-").map(Number);
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const diff = (left[index] ?? -1) - (right[index] ?? -1);
        if (diff !== 0) return diff;
      }
      return 0;
    }));
    for (const path of topicPaths) {
      const text = readFixture(path);
      for (const node of first.nodes.filter((item) => item.topicPath === path)) {
        expect(text).not.toContain(node.number + " · " + node.title);
      }
    }
    const reversed = validateWorkspace({ workspace, topics: [...topicPaths].reverse().map(parsed) });
    expect(reversed.graph?.nodes.map((node) => node.number)).toEqual(numbers);
    expect(nextBranchOrder([10, 20])).toBe(30);
    expect(nextBranchOrder([])).toBe(10);
  });
});