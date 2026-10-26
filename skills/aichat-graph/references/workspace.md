# 工作区与目录职责

首次接入、换工作区、定位主题或检查安装副本时查阅，不是每轮的扫描清单。

## 分清位置与授权

| 位置 | 职责 |
| --- | --- |
| CLI／程序安装目录 | 运行产品，不保存用户思想 |
| 讨论工作区 | 主题、实体节点及工作区配置 |
| 主题 HTML 目标 | 前端指定，由程序自动生成的完整阅读成品 |

知识库只在需要提炼时处理，不每轮双写。
不要把程序、工作区、HTML 目标或当前 shell 目录当作同一个位置。
本机绝对路径不固化进通用 Skill。

入口从用户给定信息、已配置命令或宿主实际加载的约定取得。
不假定任意目录的 AGENTS.md 都会被宿主加载，也不依赖其他聊天的隐藏记忆。
可见入口保存稳定位置和维护约定即可，不复制整份 Skill 或记录每轮状态。

记录授权不自动扩大为安装、初始化、迁移、批量提炼或服务管理授权。
已有具体授权可以沿用；目标明确时直接操作，只澄清真正影响本次任务的歧义。

## 主题选择与绑定

用户可以给主题名、目录、稳定 ID、续谈节点，或前端“复制给 Agent”的定位信息。
首次用 `topics --workspace '<工作区>'` 核对实际列表：

- 按用户给定的线索匹配；续谈节点先核对所属主题。
  标题和显示编号不是身份，不能据此拼 nodeId、topicId 或文件名。
- 唯一匹配就绑定工作区和 topicId，后续持续沿用，不每轮确认。
  主题重命名不等于创建了另一个主题。
- 重名时用真实目录、ID 或相关节点区分；没有匹配不默认新建。
- 用户明确要求新主题时，用 create-topic 创建主题与独立根，绑定返回的真实 ID。
  不因新开聊天、提到另一概念或浏览另一个主题而自动创建或切换。

在绑定主题内搜索使用 `search '<词>' --topic '<topicId>'`，并显式指定工作区。
跨主题比较可以有目的地读取，但不建立跨主题父边，也不默默改写对照主题。
主题隔离是组织与结构约束，不是读取权限屏障。

本对话的目标由用户意图和已核对的主题确定。
前端选中项、工作区 activeNode 与其他聊天的焦点都不替代绑定。
多段聊天可分别维护不同主题，不写入全局 activeTopic 作为聊天绑定。

## 当前图怎样阅读

全局主线在最左侧，next 沿本地纵轴向下；branch 向右展开，同源分支上下组织。
分支内部也有自己的纵向 next 链，再分出的方向继续向右。
完整分支区域可拉长原链的 next 间距，这是空间安排，不是新增逻辑连接。

程序安排坐标、共享干线、关系文字和派生编号。
现有 side 元数据不决定前端左右落点，不能靠改 side 或 order 微调卡片位置。
目录折叠与图上折叠互相独立；浏览时隐藏的内容仍存在于源记录与完整 HTML 中。

## CLI 与运行版本

Agent 使用与实际服务相同版本的 CLI 和 Skill，先区分以下位置：

| 使用方式 | CLI | Skill |
| --- | --- | --- |
| 仓库开发 | `<repo>/dist/cli/index.js` 或 `<repo>/aichat.cmd` | `<repo>/skills/aichat-graph` |
| 日用快照 | `<repo>/.local/daily/dist/cli/index.js` 或 `.local/daily/aichat.cmd` | 同一快照的 `skills/aichat-graph` |
| 已安装副本 | 本机 local.env.json 的 cli | 安装目录中的 SKILL.md、references 和 scripts |

源码变化不自动更新日用快照，日用更新也不会自动同步已安装副本。
开发库和正式讨论库分别绑定，不能因当前 shell 在源码目录就混用开发 CLI 写正式库。

仓库入口缺少 dist 时，构建按当前任务授权执行。
只构建 Node CLI 可用 `npm run build:node`；运行完整界面和导出需要完整构建。
版本与接口用 `version`、`whoami` 核对；程序手册随程序分发，Skill 自带完整命令参考见 commands.md。
不要仅凭仓库文档更新，就认定日用版或安装副本已支持新参数。

### Skill 自带启动脚本

[aichat.ps1](../scripts/aichat.ps1) 按以下顺序定位 CLI：

1. 显式 `-Cli '<入口>'`，给了却不存在时直接失败，不换用其他版本。
2. 按“脚本同目录 → Skill 根目录”读取 local.env.json 的 cli。
   配置缺失、损坏或入口不存在时，保留说明并继续查找。
3. 从仓库内 Skill 的 scripts 向上三级推导 dist/cli/index.js。
   先核对祖先确实包含本项目 Skill，不能把任意宿主祖先当成工程。
4. 都不可用时退出码 7，报告尝试路径和修复办法，不猜正式库或改写配置。

脚本与安装同步工具需要 PowerShell 7（pwsh）；仓库根目录的 start*.cmd 启动器
使用 Windows PowerShell 5.1。接入时核对实际命令环境，不混用两套脚本要求。

```powershell
pwsh -NoProfile -File '<Skill目录>/scripts/aichat.ps1' topics --workspace '<工作区>'
```

local.env.json 的 workspace、source 或启动器信息可作为本机定位线索；
包装脚本只从 cli 字段取得程序入口，不自动套用 workspace，也不执行 source 同步。
每条命令仍显式给出 `--workspace`。配置不进仓库，更新时保留其全部原始内容。

### 更新与安装副本

以下仅在用户要求安装或更新、且持有相应授权时执行：

- `update-daily.cmd` 从完整构建更新日用程序和 Skill，运行中拒绝替换。
  不强停用户服务、不迁移资料库、不自动拉取 GitHub。
- 已安装副本另用仓库的 `scripts/install-skill.ps1` 同步通用文件。
  必须显式给宿主 `-Host workbuddy|codex` 或绝对目录 `-Target`；两者不能同时给。
- `-Daily` 选择日用快照，显式 `-Source` 优先于它。
  同步只更新 SKILL.md、references、scripts，保留 local.env.json，不伪造本机绑定。

仅整理 Skill 说明或脚本排版、且核对日用与仓库的完整 CLI 构建同版时，
可用显式 `-Source` 和 `-Target` 单独同步日用的 skills/aichat-graph 目录。
这不替换程序、不结束服务；不能只比较入口 index.js 就认定全部命令同版。
CLI 能力或接口版本有变化时先更新对应程序与同版 Skill，不能用新说明覆盖旧版运行入口。
更新后用该副本入口执行 --help、version，必要时 whoami；文件哈希一致不等于宿主已重新加载。

```powershell
# 从仓库目录执行；只同步实际需要更新的宿主
pwsh scripts/install-skill.ps1 -Daily -Host codex
pwsh scripts/install-skill.ps1 -Daily -Host workbuddy
```

各宿主分别同步、分别核对，不能用一个副本的结果代表其他副本。
比较通用文件和配置哈希，使用该副本的包装脚本运行 --help，必要时再核对 whoami。
文件一致和帮助可用不等于宿主已重新加载 Skill，也不证明实际工作区在线可写。

## 工作区文件职责

```text
<工作区>/
  workspace.json
  topics/<主题目录>/
    topic.md
    <nodeId>.md
  .aichat/local/exports.json
  .aichat/cache/
  .aichat/runtime/
```

- workspace.json：工作区身份、格式、主题模式和讨论焦点，焦点不是聊天主题绑定。
- topic.md：主题元数据，不聚合复制全部节点正文。
- 节点 Markdown：正文与邻近结构元数据，是维护源。
- exports.json：本机导出目标，由前端／服务管理。
- cache：派生索引；runtime：服务定位、锁和恢复信息，不能随意清除。

实际路径取命令返回值，不按标题或编号猜文件名，也不在 Skill 复制完整 schema。
当前为 schemaVersion 2、topicMode isolated：每个主题独立根，父边不能跨主题。
init 用于不存在的新目录；已有库不能重新初始化或因创建主题而清空。

托管写入优先。授权直接编辑时，同一批不与托管提交并行，之后核对结构。
不手补哈希、删除恢复信息或修改生成物来绕过报错。
HTML 自动从有效源生成，不手动双写；日常读取实体节点，避免加载内嵌脚本与字体的大文件。
附件按用户明确需求处理，不预建附件库、归档或报告目录。
