# AIchat-graph CLI 手册

适用接口版本：2。程序版本以 aichat version 的实际输出为准。
本手册面向人、脚本作者和任意 Agent，说明完整 CLI 行为；Skill 自带的命令参考是另一份独立文档。两者都应按实际命令核对，不以测试数量代替可用性结论。

## 入口与版本

仓库源码构建后有三个等价入口：

    node dist/cli/index.js <command> [options]
    npm start -- <command> [options]
    .\aichat.cmd <command> [options]

日用固定版本在 .local/daily：

    .local\daily\aichat.cmd <command> [options]
    node .local\daily\dist\cli\index.js <command> [options]

安装到宿主 Skill 目录的 aichat.ps1 是宿主适配器，不独占程序能力；它最终调用同版本的 CLI。
不需要为了执行命令而安装 Skill，也不要求把程序加入全局 PATH。

除 init 用路径创建、帮助／版本／纯本地自查外，命令都要求显式或默认的工作区；只有读取类可离线读磁盘，写入必须有同工作区服务。
本程序不通过交互式提问补齐参数，缺少必填参数时直接失败并返回非零退出码。

### 版本、接口与构建

    aichat version
    aichat version --json
    aichat --version
    aichat -V

version 返回程序名、程序版本、接口版本、构建标识、提交号和构建时间。接口版本不是 workspace.json 的 schemaVersion，也不能混用。
构建标识来自构建清单 dist/build-info.json，综合程序版本与提交号，不用某个单文件哈希冒充整个运行版本。

    aichat whoami --workspace <path>
    aichat whoami --workspace <path> --json

whoami 核对并报告描述文件、运行服务、当前磁盘和真实工作区身份，同时给出本 CLI 与服务的接口版本和构建标识。接口缺失或不匹配时，whoami 仍尽量完成诊断；普通读取和写入会明确拒绝，不猜其他程序路径，不自动切换服务或工作区。
升级或更新固定版本后，应停止旧服务、启动同版本服务，再让 CLI 指向同版本入口。不要用新 CLI 写旧服务，也不要把只更新 Skill 当成更新程序。

## 工作区与服务

工作区保存 Markdown 源；程序缓存、服务描述和最近更新记录位于 .aichat/。工作区应独立于源码和构建产物。

    aichat init <path> [--name <名称>]
    aichat serve --workspace <path> [--port <端口>]

init 只创建不存在的新目录，不覆盖已有工作区。serve 默认 127.0.0.1:4317；端口冲突明确失败，不自动换端口，也不结束其他进程。
同一工作区已有服务时不要启动第二个写进程；服务不可用时可只读磁盘，写入必须拒绝。

常用检查：

    aichat topics --workspace <path>
    aichat validate --workspace <path>
    aichat whoami --workspace <path>

topics 返回稳定 topicId、标题、入口路径和节点数；validate 检查磁盘结构与整图。日常保存后不必固定运行 validate，只有诊断异常、外部直接编辑或怀疑损坏时才需要。

## 帮助与本地自查

    aichat --help
    aichat <command> --help
    aichat help <command>
    aichat help <command> --json
    aichat help --json

aichat --help 只给能力分组、常用命令和进一步查询方法。
aichat <command> --help 只解释当前命令，不附整份命令大全。
aichat help <command> --json 返回机器可读说明，至少包含参数、必填性和默认值、互斥关系、输入结构、语义约束、最小合法示例、结果关键字段与下一步。
这些帮助和自查不需要工作区、运行服务或安装 Skill。

机器说明中的 JSON Schema 只描述结构；批次的原子性、局部名称生命周期、批前凭据、唯一 next、文件路径由 CLI 解析等语义会另行列出，不能把 JSON Schema 当作完整语义证明。

## 约定与输出

默认输出 JSON。--text 是简短人类摘要，不保证包含所有标识和凭据。大多数命令支持 --json 与 --text 二选一。
所有命令都按需接受 --workspace；省略时使用当前目录，serve 例外，必须显式给出。
写命令的 --verbose 才输出路径、前后哈希、字节数、事务和完整服务身份；默认结果保持精简。

Agent 高层写命令（edit／branch／next／connect／insert／batch／rearrange／important／create-*）的默认结果是顶层对象，不再包在 result 里：

    {
      "ok": true,
      "command": "batch",
      "workspaceId": "w_...",
      "topicId": "t_...",
      "requestId": "uuid",
      "state": "committed",
      "revision": 12,
      "changedNodeIds": ["n_..."],
      "created": {
        "topicId": null,
        "nodeIds": ["n_..."],
        "aliases": { "new-question": "n_..." }
      },
      "refs": { "n_...": "opaque-token" }
    }

默认至少保留 ok、command、workspaceId、topicId、requestId、state、revision、
changedNodeIds、created.aliases、refs 和有实际意义的 diagnostics；
noop 或 committed_refresh_pending 时 refs 可以为空。
底层 check／apply 仍使用各自的 {ok,command,requestId,httpStatus,service,result} 外壳，
不等同于高层写结果。
created.nodeIds 是本批创建节点；created.topicId 在创建主题时有值。refs 的键是稳定 nodeId，值是后续写入使用的 opaque token。
--verbose 才增加 httpStatus、service、transactionId、journalCleaned、touchedFiles、created.paths 和 created.topicPath。

读取结果不是写结果的外壳：它直接返回 ReadViewResponse，refs 同样在顶层。overview、structure 和离线读取的 refs 是空对象；content 在线读取只为自己实际返回的节点签发 refs。

### 提交状态

- committed：已提交并发布新快照。
- noop：没有实际内容变化，不需要再提交一次。
- committed_refresh_pending：源文件已提交，但快照刷新待完成。按诊断核对服务和源内容，不能当作未写入而重复创建；此时 refs 为空。
- checked：仅 batch --dry-run 出现的检查状态，未落盘、未更新最近修改，不能当作 committed。

### 退出码与错误

成功为 0，写入仍要看 state。常见退出码：

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 用法、输入、范围、预算或参数错误 |
| 3 | 工作区或 workspaceId 不一致 |
| 4 | 412 版本冲突；重新读取后再修改 |
| 5 | 409 语义冲突，或 STALE_READ 读取范围失效 |
| 6 | 422 结构校验失败，或离线 validate 不通过 |
| 7 | 服务不可达、身份/接口不匹配、描述文件陈旧或启动失败 |
| 8 | 写入结果未知；先查原 requestId |
| 9 | 非标准 HTTP 错误或端点缺失 |
| 10 | 未预期内部错误 |
| 11 | 找不到节点、主题或文件 |

默认 JSON 模式的错误写到 stderr，形如 ok:false、error:{code,message,details,diagnostics,usage}。
--text 模式才输出人类可读错误。退出码相同不代表原因相同，处理时看 code、message、details 和 diagnostics。
错误诊断不输出完整正文或整批凭据。

## 命令总览

读取：topics、search、read、validate。
写入：edit、branch、next、connect、insert、batch、rearrange、important、create-topic、create-root。
工作区与服务：init、serve、whoami。
底层与恢复：check、apply、status。
自查：help、version。

各命令的必填参数和互斥关系以 aichat <command> --help 和 aichat help <command> --json 为准；下面是完整用法说明。


## 命令分组

### 工作区、服务与诊断

    aichat init <path> [--name <名称>] [--json|--text]
    aichat serve --workspace <path> [--port <端口>] [--json|--text]
    aichat topics --workspace <path> [--json|--text]
    aichat validate --workspace <path> [--json|--text]
    aichat whoami --workspace <path> [--json|--text]

init 的位置参数是目录，--name 只写工作区显示名；已存在目录不会被覆盖。
serve 必须显式 --workspace；--port 取值范围 1-65535。
topics 和 validate 默认只读磁盘，不要求服务；whoami 需要服务描述文件并核对服务身份。
服务身份或工作区被替换时拒绝继续，不回退到默认端口上的其他工作区。

### 搜索

    aichat search <query> --workspace <path> [--topic <topicId>] [--limit <1-100>] [--page <n>]

搜索标题、概述和正文。默认 10 项，最多 100；--topic 限定稳定主题。搜索不是读取正文的替代：确认 nodeId 后按需 read。

### 渐进读取

read 默认按主题给 overview；有 --node 时默认 content；有 --from 时默认 structure。三种粒度可以直接选择，不要求逐层经过。

    aichat read <topicId|relative-path> --workspace <path>
    aichat read --topic <topicId|relative-path> [--view overview|structure] [--from <nodeId>] [--budget <n>]
    aichat read <topicId|relative-path> --view overview [--budget <n>]
    aichat read <topicId|relative-path> --view structure [--from <nodeId>] [--budget <n>]
    aichat read --node <nodeId> [--node <nodeId> ...] [--budget <n>]
    aichat read --node <nodeId> ... [--start <n>] [--length <n>|--full]
    aichat read --node <nodeId> ... --from-heading <标题> [--occurrence <n>]
    aichat read --node <nodeId> ... --meta
    aichat read --cursor <token> [--budget <n>] [--offline]

范围：
- 主题 overview 返回主线与直接分支入口；分支内部默认未展开，带 read 入口。
- structure 返回所选范围的节点身份、编号、标题、概述、状态和真实连接，不含正文、路径或写凭据。
- content 由可重复的 --node 指定，保持主题隔离；也可以直接用已知 nodeId，不要求先看 overview。
- 主题也可用 --topic 指定，与位置参数二选一；--topic 不能与 --node 或 --cursor 同用。
- --from 在 overview/structure 中按可达子树读取；起点在主线中段时包含后续 next 和分支，不只读该节点旁支。
- 边界连接只说明范围如何接入，不会自动扩大修改范围。

预算：
--budget 默认 12000，范围 1-1000000，单位是 UTF-16，不是字节或模型 token。
预算覆盖最终紧凑 JSON、envelope、items、refs、page.next、budget 和结尾换行；budget.used 等于实际写入 stdout 的字符串长度，可直接核对。
content 默认每卡最多 4000 UTF-16；多卡共享整次预算，可能需要多页。--meta 也受分页约束。

分页和 cursor：
page.hasMore 表示当前视图还有下一页；page.next 是 opaque token。
续读只传 cursor、工作区、所需预算和输出选项，不重发主题、view、node、from 或正文切片参数。
在线 token 不能直接用于离线续读；服务不可用时从磁盘重新开始相应范围。
STALE_READ 表示相关范围变化；丢弃旧 token，从头重读。
truncated 只表示当前正文片段后面还有正文；末段为 false。它不同于 page.hasMore，也不同于 overview 的 scope.note。

精确片段：
--start 从 0 起；--length 为 1-16000；--full 从起点读到末尾，与 --length 互斥，仍受整次预算限制。
--from-heading 从指定标题开始读取，不是只取这一节；默认仍最多 4000 UTF-16。
--occurrence 选择同名标题中的第几个，0 起，只能与 --from-heading 一起使用；它不是全文标题序号。
--meta 只返回元数据与凭据，不返回正文，不能和 start、length、full、from-heading、occurrence 同用。

凭据：
在线 content 只为当前页实际返回的节点签发凭据，位置是响应顶层 refs[nodeId]。
overview、structure 不签发凭据；离线读取 refs 为空，不能写入。凭据绑定读取时的真实版本，不能刷新后覆盖未阅读的新内容。
--meta 适合只取凭据；不要为了凭据先读全文。

离线边界：
read 优先连接同工作区服务；只有服务不可用（退出码 7）才回退磁盘。--offline 明确只读磁盘。
其他业务错误（范围、预算、版本、参数）直接报错，不混用在线与离线结果。
程序预算不能保证任意宿主永远不截断大输出；长任务应主动缩小范围或分页。

### 写入前置：凭据与版本

所有在线写入使用真实读取得到的 opaque 凭据。读取响应的顶层 refs 是统一位置：

    {
      "refs": { "n_...": "opaque-token" }
    }

命令参数 --ref、--from-ref 只接收 token 字符串，不接收整份凭据对象、显示编号或自行拼接的 nodeId。
写入成功后默认结果顶层 refs 给出仍可读取的受影响节点凭据；刷新待完成时为空。
offline refs 为空；服务重启、凭据淘汰或源文件变化后旧凭据失效，需要重新读取。
同一节点的读取哈希不能被偷偷换成最新值；版本冲突时先重读并重新判断。

### 编辑已有节点

    aichat edit --ref <token> [--title <标题>] [--state agreed|proposed|reference]
                [--summary <概述>] [--body <正文>|--body-file <文件>|--body-stdin]
                [--append-file <文件> | --replace-file <json>] [--verbose]

至少给一项修改。正文模式互斥：整篇替换、追加、局部替换只能选一种。
--append-file 追加一段正文；段落分隔由程序规范化，不需要手工拼两个换行。
--replace-file 接受 [{"old":"...","new":"..."}] 或 {"replace":[...]}；每个 old 必须非空且恰好匹配一次，不做全局替换。
title、state、summary 可与一种正文模式同次更新。--summary 传空字符串不是删除；要删除显式概述使用底层 patchNode 的 summary:null 或重新判断。

### 创建节点与主题

    aichat branch --from-ref <token> --title <标题> --description <说明>
                  (--body <正文>|--body-file <文件>|--body-stdin)
                  [--summary <概述>] [--state <状态>] [--side left|right] [--order <n>]
    aichat next --from-ref <token> --title <标题> --description <说明>
                (--body <正文>|--body-file <文件>|--body-stdin)
                [--summary <概述>] [--state <状态>] [--topic-id <topicId>]
    aichat create-topic --topic-title <标题> [--directory <单层目录>] [--title <首卡标题>]
                        [--summary <概述>] [--state <状态>]
                        (--body <正文>|--body-file <文件>|--body-stdin)
    aichat create-root --topic-title <标题> --title <首卡标题>
                       [--summary <概述>] [--state <状态>]
                       (--body <正文>|--body-file <文件>|--body-stdin)

branch 创建独立方向；next 创建纵向后继，来源已有 next 时返回 409，不自动插队或顶掉主线。
新节点默认 proposed；--state 显式设置。side 只是源数据元数据，当前前端统一向右呈现，不用它微调位置。
order 只对 branch 有意义；未给时由程序稳定分配。创建时可以直接给 --summary，不需要创建后再 edit 一次。
create-root 只用于空工作区（没有任何节点）；已有内容时新增节点用 next／branch／insert／batch，新主题用 create-topic，目录碰撞明确拒绝。
新节点插入已有 next 之前不要用 branch 再 next 的两次提交；使用 insert 或 batch。

### 重连与重排

    aichat connect --ref <token> --description <说明>
                   [--from-ref <token>] [--flow next|branch] [--side left|right] [--order <n>]
    aichat rearrange (--input <spec.json>|--input-stdin) --workspace <path>

connect 修改一条现有连接；仅改描述也可用。真正改变来源或 flow 时，说明必须解释最终关系。
一个来源最多一个 next。目标位置已被未声明的后继占用时返回 409，工具不会隐式挤掉原后继。
rearrange 一次表达多条最终入边，服务端在内存里先腾空再落位，中间状态不写盘；成功后 refs 是顶层映射。
rearrange 输入：

    {
      "edits": [
        {
          "ref": "<C token>", "fromRef": "<A token>",
          "flow": "next", "description": "先比较适用范围"
        },
        {
          "ref": "<B token>", "fromRef": "<C token>",
          "flow": "next", "description": "比较后回到原结论"
        }
      ]
    }

每个 ref 是被改接节点，fromRef 是最终来源。flow 只取 next 或 branch；branch 可带 side/order，next 不得带。
把占位后继及其他需要换来源的节点一起纳入 edits，并各自给出最终位置。过期哈希 412、占位冲突 409、成环/重复 next 422。

### batch：一次提交完整修改

    aichat batch (--input <file.json>|--input-stdin) --workspace <path> [--dry-run] [--verbose]

batch 是一次高层事务，不是顺序调用多个写命令。一个 batch 只处理一个已存在主题；
主题创建仍用 create-topic，不把初始化或跨主题操作加入批次。
输入：

    {
      "topicId": "t_...",
      "ops": [
        {
          "op": "edit",
          "target": { "ref": "<旧节点 token>" },
          "patch": {
            "append": "对旧问题的新补充",
            "summary": "更新后的概述"
          }
        },
        {
          "op": "create",
          "as": "new-question",
          "from": { "ref": "<当前链尾 token>" },
          "flow": "next",
          "description": "由前面的判断进入新的问题",
          "title": "新的讨论问题",
          "body": "包含必要背景和问题的完整正文",
          "summary": "新问题的概述",
          "state": "proposed"
        }
      ]
    }

节点选择器二选一：ref 是真实在线凭据；local 用 create 的 as 名称。
local 只在本次输入有效，不是稳定 nodeId，不写入源文件；必须唯一，可用于本批新节点之间的连接，支持前向引用。
局部引用不存在、成环、同名重复整体拒绝。不引入全局短编号、长期别名缓存或隐式对话状态。

ops：
- edit：target 必须是已有 ref；patch 可改 title、state、summary、正文。正文三模式 body/append/replace 互斥；同一节点最多一份 edit。
- create：声明最终 from、flow、description，可一次给 title、body、summary、
  state、important；branch 可给 order，未给由程序稳定分配；next 不得带 side/order。
  新节点属性尽量在 create 一次给齐。
- connect：target 只能是已有节点；from 可用已有 ref 或本批 local；flow 只取 next/branch。
  同一节点最多一份最终连接声明。只改 description 时 from 和 flow 可省略；
  给 from 时必须同时给 flow；final flow=next 不得带 side/order。
- important：target 已有 ref，只改 important；可与同批 edit/connect 共存，分别修改不同职责字段。

同一已有节点最多一份 edit、一份 connect、一份 important，可以同时出现；它们基于同一份批前版本合成。重复或矛盾的同类修改明确拒绝，不靠 ops 顺序偷偷决定结果。

长正文输入：
CLI 输入层除 JSON 字符串 body 外，还接受 bodyFile、appendFile、replaceFile，与现有文件输入等价。
- edit.patch 可用 bodyFile 替代 body，appendFile 替代 append，replaceFile 替代 replace；每个正文模式最多一个来源。
- create 可用 bodyFile 替代 body。
- 文件字段和对应 JSON 字段不能同时写；同一内容无论走内联、文件还是 stdin，正文结果一致。
- --input 文件中的相对路径以该输入文件所在目录为基准；--input-stdin 中的相对路径以调用 cwd 为基准。
- CLI 读取这些显式文件并转换成正文后再发送；HTTP 服务不根据请求中的本机路径读取正文文件。

原子性与顺序：
所有已有凭据按批前状态解释；本批先编辑节点再把它作为来源，不需要重新读取。
程序在内存里生成最终候选图，一次提交；不逐条调用现有写命令，不发布中间结构，不创建临时旁支或过渡说明。
现有 next 被占时，只有显式声明原后继最终位置才允许改接；不自动丢弃、不自动猜测说明。
无效引用、过期版本、占位冲突、成环等提交前整体拒绝。提交失败走现有事务与恢复规则，不声称已经发生的 I/O 必然什么都没写。
无变化为 noop；仅 important 变化不替换最近内容修改集合；混合批次的 lastChanges 包含该主题最终真实改写的内容节点。

dry-run：
--dry-run 复用候选检查但不落盘、不更新最近修改、不返回可冒充已创建节点的写凭据。
输出 state 为 checked，明确不是 committed；files 说明预计变化。
dry-run 成功不代表后续提交免于重新检查版本。

错误恢复：
错误 details 会指出 ops 索引/字段、nodeId 或 local、冲突类别，并提示重读、修正输入、提高预算或查询原 requestId。
过期凭据 412、占位/语义冲突 409、格式/结构 422；退出码沿用总表。
同一 requestId 和相同请求体重放不会重复创建节点，应返回相同 created/aliases/refs；不要换 requestId 盲重发。
结果未知时先 aichat status <原 requestId>，再核对源内容；不要无界重试。

### insert：一次插入链中

    aichat insert \
      --after-ref <A token> \
      --before-ref <B token> \
      --title <新节点标题> \
      --description <A 到新节点的说明> \
      --next-description <新节点到 B 的说明> \
      (--body <正文>|--body-file <文件>|--body-stdin) \
      [--summary <概述>] [--state <状态>] --workspace <path>

语义固定：原来 A → B → C，结果 A → N → B → C。
A 与 B 当前必须是同主题内真实相邻的 next；两份凭据都按读取时版本检查。
两条新关系说明由调用方明确提供，不继承不再准确的旧说明。
不相邻、过期或结构不合法时整体拒绝，不降级为 append 或 branch；不会先创建旁支再重排。
insert 复用 batch 核心，是一次提交；它没有 batch 的 local 输入，created.aliases 为空，插入节点身份看 created.nodeIds 与顶层 refs。
也可用 batch 的 create + connect 表达同一操作：即使 create 写在 connect 前，程序仍按最终图处理，不会因过程里 A 的 next 暂时被占而拒绝。

### 重要标记

    aichat important (--ref <token>|--node <nodeId>) (--on|--off) --workspace <path>

--ref 使用已有读取版本；--node 先在线读取 meta 取得凭据，离线不伪造。
节点 important 只表示值得回看，不改变正文、编号或连接；取消时移除源字段。
最近更新来自图接口 lastChanges[topicId]，普通 read 不返回。仅 important 不替换最近内容修改集合。

### 底层检查与恢复

    aichat check --input <ChangeRequest.json> --workspace <path>
    aichat apply --input <ChangeRequest.json> --workspace <path>
    aichat status <requestId|--input <原变更.json>> --workspace <path>

check 只验证完整底层变更集合，不写盘；apply 提交并检查真实旧哈希。底层 JSON 不是 batch 或 rearrange 的简化格式。
status 查询原 requestId；unknown 既不证明成功也不证明失败。结果未知时先查原 requestId，再核对源内容，不换 ID 盲重发。
服务重启或请求记录被清理后，旧 requestId 可能查不到；这不等于一定没写入。

## 完整示例

以下示例都使用实际工作区路径变量。运行前先读取并确认稳定主题 ID。

    .\aichat.cmd topics --workspace "D:\my-graph-vault"

    .\aichat.cmd read "t_..." --workspace "D:\my-graph-vault"
    .\aichat.cmd read --node "n_..." --workspace "D:\my-graph-vault"

读取顶层 refs 后，用节点对应的 token 写入：

    .\aichat.cmd edit --ref "<token>" --append-file ".\补充.md" --workspace "D:\my-graph-vault"
    .\aichat.cmd next --from-ref "<token>" --title "新的问题" --description "沿着上一个判断继续" --body-file ".\正文.md" --summary "新问题概述" --workspace "D:\my-graph-vault"

补充旧问题并记录新问题，一次提交：

    .\aichat.cmd batch --input ".\r3-batch.json" --workspace "D:\my-graph-vault"
    .\aichat.cmd batch --input ".\r3-batch.json" --dry-run --workspace "D:\my-graph-vault"

插入：

    .\aichat.cmd insert --after-ref "<A token>" --before-ref "<B token>" --title "判断条件" --description "先引入判断条件" --next-description "满足条件后继续原问题" --body-file ".\判断.md" --workspace "D:\my-graph-vault"

写成功后从顶层 refs 取新 token：

    {
      "refs": {
        "n_...": "opaque-token"
      },
      "created": {
        "nodeIds": ["n_..."],
        "aliases": {"new-question": "n_..."}
      }
    }

## 明确不支持

- 不自动合并或删除节点，不整主题替换；整理重复节点仍需基于正文判断和现有结构操作。
- 不提供通用脚本语言、表达式引擎、工作流引擎或持久化 Agent 会话。
- 不维护全局当前主题；前端浏览选择和其他对话焦点不改变本对话写入目标。
- 不自动重排布局或修改前端视觉。
- batch 不能创建主题或跨主题；insert 不能降级为 branch。
- 不对旧接口提供别名、双轨输出或永久兼容层。接口版本不匹配时更新程序和服务，而不是猜路径。

程序手册到此。Skill 的实际记录流程、工作区核对和宿主安装边界见 Skill 包自带的 SKILL.md 与 references；两份 CLI 文档各自独立维护，发布时用真实命令核对。
