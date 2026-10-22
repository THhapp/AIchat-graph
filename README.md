# AIchat-graph

以 Markdown 为源的本地协作思考图。外部 Agent 维护内容，浏览器负责图浏览、搜索和全文阅读；不内置模型聊天、API 密钥或自主 Agent。

## 主要功能

- 一个节点一份 Markdown，按主题组织，稳定 ID 与显示编号分离。
- 单父有向关系：主线和枝内后继纵向推进，独立分支侧向展开，连接附有实际理由。
- 图优先界面，左右栏独立开合；选中项、讨论焦点与认识状态分别管理。
- 外部 Agent 可小范围读取、精确修改和新增节点；写入使用真实读取凭据及文件哈希检查，避免覆盖过期内容。
- 每个主题可绑定外部 HTML 目标；有效内容变化后自动替换完整的自包含只读快照。
- Markdown 代码、表格、公式与受限本地图片可在实时页面和离线成品中阅读。

## Windows 一键启动

需要 Node.js 和 npm；当前验证环境为 Node.js 24.17.0、npm 11.13.0。

双击项目根目录的 [start.cmd](<start.cmd>)。首次安装依赖需要网络；启动器按需构建、启动本地服务并打开浏览器。服务控制台保持可见，Ctrl+C 停止服务。

需要桌面入口时，对 [start.cmd](<start.cmd>) 使用 Windows“发送到 → 桌面快捷方式”；移动项目后需重建快捷方式。

默认数据保存在系统 LOCALAPPDATA 目录下的 AIchat-graph/workspace，不放进代码仓库。选择其他工作区可在 PowerShell 中运行：

```powershell
./start.cmd -Workspace "../aichat-workspace"
```

选择会保存在本机配置中；建议自定义工作区也保持在仓库之外。已有工作区直接读取，不会自动迁移。非空普通目录不会被覆盖成新工作区。重复启动会复用身份匹配的同一工作区服务；端口被其他服务占用时明确报错，不偷偷换端口。

仅启动服务、不打开浏览器：

```powershell
./start.cmd -NoBrowser
```

## 手动启动

在项目根目录执行。已有工作区不要再次 init；路径按需替换。

```sh
npm ci
npm run build
node ./dist/cli/index.js init "../aichat-workspace" --name "My workspace"
node ./dist/cli/index.js serve --workspace "../aichat-workspace"
```

默认地址为 <http://127.0.0.1:4317>。服务只绑定本机环回地址。

## 外部 Agent 维护

入口为项目内 [Skill](<skills/aichat-graph/SKILL.md>)，用户启用工作区图记录后，Agent 伴随普通讨论按需整理，不必每轮重新要求更新。节点内容与记录分寸、工作区定位及命令说明按需读取 Skill 中的 references。无需全局安装；[薄脚本](<skills/aichat-graph/scripts/aichat.ps1>)只在保留本仓库目录结构时定位并转发 CLI，复制 Skill 到其他位置后须使用实际 CLI 入口。

```sh
node ./dist/cli/index.js whoami --workspace "../aichat-workspace"
node ./dist/cli/index.js topics --workspace "../aichat-workspace"
node ./dist/cli/index.js search "关键词" --workspace "../aichat-workspace" --limit 10
node ./dist/cli/index.js read --node "<实际nodeId>" --workspace "../aichat-workspace"
```

先读后写。节点默认读取 4000 个 UTF-16 单元，分段上限 16000；主题默认仅提纲。在线读取取得 editRef 后，可用 edit 原位更新、next 延续线索、branch 建必要旁支、connect 改进关系；空图用 create-root。正文支持文件或 stdin，ID、路径、顺序、哈希和 requestId 由程序处理。

精确片段允许跨行并保留首尾空白，只替换唯一匹配。版本冲突须重新读取后判断；服务重启后重新获取凭据。未知提交结果先查原 requestId 的状态，不盲目重发。

新观点默认 proposed；reference 是资料状态，agreed 是讨论认可状态，均不等同于执行、实测或掌握。没有实质变化不必写入，也不逐句记录对话。一轮可维护多个相关节点，一张节点也可持续多轮完善；正常维护不固定追加操作汇报，失败或冲突应说明。

## 数据与离线 HTML

```text
workspace.json
topics/<主题目录>/topic.md
topics/<主题目录>/<nodeId>.md
.aichat/local/exports.json
.aichat/cache/
.aichat/runtime/
```

实体 Markdown 是内容来源；轻量索引只保留元数据和哈希，不长期镜像完整正文 JSON。事务恢复证据不可随意删除。格式 1 继续可读，转换必须显式写入不存在的新目录，不原位迁移。

在网页“导出”面板填写工作区和应用目录之外的绝对 HTML 路径；父目录须存在。未选目标就不输出。有效内容变化自动更新同一路径；失败保留旧成品并显示状态，外部改动的文件拒绝覆盖。

成品包括完整主题正文、隐藏分支、脚本、样式、字体与必要资源，可单文件移走并在 file:// 下离线阅读。它是冻结快照，不自动更新、不写回源。知识 Markdown 可按需要从实体记录一次性提炼，不要求日常双份维护。

图片仅支持显式 Markdown 引用的工作区 resources 内 PNG/JPEG/GIF/WebP 或安全 raster data URI；单图 8 MiB、总计 32 MiB。不抓网络图片、不执行原始 HTML，也不是通用附件系统。

## 已知边界

- 搜索可读取折叠节点正文，但不自动展开祖先；需手动展开或点“查看全部”后在图上定位。
- 已做 Windows 与 Edge 的本地服务、CLI、文件冲突和离线阅读验证；不承诺 Obsidian 内嵌、跨浏览器、移动端、大规模性能或物理断电注入。
- 自包含读者含公式字体，文件较大；不通过拆成外部依赖来消除构建大包提示。
- 不含多人同步、数据库、云服务或全量 Canvas 自动迁移。

## 开发与仓库

```sh
npm run typecheck
npm test -- --silent
npm run build
```

依赖与构建产物、本机配置、用户工作区、运行锁、凭据及导出成品不应提交。发布前检查 Git 暂存区；不要把整个开发目录直接打包上传。

技术约束见[工程契约](<ARCHITECTURE.md>)，开发协作规则见[AGENTS](<AGENTS.md>)。
