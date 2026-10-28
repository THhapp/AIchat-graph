# 命令参考（接口 4）

程序入口使用实际安装的 aichat 或 aichat.cmd；不要猜其他端口或旧 dist/cli 入口。所有读取和写入都围绕稳定 nodeId 与持久 revision。

## 读取

    aichat topics --workspace <dir>
    aichat validate --workspace <dir>
    aichat search <词> [--topic <topicId|key>] [--limit 10] [--page 0]
    aichat read <topicId|key> --view overview
    aichat read <topicId|key> --view structure [--from <nodeId>]
    aichat read <topicId|key> --view content --node <id> [--node <id> ...]
    aichat read --node <id> [--start <n>] [--length <n>|--full] [--from-heading <t> [--occurrence <n>]] [--meta]
    aichat resume <topicId|key> --node <anchorId> --budget 12000

overview：主题主线与直接分支入口，分支内部默认不展开。
structure：主题或子树的全部结构，无正文。
content：按顺序取正文；UTF-16 安全切片；--meta 不含正文。CLI 直读 SQLite 时 source 为 database。
resume：一次给出 anchor 正文、必要来路、直接 next/branch 邻居和少量 important/最近节点；其余摘要级。

响应含 budget、page.hasMore、page.next、fingerprint。cursor 绑定相关节点 revision；原样传回，只另带 --budget。相关节点变化会 409 STALE_READ，丢弃 cursor 重读。

## 单卡修改

    aichat edit --node <id> --if-revision <n> [--title <t>] [--state agreed|proposed|reference]
      [--summary <s>|--clear-summary] [--important true|false]
      [--body <text>|--body-file <file>|--body-stdin]
      [--append-file <file>|--replace-file <json>]
      [--description <why>] [--from-node <id> --from-revision <n> --flow next|branch]

示例：

    aichat edit --node <id> --if-revision 3 --title "完整标题" --summary "显式摘要" --description "入边说明" --important true --body-file ./正文.md
    aichat edit --node <id> --if-revision 3 --description "只改入边说明"
    aichat edit --node <id> --if-revision 3 --from-node <父> --from-revision 2 --flow branch --description "改接理由"

未给出字段不变。summary:null 才清除；CLI 用 --clear-summary，空字符串会报用法错误。body/append/replace 三选一。incoming 只对非 root；只改 description 可单给；改 from/flow 必须带 description；只给 flow 保留来源。metadata-only 不读 stdin。

## 新增、插入、批量、重排、删除

    aichat next --from-node <id> --from-revision <n> --title <t> --description <why> (--body <text>|--body-file <file>|--body-stdin)
    aichat branch --from-node <id> --from-revision <n> --title <t> --description <why> (--body ...) [--side left|right] [--order <n>]
    aichat insert --after-node <a> --after-revision <na> --before-node <b> --before-revision <nb> --title <t> --description <why> --next-description <back> (--body ...)
    aichat delete --node <id> --if-revision <n>
    aichat create-topic --title <t> [--key <k>] [--root-title <t>] (--body <text>|--body-file <file>|--body-stdin)
    aichat important --node <id> [--if-revision <n>] --on|--off
    aichat batch --input <batch.json>|--input-stdin [--dry-run]
    aichat rearrange --input <edits.json>

next 已有后继时 409，不自动挤掉；insert 只接受当前真实相邻 next；delete 只删无子节点叶卡，root 不可删；create-topic 的 key 唯一，根卡 state 默认 proposed、summary 未给时由正文首段派生；important 只翻转标记，不要求先读。所有 create/next/branch/insert 的正文都可用 --body、--body-file 或 --body-stdin。

batch 输入：

    {"topicId":"t_...","ops":[
      {"op":"edit","target":{"id":"n_a","revision":2},"patch":{"title":"补旧问题","append":"新增内容"}},
      {"op":"create","as":"newQ","from":{"id":"n_a","revision":2},"flow":"branch","description":"从这里旁出","node":{"title":"新问题","body":"正文"}},
      {"op":"create","as":"afterNew","from":{"local":"newQ"},"flow":"next","description":"新问题继续","node":{"title":"后续","body":"正文"}},
      {"op":"delete","target":{"id":"n_leaf","revision":1}}
    ]}

同主题一次事务；create 可引用本批 local（含安全前向依赖）；edit.patch 与单卡同字段；删除叶卡。bodyFile/appendFile/replaceFile 相对输入文件目录（stdin 相对 cwd）。--dry-run 返回 checked/changes，不落库、不写 request。

rearrange：

    {"edits":[{"target":{"id":"n_a","revision":2},"from":{"id":"n_b","revision":4},"flow":"next","description":"最终接法"},{"target":{"id":"n_c","revision":1},"from":{"id":"n_b","revision":4},"flow":"branch","description":"侧枝","order":30}]}

表达最终候选；提交后统一校验唯一 next、无环、同主题。

## NodePatch 字段

    {
      "title": "新标题",
      "state": "agreed",
      "summary": "显式摘要",
      "body": "完整正文",
      "append": "追加片段",
      "replace": [{"old": "旧", "new": "新"}],
      "important": true,
      "incoming": {"from": {"id": "n_父", "revision": 2}, "flow": "branch", "description": "理由", "order": 20}
    }

replace 的 old 必须恰好匹配一次；summary:null 清除显式摘要；incoming 对 root 整体 422；不可自连或跨主题。

## 提交与恢复

成功响应：ok、command、requestId、workspaceId、topicId、state（committed|noop）、revision（工作区级，不是节点版本；节点版本从 read/resume 的 node.revision 取）、changedNodeIds、created{topicId,nodeIds,aliases}、summary、diagnostics。提交后 SSE 更新页面；同主题最近更新替换，仅 important 不替换。

- 412 VERSION_CONFLICT：重读节点，按新 revision 重新判断后提交；不要静默用最新值覆盖。
- 409 OPERATION_CONFLICT：已有 next 或 insert 非相邻；先明确最终结构再 rearrange。
- 422 VALIDATION_FAILED：按 details.field/nodeId 修正；root 无入边；空摘要用 --clear-summary。
- 结果未知：先 aichat status <requestId>，不要重复提交不同正文。
- 409 STALE_READ：丢弃 cursor 重读。

## 其他

    aichat help [<command>] [--json]
    aichat version
    aichat whoami
    aichat status <requestId>

help --json 返回单命令参数、约束、示例和结果字段，不返回全量 batch schema。写入需要本机服务；descriptor 缺失时 CLI 可按约定自启动同版后台服务，--no-start-service 可禁止。
