# AIchat-graph 程序 CLI 手册（接口 4）

程序入口为 dist/next/cli.js，仓库根也可用 aichat.cmd。默认 JSON；--text 输出摘要。配置优先 --workspace，其次 AICHAT_WORKSPACE，其次程序根 .aichat/default.json。

## 工作区与存储

一个工作区是目录，主存储固定为 graph.sqlite；resources/ 保存正文引用的本地图片；.aichat/runtime/service.json 是本机服务描述；.aichat/local/exports.json 是 HTML 目标。graph.sqlite 保存主题、节点、正文、显式摘要、状态、连接、入边说明、顺序、important、revision 和请求结果。没有节点 Markdown、文件哈希、源码 ranges 或 editRef；正常运行不扫描、监听或写回 .md。

    aichat init <dir> --name "思路库"
    aichat import --workspace <旧V2工作区> [--name "新名称"]
    aichat config --workspace <dir>
    aichat config --show

init 拒绝已有 graph.sqlite。import 只接受旧 schemaVersion 2 isolated；原文件不动；已有 graph.sqlite 拒绝；导入失败回滚并删除本次新建库。导入会把旧卡片相对 .md 链接改成 aichat:node/<id>，把 resources/ 图片引用归一成资源键。

服务：

    aichat serve --workspace <dir> [--port 4317|0] [--no-browser]

服务只监听 127.0.0.1；port 0 选实际端口；descriptor 记录 url/workspaceId/instanceId/pid/rootPath/program。写入命令发现没有 descriptor 时会自启动后台同版服务并等待可用；--no-start-service 可禁止。Agent 不需要手工编排服务。

## 读取

直接读 SQLite，返回稳定 nodeId 和整数 revision；不需要服务。CLI 直读时响应 source 为 database。

    aichat topics
    aichat validate
    aichat search <词> [--topic <topicId|key>] [--limit 10] [--page 0]
    aichat read <topicId|key> --view overview --budget 12000
    aichat read <topicId|key> --view structure [--from <nodeId>]
    aichat read <topicId|key> --view content --node <id> [--node <id> ...]
    aichat read --node <id> [--start <n>] [--length <n>|--full] [--from-heading <标题> [--occurrence <n>]] [--meta]
    aichat resume <topicId|key> --node <anchorId> --budget 12000

overview 只给主线与直接分支入口。structure 给主题或子树的全部结构，无正文。content 按顺序给正文切片；UTF-16 偏移不切代理对；--meta 只返回元数据。resume 是续谈入口，一次返回 anchor 正文、必要来路、直接 next/branch 邻居和少量 important/最近节点，其余摘要级，需要时再 content。

每个响应带 budget {unit,limit,used,mode}、page.hasMore 和 page.next。cursor 绑定节点 revision；把 page.next 原样传给 --cursor，只可另带 --budget；相关节点变化时返回 409 STALE_READ，丢弃 cursor 并从原范围重读。

## 写入公共契约

所有在线修改用读取时得到的 {id,revision}。revision 持久，服务重启不重置，无关主题不使其失效。冲突返回 412 VERSION_CONFLICT，details 带 expectedRevision/actualRevision/nodeId；不要先读最新再静默代填。单卡 edit 与 batch edit 共用同一个 NodePatch：

    {
      "title": "新标题",
      "state": "agreed",
      "summary": "显式摘要",
      "body": "完整正文",
      "append": "追加片段",
      "replace": [{"old": "旧片段", "new": "新片段"}],
      "important": true,
      "incoming": {
        "from": {"id": "n_父节点", "revision": 2},
        "flow": "branch",
        "description": "为什么改接到这里",
        "order": 20
      }
    }

- 未出现字段不变；body/append/replace 三选一；replace 的 old 必须恰好匹配一次。
- summary:null 才是清除；CLI 用 --clear-summary；空字符串不是删除。
- incoming 只对非 root；只改 description 可单独给；改 from/flow 必须同时给 description；只给 flow 保留当前来源。
- root 没有入边，任何 incoming 修改整体 422 VALIDATION_FAILED（details 含 field=incoming、category=structure、nodeId）。
- 内容、入边、重要性同一事务；失败不部分写入；仅 important 不替换最近内容更新集合。
- 不自动刷新凭据或占用读取版本。

## 单卡 edit

    aichat edit --node <id> --if-revision <n> [--title <t>] [--state agreed|proposed|reference]
      [--summary <s>|--clear-summary] [--important true|false]
      [--body <text>|--body-file <file>|--body-stdin]
      [--append-file <file>|--replace-file <json>]
      [--description <why>] [--from-node <id> --from-revision <n> --flow next|branch]

示例：

    aichat edit --node <id> --if-revision 3 --title "更准确的标题" --summary "新的概述" --description "更新后的入边理由" --important true --body-file .\正文.md
    aichat edit --node <id> --if-revision 3 --description "改后的理由"
    aichat edit --node <id> --if-revision 3 --from-node <新父> --from-revision 2 --flow branch --description "改接到这里更准确"

至少给一项；--summary 与 --clear-summary 互斥；--from-node 必须带 --from-revision、--flow、--description；只给 --flow 保留来源；metadata-only 不读 stdin，只有 --body-stdin 才读。

## 新增、插入、批量、重排、删除

    aichat next --from-node <id> --from-revision <n> --title <t> --description <why> (--body <text>|--body-file <file>|--body-stdin)
    aichat branch --from-node <id> --from-revision <n> --title <t> --description <why> (--body ...) [--side left|right] [--order <n>]
    aichat insert --after-node <a> --after-revision <na> --before-node <b> --before-revision <nb> --title <t> --description <why> --next-description <back> (--body ...)
    aichat delete --node <id> --if-revision <n>
    aichat create-topic --title <t> [--key <k>] [--root-title <t>] (--body <text>|--body-file <file>|--body-stdin)
    aichat important --node <id> [--if-revision <n>] --on|--off
    aichat batch --input <batch.json>|--input-stdin [--dry-run]
    aichat rearrange --input <edits.json>

next 遇已有 next 返回 409，不隐式挤掉。insert 只接受当前真实相邻 next。delete 只允许无子节点叶卡，root 不可删，不递归合并。create-topic 的 key 唯一，省略时由标题派生；根卡 state 默认 proposed，summary 未给时由正文首段派生。important 只翻转标记，不要求预读 token。create/next/branch/insert 的正文都可来自 --body、--body-file 或 --body-stdin。

batch 输入：

    {"topicId":"t_...","ops":[
      {"op":"edit","target":{"id":"n_a","revision":2},"patch":{"title":"补旧问题","append":"新增内容"}},
      {"op":"create","as":"newQ","from":{"id":"n_a","revision":2},"flow":"branch","description":"从这里旁出","node":{"title":"新问题","body":"正文"}},
      {"op":"create","as":"afterNew","from":{"local":"newQ"},"flow":"next","description":"新问题继续","node":{"title":"后续","body":"正文"}},
      {"op":"delete","target":{"id":"n_leaf","revision":1}}
    ]}

同一主题一次事务；create 可引用本批 local（含安全前向依赖）；edit.patch 与单卡完全相同；create.node 支持 title、body 及可选 summary/state/important/side/order；删除叶卡。CLI 从输入 JSON 读 bodyFile/appendFile/replaceFile（相对输入文件目录，stdin 相对 cwd），服务端不读路径。--dry-run 返回 changes 和 checked，不落库、不写 request。

rearrange 输入：

    {"edits":[{"target":{"id":"n_a","revision":2},"from":{"id":"n_b","revision":4},"flow":"next","description":"最终接法"},{"target":{"id":"n_c","revision":1},"from":{"id":"n_b","revision":4},"flow":"branch","description":"侧枝","order":30}]}

表达最终候选连接，提交后统一校验唯一 next、无环、同主题；不为临时态落旁支。

## 提交结果、最近更新与幂等

成功响应含 requestId、workspaceId、topicId、state（committed|noop）、revision（工作区级，不是节点版本）、changedNodeIds、created{topicId,nodeIds,aliases}、summary、diagnostics。提交后服务通过 SSE 推 snapshot；浏览器取得一致图数据。每主题 lastChanges 只在标题/摘要/正文/内容/入边真实变化时替换；仅 important 不替换；删除从集合移除被删节点。同一 requestId 同请求体重放原结果，不同请求体 409；aichat status <requestId> 直接读库查询。

## 导出与独立 HTML

导出目标由 Web 阅读器设置，存 .aichat/local/exports.json。目标须是工作区与应用根之外的绝对 .html；每次内容/节点 revision 变化自动重建；同路径原子替换；失败保留旧成品；外部改动拒绝覆盖；解绑不删旧文件。成品完整自包含，含正文、布局、脚本、样式和本地图片资源。

## 帮助与错误

    aichat help [<command>] [--json]
    aichat version
    aichat whoami
    aichat status <requestId>

help --json 只返回单命令参数/约束/示例/结果字段，不返回全量 batch schema。错误默认写 stderr：{ok:false,error:{code,message,details,usage}}。退出码：0 成功，2 用法，3 工作区，4 版本冲突（412），5 操作冲突（409），6 校验/结构（422），7 服务不可用，8 结果未知。

恢复：412 重新读取后按新 revision 重试；409 先显式重接已有 next；422 按 details.field/nodeId 修正，root 入边不可改、空摘要用 --clear-summary；结果未知先 status 再决定，不重复提交不同正文；STALE_READ 丢弃 cursor 重读。
