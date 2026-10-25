export type NewlineStyle = "lf" | "crlf" | "cr" | "mixed" | "none";

export interface LineBounds {
  /** 行内容结束位置（不含换行符）。 */
  readonly end: number;
  /** 下一行开始位置（文件末尾时等于 text.length）。 */
  readonly next: number;
}

/**
 * 定位从 start 开始的行，只按 LF 分行。
 *
 * CRLF 的 CR 归入行尾但不包含在 end 里；单独的 CR 不视为换行，会留在行内容中。
 * 解析层只支持 LF／CRLF；裸 CR 文件目前不会被拒绝，而会被当成一行或行内字符，
 * 调用方不应依赖这里提供裸 CR 分行能力。
 */
export function lineBounds(text: string, start: number): LineBounds {
  const newline = text.indexOf("\n", start);
  if (newline === -1) return { end: text.length, next: text.length };
  const end = newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
  return { end, next: newline + 1 };
}

/** 把任意换行统一成 LF 后再转换为目标换行；目标不是 LF 时按 LF 逐段替换。 */
export function normalizeNewlines(value: string, nl: string): string {
  const lf = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return nl === "\n" ? lf : lf.replace(/\n/g, nl);
}

/**
 * 选择文件的主要换行：出现 CRLF 即按 CRLF，否则 LF。
 * 只表达"写回时用哪种换行"，与 detectNewlineStyle 的完整事实区分。
 */
export function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
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
