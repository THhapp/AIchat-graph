/**
 * 格式 1 → 格式 2 的隔离转换。
 *
 * 纯函数：只根据读取到的源工作区事实生成目标文件计划，不写盘、不改源。
 * 源工作区始终只读；目标目录由调用方在确认为"不存在"后再发布。
 *
 * 保留：workspaceId／topicId／nodeId、正文、状态、焦点、from／flow／side／order，
 * 以及主题标题与关系顺序。旧 label 有值时保留为 description；缺失时不允许编造——
 * 必须由调用方按 nodeId 提供映射，否则拒绝发布目标。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseWorkspaceDocuments,
  type Diagnostic,
  type ParsedTopic,
  type WorkspaceMeta,
} from "../core/index.js";
import { StorageError, isErrnoCode } from "./errors.js";
import { normalizeRelativePath, resolveWorkspaceRoot } from "./paths.js";
import { readWorkspaceFiles } from "./workspace.js";
import type { WorkspaceFiles } from "./workspace.js";
import {
  TOPICS_DIR,
  nodePath,
  normalizeNewlines,
  renderNodeFile,
  renderTopicMetaText,
  topicMetaPath,
} from "./format-v2.js";

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.lstat(absolutePath);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** 目标目录下的一个待写入文件；content 恒为字符串，转换不生成删除。 */
export interface ConvertedFile {
  readonly path: string;
  readonly content: string;
}

export interface ConversionPlan {
  readonly ok: boolean;
  /** workspace.json 的目标内容。 */
  readonly workspaceJson: string | null;
  readonly files: readonly ConvertedFile[];
  readonly diagnostics: readonly Diagnostic[];
  /** 缺失 description 的节点（非 root）；非空时 ok=false，且 files 为空。 */
  readonly missingDescriptions: readonly string[];
  readonly counts: {
    readonly topics: number;
    readonly nodes: number;
    readonly preservedLabels: number;
  };
}

export interface ConvertWorkspaceOptions {
  /** 已按 {@link groupWorkspaceFiles} 读取的源工作区事实；必须为格式 1。 */
  readonly files: WorkspaceFiles;
  /** 按 nodeId 提供的 description；仅用于源 label 缺失的节点。 */
  readonly descriptions?: Readonly<Record<string, string>> | undefined;
}

function fail(diagnostics: readonly Diagnostic[], missing: readonly string[], preserved = 0): ConversionPlan {
  return {
    ok: false,
    workspaceJson: null,
    files: [],
    diagnostics,
    missingDescriptions: missing,
    counts: { topics: 0, nodes: 0, preservedLabels: preserved },
  };
}

/**
 * 生成格式 2 的目标文件计划。不写盘；调用方先 preview，确认后再发布到不存在的新目录。
 *
 * 不生成任何"全图总表"或主题节点清单：V2 的主题入口只有 topicId 与 title。
 */
export function planConversion(options: ConvertWorkspaceOptions): ConversionPlan {
  const { files } = options;
  if (files.workspace.schemaVersion !== 1) {
    return fail(
      [
        {
          code: "SCHEMA_INVALID",
          message: "源工作区不是格式 1（schemaVersion " + files.workspace.schemaVersion + "），无需转换",
        },
      ],
      [],
    );
  }
  const documents = files.topics.map((file) => ({ path: file.path, text: file.text }));
  const parsed = parseWorkspaceDocuments({ workspace: workspaceMetaFromInfo(files), documents });
  if (!parsed.ok || parsed.schemaVersion !== 1) {
    return fail(parsed.diagnostics, []);
  }

  const descriptions = options.descriptions ?? {};
  const missing: string[] = [];
  const out: ConvertedFile[] = [];
  let preservedLabels = 0;
  let nodeCount = 0;

  // 主题目录名沿用原主题文件主名；冲突时追加稳定后缀，避免覆盖。
  const usedDirs = new Set<string>();
  const dirOfTopic = new Map<string, string>();
  for (const topic of parsed.topics) {
    const base = topicBaseName(topic);
    let dir = base;
    let suffix = 2;
    while (usedDirs.has(dir)) {
      dir = base + "-" + suffix;
      suffix += 1;
    }
    usedDirs.add(dir);
    dirOfTopic.set(topic.topicId, dir);
  }

  for (const topic of parsed.topics) {
    const dir = dirOfTopic.get(topic.topicId) as string;
    const metaPath = topicMetaPath(dir);
    out.push({
      path: metaPath,
      content: renderTopicMetaText({ topicId: topic.topicId, title: topic.title, nl: "\n" }),
    });
    for (const node of topic.nodes) {
      nodeCount += 1;
      const existing = node.label !== undefined ? node.label.trim() : "";
      const supplied = descriptions[node.id]?.trim() ?? "";
      let description: string | undefined;
      if (node.flow === "root") description = undefined;
      else if (existing.length > 0) {
        description = existing;
        preservedLabels += 1;
      } else if (supplied.length > 0) description = supplied;
      else missing.push(node.id);

      if (missing.length > 0) continue;

      const targetPath = nodePath(dir, node.id);
      const content = renderNodeFile({
        header: {
          nodeId: node.id,
          title: node.title,
          state: node.state,
          from: node.from,
          flow: node.flow,
          ...(description !== undefined ? { description } : {}),
          ...(node.side !== undefined ? { side: node.side } : {}),
          ...(node.order !== undefined ? { order: node.order } : {}),
          ...(node.summaryExplicit ? { summary: node.summary } : {}),
        },
        // 正文原样搬运：不把旧 H2 卡片标题或 node 注释混进内容。
        body: node.body,
        nl: "\n",
      });
      out.push({ path: targetPath, content });
    }
  }

  if (missing.length > 0) {
    const diagnostics: Diagnostic[] = missing.map((nodeId) => ({
      code: "SCHEMA_INVALID",
      message:
        "节点 " + nodeId + " 没有可用 description（旧 label 为空）；请读取该节点后提供映射，不能编造",
      nodeId,
    }));
    return fail(diagnostics, missing, preservedLabels);
  }

  const workspaceJson =
    JSON.stringify(
      {
        schemaVersion: 2,
        ...(files.workspace.topicMode !== undefined ? { topicMode: files.workspace.topicMode } : {}),
        workspaceId: files.workspace.workspaceId,
        name: files.workspace.name,
        activeNode: files.workspace.activeNode,
      },
      null,
      2,
    ) + "\n";

  return {
    ok: true,
    workspaceJson,
    files: out,
    diagnostics: [],
    missingDescriptions: [],
    counts: { topics: parsed.topics.length, nodes: nodeCount, preservedLabels },
  };
}

/** 扫描事实里的最小身份字段就是 core 的 WorkspaceMeta；这里显式收窄，不靠断言蒙混。 */
function workspaceMetaFromInfo(files: WorkspaceFiles): WorkspaceMeta {
  return {
    schemaVersion: files.workspace.schemaVersion,
    ...(files.workspace.topicMode !== undefined ? { topicMode: files.workspace.topicMode } : {}),
    workspaceId: files.workspace.workspaceId,
    name: files.workspace.name,
    activeNode: files.workspace.activeNode,
  };
}

/** 主题目录名：取源主题文件名（不含目录与扩展名），去掉不适合做目录名的字符。 */
function topicBaseName(topic: ParsedTopic): string {
  const path = topic.document.path;
  const withoutTopics = path.startsWith(TOPICS_DIR + "/") ? path.slice(TOPICS_DIR.length + 1) : path;
  const lastSegment = withoutTopics.split("/").pop() ?? "topic";
  const withoutExt = lastSegment.replace(/\.md$/i, "");
  const cleaned = withoutExt
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length === 0 ? topic.topicId : cleaned;
}
/* ------------------------------------------------------------------ *
 * 隔离迁移：显式 source → 不存在的新 destination
 * ------------------------------------------------------------------ */

export interface MigrateWorkspaceOptions {
  /** 源工作区根（只读；不原位迁移）。 */
  readonly source: string;
  /** 目标根：必须不存在。由调用方确认是本机空位。 */
  readonly destination: string;
  /** 按 nodeId 提供的连接描述；仅用于源 label 缺失的非 root 节点。 */
  readonly descriptions?: Readonly<Record<string, string>> | undefined;
  /** 只计算不落盘：用于 preview 展示将写入哪些文件。 */
  readonly dryRun?: boolean | undefined;
}

export interface MigrateWorkspaceResult {
  readonly ok: boolean;
  readonly source: string;
  readonly destination: string;
  /** 目标目录是否已实际发布（dryRun 恒为 false）。 */
  readonly published: boolean;
  readonly files: readonly ConvertedFile[];
  readonly diagnostics: readonly Diagnostic[];
  /** 缺失 description 的节点；非空时 ok=false 且不发布。 */
  readonly missingDescriptions: readonly string[];
  readonly counts: ConversionPlan["counts"];
}

function migrateResult(options: {
  ok: boolean;
  source: string;
  destination: string;
  published: boolean;
  plan: ConversionPlan;
}): MigrateWorkspaceResult {
  return {
    ok: options.ok,
    source: options.source,
    destination: options.destination,
    published: options.published,
    files: options.plan.files,
    diagnostics: options.plan.diagnostics,
    missingDescriptions: options.plan.missingDescriptions,
    counts: options.plan.counts,
  };
}

/**
 * 把格式 1 工作区转换成一份新的格式 2 工作区。
 *
 * - 源始终只读：只调用 readWorkspaceFiles，不修改、不移动源文件；
 * - 目标必须不存在：已存在就拒绝，绝不覆盖他人的目录；
 * - 先在目标同父目录的临时目录写满全部文件并自检，再一次 rename 发布；
 * - 缺少必需 description 时直接失败，不生成"看起来完整"的半个目标。
 */
export async function migrateWorkspace(
  options: MigrateWorkspaceOptions,
): Promise<MigrateWorkspaceResult> {
  const sourceRoot = await resolveWorkspaceRoot(options.source);
  const destination = path.resolve(options.destination);
  const sourceDisplay = sourceRoot;
  const destinationDisplay = destination;

  if (destination === sourceRoot) {
    throw new StorageError("INVALID_ARGUMENT", "目标目录不能与源工作区相同；转换不原位迁移", {
      path: destination,
    });
  }
  if (await pathExists(destination)) {
    throw new StorageError("WORKSPACE_EXISTS", "目标目录已存在，拒绝覆盖：" + destination, {
      path: destination,
    });
  }

  const files = await readWorkspaceFiles(sourceRoot);
  const plan = planConversion({ files, descriptions: options.descriptions });
  if (!plan.ok || plan.workspaceJson === null) {
    return migrateResult({
      ok: false,
      source: sourceDisplay,
      destination: destinationDisplay,
      published: false,
      plan,
    });
  }

  if (options.dryRun === true) {
    return migrateResult({
      ok: true,
      source: sourceDisplay,
      destination: destinationDisplay,
      published: false,
      plan,
    });
  }

  const parent = path.dirname(destination);
  const parentStat = await fs.stat(parent).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) {
      throw new StorageError("INIT_FAILED", "目标父目录不存在：" + parent, { cause: error });
    }
    throw error;
  });
  if (!parentStat.isDirectory()) {
    throw new StorageError("INIT_FAILED", "目标父路径不是目录：" + parent);
  }

  const staging = path.join(
    parent,
    "." + path.basename(destination) + "." + randomUUID() + ".convert",
  );
  try {
    await fs.mkdir(staging);
    await fs.mkdir(path.join(staging, TOPICS_DIR));
    await fs.mkdir(path.join(staging, ".aichat", "cache"), { recursive: true });
    await fs.mkdir(path.join(staging, ".aichat", "local"), { recursive: true });
    await fs.mkdir(path.join(staging, ".aichat", "runtime", "transactions"), { recursive: true });
    await fs.writeFile(path.join(staging, "workspace.json"), plan.workspaceJson, {
      encoding: "utf8",
      flag: "wx",
    });
    for (const file of plan.files) {
      const relativePath = normalizeRelativePath(file.path);
      const absolutePath = path.join(staging, ...relativePath.split("/"));
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, file.content, { encoding: "utf8", flag: "wx" });
    }
    // 发布前自检：目标必须能被同一读取路径解析，且图校验通过。
    const staged = await readWorkspaceFiles(staging);
    const stagedDocuments = staged.topics.map((file) => ({ path: file.path, text: file.text }));
    const stagedParsed = parseWorkspaceDocuments({
      workspace: workspaceMetaFromInfo(staged),
      documents: stagedDocuments,
    });
    if (!stagedParsed.ok) {
      return migrateResult({
        ok: false,
        source: sourceDisplay,
        destination: destinationDisplay,
        published: false,
        plan: {
          ...plan,
          ok: false,
          diagnostics: stagedParsed.diagnostics,
        },
      });
    }
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      if (
        isErrnoCode(error, "EEXIST") ||
        isErrnoCode(error, "ENOTEMPTY") ||
        isErrnoCode(error, "EPERM")
      ) {
        throw new StorageError("WORKSPACE_EXISTS", "目标目录已存在，拒绝覆盖：" + destination, {
          path: destination,
          cause: error,
        });
      }
      throw error;
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof StorageError) throw error;
    throw new StorageError("INIT_FAILED", "转换写入目标失败，未发布：" + destination, {
      cause: error,
    });
  }

  return migrateResult({
    ok: true,
    source: sourceDisplay,
    destination: await fs.realpath(destination),
    published: true,
    plan,
  });
}