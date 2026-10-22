/** 简短用法；只列已实现命令，不描述未实现的能力。 */

export const USAGE = [
  "aichat <command> [options]",
  "",
  "Read (offline, straight from disk):",
  "  topics --workspace <path>                   列出主题（V1 单文件／V2 一节点一份）",
  "  search <query> --workspace <path> [--topic <topicId>] [--limit <n>] [--page <n>]",
  "                                              搜索标题／摘要／正文（默认 10 项，最多 100）",
  "  read <topicId|relative-path> --workspace <path>",
  "  read --node <id> [--node <id> ...] [--start <n>] [--length <n>|--full]",
  "                                              真实磁盘正文；默认 4000 UTF-16，--full 取全文",
  "  validate --workspace <path>                 校验磁盘结构与全图",
  "",
  "Write (online, needs a running serve for this workspace):",
  "  read --node <id>                            有服务时返回 editRef；离线读取不带可写凭据",
  "  edit --ref <ref> [--title ...] [--body-file <f>|--body-stdin|--append-file <f>|--replace-file <f>]",
  "  branch --from-ref <ref> --title <t> --description <d> (--body-file <f>|--body-stdin|--body <b>)",
  "  next --from-ref <ref> --title <t> --description <d> (--body-file <f>|--body-stdin|--body <b>)",
  "                                              纵向后继；来源已有 next 时明确 409，不挤掉旧主线",
  "  connect --ref <ref> --description <d> [--from-ref <ref>] [--flow ...] [--side ...] [--order <n>]",
  "  create-topic --topic-title <t> [--directory <name>] [--title <t>] (--body-file <f>|--body-stdin|--body <b>)",
  "                                              isolated 模式创建主题和独立起点；目录碰撞拒绝",
  "  create-root --topic-title <t> --title <t> (--body-file <f>|--body-stdin|--body <b>)",
  "  check --input <json>                        只验证一次底层变更集合（不写盘）",
  "  apply --input <json>                        提交底层变更集合（须带真实旧哈希）",
  "  status <requestId>                          查询请求状态；unknown 不证明成功或失败",
  "",
  "Migration (isolated; never in place):",
  "  migrate --source <v1-dir> --destination <new-dir> [--preview] [--descriptions <json>]",
  "                                              格式 1 → 格式 2，目标必须不存在",
  "",
  "Workspace / service:",
  "  init <path> [--name <name>] [--format <1|2>]  新建工作区（默认格式 2，不覆盖已有目录）",
  "  serve --workspace <path> [--port <port>]      启动本机服务（默认 127.0.0.1:4317）",
  "  whoami --workspace <path>                     核对服务与磁盘身份",
  "",
  "Global options:",
  "  --workspace     省略时使用当前目录（serve 除外，必须显式给出）",
  "  --json          机器可读 JSON（默认）",
  "  --text          简短人类摘要",
  "  -h, --help      显示帮助",
  "",
  "备注：read 不读缓存快照；apply 只连接 --workspace 描述文件声明的同一服务，",
  "      身份不一致或描述文件陈旧时拒绝，不回退默认端口。",
].join("\n");

export const COMMAND_USAGE: Record<string, string> = {
  init: "aichat init <path> [--name <name>] [--format <1|2>] [--json|--text]",
  serve: "aichat serve --workspace <path> [--port <port>] [--json|--text]",
  topics: "aichat topics --workspace <path> [--json|--text]",
  search:
    "aichat search <query> --workspace <path> [--topic <topicId>] [--limit <1-100>] [--page <n>] [--json|--text]",
  read: [
    "aichat read <topicId|relative-path> --workspace <path> [--json|--text]",
    "       aichat read --topic <topicId|relative-path> --workspace <path>",
    "       aichat read --node <nodeId> [--node <nodeId> ...] [--start <n>]",
    "                  [--length <1-16000>|--full] [--section <title> [--section-index <n>]]",
    "                  [--offline] [--workspace <path>] [--json|--text]",
  ].join("\n"),
  validate: "aichat validate --workspace <path> [--json|--text]",
  edit: [
    "aichat edit --ref <editRef> [--title <t>] [--state agreed|proposed|reference] [--summary <s>]",
    "            [--body <text>|--body-file <file>|--body-stdin]",
    "            [--append-file <file> | --replace-file <json>] [--workspace <path>]",
  ].join("\n"),
  branch: [
    "aichat branch --from-ref <editRef> --title <t> --description <why>",
    "               (--body <text>|--body-file <file>|--body-stdin)",
    "               [--state ...] [--side left|right] [--order <n>] [--workspace <path>]",
  ].join("\n"),
  next: [
    "aichat next --from-ref <editRef> --title <t> --description <why>",
    "             (--body <text>|--body-file <file>|--body-stdin)",
    "             [--state ...] [--topic-id <topicId>] [--workspace <path>]",
  ].join("\n"),
  connect: [
    "aichat connect --ref <editRef> --description <why>",
    "                [--from-ref <editRef>] [--flow root|next|branch] [--side left|right] [--order <n>]",
  ].join("\n"),
  "create-topic": "aichat create-topic --topic-title <t> [--directory <单层目录>] [--title <t>] (--body-file <f>|--body-stdin|--body <b>) [--state ...] [--workspace <path>]",
  "create-root": [
    "aichat create-root --topic-title <t> --title <t>",
    "                    (--body <text>|--body-file <file>|--body-stdin) [--state ...] [--workspace <path>]",
  ].join("\n"),
  check: "aichat check --input <json> --workspace <path> [--json|--text]",
  apply: "aichat apply --input <json> --workspace <path> [--json|--text]",
  status: "aichat status <requestId|--input <json>> --workspace <path> [--json|--text]",
  whoami: "aichat whoami --workspace <path> [--json|--text]",
  migrate: [
    "aichat migrate --source <v1-dir> --destination <new-dir> [--preview]",
    "                 [--descriptions <nodeId→description JSON>] [--json|--text]",
  ].join("\n"),
};

export function usageFor(command: string | undefined): string {
  if (command && COMMAND_USAGE[command]) {
    return "Usage: " + COMMAND_USAGE[command] + "\n\n" + USAGE;
  }
  return "Usage: " + USAGE;
}

/** 错误输出用的简短用法：只给当前命令，未知命令给命令索引。 */
export function briefUsage(command: string | undefined): string {
  if (command && COMMAND_USAGE[command]) return "Usage: " + COMMAND_USAGE[command];
  return (
    "Usage: aichat <command> [options]\n" +
    "Commands: init serve topics search read validate edit branch next connect create-root create-topic migrate check apply status whoami"
  );
}