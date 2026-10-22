import { describe, expect, it } from "vitest";
import {
  DEFAULT_READ_LENGTH,
  MAX_READ_SEGMENT,
  locateSection,
  normalizeLength,
  sliceBody,
} from "../../src/core/index.js";

const FENCE = String.fromCharCode(96, 96, 96);

describe("章节定位基于 AST", () => {
  it("围栏代码块里的伪标题不算章节", () => {
    const text = [
      "# 顶层说明",
      "",
      "正文。",
      "",
      FENCE + "md",
      "# 不是章节",
      FENCE,
      "",
      "~~~",
      "# 也不是章节",
      "~~~",
      "",
      "## 真正的章节",
      "",
      "内容。",
    ].join("\n");
    const found = locateSection(text, "真正的章节");
    expect(found.level).toBe(2);
    expect(found.index).toBe(0);
    expect(text.slice(found.start, found.start + 2)).toBe("##");
    expect(text.slice(found.start)).toContain("真正的章节");
    expect(() => locateSection(text, "不是章节")).toThrow(RangeError);
    expect(() => locateSection(text, "也不是章节")).toThrow(RangeError);
  });

  it("重名标题必须显式指定第几个，且 index 指同名序号", () => {
    const text = ["# 背景", "", "## 细节", "", "第一处", "", "## 其它", "", "## 细节", "", "第二处"].join("\n");
    expect(() => locateSection(text, "细节")).toThrow(/出现 2 次/);
    const first = locateSection(text, "细节", 0);
    const second = locateSection(text, "细节", 1);
    expect(first.start).toBeLessThan(second.start);
    expect(text.slice(second.start, second.start + 5)).toBe("## 细节");
    expect(text.slice(second.start, second.start + 2)).toBe("##");
    expect(text.slice(second.start)).toContain("第二处");
    expect(() => locateSection(text, "细节", 2)).toThrow(/超出范围/);
    expect(() => locateSection(text, "细节", -1)).toThrow(RangeError);
    expect(() => locateSection(text, "不存在的章节")).toThrow(/没有标题/);
  });

  it("标题里的行内标记与 HTML 不参与匹配", () => {
    const text = "## \u7ec6\u8282 **重点** " + "<!-- x -->" + "\n\n正文。\n";
    const found = locateSection(text, "\u7ec6\u8282 重点");
    expect(found.level).toBe(2);
    expect(found.start).toBe(0);
  });
});

describe("有界切片", () => {
  const body = "第一段。\n\n第二段，包含 😀 表情。\n\n第三段。";

  it("默认长度、上限与非法长度", () => {
    expect(normalizeLength(undefined)).toBe(DEFAULT_READ_LENGTH);
    expect(normalizeLength(1)).toBe(1);
    expect(normalizeLength(MAX_READ_SEGMENT + 1000)).toBe(MAX_READ_SEGMENT);
    expect(() => normalizeLength(0)).toThrow(RangeError);
    expect(() => normalizeLength(1.5)).toThrow(RangeError);
  });

  it("从中间读到结尾也标记 truncated", () => {
    const fromMiddle = sliceBody(body, { start: 5, length: MAX_READ_SEGMENT });
    expect(fromMiddle.range.start).toBe(5);
    expect(fromMiddle.range.end).toBe(body.length);
    expect(fromMiddle.truncated).toBe(true);
    expect(fromMiddle.text).toBe(body.slice(5));

    const whole = sliceBody(body, { full: true });
    expect(whole.range).toEqual({ start: 0, end: body.length, total: body.length, unit: "utf16" });
    expect(whole.truncated).toBe(false);

    const tail = sliceBody(body, { start: body.length - 3, full: true });
    expect(tail.truncated).toBe(true);
    expect(tail.text).toBe(body.slice(body.length - 3));
  });

  it("不切断代理对，range 仍是 UTF-16", () => {
    const emojiIndex = body.indexOf("\u{1F600}");
    const lowHalf = emojiIndex + 1;
    const cutInside = sliceBody(body, { start: lowHalf, length: 4 });
    expect(cutInside.range.start).toBe(emojiIndex);
    expect(cutInside.text.startsWith("\u{1F600}")).toBe(true);
    expect(cutInside.range.total).toBe(body.length);
    expect(cutInside.range.unit).toBe("utf16");

    const endInside = emojiIndex + 1;
    const prefix = sliceBody(body, { start: 0, length: endInside });
    expect(prefix.range.end).toBeGreaterThan(endInside);
    expect(prefix.text.endsWith("\u{1F600}")).toBe(true);
    expect(prefix.truncated).toBe(true);

    expect(() => sliceBody(body, { start: -1 })).toThrow(RangeError);
    expect(sliceBody("", {}).range).toEqual({ start: 0, end: 0, total: 0, unit: "utf16" });
  });
});