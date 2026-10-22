/**
 * 工作区分组解析：按 workspace.schemaVersion 把扫描到的 Markdown 原文分组为主题与节点。
 *
 * 纯函数：不读盘、不取锁、不写缓存，也不依赖 storage。service／CLI／候选校验共用这一入口，
 * 避免各处各写一套目录解析。V1 与 V2 不混合；一个工作区只使用一种正文组织。
 */
import { makeDiagnostic } from "./diagnostics.js";
import type { Diagnostic } from "./diagnostics.js";
import { validateWorkspace } from "./graph.js";
import type { WorkspaceGraph } from "./graph.js";
import { parseTopicDocument } from "./parser.js";
import type { ParsedTopic } from "./parser.js";
import { workspaceMetaSchema } from "./schema.js";
import type { SupportedSchemaVersion, WorkspaceMeta } from "./schema.js";
import { nodeFromV2Document, parseV2NodeDocument, parseV2TopicDocument } from "./v2.js";
import type { ParsedNode } from "./parser.js";

/** 一份扫描到的 Markdown 原文；path 为工作区相对 POSIX 路径。 */
export interface WorkspaceDocument {
  readonly path: string;
  readonly text: string;
}

export interface ParseWorkspaceInput {
  readonly workspace: WorkspaceMeta;
  readonly documents: readonly WorkspaceDocument[];
}

export interface ParseWorkspaceResult {
  readonly ok: boolean;
  /** 无法判定或版本不支持时为 null。 */
  readonly schemaVersion: SupportedSchemaVersion | null;
  readonly topics: readonly ParsedTopic[];
  readonly diagnostics: readonly Diagnostic[];
  /** 仅在 ok 时提供；失败时不返回部分结构。 */
  readonly graph?: WorkspaceGraph | undefined;
}

const TOPIC_ENTRY = "topic.md";

interface V2TopicGroup {
  readonly dir: string;
  /** 主题入口 topic.md；目录里只有节点而缺少入口时为 undefined。 */
  readonly entry?: WorkspaceDocument | undefined;
  readonly nodes: WorkspaceDocument[];
}

function segmentsOf(path: string): string[] {
  return path.split("/");
}

function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** 路径必须是工作区相对 POSIX 路径，且落在 topics/<主题目录>/ 下。 */
function pathProblem(path: string): string | undefined {
  if (path.length === 0) return "路径为空";
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return "只接受工作区相对的 POSIX 路径";
  const segments = segmentsOf(path);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "路径不能含空段、. 或 ..";
  }
  if (segments.length < 2 || segments[0] !== "topics") {
    return "格式 2 的 Markdown 必须位于 topics/ 下（主题目录或 topic.md）";
  }
  return undefined;
}

function groupV2Documents(
  documents: readonly WorkspaceDocument[],
  diagnostics: Diagnostic[],
): Map<string, V2TopicGroup> {
  const groups = new Map<string, V2TopicGroup>();
  const seenPaths = new Set<string>();
  for (const document of documents) {
    if (seenPaths.has(document.path)) {
      diagnostics.push(makeDiagnostic("DUPLICATE_DOCUMENT_PATH", "同一路径出现多次：" + document.path, { topicPath: document.path }));
      continue;
    }
    seenPaths.add(document.path);
    const problem = pathProblem(document.path);
    if (problem) {
      diagnostics.push(makeDiagnostic("DOCUMENT_PATH_INVALID", problem + "：" + document.path, { topicPath: document.path }));
      continue;
    }
    const segments = segmentsOf(document.path);
    if (segments.length === 2) {
      diagnostics.push(
        makeDiagnostic("V2_ORPHAN_DOCUMENT", "Markdown 必须放在 topics/<主题目录>/ 内；它不属于任何主题：" + document.path, {
          topicPath: document.path,
        }),
      );
      continue;
    }
    if (segments.length !== 3) {
      diagnostics.push(
        makeDiagnostic("DOCUMENT_PATH_INVALID", "格式 2 的主题目录只能有一层，节点文件直接放在该目录下：" + document.path, {
          topicPath: document.path,
        }),
      );
      continue;
    }
    if (!isMarkdownPath(document.path)) continue;
    const dir = segments[1];
    const fileName = segments[2] ?? "";
    if (dir === undefined) continue;
    const existing: V2TopicGroup = groups.get(dir) ?? { dir, nodes: [] };
    if (fileName === TOPIC_ENTRY) {
      groups.set(dir, { ...existing, entry: document });
    } else {
      groups.set(dir, { ...existing, nodes: [...existing.nodes, document] });
    }
  }
  return groups;
}

function parseV2Group(group: V2TopicGroup, diagnostics: Diagnostic[]): ParsedTopic | undefined {
  if (!group.entry) {
    diagnostics.push(makeDiagnostic("V2_TOPIC_MISSING", "主题目录 " + group.dir + " 缺少 topic.md", {}));
    return undefined;
  }
  const entry = group.entry;
  const parsedEntry = parseV2TopicDocument(entry.text, entry.path);
  if (parsedEntry.diagnostics.length > 0 || !parsedEntry.header) {
    diagnostics.push(
      ...(parsedEntry.diagnostics.length > 0
        ? parsedEntry.diagnostics
        : [makeDiagnostic("V2_TOPIC_MISSING", "主题入口缺少有效头", { topicPath: entry.path })]),
    );
    return undefined;
  }

  const context = { topicId: parsedEntry.header.topicId, topicPath: entry.path, dir: group.dir };
  const nodeFiles = [...group.nodes].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (nodeFiles.length === 0) {
    diagnostics.push(makeDiagnostic("TOPIC_EMPTY", "主题至少需要一张卡片：" + group.dir, { topicPath: entry.path }));
    return undefined;
  }
  const nodes: ParsedNode[] = [];
  for (const document of nodeFiles) {
    const parsed = parseV2NodeDocument(document.text, document.path, context);
    if (parsed.diagnostics.length > 0 || !parsed.header) {
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    nodes.push(nodeFromV2Document(parsed.document, parsed.header, context));
  }

  return {
    document: parsedEntry.document,
    schemaVersion: 2,
    topicId: parsedEntry.header.topicId,
    title: parsedEntry.header.title,
    dir: group.dir,
    sourcePaths: [entry.path, ...nodeFiles.map((document) => document.path)],
    nodes,
  };
}

/**
 * 解析整个工作区并完成全图校验。调用方只需给出 workspace.json 数据与扫描到的原文；
 * 成功时 graph 一定存在（空工作区为 rootId:null、nodes:[]、topics:[]）。
 */
export function parseWorkspaceDocuments(input: ParseWorkspaceInput): ParseWorkspaceResult {
  const declaredVersion = (input.workspace as { schemaVersion?: unknown }).schemaVersion;
  if (declaredVersion !== 1 && declaredVersion !== 2) {
    return {
      ok: false,
      schemaVersion: null,
      topics: [],
      diagnostics: [
        makeDiagnostic(
          "WORKSPACE_VERSION_UNSUPPORTED",
          "只支持工作区 schemaVersion 1 或 2，收到 " + JSON.stringify(declaredVersion) + "；未知版本需要显式迁移",
        ),
      ],
    };
  }
  const workspaceParsed = workspaceMetaSchema.safeParse(input.workspace);
  if (!workspaceParsed.success) {
    return {
      ok: false,
      schemaVersion: null,
      topics: [],
      diagnostics: workspaceParsed.error.issues.map((issue) =>
        makeDiagnostic(
          "WORKSPACE_SCHEMA_INVALID",
          "workspace.json: " + issue.message + " (" + issue.path.map(String).join(".") + ")",
        ),
      ),
    };
  }
  const workspace = workspaceParsed.data;
  const schemaVersion = workspace.schemaVersion;
  const diagnostics: Diagnostic[] = [];

  let topics: ParsedTopic[] = [];
  if (schemaVersion === 1) {
    const seenPaths = new Set<string>();
    for (const document of input.documents) {
      if (seenPaths.has(document.path)) {
        diagnostics.push(makeDiagnostic("DUPLICATE_DOCUMENT_PATH", "同一路径出现多次：" + document.path, { topicPath: document.path }));
        continue;
      }
      seenPaths.add(document.path);
      const parsed = parseTopicDocument(document.text, { path: document.path });
      if (parsed.diagnostics.length > 0 || !parsed.topic) {
        diagnostics.push(...parsed.diagnostics);
        continue;
      }
      topics.push(parsed.topic);
    }
  } else {
    const groups = groupV2Documents(input.documents, diagnostics);
    for (const dir of [...groups.keys()].sort()) {
      const group = groups.get(dir);
      if (!group) continue;
      const parsed = parseV2Group(group, diagnostics);
      if (parsed) topics.push(parsed);
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, schemaVersion, topics: [], diagnostics };
  }

  const validated = validateWorkspace({ workspace, topics });
  if (!validated.ok || !validated.graph) {
    return { ok: false, schemaVersion, topics: [], diagnostics: validated.diagnostics };
  }
  return { ok: true, schemaVersion, topics, diagnostics: [], graph: validated.graph };
}