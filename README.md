# AIchat-graph

以 Markdown 为源的本地协作思考图。外部 Agent 维护内容，浏览器负责图浏览、搜索和全文阅读；不内置模型聊天、API 密钥或自主 Agent。

## 主要功能

- 一个节点一份 Markdown，按独立主题组织，各主题有自己的起点和编号，稳定 ID 与显示编号分离。
- 单父有向关系：主线和枝内后继纵向推进，独立分支侧向展开，连接附有实际理由。
- 图优先界面，左右栏独立开合；选中项、讨论焦点与认识状态分别管理。
- 外部 Agent 可小范围读取、精确修改和新增节点；写入使用真实读取凭据及文件哈希检查，避免覆盖过期内容。
- 每个主题可绑定外部 HTML 目标；有效内容变化后自动替换完整的自包含只读快照。
- Markdown 代码、表格、公式与受限本地图片可在实时页面和离线成品中阅读。

## Windows 日用与开发启动

需要 Node.js 和 npm；当前验证环境为 Node.js 24.17.0、npm 11.13.0。

双击 [start.cmd](<start.cmd>) 使用已准备好的日用构建，默认打开 <http://127.0.0.1:4317>。服务控制台保持可见，Ctrl+C 停止。日用程序固定在本机忽略的 `.local/daily`，包含独立运行依赖及同版本 Skill；修改开发源码不会触发日用重建，也不会自动更新这份程序。

需要桌面入口时，对 [start.cmd](<start.cmd>) 使用 Windows“发送到 → 桌面快捷方式”；移动项目后需重建快捷方式。

首次从源码准备日用版本：

```powershell
npm ci
npm run build
./update-daily.cmd
./start.cmd -Workspace "D:/my-graph-vault"
```

工作区使用自选长期目录，保持在代码仓库之外；选择保存在本机 `launcher.local.json`，以后直接双击即可。不再默默回退到系统临时或旧默认位置。已有工作区直接读取，不自动迁移；非空普通目录不会被覆盖成新工作区。重复启动复用身份匹配的服务，端口冲突明确报错，不抢占其他程序。

准备更新日用版本时，先完成当前改动的必要验证和构建，再运行 [update-daily.cmd](<update-daily.cmd>)。更新入口不替你自动构建；准备失败保留旧版本，日用程序运行中拒绝替换。它不是自动更新服务，也不复制正式资料。

开发时使用 [start-dev.cmd](<start-dev.cmd>)：运行当前源码对应的构建，默认端口 4318，默认资料目录为 `.local/development-workspace`。开发配置单独保存在 `launcher.development.local.json`；不继承日用库，也不能意外使用已绑定的正式库。开发模式按需安装依赖和构建，首次可能需要网络。

两种模式共享产品规则，各自使用独立程序／数据位置。开发验证只需覆盖本次改动的行为，不要求每次重新执行全部历史验收。

仅启动服务、不打开浏览器：

```powershell
./start.cmd -NoBrowser
```

## 手动启动当前开发构建

在项目根目录执行。已有工作区不要再次 init；路径按需替换。

```sh
npm ci
npm run build
node ./dist/cli/index.js init "../aichat-workspace" --name "My workspace"
node ./dist/cli/index.js serve --workspace "../aichat-workspace"
```

手动服务不经过模式隔离入口，需自己明确工作区和端口；默认地址为 <http://127.0.0.1:4317>，仅绑定本机环回地址。日用一般直接使用 start.cmd。

## 外部 Agent 维护

开发入口为项目内 [Skill](<skills/aichat-graph/SKILL.md>)；日用应使用 `.local/daily/skills/aichat-graph/SKILL.md` 与 `.local/daily/dist/cli/index.js`，保持 Skill、CLI 和运行服务同版本。用户启用工作区图记录后，Agent 伴随普通讨论按需整理，不必每轮重新要求更新。节点内容与记录分寸、工作区定位及命令说明按需读取 Skill 中的 references。无需全局安装；[薄脚本](<skills/aichat-graph/scripts/aichat.ps1>)只在保留相对目录结构时定位并转发 CLI，复制 Skill 到其他位置后须使用实际 CLI 入口。

可以直接告诉 Agent“这次记录到论文阅读这个主题”，或粘贴前端“复制给 Agent”的内容。Agent 先核对实际主题，绑定稳定 ID 后在当前对话沿用；只有重名或目标不明确时再询问。明确的新主题可创建独立起点，不需要用户手填 ID。前端切换浏览主题不会改变另一个 Agent 对话的记录目标，activeNode 也不代替主题绑定。

```sh
node ./dist/cli/index.js whoami --workspace "../aichat-workspace"
node ./dist/cli/index.js topics --workspace "../aichat-workspace"
node ./dist/cli/index.js search "关键词" --workspace "../aichat-workspace" --limit 10
node ./dist/cli/index.js read --node "<实际nodeId>" --workspace "../aichat-workspace"
```

先读后写。绑定主题后搜索加 `--topic <topicId>`；节点默认读取 4000 个 UTF-16 单元，分段上限 16000，主题默认仅提纲。在线读取取得 editRef 后，可用 edit 原位更新、next 延续线索、branch 建必要旁支、connect 改进关系。新主题使用 `create-topic --topic-title "论文阅读" --directory "paper-reading" --body-file "opening.md"`，在同一事务中创建主题和起点；directory 可省略，重名目录明确拒绝。空库也可用 create-root。以上写入命令同样显式带 `--workspace`。正文支持文件或 stdin，ID、路径、顺序、哈希和 requestId 由程序处理。

精确片段允许跨行并保留首尾空白，只替换唯一匹配。版本冲突须重新读取后判断；服务重启后重新获取凭据。未知提交结果先查原 requestId 的状态，不盲目重发。

新观点默认 proposed；reference 是资料状态，agreed 是讨论认可状态，均不等同于执行、实测或掌握。没有实质变化不必写入，也不逐句记录对话。一轮可维护多个相关节点，一张节点也可持续多轮完善；正常维护不固定追加操作汇报，失败或冲突应说明。

## 数据与离线 HTML

左侧导航按主题目录组织：点击主题打开对应图，展开目录查看它的节点；不显示程序 JSON、缓存或锁文件。切换主题分别保留阅读位置，搜索默认限于当前主题。没有打开主题时先选择主题，不把多个独立主题合成一张图；侧栏收起后仍可看到当前主题并复制续谈上下文。

新建工作区采用 `topicMode: "isolated"`，每个主题有独立根，连接限于同主题。旧工作区缺少该字段时按 shared 模式兼容，仍允许既有跨主题连接，界面说明其兼容状态；不会自动拆图或迁移。已有非空共享图的转换不在本轮范围内。

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

按改动风险选检查：Skill／文档以格式和引用为主，界面验证受影响操作，存储／迁移／覆盖写入验证数据完整性。不因小改动默认重跑全部测试、扩大故障矩阵或追覆盖率。

主题隔离已验证独立根及编号、同主题连接约束、目录碰撞不覆盖、主题内搜索和旧 shared 兼容；实际页面已检查主题切换、刷新后恢复折叠状态、未选节点时复制续谈上下文，以及打开导出设置后画布仍可阅读。这些检查不代表用户已认可版面体验。

```sh
npm run typecheck
npx vitest run tests/core/format2.test.ts tests/service/agent.test.ts tests/web/reading.test.ts
npm run build
```

以上测试文件针对主题隔离改动；其他改动选择对应的现有检查，完整历史测试按实际需要运行。

依赖与构建产物、本机配置、用户工作区、运行锁、凭据及导出成品不应提交。发布前检查 Git 暂存区；不要把整个开发目录直接打包上传。

技术约束见[工程契约](<ARCHITECTURE.md>)，开发协作规则见[AGENTS](<AGENTS.md>)。
