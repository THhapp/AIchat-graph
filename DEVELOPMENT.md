# 开发与工程约束

本文件集中维护开发操作、模块边界和跨模块约束。
产品用法见 [README](README.md)，Agent 协作规则见 [AGENTS](AGENTS.md)。按任务阅读相关章节。

## 文档维护边界

| 位置 | 保存什么 | 何时更新 |
| --- | --- | --- |
| README.md | 用户能做什么、怎么使用、实际限制 | 用户操作或可见行为改变 |
| DEVELOPMENT.md | 开发入口、数据流、兼容与安全约束、验证方法 | 工程操作或跨模块契约改变 |
| AGENTS.md | 角色、授权、调度和停止规则 | 协作规则改变 |
| skills/aichat-graph/ | 外部 Agent 的记录方法与命令用法 | Agent 工作流或命令用法改变 |
| .local/、本机配置 | 个人路径、运行版本与本机入口 | 本机设置改变，不上传 |

一次内部修复可以不改说明文档。只更新受影响的主要位置，不为证明进展而同步改遍各份文件。
字段定义在 `src/core/schema.ts`、`src/shared/protocol.ts`，参数以 CLI `--help` 为准；本文解释其语义，不复制完整类型和参数表。
若代码与约束冲突，先核对授权和实际行为，不能静默把缺陷改写成规则。

文档采用当前有效表述，不保存逐轮报告、派工名单、测试数量或阶段授权。验证结果写在交付消息或提交说明中；长期产品限制归 README。
重要取舍只留理解现状所需的理由，不保留每次措辞版本。常用配置和启动入口保留根目录，不为整齐另建索引或重定向文件。

链接文字描述目标的稳定职责，不写“最新进度”“当前阶段”或数字章节号。
能直接说明的规则不强制加链接；必须定位时用文件或语义标题，不依赖行号和章节顺序。
移动、删除文件或改变职责时，检查入链、源码注释及引用文字，不能只查目标是否存在。

## 开发和固定运行版本

环境版本以 `package.json` 的 engines 和锁文件为准，统一用 `npm ci` 安装依赖。

| 用途 | 程序位置 | 资料与配置 | Windows 入口 |
| --- | --- | --- | --- |
| 源码开发 | 当前 src/、dist/ 和开发依赖 | 默认 .local/development-workspace；launcher.development.local.json | start-dev.cmd，默认 4318 |
| 固定版本 | .local/daily，含独立运行依赖与同版本 Skill | 仓库外资料库；launcher.local.json | start.cmd，默认 4317 |

固定版本是本机构建快照，不是源码分支或安装包；源码变化不自动更新它，讨论资料不复制进去。
两套配置互不继承，开发入口拒绝与已绑定正式库相同或相互包含的目录。
`.local/`、`*.local.json`、依赖和构建产物不上传；个人路径只保存在本机。

开发入口按需构建当前源码，默认使用独立测试资料：

```powershell
npm ci
./start-dev.cmd
# -NoBrowser 只启动服务；-Help 查看选项
```

手动启动须自选测试库和端口，启动器隔离检查不会介入：

```powershell
npm run build
node ./dist/cli/index.js init "../graph-test-workspace" --name "Graph test"
node ./dist/cli/index.js serve --workspace "../graph-test-workspace" --port 4318
```

已有库不要再次初始化，真实讨论不用作写入、迁移或故障测试样例。首次准备固定版本前完成必要验证与构建：

```powershell
npm ci
npm run build
./update-daily.cmd
./start.cmd -Workspace "D:/my-graph-vault"
```

后续更新：停止固定版本服务 → 验证改动 → 重新构建 → `update-daily.cmd` → `start.cmd`。
更新使用现有完整构建，不代替构建、不拉取 GitHub、不迁移资料库；运行中拒绝替换，准备失败保留旧版。
服务控制台保持打开，Ctrl+C 停止。绑定后沿用本机配置；路径或端口冲突报错，不回退其他目录或结束别的进程。

Agent 使用服务同版本的 CLI 和 Skill。固定版为 `.local/daily/dist/cli/index.js` 和 `.local/daily/skills/aichat-graph/SKILL.md`；开发版使用仓库入口。
续谈信息提供实际位置，程序从运行模块推导入口，不依赖启动 shell 的目录。

## 模块与数据流

Node.js／TypeScript ESM 服务通过 HTTP／SSE 连接 React／React Flow 阅读界面。依赖版本不在文档重复列举。

| 模块 | 职责与边界 |
| --- | --- |
| src/core/ | 纯解析、结构校验；统一 parseWorkspaceDocuments 入口，不读写磁盘 |
| src/storage/ | 扫描、初始化、纯候选变更、格式转换、可恢复事务 |
| src/index/ | 从解析结果派生索引，不成为正文来源 |
| src/service/ | 锁与队列、有效快照、读取凭据、API、资源接入、导出调度 |
| src/shared/protocol.ts | 跨层类型，不承载写盘逻辑 |
| src/cli/、skills/aichat-graph/ | 适配产品能力，不复制解析、业务或事务实现 |
| src/web/ | 实时与离线共用阅读组件、布局和 Markdown 渲染 |
| src/export/ | 受限资源捕获、安全 HTML 封装，不重新解释思想结构 |

源文件 → 扫描与统一解析 → 结构校验 → 有效快照 → 图、详情与导出。
Agent 写入 → 凭据检查 → 纯候选变换与全图校验 → 文件事务 → 发布有效快照。
调用方复用公共解析和类型；跨模块调整先核对实际接口，避免各自维护目录解析或 DTO。

候选变更的内部请求定义与文本处理在 `src/storage/changes/`，原 changes.ts/changes-v2.ts 保留业务编排和兼容导出。
HTTP 请求解析、响应组装在 `src/service/http/`；导出路径防护与冻结文档组装在 `src/service/export/`，队列及覆盖时序仍由 ExportCoordinator 管理。
布局入口在 `src/web/layout/index.ts`，内部按输入与可见树、几何计算、工作类型与诊断划分。内部模块不反向依赖兼容入口。

## 源文件与主题结构

新工作区采用格式 2：

```text
workspace.json                     # 身份、格式、topicMode、焦点
topics/<主题目录>/topic.md          # 仅主题元数据
topics/<主题目录>/<nodeId>.md        # 单节点头信息与完整正文
AGENTS.md                          # 工作区维护入口
.aichat/cache/                     # 可重建轻量索引与哈希
.aichat/local/exports.json          # 本机导出绑定与成功版本
.aichat/runtime/                   # 服务定位、锁、恢复证据
```

主题目录是 topics 下一级；topic.md 为保留名称，严格头信息只有 topicId、title，正文为空白。
节点身份来自 nodeId，不从文件名、标题或显示编号重建。目录或文件改名不改变身份，移动节点仍须通过结构校验。
不允许重复 ID、孤立 Markdown、悬空连接或符号链接。

节点头必需 nodeId/title/state/from/flow；非根须有非空 description，根的 from 为 null 且无 description。
branch 才能有 side/order，summary 可选，未知字段拒绝。正文不重复维护标题、编号、坐标、children 或节点总表。
ID 使用 n_/t_/w_ 加 32 位小写十六进制；state 为 agreed/proposed/reference，认可不代表执行、实测或掌握。
新提议默认 proposed，不从父节点继承认可。精确字段约束见 schema 定义。

严格解析 UTF-8 与 YAML，拒绝重复键、别名、自定义标签和多文档，修改保留 BOM 与换行形式。
哈希来自真实原始字节；文本范围是实际 sourcePath 的 UTF-16 半开区间，不用合成全文或伪造范围修改源文件。
V2 的 topic.md 哈希不能代替节点正文哈希，主题 contentHash 与单文件 fileHash 分开。
图响应不携带全部正文；详情按有效快照返回真实路径、正文和哈希，索引覆盖全部源文件。

新格式 2 默认 isolated：每个非空主题恰好一个根，其余节点同主题、单父、无环且从根可达，各主题从 01 编号。
空库合法，主题不能只剩空占位。旧库缺少 topicMode 时按 shared 兼容：非空全库单根，可保留跨主题连接。
格式 1 保持 shared，不因启动或升级自动拆图、改模式。多根使用 rootIds，旧 rootId 仅在单根时有值。

next 纵向继续，每个来源最多一个；branch 从侧面进入，枝内可继续 next 或再分支。
同一来源 branch 的显式 order 跨左右唯一并升序，缺省按稳定 ID 后置；新建默认右侧、最大 order 加 10。
主线 06 → 07 不因侧枝 06-03 而改变。编号由结构派生，不写回源文件。
主题连续阅读按派生结构顺序过滤节点，不按文件名排序。
description 解释为何 A 接到 B，不自动表示证明、因果或认可；改接来源须显式提供或确认描述。

## Agent 读写与提交边界

完整操作说明只维护在 [CLI 说明](skills/aichat-graph/references/commands.md)，此处保留实现约束。
Agent 根据用户主题名、目录或复制上下文核对稳定 topicId，在当前对话沿用。
前端浏览、工作区焦点与对话写入目标独立，不通过共享 activeTopic 控制多个对话。
查询先按主题过滤再分页；默认有界、显式请求才取全文，不因此限制源正文长度。

在线 editRef 绑定实例、工作区、节点、真实路径与读取时哈希；离线读取不伪造写凭据，重启或过期后重新读取。
无关文件的 revision 变化不单独使节点凭据失效。编号只在读取时解析为稳定 ID，不在提交时重新定位。

- patchNode 的片段替换须非空且唯一匹配，replace/append/body 互斥，不借修改正文重填其他字段。
- createBranch/createNext 使用来源凭据；已有 next 时拒绝冲突，不挤掉主线。
- updateConnection 改接须有目标 editRef、来源 fromRef 与描述，不隐式创建第二根。
- createTopic 在 isolated 模式原子创建主题与根，目录冲突不覆盖；createRoot 仅用于空库。
- 同一 requestId 重放不能生成不同 ID；高层动作进入统一 prepareChanges/commitFiles 链路。

expectedFiles 使用签发时哈希，不能提交时偷读最新值绕过冲突。
已有受影响文件和决定修改所依据的来源均检查旧哈希，新文件须声明不存在。
过期返回 412、语义冲突 409、格式错误 422。提交结果未知时先查原 requestId，不换请求盲重发；记录不是永久账本。
V2 不用 replaceTopic 模拟整主题正文，修复定位真实节点文件。

## 事务、有效快照与兼容

proper-lockfile 与 WorkspaceRuntime.queue 协调单写者；监听重载、check、apply、发布及导出配置变更串行执行。
prepareChanges 是纯候选变换，不取锁、不写盘，提交前验证完整结构。

事务先持久化 before/after 与完整日志，再 prepared、逐文件可靠替换、committed，快照确认后清理。
prepared 回滚只覆盖仍匹配 before/after 的文件；committed 不因发布失败回滚，而返回 committed_refresh_pending。
日志缺失、外部字节冲突或恢复歧义须保留证据并停写。删除用 content:null、afterSha256:null 表达，runtime 不能当普通缓存清理。

外部编辑不得与托管提交并行改同一批文件。无效磁盘不发布新图、不自动修正文；运行中保留上一有效内存快照与诊断。
冷启动从真实源重建，不用轻量缓存伪造有效正文。完整正文不另存长期 JSON 镜像；事务证据和独立 HTML 不属此类镜像。
快照使用 instanceId/revision，过期详情返回 409 STALE_SNAPSHOT，SSE 传元数据而非整份正文。

格式由 workspace.schemaVersion 选择，不混合正文组织。格式 1 保留读取和已有受控操作，新增低摩擦入口以格式 2 为主。
显式 migrate 写入不存在的新目录，源只读；保留身份、正文、状态、焦点、关系与顺序，不迁移 Canvas。
旧 label 转 description；非根缺描述时要求按节点 ID 提供映射，不用“继续”填空。
先预览、构建并校验，再从同父临时目录发布；失败不留下冒充成功的目标。
格式转换不等于 shared 转 isolated，有内容的共享图拆分需另行明确设计。

## 单文件 HTML 与本机导出

一个主题一份成品，包含同一冻结有效快照的全部节点、正文、关系和必要资源，不受折叠、搜索、视口过滤。
shared 跨主题来源只带必要边界上下文，不复制全库。OfflineTopicDocument 是生成时传输结构，不是长期源镜像，不混用不同 revision。

只捕获正文明确引用的 resources 内普通 PNG/JPEG/GIF/WebP 文件或安全 raster data URI；单件 8 MiB、总计 32 MiB。
路径不经链接逃出工作区，不扫描附件库、不抓网络图、不支持 SVG。资源字节、哈希与错误属于冻结快照，变化进入监听与内容指纹。
缺失、超限或不支持时导出报错；图可保留文字与诊断，不能生成貌似完整的成品。

实时与离线复用阅读组件、布局和 Markdown 渲染，构建生成 dist/offline/reader.js 与 reader.css。
HTML 内联脚本、样式、公式字体和必要资源，无 CDN、fetch、EventSource、外部 Worker 或旁边 assets 依赖；服务不临时执行 Vite。
惰性 JSON 转义脚本终止风险、<、U+2028/U+2029，正文不拼入可执行脚本，原始 Markdown HTML 不执行。
外部来源链接只在主动点击时访问。

目标由前端明确指定并保存在本机 exports.json；未绑定不写默认文件，解绑或换位置不删除旧成品。
只允许工作区及应用根之外的本地绝对 .html 普通文件，父目录须存在；拒绝 UNC、设备路径、ADS、目录和链接。
目标须不存在或属于同一 workspace/topic；覆盖还须匹配已授权旧字节哈希，不只看归属标记。
外部修改、无关文件和重复目标绑定均拒绝覆盖，不提供强制绕过。

公开导出入口与异步结果处理进入同一队列，InQueue 方法不以全局布尔值让并发请求跳队列。
先注册任务再返回状态，SSE 独立推送完成与失败，即使思想 revision 未变也更新界面。
每主题合并连续请求；真正替换前重新检查路径约束、目标代次、有效版本与资源，过时结果不得覆盖新目标或新内容。
任务不反写思想源、不引发自激监听；关闭服务等待或取消本实例任务。

先生成完整临时文件，再可靠替换；替换前持久化轻量 pending 的旧/新字节哈希与指纹，成功后记账。
写前记账失败不碰旧文件，写后记账失败保留 pending、不假报成功。
恢复时旧哈希对应重新排队，新哈希对应确认本程序产物并追最新内容，其他值视为外部冲突。
恢复仍遵守锁、队列及未恢复事务守卫，不偷补当前哈希绕过覆盖授权。

内容指纹排除自身、instanceId、revision、生成时间；成品指纹另含 reader 构建与导出格式。
当前与最后成功内容指纹须同域可比较。重启核对归属、实际字节与指纹，缺文件或内容/reader 变化时补生成。
失败保留旧成品与绑定，显示 error/stale；源无效时不声称已同步最新磁盘。
已打开的离线页面不自动刷新、不写回源、不跟随服务继续更新。

## 阅读状态与本机安全

主题目录只展示主题和节点，隐藏内部文件；选主题打开自己的图，不自动打开长正文。
左右栏初始关闭，单击节点只选中，显式打开详情才展开右栏；导航入口按需打开左栏。
各主题分别恢复位置、选择和折叠；无有效主题时提供选择入口，不合并全库图。
主题名称可见，搜索限定当前主题，复制续谈上下文携带工作区、稳定主题身份和同版本入口，不带无关正文。

主线与分支采用确定性布局，卡片不随正文扩张；更新和面板开合尽量保持锚点、缩放，不自动 fit 全图。
selectedNodeId、activeNode 与内容 state 独立；只读界面不增加拖线、自由坐标或网页正文编辑。
用户视图不限制 Agent 读取范围，也不自动决定模型上下文。

服务仅绑定环回地址与固定工作区，端口冲突报错；校验精确 Host、同源 Origin、JSON 与 X-AIchat-Client:cli，不开放宽泛 CORS。
CLI 核对运行描述、工作区/实例身份与真实根，不自行启动第二写进程。
源路径规范化并经 realpath 防越界、拒绝符号链接；Markdown 阻止 javascript/file 等危险链接。
安全依赖同机文件权限，不声称能抵御已控制本机的程序。

## 按改动选择验证

复用现有检查，不默认重跑全部历史验收，不以测试数或覆盖率为目标。

| 改动 | 必要检查 |
| --- | --- |
| 文档、注释、Skill 文字 | diff、引用目标及文字含义、隐私边界；不为此构建或跑全量测试 |
| 界面 | 相关类型/现有测试，实际浏览器核对受影响操作与阅读位置 |
| 主题与存储 | 隔离样例的身份、关系、旧凭据冲突、无效源与恢复保护 |
| 导出 | 完整隐藏分支、同路径更新、失败保留旧文件、重启补齐；移走单文件停服离线阅读 |
| 运行版本 | 独立资料配置、同版本入口、固定快照更新失败保护 |

代码集成按需要执行：

```powershell
npm run typecheck
# 主题相关改动示例，其他改动选择实际受影响测试
npx vitest run tests/core/format2.test.ts tests/service/agent.test.ts tests/web/reading.test.ts
npm run build
```

离线能力查生产成品，不只查开发服务器；普通浏览器通过不等于 Obsidian 内嵌通过。
用合成隔离样例，优先 DOM、几何和文件证据，不例行截图、不发布真实内容。
Agent 工作流改变时复用独立 Agent 经 Skill 做相关读写闭环，核对真实源、界面与成品。
只有新增具体风险才扩大检查，程序验证不代替用户对交互、理解和掌握感的认可。
提交前排除个人路径、真实讨论、凭据、配置和成品；提交、推送、发布须有相应授权。
清理本任务临时资源，保留用户资料和未恢复证据。
