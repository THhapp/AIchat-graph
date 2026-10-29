# 接入与主题绑定

首次接入、换工作区或目标不明确时查阅；已完成绑定后沿用，不每轮重新接入。
本页说明定位与协作边界，命令细节见随附[命令参考](commands.md)。

## 定位程序与资料

| 位置 | 职责 |
| --- | --- |
| 程序目录 | CLI、服务、阅读器和导出资源 |
| 讨论工作区 | graph.sqlite、resources/ 及 .aichat/ 本机状态 |
| HTML 目标 | 用户通过前端指定的独立只读成品 |

工作区正文在数据库中，仍使用 Markdown 语法；没有日常维护的节点 .md 文件。
旧文件若仍在，属于一次性导入的原件，不参与后续维护。

从用户给出的入口、已配置命令或宿主绑定取得位置。
程序不依赖 Skill 安装；未注册 aichat 命令时，使用实际 aichat.cmd 或 `node <CLI.js>`。
不把通用 Skill 写成本机绝对路径表。

## 工作区与身份

CLI 的目录选择顺序是 --workspace、AICHAT_WORKSPACE、程序根 .aichat/default.json。
config --workspace 保存默认目标；--workspace-id 只核对所选库，不能只凭它查找目录。
便携包、源码开发快照、开发库是不同程序根，配置时用实际入口；
不因当前 shell 位于仓库就写正式库。便携包默认配置随程序根 .aichat/ 保留，
更新程序时不会被替换。

已安装 Skill 的 local.env.json 可提供 cli、workspace 等定位线索；
便携包推荐 cli 指向包根 aichat.cmd，包装脚本直接使用同包 runtime\node.exe 与
app\dist\next\cli.js。包装脚本只使用 cli，不自动追加 workspace，也不执行 source 同步。
可显式传 --workspace，或在已有默认绑定时使用 --workspace-id。
程序首次打开不会安装 Skill；需要时由用户主动运行包内 app\tools\install-skill.ps1。

记录授权不自动扩大为安装、初始化或迁移。目标明确且已有授权时直接操作；
只澄清会改变本次记录目标或操作范围的真实歧义。

## 主题绑定

用户可以给名称、key、topicId、续谈节点或页面复制的信息。
先核对实际身份：可用 topics，已知节点或明确续谈信息也可直接读取并核对所属主题。

- 唯一匹配就绑定工作区和稳定 topicId，后续沿用；主题改名不等于新主题。
- 重名时用 key、ID 或相关节点区分；没有匹配不默认新建。
- 明确要求新主题时用 create-topic 创建主题与独立 root。
- 标题、显示编号和文件名不能拿来拼稳定 ID。
- 前端选中、activeNode 与其他对话焦点不替代本对话绑定。
- 跨主题比较可以按需读取，父边不能跨主题，写入仍受用户指定范围约束。

未知范围可读 overview；已知节点可用 `read --node` 直读正文；续谈用 resume。
这三种入口按实际需要选，不是每次必须经历的固定顺序。

## 图与文件的职责

全局主线在最左，next 向下；branch 向右，同源分支上下排列，枝内可以继续 next 和再分支。
完整分支区域可以拉长主线间距，程序负责坐标、编号、干线与标签。
side 不决定左右落点；order 用于逻辑分支顺序，不用来微调像素位置。

目录折叠与图上折叠独立；隐藏内容仍在数据库和完整 HTML 内。
资源使用 resources/... 键，内部卡片链接可用 `aichat:node/<id>`。
HTML 位置由用户选择，取消绑定不删成品；知识库只在需要提炼时处理。

## 运行版本和宿主入口

| 使用方式 | CLI | Skill |
| --- | --- | --- |
| Windows 便携包 | 包根 `aichat.cmd`（同包 runtime\node.exe） | `app\skills\aichat-graph` |
| 源码仓库 | `<repo>/dist/next/cli.js` 或根 aichat.cmd | `<repo>/skills/aichat-graph` |
| 已安装副本 | 本机 local.env.json 的 cli | 安装目录的 SKILL.md、references 和 scripts |

程序、服务和参考应对应实际接口；version / whoami 用于接入或排错，
不作为每轮记录前的固定步骤。接口不匹配或程序缺失时说明具体缺口，
不因记录任务自行重建或切换已安装程序。

[aichat.ps1](../scripts/aichat.ps1) 使用 Windows PowerShell 5.1，按顺序查找入口：

1. 显式 -Cli；给了却不存在则失败，不换用其他版本。
2. 脚本同目录或 Skill 根的 local.env.json.cli。
3. 随包 Skill 从 app/skills 相对位置使用 runtime\node.exe + app\dist\next\cli.js；
   源码仓库使用系统 node + dist/next/cli.js。
4. 均不可用则退出 7，给出尝试位置；不修改配置或猜资料库。

包装脚本对 .cmd 入口解析同包 runtime\node.exe 与 app\dist\next\cli.js；
对 .js 入口使用 node。
普通 Skill 同步保留本机配置；入口位置变了时，按授权只修正需要的绑定字段。
安装和日用更新属于维护任务，不要求记录 Agent 每次执行；文件已同步不代表宿主已重新加载。
