# 命令速查

首次操作或遇到命令问题时阅读，不必每轮重读。入口和目标绑定见[工作区与目录职责](workspace.md)。

入口：`node "<aichat-cli>"`（工程内通常是 `dist/cli/index.js`）。默认输出 JSON；`--text` 为简短人类摘要。始终显式传 `--workspace "<工作区>"`，不要依赖默认当前目录。当前 CLI 的 `--help`／`<命令> --help` 是参数权威；本页保留常用操作与重要边界，不替代完整协议。

## 离线只读

| 命令 | 说明 |
| --- | --- |
| `topics` | 主题列表：topicId、title、真实入口文件、节点数 |
| `search <词> [--topic <topicId>] [--limit 1-100] [--page n]` | 标题→摘要→正文优先级排序；默认 10 项；主题过滤后分页；给出节点真实路径与文件哈希 |
| `read <topicId\|相对路径>` | 主题元数据与节点清单（显示编号、概述、状态、连接、真实文件与哈希）；不含节点正文 |
| `read --node <id> [--node <id> ...] [--meta] [--start n] [--length n] [--full] [--section 标题] [--section-index n] [--offline]` | 节点元数据／正文片段；默认 4000 UTF-16，单段上限 16000；`--meta` 不取正文；多卡有整次总量预算 |
| `validate` | 校验磁盘结构与全图；失败时不给 graph |

`read --node` 输出要点（在线与离线同一形状）：

- `nodes[]` 每项：`node` 是核心节点字段（`id`／`title`／`summary`／`number`／`from`／`flow`／`state`／`important`／`description` 等），`body`／`range`／`truncated`／`path`／`fileHash`／`editRef` 在同一项顶层。不要再按 `item.node ?? item` 猜来源。
- `source` 标明 `online`／`disk`；服务信息在同一次输出的顶层 `online`，不在每张卡上重复。在线项 `editRef` 可用；离线项为 `null`，不伪造凭据。
- `bodyOmitted: true` 表示本次只取元数据（`--meta`），没有正文；`range.total` 仍是正文总量。
- `range: { start, end, total, unit: "utf16" }`，左闭右开，不切断代理对；`truncated` 表示后面还有内容。
- `important` 是节点重要性，在 `node.important`。`lastChange` 不在节点读取里，见[重要标记与最近更新](#重要标记与最近更新)。

先定位、读相关范围，再写入。同一轮可维护多个节点，但每次提交使用相应真实读取凭据。需要理解节点完整论证时用 `--full`，不因默认片段短就误以为正文已读完。

## 读取规模与分段

宿主输出有上限，一次取太多会被截断，看起来像正文缺失或源文件损坏。按需要分层取：

| 需要 | 用法 |
| --- | --- |
| 只确认主题与节点清单 | `read <topicId>`：元数据加清单，不含正文 |
| 只要身份、元数据或写前凭据 | `read --node <id> --meta`：无正文，在线仍给 `editRef` |
| 看某张卡的开头 | `read --node <id>`：默认 4000 UTF-16，返回 `range` 与 `truncated` |
| 接着往后读 | `read --node <id> --start <上次 range.end>`，单次 `--length` 取 1—16000 |
| 只读某一节 | `read --node <id> --section "<标题>" [--section-index <n>]`，在线与离线一致 |
| 一次取多张卡 | 重复 `--node`；未显式给 `--length`／`--full` 时，整次约 12000 UTF-16 按节点均分（单卡最多 4000），每项各自给 `range`／`truncated`；顶层 `budget` 说明本次分配 |
| 确认整篇 | 只有需要完整论证时才 `--full`，不默认全取 |

`--start`／`--length` 以 UTF-16 为单位、左闭右开；续读用返回的 `range.end`，不按字数估。`--length` 只接受 1—16000，传 `0` 是参数错误（`INVALID_ARGUMENT`，退出码 2 并给出范围）；只取元数据用 `--meta`，不要用零长度试探。搜索结果先看默认 10 项（`--limit` 最多 100，`--page` 翻页），确认 nodeId 再读正文，不把整页摘要当成正文依据。

日常使用已绑定主题的稳定 ID：`search "<关键词>" --topic "<topicId>" --workspace "<工作区>"`。`topics` 用于解析用户给出的名称、目录和真实 ID，`read <topicId>` 用于核对节点归属；不要用全局 activeNode 或浏览器选中项决定写入主题。

## 在线写入

**当前格式**：一节点一份 Markdown、每个主题独立根（`schemaVersion: 2`, `topicMode: isolated`）。不再支持旧格式 1 或 shared 跨主题图。以下写入命令均需要该工作区的 `serve`：

| 命令 | 必需 | 说明 |
| --- | --- | --- |
| `edit --ref <ref>` | 至少一项修改 | `--title`／`--state`／`--summary`／`--body*`／`--append-file`／`--replace-file` |
| `branch --from-ref <ref> --title <t> --description <why>` | 正文来源之一 | 横向旁支；默认同主题、右侧、proposed、order 由服务取 max+10 |
| `next --from-ref <ref> --title <t> --description <why>` | 正文来源之一 | 纵向后继；`flow: next`，不带 side／order；来源已有 next 时 409，不插队 |
| `connect --ref <ref> --description <why>` | `--description` | 结构字段全可选：`--from-ref`／`--flow`／`--side`／`--order`；只改描述也合法 |
| `rearrange --input <spec.json>` | 至少一条 edit | 一次表达多条最终入边；工具在同一事务里安全排序，见[整体整理与重连](#整体整理与重连) |
| `important (--node <id> \| --ref <ref>) (--on \| --off)` | 二选一 | 设置／取消重要标记；`--node` 先做真实在线读取，`--ref` 保留读取时的冲突检查 |
| `create-root --topic-title <t> --title <t>` | 正文来源之一 | 仅空工作区；主题与根卡一次创建 |
| `create-topic --topic-title <t> [--directory <目录名>] [--title <首节点标题>]` | 正文来源之一 | 在当前主题库中创建新主题与独立 root；首节点标题默认主题名，目录为可选自命名单层目录 |
| `check --input <json>` | — | 只验证当前变更集合，不写盘 |
| `apply --input <json>` | — | 提交当前变更集合（需带真实旧哈希） |
| `status <requestId>` | — | 查询状态；unknown 不证明成功或失败 |

正文来源写法：`--body "短文本"`、`--body-file <路径>`、`--body-stdin`；追加用 `--append-file`，局部替换用 `--replace-file`（`[{old,new}]` 或 `{replace:[{old,new}]}`，`old` 必须非空且唯一匹配）。

概述使用已有节点的 `edit --summary`。创建命令没有该参数时，先把概述写成正文首段供程序派生；需要独立的显式概述再读取新节点、用真实凭据补设。不要向创建命令传不存在的 `--summary`。

```powershell
node "<aichat-cli>" edit --ref "<实际读取凭据>" --append-file "<补充正文.md>" --workspace "<工作区>"
node "<aichat-cli>" branch --from-ref "<实际读取凭据>" --title '输入分辨率改变后的处理' --description '从固定尺寸实例延伸到可变尺寸的网络设计' --body-file "<分支正文.md>" --workspace "<工作区>"
node "<aichat-cli>" create-topic --topic-title 'LeNet 学习' --directory 'lenet' --body-file "<首节点正文.md>" --workspace "<工作区>"
```

不自行生成 nodeId、路径、顺序、哈希或 requestId。托管提交已包含候选结构校验；核对返回结果即可，不要求每次再运行全图 `validate`。直接编辑源文件后、出现结构诊断或怀疑损坏时再校验。同一批修改只选托管提交或直接编辑。

用户明确要求记录新主题时可用 `create-topic`，不必先把整个工作区清空，也不把现有主题的 root 接到新主题。`--directory` 是单层目录名，不是任意路径；不自行创建目录或写元数据来绕过命令。创建能力以实际 CLI 的帮助和诊断为准。

## 整体整理与重连

整理可以拆分、合并、移动和重连，不必只原位追加或一路向后生长。已有节点的整体重排用 `rearrange` 一次表达最终入边，不再靠多次临时旁支和重读拼顺序：

```json
{
  "edits": [
    { "ref": "<C 的 editRef>", "fromRef": "<A 的 editRef>", "flow": "next", "description": "先比较两者的适用范围" },
    { "ref": "<B 的 editRef>", "fromRef": "<C 的 editRef>", "flow": "next", "description": "比较之后再回到原结论" },
    { "ref": "<D 的 editRef>", "fromRef": "<B 的 editRef>", "flow": "next", "description": "结论仍接在 B 之后" }
  ]
}
```

```powershell
node "<aichat-cli>" rearrange --input "<rearrange.json>" --workspace "<工作区>"
```

- `ref` 是要改接的节点，`fromRef` 是最终来源；`flow` 只取 `next`／`branch`，`branch` 可带 `side`／`order`。两个 ref 都必须来自真实读取；只需定位和凭据时用 `read --node <id> --meta`。
- `description` 写**最终**连接的理由，不能沿用旧边的说明。旧说明会从源文件和连接文字中消失，不会作为临时状态残留。
- 工具在同一批候选与事务里先腾空、再落位；中间状态不写盘，不产生临时说明、临时旁支或历史副本。失败时源文件不变：过期哈希 412、结构冲突 409、成环或重复 next 422。
- 一个来源最多一个 `next`。目标位置被别的后继占用时，必须把那个后继也写进同一次 `edits` 并给出它的最终位置；工具不会隐式挤掉或覆盖未声明的后继。被移动节点**后面**的节点如果来源要跟着变（例如 A→B→C→D 改成 A→C→B→D 时的 D），也属于同一次最终关系，示例已把它列入。
- 成功后响应带 `editRefs`（按 nodeId，覆盖本次实际变化的节点），可直接用于后续修改，不必立刻重读；未变化节点沿用原凭据。多节点整理不再签发单节点 `editRef`（为 `null`），以免同一节点出现两个凭据。需要核对最终编号与结构时再 `read <topicId>`。
- 只调整单条连接、且目标来源没有 next 冲突时，仍可用 `connect`。新建节点仍用 `branch`／`next`；要把新节点插进已有 next 之前，先创建，再用 `rearrange` 一次落位。
- 编号由程序按最终结构派生，不手工排序，也不写回源文件。改接的节点保留稳定 ID 和原有子树。

## 重要标记与最近更新

`important` 是节点自身的元数据，表示“值得回看”；`lastChange` 是界面图数据里按主题保留的最近一批提交记录，普通 `read --node` 不返回。两者不要混用：最近更新不是重要性，也不是修改历史。

读重要性看 `read --node` 返回的 `node.important`（布尔，缺省 false）。写：

```powershell
node "<aichat-cli>" important --node "<nodeId>" --on --workspace "<工作区>"
node "<aichat-cli>" important --ref "<实际读取凭据>" --off --workspace "<工作区>"
```

- `--node` 会在同一条命令里先做一次真实在线读取取得凭据，再提交；服务不可达时明确失败，离线不伪造。
- 已有读取凭据时用 `--ref`，保留冲突检查：读取后源文件被改过会 412，不偷偷补最新哈希。
- 只改这一项元数据，不改变正文、编号、连接或顺序；`lastChange` 也不因重要性单独变化。
- 取消标记会移除源文件中的 `important` 字段；不要手改源字段绕过事务。
- 界面通过 `POST /api/importance` 切换，那是界面入口；Agent 用上面的命令。

## 长文本与转义

正文、描述和整批变更不要拼进命令行字符串再层层转义——多层引号经常在 CLI 解析阶段就失败，命令根本没执行，事后看像“没有写入”。

- 正文：长文用 `--body-file <路径>` 或 `--body-stdin`；只有短文本才用 `--body`。
- 追加／局部替换：`--append-file`、`--replace-file`（`[{old,new}]`），不手拼 JSON 字符串。
- 整批结构变更：写成 JSON 文件再 `check --input <json>`／`apply --input <json>`。
- 描述里出现中文弯引号（`“”`、`‘’`）时，外层用单引号；PowerShell 会把它们当引号，参数被截成多段并报未知选项。

错误示范（不要这样写）：正文里含 JSON 和引号时，把整段塞进外层双引号再拼 `node <cli> edit --ref <ref> --body "{\"title\":\"...\",\"text\":\"...\"}"`。反斜杠与嵌套引号在参数解析阶段就被吃掉，命令报未知选项或截断参数；即使偶尔拼对了，下一处改动也极易再错。改成写文件：

```powershell
node <aichat-cli> connect --ref <editRef> '--description=改得更“准确”的说明' --workspace "<workspace>"
node "<aichat-cli>" edit --ref "<实际读取凭据>" --append-file "<补充正文.md>" --workspace "<工作区>"
```

## 工作区与服务

| 命令 | 说明 |
| --- | --- |
| `init <path> [--name n]` | 新工作区；目标已存在则拒绝 |
| `serve --workspace <path> [--port n]` | 默认 127.0.0.1:4317；端口占用明确失败 |
| `whoami` | 核对描述文件、服务与磁盘身份 |

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 用法／输入错误（含 `--input` 结构不合法） |
| 3 | 工作区或 workspaceId 不一致 |
| 4 | 412 版本冲突（旧哈希／过期凭据） |
| 5 | 409 语义冲突 |
| 6 | 422 校验失败，或离线校验不通过 |
| 7 | 服务不可达、描述文件陈旧、身份不符、启动失败 |
| 8 | 写入结果未知：先 status 与重读，不盲目重发 |
| 9 | 服务返回非标准错误体、端点缺失等 HTTP 错误；按 stderr 的 message/details 处理 |
| 10 | 未预期的内部错误；保留 stderr 的上下文 |
| 11 | 找不到节点／主题／文件 |

错误统一为 stderr 上的 `{ ok: false, error: { code, message, details?, diagnostics? } }`。

版本冲突后重新读取并重新判断，不能只取最新哈希让旧改动强行通过。语义冲突先检查当前结构，校验失败根据 diagnostics 修正内容。

退出码 8 时，先用原 requestId 查询 `status`，再核对源内容；未知既不证明成功也不证明失败，不换 requestId 盲目重发。服务重启后重新获取 editRef。服务不可达时可继续离线阅读与讨论；启动或直接写文件沿用用户已有授权，否则说明保存受阻。
