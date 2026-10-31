# 工作区指南

工作区保存讨论资料；程序、开发代码、日用程序和 HTML 成品可以放在不同位置。
Windows 发布包中的 aichat.cmd 是实际 CLI 入口；源码开发时可用 node dist/next/cli.js。

## 第一次打开与建立

Windows 便携包解压后双击 AIchat-graph.exe：

1. 没有默认库时打开原生目录选择器；
2. 选择已有讨论库（含 graph.sqlite），或空文件夹作为新库；
3. 新库名称取文件夹名，无需额外命名；
4. 服务就绪后打开默认浏览器，并记住默认库；下次双击直接打开。

取消选择不会创建数据库或改默认库。程序目录、只读目录、非空且没有 graph.sqlite 的目录
不会被当作讨论库；旧 Markdown 库需要先显式 import。
程序包根和内部程序目录不能作为讨论库；不要把资料放进后续会被替换的程序目录。

也可以显式管理：

~~~text
aichat.cmd init D:/my-discussions --name "我的讨论库"
aichat.cmd open --workspace D:/my-discussions --no-browser
aichat.cmd open
aichat.cmd stop
~~~

open 会复用存活服务，缺失时启动后台服务；成功后保存为默认库。stop 只请求当前库服务
自行退出，不自启动、不按 PID 杀进程；已停止时返回 not-running 成功状态。
页面「程序」菜单提供打开其他库和退出本库服务。

## 数据位置

~~~text
graph.sqlite
resources/
.aichat/runtime/service.json
.aichat/local/runtime.json
.aichat/local/exports.json
~~~

- graph.sqlite 是唯一主存储。WAL 模式还可能出现 graph.sqlite-wal / -shm，由 SQLite 管理。
- graph.sqlite 的 topic_changes 只保存每个主题最近一批内容变化（新增／改动／删除），供页面标签和差异查看，不是完整历史。
- resources/ 保存正文明确引用的本地图片，正文使用 resources/... 键。
- service.json 是当前服务描述，由程序维护；不要靠删除它解决连接问题。
- runtime.json 记录本库上次成功绑定的端口；服务优先复用，端口被占用时才换空闲端口。
- exports.json 保存本机 HTML 目标，由页面设置；它不是正文来源。
- 主题 key 是库内自命名标识，不要求存在同名目录。

数据库格式版本为 schemaVersion 3。schemaVersion 1／2 的旧库只读打开可直接读取，不迁移、不建表、不改写；
可写打开时一次性逐级升级到 3（v1→v2→v3），保留节点、正文、连接、版本、主题最近更新记录与工作区 revision，
不把升级记为最近更新。v2→v3 只新建 topic_changes 表并更新 meta；旧库没有保存过变化批次，不会补造。
新库与 import 得到的库都是 3。

不要直接修改数据库、运行描述或 HTML 来绕过 CLI 报错。
日常维护不需要 workspace.json、topics/ 或节点 Markdown。

## 程序目录、默认库与端口

便携包目录边界：

~~~text
AIchat-graph-<version>-win-x64/
  AIchat-graph.exe
  aichat.cmd
  更新已有程序.cmd
  开始使用.md
  distribution.json
  runtime/         包内 Node
  app/             CLI、Web、Skill、文档与生产依赖
  .aichat/         默认库、本机设置和日志（由程序产生）
~~~

程序区和资料区分开：更新只替换 root 程序文件、runtime/ 和 app/，保留 .aichat/；
讨论库应放在程序目录之外。默认库保存在程序根 .aichat/default.json。
源码运行时默认配置在仓库根 .aichat/default.json。

CLI 选择目录的顺序：

1. --workspace <dir>；
2. AICHAT_WORKSPACE 环境变量；
3. 当前安装的程序根 .aichat/default.json。

config --workspace 保存默认目标，config --show 查看；--workspace-id 只核对身份。
端口默认按 runtime.json 的 preferredPort，未记录时用 4317，被占用时才用系统空闲端口；
只有成功绑定后才记录。

## 更新程序

1. 下载新 ZIP，完整解压到旧程序目录之外；
2. 先退出旧程序正在服务的讨论库（页面菜单或旧程序 --stop）；
3. 从新包运行「更新已有程序.cmd」，选择旧程序目录并确认；
4. 完成后从原位置打开。

更新只替换程序文件，不复制、不删除讨论资料；不会停止仍在运行的旧服务。
程序不注册系统服务、PATH、文件关联或协议，也不自动安装 Skill。

## 给 Agent 继续讨论

提供实际 CLI 入口、工作区和主题，或从页面复制续谈信息。
已知节点可直接读取，返回旧问题可用 resume；不必每次重读全图。
修改使用读到的节点 revision，继续修改可用写结果中的 nodeRevisions。
想核对上一次写入改变了什么，可用 diff 查看批次摘要或单卡字段／正文差异；
页面上的变化标签与清单来自同一保存批次，只保留最近一批。

需要协作方法时加载 Skill；程序本身可以独立使用。
Skill 是可选组件，首次打开程序不会安装。包内可用 app/tools/install-skill.ps1
显式安装到 Codex/WorkBuddy 或其他目录；安装不改变讨论资料。

## HTML 保存与知识提炼

在页面导出设置中选择一个工作区及程序目录之外的 .html 路径。
已有绑定会在主题有效变化后更新；没有绑定则不会生成文件。
导出会内嵌该主题最新一批变化快照，离线也能看新增／改动标签、主题变化清单和单卡差异；
没有该字段的旧成品仍可读，只是不显示变化标记。
程序或阅读器升级不会单独重写已有成品；只有主题内容变化或显式重新导出才用当前阅读器生成。
旧成品（含多余 state 字段）仍可读取。
取消绑定不删除成品，失败保留旧成品。

HTML 是完整、独立、只读的主题快照；保存位置可与知识库放在一起。
需要知识 Markdown 时再由 Agent 提炼，不进行日常全文双写。

## 仅旧版 Markdown 资料需要导入

~~~text
aichat.cmd import --workspace D:/old-workspace
~~~

import 只读当前旧 V2 / isolated 格式，在该目录新建 graph.sqlite，
保留原 workspace.json、topics/ 和资源；已有 graph.sqlite 时拒绝覆盖。
之后正常运行只使用数据库，不恢复对旧文件的监听或写回。
旧 frontmatter 的 state 会被读取但忽略，不转成正文；它是遗留导入格式，新节点契约没有状态。

切换时停止同一资料库的旧服务，导入一次，再启动新服务；
不让两个版本分别向文件和数据库维护同一讨论。
无需重复导入、复制备份树或维护长期兼容后端。
