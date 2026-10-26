import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StorageError, isErrnoCode } from "./errors.js";
import { sha256Bytes } from "./hash.js";
import { parseWorkspaceInfo } from "./workspace.js";
import { normalizeRelativePath } from "./paths.js";
import { WORKSPACE_FILENAME, TOPICS_DIR } from "./format.js";

export interface InitWorkspaceOptions {
  /** 新建工作区的目标目录；必须不存在。 */
  root: string;
  /** 工作区显示名，默认取目录名。 */
  name?: string;
  /** 固定 ID 仅用于测试或迁移；默认随机生成。 */
  workspaceId?: string;
  /** 覆盖默认入口说明（测试用，不对外暴露为产品配置）。 */
  agentsMarkdown?: string;
}

export interface InitWorkspaceResult {
  root: string;
  workspaceId: string;
  files: Array<{ path: string; sha256: string }>;
}

const DEFAULT_GITIGNORE = `.aichat/
node_modules/
`;

/**
 * 新工作区的本地接入说明：只保存目录与操作边界，不复制开发规范、Skill 或完整 schema。
 * 不回写已有工作区的 AGENTS.md；程序命令可独立使用，不要求安装 Skill。
 */
function buildAgentsMarkdown(name: string): string {
  return [
    "# " + name,
    "",
    "这是 AIchat-graph 工作区：一个节点一份 Markdown。讨论内容只写在 topics 下的文件里，程序据此生成图。",
    "本文件说明本工作区的接入与存储边界，不是程序仓库的开发约定，也不自动启用讨论记录。",
    "",
    "## 结构",
    "",
    "- workspace.json：工作区身份与 activeNode；activeNode 不是前端选中项，也不替代本对话的主题绑定。",
    "- topics/<主题目录>/topic.md：只放该主题的 topicId 与 title，正文留空。",
    "- topics/<主题目录>/<节点ID>.md：节点 YAML 头保存身份、标题、状态、连接及 description 等元数据；正文保存内容。",
    "- .aichat/：可重建缓存与运行中服务的事务日志。未恢复事务不是缓存，不要删除。",
    "",
    "## 主题绑定",
    "",
    "- 工作区固定采用 isolated：每个主题有自己的 root，禁止跨主题结构连线。",
    "- 用 topics 核对用户指定主题的稳定 topicId，显式传 --workspace；不要根据标题或显示编号拼接 ID 和路径。",
    "- 前端打开主题只是阅读状态，不代表其他 Agent 对话的目标；不要猜测全局 activeTopic。",
    "- 新主题用 create-topic 原子创建主题和独立起点，已有库不要再次 init。",
    "",
    "## 维护方式",
    "",
    "- 推荐通过同版本 CLI 和本机服务托管修改；程序在写入前检查版本与最终结构，并通过文件事务保存。",
    "- 在线读取和写回的凭据统一在顶层 refs[nodeId]，后续命令使用其中的 token；离线 refs 为空，不能写入。",
    "- 已有节点身份由稳定 nodeId 确定；编号、布局和 HTML 是派生结果，不通过修改生成物维护内容。",
    "- 授权直接编辑 Markdown 时，不能与托管提交同时改同一批文件；服务在文件变化后重新校验，但不产生最近更新标记。",
    "- 出现诊断或怀疑结构损坏时再 validate，不将全图校验作为每次保存的固定步骤。",
    "",
    "## 命令",
    "",
    "使用用户提供的实际程序入口；下文 aichat 可替换为该入口，<ws> 替换为本工作区绝对路径。",
    "程序命令不依赖 Skill；讨论的组织、写作和确认方法由用户启用的 Skill 或本次要求决定。",
    "",
    "- aichat --help／aichat <命令> --help：命令入口与当前参数；不需要工作区或服务。",
    "- aichat version／aichat whoami --workspace <ws>：程序版本与实际服务身份。",
    "- aichat topics --workspace <ws>／aichat read <topicId> --workspace <ws>：主题定位与概览。",
    "- aichat read --node <id> --workspace <ws>：节点正文和在线写入凭据。",
    "- aichat create-topic、edit、next、branch：创建主题及单项内容修改；参数按命令帮助提供。",
    "- aichat batch／insert／rearrange：分别用于混合修改、链中插入及现有节点重连；详见对应命令帮助。",
    "",
  ].join("\n");
}

const AGENTS_MARKDOWN_FILENAME = "AGENTS.md";

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.lstat(absolutePath);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * 在新目录初始化空工作区：workspace.json、topics/、.gitignore、AGENTS.md。
 * 先在目标同父目录的临时目录写满完整骨架，再 rename 发布到目标；
 * 目标已存在则拒绝，不初始化 Git，也不创建示例思想。
 */
export async function initWorkspace(
  options: InitWorkspaceOptions,
): Promise<InitWorkspaceResult> {
  const requestedRoot = path.resolve(options.root);
  const parent = path.dirname(requestedRoot);
  const targetName = path.basename(requestedRoot);
  if (targetName === "" || parent === requestedRoot) {
    throw new StorageError("INVALID_ARGUMENT", `无法初始化该路径: ${requestedRoot}`);
  }
  if (await pathExists(requestedRoot)) {
    throw new StorageError("WORKSPACE_EXISTS", `目标目录已存在，拒绝覆盖: ${requestedRoot}`, {
      path: requestedRoot,
    });
  }
  const parentStat = await fs.stat(parent).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) {
      throw new StorageError("INIT_FAILED", `父目录不存在: ${parent}`, { cause: error });
    }
    throw error;
  });
  if (!parentStat.isDirectory()) {
    throw new StorageError("INIT_FAILED", `父路径不是目录: ${parent}`);
  }

  if (targetName.startsWith(".")) {
    throw new StorageError(
      "INVALID_ARGUMENT",
      `目标目录名不能以点开头（避免隐藏工作区）: ${targetName}`,
    );
  }
  const workspaceId = options.workspaceId ?? `w_${randomUUID().replace(/-/g, "")}`;
  const name = options.name ?? targetName;
  const workspaceJson = `${JSON.stringify(
    {
      schemaVersion: 2,
      topicMode: "isolated",
      workspaceId,
      name,
      activeNode: null,
    },
    null,
    2,
  )}\n`;
  const agentsMarkdown = options.agentsMarkdown ?? buildAgentsMarkdown(name);

  const stagingName = `.${targetName}.${randomUUID()}.init`;
  const staging = path.join(parent, stagingName);
  const files: Array<{ path: string; content: string }> = [
    { path: WORKSPACE_FILENAME, content: workspaceJson },
    { path: ".gitignore", content: DEFAULT_GITIGNORE },
    { path: AGENTS_MARKDOWN_FILENAME, content: agentsMarkdown },
  ];

  try {
    await fs.mkdir(staging);
    await fs.mkdir(path.join(staging, TOPICS_DIR));
    await fs.mkdir(path.join(staging, ".aichat", "cache"), { recursive: true });
    await fs.mkdir(path.join(staging, ".aichat", "local"), { recursive: true });
    await fs.mkdir(path.join(staging, ".aichat", "runtime", "transactions"), {
      recursive: true,
    });
    for (const file of files) {
      const relativePath = normalizeRelativePath(file.path);
      const absolutePath = path.join(staging, ...relativePath.split("/"));
      await fs.writeFile(absolutePath, file.content, { encoding: "utf8", flag: "wx" });
    }
    // 发布前自检：骨架必须能被同一读取路径解析，避免发布半成品。
    const stagedWorkspace = await fs.readFile(path.join(staging, WORKSPACE_FILENAME), "utf8");
    const stagedInfo = parseWorkspaceInfo(stagedWorkspace);
    if (stagedInfo.workspaceId !== workspaceId || stagedInfo.schemaVersion !== 2) {
      throw new StorageError("INIT_FAILED", "初始化自检失败：工作区身份或格式不一致");
    }
    // 发布：rename 不会覆盖已存在目录，目标被并发创建时安全失败。
    try {
      await fs.rename(staging, requestedRoot);
    } catch (error) {
      if (isErrnoCode(error, "EEXIST") || isErrnoCode(error, "ENOTEMPTY") || isErrnoCode(error, "EPERM")) {
        throw new StorageError("WORKSPACE_EXISTS", `目标目录已存在，拒绝覆盖: ${requestedRoot}`, {
          path: requestedRoot,
          cause: error,
        });
      }
      throw error;
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof StorageError) throw error;
    throw new StorageError("INIT_FAILED", `初始化工作区失败: ${requestedRoot}`, {
      cause: error,
    });
  }

  const publishedRoot = await fs.realpath(requestedRoot);
  const published = [] as Array<{ path: string; sha256: string }>;
  for (const file of files) {
    // 哈希取自发布后的实际字节，而不是内存中的字符串。
    const bytes = await fs.readFile(path.join(publishedRoot, ...file.path.split("/")));
    published.push({ path: file.path, sha256: sha256Bytes(bytes) });
  }
  return {
    root: publishedRoot,
    workspaceId,
    files: published,
  };
}
