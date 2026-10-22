export type NewlineStyle = "lf" | "crlf" | "cr" | "mixed" | "none";

export interface LineBounds {
  /** 行内容结束位置（不含换行符）。 */
  readonly end: number;
  /** 下一行开始位置（文件末尾时等于 text.length）。 */
  readonly next: number;
}

/** 定位从 start 开始的行；兼容 LF、CRLF 与单独的 CR。 */
export function lineBounds(text: string, start: number): LineBounds {
  const newline = text.indexOf("\n", start);
  if (newline === -1) return { end: text.length, next: text.length };
  const end = newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
  return { end, next: newline + 1 };
}

/** 只报告原文换行事实；解析与范围都不做换行归一化。 */
export function detectNewlineStyle(text: string): NewlineStyle {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charCodeAt(i);
    if (char === 13 && text.charCodeAt(i + 1) === 10) {
      crlf += 1;
      i += 1;
    } else if (char === 10) {
      lf += 1;
    } else if (char === 13) {
      cr += 1;
    }
  }
  if (crlf > 0 && (lf > 0 || cr > 0)) return "mixed";
  if (crlf > 0) return "crlf";
  if (lf > 0) return "lf";
  if (cr > 0) return "cr";
  return "none";
}
/**
 * 取一段源码范围中有实际内容的部分：去掉首尾空行与空白，但不改动原文。
 * 用于“正文范围”这类只表达可见内容的定位；整块替换应使用各自文件的 node 范围。
 */
export function contentRange(text: string, start: number, end: number): SourceRangeLike {
  let cursor = start;
  while (cursor < end) {
    const line = lineBounds(text, cursor);
    if (text.slice(cursor, Math.min(line.end, end)).trim().length > 0) break;
    cursor = line.next;
  }
  let tail = end;
  while (tail > cursor && /\s/.test(text[tail - 1] ?? "")) tail -= 1;
  return { start: cursor, end: tail };
}

export interface SourceRangeLike {
  readonly start: number;
  readonly end: number;
}
