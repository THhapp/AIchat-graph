# 命令参考

适用接口：6。本参考随 Skill 分发，可独立完成接入、读取和图维护，不依赖程序手册。
以下 aichat 指实际入口：Windows 便携包用包根 aichat.cmd；源码开发用
node <程序目录>/dist/next/cli.js。
<...>、n_a、t_... 等均为占位，使用真实返回的 ID 与版本。

## 接入与定位

~~~text
aichat version
aichat config --workspace <dir>
aichat config --show
aichat whoami --workspace <dir>
aichat topics --workspace <dir>
~~~

目录按 --workspace、AICHAT_WORKSPACE、该程序根 .aichat/default.json 选择。
--workspace-id 只校验身份，不查目录；已知目标后持续沿用，不每轮重新接入。
默认 JSON，--text 为人类摘要；写入 --verbose 仅增加诊断。
程序、服务和参考对应接口 6。Skill 包装脚本只定位 cli，不自动使用配置中的 workspace。

`init <dir> --name <名称>` 用于新库；`import --workspace <旧V2目录> [--name <名称>]`
只在明确需要时一次导入，原件不改，已有 graph.sqlite 拒绝覆盖。
不要因开始记录自动初始化、导入或安装。

aichat open 用于用户主动打开/复用本库服务，aichat stop 只请求服务自行退出；
两者都属于本机程序维护，不是记录流程的固定步骤。不要未经用户要求停止服务，
也不要因页面断开就自行重启或建第二个服务。

## 选合适的读取粒度

~~~text
aichat read <topicId|key>
aichat read <topicId|key> --view structure [--from <nodeId>]
aichat read --node <id> [--node <id> ...]
aichat read --node <id> --meta
aichat resume <topicId|key> --node <anchorId>
aichat search <词> [--topic <topicId|key>] [--limit 10] [--page 0]
aichat validate
~~~

- overview 是主题默认视图，给主线和直接分支入口，只含节点元数据与连接。
- structure 返回主题 / 子树结构，不带正文；--from 包含其后可达的 next 与 branch。
- content 可由 read --node 直达，返回正文与节点 revision；--meta 只给元数据。
- resume 等价于 `read <topicId> --view resume --node <id>`，优先给 anchor 正文，
  其他来路、邻居、少量重要 / 最近节点为摘要；长正文仍可能需要续读。
- 节点项不重复 topicId；只有实际返回正文的项才有 body／range／truncated，其余标 omitted。
  resume 用响应顶层 anchorId 指认锚点，anchor 元数据在 items 中只出现一次。
- search 按标题、摘要、正文检索；validate 是主动诊断，不是每次提交后的固定步骤。

正文可选 --start、--length、--full，或 --from-heading 配 --occurrence。
偏移用 UTF-16；length 默认 4000、最大 16000；同名标题序号 0 起。
from-heading 从标题起读，不自动止于下一标题；full 也受整次输出预算约束。

~~~text
aichat read --cursor "<page.next>" --budget 12000
~~~

budget 默认 12000 UTF-16 单位，计整次响应；BUDGET_TOO_SMALL 的 details.minimum 给出最小可用预算。
page.hasMore 决定是否继续；range 只在正文返回时出现，omitted 表示按视图或 --meta 省略正文。
续读 cursor（v2）记录原视图、范围与切片条件（length／full／meta），续页保持原切片长度与 range；
content 的节点顺序保留，topic／subtree 不在 cursor 重复节点列表。
cursor 原样传回，只另调 budget，不重发节点或切片条件；工作区仍需正常定位。
当前指纹含主题版本及所选节点版本，同主题修改可能使其过期，其他主题不影响。
STALE_READ 时丢弃旧 cursor，从原范围重读。

## 查看变化批次：diff

~~~text
aichat diff <topicId|key> [--request <id>] [--node <id> [--patch]] [--budget <n>]
aichat diff (--input <batch.json>|--input-stdin) [--node <id> [--patch]] [--budget <n>]

aichat diff --cursor "<page.next>" --budget 12000
~~~

最新批次直接只读数据库，不需要服务；--input 用 batch JSON 做 dry-run 预览，需要服务。
默认摘要给 requestId、counts 与节点（nodeId、title、kind、fields）；删除节点也在清单里，正文不在摘要中。
批次字段只有 title、summary、from、flow、description、side、order，正文用 unified patch 表示，
important 不属于批次。
--node 过滤一张卡；加 --patch 给 before／after 版本、fieldDiffs 和 unified 正文 patch（新增／删除为
空→正文／正文→空）；--patch 必须配 --node，不在批次报 CHANGE_NOT_FOUND。预览与最新批次格式一致。
--request 只接受当前最新批次：旧批次报 BATCH_SUPERSEDED（details.latest 给最新 requestId），
未知报 BATCH_UNAVAILABLE；不静默换批次。
schema 1／2 旧库没有保存过批次：不带 --request 报 CHANGE_HISTORY_UNAVAILABLE，带 --request 报 BATCH_UNAVAILABLE；
可写打开升级后开始记录，不补造。

--budget 是整次 JSON 响应预算（UTF-16，默认 12000）：序列化后长度（JSON.stringify(payload).length+1）
超过预算就分页，budget.used 是实际长度，budget.truncated 与 page.hasMore 一致。
summary 按节点分页，每页 counts 都是整批统计；patch 按行分页，每页重复 fieldDiffs 与整篇增删统计。
预算不足报 BUDGET_TOO_SMALL，details.minimum 给出最小预算；不输出半个 JSON。
--text 的预算仍按 JSON 计量，不保证文本输出同样短。
page.hasMore 为真时用 page.next 作为 --cursor 续读，只可再带预算／输出／工作区选项，不重发主题或查看条件；
最新续页校验 requestId 仍最新（旧批次 BATCH_SUPERSEDED），cursor 非法报 CURSOR_INVALID。
--input 预览的 cursor 内嵌原批次动作，用同一 requestId 重新 dry-run，不落库；目标期间被真实改动时重放报 412。
预览不接受 --request 与主题位置参数。

例如先预览已有卡片的改写，不提交：

~~~text
aichat diff --input batch.json --node <id> --patch
~~~

预览 cursor 内含压缩后的批次动作，大输入可能要求更大预算；不要解码或改写 cursor。
每卡正文 patch 最多生成 16000 UTF-16 单元，超出按整行截断。
page.hasMore 决定是否续页；末页 body.truncated 仍为真时，不能声称已看完全部差异，
增大预算也不会恢复被生成上限截去的部分。需要当前完整正文时另用 read。

每主题只保留最近一次实际内容提交，不按回复累计。
普通写后不必固定看 diff；需要核对改写时再查；只检查提交可行性用 batch --dry-run。

## 同一问题的一次完整 edit

~~~text
aichat edit --node <id> --if-revision <n> --body-file "./正文.md"
aichat edit --node <id> --if-revision <n> --description "新的入边说明"
~~~

一次 edit 可组合以下参数，不需拆多次提交：

| 内容 | 参数 |
| --- | --- |
| 标题 | --title |
| 摘要 | --summary 或 --clear-summary |
| 正文三选一 | --body、--body-file、--body-stdin |
| 追加 / 替换 | --append-file、--replace-file，与其他正文模式互斥 |
| 回看标记 | --important true / false |
| 入边说明 / 类型 | --description；--flow next / branch |
| 新来源 | --from-node、--from-revision、--flow、--description 一起给 |

省略字段不改。summary:null 清除显式摘要；CLI 用 --clear-summary，不能传空字符串。
root 不允许 incoming；只改 description 不需重给父节点。
只给 flow 保留来源，也须给 description。metadata-only 不读 stdin。

文件和显式 stdin 均可传长正文，按宿主环境选择，不为强制一种方式叠加包装。
PowerShell 管道中可设 $OutputEncoding 为 UTF-8 后传 --body-stdin。

## 新问题、插入与叶删除

~~~text
aichat next --from-node <id> --from-revision <n> --title <标题> --description <理由> --body-file <file>
aichat branch --from-node <id> --from-revision <n> --title <标题> --description <理由> --body-file <file>
aichat create-topic --title <主题名> [--key <key>] [--root-title <标题>] --body-file <file>
aichat delete --node <id> --if-revision <n>
aichat important --node <id> --on
aichat important --node <id> --off
~~~

创建正文也可用 --body 或 --body-stdin。
next / branch / insert 可给 --summary，branch 可给 --order；
side 只是保留元数据，不控制画布左右。
create-topic 的根卡目前只由标题和正文创建，摘要派生；其他根字段可用返回 ID / 版本再 edit。
key 是库内唯一标识，不是真目录；没有明确新建需求不另造主题。

next 已有后继会冲突。insert 使用 after / before 两端的实际 ID 和版本，
并给 --title、正文、--description 与 --next-description，一次形成 A→新卡→B：

~~~text
aichat insert --after-node <a> --after-revision <na> --before-node <b> --before-revision <nb>
              --title <标题> --description <A到新卡> --next-description <新卡到B> --body-file <file>
~~~

上面是换行展示的参数结构，实际按宿主 shell 的续行方式组合。
delete 仅删最终无子节点叶卡，root 不可删，不自动安排其子树。
important 单独设值可仅给 ID，提供 --if-revision 则检查；它不产生也不替换变化批次。

## NodePatch：单卡与批次相同

这是一个可组合的 patch 示例，正文只使用 body：

~~~json
{
  "title": "当前问题",
  "summary": "当前需要判断的核心。",
  "body": "完整说明。",
  "important": true,
  "incoming": {
    "from": {"id": "n_parent", "revision": 2},
    "flow": "branch",
    "description": "从这里展开",
    "order": 20
  }
}
~~~

追加用 {"append":"新片段"} 替代 body；唯一替换用
{"replace":[{"old":"唯一旧片段","new":"新片段"}]} 替代 body。
body / append / replace 三选一；replace.old 必须恰好匹配一次。
append 直接追加到正文末尾，不会自动将补充融入原文。
incoming 的来源用实际节点版本；root 整体拒绝 incoming，不能自连或跨主题。
CLI edit 没有 order 参数，需改它时用 batch 的 patch.incoming.order。
入边说明属于 incoming.description，patch 顶层没有 description；放错时 CLI 会指出正确字段并给最小片段。
节点没有确认状态，NodePatch / NodeCreate 都不含 state；batch 输入中出现 state 会按未知字段拒绝。

## 补旧卡并新建卡：batch

~~~text
aichat batch --input <batch.json>
aichat batch --input-stdin
aichat batch --input <batch.json> --dry-run
~~~

~~~json
{
  "topicId": "t_...",
  "ops": [
    {
      "op": "edit",
      "target": {"id": "n_old", "revision": 2},
      "patch": {"body": "原问题的完整正文，已将补充融入对应位置。"}
    },
    {
      "op": "create",
      "as": "newQ",
      "from": {"id": "n_old", "revision": 2},
      "flow": "branch",
      "description": "独立讨论下一方向",
      "node": {"title": "新问题", "bodyFile": "./新问题.md"}
    }
  ]
}
~~~

既有选择器使用本批前版本；新建可从 {"local":"newQ"} 继续创建，
local 名称只在本批有效，最终 ID 见 created.aliases。
create.node 支持 title、body、summary、important、side、order；
next 不带 side / order。删除操作为
{"op":"delete","target":{"id":"n_leaf","revision":1}}。

bodyFile / appendFile / replaceFile 由 CLI 读取，
相对输入文件目录解析；stdin 输入相对当前目录。
相应字段与内联正文模式互斥。dry-run 只给 checked / changes，不保存或伪造提交版本。
入边说明写在 patch.incoming.description，patch 顶层没有 description。
整批按最终图一次事务提交，不写临时旁支。

## 纯连接整理：rearrange

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
      "description": "最终接法"
    }
  ]
}
~~~

可同时整理多个主题各自内部的边，不能跨主题父边。
程序检查最终唯一 next、无环与主题归属，不要求手动制造中间态。

## 写后继续维护与错误处理

写入结果的 state 表示 committed／noop／committed_refresh_pending；dry-run 为 checked，
不是节点分类。结果还包含工作区 revision、nodeRevisions、changedNodeIds、created.aliases、
requestId 和诊断。内容提交成功时另有 change（本次最新批次摘要）；noop、仅 important 与 dry-run 不含。
节点下一版本取 nodeRevisions[nodeId]，不能用工作区 revision；不只为获取它再发一次 read。

映射覆盖新建、修改和明确操作且仍存在的目标，noop 也给；删除节点省略。
insert 的 after 仅作相邻前置条件，不作为修改目标返回。
replay 保留当时结果，dry-run 不给虚构新版本。
内容批次（新增、改动、删除）替换该主题上一批，纯删除同样替换并把最近更新节点列表清空；
important、noop、dry-run 与重放不替换；混合删除会移除已不存在的节点 ID。

- 412：重读相关节点，理解新内容后再判断，不能静默取最新版本覆盖。
- 409 占位 / 相邻冲突：明确最终连接，必要时 rearrange；不要临时 branch 绕行。
- 422：按字段 / 节点修正；root 无入边、空摘要用 clear-summary。
- 结果未知：先 `status <requestId>`，unknown 也不证明写入失败。
- 读取过期：从原范围重新读取。

退出码为 0 成功；2 用法；3 工作区；4 版本；5 操作；6 校验；
7 服务；8 结果未知；9 HTTP；10 内部错误；11 未找到。

## 服务、帮助和成品

~~~text
aichat serve --workspace <dir> [--port <端口>] [--no-browser]
aichat help --json
aichat help batch --json
aichat help diff --json
aichat version
aichat whoami
aichat status <requestId>
~~~

读取及 status 不需要服务；写入缺少服务描述时可自启动同版后台服务，
--no-start-service 可禁止。服务端口优先用工作区 .aichat/local/runtime.json 的偏好，
其次 4317；被占用时才用系统空闲端口，0 明确表示系统选择。
不假定所有连接失败都会自动恢复。

根 help 给命令目录，单命令 help 给参数、约束、示例和结果字段。
NodePatch / batch 的具体结构使用本参考。
不必为一次普通操作重读全部帮助。

HTML 目标通过前端选择，保存完整主题和资源，失败保留旧文件、解绑不删成品。
未绑定时不生成，不替用户指定长期位置；提炼知识按实际需要另做。
