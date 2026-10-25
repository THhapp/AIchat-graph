import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StorageError, isErrnoCode } from "./errors.js";
import { sha256Bytes } from "./hash.js";
import { parseWorkspaceInfo } from "./workspace.js";
import { normalizeRelativePath } from "./paths.js";
import { DEFAULT_WORKSPACE_SCHEMA_VERSION, WORKSPACE_FILENAME, TOPICS_DIR } from "./format-v2.js";
import type { WorkspaceSchemaVersion } from "./format-v2.js";

export interface InitWorkspaceOptions {
  /** 新建工作区的目标目录；必须不存在。 */
  root: string;
  /** 工作区显示名，默认取目录名。 */
  name?: string;
  /** 写入的工作区格式；新工作区默认 2，1 仅为兼容旧测试与显式要求。 */
  schemaVersion?: WorkspaceSchemaVersion;
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
 * 生成的维护指南：只讲这个工作区怎么用，不复制架构正文。
 * 必须与真实文件格式一致——每张卡片是一个 Markdown 文件，标题在 YAML 头里。
 */
function buildAgentsMarkdown(name: string): string {
  return [
    "# " + name,
    "",
    "这是 AIchat-graph 工作区：一个节点一份 Markdown。讨论内容只写在 topics 下的文件里，程序据此生成图。",
    "",
    "## 结构",
    "",
    "- workspace.json：工作区身份与 activeNode（当前讨论焦点，不是用户选中的卡片）。",
    "- topics/<主题目录>/topic.md：只放该主题的 topicId 与 title，正文留空。",
    "- topics/<主题目录>/<节点ID>.md：一份文件一张真正存在的卡片，标题、状态、连接写在自己的 YAML 头里。",
    "- .aichat/：可重建缓存与运行中服务的事务日志。未恢复事务不是缓存，不要删除。",
    "",
    "## 卡片文件",
    "",
    "YAML 头只有这些字段，不接受其他字段：",
    "",
    "~~~yaml",
    "---",
    "nodeId: n_00000000000000000000000000000001",
    "title: 跨对话复用",
    "state: proposed",
    "from: n_00000000000000000000000000000002",
    "flow: branch",
    "description: 把一般协作约定具体化为新会话的续谈方法",
    "side: left",
    "order: 20",
    "---",
    "正文从这里开始，可以自由使用 Markdown 标题、代码、表格。",
    "~~~",
    "",
    "- nodeId／title／state／from／flow 必需。root 的 from 写 null 且不写 description；其他节点必须有非空 description，说明为什么接到来源。",
    "- state 取 agreed／proposed／reference；新提议默认 proposed，不要从来源继承 agreed。重要标记写 important: true，缺省不写该字段。",
    "- flow 取 root／next／branch。branch 可省 side／order，省略时按右侧与稳定顺序；新增分支的 order 取同源最大值加 10。",
    "- 标题只写在 YAML 头里，正文不要再写同名标题。",
    "",
    "## 主题绑定",
    "",
    "- 新格式 2 工作区采用 isolated：每个主题有自己的 root，禁止跨主题结构连线。旧库未声明 topicMode 时沿用 shared，不自动转换。",
    "- 先用 aichat topics 按用户给出的名称或续谈提示解析并绑定 topicId；重名或目标不明才询问，后续沿用绑定。",
    "- 前端打开主题只是阅读状态，不代表其他 Agent 对话的目标；不要猜测全局 activeTopic。",
    "- 新主题用 aichat create-topic --topic-title <名称> [--directory <一级目录>] --body-file <文件>，原子创建主题和独立起点。",
    "- 搜索已有主题内容可用 aichat search <关键词> --topic <topicId>。",
    "",
    "## 维护方式",
    "",
    "- 先读相关节点文件，再原位改需要的部分；没有实质变化不新建卡片，不按聊天轮次留副本。",
    "- 同一批修改只用一种方式：直接编辑 Markdown，或经运行中的服务用 aichat apply 托管提交。",
    "- 移动或改名文件时保留 nodeId：身份来自 nodeId，不来自文件名。隔离模式移入其他主题前必须显式处理连接，不能把跨主题关系当作合法结构。",
    "- 删除只用于没有后继的卡片；有后继时先显式重接，不隐式丢掉整棵子树。",
    "- 结构不确定时先跑 aichat validate 看诊断，再修改。",
    "",
    "## 命令",
    "",
    "在工程目录执行，或把入口换成对应路径：",
    "",
    "- aichat topics／search：定位主题与已有卡片",
    "- aichat read --node <id>／read <topicId 或路径>：读正文、真实文件路径与当前 SHA-256",
    "- aichat validate：校验当前磁盘结构",
    "- aichat check --input <json>：只验证一次变更，不写盘",
    "- aichat apply --input <json>：经 aichat serve 启动的服务托管提交（需带真实旧哈希）",
    "",
    "直接编辑也可用，服务会在文件变化后重新校验；不要与托管提交同时改同一批文件。",
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
  // 新工作区默认格式 2；格式 1 只用于显式兼容旧数据。
  const schemaVersion = options.schemaVersion ?? DEFAULT_WORKSPACE_SCHEMA_VERSION;
  const workspaceJson = `${JSON.stringify(
    {
      schemaVersion,
      topicMode: schemaVersion === 2 ? "isolated" : "shared",
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
    if (stagedInfo.workspaceId !== workspaceId || stagedInfo.schemaVersion !== schemaVersion) {
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
