/**
 * Card geometry and text metrics shared by the live reader, the offline reader
 * and `src/web/styles/graph.css`.
 *
 * Everything here is a pure function of the input text. The offline build has no
 * DOM measurement available and live layout must not wait for fonts, so line
 * counts are estimated from a fixed width table. The estimate is deliberately
 * conservative: it may predict one extra row, never one too few, so a long title
 * is never clipped by the geometry we hand to layout.
 *
 * The px values below must stay equal to the card rules in graph.css.
 */

/** Card outer width; layout, React Flow and the card CSS all use this value. */
export const CARD_WIDTH = 360;
export const CARD_PADDING_X = 12;
export const CARD_PADDING_Y = 12;
/** Top/bottom/right border. */
export const CARD_BORDER = 1;
/** Left accent border (border-left replaces the 1px border). */
export const CARD_ACCENT_BORDER = 3;
/** Vertical gap between header, title, summary and footer. */
export const CARD_SECTION_GAP = 4;
export const CARD_HEAD_HEIGHT = 24;
export const CARD_FOOT_HEIGHT = 16;
export const CARD_TITLE_FONT = 15;
export const CARD_TITLE_LINE_HEIGHT = 20;
export const CARD_SUMMARY_FONT = 13;
export const CARD_SUMMARY_LINE_HEIGHT = 20;
export const CARD_SUMMARY_LINES = 3;

/** Edge label (relationship sentence drawn on the connector). */
export const EDGE_LABEL_FONT = 11;
export const EDGE_LABEL_LINE_HEIGHT = 14;
export const EDGE_LABEL_PAD_X = 4;
export const EDGE_LABEL_PAD_Y = 2;
export const EDGE_LABEL_RADIUS = 4;

/**
 * Layout gaps; exported so the live reader, the offline reader and the layout
 * core do not each spell them out.
 */
export const LAYOUT_VERTICAL_GAP = 64;
export const LAYOUT_HORIZONTAL_GAP = 200;
/** Tight vertical distance between siblings of one branch group. */
export const LAYOUT_BRANCH_SIBLING_GAP = 40;
/** Shared branch riser inset from the source card's right edge. */
export const LAYOUT_TRUNK_INSET = 20;
/** Minimum clear space between an edge label and cards/trunk lines. */
export const LAYOUT_LABEL_GUTTER = 8;
/** Gap above a next-relation label and below it before the target card. */
export const LAYOUT_LABEL_GAP = 8;
/** Vertical gap between top-level forest blocks. */
export const LAYOUT_ROOT_GAP = 120;
/** Layout output contract version; `layout/types` re-exports this value. */
export const LAYOUT_VERSION = 5;

/** Text box between the accent border, the right border and the horizontal padding. */
export const CARD_CONTENT_WIDTH =
  CARD_WIDTH - CARD_BORDER - CARD_ACCENT_BORDER - CARD_PADDING_X * 2;

/**
 * Width used to estimate title rows. The 2px reserve covers the title's
 * letter-spacing, so a row is never claimed when the browser would wrap it.
 */
export const CARD_TITLE_WIDTH = CARD_CONTENT_WIDTH - 2;

/** Everything above and below the title, in px. */
export const CARD_CHROME_HEIGHT =
  CARD_BORDER * 2 +
  CARD_PADDING_Y * 2 +
  CARD_SECTION_GAP * 3 +
  CARD_HEAD_HEIGHT +
  CARD_SUMMARY_LINE_HEIGHT * CARD_SUMMARY_LINES +
  CARD_FOOT_HEIGHT;

/** Height of a card whose title needs one line; layout's fallback card height. */
export const CARD_BASE_HEIGHT = CARD_CHROME_HEIGHT + CARD_TITLE_LINE_HEIGHT;

/** Latin glyphs that are clearly narrower than the average letter. */
const NARROW_ASCII = new Set([...'iljtfrI.,:;\'`|!']);

/** Wide (CJK, fullwidth, emoji) code point ranges. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
  [0x20000, 0x3fffd],
];

export function isWideChar(codePoint: number): boolean {
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

/**
 * Width of one code point in em. Latin averages sit above the real advance so a
 * mixed title is never estimated shorter than it renders; wide glyphs are 1em,
 * which is exact for CJK.
 */
function charWidthEm(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0x20 || codePoint === 0xa0) return 0.34;
  if (isWideChar(codePoint)) return 1;
  if (codePoint < 0x7f) {
    if (NARROW_ASCII.has(char)) return 0.34;
    if (char >= 'A' && char <= 'Z') return 0.68;
    if (char >= '0' && char <= '9') return 0.6;
    return 0.58;
  }
  return 0.66;
}

/** Estimated rendered width of `text` at `fontPx`. */
export function textWidth(text: string, fontPx: number): number {
  if (!(fontPx > 0)) return 0;
  let total = 0;
  for (const char of text) total += charWidthEm(char) * fontPx;
  return total;
}

interface Segment {
  text: string;
  width: number;
  space: boolean;
}

/**
 * Splits text into breakable pieces: whitespace runs, single wide glyphs and
 * Latin words. Breaking only between words keeps labels readable; a word that is
 * wider than the line is hard-broken by the caller.
 */
function segmentsOf(text: string, fontPx: number): Segment[] {
  const segments: Segment[] = [];
  let word = '';
  let wordWidth = 0;
  const flushWord = (): void => {
    if (word === '') return;
    segments.push({ text: word, width: wordWidth, space: false });
    word = '';
    wordWidth = 0;
  };
  for (const char of text) {
    const width = charWidthEm(char) * fontPx;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      flushWord();
      segments.push({ text: ' ', width, space: true });
      continue;
    }
    if (isWideChar(char.codePointAt(0) ?? 0)) {
      flushWord();
      segments.push({ text: char, width, space: false });
      continue;
    }
    word += char;
    wordWidth += width;
  }
  flushWord();
  return segments;
}

/** Adds an ellipsis to the last line, trimming characters until it fits. */
function withEllipsis(line: string, maxWidth: number, fontPx: number): string {
  const ellipsis = '…';
  if (textWidth(line + ellipsis, fontPx) <= maxWidth) return line + ellipsis;
  const chars = [...line];
  while (chars.length > 0) {
    chars.pop();
    const candidate = chars.join('').trimEnd();
    if (textWidth(candidate + ellipsis, fontPx) <= maxWidth) return candidate + ellipsis;
  }
  return ellipsis;
}

function wrapOneParagraph(text: string, maxWidth: number, fontPx: number): string[] {
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;

  const pushCurrent = (): void => {
    const trimmed = current.trimEnd();
    if (trimmed !== '') lines.push(trimmed);
    current = '';
    currentWidth = 0;
  };

  for (const segment of segmentsOf(text, fontPx)) {
    if (segment.space) {
      if (current === '') continue;
      current += segment.text;
      currentWidth += segment.width;
      continue;
    }
    if (currentWidth + segment.width <= maxWidth) {
      current += segment.text;
      currentWidth += segment.width;
      continue;
    }
    pushCurrent();
    if (segment.width <= maxWidth) {
      current = segment.text;
      currentWidth = segment.width;
      continue;
    }
    // A single word wider than the line: break it by code point.
    let buffer = '';
    let bufferWidth = 0;
    for (const char of segment.text) {
      const width = charWidthEm(char) * fontPx;
      if (bufferWidth > 0 && bufferWidth + width > maxWidth) {
        lines.push(buffer);
        buffer = '';
        bufferWidth = 0;
      }
      buffer += char;
      bufferWidth += width;
    }
    current = buffer;
    currentWidth = bufferWidth;
  }
  pushCurrent();
  return lines;
}

/** True when every code point is a wide glyph, so nothing Latin or blank can be split. */
function isWideOnly(text: string): boolean {
  if (text === '') return false;
  for (const char of text) {
    if (!isWideChar(char.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/**
 * Greedy wrapping leaves a widow when a sentence runs one character past a full
 * row: "用明确左侧对照自动" + "择侧". For pure CJK tails of one or two glyphs the
 * last two rows are merged and cut in half, which keeps both rows readable and
 * the row count unchanged. Mixed text is left alone so no word is torn apart.
 */
function rebalanceTail(lines: string[], maxWidth: number, fontPx: number): string[] {
  if (lines.length < 2) return lines;
  const head = [...(lines[lines.length - 2] ?? '')];
  const tail = [...(lines[lines.length - 1] ?? '')];
  if (tail.length > 2) return lines;
  const merged = [...head, ...tail];
  if (!isWideOnly(merged.join(''))) return lines;
  const cut = Math.ceil(merged.length / 2);
  const first = merged.slice(0, cut).join('');
  const second = merged.slice(cut).join('');
  if (textWidth(first, fontPx) > maxWidth || textWidth(second, fontPx) > maxWidth) return lines;
  return [...lines.slice(0, -2), first, second];
}

/**
 * Deterministic greedy wrap at `maxWidth`. Whitespace runs collapse to one space
 * so the same sentence always yields the same lines. With `maxLines`, extra lines
 * are dropped and the last one ends with an ellipsis that still fits.
 */
export function wrapByWidth(
  text: string,
  maxWidth: number,
  fontPx: number,
  maxLines?: number,
): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '') return [];
  if (!(maxWidth > 0) || !(fontPx > 0)) return [normalized];

  const lines = wrapOneParagraph(normalized, maxWidth, fontPx);
  if (lines.length === 0) return [normalized];
  const limit = maxLines === undefined ? lines.length : Math.max(1, Math.floor(maxLines));
  if (lines.length <= limit) return rebalanceTail(lines, maxWidth, fontPx);

  const kept = lines.slice(0, limit);
  const lastIndex = kept.length - 1;
  kept[lastIndex] = withEllipsis(kept[lastIndex] ?? '', maxWidth, fontPx);
  return kept;
}

export interface EdgeLabelBoxSize {
  /** Painted box width, including horizontal padding. */
  width: number;
  /** Painted box height, including vertical padding. */
  height: number;
  /** Complete wrapped lines; never truncated. */
  lines: string[];
}

/**
 * Size of an edge-label box for `text` at `maxWidth`. Layout reserves this
 * height next to cards and the reader paints exactly these lines, so both sides
 * share one metric instead of estimating separately.
 */
export function edgeLabelBoxSize(text: string, maxWidth: number): EdgeLabelBoxSize {
  if (text.trim() === '') return { width: 0, height: 0, lines: [] };
  const limit = maxWidth > 0 ? maxWidth : 1;
  const lines = wrapByWidth(text, limit, EDGE_LABEL_FONT);
  if (lines.length === 0) return { width: 0, height: 0, lines: [] };
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, textWidth(line, EDGE_LABEL_FONT));
  return {
    width: Math.min(widest, limit) + EDGE_LABEL_PAD_X * 2,
    height: lines.length * EDGE_LABEL_LINE_HEIGHT + EDGE_LABEL_PAD_Y * 2,
    lines,
  };
}

/** Number of rows the title needs at the card's fixed font and content width. */
export function titleLineCount(title: string): number {
  const lines = wrapByWidth(title, CARD_TITLE_WIDTH, CARD_TITLE_FONT);
  return Math.max(1, lines.length);
}

/**
 * Card height for a title. The same title always yields the same number, and the
 * title is never clamped: a longer title makes a taller card instead of an
 * unreadable one.
 */
export function cardHeightForTitle(title: string): number {
  return CARD_CHROME_HEIGHT + titleLineCount(title) * CARD_TITLE_LINE_HEIGHT;
}
