# Skill 命令参考

适用接口版本：2。程序版本和构建标识用当前入口的 version/whoami 核对。
本文件是 aichat-graph Skill 随附的完整 CLI 参考，面向讨论图维护场景；与程序仓库的程序手册是两份独立文档。
开始前先按 SKILL.md 确认工作区、主题和本机入口；本文件不替代协作内容判断。

## 入口与调用

使用与服务同版本的 CLI。常见形式：

    node <实际程序目录>/dist/cli/index.js <command> [options]
    <实际程序目录>/aichat.cmd <command> [options]

固定版本目录通常为 .local/daily，安装副本的 local.env.json 会指向同一入口。
始终显式传 --workspace，不依赖上一聊天的隐藏路径或 shell 当前目录。
默认输出 JSON；--text 只是简短摘要。帮助和版本不需要工作区或服务：

    aichat --help
    aichat <command> --help
    aichat help batch --json
    aichat version --json

接口版本是 2；`version` 报告程序、接口与构建标识，`whoami` 同时核对
CLI、服务、描述文件与磁盘身份。接口缺失或不匹配时普通读写退出 7 并明确提示，
不猜路径；whoami 例外仍可诊断，read 可回退磁盘并在 online.reason 说明。
不要用新 CLI 写旧服务，也不要把只同步 Skill 当成更新程序。

初次接入先核对主题，不要凭标题猜 topicId：

    aichat topics --workspace <ws>
    aichat read <topicId> --workspace <ws>

topics 返回稳定 topicId、标题、入口路径和节点数。绑定本对话后持续沿用；重名或目标不明才向用户澄清。
前端浏览选择、全局 activeNode 和其他对话焦点都不替代本对话的记录目标。

## 结果与凭据

读取响应的顶层 refs 是唯一凭据入口：

    {
      "refs": {
        "n_0123456789abcdef0123456789abcdef": "opaque-token"
      }
    }

命令参数 --ref、--from-ref 只接收这个 token 字符串，不接收整份对象、显示编号或自行拼接的 nodeId。
overview、structure 和离线读取的 refs 是空对象；在线 content 只为当前页实际返回的节点签发。
凭据绑定读取时的真实版本；服务重启、源文件变化或凭据淘汰后失效，需要重新读取。

写入默认结果是顶层对象，不套 result：

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
        "aliases": {"new-question": "n_..."}
      },
      "refs": {"n_...": "opaque-token"}
    }

写成功后从顶层 refs 继续修改；created.aliases 只把本批 local 名称映射到稳定 nodeId，不是凭据。
不要从 result.editRef、result.editRefs 或 items[i].editRef 取凭据，这些位置已不再使用。
--verbose 才输出路径、哈希、事务和完整服务身份；默认只看精简结果。底层 check／apply 仍保留各自的 result 外壳，不属于这套高层写结果。

写入还要看 state：

- committed：已提交。
- noop：没有实际变化，不必重复提交。
- committed_refresh_pending：源文件已提交，快照刷新待完成；按诊断核对，不能当作没写入而重复创建；此时 refs 可能为空。
- checked：仅 batch --dry-run 的检查状态，未落盘、未更新最近修改。

## 读取：先定位，已知节点可直读

    aichat read <topicId> [--budget <n>] [--workspace <ws>]
    aichat read --topic <topicId|相对入口> [--view overview|structure] [--budget <n>] [--workspace <ws>]
    aichat read <topicId> --view structure [--from <nodeId>] [--budget <n>] [--workspace <ws>]
    aichat read --node <nodeId> [--node <id> ...] [--budget <n>] [--workspace <ws>]
    aichat read --node <nodeId> --meta [--workspace <ws>]

三种粒度可直接选择，不强制逐层：
- overview：主题身份、主线和直接分支入口；分支内部未展开，带继续读取入口。
- structure：节点身份、编号、标题、概述、状态和真实连接；不含正文、路径或写凭据。
- content：按 node 读正文或元数据，可跨分支直接读已知节点。

content 输出 item 的 node、body、range、truncated、path、fileHash 是有用事实；凭据只在顶层 refs。
truncated 只表示当前正文片段后面还有正文；page.hasMore 表示当前视图还有下一页，两者不同。
overview 的 scope.note 说明未展开分支，不代表正文缺失。

预算：
--budget 默认 12000，范围 1-1000000，单位 UTF-16，不是字节或模型 token。
预算覆盖最终紧凑 JSON、refs、page.next、budget 和结尾换行；budget.used 等于实际 stdout 长度。
content 默认每卡最多 4000 UTF-16，多卡共享整次预算，可能需要多页。--meta 也受分页约束。
page.next 原样交给 --cursor，只再带工作区、预算和输出选项；不要重发主题、view、node、from 或切片参数。
在线 cursor 不能离线续读；服务不可用时可从磁盘重新开始相应范围。
STALE_READ：相关范围已变，丢弃旧 cursor，从原范围重新读；无关主题或不影响本范围的变化不应使 token 失效。

精确片段：

    aichat read --node <nodeId> --start 0 --length 4000 --workspace <ws>
    aichat read --node <nodeId> --from-heading "适用范围" --occurrence 0 --workspace <ws>
    aichat read --node <nodeId> --full --budget 30000 --workspace <ws>

--from-heading 从该标题开始读取，不是只取这一节；默认仍最多 4000 UTF-16。
--occurrence 选择同名标题中的第几个，0 起，只可与 --from-heading 同用。
--meta 只取元数据和凭据，不返回正文，不能与 start、length、full、from-heading、occurrence 同用。
显式切片超预算报 BUDGET_EXCEEDED，不静默截断；BUDGET_TOO_SMALL 按 details.minimum 调大预算。

离线读取：

    aichat read <topicId> --offline --workspace <ws>
    aichat read --node <nodeId> --offline --workspace <ws>

离线 refs 为空，不能写；服务不可达时读可回退磁盘，但写入不回退。不要把离线结果当成已同步到服务。

## 写入：一条连接、一次补充或一批完整修改

所有写命令需要同工作区运行服务，且只使用真实在线凭据。

### 修改已有问题

    aichat edit --ref <token> --title <标题> --state agreed|proposed|reference --summary <概述> --workspace <ws>
    aichat edit --ref <token> --append-file <补充.md> --workspace <ws>
    aichat edit --ref <token> --replace-file <替换.json> --workspace <ws>
    aichat edit --ref <token> --body-file <完整正文.md> --workspace <ws>

正文整篇替换、追加、局部替换一次只能一种。追加段落由程序规范化，不需要自己拼空行。
replaceFile 接受数组或 {"replace":[...]}，每个 old 非空且唯一匹配；不做含糊的全局替换。
title、state、summary 可以和一种正文模式一起更新。
同一问题的补充优先原位 edit，不必新建节点。

### 创建继续或方向

    aichat next --from-ref <token> --title <标题> --description <为什么继续> \
      --body-file <正文.md> [--summary <概述>] [--state <状态>] --workspace <ws>

    aichat branch --from-ref <token> --title <标题> --description <为什么分支> \
      --body-file <正文.md> [--summary <概述>] [--state <状态>] [--order <n>] --workspace <ws>

next 纵向继续；来源已有 next 时返回 409，不自动插队。需要插入已有 next 之前时用 insert 或 batch，不要先 branch 再 next 两次提交。
branch 展开独立方向；side 只是源数据元数据，当前前端统一向右，不能用它调整外观。
state 默认 proposed；--summary 让概述一次给齐，不必创建后单独 edit。
description 解释为什么从来源接到新节点，不能继承一条不再准确的旧说明。

### 创建主题

    aichat create-topic --topic-title <主题标题> [--directory <单层目录>] \
      --title <首卡标题> --body-file <正文.md> [--summary <概述>] --workspace <ws>

create-topic 原子创建主题和独立根；目录已存在时明确拒绝，不覆盖、不另建副本。
已有讨论继续使用原主题，不要为每次对话新建主题。create-root 只用于空工作区。

### 插入已有链

    aichat insert --after-ref <A token> --before-ref <B token> \
      --title <新节点标题> --description <A 到新节点的说明> \
      --next-description <新节点到 B 的说明> \
      --body-file <正文.md> [--summary <概述>] --workspace <ws>

原来 A → B → C，结果 A → N → B → C。
A 与 B 必须当前真实相邻 next；不是相邻、凭据过期或结构不合法时整体拒绝，不降级为 append 或 branch。
两条新关系说明都要明确给出；不继承旧说明。insert 是一次事务，不会先落临时旁支。

### 重要标记

    aichat important --node <nodeId> --on --workspace <ws>
    aichat important --ref <token> --off --workspace <ws>

important 只表示值得回看，不改变正文、编号或连接；取消时移除源字段。
它不属于最近内容修改；仅改 important 不替换 lastChanges。


### batch：补充旧问题同时记录新问题

一次讨论维护常同时发生两件事：旧问题需要补充，新问题需要继续。batch 把整批最终修改
放在一次事务里，避免两次提交导致最近更新只保留后一批。

    aichat batch (--input <batch.json>|--input-stdin) --workspace <ws>
    aichat batch --input <batch.json> --dry-run --workspace <ws>

一个 batch 只处理一个已存在主题。主题创建仍用 create-topic；batch 不能初始化或跨主题。

输入形状：

    {
      "topicId": "t_...",
      "ops": [
        {
          "op": "edit",
          "target": { "ref": "<旧问题 token>" },
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

选择器：
- {"ref":"..."} 是真实在线凭据，按批前状态解释；本批先 edit 再把它作为来源，不需要重读。
- {"local":"as"} 只能指向本批 create 声明的节点；名称只在本次输入有效，不是稳定 nodeId，必须唯一。
- local 支持前向引用；程序解析依赖，不存在的引用和成环明确拒绝。不要建立长期别名或全局短编号。

ops：
- edit：target 已有 ref；patch 可改 title、state、summary 或正文。body、append、replace 互斥；同一节点最多一份 edit。
- create：一次声明最终 from、flow、description，可给 title、body、summary、
  state、important；branch 可给 order，未给由程序稳定分配；next 不得带 side/order。
- connect：target 只能已有节点；from 可已有 ref 或本批 local；flow 取 next/branch。
  同一节点最多一份最终连接声明。只改说明可省 from/flow；给 from 时必须给 flow；
  next 不带 side/order。
- important：target 已有 ref，可与 edit/connect 共存，修改不同字段；基于同一批前版本。
同一已有节点最多一份 edit、一份 connect、一份 important；重复或矛盾同类修改明确拒绝，不靠 ops 顺序决定结果。

文件输入：
patch 可用 bodyFile、appendFile、replaceFile 替代对应 JSON 字段；create 可用 bodyFile。
文件字段和 JSON 字段不能同时出现，一个正文模式最多一个来源。
--input 文件的相对路径以输入文件所在目录为基准；--input-stdin 以调用 cwd 为基准。
CLI 读取文件后才发给服务；服务不读任意本机路径。
追加段落由程序规范化；不要手工拼两个换行。同一内容走内联、文件或 stdin 结果一致。

原子性：
所有旧凭据按批前状态解释，本批中间结构不写盘，不要求创建临时旁支或过渡说明。
现有 next 被占时，只有显式声明原后继最终位置才允许改接；不自动丢弃、不自动猜说明。
程序在内存里构造最终候选图一次提交；过期版本、占位冲突、成环等提交前整体拒绝。
无变化为 noop；仅 important 变化不替换最近内容修改；混合批次的 lastChanges 包含最终真实改写内容节点。
同一 requestId 相同请求体重放不重复创建，返回相同 created.aliases/refs；不要换 ID 盲重发。

dry-run：
--dry-run 只检查候选，不落盘、不更新最近修改、不签发可冒充已创建节点的凭据。
输出 state=checked 和预计 files，不是 committed。dry-run 成功也不代表后续提交免于重新检查版本。

### rearrange：只表达最终入边

    aichat rearrange --input <rearrange.json> --workspace <ws>
    Get-Content -Raw -Encoding utf8 <rearrange.json> | aichat rearrange --input-stdin --workspace <ws>

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

rearrange 只改已有节点的最终入边，不同时创建或编辑正文。
每个 ref 是被改接节点，fromRef 是最终来源，flow 只取 next/branch；branch 可带 side/order，next 不得带。
目标位置被占时，把占位后继及其他需要换来源的节点一起纳入 edits，并各自给最终位置；不隐式挤掉未声明节点。
服务在同一候选和事务里腾空、落位，不写临时旁支。成功后从顶层 refs 取受影响节点 token。
过期哈希 412、占位冲突 409、成环/重复 next 422。

### 结果未知和冲突

版本冲突（412）：先重读相关节点，重新判断内容和关系，再修改；不要补新哈希或覆盖别人改动。
语义冲突（409）：占位 next、主题隔离、凭据过期或结果状态冲突；按 details 调整结构或重读，不换路径碰运气。
结构校验失败（422）：修正最终图，不关闭校验。
结果未知（退出码 8）：先用原 requestId 查询 status，再核对源内容；status 的 unknown 既不证明成功也不证明失败。
不要自动换 requestId 重发，也不要无界重试。服务重启后请求记录可能消失，这不等于一定未写入。

### 读取/写入选择

- 只改一个已有问题：edit。
- 在末尾继续：next。
- 独立方向：branch。
- 补充旧问题同时记录新问题：batch。
- 在 A 与 B 之间插入：insert。
- 多条已有连接整理：rearrange。
- 只标重要：important。
- 新建主题：create-topic；不要为同主题续谈新建。
- 修改前先读相关正文和相邻关系；只取凭据/元数据可用 --meta，不要只凭摘要覆盖解释。

## 不支持与边界

- 不自动合并重复节点、不自动删除、不整主题替换；结构操作仍要基于正文和真实关系判断。
- 不提供通用脚本语言、表达式引擎、工作流引擎或持久化会话。
- 不维护全局当前主题；前端浏览和其他对话焦点不改变本对话绑定。
- 不通过 CLI 修改前端布局或导出形式。
- batch 不创建主题、不跨主题；insert 不降级为 branch。
- 旧接口没有别名或双轨输出；接口版本不匹配时更新程序与服务，不猜路径。
- 离线可读不可写；服务不可达时清楚说明未保存部分。

## 全部命令索引

只读磁盘（不要求服务）：
- init <path> [--name]：新建不存在的工作区，不覆盖已有目录。
- topics --workspace：列出稳定 topicId、标题、目录和节点数；首次绑定先核对。
- search <词> --topic <topicId> --workspace：按标题、概述、正文搜索；不是读取正文的替代。
- read ...：overview／structure／content、预算、cursor、--from-heading/--occurrence、离线；见上文。
- validate --workspace：检查磁盘结构、工作区元数据与整图；日常保存后不必固定运行。
- version／help：本地自查，不要求工作区或服务。

需要同工作区服务：
- serve --workspace [--port]：启动本机服务；同一工作区不要开两个写进程。
- whoami --workspace：报告 CLI、服务、描述文件、磁盘身份、接口版本与构建是否一致；不匹配时仍可诊断。
- edit：原位修改已有节点；--ref 来自顶层 refs。
- branch／next／create-topic／create-root：创建节点或主题；正文来源三选一，支持 --summary。create-root 只用于空工作区；已有内容新增节点用 next／branch／insert／batch。
- connect：改已有节点最终来源/flow/说明；flow 只取 next|branch，root 不可改接。
- insert：A→N→B→C 当前相邻链插入，一次事务。
- batch：一个已存在主题内 edit/create/connect/important 原子批次；支持 --dry-run。
- rearrange：一次表达多条已有节点的最终入边。
- important：--ref 或 --node 设置/取消重要；只改 important 不替换最近内容。
- check --input <ChangeRequest.json>：底层候选检查，不写盘，结果保留 result 外壳。
- apply --input <ChangeRequest.json>：底层显式提交，须带真实旧哈希，结果保留 result 外壳。
- status <requestId|--input>：查询原请求；unknown 不代表未写入。

错误分类：过期凭据 412、占位/语义冲突 409、格式/结构 422；结果未知退出码 8。所有命令的完整参数和最小示例以当前入口的 <command> --help、help <command> --json 为准；本索引不替代具体参数说明。

## 快速路径

1. topics 核对 topicId；read overview/structure 定位相关节点。
2. read --node 或 read --node --meta 取正文与顶层 refs。
3. 同一问题补充用 edit；新问题 next/branch；混合修改用 batch；链中插入用 insert。
4. 成功后看 state 和顶层 refs；需要继续改时用新 token。
5. 冲突先重读；结果未知先 status；不重复创建。

命令参数和帮助以当前入口为准：

    aichat help <command> --json
    aichat <command> --help

本文件与程序手册各自完整；此处侧重讨论图维护时的操作顺序和判断边界。
