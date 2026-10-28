# 开发与工程约束

本文是工程与验证约束；产品、命令和 Agent 协作分别见 README、[程序 CLI 手册](docs/cli.md) 和 [Skill](skills/aichat-graph/SKILL.md)。

## 文档维护边界

- 先读 README 了解产品；本文件按任务查阅，不要求每次全读。
- 文档按职责维护，不复制产品命令表。主控负责设计、调度、集成、验收和收尾文档；实现者只改任务授权文件。
- 不按轮次新增 REPORT、HANDOFF、状态副本或历史备份；移动或删除文档时检查源码注释和入链。
- 公开仓库不得含本机用户名、私人绝对路径、真实用户内容、凭据或本机运行配置。
- AGENTS.md 的协作规则只留本机，不上传公开仓库。

## 开发与固定运行版本

环境以 package.json 的 engines 和锁文件为准，统一用 npm ci。已验证 Node.js 24.17.0、npm 11.13.0；node:sqlite 在这个 Node 版本是 release candidate，项目不承诺旧 Node。

| 用途 | 程序位置 | 资料与配置 | Windows 入口 |
| --- | --- | --- | --- |
| 源码开发 | 仓库 src/、dist/ | .local/development-workspace、独立本机配置 | start-dev.cmd，4318 |
| 固定版本 | .local/daily、独立运行依赖 | 仓库外资料库、launcher.local.json | start.cmd，4317 |

固定版本是本机构建快照，不是源码分支或安装包；源码变化不自动更新它，讨论资料不复制进去。两套配置互不继承，开发入口拒绝与已绑定正式库相同或相互包含的目录。

    npm ci
    ./start-dev.cmd
    # -NoBrowser 只启动服务；-Help 查看选项

启动器发现同一测试库已有同接口服务时直接复用。试用源码改动时先停开发服务窗口，再运行 start-dev.cmd；日用窗口可继续运行。update-daily 只在构建完成且服务停止时执行；不能强停其他进程。

## 模块与数据流

- src/next/protocol.ts、model.ts、store.ts、read.ts 是当前领域、SQLite 边界和读取投影的核心；interfaceVersion 由 build-info 统一报告为 4。
- CLI 的命令、参数、help 和错误模型在 src/next/args.ts、cli.ts、client.ts、config.ts；凭据、写入动作和读取结果与协议共享类型。
- 本机服务在 src/next/server.ts、runtime.ts：打开 GraphStore，持有 instanceId 和 SSE，写/删 descriptor，协调导出；没有源 MD watcher、writer.lock 或文件事务恢复。
- HTML 导出在 src/next/export.ts；领域文档直接来自 GraphStore 快照，复用 src/export 的 render/capture/reader 资源。
- 旧 V2 文件只为 src/next/import.ts 一次性读取保留；正常 CLI、服务和读取链不导入旧解析器。

主进程可以同时打开一个 GraphStore 写连接；SQLite WAL、BEGIN IMMEDIATE 和 busy timeout 负责本地串行。无多进程写锁；后启动实例覆盖 descriptor，先启动实例停止时只清理自己的描述文件。

## 存储与版本

workspace 目录：

    graph.sqlite
    resources/
    .aichat/runtime/service.json
    .aichat/local/exports.json

graph.sqlite 表：workspace、topics、nodes、requests。workspace 有持久 workspaceId、name、activeNode、revision；topics 有稳定 topicId、key、title、revision、last_change_at/last_change_ids；nodes 有稳定 nodeId、topicId、title、body、可空显式 summary、state、from、flow、description、side、order、important、revision；requests 保存 requestId、请求体哈希、最终结果和状态。

- node revision 只在该节点真实变化时递增；重要性变化也递增，但不进入最近内容更新。
- topic revision 只在该主题节点或主题标题变化时递增；workspace revision 只在有真实提交时递增。
- 服务重启不重置任何 revision；无关主题不使其他节点失效。
- 显式 summary 为空用 null 表示，读取时沿用从正文首段派生的摘要；不把派生摘要写成显式摘要。
- 编号、坐标、children、布局缓存不进入主存储；side 作为既有元数据保留，不恢复左右布局。
- 数据库 schemaVersion 独立于程序版本和 interfaceVersion，目前为 1；本轮从 Markdown 一次导入，不建设旧数据库迁移平台。

## Agent 写入与读取边界

单卡 edit 与 batch edit 共用 NodePatch：title、state、summary（null 清除）、body、append、replace、important、incoming（from/flow/description/order）。所有节点修改使用读取所得的 {id,revision}；服务不能预读最新版本静默代填旧修改。

写入动作包括 createTopic、createNext/createBranch、batch（edit/create/delete）、insert、rearrange、setImportance、delete。最终候选在同一事务校验并写入：唯一 root、唯一 next、无环、同主题、不可自连、不可跨主题；删除只允许叶卡，root 不可删。不得自动挤掉已有 next 后继。

batch 支持话题内 edit/create/delete 与 local 别名；insert 只接受当前真实相邻 after→before；rearrange 表达最终连接；dry-run 只返回 checked/changes。请求按 requestId+请求体哈希幂等；同 id 不同请求体 409；请求结果存 requests 表。

读取视图 overview/structure/content/resume 都是同一快照上的纯投影。content 的正文按 UTF-16 安全切片；cursor 绑定相关节点 revision，变化后返回 409 STALE_READ。resume 只给 anchor 正文、必要来路、直接邻居和少量 important/最近节点，不倾倒全图，不生成模型摘要。

## 事务、SSE 与导出

GraphStore.commit 在一个 BEGIN IMMEDIATE 中完成候选计算、校验、revision、最近更新和持久化；失败整体回滚。提交成功后 runtime 计算受影响主题，广播 snapshot SSE，并调度导出。

导出用同一已提交快照组装 OfflineTopicDocument；目标从 .aichat/local/exports.json 读取。要求：

- 目标只能是工作区与应用根之外的绝对 .html；拒绝符号链接逃逸、目录、UNC/设备路径和无关已有文件。
- 先计算、后写盘；同一路径原子替换，失败保留旧成品，外部改动拒绝覆盖。
- 解绑只删配置，不删已有成品；资源只从 workspace/resources 读取并内联 data URI。
- 独立 HTML 完整自包含；实时页面和离线页面共用现有布局与阅读组件。

## 前端排版规则

保留既有主题目录、主线/分支、卡片、连线、标签、重要标记、最近更新、阅读位置、折叠和独立 HTML 视觉。Web 只依赖领域 DTO（GraphNode/GraphTopic/详情 body/revision/resources），不依赖 SQLite、文件路径、文件哈希或源码 ranges。

- 每个主题 root 在最左；next 向下；branch 向右；同一来源多个分支右侧上下排列并共用干线。
- 标题完整显示；连接说明在自己的支线旁；编号由服务派生，不用于 ID。
- 正文 Markdown 支持代码、表格、公式、受限本地图片；链接只解释 #anchor、http(s)、aichat:node/<id> 和 resources/ 键，不把任意相对文件路径当可读文件。
- 详情显示主题 key、节点 revision 和数据来源；不显示源 MD 路径或哈希。
- 实时和离线资源映射分开：实时是同源 /api/resources URL，离线是内联 data URI；不在浏览器发起任意网络请求。

## 验证与交付

按实际改动选择验证，优先复用现有测试：

- 领域 / store：npx vitest run tests/next/import.test.ts tests/next/server.test.ts；新规则补针对性测试。
- CLI：npx vitest run tests/next/cli.test.ts；真实命令在临时库执行 init/topics/create-topic/edit/read/resume/status。
- Web：npm run typecheck:web、npx vitest run tests/web、npm run build:web。
- 导出：npx vitest run tests/next/export.test.ts；真实服务绑定临时 .html，改内容后确认自动重建且失败保留旧成品。
- 全量构建：npm run typecheck（node）与 npm run build；需要更完整回归时再跑全量 vitest。

不追求覆盖率、全故障矩阵、哈希清单或截图材料；正文保真、版本冲突、导入完整性、导出失败保留等关键新规则必须有具体检查。主控核对真实文件和命令结果，不以子任务结论代替验收。

## 开源分发

- 仓库含源码和 Skill；不提交 .local/、*.local.json、依赖、dist 或本机配置。
- 根 aichat.cmd 指向 dist/next/cli.js；固定版本目录由 daily-snapshot 复制新入口、docs/cli.md 和 aichat.cmd。
- 本机 Codex/WorkBuddy 安装副本安装前先更新日用构建；新版 Skill 不指向旧版 CLI。
- Git 提交和推送到既有 origin/main 需在正常验证后进行；不强推、不改远程、不建正式 Release。
