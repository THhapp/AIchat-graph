# 命令参考

适用接口：4。本参考随 Skill 分发，可独立完成接入、读取和图维护，不依赖程序手册。
以下 aichat 指实际入口：可用 aichat.cmd 或 node <程序目录>/dist/next/cli.js。
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
程序、服务和参考对应接口 4。Skill 包装脚本只定位 cli，不自动使用配置中的 workspace。

`init <dir> --name <名称>` 用于新库；`import --workspace <旧V2目录> [--name <名称>]`
只在明确需要时一次导入，原件不改，已有 graph.sqlite 拒绝覆盖。
不要因开始记录自动初始化、导入或安装。

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

- overview 是主题默认视图，给主线和直接分支入口。
- structure 返回主题 / 子树连接，不带正文；--from 包含其后可达的 next 与 branch。
- content 可由 read --node 直达，返回正文与节点 revision；--meta 省略正文。
- resume 等价于 `read <topicId> --view resume --node <id>`，优先给 anchor 正文，
  其他来路、邻居、少量重要 / 最近节点为摘要；长正文仍可能需要续读。
- search 按标题、摘要、正文检索；validate 是主动诊断，不是每次提交后的固定步骤。

正文可选 --start、--length、--full，或 --from-heading 配 --occurrence。
偏移用 UTF-16；length 默认 4000、最大 16000；同名标题序号 0 起。
from-heading 从标题起读，不自动止于下一标题；full 也受整次输出预算约束。

~~~text
aichat read --cursor "<page.next>" --budget 12000
~~~

budget 默认 12000 UTF-16 单位，计整次响应。
page.hasMore 决定是否继续；range 表示片段范围，omitted 表示按视图省略正文。
cursor 原样传回，只另调 budget，不重发节点或切片条件；工作区仍需正常定位。
当前指纹含主题版本及所选节点版本，同主题修改可能使其过期，其他主题不影响。
STALE_READ 时丢弃旧 cursor，从原范围重读。

## 同一问题的一次完整 edit

~~~text
aichat edit --node <id> --if-revision <n> --body-file "./正文.md"
aichat edit --node <id> --if-revision <n> --description "新的入边说明"
~~~

一次 edit 可组合以下参数，不需拆多次提交：

| 内容 | 参数 |
| --- | --- |
| 标题 / 状态 | --title；--state agreed / proposed / reference |
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
next / branch / insert 可给 --summary 和 --state，branch 可给 --order；
side 只是保留元数据，不控制画布左右。默认状态 proposed。
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
important 单独设值可仅给 ID，提供 --if-revision 则检查；它不替换最近内容更新。

## NodePatch：单卡与批次相同

这是一个可组合的 patch 示例，正文只使用 body：

~~~json
{
  "title": "当前问题",
  "state": "proposed",
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
incoming 的来源用实际节点版本；root 整体拒绝 incoming，不能自连或跨主题。
CLI edit 没有 order 参数，需改它时用 batch 的 patch.incoming.order。

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
      "patch": {"append": "融入旧问题的补充。"}
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
create.node 支持 title、body、summary、state、important、side、order；
next 不带 side / order。删除操作为
{"op":"delete","target":{"id":"n_leaf","revision":1}}。

bodyFile / appendFile / replaceFile 由 CLI 读取，
相对输入文件目录解析；stdin 输入相对当前目录。
相应字段与内联正文模式互斥。dry-run 只给 checked / changes，不保存或伪造提交版本。
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

成功结果包含 state、工作区 revision、nodeRevisions、changedNodeIds、
created.aliases、requestId 和诊断。节点下一版本取 nodeRevisions[nodeId]，
不能用工作区 revision；不只为获取它再发一次 read。

映射覆盖新建、修改和明确操作且仍存在的目标，noop 也给；删除节点省略。
insert 的 after 仅作相邻前置条件，不作为修改目标返回。
replay 保留当时结果，dry-run 不给虚构新版本。
内容、状态、入边等实际变化按主题替换最近一批；important、纯删除等不替换，
删除时清除已不存在的节点 ID。

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
aichat version
aichat whoami
aichat status <requestId>
~~~

读取及 status 不需要服务；写入缺少服务描述时可自启动同版后台服务，
--no-start-service 可禁止。端口默认 4317，0 由系统选择，不假定所有连接失败都会自动恢复。

根 help 给命令目录，单命令 help 给参数、约束、示例和结果字段。
NodePatch / batch 的具体结构使用本参考。
不必为一次普通操作重读全部帮助。

HTML 目标通过前端选择，保存完整主题和资源，失败保留旧文件、解绑不删成品。
未绑定时不生成，不替用户指定长期位置；提炼知识按实际需要另做。
