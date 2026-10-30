/**
 * One-time import from the retired format-2 isolated Markdown workspace into graph.sqlite.
 *
 * This is the only module allowed to keep reading the old file format; the normal
 * runtime chain never scans Markdown. Source files are only read and left untouched,
 * nothing is backed up, and a half-imported database is removed again. The import is
 * async (old file readers are async) but never starts a service.
 */
import { existsSync, promises as fs, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parseWorkspaceDocuments } from "../core/documents.js";
import { readWorkspaceFiles } from "../storage/workspace.js";
import type { WorkspaceFiles } from "../storage/workspace.js";
import { StorageError } from "../storage/errors.js";
import { isRecord } from "../shared/guards.js";
import { DomainError, projectSnapshot } from "./model.js";
import type { NodeRecord, TopicRecord, WorkspaceRecord } from "./model.js";
import { GraphStore } from "./store.js";

const DB_FILE = "graph.sqlite";
const LAST_CHANGE_RELATIVE = ".aichat/runtime/last-change.json";
const LAST_CHANGE_SCHEMA_VERSION = 2;
// Stable ID shapes of the retired format; kept local so the one-time importer
// does not depend on the old core/storage modules the runtime is retiring.
const NODE_ID_PATTERN = /^n_[0-9a-f]{32}$/;
const TOPIC_ID_PATTERN = /^t_[0-9a-f]{32}$/;

interface RecentChange {
  readonly at: string;
  readonly nodeIds: string[];
}

export interface ImportSummary {
  ok: true;
  root: string;
  dbPath: string;
  workspaceId: string;
  name: string;
  topicCount: number;
  nodeCount: number;
  lastChangeTopicCount: number;
}

function sourceInvalid(message: string, diagnostics: unknown[] = []): DomainError {
  return new DomainError("IMPORT_SOURCE_INVALID", message, 422, { diagnostics });
}

function unsupportedWorkspace(message: string): DomainError {
  return new DomainError("IMPORT_UNSUPPORTED_WORKSPACE", message, 422);
}

function workspaceExists(dbPath: string): DomainError {
  return new DomainError(
    "IMPORT_WORKSPACE_EXISTS",
    "该工作区已经有 graph.sqlite，导入拒绝覆盖：" + dbPath,
    409,
    { dbPath, hint: "继续使用现有数据库；需要重新导入请换一个目录。" },
  );
}

/** Reject V1 / shared explicitly before the strict V2 reader hides the reason. */
async function assertFormat2(root: string): Promise<void> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, "workspace.json"), "utf8");
  } catch {
    return; // Missing file: the old reader below reports the real error.
  }
  let declared: unknown;
  try {
    declared = JSON.parse(text);
  } catch {
    return; // Invalid JSON: the old reader below reports the real error.
  }
  if (!isRecord(declared)) return;
  if (declared["schemaVersion"] !== 2) {
    throw unsupportedWorkspace(
      "只支持旧资料 schemaVersion 2（isolated），收到 " + JSON.stringify(declared["schemaVersion"]) +
        "；V1 / shared 工作区不能导入。",
    );
  }
  if (declared["topicMode"] !== undefined && declared["topicMode"] !== "isolated") {
    throw unsupportedWorkspace("只支持 topicMode isolated 的旧资料，收到 " + JSON.stringify(declared["topicMode"]));
  }
}

/** Old last-change.json is best effort: missing or damaged means "no recent updates". */
function readLastChanges(root: string): Record<string, RecentChange> {
  let text: string;
  try {
    text = readFileSync(path.join(root, ...LAST_CHANGE_RELATIVE.split("/")), "utf8");
  } catch {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(raw) || raw["schemaVersion"] !== LAST_CHANGE_SCHEMA_VERSION) return {};
  const topics = raw["topics"];
  if (!isRecord(topics)) return {};
  const result: Record<string, RecentChange> = {};
  for (const [topicId, value] of Object.entries(topics)) {
    if (!TOPIC_ID_PATTERN.test(topicId) || !isRecord(value)) continue;
    const at = value["at"];
    const rawIds = value["nodeIds"];
    if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || !Array.isArray(rawIds)) continue;
    const nodeIds: string[] = [];
    for (const id of rawIds) {
      if (typeof id === "string" && NODE_ID_PATTERN.test(id) && !nodeIds.includes(id)) nodeIds.push(id);
    }
    if (nodeIds.length === 0) continue;
    result[topicId] = { at, nodeIds };
  }
  return result;
}

function oldWorkspaceMeta(files: WorkspaceFiles): {
  schemaVersion: 2;
  workspaceId: string;
  name: string;
  activeNode: string | null;
  topicMode?: "isolated";
} {
  return {
    schemaVersion: 2,
    workspaceId: files.workspace.workspaceId,
    name: files.workspace.name,
    activeNode: files.workspace.activeNode,
    ...(files.workspace.topicMode === "isolated" ? { topicMode: "isolated" as const } : {}),
  };
}

function resolveName(oldName: string, name: string | undefined): string {
  if (name === undefined) return oldName;
  const resolved = name.trim();
  if (resolved.length === 0 || /[\r\n]/.test(resolved)) {
    throw new DomainError("INVALID_ARGUMENT", "name 必须是非空单行文本", 422, { field: "name" });
  }
  return resolved;
}


function normalizeRelativePath(fromFile: string, target: string): string {
  const clean = target.split('#')[0]?.split('?')[0] ?? target;
  const decoded = (() => { try { return decodeURIComponent(clean); } catch { return clean; } })();
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), decoded)).replace(/^\.\//, '');
}

/** Rewrite old workspace-relative card/image links to stable node links or resources keys. */
function normalizeBodyLinks(body: string, sourcePath: string, nodeByPath: ReadonlyMap<string, string>): string {
  const lines = body.split('\n');
  let fenced = false;
  const pattern = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    lines[index] = line.replace(pattern, (whole: string, prefix: string, target: string, suffix: string) => {
      if (/^(?:[a-z]+:|\/|#)/i.test(target)) return whole;
      const hashIndex = target.indexOf('#');
      const fragment = hashIndex >= 0 ? target.slice(hashIndex) : '';
      const normalized = normalizeRelativePath(sourcePath, target);
      if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) {
        const nodeId = nodeByPath.get(normalized);
        return nodeId === undefined ? whole : prefix + 'aichat:node/' + nodeId + fragment + suffix;
      }
      if (normalized.startsWith('resources/')) {
        const encoded = normalized
          .split('/')
          .map((segment) => (segment === '..' || segment === '.' ? segment : encodeURIComponent(segment)))
          .join('/');
        return prefix + encoded + fragment + suffix;
      }
      return whole;
    });
  }
  return lines.join('\n');
}

function removeCreatedDatabase(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      // Best effort: a leftover file is reported by the next create attempt.
    }
  }
}

/**
 * Import one format-2 isolated Markdown workspace into <root>/graph.sqlite.
 *
 * Stable IDs, topic keys (old directory names), bodies, explicit summaries,
 * connections, side/order, important flags and per-topic recent updates are kept.
 * The retired confirmation state is ignored, never converted into content.
 * An existing graph.sqlite is rejected; a failed import removes the database created
 * by this call so no half graph stays visible.
 */
export async function importV2(root: string, name?: string): Promise<ImportSummary> {
  await assertFormat2(root);
  let files: WorkspaceFiles;
  try {
    files = await readWorkspaceFiles(root);
  } catch (error) {
    if (error instanceof StorageError) {
      throw sourceInvalid("不能读取旧工作区：" + error.message, [
        { code: error.code, message: error.message, ...(error.path === undefined ? {} : { path: error.path }) },
      ]);
    }
    throw error;
  }
  const symlinked = files.diagnostics.filter((entry) => entry.code === "PATH_SYMLINK_SKIPPED");
  if (symlinked.length > 0) {
    throw sourceInvalid(
      "旧资料 topics 下含符号链接，导入不会跟随或静默丢内容：" + symlinked.map((entry) => entry.path).slice(0, 5).join(", "),
      symlinked.map((entry) => ({ code: entry.code, message: entry.message, ...(entry.path === undefined ? {} : { path: entry.path }) })),
    );
  }

  const parsed = parseWorkspaceDocuments({
    workspace: oldWorkspaceMeta(files),
    documents: files.topics.map((document) => ({ path: document.path, text: document.text })),
  });
  if (!parsed.ok) {
    const first = parsed.diagnostics[0];
    throw sourceInvalid(
      "旧资料无法解析或图校验未通过" + (first === undefined ? "" : "：" + first.message),
      parsed.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.topicPath === undefined ? {} : { topicPath: diagnostic.topicPath }),
        ...(diagnostic.nodeId === undefined ? {} : { nodeId: diagnostic.nodeId }),
      })),
    );
  }

  const lastChanges = readLastChanges(files.root);
  const nodeByPath = new Map<string, string>();
  for (const topic of parsed.topics) {
    for (const node of topic.nodes) nodeByPath.set(node.sourcePath, node.id);
  }
  const workspaceName = resolveName(files.workspace.name, name);
  const topics: TopicRecord[] = [];
  const nodes: NodeRecord[] = [];
  let lastChangeTopicCount = 0;
  for (const topic of parsed.topics) {
    const topicNodes: NodeRecord[] = topic.nodes.map((node) => ({
      id: node.id,
      topicId: node.topicId,
      title: node.title,
      body: normalizeBodyLinks(node.body, node.sourcePath, nodeByPath),
      summary: node.summaryExplicit ? node.summary : null,
      from: node.from,
      flow: node.flow,
      description: node.description ?? null,
      side: node.side ?? null,
      order: node.order ?? null,
      important: node.important,
      revision: 1,
    }));
    const importedIds = new Set(topicNodes.map((node) => node.id));
    const change = lastChanges[topic.topicId];
    const lastChangeIds = change === undefined ? [] : change.nodeIds.filter((id) => importedIds.has(id));
    if (lastChangeIds.length > 0) lastChangeTopicCount += 1;
    topics.push({
      id: topic.topicId,
      key: topic.dir,
      title: topic.title,
      revision: 1,
      lastChangeAt: lastChangeIds.length > 0 && change !== undefined ? change.at : null,
      lastChangeIds,
    });
    nodes.push(...topicNodes);
  }
  const workspace: WorkspaceRecord = {
    id: files.workspace.workspaceId,
    name: workspaceName,
    activeNode: files.workspace.activeNode,
    revision: 1,
  };

  // Validate the mapped graph before touching the disk, so invalid sources do not
  // leave a database behind that a later import would have to reject.
  try {
    projectSnapshot(workspace, topics, nodes);
  } catch (error) {
    if (error instanceof DomainError) {
      throw sourceInvalid("旧资料映射到新图后校验失败：" + error.message, [
        { code: error.code, message: error.message },
      ]);
    }
    throw error;
  }

  const dbPath = path.join(files.root, DB_FILE);
  if (existsSync(dbPath)) throw workspaceExists(dbPath);
  let store: GraphStore | null = null;
  let created = false;
  try {
    store = GraphStore.create(files.root, workspaceName);
    created = true;
    store.importState({ workspace, topics, nodes });
  } catch (error) {
    if (store !== null) {
      try {
        store.close();
      } catch {
        // ignore close errors during cleanup
      }
    }
    if (created) removeCreatedDatabase(dbPath);
    if (error instanceof DomainError && error.code === "WORKSPACE_EXISTS") throw workspaceExists(dbPath);
    throw error;
  }
  store.close();
  return {
    ok: true,
    root: files.root,
    dbPath,
    workspaceId: workspace.id,
    name: workspaceName,
    topicCount: topics.length,
    nodeCount: nodes.length,
    lastChangeTopicCount,
  };
}
