# AIchat-graph

以 SQLite 为唯一主存储的本地协作思考图。你与外部 AI Agent 讨论，Agent 通过稳定 ID 和持久 revision 维护节点与关系，浏览器同步呈现思路历程；也可导出完整独立 HTML 供日后回顾。

项目不内置模型聊天、API 密钥或自主 Agent。

程序提供 CLI、本机服务、图阅读器和 HTML 导出；随附 Skill 提供外部 Agent 的协作与记录方法。程序可独立使用，Skill 通过实际程序入口操作工作区，两者各自附带 CLI 文档。

## 能做什么

- 按主题组织讨论，每个主题有独立起点和编号；节点、连接、正文、显式摘要和版本保存在一个 graph.sqlite 中。
- 每个主题的全局主线固定在最左侧，沿 next 从上到下连续阅读；branch 统一向右展开，同一来源的多个分支在右侧上下排列并共用一条竖向干线。
- 图上标题完整显示，连接说明写在自己的支线旁；保留既有主题目录、阅读位置、选择、卡片折叠和目录折叠体验。
- 外部 Agent 按主题概览、局部结构和正文续读，用节点 ID 与 revision 提交修改；版本不匹配时不会覆盖新内容。
- 单卡 edit 与 batch 的 edit 共用同一 NodePatch；内容、入边说明、来源关系、重要性和正文可以一次事务完成。
- 批量补卡、插入、重排和叶卡删除一次提交；不自动挤掉已有 next 后继。
- 每个主题可指定 HTML 保存位置，内容有效更新后自动生成完整单文件快照；实时页面和离线 HTML 支持 Markdown、代码、表格、公式与本地图片。
- 旧版 Markdown 工作区可按需一次性导入；运行链不再扫描、监听或写回节点 Markdown。

## 安装与运行

需要 Node.js 24.17 或兼容的 24.x（node:sqlite 为 release candidate）和 npm。当前提供源码，尚未提供独立安装包。

~~~sh
git clone https://github.com/THhapp/AIchat-graph.git
cd AIchat-graph
npm ci
npm run build
~~~

新工作区选择仓库之外的目录；只对不存在或空目录初始化：

~~~sh
node ./dist/next/cli.js init "../my-graph-workspace" --name "My graph"
node ./dist/next/cli.js serve --workspace "../my-graph-workspace"
~~~

Windows 也可直接使用仓库根目录的 aichat.cmd；日用固定版本目录同样提供 aichat.cmd。打开 http://127.0.0.1:4317，在服务终端按 Ctrl+C 停止。服务仅监听本机环回地址；端口冲突会明确报错。

新工作区目录、文件职责和切换步骤见 [新工作区指南](docs/workspace.md)。旧版 Markdown 工作区先导入一次（原文件保留，不会自动删除或改写）：

~~~sh
node ./dist/next/cli.js import --workspace "../old-workspace"
~~~

## 与 Agent 一起使用

给外部 Agent 实际程序入口和工作区路径，它可以按 [程序 CLI 手册](docs/cli.md)及命令帮助接入。需要本项目的讨论组织、节点写作与共识记录方法时，再使用随附 [Skill](skills/aichat-graph/SKILL.md)。

Agent 的正常流程只有一条：先 topics/read 取得主题与节点，按需 read --view content 或 resume，再用稳定 nodeId + revision 提交 edit/next/branch/batch。程序校验版本与图结构，一次 SQLite 事务提交，并通过 SSE 通知浏览器和导出队列。

程序不直接读取外部聊天窗口，也不自行决定哪些内容应记入图。

启用记录时，可以说“这次记录到论文阅读这个主题”。Agent 核对实际主题并绑定后，在当前对话持续沿用；重名或目标不明确时再询问。新主题可以创建独立起点。

继续已有讨论时，从页面选择主题，点击“复制给 Agent”，将定位信息粘贴到对话中。前端切换主题只影响浏览，不改变其他 Agent 对话的记录目标。

随附 Skill 按思考单元组织记录：同一问题原位完善，后续问题纵向继续，独立方向形成侧枝。不逐句复制聊天，也不要求每轮新增节点。新提议、讨论认可与参考资料分别标记；认可不代表已执行、实测或掌握。这些是协作方法，程序校验的是结构与写入条件。

程序入口、完整命令、版本冲突恢复见 [程序 CLI 手册](docs/cli.md)；讨论图维护流程和 Skill 自带命令参考在 [Skill](skills/aichat-graph/SKILL.md)。

读取已有主题时，Agent 先取得主题概览（主线与直接分支入口），再按需读取局部结构或正文；多卡正文由程序按整次响应预算分页，page.next 原样交回即可。

## 本地边界

workspace 目录中会出现：

- graph.sqlite（SQLite 主存储，WAL 模式）；
- resources/（正文引用的本地图片等资源）；
- .aichat/runtime/service.json（本机服务描述文件）；
- .aichat/local/exports.json（本机 HTML 目标，不进入内容真源）。

服务只监听 127.0.0.1。图数据、HTML 目标和本机配置留在本机；仓库公开内容不包含个人路径、真实讨论或凭据。
