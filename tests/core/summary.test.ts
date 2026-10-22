import { describe, expect, it } from "vitest";
import {
  collapseWhitespace,
  formatDiagnostic,
  parseTopicDocument,
  plainText,
  truncateSummary,
} from "../../src/core/index.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "workspace");

describe("纯文本与摘要工具", () => {
  it("跳过图片与 HTML，折叠空白并处理链接文字", () => {
    const tree = {
      type: "paragraph",
      children: [
        { type: "text", value: "前文 " },
        { type: "emphasis", children: [{ type: "text", value: "强调" }] },
        { type: "inlineCode", value: "code" },
        { type: "image", url: "x.png", alt: "图" },
        { type: "html", value: "<span>x</span>" },
        { type: "link", url: "#", children: [{ type: "text", value: "链接" }] },
      ],
    };
    expect(collapseWhitespace(plainText(tree))).toBe("前文 强调code链接");
    expect(truncateSummary("一二三四", 2)).toBe("一二");
    expect(truncateSummary("一二", 5)).toBe("一二");
  });

  it("诊断格式化包含位置与节点", () => {
    const result = parseTopicDocument(
      readFileSync(join(fixtureRoot, "topics", "协作方式.md"), "utf8"),
      { path: "topics/协作方式.md" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(formatDiagnostic({
      code: "NODE_FROM_UNKNOWN",
      message: "断链",
      topicPath: "topics/x.md",
      nodeId: "n_00000000000000000000000000000001",
      range: { start: 3, end: 9 },
    })).toBe(
      "NODE_FROM_UNKNOWN topics/x.md node=n_00000000000000000000000000000001 @3-9: 断链",
    );
  });
});
