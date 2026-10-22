# AIchat-graph 工程契约

本文件定义数据格式、模块边界与运行安全契约。格式 2 为新工作区默认；格式 1 通过显式兼容路径读取，不自动改写。功能、使用和已知限制见 [README](<README.md>)，开发、验证及运行版本管理见 [DEVELOPMENT](<DEVELOPMENT.md>)，开发协作规则见 [AGENTS](<AGENTS.md>)。不得擅自迁移用户数据或将用户内容、本机配置与凭据纳入公共仓库。

## 1. 范围与现有基础

用户与外部 Agent 对话；Agent 按需要静默整理内容；程序发布有效内容并刷新图及已指定的主题 HTML。无变化不必写，不逐句记录，不制造逐轮报告，不内置聊天、密钥或自主 Agent。图记录、可替换的 HTML 快照与按需提炼的知识 Markdown 分工，不日常双写完整知识正文。

沿用 Node.js 24.17、TypeScript ESM、npm、React 19／React Flow、Hono、Chokidar、yaml／Zod、write-file-atomic、proper-lockfile。不换数据库或布局平台。HTML 构建、公式等确有必要的依赖由唯一构建负责人管理。

依赖方向：core（纯解析／校验）→ storage（扫描／纯候选／事务）→ index／service（有效快照／串行发布）→ CLI／web；export 仅接收冻结的阅读数据及受限资源，不重新解释思想结构。共享 DTO 只放类型，不放写盘逻辑。

## 2. 格式 2：一节点一份 Markdown

~~~text
workspace.json                         # schemaVersion:2, workspaceId,name,activeNode,topicMode
topics/<任意主题目录>/topic.md           # 主题元数据，没有正文镜像或节点总表
topics/<任意主题目录>/<nodeId>.md        # 一份文件一张真实节点
AGENTS.md                              # 简短维护指南
.aichat/cache/                         # 可重建轻量索引／元数据／哈希，不存完整正文JSON镜像
.aichat/local/exports.json              # 本机导出目标及成功版本，不是内容来源
.aichat/runtime/                        # 服务协调、锁、未恢复事务
~~~

主题目录在 topics 下一层；topic.md 为保留文件名。其严格 YAML 头只有 topicId、title，正文仅允许空白。主题 ID 保存在头中，目录改名不改变身份。标题不重复存放。节点默认以 ID 命名，但真正身份来自 nodeId；改名／移动保留身份。移动到另一主题目录改变归组，不改变 ID 或连接；isolated 模式仍须满足目标主题单根、父边同主题等约束，不能仅靠移动文件完成拆图。禁止隐式按文件名重新生成身份。

单节点示例（以下省略值仅为教学占位，真实 ID 必须通过 schema）：

~~~markdown
---
nodeId: n_<32位小写十六进制>
title: 跨对话复用
state: proposed
from: n_<来源稳定ID>
flow: branch
description: 把一般协作约定具体化为新会话的续谈方法
side: left
order: 20
---
这里是完整 Markdown 正文，普通标题、代码、表格、公式均保留。
~~~

必需 nodeId、title、state、from、flow；非 root 必需非空 description；root 的 from 必须 null，且不写 description。branch 可省 side／order，沿用右侧／稳定缺省排序；新建由工具生成 max+10 顺序。summary 可选；其他字段拒绝。V2 不存 label、坐标、显示编号、children、主题节点清单或另一份 JSON 正文。标题只在头中维护，正文不要求 H2 卡片标记，内部 H1/H2 等是普通内容。

ID 沿用 n_／t_／w_ 加 32 位小写十六进制；状态 agreed／proposed／reference。认可不意味着用户已执行、实测或掌握。新提议默认 proposed，reference 显式指定，工具不从父节点继承 agreed。

沿用严格 UTF-8、BOM／LF／CRLF 保留、YAML 重复键／别名／自定义标签／多文档／未知字段拒绝。重复节点或主题 ID、孤立 Markdown、错误目录归属、悬空连接、自连、环、重复分支顺序、非法路径和符号链接都明确诊断。正常非空主题有实际节点，不能留下空占位；空工作区合法。

## 3. 内存接口与来源

保留现有 parseTopicDocument 作为格式 1 解析器；新增 core.parseWorkspaceDocuments({workspace,documents:[{path,text}]}) → {ok,topics,diagnostics}，统一给 service／CLI／候选校验使用。它不读盘、不依赖 storage。格式来自 workspace.schemaVersion，接受 1／2，未知版本拒绝，禁止一个工作区混合两种正文组织。

ParsedTopic.schemaVersion 为 1|2，document 指向真实主题文件（V2 topic.md），sourcePaths 可列该主题全部真实源路径。ParsedNode 保留 topicPath 作为主题入口路径；新增 sourcePath（V2 节点文件，V1 缺省回退 topicPath）及 description。范围始终指向对应真实 sourcePath 的原始 UTF-16 文本，不能把合成主题或伪造 H2 范围用于修改；V2 无注释范围时显式缺省。

storage.WorkspaceFiles.topics 仍是扫描到的全部 topics Markdown 原始事实，workspace.schemaVersion 扩展为 1|2。SHA-256 只按原始字节。增加可复用的解析分组入口，不允许 service、CLI、候选各写一套目录解析。

service 的 TopicInput 可扩展 files（该主题所有 WorkspaceFile）；TopicSnapshot 保留 metadata 的 raw／path／fileHash，另持有 files 与主题 contentHash。节点详情必须返回节点真实 sourcePath／fileHash，不再把 topic.md 哈希当正文版本。索引 manifest.fileHashes 必须包含全部节点文件与主题元数据，搜索路径指向节点。

GraphNode／TopicNodeDetail 新增 description，GraphTopic 可增 contentHash；旧 fileHash 保持所声明真实文件的字节哈希。topic detail 的 raw 在 V2 仅为主题元数据，完整阅读通过 nodes，每项附真实 path／fileHash。不得把合成全文与某个真实文件哈希配对。纯 GraphResponse 仍不含全部正文。

## 4. 简单结构与阅读顺序

主题是讨论的隔离边界。新建格式 2 工作区使用 `workspace.json` 的 `topicMode: "isolated"`：每个非空主题恰好一个 root，其余节点只能连接同主题节点，并从该主题 root 可达，无环；各主题从 01 独立编号。根节点不是全库公共入口，不要求不同主题互相连线。不增加多父、交叉关系或复杂关系本体。

已有工作区缺少 topicMode 时沿用 `shared` 兼容语义：非空全库恰好一个 root，允许既有跨主题连接。显式 shared 同样兼容。格式 1 保持 shared，不自动改写旧数据或剪断关系。空库可以在停服并校验后明确切换 isolated；有内容的共享图转独立主题须另行设计显式转换，不由本轮自动执行。

内部图提供全部 rootIds，旧 rootId 仅在单根时有值；索引收录全部根。命令和 HTTP 快照明确返回实际 topicMode，使界面不会把共享图假装成独立主题。单父、next／branch 及稳定身份不因分主题而改变。

next 纵向继续，每个来源最多一个 next；branch 横向进入，分支内部可以 next。side／order 只用于 branch；同一来源各 branch 的 order 跨左右唯一，显式整数升序、缺省稳定 ID 后置。新建默认最大值+10。06 的 next 保持 07，06-03 必须是侧枝，不因添加分支吞掉主线。

description 解释为什么 A 接到 B，不自动表示证明、因果或认可；不是泛化词枚举。图上可截短，详情显示完整内容，不再维护意义重复的第二份说明。改变来源时显式提供或重新确认描述。

V2 主题连续阅读按全图派生结构顺序过滤该主题节点，而不是文件名排序。布局继续使用既有 computeLayout 与固定卡片尺寸、纵向链／侧向入口、确定性路由。文本编辑不以长正文改变卡片尺寸。保留整体确定性布局加锚点／视口补偿，不宣称任意编辑下完全局部布局。

## 5. 低摩擦 Agent 入口

已有离线 topics／search／read／validate 与在线低层 check／apply／status 保留。默认查询输出有界：搜索默认 10 项、最大 100，分页；节点正文默认 4000 UTF-16 单元、最大分段 16000，显式 --full 才取全文。返回 range {start,end,total,unit:"utf16"}、truncated、路径和匹配版本；不要切断代理对。章节标题可选定位，重复标题需明确范围。完整读取不限制必要正文保存长度。

新增 `create-topic --topic-title <主题> [--directory <自命名一级目录>] [--title <首节点标题>] --body-file <文件>`，在 isolated 工作区原子创建主题及独立 root，默认首节点标题可取主题名。目录重名明确拒绝，不覆盖已有资料。create-root 继续作为空库兼容入口。search 支持 `--topic <topicId>`，在主题过滤后再分页；稳定 ID 由命令返回，用户不必手填。

Agent 按用户首次给定的主题名或前端复制的上下文解析并绑定 topicId／目录，之后在当前对话沿用；重名或缺目标时只澄清实际歧义。前端打开的主题是本机阅读状态，不写入共享 activeTopic，也不能作为其他对话的默认写入目标。写入凭据继续绑定真实节点及主题，隔离模式拒绝跨主题连接。工作区身份响应可带从当前运行构建位置推导的 agentEntry（cliPath、skillPath），供续谈提示提供同版本入口，不能猜测开发目录或依赖 process.cwd。

新增在线 GET /api/agent/nodes/:id?start=&length=&full=，返回节点属性、body 片段、range、truncated、实际 path／fileHash、快照版本及 editRef。editRef 为实例内短凭据，绑定工作区、节点、真实源路径与读取时哈希；可含相关主题身份元数据。离线读取不假造在线可写凭据。过期／服务重启后明确拒绝，不能按编号悄悄重定位；显示编号只能在读取时解析成稳定 ID。

新增 POST /api/agent/changes（JSON、同现有写安全检查），外层 requestId 由 CLI 自动生成，具体动作：

- patchNode：editRef、可选 title/state/summary，以及 replace:[{old,new}] 或 append 或 body（正文模式互斥）。old 必须非空且唯一匹配，匹配失败不全局替换；修改旧片段应来自实际读取。其他字段不重填。
- createBranch：editRef（来源）、title、body、description，可选 state/side/order；默认同主题、右侧、proposed、追加顺序。新稳定 ID、文件路径与请求元数据由工具生成。同一请求重放不能重新生成不同 ID。
- createNext：与 createBranch 共用编译路径，editRef、title、body、description、可选 state/topicId，flow 固定 next，不带 side/order。来源已有 next 即冲突，不自动 insert 或挤掉旧主线。
- updateConnection：editRef（目标）、可选 fromRef（改接来源时必需）、flow/side/order，及 description；不能隐式改为第二个 root 或挤掉既有 next。
- createRoot：仅空工作区可用，topicTitle、title、body、可选 state；工具生成主题、节点 ID 与路径，同一事务创建主题与根。
- createTopic：isolated 工作区可用，topicTitle、body、可选 directory/title/state；同一事务创建新主题与独立根，title 缺省用主题标题，目录冲突不覆盖。不能借此转换 shared 工作区。

服务将这些动作编译到同一个 prepareChanges／commitFiles 链路，不在 CLI 或 Skill 另造修改逻辑。低层操作补充 patchNode／updateConnection 与 V2 description 支持；已有节点更新仍可全文替换，V2 拒绝用 replaceTopic 伪造整主题节点正文，必要原文修复须定位真实单节点文件。

CLI 提供 read --node ID（有在线服务时取得 editRef）、edit --ref REF、branch --from-ref REF、next --from-ref REF、connect --ref REF、create-root；正文支持 --body-file 和 --body-stdin，局部修改支持小型 --input／--replace-file，追加可用 --append-file。禁止同时提供歧义正文来源。不要求 Agent 手拼大量 JSON 转义、哈希、UUID、坐标或编号。命令最终拼写与错误退出码由 CLI 负责人统一使用说明并通告调用方。

普通动作一次提交，写前校验在工具内部完成；复杂变更仍可显式 check。凭据的旧哈希必须参与检查，所有 editRef/fromRef 对应 expectedFiles 只能使用签发时 fileHash，不能提交时偷读最新快照或磁盘哈希补齐；无关文件引起的全局 revision 变化不单独使节点凭据失效。过期返回 412；语义冲突 409；格式错误 422。未知提交结果先查原 requestId，unknown 不证明成功／失败，不能换请求盲重发。会话结果记录继续有界，不宣称永久账本。

## 6. 受控提交、无效内容与恢复

沿用根级 proper-lockfile 与 WorkspaceRuntime.queue：watcher 重载、check、apply、有效发布串行。apply 重新读原始字节，所有已有受影响文件与内容决策所依据的来源必须声明旧哈希，新文件须声明不存在。prepareChanges 纯变换并全图校验，不取锁不写盘。新增目录和节点仍经现有路径防护。

事务 before／after 与完整日志先持久化，再 prepared，再逐文件可靠替换，最后 committed；快照确认后清理。prepared 回滚只覆盖仍匹配 before／after 的文件；committed 永不因发布失败回滚，返回 committed_refresh_pending。缺日志、歧义、外部不同字节保留证据停写；删除用 content:null 与 afterSha256:null，绝不把 runtime 当普通缓存清理。

外部直接编辑可用，但不得与托管更新同时改同一批文件。无效磁盘不发布新图、不自动修正文；运行中显示内存上一有效快照与诊断。完整有效正文只驻留内存，不将所有源文件 raw/body 长期写入 JSON 缓存；缓存仅轻量索引、元数据与哈希。冷启动总按实体源重新解析，磁盘无完整有效内容时明确失败或只读诊断，不把轻量缓存拼成假有效图；这不影响独立 HTML 成品或必须保留的事务 before/after 恢复证据。快照 {instanceId,revision}，详情必须匹配；过期详情 409 STALE_SNAPSHOT。SSE 只发元数据，不塞全部正文。

## 7. 格式 1 衔接与隔离转换

新 init 默认 schemaVersion 2；格式 1 保持可识别读取和已有受控命令，不自动搬迁、不双写。工具必须明确工作区格式，低摩擦新增入口以 V2 为主，不把 V1 当 V2 误写。

新增纯 conversion 生成目标 V2 文件，以及显式 CLI migrate --source OLD --destination NEW（目标必须不存在）。不原位迁移，不动 Canvas。保留 workspace/topic/node ID、正文内容、状态、焦点、from／flow／side／order，主题标题与现有顺序含义不丢。V1 的 H2 卡片标题转入节点 title，正文原样保存，不把旧节点锚点混入内容。

旧 label 有值时保留为 description；缺失时不能编造解释。转换接受按 nodeId 给出的 description 映射，缺失非根描述则列诊断并拒绝发布目标；可先 preview，由维护 Agent 阅读实际内容后提供映射，再转换。不要用“继续”填空假装满足语义要求。先构建并全图校验、临时同父目录准备，再发布新目录；失败不留下冒充成功的目标。源只读，隔离转换按实际源文件与关系逐项核对。

## 8. 完整主题导出数据与资源

一个主题一份 HTML，主题中的全部节点／正文／状态／内部关系都来自同一份冻结有效快照，不接受视口、折叠或搜索过滤作为导出选择。跨主题 from 不凭空复制整工作区：保留来源 ID／标题／主题作为边界上下文；该主题的局部入口仍能定位。不能丢掉主题内分支；导出范围清楚标示。

共享 OfflineTopicDocument：format:1、workspaceId、workspaceName、instanceId、revision、fingerprint、generatedAt、topic:GraphTopic、nodes:(GraphNode & {body,path,fileHash})[]、boundaryNodes:GraphNode[]、resources:Record<string,string>（解析后的资源键→data URI）。这不是长期源镜像，只是生成成品时的一份冻结传输数据。不得从不同 revision 临时拼正文。

只处理实际 Markdown 明确引用的必要资源，不扫描／收集整个附件库，不自动联网抓取。允许已内联的安全 data 图片，以及工作区 resources 下的受限静态 PNG/JPEG/GIF/WebP；文件须普通、路径在根内、不经过 symlink／junction，单件默认 8 MiB、总计 32 MiB，超限／不支持类型／缺失应报具体导出失败，不静默删图。扩展网页来源链接允许保留，但不能作为正文阅读的隐含资源依赖。SVG 或其他格式遇到实际需要再作具体支持，不扩大资源管理系统。

export.captureResources(root,nodes) 负责一次捕获明确引用的资源原始字节、哈希与 data URI；service 在有效快照组装中调用，资源引用及错误与该快照一起保存，资源变化纳入监听／内容指纹。导出提交前确认版本／资源未过期；缺资源可保留图的文字阅读并显示资源诊断，但 HTML 状态必须 error，不生成貌似完整的成品。实时详情可带同一份 resources，不让浏览器自行请求任意本地路径。

export.renderTopicHtml({document,readerScript,readerStyles}) → string 只负责安全封装，不取当前 UI、不取新磁盘正文。导出标记包含 workspaceId／topicId／fingerprint。正文数据用惰性 application/json 区块，转义 <、脚本终止串、U+2028/U+2029；原始 Markdown HTML 不执行。绝不直接把正文拼入可执行脚本。

## 9. 本机导出配置、目标约束与调度

前端用完整本机 .html 路径输入及明确保存／更改操作，不以下载代替服务写入。未指定目标绝不写默认目录。目标保存在 .aichat/local/exports.json，与宿主机绑定，不进入源内容；取消绑定不删除已有成品。

API：GET /api/exports → {topics:TopicExportStatus[]}；PUT /api/exports/:topicId/target，{path:string|null}；POST /api/exports/:topicId/retry。状态至少 topicId、targetPath、state(unset/pending/writing/ready/error/stale)、sourceFingerprint、exportedFingerprint、lastSuccessAt、error。合法绑定／重试先注册生成任务再取得返回状态，不把正常的首次未生成误报 error，也不等待整份渲染。SSE 发送 export 状态事件，不传正文；前端必须消费它，即便思想快照 revision 不变也更新生成完成／失败状态。前端这些本机配置写同样携带 X-AIchat-Client:cli，不写思想正文。公开配置／调度／异步错误入口显式进入同一运行时队列，内部 InQueue 函数只执行已排队操作与可写守卫；不得用实例级“正在队列中”标志让其他并发调用跳队列。沿用 Host／Origin／JSON／客户端头检查。

目标只允许明确指定的本地绝对 .html 普通文件，父目录必须存在；拒绝 UNC／设备／ADS、目录、链接以及工作区和应用源码／构建根内部目标。不得覆盖无关已存在文件：只允许不存在的目标，或标记属于同一 workspace/topic 的已有成品。记录已授权目标的旧字节哈希，替换前发现被外部改成其他内容即拒绝；禁止全局强制覆盖开关。重新选择位置不删除旧成品，不将一个目标绑定给不同主题。路径检查在真正替换前重做。

读取目标后记住配置并立即生成当前有效主题。所有有效发布（受控写入和 watcher）经同一通知点排入导出；只配置变化或 .aichat 缓存变化不触发源循环，导出目录在工作区之外。连续更新按主题合并，generation 含目标变更；计算可在队列外，但最终“仍是最新任务／目标→校验→可靠替换→记录成功”经同一运行时串行队列。旧任务丢弃，不能覆盖更新的成品。

先完整生成并在目标同目录准备完整临时文件，再可靠替换，失败保留旧成品，不先 truncate。替换前先持久化轻量 pending（旧／新完整字节哈希、内容／读者／组合指纹及版本，不存 HTML 正文），替换后完成记账；写前记账失败不得触碰旧成品，完成记账失败保留 pending、不假报成功。恢复仍经同一队列与可写／锁／未恢复事务守卫：实际哈希等 pending 的旧值则重排，等新值则确认本程序产物后追最新源，都不等仍是外部冲突；不得仅凭归属标记或偷补最新哈希绕过授权。不在失败时更新已确认成功版本；暴露当前源指纹与最后成功指纹。服务关闭等待或取消本实例导出任务，不留下继续写盘的进程。

sourceFingerprint 与 exportedFingerprint 分别是当前／最后成功的内容指纹，必须同域可比较。export.computeContentFingerprint 排除 fingerprint 自身、instanceId、revision、generatedAt，仅规范序列化完整内容／关系／资源与必要上下文；exportFingerprint 另组合 reader 构建指纹和导出格式。不要将自身指纹递归纳入哈希。readReaderAssets 默认从模块位置推导 dist/offline，不依赖启动 cwd。

启动读取本机配置，验证目标归属／存在／实际哈希；当前内容或 reader 构建指纹不同、目标缺失时补生成，否则可复用。配置路径无效显示失败，不丢绑定也不默认另写一份。源无效时保持旧成品，状态 stale/error，不把上一有效内容说成已同步最新磁盘。

## 10. 共用实时与离线阅读

实时和离线复用 MarkdownBody、卡片、图、主分支布局与详情等组件或共享纯 view model，不维护第二套 Markdown 解释逻辑。GFM 代码／表格和 remark-math＋KaTeX 类公式采用确定性的本地渲染。HTML 必须包含全部读者 JS、CSS、公式字体与必要资源，无 CDN、fetch、EventSource、原工作区或旁边 assets 依赖。

构建负责人提供 dist/offline/reader.js（独立 IIFE，包含 React 与依赖、无 import）和 reader.css（所有 url 资源内联）。export 模块读取这些构建资源封装成单文件，不要求服务运行时执行 Vite。离线布局可同步复用 computeLayout，或使用已内联 Blob Worker，不允许 file:// 外部 Worker。生产验收检查构建结果，不能只看开发服务器。

离线支持图浏览、搜索、折叠、定位与完整正文，搜索／折叠只影响视图，不删除嵌入内容。新打开 HTML 不联网、不写回、不自动更新；外部来源链接只在用户主动点击时访问。普通浏览器验证与 Obsidian 应用内打开分开记录，不要求插件。

左右栏独立可折叠，初始关闭；单击选中，显式详情打开右栏，导航小入口打开左栏。面板开合、内容更新尽量保持锚点与缩放，不自动 fit 全图。selectedNodeId、activeNode 和内容 state 独立，用户视图不限制 Agent 读取。按主题设置导出目标及状态入口在前端明确可达。只读图不增加拖线、自由坐标编辑或网页内容编辑器。

## 11. 本机安全与现有通用约束

默认 127.0.0.1:4317，端口冲突失败，不静默切端口。一次服务绑定固定根，不让网页切任意工作区；精确 Host／同源 Origin，JSON 写与 X-AIchat-Client:cli，拒绝宽泛 CORS。CLI 核对运行描述、workspaceId／instanceId／真实根，不自动起第二写进程。路径使用规范化相对源路径、realpath 防越界，根外源资料只读。

React Markdown 默认关闭原始 HTML；阻止 javascript/file 等危险链接。外部普通链接与内置阅读资源分开。该产品信任同机文件权限，不伪称能防御已控制本机的程序。配置和安全报错保留具体原因。

## 12. 文件所有权与集成接口

### 主题目录与前端打开方式

隔离模式的左侧导航是可收起的主题目录：主题行打开对应图，目录展开仅展示该主题的节点，不显示 topic.md、JSON、缓存、锁或其他程序文件。没有有效打开主题时显示选择入口，不把所有主题默认合并成图；恢复上次有效打开的主题，切换时保存各主题的阅读状态。选择主题不自动打开长正文，保留图优先；不扩展为任意多层文件管理器、文件编辑器或多标签系统。

当前主题名称在主界面明确可见；节点查找与阅读以当前主题为范围，不把其他主题结果悄悄混入。侧栏收起后仍可切换主题或复制其 Agent 续谈上下文。复制内容包括工作区、主题稳定 ID／真实目录、可选节点及同版本 CLI／Skill 入口；不复制全部正文或要求新 Agent 按旧单文件格式读取整主题。浏览选择与对话记录绑定分别处理。旧 shared 模式保留兼容说明，不自动迁移。

### 本机日用与开发启动

日用程序、开发源码和用户资料分别管理。日用入口使用私有 `.local/daily` 中明确更新的固定构建及独立运行依赖，不因开发源码时间变化而自动重建。开发入口使用当前工程构建，默认独立开发工作区与 4318 端口；日用默认 4317。开发模式不继承日用工作区配置，并拒绝意外使用已绑定的正式库。工作区身份和服务复用继续使用现有检查，不通过结束其他进程或偷偷换端口解决冲突。

日用工作区由本机 `launcher.local.json` 显式绑定；开发选择保存在独立的本机配置。具体用户路径不得写入公开源码、Skill 或构建快照。资料库继续将节点正文与关系保存在主题 Markdown，缓存、本机配置与运行证据留在 `.aichat`，不把程序内部文件显示成节点，不复制用户资料到日用快照。

更新日用版是独立操作：使用当前完整且未落后源码的构建，在私有暂存位置准备必要产物和独立运行依赖，做最小入口检查后替换；不自动获取更新、不创建发布平台。日用快照仍在使用时拒绝替换，准备失败保留旧版本。清理只针对本操作创建并已核对绝对边界的暂存资源，不清理用户资料和未恢复事务。

- [core](<src/core/>)／[index](<src/index/>)：纯解析、结构校验与索引，不依赖写盘或服务。
- [storage](<src/storage/>)：扫描、初始化、候选变更、转换与可恢复事务，复用公共解析入口。
- [service](<src/service/>)：有效快照、读取凭据、受控 API、资源接入与导出调度；共享 [DTO](<src/shared/protocol.ts>) 统一定义跨层契约。
- [CLI](<src/cli/>) 与 [Skill](<skills/aichat-graph/SKILL.md>)：适配既有 API，不复制业务规则或全局安装。
- [web](<src/web/>)：实时与离线阅读组件；构建配置与依赖由单一负责人协调，避免并行覆盖。
- [export](<src/export/>)：受限资源捕获与安全 HTML 封装，不重新解释思想结构。

跨模块实现前先确定 parseWorkspaceDocuments、sourcePath/sourcePaths、OfflineTopicDocument、TopicExportStatus 和 Agent 请求响应等实际接口。调用方适配统一类型，不复制长期 DTO；缺口返回负责模块处理。编排与独立复核按 [AGENTS](<AGENTS.md>) 执行。

## 13. 必要验收与停止

先按改动风险选择受影响的既有检查，集成后只补必要的类型检查、针对性测试和生产构建，不默认重跑全部历史验收。纯文档或 Skill 文字修改检查格式与引用；界面调整验证受影响行为；存储、迁移和覆盖写入重点验证数据完整性。复用现有 Vitest 与 Edge CDP／Node WebSocket，非必要不安装重型平台，不追覆盖率或重复全量旧验收。

隔离工作区验证：新建格式 2、真实节点独立存储；原位片段修改、新分支、连接说明、旧凭据冲突不覆盖；无效源保持旧有效图；必要 V1 转换身份／正文／状态／顺序／连接完整，源未改。

实际浏览器验证：两栏初始关闭、选择／详情／搜索／折叠；主线、枝内后继与深层分支保持结构语义；源更新触发图与同一路径主题 HTML；连续更新、失败保留旧文件、配置重启恢复。使用隔离的合成样例，默认 DOM／几何／文件证据，不例行截图或发布真实用户内容。

停止服务后单独复制 HTML 到另一目录，用 file:// 和离线模式验证搜索、折叠、定位、完整正文、代码、表格、公式，导出前隐藏的分支仍存在，无运行资源网络请求或外部资产依赖。Obsidian 应用内能力未实际验证则明确标记。

复用无实现上下文的 Agent 按项目内 Skill／维护入口完成原位修改和新增分支，再核对源／界面／成品；从真实主题在隔离输出处提炼一份独立 Markdown，检查条件、理由、实例与证据状态，不改既有知识笔记，不自动双写。

只有新增具体风险才扩大检查。必要检查通过且无阻断后交付，清理本轮临时进程与一次性资源，保留用户源记录、成品和未恢复证据；不继续扩展聊天、附件管理或知识平台。
