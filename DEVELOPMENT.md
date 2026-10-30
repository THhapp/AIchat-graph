# 开发与工程约束

产品见 [README](README.md)，程序命令见 [CLI 手册](docs/cli.md)，
协作记录方法见 [Skill](skills/aichat-graph/SKILL.md)。本文件按任务查阅。

## 文档维护边界

| 文档 | 职责 |
| --- | --- |
| README.md | 产品、开始使用、限制、隐私与许可入口 |
| docs/workspace.md | 工作区位置、配置、成品与旧资料一次导入 |
| docs/cli.md | 程序独立的 CLI 使用手册 |
| DEVELOPMENT.md | 工程操作、模块边界和实现约束 |
| skills/aichat-graph/ | 协作方法与随 Skill 分发的独立命令参考 |
| 本机 AGENTS.md | 个人角色、调度、授权与停止规则 |

程序手册与 Skill 命令参考分别自足，允许重复接口事实，各自服务其读者。
安装与快照维护不进入每轮讨论流程；Skill 方法不作为程序存储格式校验。
只更新实际受影响的文档，不新增逐轮 REPORT、HANDOFF、状态副本或历史备份。
移动文件时检查入链含义；本机路径、配置和真实资料不进入公开仓库。
根目录 AGENTS.md 及私有设计笔记仍留本机。

## 开发、日用与发布包

环境以 package.json 和锁文件为准。当前为 Node.js 24.17.0、npm 11.13.0；
node:sqlite 使用该版本自带实现，不要求额外数据库驱动。构建 Windows 包另需
64 位 MinGW-w64 gcc；运行发布包的用户不需要任何 Node、npm、Git、.NET 或 VC++。

| 用途 | 程序 | 资料与配置 | 入口 |
| --- | --- | --- | --- |
| 开发 | 仓库 src/、dist/ | .local/development-workspace、开发配置 | start-dev.cmd，4318 |
| 日用 | .local/daily 便携程序 | 仓库外资料库、.local/daily/.aichat | start.cmd，默认库偏好端口 |
| 发布 | .local/packages/AIchat-graph-<version>-win-x64 | 用户解压位置 | AIchat-graph.exe / aichat.cmd |

~~~powershell
npm ci
./start-dev.cmd
~~~

-NoBrowser 可只启动服务。开发启动器复用已运行的匹配服务，不因源码变化自动替换它。
试用新代码时先停止开发服务，再运行开发入口；正式日用可继续使用。
开发库不能与正式库相同或相互包含。

### 构建与更新日用便携程序

先完成改动与必要检查，然后：

~~~powershell
npm run build
npm run package:windows
~~~

package:windows 生成 .local/packages/AIchat-graph-0.1.0-win-x64/ 和同名 ZIP：
包内 Node 24.17.0、app/dist、生产 node_modules、原生薄入口、Skill 与安装器、
开始使用.md 和 distribution.json；不打包源码、测试、.local、本机配置或真实资料。
ZIP 是发布/分发产物，不提交到 Git。

update-daily.cmd 会先构建并打包，再用包内 update.js 把新程序替换到 .local/daily，
保留 daily/.aichat 和外部讨论库；检测到日用程序正在使用时拒绝更新，不强停进程。
更新后 start.cmd 直接运行 .local/daily/AIchat-graph.exe。
日用程序首次打开会写自己的 .aichat/default.json；更新器将其视为运行区并保留，
不再是旧快照更新器的额外目录限制。

### 端口、服务与正常退出

服务端口偏好保存在工作区 .aichat/local/runtime.json：省略 --port 时按
remembered preferredPort → 4317 → 系统空闲端口选择，只有绑定成功才记录；
显式 --port 精确使用。同一工作区用命名管道启动占位防止第二个写服务。

CLI open 只读/启动当前库服务并打开浏览器；stop 只请求服务自行退出，不按 PID 杀，
descriptor 缺失或连接拒绝视为 not-running。页面「程序」菜单提供相同能力，
停止后关闭 SSE、保留已加载内容且不自动重连。

CLI 的默认目录来自当前程序根 .aichat/default.json；便携包、源码仓库和开发快照
各自独立。开发与临时命令显式传工作区，避免继承日用默认值。

## 模块与数据流

| 模块 | 职责 |
| --- | --- |
| src/next/protocol.ts、model.ts | 领域记录、输入输出、图校验和编号 |
| src/next/store.ts | SQLite、最终候选、差异提交与请求结果 |
| src/next/read.ts | overview / structure / content / resume、预算与游标 |
| src/next/cli.ts、args.ts、client.ts、config.ts | 命令、帮助、输入、open/stop 服务接入和工作区定位 |
| src/next/installation.ts | 源码/便携布局、程序根、随包 Node、真实 Agent 入口与启动日志 |
| src/next/server.ts、runtime.ts | 本机 HTTP / SSE、服务描述、端口偏好、启动占位、运行控制和导出调度 |
| src/next/export.ts、src/export/ | 领域成品、资源捕获和独立 HTML 封装 |
| src/web/ | 实时及离线阅读组件、布局、视口状态与程序菜单 |
| src/next/import.ts | 旧 V2 资料的一次性导入 |
| src/portable/update.ts | 便携包本地替换，保留目标 .aichat，不处理讨论资料 |
| native/windows/launcher.c | 原生薄入口、目录选择、隐藏 Node 启动、停止/更新/打开本机 URL |
| scripts/package-windows.mjs | Windows x64 自包含包与 ZIP 构建 |

读取直接打开同一 SQLite；普通写入通过本机服务进入统一 GraphStore.commit。
成功提交后广播 SSE 并安排成品更新；没有源 MD watcher、文件事务或 writer.lock。
SQLite WAL、BEGIN IMMEDIATE 和 busy timeout 协调数据库写入。
当前没有多实例通知机制，日常使用维持一个服务；不把“可打开多个连接”当作协同能力。

旧解析模块仅供导入使用，不能再接回正常读写链。
Markdown AST 章节读取、正文渲染及确有调用者的 IO / 资源辅助仍保留。

## 存储与版本

工作区由 graph.sqlite、resources/ 和 .aichat/ 下的本机状态组成。
数据库包含 meta、workspace、topics、nodes、requests：
workspace 保存身份及总 revision；topics 保存 key、标题、版本和各自最近一批；
nodes 保存正文、摘要、连接、重要性及节点版本；
requests 保存有限的请求结果，用于幂等和 status。

- 节点真实变化才增加其 revision；重要性变化也增加，但不替换内容更新集合。
- 主题和工作区版本随实际变化更新；noop 不增加；服务重启不重置持久版本。
- summary 为 null 表示没有显式摘要，读取时按正文首段派生。
- 编号、坐标和 children 是派生值；side 只保留已有元数据，界面统一向右。
- 当前 interfaceVersion 为 5、schemaVersion 为 2；两者独立，前者是 CLI／服务协议版本，后者是数据库格式版本。
- nodes 表无 state 列。旧 v1 库只读打开可直接读取且不迁移；可写打开时一次性升级为 v2，保留 ID、正文、摘要、连接、顺序、important、节点 revision、主题最近更新与工作区 revision，不把升级记为最近更新。新库和导入均为 v2。
- interfaceVersion 常量只在 src/next/protocol.ts 定义，build-info 与程序信息直接复用，不另设副本。
- 旧 Markdown 导入仍读取旧 frontmatter 的 state 但忽略、不转成正文；它只是遗留导入格式，不属于新节点契约。

## 写入、读取与提交边界

单卡与 batch 使用同一 NodePatch：内容、摘要、important 和 incoming。
NodePatch / NodeCreate 不含 state，CLI 与 batch JSON 中出现时按未知字段拒绝。
已有节点按调用者提供的 id / revision 检查，不能预读最新值静默覆盖。
important 的独立设值允许仅给节点 ID；给版本时则检查版本。

候选一次表达最终结构，校验独立主题、唯一 root / next、无环、无自连和无跨主题父边。
insert 要求真实相邻；delete 只删最终叶卡且不删 root；不自动挤走未声明的 next。
正文 body / append / replace 互斥，片段替换必须唯一命中；summary:null 清除显式摘要。

GraphStore.commit 在同一事务保存节点差异、版本、每主题最近一批和请求响应。
普通写入按 ID 执行 INSERT / UPDATE / DELETE，不重建全库；全量导入仅留在 importState。
最终值没有变化时为 noop，业务行不写。仅重要性、纯删除和被动编号不替换最近内容更新，
删除时移除集合中已不存在的节点。

成功响应的 revision 是工作区版本，nodeRevisions 给实际目标的持久节点版本，
可直接用于下一次写入；新建、修改和 noop 的目标均适用，删除节点省略。
映射随响应保存，幂等重放不拼入最新版本；dry-run 不伪造提交后版本。
insert 的 after 仅为相邻前置条件，不作为修改目标返回。

事务内不夹 HTTP、模型调用或 HTML 渲染。提交成功后通知 / 导出失败不能声称数据回滚。
请求结果有限保留，status=unknown 不等于写入失败，不能据此盲目重发。

读取视图共用预算和正文切片，预算计入整次序列化输出。
当前 cursor 指纹包含主题 revision 和所选节点版本：同主题变化可能使其过期，
其他主题变化不影响。此规则与单卡写入版本检查分别处理。
resume 优先给 anchor 正文，来路和邻居为摘要级；较长内容按预算续读，不生成模型摘要。

## 阅读器与导出

保留现有主线、分支、卡片、连线、目录、重要性、最近更新和阅读位置。
当前讨论节点用中性的“当前”标记；不再显示节点确认状态标签、状态点或状态边色，重要、最近更新、选择／焦点与目录当前加粗仍保留。
Web 接收领域 DTO，不查询 SQL，也不依赖源 MD 路径、哈希或源码范围。
实例身份只用于服务连接等运行状态，不决定节点版本有效性。

资源由 resources/... 键定位；内部链接为 `aichat:node/<id>`，
外部链接和 Markdown 保留现有渲染边界。
实时资源使用同源 URL，离线成品内联资源；不额外抓取远程图片。

导出目标保存在 .aichat/local/exports.json，由页面选择：
目标位于工作区与应用根之外，保存完整主题；取消绑定不删除文件。
沿用先生成后替换、失败保留旧文件、拒绝覆盖外部改动和安全资源处理。
没有绑定时不生成 HTML；独立文件不会主动联网刷新。
已有成品不因程序或阅读器升级自动重写：只有主题内容变化或用户显式重新绑定／重导出时才用当前阅读器生成。新旧 HTML 都可读取，旧文件中多余的节点 state 字段会被忽略。

## 文档与 Skill 分发

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File app\tools\install-skill.ps1 -Host codex
powershell -NoProfile -ExecutionPolicy Bypass -File app\tools\install-skill.ps1 -Host workbuddy
~~~

Skill 是可选组件。程序首次打开不会安装或修改任何宿主目录；只有显式运行包内
app/tools/install-skill.ps1 才同步通用内容，默认保留 local.env.json 的 workspace。
便携副本的 cli 推荐指向包根 aichat.cmd；包装脚本据此直接使用同包 runtime\node.exe
和 app\dist\next\cli.js。源码副本可用 dist/next/cli.js，不添加旧入口兼容层。
安装器使用 Windows PowerShell 5.1 可执行语法，不要求 PowerShell 7。

日用更新与宿主同步是独立操作。需要修正安装位置时只修改实际需要的配置字段。
程序手册和 Skill 参考必须对应实际运行接口；只更新说明不会升级 CLI，
文件已同步也不证明宿主已重新加载。纯文档 / Skill 指引调整可同步文本，
不替换运行中的 dist 或中断服务。

## 检查与交付

以构建和集成为主，按改动复用现有检查：
核心 store / CLI / 服务控制在 tests/next，阅读器在 tests/web，布局在 tests/layout。
有具体缺陷或关键规则缺口再补最小回归，不把独立审查和材料清单设为固定交付。

源码改动收尾通常使用 npm run typecheck、受影响测试和 npm run build；
发布包改动再运行 npm run package:windows，并至少检查：

- 包内 runtime\node.exe 为 24.17.0，app\dist\next\cli.js 可运行；
- 解压后 aichat.cmd --version、open/stop 与 AIchat-graph.exe --stop 可用；
- 首次打开目录选择、默认库复用、端口偏好写入、正常退出；
- 用源包 update.js 替换另一份包时保留 .aichat，讨论库未改动；
- ZIP 不含 .local、源码、测试、真实资料、local.env.json 或本机配置。

依赖变化沿用 notices 生成与检查。文档整理只需核对真实命令、示例和链接。
通过后停止，不为证明稳定性重复全量运行、生成哈希清单或截图矩阵。

## 开源分发

项目使用 MIT，依赖和字体原文通过既有声明生成器汇集。
不提交 .local/、本机配置、dist、依赖或真实资料。
按本机约定正常提交推送到既有远程，不强推、不改远程、不自动发布 Release。
Windows 便携 ZIP 留在 .local/packages/ 供本地审阅和分发；正式 GitHub Release
仍需单独授权。
