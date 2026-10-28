# 接入与主题绑定

首次接入、换工作区、定位主题或核对宿主绑定时查阅，不是每轮扫描清单。
完整命令行为在随附 commands.md；程序构建、日用发布和宿主安装属于独立维护任务。

## 位置与授权

| 位置 | 职责 |
| --- | --- |
| CLI／程序安装目录 | 运行产品，不保存用户思想 |
| 讨论工作区 | graph.sqlite、resources/ 和本机配置 |
| 主题 HTML 目标 | 前端指定、程序自动生成的完整阅读成品 |

知识库只在需要提炼时处理，不每轮双写。程序、工作区、HTML 目标和当前 shell 目录不是同一个位置。
本机绝对路径不固化进通用 Skill；从用户给定信息、已配置命令或宿主入口取得程序与工作区。
记录授权不自动扩大为安装、初始化、迁移、批量提炼或服务管理授权；目标明确时直接操作，只澄清影响本次任务的歧义。

## 主题选择与绑定

用户可给主题名、key、稳定 ID、续谈节点或前端“复制给 Agent”的定位信息。首次用：

    aichat topics --workspace <dir>

核对实际列表：

- 按用户线索匹配；续谈节点先核对所属主题。标题和显示编号不是身份，不能据此拼 nodeId/topicId。
- 唯一匹配就绑定工作区和 topicId，后续持续沿用，不每轮确认。主题重命名不等于新主题。
- 重名时用 key、ID 或相关节点区分；没有匹配不默认新建。
- 用户明确要求新主题时，用 create-topic 创建主题与独立 root，绑定返回的真实 ID；不因新开聊天自动创建或切换。

绑定主题内搜索：

    aichat search '<词>' --topic '<topicId>' --workspace <dir>

跨主题比较可有目的地读取，但不建立跨主题父边，也不默默改写对照主题。主题隔离是组织与结构约束，不是读取权限屏障。
前端选中项、activeNode 与其他聊天焦点不替代本对话绑定。

## 图怎样阅读

全局主线在最左侧，next 沿本地纵轴向下；branch 向右展开，同源分支上下组织。分支内部也有自己的纵向 next 链，再分出的方向继续向右。
程序安排坐标、共享干线、关系文字和派生编号。side 元数据不决定前端左右落点，不能靠改 side/order 微调位置。
目录折叠与图上折叠互相独立；浏览时隐藏的内容仍在库与完整 HTML 中。

## CLI 与运行版本

Agent 使用与实际服务相同版本的 CLI 和 Skill：

| 使用方式 | CLI | Skill |
| --- | --- | --- |
| 仓库开发 | <repo>/dist/next/cli.js 或 <repo>/aichat.cmd | <repo>/skills/aichat-graph |
| 日用快照 | <repo>/.local/daily/dist/next/cli.js | 同一快照的 skills/aichat-graph |
| 已安装副本 | 本机 local.env.json 的 cli | 安装目录中的 SKILL.md、references 和 scripts |

源码变化不自动更新日用快照；日用更新不会自动同步已安装副本。开发库与正式库分别绑定，不混用。
version、whoami 核对接口与身份；Skill 自带完整命令参考，不依赖程序手册路径。记录任务遇到 dist 缺失或接口不匹配时说明缺口；按已有授权启动同版服务，不因记录讨论自动重建、替换快照或迁移资料。
不要仅凭仓库文档更新，就认定日用版或安装副本已支持新参数。

### Skill 自带启动脚本

[aichat.ps1](../scripts/aichat.ps1) 按顺序定位 CLI：

1. 显式 -Cli <入口>，给了却不存在时失败，不换其他版本。
2. 按“脚本同目录 → Skill 根目录”读取 local.env.json 的 cli；配置缺失或入口不存在时保留说明并继续。
   若本机配置仍指向旧入口 dist/cli/index.js，脚本按同版本 Skill 解析到同目录的 dist/next/cli.js，不改写 local.env.json。
3. 从仓库内 Skill 的 scripts 向上推导 dist/next/cli.js；先核对祖先确实包含本项目 Skill。
4. 都不可用时退出 7，报告尝试路径和修复办法，不猜正式库或改配置。

需要 PowerShell 7（pwsh）；每条命令仍显式给 --workspace。local.env.json 不进仓库，更新时保留原内容。
文件一致、--help 可用、宿主已加载和工作区在线可写是分别需要核对的状态。

## 工作区文件职责

    <工作区>/
      graph.sqlite
      resources/
      .aichat/runtime/service.json
      .aichat/local/exports.json

- graph.sqlite：唯一主存储，保存主题、节点正文、显式摘要、状态、连接、入边说明、顺序、important、revision 和请求结果。
- resources/：正文图片等资源；正文使用 resources/ 键或 aichat:node/<id> 链接。
- service.json：本机服务描述（实例、URL、进程），由程序维护，不手工编辑。
- exports.json：本机 HTML 目标，由前端／服务管理，不是内容真源。

不再有 workspace.json、topics/、节点 Markdown、文件哈希或 editRef。旧版 V2 目录需要时用 import 一次性读入；原文件不动，之后运行链只读 graph.sqlite。
init 只用于不存在或空目录；已有 graph.sqlite 拒绝覆盖。不要直接改数据库或 HTML 来绕过报错。

## 宿主安装

Skill 可直接从程序随附目录读取，也可安装到宿主。已安装副本需要仍存在的程序入口；移动程序后按授权更新绑定，不能靠旧 source 自动切换。
需要安装或更新时，按独立任务授权同步通用文件并分别核对宿主。CLI 接口变化须对应更新程序、服务和 Skill；只同步说明不能升级旧程序。文件一致、help 可用、宿主加载和在线可写分别核对。
