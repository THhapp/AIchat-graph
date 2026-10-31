# AIchat-graph 程序 CLI 手册

适用接口：6。程序可独立使用，不要求安装 Skill。
Windows 便携包中 aichat 表示包根 aichat.cmd；源码开发时可用 aichat.cmd 或
node <程序目录>/dist/next/cli.js。普通用户用包内 AIchat-graph.exe 打开，不必执行 CLI。

示例中的 <...>、n_a、t_... 等为占位符，使用命令返回的真实 ID 和版本替换。
用法展示中的方括号表示可选项，不要原样传入 shell。

## 入口、工作区与输出

目录选择顺序为 `--workspace <dir>`、AICHAT_WORKSPACE、程序根 .aichat/default.json。
`--workspace-id <id>` 只检查所选库身份，不负责查找目录。
仓库和日用快照各有程序根；config 应通过实际使用的入口执行。

~~~text
aichat config --workspace D:/my-discussions
aichat config --show
aichat version
aichat whoami --workspace D:/my-discussions
~~~

默认输出紧凑 JSON，--json 可显式指定，--text 输出简短摘要。
写入可加 --verbose 查看附加传输信息，--no-start-service 禁止自动启动缺失的服务。
普通成功结果写 stdout，失败结果写 stderr。
默认库配置位于当前程序根 .aichat/default.json；便携包、源码和开发快照各自独立。
目标不明确时显式给 --workspace；原生启动器选过的库会写入同一程序根的默认配置。

## 打开、停止、初始化与导入

~~~text
aichat open
aichat open --workspace <dir> [--no-browser]
aichat open --choose-workspace --interactive [--no-browser]
aichat stop
aichat stop --workspace <dir>
aichat init <dir> --name "思路库"
aichat import --workspace <旧V2目录> [--name "新名称"]
aichat serve --workspace <dir> [--port <端口>] [--no-browser]
~~~

open 复用当前库的存活服务；没有服务时在后台启动并等待就绪，成功后保存为默认库并打开
默认浏览器。--workspace 显式选库；--choose-workspace --interactive 弹原生目录选择器。
只有选择器选中的空目录才会 init（库名取目录名）；取消返回 state:cancelled，不改默认库。
程序目录及其内部不能作为讨论库；非空且没有 graph.sqlite 的目录不是可直接打开的库。

stop 只请求当前库的服务自行退出，不自启动、不按 PID 杀进程；descriptor 缺失或连接拒绝
返回 not-running 成功状态，旧服务没有停止端点时给出明确错误。结果中的 workspace revision
不是节点版本；写后继续改节点使用 nodeRevisions。

init 建立 graph.sqlite，拒绝覆盖已有数据库；建议选新的或空目录。
import 只读取旧工作区 Markdown 资料（旧 workspace.json 里的 schemaVersion 2、topicMode isolated）
与原目录节点 .md 文件；这是旧工作区格式，不是 graph.sqlite 的 schemaVersion 3。
导入在原目录新建数据库，不改写原文件。已有 graph.sqlite 时拒绝；失败不留下半导入的可见库。
原相对节点链接和资源引用会转换为稳定 ID 链接与 resources/ 键。

serve 默认优先本库 .aichat/local/runtime.json 记录的端口，其次 127.0.0.1:4317，
被占用时才用系统空闲端口；显式 --port 精确使用（0 = 系统分配）。
在浏览器打开服务实际 URL，Ctrl+C 停止；运行地址也可从 whoami 或服务描述取得。
写命令需要本机服务；缺少描述文件时，CLI 可后台启动同版服务并等待就绪。
已有描述却连接失败或版本不匹配时，按具体错误处理，不假定一定会自动修复。

工作区保存 graph.sqlite、resources/ 及 .aichat/ 本机状态。
正常运行不扫描、监听或写回旧节点 Markdown。

当前数据库格式为 schemaVersion 3，新库和 import 的结果均为 3。
旧版数据库只读打开不升级；可写打开时升级并保留讨论内容与版本。
升级不制造内容变化，也不补造旧差异。数据位置与升级规则见[工作区指南](workspace.md)。

## 读取与检索

~~~text
aichat topics
aichat validate
aichat search <词> [--topic <topicId|key>] [--limit 10] [--page 0]
aichat read <topicId|key>
aichat read <topicId|key> --view structure [--from <nodeId>]
aichat read --node <id> [--node <id> ...]
aichat resume <topicId|key> --node <anchorId>
~~~

读取直接只读打开数据库，不要求服务，source 为 database。
主题默认 overview；给 --node 可直接读 content，不必先经过其他视图。
节点元数据不再重复 topicId（响应顶层已有 topicId）。items 只有在实际返回正文时才带 body、range、truncated；
overview／structure 及 --meta 的项为 omitted:true，没有这些字段。
本次范围写在 scope：overview／resume 为 topic；structure 无 --from 为 topic、有 --from 为 subtree；content 为 nodes（保留请求顺序）。

| 视图 | 返回内容 |
| --- | --- |
| overview | 主线和直接 branch 入口，只含节点元数据与连接，不含正文 |
| structure | 主题或从 --from 开始可达的结构，只含元数据，不含正文 |
| content | 指定节点正文和元数据 |
| resume | anchor 正文，必要祖先、直接邻居及少量重要 / 最近节点的摘要 |

resume 等价于 `read <topicId> --view resume --node <id>`。
响应用顶层 anchorId 指认锚点，anchor 元数据只在 items 中出现一次（role=anchor），没有另外的 anchor 对象。
较长 anchor 正文仍受切片和输出预算约束，需要时续读。

content 可用：

- --meta：只读元数据与节点版本；items 为 omitted:true，不含 body／range。
- `--start <n>`：从 UTF-16 偏移开始，0 起。
- `--length <n>`：片段长度，1–16000，默认 4000。
- --full：请求从起点到正文末尾，仍受整次响应预算约束。
- `--from-heading <标题>`：从匹配标题起读，不表示只读该小节。
- `--occurrence <n>`：同名标题序号，0 起，只与 --from-heading 同用。

--length 与 --full 互斥，UTF-16 偏移不会切开代理对。

### 预算与续读

--budget 默认 12000 UTF-16 单位，覆盖最终序列化响应，不等同于模型 token 数。
range 只随正文返回，给出实际起止与总长；truncated 只表示该段正文后面还有内容；
omitted:true 表示本视图或 --meta 按设计省略正文。是否还有下一页以 page.hasMore 为准。

~~~text
aichat read --cursor "<page.next>" --budget 12000
~~~

续读 cursor（v2）记录原视图、范围、起始位置与切片条件（--length／--full／--meta），续页保持原切片长度与 range，不丢页；
content 的显式节点集合与顺序保留在 cursor 中，topic／subtree 的 cursor 不重复完整节点列表。
把 page.next 原样传回，只另调 --budget（工作区仍正常定位），不重发主题、节点或切片条件。
当前指纹包含主题 revision 和所选节点版本，同主题修改可能使 cursor 过期；
其他主题修改不影响。遇到 STALE_READ 从原范围重新读取。

### 查看变化批次（diff）

~~~text
aichat diff <topicId|key> [--request <id>] [--node <id> [--patch]] [--budget <n>]
aichat diff (--input <batch.json>|--input-stdin) [--node <id> [--patch]] [--budget <n>]
aichat diff --cursor "<page.next>" --budget 12000
~~~

一次实际内容提交形成一批变化，不按聊天轮次累计。每主题只保留最近一批；
important-only、noop、dry-run 和幂等重放不替换，纯删除会替换。
查看已提交批次只读数据库，不需要服务；预览复用 batch 输入与 dry-run，需要同版服务。

常用方式：

~~~text
aichat diff <topicId>
aichat diff <topicId> --request <写入返回的requestId> --node <id> --patch
aichat diff --input batch.json --node <id> --patch
~~~

默认摘要含批次身份、时间、整批 counts，以及每项的 nodeId、title、kind 和 fields，不含正文。
删除项仍在清单里；新增／删除的 fields 为空。字段变化包括 title、summary、from、flow、
description、side、order；正文另外生成 patch，important 不属于内容批次。

--node 限定一张卡，--patch 必须配 --node，预览与已提交批次用法相同。
具体差异含 beforeRevision／afterRevision、fieldDiffs 与正文 unified patch；
新增和删除的正文分别为“空→正文”和“正文→空”。正文没变时没有 body 差异。

预览支持 --input 文件或 --input-stdin，不接受主题位置参数和 --request。
相对正文文件路径按 batch 的规则解析；预览不落库、不写请求记录，零变化返回空清单。
只想检查提交是否可执行、不看差异时，用 batch --dry-run；两者都不是写入的必经步骤。

预算与续读：

- --budget 默认 12000、最大 1000000 UTF-16 单元，覆盖整次 JSON 与末尾换行。
  budget.used 是实际长度；--text 仍按 JSON 计量，不保证文本输出受同样长度限制。
- 摘要按节点分页，每页 counts 都是整批统计，不是本页数量。
  patch 按行分页，每页重复 fieldDiffs 和整篇增删统计；body.patch 只含本页内容。
- page.hasMore 为真时，原样传回 page.next。续读只另带预算、输出或工作区选项，
  不重发主题、--node、--patch、--request、--input。
- 预览 cursor 内含压缩后的批次动作，过大的输入也会占输出预算。
  续页会重新 dry-run；修改目标的版本过期时报 412，需重新读取并判断。

**分页不等于完整差异。** 每卡正文 patch 最多生成 16000 UTF-16 单元，超出时按整行截断。
page.hasMore 只表示还能否续页；末页仍有 body.truncated=true，表示已达到 patch 生成上限，
提高预算或继续翻页也无法补齐。当前正文可另用 read 阅读；diff 不提供任意旧版本的全文读取。

| 错误 | 处理 |
| --- | --- |
| BUDGET_TOO_SMALL | 最小分页单元放不下，采用 details.minimum 或更大的预算 |
| CHANGE_NOT_FOUND | 节点不在该批次中，检查节点与批次 |
| BATCH_SUPERSEDED | 指定或续读批次已被替换；details.latest 提供最新 requestId |
| BATCH_UNAVAILABLE | 指定的批次不可用，不会自动改读另一批 |
| CURSOR_INVALID | 续读标记非法或越界，从原查询重新开始 |
| CHANGE_HISTORY_UNAVAILABLE | 旧数据库未保存差异；升级后从新的内容提交开始记录 |

--request 与最新批次续读都检查批次身份；旧批次被替换后无法继续查看，不保存完整历史。

## 写入与节点版本

已有节点的内容、入边或删除使用实际读到的 {id,revision}。
节点版本跨服务重启持久，不能用工作区 revision 代替，也不在提交前偷取最新值覆盖。
独立 important 设值可仅给节点 ID；提供 --if-revision 时再核对版本。
节点没有确认状态：读取、写入和 HTML 都不含节点状态字段，写命令也没有 --state。

### 完整编辑一张卡

~~~text
aichat edit --node <id> --if-revision <n>
~~~

在同一次 edit 中按需组合：

| 内容 | 参数 |
| --- | --- |
| 标题 | --title |
| 显式摘要 | --summary 或 --clear-summary |
| 正文 | --body、--body-file、--body-stdin 三选一 |
| 追加 / 唯一替换 | --append-file 或 --replace-file，与其他正文模式互斥 |
| 重要性 | --important true / false |
| 当前入边说明 | --description |
| 改关系类型 | --flow next / branch，并给 --description |
| 改来源 | --from-node、--from-revision、--flow、--description 一起给 |

未给字段保持原值，至少给一项修改。root 没有入边，任何 incoming 修改整体拒绝。
--summary 与 --clear-summary 互斥，空摘要字符串不是清除。
只改元数据不读取 stdin，只有 --body-stdin 才把 stdin 当正文。

~~~text
aichat edit --node <id> --if-revision 3 --description "补充这个结论的理由"
aichat edit --node <id> --if-revision 3 --body-file "./正文.md"
~~~

### NodePatch 与文本输入

单卡和 batch 使用同一 NodePatch；以下是一个合法的组合形状：

~~~json
{
  "title": "新的标题",
  "summary": "当前需要判断的问题。",
  "body": "完整正文。",
  "important": true,
  "incoming": {
    "from": {"id": "n_parent", "revision": 2},
    "flow": "branch",
    "description": "从这里展开独立方向",
    "order": 20
  }
}
~~~

正文模式只选一种。需要追加或替换时，用以下字段替代 body：

~~~json
{"append": "新增片段"}
~~~

~~~json
{"replace": [{"old": "唯一匹配的旧片段", "new": "新片段"}]}
~~~

replace.old 必须非空且恰好匹配一次。summary:null 清除显式摘要。
append 把文本追加到末尾，不会自动合并或重写已有正文。
incoming.from 使用来源节点实际版本；只改 description 无需重给来源。
incoming.description 才是入边说明，patch 顶层没有 description。
CLI edit 未暴露 order 参数，需要时可通过 batch 的 incoming.order 修改。
NodePatch 不含 state；batch 的 patch 或 create.node 出现 state 会按未知字段拒绝。

长正文用文件或显式 stdin。PowerShell 管道示例：

~~~powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
多行正文，可包含中文、引号和代码。
'@ | .\aichat.cmd edit --node "<nodeId>" --if-revision 3 --body-stdin
~~~

replace-file 内容为替换数组，或 {"replace":[...]} 对象。
JSON 输入中的 bodyFile / appendFile / replaceFile 由 CLI 读成文本；
相对路径以输入 JSON 所在目录为基准，stdin 输入则以当前目录为基准，服务端不读取这些路径。

## 新建、插入、批量和整理

~~~text
aichat create-topic --title <主题名> [--key <key>] [--root-title <标题>] --body-file <file>
aichat next --from-node <id> --from-revision <n> --title <标题> --description <理由> --body-file <file>
aichat branch --from-node <id> --from-revision <n> --title <标题> --description <理由> --body-file <file>
aichat delete --node <id> --if-revision <n>
aichat important --node <id> --on
aichat important --node <id> --off
~~~

创建正文也可用 --body 或 --body-stdin。
next / branch / insert 支持 --summary；
branch 另支持 --order 和保留为元数据的 --side，界面仍统一向右。
create-topic 当前只提供主题 / 根标题及正文，摘要从正文派生；
若要改根的其他字段，可直接使用返回 ID 和版本 edit。

key 在库内唯一，不是真实目录。next 已有后继会冲突，不自动挤走。
delete 只删最终没有子节点的叶卡，不删 root，不推断如何安置子树。
important 只设置标记，不产生也不替换最新变化批次。

insert 用 --after-node / --after-revision、--before-node / --before-revision 指定真实相邻 A→B，
并给新卡的 --title、正文、A→新卡的 --description、新卡→B 的 --next-description。
它在一次事务内形成 A→新卡→B。

~~~powershell
.\aichat.cmd insert --after-node "<a>" --after-revision 2 `
  --before-node "<b>" --before-revision 3 `
  --title "插入问题" --description "先明确条件" `
  --next-description "再继续原问题" --body-file "./正文.md"
~~~

### batch

~~~text
aichat batch --input <batch.json>
aichat batch --input-stdin
aichat batch --input <batch.json> --dry-run
~~~

同一主题内可组合 edit / create / delete。既有节点使用本批修改前的版本，
新节点使用本批 local 名称引用；所有动作按最终候选一次检查和提交。

~~~json
{
  "topicId": "t_...",
  "ops": [
    {
      "op": "edit",
      "target": {"id": "n_a", "revision": 2},
      "patch": {"body": "原问题的完整正文，补充已整合到相应段落。"}
    },
    {
      "op": "create",
      "as": "new-question",
      "from": {"id": "n_a", "revision": 2},
      "flow": "branch",
      "description": "进一步讨论独立方向",
      "node": {"title": "新问题", "bodyFile": "./新问题.md"}
    },
    {
      "op": "delete",
      "target": {"id": "n_leaf", "revision": 1}
    }
  ]
}
~~~

create.node 支持 title、body 及可选 summary / important / side / order；
bodyFile 是 CLI 输入形式，不能与 body 同给。后续创建可用 {"local":"new-question"} 作为 from。
前向引用须最终可解析且不成环。--dry-run 返回 checked 和变化计划，不写库或请求记录。
patch 没有顶层 description：入边说明写在 patch.incoming.description（如 {"incoming":{"description":"为什么改接"}}）。
放错位置时 CLI 会指出正确字段并给最小片段。

### rearrange

~~~text
aichat rearrange --input <edits.json>
~~~

~~~json
{
  "edits": [
    {
      "target": {"id": "n_a", "revision": 2},
      "from": {"id": "n_b", "revision": 4},
      "flow": "next",
      "description": "按最终关系继续"
    }
  ]
}
~~~

一次表达最终入边，可对多个主题各自内部重排，不允许跨主题父边。
不落临时 branch，整体校验唯一 next、无环及主题约束。

## 提交结果与继续修改

~~~json
{
  "ok": true,
  "command": "edit",
  "requestId": "...",
  "workspaceId": "w_...",
  "topicId": "t_...",
  "state": "committed",
  "revision": 12,
  "changedNodeIds": ["n_a"],
  "nodeRevisions": {"n_a": 4},
  "created": {"topicId": null, "nodeIds": [], "aliases": {}},
  "summary": "1 update",
  "diagnostics": []
}
~~~

- revision 是工作区版本，nodeRevisions 是本次节点实际版本；下一次 edit 可直接使用映射值。
- state 是提交状态（committed／noop／committed_refresh_pending；dry-run 为 checked），不是节点状态。
- 内容提交成功时另有 change：本次保存的最新变化摘要（requestId／counts／nodes）；noop、仅 important 与 dry-run 不含，纯删除会返回。
- 映射覆盖新建、实际修改及明确操作且仍存在的目标，noop 也返回；删除节点省略。
- insert 的 after 仅作相邻前置条件，映射包含实际改接的 before 与新节点。
- created.aliases 将本批名称映射到稳定 ID，不是后续批次仍可使用的别名。
- 幂等重放返回当时保存的结果和版本，不拼入最新数据；dry-run 不返回伪造的新版本。

内容批次（新增、改动或删除）与提交在同一事务内保存为该主题的最新变化批次，替换上一批，不累积历史；
纯删除同样替换，并把最近更新节点列表清空。important、noop、dry-run 和幂等重放不替换；
混合删除会把已删除节点从最近更新列表移除，被动编号等不产生变化批次。

写入由程序生成 requestId。结果未知先 `status <requestId>`；
同一 ID 和相同请求体重放原结果，不同请求体则冲突。
请求记录有限保留，status=unknown 不能证明写入失败。

## 导出

在 Web 导出设置中指定本机 HTML 目标，保存在 .aichat/local/exports.json。
目标位于工作区和程序目录之外，父目录须存在。
绑定后主题的可见数据变化会自动重建；没有绑定就不生成文件。
失败保留旧成品，外部改动的目标不直接覆盖，解绑不删除已有文件。
完整独立 HTML 包含主题、阅读器、样式及必要资源。
导出时同时保存该主题最新一批变化快照，离线也能显示新增／改动标签、主题变化清单和单卡差异；
没有该字段的旧成品仍可读取，只是不显示变化标记。
程序或阅读器升级不会单独重写已有成品；主题内容变化或用户显式重新导出时，
才用当前阅读器重新生成。旧成品（包括带多余节点 state 字段的 HTML）仍可读取。

## 帮助、错误和恢复

~~~text
aichat help --json
aichat help edit --json
aichat help batch --json
aichat help diff --json
aichat version
aichat whoami
aichat status <requestId>
~~~

根 help 返回命令目录；单命令 help 返回参数、约束、示例和结果字段。
batch 的 NodePatch 和 JSON 结构见本手册；不需要为普通操作读取全目录。

失败 JSON 形如 {"ok":false,"error":{"code":"...","message":"...","details":{},"usage":"..."}}；
details / usage 按错误实际需要返回。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 / 3 | 用法 / 工作区 |
| 4 / 5 / 6 | 版本冲突 / 操作冲突 / 结构校验 |
| 7 / 8 | 服务不可用 / 结果未知 |
| 9 / 10 / 11 | HTTP / 内部错误 / 未找到 |

412 VERSION_CONFLICT：重读相关节点并重新判断。
409 OPERATION_CONFLICT：检查占位或相邻关系，必要时明确最终重排。
422：按具体字段纠正输入。STALE_READ：从原范围重新读。
失败时不静默换库、改版本或重复提交不同正文。
