# 开发与工程约束

本文件集中维护开发操作、模块边界和跨模块约束。
产品用法见 [README](README.md)，Agent 协作规则见 [AGENTS](AGENTS.md)。按任务阅读相关章节。

## 文档维护边界

| 位置 | 保存什么 | 何时更新 |
| --- | --- | --- |
| README.md | 用户能做什么、怎么使用、实际限制 | 用户操作或可见行为改变 |
| docs/cli.md | 程序自身完整 CLI 手册：入口、版本、命令、参数、输入输出、错误与恢复 | 程序 CLI 接口或行为改变 |
| DEVELOPMENT.md | 开发入口、数据流、跨模块契约与安全约束、验证方法 | 工程操作或跨模块契约改变 |
| AGENTS.md | 角色、授权、调度和停止规则 | 协作规则改变 |
| skills/aichat-graph/SKILL.md | Skill 入口、适用范围与按需路由 | 协作方法或启用边界改变 |
| skills/aichat-graph/references/commands.md | Skill 自带的完整 CLI 参考 | CLI 行为改变 |
| skills/aichat-graph/references/workspace.md | 记录 Agent 的接入、主题绑定与目录识别 | 接入或定位方式改变 |
| skills/aichat-graph/references/maintenance.md | 内容组织、共识、节点与关系的写作方法 | 协作记录方法改变 |
| 新工作区 AGENTS.md 模板 | 工作区本地接入、目录与操作边界 | 初始化指南与程序接口改变 |
| LICENSE、SECURITY.md | 项目许可、安全维护与报告边界 | 授权或安全报告方式改变 |
| THIRD_PARTY_NOTICES.txt、licenses/ | 自动汇集的依赖授权、经核对的补充原文 | 依赖或上游许可改变，由生成器更新声明 |
| .local/、本机配置 | 个人路径、运行版本与本机入口 | 本机设置改变，不上传 |

程序手册 docs/cli.md 与 Skill 的命令参考 skills/aichat-graph/references/commands.md 是两份独立正文；各自面向人和 Agent，
允许重复接口事实，不以链接、生成或转发壳互相代替。两份都标注适用接口版本；发布时用真实 `--help` 和命令核对，不另建同步报告或历史副本。SKILL.md 只保留协作方法与对自身
references 的指引。

产品接入、源文件与图的机制放 README 和程序手册；Agent 如何绑定本对话、
组织内容和判断认可放 Skill。两边可保留独立使用所需的事实与例子，
不把源码构建、宿主安装命令和快照发布步骤塞进日常记录流程。
CLI 接口变化核对两份命令文档及真正受影响的指南；纯写作方法变化只改 Skill。
程序不强制 Skill 的正文模板或共识约定，调用 CLI 不要求安装 Skill。

仓库根目录 AGENTS.md 管开发协作，工作区 AGENTS.md 管本地资料接入，
两者不互相授予权限，也不充当 Skill 副本。
工作区指南模板在 src/storage/init.ts，只对以后初始化的新工作区生效；
程序升级不回写已有指南或用户本地约定。
工程协作、许可和安全说明按现有文件维护，不按程序／Skill 各复制一套。

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
| 源码开发 | 仓库 src/、dist/ | .local/development-workspace、独立本机配置 | start-dev.cmd，4318 |
| 固定版本 | .local/daily、独立运行依赖 | 仓库外资料库、launcher.local.json | start.cmd，4317 |

固定版本是本机构建快照，不是源码分支或安装包；源码变化不自动更新它，讨论资料不复制进去。
两套配置互不继承，开发入口拒绝与已绑定正式库相同或相互包含的目录。
`.local/`、`*.local.json`、依赖和构建产物不上传；个人路径只保存在本机。

日用与开发服务可以同时运行：保留 `start.cmd` 的日用窗口，另开终端运行 `start-dev.cmd`，分别访问 4317 和 4318。
开发 Agent 使用仓库 CLI 与测试库，记录真实讨论的 Agent 使用日用快照内的 CLI 与正式库；不要交叉绑定。
仓库中的修改和构建不会更新运行中的日用快照。只有执行 `update-daily.cmd` 前才需要停止日用服务。

开发入口按需构建当前源码，默认使用独立测试资料：

```powershell
npm ci
./start-dev.cmd
# -NoBrowser 只启动服务；-Help 查看选项
```

启动器发现同一测试库已有服务时会直接复用，不重新构建。试用源码改动时，先在开发服务窗口按 Ctrl+C，再运行 `start-dev.cmd`，由它按需构建并重新启动；日用窗口继续保持运行。

手动启动须自选测试库和端口，启动器隔离检查不会介入：

```powershell
npm run build
node ./dist/cli/index.js init "../graph-test-workspace" --name "Graph test"
node ./dist/cli/index.js serve --workspace "../graph-test-workspace" --port 4318
```

命令行入口可直接用 `node ./dist/cli/index.js ...` 或根目录 `aichat.cmd ...`，不需要安装 Skill。程序完整手册在
`docs/cli.md`；`aichat version` 报告程序版本、接口版本和构建标识，`whoami` 同时报告 CLI 与运行服务的身份。

构建会生成 `dist/build-info.json`（程序版本、提交号、dirty、构建时间），
不得用单个 index.js 哈希代替整个运行版本。
接口版本由 `src/build-info.ts` 的 INTERFACE_VERSION 决定，和 workspace.json 的 schemaVersion 无关。
客户端与服务接口不匹配时拒绝在线连接并提示更新；read 可转为无凭据的磁盘读取，
明确 source 与 online.reason，写入不回退，也不自动切换服务。

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

固定版 CLI 为 `.local/daily/dist/cli/index.js`，也可用 `.local/daily/aichat.cmd`。
程序手册随快照为 `.local/daily/docs/cli.md`；开发版使用仓库入口和 docs/cli.md。
续谈信息提供实际位置，程序从运行模块推导入口，不依赖启动 shell 的目录。
更新日用同时更新程序、构建标识、入口与手册；运行服务应对应所用 CLI 的接口。

## Skill 分发与宿主绑定

程序运行不要求安装 Skill。使用 Skill 时，随附命令参考必须适配实际 CLI 接口；
固定版随附目录为 `.local/daily/skills/aichat-graph`，开发版使用仓库 skills 目录。
update-daily.cmd 会携带 Skill，但不会自动同步宿主安装副本。
节点写法、讨论目标绑定和每轮维护由 Skill 规定，不属于程序启动器的工作。

可选适配器 `skills/aichat-graph/scripts/aichat.ps1` 依次查找：

1. 显式 -Cli；已指定而入口不存在时直接失败。
2. 脚本同目录、Skill 根目录的 local.env.json 中的 cli。
3. 仓库内相对推导的 dist/cli/index.js，先核对工程标记。

已安装副本不从宿主祖先目录猜工程，通常依靠显式入口或本机绑定；
所绑定程序必须仍然存在。local.env.json 的 workspace、source 等只是定位线索，
适配器不自动套用工作区或执行 source 同步，每条操作仍显式给 --workspace。
配置保留全部原始内容，不入仓库，也不随通用文件覆盖。

同步时显式指定宿主或绝对目标，二者互斥；-Daily 选择日用快照，显式 -Source 优先。

```powershell
pwsh scripts/install-skill.ps1 -Daily -Host codex
pwsh scripts/install-skill.ps1 -Daily -Host workbuddy
# 自定义安装目标；使用真实位置替换占位值
pwsh scripts/install-skill.ps1 -Source '<Skill来源>' -Target '<安装目标绝对路径>'
```

同步只覆盖 SKILL.md、references 和 scripts，保留 local.env.json，不生成或猜测绑定。
各宿主分别核对通用文件、配置是否保留，并使用各自适配器执行 --help、version；
在线身份有疑问时再 whoami。文件一致不代表宿主已经加载，也不证明真实工作区可写。

CLI 接口改变时，先使程序和服务对应，再同步适配该接口的 Skill。
运行中不能强行替换日用程序，也不能先用新 Skill 指导旧接口。
仅 Skill 说明／脚本排版变化、且完整 CLI 运行构建同版时，
可用安装同步工具显式 -Source、-Target 更新日用 Skill 目录，再分别同步宿主；
不能只比较 index.js 哈希就认定整个运行版本相同。

适配器和安装同步工具需要 PowerShell 7（pwsh）；start*.cmd 使用 Windows PowerShell 5.1。
新增或修改脚本时核对对应环境，不要求普通 CLI 调用者为 Skill 安装 pwsh。

## 模块与数据流

Node.js／TypeScript ESM 服务通过 HTTP／SSE 连接 React／React Flow 阅读界面。依赖版本不在文档重复列举。

| 模块 | 职责与边界 |
| --- | --- |
| src/core/ | 纯解析、结构校验、Markdown AST 与章节读取；统一 parseWorkspaceDocuments 入口，不读写磁盘 |
| src/storage/ | 扫描、初始化、纯候选变更、可恢复事务；changes/common.ts 放候选公共壳逻辑 |
| src/index/ | 从解析结果派生索引、唯一搜索与读取视图投影，不成为正文来源 |
| src/service/ | 锁与队列、有效快照、读取凭据、HTTP API、导出调度；agent/ 下按 schema／read／compile 分工 |
| src/shared/ | 跨层类型（protocol.ts，type-only）与 browser/node 中立的结构判定 guards.ts |
| src/cli/ | transport 统一 HTTP、options 统一参数；按命令职责分文件，不复制解析、业务或事务 |
| src/web/ | 实时与离线共用阅读组件、布局和 Markdown 渲染 |
| src/export/ | 受限资源捕获、安全 HTML 封装，不重新解释思想结构 |

源文件 → 扫描与统一解析 → 结构校验 → 有效快照 → 图、详情、搜索与导出。
Agent 写入 → 凭据检查 → 纯候选变换与全图校验 → 文件事务 → 发布有效快照。
调用方复用公共解析和类型；跨模块调整先核对实际接口，避免各自维护目录解析或 DTO。

候选变更的公共壳逻辑在 `src/storage/changes/common.ts`；`src/storage/changes.ts` 是唯一候选实现，请求与文本处理在
`src/storage/changes/`，格式读写在 `src/storage/format.ts`。
HTTP 请求解析与响应组装在 `src/service/http/`；服务 Agent 动作的 schema、读取和编译分在 `src/service/agent/`；
导出路径防护与冻结文档组装在 `src/service/export/`，队列及覆盖时序仍由 ExportCoordinator 管理。
布局入口在 `src/web/layout/index.ts`；搜索唯一实现是 `src/index/search.ts`，CLI 与服务端不另写匹配、排序或 snippet。

CLI 由 `src/cli/` 适配产品能力，`command-specs.ts` 是参数、约束、示例和帮助 JSON
的单一来源；命令实现消费同一张表，不再各写一份选项清单。程序接口版本和构建身份在
`src/build-info.ts`：`INTERFACE_VERSION` 与 `dist/build-info.json` 分别表示协议版本和
“版本 + 提交号”的构建标识。`aichat version` / `whoami` 报告两者；CLI 与运行服务的接口
不匹配时拒绝普通读写，不猜路径或自动切服务。`aichat.cmd` 与 `.local/daily/aichat.cmd`
提供不经 Skill 的直接程序入口。

`src/web` 的阅读端分层：`App.tsx` 组合页面和用户操作；`data/` 管服务快照、详情、导出与阅读状态；`graph/` 管视图投影、边列表、布局输入和 React
Flow 视口适配（`useCanvasViewport.ts`）；`components/` 只做呈现；`layout/` 只做纯几何；`offline/` 只读冻结文档；`lib/`
放跨页面 UI 辅助。实时与离线共享视图、布局输入、布局和呈现组件，各自保留服务连接、冻结数据和写入边界；页面和离线入口不重复拼布局输入或目录派生。

## 命名与组织

- 目录使用下层职责名，小写单数；`src/web` 内按 `components/data/graph/layout/lib/offline/styles` 分工。
- Node/TS 模块多词用 kebab-case（`service-client.ts`、`last-changes.ts`），单词用小写（`parse.ts`）；React 组件
  PascalCase `.tsx`，hooks `useXxx.ts`，Web 其他模块 camelCase `.ts`。
- 类型/接口 PascalCase；函数/变量 camelCase；模块级常量 UPPER_SNAKE；布尔值用 `is`／`has`／`can` 前缀。
- CLI 命令与选项 kebab-case（`create-topic`、`--from-ref`）；协议 JSON 字段 camelCase；错误码 UPPER_SNAKE。
- 测试文件 `<subject>[-aspect].test.ts`，目录镜像 `src` 的层；合成 fixture 放 `tests/fixtures/`。
- `index.ts` 只用于模块边界入口；不为已无使用者的旧内部路径保留 re-export、别名或转发层。
- 新文件或重命名先确认职责独立或确有使用；不以行数或“更整齐”为目标拆文件，也不为统一而改稳定 CLI 命令、协议字段或讨论源格式。

## 源文件与主题结构

当前工作区采用格式 2：

```text
workspace.json                     # 身份、schemaVersion、topicMode、焦点
topics/<主题目录>/topic.md          # 仅主题元数据
topics/<主题目录>/<nodeId>.md        # 单节点头信息与完整正文
AGENTS.md                          # 工作区维护入口
.aichat/cache/                     # 可重建轻量索引与哈希
.aichat/local/exports.json          # 本机导出绑定与成功版本
.aichat/runtime/                   # 服务定位、锁、恢复证据；last-change.json 按主题记最近一批内容更新
```

主题目录是 topics 下一级；topic.md 为保留名称，严格头信息只有 topicId、title，正文为空白。
节点身份来自 nodeId，不从文件名、标题或显示编号重建。目录或文件改名不改变身份，移动节点仍须通过结构校验。
不允许重复 ID、孤立 Markdown、悬空连接或符号链接。

节点头必需 nodeId/title/state/from/flow；非根须有非空 description，根的 from 为 null 且无 description。
branch 才能有 side/order，summary 可选，`important: true` 可选（缺省即未标记，取消时移除该字段），未知字段拒绝。
ID 使用 n_/t_/w_ 加 32 位小写十六进制；state 为 agreed/proposed/reference，认可不代表执行、实测或掌握。
新提议默认 proposed，不从父节点继承认可。精确字段约束见 schema 定义。

严格解析 UTF-8 与 YAML，拒绝重复键、别名、自定义标签和多文档，修改保留 BOM 与换行形式。
哈希来自真实原始字节；文本范围是实际 sourcePath 的 UTF-16 半开区间，不用合成全文或伪造范围修改源文件。
topic.md 哈希不能代替节点正文哈希，主题 contentHash 与单文件 fileHash 分开。
图响应不携带全部正文；详情按有效快照返回真实路径、正文和哈希，索引覆盖全部源文件。

当前唯一格式：一节点一份 Markdown、isolated 主题。每个非空主题恰好一个根，其余节点同主题、单父、无环且从根可达，各主题从 01 编号；`rootIds`
是各主题根的唯一集合。空库合法，主题不能只剩空占位。`workspace.json` 的 `schemaVersion` 固定为 2，`topicMode` 缺省或为 `isolated`；
不再接受 shared、格式 1 或 rootId。

next 纵向继续，每个来源最多一个；branch 从侧面进入，枝内可继续 next 或再分支。
同一来源 branch 的显式 order 跨左右唯一并升序，缺省按稳定 ID 后置；新建默认右侧、最大 order 加 10。
主线 06 → 07 不因侧枝 06-03 而改变。编号由结构派生，不写回源文件。
主题连续阅读按派生结构顺序过滤节点，不按文件名排序。
description 解释为何 A 接到 B，不自动表示证明、因果或认可；改接来源须显式提供或确认描述。

## Agent 读写与提交边界

完整命令行为见 [程序 CLI 手册](docs/cli.md)；Skill 自带的 [命令参考](skills/aichat-graph/references/commands.md)
从讨论维护流程出发独立说明同一接口。此处保留实现约束。
Agent 根据用户主题名、目录或复制上下文核对稳定 topicId，在当前对话沿用。
前端浏览、工作区焦点与对话写入目标独立，不通过共享 activeTopic 控制多个对话。
查询先按主题过滤再分页；默认有界、显式请求才取全文，不因此限制源正文长度。

在线读取在响应顶层 `refs[nodeId]` 签发 opaque token；content 只为当前页实际返回节点签发，overview／structure／离线为空。
写入成功结果同样使用顶层 `refs`，不再有 editRef／editRefs 的提取位置；batch 的局部名称到稳定 ID 映射另放在 `created.aliases`。
凭据绑定实例、工作区、节点、真实路径与读取时哈希；离线读取不伪造写凭据，重启或过期后重新读取。
无关文件的 revision 变化不单独使节点凭据失效。编号只在读取时解析为稳定 ID，不在提交时重新定位。

- patchNode 的片段替换须非空且唯一匹配，replace/append/body 互斥，不借修改正文重填其他字段。追加段落由 storage 统一规范化为恰好一个空行，不因
  JSON、文件或 stdin 产生不同正文。
- createBranch/createNext/createRoot/createTopic 可使用来源凭据并一次给 summary；createNode 支持 important。已有
  next 时拒绝冲突，不挤掉主线。
- updateConnection 改接须有目标凭据、来源 fromRef 与描述，不隐式创建第二根；root 不允许改接。
- rearrange 一次表达多条最终入边，编译为同一批 updateConnection：先在内存腾空需要让出 next 的节点，再按最终关系落位，
  中间状态不写盘、不产生临时说明或临时旁支。目标位置的后继须由调用方纳入同批 edits，工具不隐式覆盖；最终唯一 next 与无环由整图校验拒绝。成功后返回受影响节点的顶层 refs。
- batch 在一次事务内处理一个已存在主题的 edit／create／connect／important：
  已有凭据按批前状态解释，local 只在本输入有效并支持前向引用；先做最终关系与
  整图预检，再按腾空→create→最终 connect→patch／important 生成一个 ChangeRequest；
  同节点 edit／connect／important 可共存，重复同类或成环／唯一 next／占位冲突整体拒绝；
  不发布中间结构。dry-run 只检查候选，state=checked，不落盘、不更新最近内容、
  不签发写凭据。
- insert 语义固定为 A→N→B→C：要求 after 与 before 当前同主题真实相邻 next，两条新关系说明由调用方给出，复用 batch 核心一次提交；不降级为
  append／branch。
- setImportance 只改节点头 important，不进入最近内容更新；CLI important 的 --ref 使用读取时哈希，--node 先做一次真实在线 meta
  读取取得凭据，离线不伪造。
- 阅读提供 overview／structure／content 三种可选粒度：主题默认 overview；structure 返回指定范围的真实连接与必要边界，不默认带正文、长路径或凭据；
  content 复用节点正文、章节和在线凭据。三者不是必须逐层经过的流程，已知节点可直读。
- 范围按稳定 topicId／nodeId 与真实连接计算：整主题、从起点沿 next／branch 可达的子树，或明确节点集合；子树起点在主线中段时包含其后主线延续，边界节点只用于说明归属。
- 读取预算覆盖最终序列化输出（紧凑 JSON 加结尾换行，含 envelope、items、
  page.next、budget、fingerprint），默认 12000 UTF-16，可由 --budget 调整；
  CLI stdout 与服务读取端点复用同一字符串，budget.used 可直接与原始输出长度核对。
  分页和正文续读由程序组织，cursor 是不透明标记，绑定 mode／workspace／topic／
  view／scope／相关指纹，不建立服务端分页会话。相关节点或结构变化返回 STALE_READ
  并给重新读取入口；无关主题变化不使范围失效。
- page.hasMore 只表示当前视图还有下一页；正文 item.truncated 表示该卡还有正文
  未返回；overview 的分支内部未展开由 scope.note 说明，三者不能混成一个 complete 字段。
  显式 --full／--length／--start／--from-heading／--occurrence 是精确读取，
  超过 budget 明确拒绝，不静默截断。`--from-heading` 从该标题开始读取，不是只读一节；
  `--occurrence` 是 0 起同名标题序号，只能与前者同用。
- 在线 content 的凭据只在响应顶层 refs，且只覆盖当前页实际返回节点；离线 refs 为空。cursor 只承接读取，不替代凭据，也不用于刷新旧哈希强行提交。
- createTopic 在 isolated 模式原子创建主题与根，目录冲突不覆盖；createRoot 仅用于空库。
- 同一 requestId + 相同请求体重放返回原响应，包括全部 batch local→nodeId 映射（created.aliases）与 refs；不能只保存第一个生成 ID。
  高层动作进入统一 prepareChanges/commitFiles 链路，结果未知先查原 requestId。
- dry-run 与真实提交共享候选检查，但不写源、不写最近更新、不写幂等记录；dry-run 成功不保证后续提交免于重新检查版本。

expectedFiles 使用签发时哈希，不能提交时偷读最新值绕过冲突。
已有受影响文件和决定修改所依据的来源均检查旧哈希，新文件须声明不存在。
过期返回 412、语义冲突 409、格式错误 422。提交结果未知时先查原 requestId，不换请求盲重发；记录不是永久账本。
不用 replaceTopic 模拟整主题正文，修复定位真实节点文件。

## 事务与有效快照

proper-lockfile 与 WorkspaceRuntime.queue 协调单写者；监听重载、check、apply、发布及导出配置变更串行执行。
prepareChanges 是纯候选变换，不取锁、不写盘，提交前验证完整结构。

事务先持久化 before/after 与完整日志，再 prepared、逐文件可靠替换、committed，快照确认后清理。
prepared 回滚只覆盖仍匹配 before/after 的文件；committed 不因发布失败回滚，而返回 committed_refresh_pending。
日志缺失、外部字节冲突或恢复歧义须保留证据并停写。删除用 content:null、afterSha256:null 表达，runtime 不能当普通缓存清理。

外部编辑不得与托管提交并行改同一批文件。无效磁盘不发布新图、不自动修正文；运行中保留上一有效内存快照与诊断。
冷启动从真实源重建，不用轻量缓存伪造有效正文。完整正文不另存长期 JSON 镜像；事务证据和独立 HTML 不属此类镜像。
快照使用 instanceId/revision，过期详情返回 409 STALE_SNAPSHOT，SSE 传元数据而非整份正文。
最近一次内容更新只取最终真实写盘的节点文件：同批改回原值、仅改重要性、删除都不计入，候选过程中的临时改动不得混入。
该记录按稳定 topicId 分别保留一批；同次提交涉及多个主题时分别替换对应集合，其他主题不变；无内容修改时保留。

当前只有一种正文组织：`workspace.json` 声明 `schemaVersion: 2`，每个主题一节点一份 Markdown。读取和写入都按这一模型校验，
不保留格式分派、旧格式读取或迁移命令。

## 单文件 HTML 与本机导出

一个主题一份成品，包含同一冻结有效快照的全部节点、正文、关系和必要资源，不受折叠、搜索、视口过滤。
OfflineTopicDocument 是生成时传输结构，不是长期源镜像，不混用不同 revision。

只捕获正文明确引用的 resources 内普通 PNG/JPEG/GIF/WebP 文件或安全 raster data URI；单件 8 MiB、总计 32 MiB。
路径不经链接逃出工作区，不扫描附件库、不抓网络图、不支持 SVG。资源字节、哈希与错误属于冻结快照，变化进入监听与内容指纹。
缺失、超限或不支持时导出报错；图可保留文字与诊断，不能生成貌似完整的成品。

实时与离线复用阅读组件、布局和 Markdown 渲染，构建生成 dist/offline/reader.js 与 reader.css。
HTML 内联脚本、样式、公式字体和必要资源，无 CDN、fetch、EventSource、外部 Worker 或旁边 assets 依赖；服务不临时执行 Vite。
共享阅读组件将项目许可与第三方声明作为纯文本编入读者，实时与离线底栏均可打开完整声明；许可变化自然进入 reader 构建指纹，不改变思想内容。
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

内容指纹排除自身、instanceId、revision、生成时间；成品指纹另含 reader 构建与导出格式。节点头里影响呈现的字段（如 important）参与指纹，
否则标记变化后成品会停在旧状态。
离线只读取重要标记用于显示，不提供写回；标记变化与内容变化一样触发重新导出。
当前与最后成功内容指纹须同域可比较。重启核对归属、实际字节与指纹，缺文件或内容/reader 变化时补生成。
失败保留旧成品与绑定，显示 error/stale；源无效时不声称已同步最新磁盘。
已打开的离线页面不自动刷新、不写回源、不跟随服务继续更新。

## 阅读状态与本机安全

主题目录只展示主题和节点，隐藏内部文件；选主题打开自己的图，不自动打开长正文。
左右栏初始关闭，单击节点只选中，显式打开详情才展开右栏；导航入口按需打开左栏。
各主题分别恢复位置、选择和折叠；无有效主题时提供选择入口，不合并全库图。
左栏开合同样按主题保存，刷新或组件重建后恢复；目录树自己的折叠状态独立保存，折叠目录不折叠图，反之亦然。两者都只存在本机阅读状态里。
卡片上不放“全文”或方向文字：单击只选中，双击打开右栏详情；关系方向由连线表达，源 side 字段保留但新布局不据此选择左右。
详情里的“复制定位”给出工作区、workspaceId、topicId、nodeId、节点源文件、同版本 CLI／Skill 入口与当前编号标题，重排后仍可凭 ID 找回。
主题名称可见，搜索限定当前主题，复制续谈上下文携带工作区、稳定主题身份和同版本入口，不带无关正文。

主线与分支采用确定性布局，卡片不随正文扩张；更新和面板开合尽量保持锚点、缩放，不自动 fit 全图。
selectedNodeId、activeNode 与内容 state 独立；只读界面不增加拖线、自由坐标或网页正文编辑。
用户视图不限制 Agent 读取范围，也不自动决定模型上下文。

主题目录使用同一份层级投影：主线 next 节点同级；某节点的直接 branch 子链紧随该节点并深入一级；branch 链中的 next 与链首同级；branch 的 branch
再深入一级。排序、缩进、展开图标、目录折叠范围和 +N 隐藏数都由这份投影派生，不再按编号连字符数或真实 from 的 next 先序分别计算。折叠目录节点不隐藏同级主线，目录折叠仍与图折叠独立。

实时卡片始终保留 importance 操作入口：未标记时可设置，已标记时可辨认并取消；操作按稳定 nodeId 提交，不要求先选中，也不改变卡片高度、讨论状态或最近更新集合。
实时详情与卡片读取同一份标记；离线成品只读展示星标与详情标记，不提供写入。
初始化恢复已有选中项与 viewport 时保持原阅读位置；没有恢复选中项时，用户首次从目录、搜索或定位入口选择可见节点属于主动导航并居中。隐藏目标不自动展开图折叠祖先，选择保留，
待其可见后再尝试定位。

页面外壳占满动态视口（100dvh，100% 回退），html／body／#root 不参与文档滚动；目录、详情、导出以及代码表只在各自容器内滚动。窗口调整和面板开合后，
header、状态栏和画布仍完整位于视口内。

服务仅绑定环回地址与固定工作区，端口冲突报错；校验精确 Host、同源 Origin、JSON 与 X-AIchat-Client:cli，不开放宽泛 CORS。
CLI 核对运行描述、工作区/实例身份与真实根，不自行启动第二写进程。
源路径规范化并经 realpath 防越界、拒绝符号链接；Markdown 阻止 javascript/file 等危险链接。
安全依赖同机文件权限，不声称能抵御已控制本机的程序。

## 前端排版规则

布局在 `src/web/layout/`，实时页面与单文件 HTML 共用同一模块、同一套尺寸常量和同一份标签几何；几何只由结构、每卡高度、关系文字折行和间距决定。

- 从主题根沿 next 收集一条链；每个 branch 目标是另一条链的链头。每个可见节点只属于一条链，分支可以从链中任意节点发出。
- 链块以链头卡片左上角为局部原点自底向上测量：链上每个节点与它的直接分支组成一个完整纵向区域，本链 next 只在这个区域结束后继续向下，因此主线可以被分支的完整高度拉长。
- 同一来源的直接 branch 子块在来源卡片右侧的同一列起点上下堆叠；兄弟按 order 升序、缺失后置、同序按稳定 ID 排序，不再左右择侧、不再各占一列。子块自己的 next
  仍沿本列向下，再分支继续向右。
- 分支子块的入线标签框位于自己那条独占横线的上方，并参与堆叠占位：标签高于首卡上半部时先留出顶部溢出，兄弟之间保留固定间距。不允许把标签塞进卡片、截断文字、隐藏标签或改写源说明。
- 链块宽度取最宽的子块，不按窗口宽度平均摊开；整个森林在最左侧按根块自上而下排列，不横向铺开根节点。
- `side` 由源记录保留，但新布局不再解释它，统一向右呈现；不为布局批量改写或补写 side，也不再维护左右两套布局。
- 卡片高度随标题行数变化，由 `src/web/graph/cardMetrics.ts` 按保守字宽估算（宁多一行不少一行）；布局的步进、边界、路由、Worker
  与离线输入使用同一个高度。标题不截断，概述固定三行预览；标题变化会重排，锚点补偿保持当前阅读位置。
- 关系文字取 `description`，由布局按共享折行规则生成完整标签框（不设最大行数、不加省略号），并计入 nextGap 或分支兄弟堆叠。长 next 标签把主线下一个节点向下推；
  长 branch 标签通过顶部占位把子块下推。
- 折叠只影响可见集合，隐藏子树不占位；重新展开时按当前结构重新测量，不保留旧空洞。
- 更新时稳定 ID 与分支顺序不变；给某个分支增加内容只把它自己和下方兄弟/本链后继向下推，上方兄弟不动；收起释放空间。阅读锚点由现有视口补偿保持。

链块和标签占位在 `src/web/layout/measure.ts`，路由、干线和标签框在 `src/web/layout/routing.ts`；间距和标签度量由
`src/web/graph/cardMetrics.ts` 统一提供。容器框只存在于计算中，不显示为卡片、色块或标题。

改布局前先确认 `src/web/layout/types.ts` 的输入输出契约：`LayoutNodeInput` 的 `height`、`label`、`order`；
`LayoutResult` 的 `positions`、`heights`、`edgeRoutes`（`points`、`trunkId`、`label`）、`branchTrunks`（竖
向共享干线）、`bounds`（含标签框）与 `layoutVersion`（当前为 5）。阅读界面、Worker 协议和离线成品按同一契约适配，不另写一套排布或标签放置逻辑。实时 Hook
与离线入口的布局输入统一由 `src/web/graph/layoutBridge.ts` 的 `layoutInputForView` 生成，页面不再各自拼 `LayoutInput` 字段。

### 连线与关系文字

连线属于显示几何，不改变 from/flow/order、编号与连接语义。测量在 `src/web/layout/measure.ts`，路由在
`src/web/layout/routing.ts`，呈现在 `src/web/components/RouteEdge.tsx`、`TrunkEdge.tsx` 和
`edgePath.ts`；尺寸与折行复用 `src/web/graph/cardMetrics.ts`。边的列表顺序在 `src/web/graph/flowEdges.ts`，
干线必须最后绘制，以覆盖共享支线的端部。

- next 从源卡底边中心连到目标卡顶边中心；两点同 x 时是一条直线。next 标签位于源卡下方、源卡与目标卡之间的空隙，背景使用画布底色断开自己的线。
- branch 从来源卡右边发出。单个分支走一条从源卡边缘出发的短折，等高时退化为一条水平线，不产出干线。
- 同一来源有多个 branch 时共用一个出口和一条竖向干线；干线只绘制一次，每条分支只绘制从干线接出到目标卡左边中心的独占横段。逻辑关系数与 SVG 路径数不必相等。
- 干线从源卡右边缘的横向接入段接到共享通道，再沿通道向下；首条支线接入处是横向段、竖向段与支线的 T 接。渲染把同一 path 拆成横向段和竖向段两个子路径，首接处保持直角，
  不再用圆角切掉入口，也不画起点大圆点。单支从卡边直接走短折，同样不画圆点。
- 干线为略重实线，next 为实线，branch 支线为虚线。共享干线的端点用平头（butt），支线接出处由最后绘制的干线覆盖；独立连线的转角按相邻线段自适应圆角，半径不超过短段的一半，
  短于阈值时保持直角，避免短线被弯过头。画布通过 `--edge-scale` 对描边和虚线节距作有上限的缩放补偿，提升概览可见性。
- 关系文字每条一份，靠近自己的独占支线：branch 标签在源卡与目标卡之间的通道内、自己独占横线的上方，next 标签在源卡下方；标签不覆盖共享干线、卡片、独占横线或其他标签。
- 标签框由布局输出，阅读界面只绘制，不再自行搜索候选位置或另做碰撞避让。实时与离线使用同一份结果。
- 折叠只画可见分支所需的干线，没有可见成员时不产出干线。

本轮布局采用项目专用的递归链块，没有引入新的通用布局依赖。参考了 AntV CompactBox/non-layered tidy 的完整子树测量与兄弟分离、SimpleMindMap
VerticalTimeline/CatalogOrganization 的完整块堆叠与向下推进、ELK Layered 的端口约束和边标签参与布局；但没有让通用树算法重新解释
next/branch、改接来源或任意改变分支顺序。

图区域视觉以持续阅读为准：标题、摘要、编号和状态有固定层次；卡片边框、圆角和阴影克制；共享干线比独占支线略重；关系文字小号、贴近自己的线；选中、键盘焦点、悬停和最近更新各自可辨。
明暗主题沿用现有语义色，不新增按分支分配的颜色。标签字号和行高必须与 `cardMetrics` 一致，不能只改 CSS 造成布局与文字错位。

验证按改动选择：类型检查、受影响的布局/阅读/导出测试与正式构建；先用代表性合成图（主线、同源不同长度分支、中段再分支、长标题/多行关系说明、折叠与增长）判断实际排布，再做必要程序检查。
改到共享呈现或导出链路时抽查单文件 HTML 的离线布局、标签和许可入口；涉及主题样式时抽查明暗主题和窗口适配。

## 实践反馈与待验证

本文件上方契约记录当前稳定行为；本节只保留尚未实现、尚待真实使用确认或明确保持现状的边界，不记录逐轮过程。
反馈以“能复现的操作 + 期望结果”记入；处理完成后把稳定行为并入上方对应契约，并删除该条。

### 操作能力与当前限制

- batch 只处理一个已存在主题，不创建主题、不跨主题；主题创建仍走 create-topic。
- insert 只处理当前真实相邻的 next；更复杂的结构变化用 batch 或 rearrange，不能降级为 append／branch。
- 尚无面向 Agent 的便捷合并／删除入口；底层已有 `removeLeaf`，不能描述为完全不支持删除。如何整理重复节点仍需兼顾正文保留与最终结构。
- 界面搜索不自动展开折叠祖先，只匹配编号、标题与摘要，最多返回 60 个节点；不等于 CLI 的正文搜索。命中隐藏节点时，选中与画布定位之间仍有断点。
- 离线成品的阅读位置、选择和折叠只保留在当前页面状态中，刷新后重置；实时版的持久化能力不应被概括为离线也支持。
- 外部直接编辑源文件不产生最近更新记录，维持现状。
- 不同宿主实际输出截断阈值仍需在真实对话观察；本程序预算不能保证任意显式大输出都不会被宿主截断。
- 安装副本按宿主分别同步并保留本机绑定；宿主实际加载、`whoami` 与真实工作区是否匹配仍以各宿主实际入口核对，文件哈希一致不等于已经验证宿主加载。

### 待真实阅读反馈

- 同一来源的多个分支现在上下堆叠、共用一条竖向干线；分支很多时右侧区域会沿纵向变得很长，是否需要更明显的概览或折叠优先入口，按真实阅读反馈决定。
- 关系文字不再截断，很长的说明会拉开 next 间距或分支堆叠；标签框在画布底色上读取是否仍清楚，按真实阅读观察。
- 源 side 不再决定左右；详情里的“右侧分支”描述的是当前呈现，不是源 side 的约束。旧数据中 side 为 left 的条目需要按新呈现理解。
- 分支入口与分支内的 next 共用前缀序号，编号本身不能区分两者；目录按真实 branch 链投影，不改变图的语义。图上是否还需更明显的分支入口提示，按实际阅读反馈决定。
- 为卡片双击而关闭空白双击缩放；若影响使用，先核对事件能否分开处理，不把“牺牲缩放或加回按钮”当成唯一二选一。
- 最近更新红点是否配文字属于呈现微调，不改变更新语义或状态配色。

## 按改动选择验证

复用现有检查，不默认重跑全部历史验收，不以测试数或覆盖率为目标。

| 改动 | 必要检查 |
| --- | --- |
| 文档、注释、Skill 文字 | diff、引用目标及文字含义、隐私边界；不为此构建或跑全量测试 |
| 界面 | 相关类型/现有测试，实际浏览器核对受影响目录层级、定位、卡片交互、窗口适配与阅读位置 |
| 布局与路由 | typecheck、tests/layout、相关 tests/web、构建；代表图排布、折叠增长、标签及实时／离线一致 |
| 主题与存储 | 隔离样例的身份、关系、旧凭据冲突、无效源与恢复保护 |
| 渐进读取 | 范围与边界、预算、分页及 cursor；离线无凭据；正文定位、输出长度正确 |
| CLI 帮助与版本 | 相关类型与 tests/cli；无工作区帮助可用；双方版本诊断；两份 CLI 文档独立可用 |
| 批量写入 | 混合提交、插入与重排；幂等、冲突、noop、重要性、最近更新及 dry-run |
| 导出 | 完整隐藏分支、同路径更新、失败保留旧文件、重启补齐；移走单文件停服后核对新布局、标签、交互和许可入口 |
| 运行版本 | 独立资料配置、同版本入口、固定快照更新失败保护 |

渐进读取核对 overview 的主线／直接分支及 scope、structure 边界；
小预算、多卡和长文续读不漏内容，cursor 随相关变化失效、无关主题不影响；
显式 full 超预算拒绝，budget.used 对应原始 stdout，from-heading／occurrence 定位准确。
CLI 帮助核对总入口、单命令及 help JSON，version／whoami 区分程序、接口和构建；
接口不符拒绝在线连接，read 回退磁盘时明确来源；两份文档各自能指导定位、读取和一次写入。
批量写入核对补充旧问题＋创建新问题、insert A→N→B、现有重排；
同 requestId 多节点重放不重复，aliases／refs 一致；过期、占位、成环和跨主题在提交前整体拒绝。
noop、仅 important 和混合批次的 lastChanges 正确，dry-run 不落盘、不签可写凭据。

代码集成按需要执行：

```powershell
npm run typecheck
npm test                 # 全量 vitest；改动较大或跨模块时使用
npx vitest run tests/cli tests/service   # 或按受影响目录/文件缩小
npm run test:web
npm run build
```

导出与离线相关用例读取 `dist/offline`，干净检出上先执行 `npm run build`；普通主题/CLI 用例不依赖离线产物。
离线成品的手工诊断入口（只打印事实，不作为自动回归）：`node tests/web/check-offline-bundle.mjs`、
`node tests/web/offline-e2e.mjs`；`node tests/web/mock-api.mjs` 只用于前端本地假数据，不能当作工作区样例。

离线能力查生产成品，不只查开发服务器；普通浏览器通过不等于 Obsidian 内嵌通过。
用合成隔离样例，优先 DOM、几何和文件证据，不例行截图、不发布真实内容。
Agent 工作流改变时复用独立 Agent 经 Skill 做相关读写闭环，核对真实源、界面与成品。
只有新增具体风险才扩大检查，程序验证不代替用户对交互、理解和掌握感的认可。
提交前排除个人路径、真实讨论、凭据、配置和成品；提交、推送、发布须有相应授权。
清理本任务临时资源，保留用户资料和未恢复证据。

## 开源分发

项目许可由根目录 `LICENSE` 定义，package 与 lock 根元数据使用 SPDX `MIT`；`private: true` 只防止意外发布到 npm，不限制 GitHub
上的源码开放。

`npm run notices` 按 lock 中的生产依赖记录和实际安装包授权文本生成 `THIRD_PARTY_NOTICES.txt`，另保守保留 Vite 注入 helper
的许可与 KaTeX 字体许可。它是分发声明集合，不是精确的浏览器打包清单；相同全文合并后映射回每个包名和版本。`licenses/` 仅保存发布包缺失或需要额外附带的上游原文，
来源与适用版本固定在生成器中。

构建及 Web 开发入口自动生成声明，Node/Web 构建同时将 `LICENSE` 和完整第三方声明复制到 `dist/`；日用更新一并携带。源码分发保留根目录声明，
程序分发保留这两份文件，独立 HTML 的声明由共享阅读组件内嵌，不要求旁边另放附件。

依赖变化后提交重新生成的声明，用 `npm run notices:check` 核对确定性结果。不手工维护依赖清单、不删减上游版权文本；缺失原文、安装版本不匹配或出现未经核对的许可类型时，
先核对上游再补显式规则，不能用项目 MIT 代替。
