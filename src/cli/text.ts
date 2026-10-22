/**
 * 有界正文读取与章节定位：逻辑统一放在 core（A1），这里只做 re-export。
 *
 * CLI 不保留第二份实现——切片单位、上限、代理对对齐、围栏代码块里的 # 是否算章节、
 * truncated 语义，都必须与 service 的 agent bounded read 完全一致。
 * 保留本文件是为了让 CLI 内的调用点不需要知道模块边界变化。
 */
export {
  DEFAULT_READ_LENGTH,
  MAX_READ_SEGMENT,
  normalizeLength,
  sliceBody,
  locateSection,
  type BodyRange,
  type BodySegment,
  type SectionLocation,
  type SliceOptions,
} from "../core/index.js";