import type { SourceRange } from "./diagnostics.js";
import type { NewlineStyle } from "./newlines.js";
import type { BranchSide, NodeFlow, NodeState } from "./schema.js";

/** 一份主题或节点文档的原文事实；范围均相对于未归一化的 text。 */
export interface TopicDocument {
  /** 调用方给出的定位标签（通常是工作区相对路径）；解析器本身不读取文件系统。 */
  readonly path: string;
  /** UTF-8 解码后的原始字符串；解析不归一化换行，所有范围都相对于它。 */
  readonly text: string;
  readonly bom: boolean;
  readonly newline: NewlineStyle;
  readonly frontmatterRange?: SourceRange | undefined;
  readonly frontmatterContentRange?: SourceRange | undefined;
  readonly bodyRange?: SourceRange | undefined;
}

/** 一节点一份 Markdown：node 为整个节点文件，body 为 frontmatter 之后的可见正文。 */
export interface NodeRanges {
  readonly node: SourceRange;
  readonly body: SourceRange;
}

export interface ParsedNode {
  readonly id: string;
  readonly topicId: string;
  /** 主题入口路径（topic.md）。 */
  readonly topicPath: string;
  /** 节点真实来源文件。 */
  readonly sourcePath: string;
  readonly title: string;
  readonly body: string;
  readonly summary: string;
  readonly summaryExplicit: boolean;
  readonly state: NodeState;
  readonly flow: NodeFlow;
  readonly from: string | null;
  /** 来源说明；解释为什么接到 from。root 节点不写。 */
  readonly description?: string | undefined;
  readonly side?: BranchSide | undefined;
  readonly order?: number | undefined;
  readonly important: boolean;
  /** 均为原始字符串的 UTF-16 offset，左闭右开，可直接 text.slice。 */
  readonly ranges: NodeRanges;
}

export interface ParsedTopic {
  /** 主题入口文件 topic.md。 */
  readonly document: TopicDocument;
  readonly schemaVersion: 2;
  readonly topicId: string;
  readonly title: string;
  /** 主题目录（topics/<dir>）。 */
  readonly dir: string;
  /** 该主题全部真实源文件（含入口）。 */
  readonly sourcePaths: readonly string[];
  readonly nodes: readonly ParsedNode[];
}
