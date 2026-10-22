# AIchat-graph

以 Markdown 为源的本地协作思考图。你与外部 AI Agent 讨论，Agent 维护节点和关系，浏览器同步呈现思路历程；也可导出独立 HTML，供日后回顾。

项目不内置模型聊天、API 密钥或自主 Agent。

## 能做什么

- 按主题组织讨论，每个主题有独立起点和编号，节点各自保存为 Markdown。
- 主线纵向推进，分支横向展开；连接描述保留问题之间的实际来路。
- 从左侧主题目录打开对应的图，分别保留阅读位置、选择与折叠状态。
- 外部 Agent 按需读取和整理已有节点，通过版本检查避免覆盖过期内容。
- 每个主题可指定 HTML 保存位置，内容有效更新后自动生成完整的单文件快照。
- 实时页面和离线 HTML 支持 Markdown、代码、表格、公式与受限本地图片。

## 安装与运行

当前提供源码，需要 Node.js 和 npm。已验证环境为 Node.js 24.17.0、npm 11.13.0；尚未提供独立安装包。

```sh
git clone https://github.com/THhapp/AIchat-graph.git
cd AIchat-graph
npm ci
npm run build
```

选择仓库之外的目录保存讨论资料。仅对不存在的新目录执行初始化；已有工作区直接启动服务。

```sh
node ./dist/cli/index.js init "../my-graph-workspace" --name "My graph"
node ./dist/cli/index.js serve --workspace "../my-graph-workspace"
```

打开 <http://127.0.0.1:4317>，在服务终端按 Ctrl+C 停止。服务仅监听本机环回地址；端口冲突会明确报错。

## 与 Agent 一起使用

让 Agent 读取项目内的 [Skill](skills/aichat-graph/SKILL.md)，并提供实际 CLI 入口和工作区路径。Skill 可直接从项目使用，无需全局安装；它是协作指引，不是自动注入每次对话的后台钩子。

启用记录时，可以说“这次记录到论文阅读这个主题”。Agent 核对实际主题并绑定后，在当前对话持续沿用；重名或目标不明确时再询问。新主题可以创建独立起点。

继续已有讨论时，从页面选择主题，点击“复制给 Agent”，将定位信息粘贴到对话中。前端切换主题只影响浏览，不改变其他 Agent 对话的记录目标。

记录按思考单元组织：同一问题原位完善，后续问题纵向继续，独立方向形成侧枝。不逐句复制聊天，也不要求每轮新增节点。新提议、讨论认可与参考资料分别标记；认可不代表已执行、实测或掌握。

实际命令、读取凭据及冲突处理见 [CLI 说明](skills/aichat-graph/references/commands.md)。Agent 应使用与服务相同版本的 CLI 和 Skill。

## 资料与导出

工作区保存真实 Markdown，程序缓存和运行状态位于 `.aichat/`，不显示为图节点。资料库应独立于源码和构建产物保存。

```text
workspace.json
topics/<主题目录>/topic.md
topics/<主题目录>/<nodeId>.md
.aichat/
```

在页面的“导出”设置中指定工作区及程序目录之外的绝对 `.html` 路径，父目录须存在。程序在内容有效更新后替换同一路径成品；生成失败保留旧文件，外部修改的文件拒绝覆盖。

HTML 包含完整主题、分支、脚本、样式和必要资源，移走后可离线阅读；它是只读快照，不自动联网更新或写回源记录。需要提炼知识时，可从实体 Markdown 单独整理，不要求长期维护两份相同正文。

## 限制

- 新工作区的主题相互隔离；旧共享图保持兼容，不自动拆分或迁移。格式 1 转换须显式写入新目录，不原位覆盖。
- 图片支持明确引用的工作区 resources 内 PNG/JPEG/GIF/WebP 或安全 raster data URI；单图 8 MiB、总计 32 MiB。不抓取网络图片，不提供通用附件管理。
- 搜索定位不会自动展开折叠祖先，可先展开或点击“查看全部”。
- 主要验证 Windows 本地环境；Obsidian 应用内嵌、移动端和大规模性能尚未验证。
- 不含多人同步、云服务、数据库或全量 Canvas 自动迁移。

## 开发

源码开发、Windows 辅助启动器、固定运行版本的准备与更新、验证命令见 [DEVELOPMENT.md](DEVELOPMENT.md)。接口和数据约束见 [ARCHITECTURE.md](ARCHITECTURE.md)，开发协作规则见 [AGENTS.md](AGENTS.md)。
