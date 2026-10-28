# 工作区指南

工作区保存讨论资料；程序、开发代码、日用构建和 HTML 成品可以放在不同位置。
以下 aichat 表示实际入口，未加入 PATH 时使用 aichat.cmd 或 `node <实际 CLI.js>`。

## 建立与打开

对新目录执行：

~~~text
aichat init D:/my-discussions --name "我的讨论库"
aichat config --workspace D:/my-discussions
aichat serve --workspace D:/my-discussions
~~~

浏览器打开默认地址 <http://127.0.0.1:4317>。停止服务不会删除资料。
已有 graph.sqlite 的工作区直接打开，不再 init。

## 数据位置

~~~text
graph.sqlite
resources/
.aichat/runtime/service.json
.aichat/local/exports.json
~~~

- graph.sqlite 是唯一主存储。WAL 模式还可能出现 graph.sqlite-wal / -shm，由 SQLite 管理。
- resources/ 保存正文明确引用的本地图片，正文使用 resources/... 键。
- service.json 是当前服务描述，由程序维护；不要靠删除它解决连接问题。
- exports.json 保存本机 HTML 目标，由页面设置；它不是正文来源。
- 主题 key 是库内自命名标识，不要求存在同名目录。

不要直接修改数据库、运行描述或 HTML 来绕过 CLI 报错。
讨论图和完整成品的日常维护不需要 workspace.json、topics/ 或节点 Markdown。

## 默认工作区与显式目标

CLI 按以下顺序选择目录：

1. `--workspace <dir>`；
2. AICHAT_WORKSPACE 环境变量；
3. 该程序根目录的 .aichat/default.json。

config --workspace 保存默认目标，config --show 查看。
--workspace-id 只核对所选库的身份，不把 ID 转成目录。

仓库与 .local/daily 是不同程序根，应通过实际使用的入口配置默认库。
Windows 启动器另外使用 launcher.local.json 或开发配置；
它与 CLI 默认配置目前不会自动互相同步。目标不明确时显式给 --workspace。

固定日用快照还有一项限制：在其程序根写入 .aichat/default.json 后，
当前更新器会将 .aichat 视为额外目录并拒绝替换快照。
日用命令宜显式给 --workspace；不要为更新快照自行删除配置或运行数据。

## 给 Agent 继续讨论

提供实际 CLI 入口、工作区和主题，或从页面复制续谈信息。
已知节点可直接读取，返回旧问题可用 resume；不必每次重读全图。
修改使用读到的节点 revision，继续修改可用写结果中的 nodeRevisions。

需要协作方法时加载 Skill；程序本身可以独立使用。
Skill 包装脚本负责定位 CLI，不自动应用 local.env.json 中的 workspace 字段。

## HTML 保存与知识提炼

在页面导出设置中选择一个工作区及程序目录之外的 .html 路径。
已有绑定会在主题有效变化后更新；没有绑定则不会生成文件。
取消绑定不删除成品，失败保留旧成品。

HTML 是完整、独立、只读的主题快照；保存位置可与知识库放在一起。
需要知识 Markdown 时再由 Agent 提炼，不进行日常全文双写。

## 仅旧版 Markdown 资料需要导入

~~~text
aichat import --workspace D:/old-workspace
~~~

import 只读当前旧 V2 / isolated 格式，在该目录新建 graph.sqlite，
保留原 workspace.json、topics/ 和资源；已有 graph.sqlite 时拒绝覆盖。
之后正常运行只使用数据库，不恢复对旧文件的监听或写回。

切换时停止同一资料库的旧服务，导入一次，再启动新服务；
不让两个版本分别向文件和数据库维护同一讨论。
无需重复导入、复制备份树或维护长期兼容后端。
