import { describe, expect, it } from "vitest";
import { nodeFromDocument, parseNodeDocument } from "../../src/core/index.js";
import { detectLineEnding, normalizeNewlines } from "../../src/core/newlines.js";

const NODE_ID = "n_00000000000000000000000000000001";
const TOPIC_ID = "t_00000000000000000000000000000001";
const CONTEXT = { topicId: TOPIC_ID, topicPath: "topics/演示/topic.md", dir: "演示" };
const PATH = "topics/演示/" + NODE_ID + ".md";

function nodeTemplate(): string[] {
  return [
    "---",
    "nodeId: " + NODE_ID,
    "title: 先有想法",
    "state: agreed",
    "from: null",
    "flow: root",
    "---",
    "",
    "第一段正文。",
    "",
  ];
}

function parse(text: string) {
  const result = parseNodeDocument(text, PATH, CONTEXT);
  if (!result.header || result.diagnostics.length > 0) {
    throw new Error("节点文件未通过解析：" + JSON.stringify(result.diagnostics));
  }
  return nodeFromDocument(result.document, result.header, CONTEXT);
}

describe("BOM 与文件头", () => {
  it("带 BOM 的 UTF-8 文件仍可解析，范围落在 BOM 之后", () => {
    const text = "﻿" + nodeTemplate().join("\n");
    const parsed = parseNodeDocument(text, PATH, CONTEXT);
    expect(parsed.document.bom).toBe(true);
    const node = parse(text);
    expect(node.ranges.node).toEqual({ start: 0, end: text.length });
    expect(node.ranges.body.start).toBeGreaterThan(1);
    expect(text.slice(node.ranges.body.start, node.ranges.body.end)).toBe("第一段正文。");
  });
});

describe("换行 helper", () => {
  it("normalizeNewlines 先统一为 LF，再转换成目标换行", () => {
    const mixed = "a\r\nb\rc\nd";
    expect(normalizeNewlines(mixed, "\n")).toBe("a\nb\nc\nd");
    expect(normalizeNewlines(mixed, "\r\n")).toBe("a\r\nb\r\nc\r\nd");
    expect(normalizeNewlines("a\nb", "\r\n")).toBe("a\r\nb");
  });

  it("detectLineEnding 只在出现 CRLF 时选 CRLF，其余按 LF", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\n")).toBe("\n");
    // 单独 CR 与无换行文本都回退到 LF；裸 CR 不构成换行事实。
    expect(detectLineEnding("a\rb")).toBe("\n");
    expect(detectLineEnding("a")).toBe("\n");
  });
});

describe("同一份内容的不同换行", () => {
  it("LF 与 CRLF 解析出相同结构与正文，范围各自对应原文", () => {
    const lf = nodeTemplate().join("\n");
    const crlf = nodeTemplate().join("\r\n");
    const fromLf = parseNodeDocument(lf, PATH, CONTEXT);
    const fromCrlf = parseNodeDocument(crlf, PATH, CONTEXT);
    expect(fromLf.diagnostics).toEqual([]);
    expect(fromCrlf.diagnostics).toEqual([]);
    expect(fromLf.document.newline).toBe("lf");
    expect(fromCrlf.document.newline).toBe("crlf");
    expect(fromCrlf.document.text).toBe(crlf);

    const shape = (text: string, parsed: typeof fromLf) => {
      if (!parsed.header) throw new Error("缺少节点头");
      const node = nodeFromDocument(parsed.document, parsed.header, CONTEXT);
      return {
        title: node.title,
        body: text.slice(node.ranges.body.start, node.ranges.body.end),
        block: text.slice(node.ranges.node.start, node.ranges.node.end).replace(/\r\n/g, "\n"),
      };
    };

    expect(shape(lf, fromLf)).toEqual(shape(crlf, fromCrlf));
    expect(fromLf.header).toBeDefined();
    if (!fromLf.header || !fromCrlf.header) throw new Error("缺少节点头");
    const lfNode = nodeFromDocument(fromLf.document, fromLf.header, CONTEXT);
    const crlfNode = nodeFromDocument(fromCrlf.document, fromCrlf.header, CONTEXT);
    expect(lfNode.body).toBe("第一段正文。");
    expect(crlfNode.body).toBe("第一段正文。");
    expect(crlfNode.body).not.toContain("\r");
    expect(crlf.slice(crlfNode.ranges.node.start, crlfNode.ranges.node.end)).toBe(crlf);
  });
});
