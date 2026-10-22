import { describe, expect, it } from "vitest";
import { parseTopicDocument } from "../../src/core/index.js";

const N1 = "n_00000000000000000000000000000001";
const N2 = "n_00000000000000000000000000000002";

const TEMPLATE = [
  "---",
  "schemaVersion: 1",
  "topicId: t_00000000000000000000000000000001",
  "title: LF 主题",
  "nodes:",
  "  " + N1 + ":",
  "    from: null",
  "    flow: root",
  "    state: agreed",
  "  " + N2 + ":",
  "    from: " + N1,
  "    flow: next",
  "    state: agreed",
  "---",
  "",
  "## 先有想法 <!-- node:" + N1 + " -->",
  "",
  "第一段正文。",
  "",
  "## 后来补充 <!-- node:" + N2 + " -->",
  "",
  "第二段正文。",
  "",
];

describe("BOM 与文件头", () => {
  it("带 BOM 的 UTF-8 文件仍可解析，范围落在 BOM 之后", () => {
    const text = "\uFEFF" + TEMPLATE.join("\n");
    const result = parseTopicDocument(text, { path: "topics/bom.md" });
    expect(result.ok).toBe(true);
    expect(result.document.bom).toBe(true);
    const first = result.topic!.nodes[0]!;
    // 格式 1 的标题范围恒存在；ranges.heading 在格式 2 才缺省。
    const heading = first.ranges.heading!;
    expect(heading).toBeDefined();
    expect(text.slice(heading.start, heading.end)).toBe("## 先有想法 <!-- node:" + N1 + " -->");
    expect(heading.start).toBeGreaterThan(0);
  });
});

describe("同一份内容的不同换行", () => {
  it("LF 与 CRLF 解析出相同结构与正文，范围各自对应原文", () => {
    const lf = TEMPLATE.join("\n");
    const crlf = TEMPLATE.join("\r\n");
    const fromLf = parseTopicDocument(lf, { path: "topics/lf.md" });
    const fromCrlf = parseTopicDocument(crlf, { path: "topics/crlf.md" });
    expect(fromLf.ok).toBe(true);
    expect(fromCrlf.ok).toBe(true);
    expect(fromLf.document.newline).toBe("lf");
    expect(fromCrlf.document.newline).toBe("crlf");
    expect(fromCrlf.document.text).toBe(crlf);

    const shape = (text: string, parsed: typeof fromLf) =>
      parsed.topic!.nodes.map((node) => ({
        title: node.title,
        body: text.slice(node.ranges.body.start, node.ranges.body.end),
        heading: text.slice(node.ranges.heading!.start, node.ranges.heading!.end),
        block: text.slice(node.ranges.node.start, node.ranges.node.end).replace(/\r\n/g, "\n"),
      }));

    expect(shape(lf, fromLf)).toEqual(shape(crlf, fromCrlf));
    const lastCrlfBlock = crlf.slice(
      fromCrlf.topic!.nodes[1]!.ranges.node.start,
      fromCrlf.topic!.nodes[1]!.ranges.node.end,
    );
    expect(lastCrlfBlock.endsWith("\r\n")).toBe(true);
    expect(lastCrlfBlock).toContain("第二段正文。\r\n");
    const crlfBody = crlf.slice(
      fromCrlf.topic!.nodes[0]!.ranges.body.start,
      fromCrlf.topic!.nodes[0]!.ranges.body.end,
    );
    expect(crlfBody).toBe("第一段正文。");
    expect(crlfBody).not.toContain("\r");
  });
});