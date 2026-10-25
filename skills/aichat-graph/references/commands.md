# 命令速查

首次操作或遇到命令问题时阅读，不必每轮重读。入口和目标绑定见[工作区与目录职责](workspace.md)。

入口：`node "<aichat-cli>"`（工程内通常是 `dist/cli/index.js`）。默认输出 JSON；`--text` 为简短人类摘要。始终显式传 `--workspace "<工作区>"`，不要依赖默认当前目录。当前 CLI 的 `--help`／`<命令> --help` 是参数权威；本页保留常用操作与重要边界，不替代完整协议。

## 离线只读

| 命令 | 说明 |
| --- | --- |
| `topics` | 主题列表：topicId、title、真实入口文件、节点数 |
| `search <词> [--topic <topicId>] [--limit 1-100] [--page n]` | 标题→摘要→正文优先级排序；默认 10 项；主题过滤后分页；给出节点真实路径与文件哈希 |
| `read <topicId\|相对路径> [--budget n] [--cursor token]` | 默认 overview：主题范围、主线与直接分支入口；不含正文 |
| `read <topicId> --view structure [--from <nodeId>] [--budget n] [--cursor token]` | 指定范围的结构记录与必要边界；不含正文、路径和写凭据 |
| `read --node <id> [--node <id> ...] [--budget n] [--cursor token] [--meta] [--start n] [--length n] [--full] [--section 标题] [--section-index n] [--offline]` | content：节点正文／元数据；默认每卡 4000 UTF-16，程序负责整次预算与续读 |
| `validate` | 校验磁盘结构与全图；失败时不给 graph |

## 渐进读取

`read` 是唯一的读取入口，`--view` 是可选择的粒度，不是每次必须依次经过的流程：

- **overview**（`read <topicId>` 的默认）：主题身份、范围、主线节点和主线节点下的直接分支入口。分支入口带自身子树节点数和可继续读取的结构范围；分支内部默认不展开，这是设计上的范围说明，不是输出截断。
- **structure**：`--view structure [--from <nodeId>]`。返回指定主题／子树内的稳定节点记录（id、标题、摘要、状态、from、flow、description、顺序字段）和必要边界连接；不默认返回正文、长路径、文件哈希或 editRef。
- **content**：`--node <id>`（可重复）。复用节点正文、章节和真实写凭据；默认每卡最多 4000 UTF-16，`--meta` 只取元数据，`--start`／`--length`／`--section` 取精确片段；离线项 `editRef` 为 `null`。

范围由稳定 ID 和真实连接确定：

- 主题范围是当前 topicId 的全部节点；`--from <nodeId>` 表示从该节点沿 next／branch 可达的子树。起点在主线中段时，范围包含其后的主线延续，`scope.note` 会说明。
- 边界连接只解释范围节点从哪里接入，不把外部节点自动并入正文读取或修改范围。
- 主题隔离仍有效；不在读取时按显示编号或浏览器选中项猜范围。

整次响应预算与续读：

- `--budget` 默认 12000 UTF-16，覆盖最终 JSON 中的结构、元数据、凭据、page 和续读标记，而不是只限制正文。read 的 JSON 使用紧凑格式并保留结尾换行，`budget.used` 就是这份实际输出的 UTF-16 长度，可直接核对。可显式调大；UTF-16 不是模型 token 数，也不保证所有宿主一定不截断超大输出。
- `page.hasMore` 表示当前视图还有下一页；`page.next` 是程序生成的续读标记。把 `--cursor "<next>"` 原样交回即可，不要在续读时重发 view／topic／--from／--node 或切片参数；可另带 `--budget`，离线来源加 `--offline`。
- 正文项的 `truncated: true` 只表示这张卡还有正文没返回；overview 中“分支内部未展开”由 `scope.note` 说明。三者不是同一个 `complete` 字段。
- 相关节点或结构变化后，续读标记会返回 `STALE_READ`（退出码 5）；此时按提示从原范围重新读取，不要混用两批状态。无关主题变化不会单独使当前范围失效。
- 显式 `--full`／`--length`／`--start`／`--section` 是精确读取：结果超过当前 `--budget` 会明确失败，不静默截断。需要大输出时先提高 `--budget` 或缩小节点范围；`--meta` 也按预算分页。
- 连一条最小记录都放不下时返回 `BUDGET_TOO_SMALL`；诊断里的 `minimum` 是能让该页成立的最小预算，直接按它调高，不要用空页或极小预算反复重试。

`read --node` 的每个 item 形状：`node` 是核心节点字段（`id`／`title`／`summary`／`number`／`from`／`flow`／`state`／`important`／`description` 等），`body`／`range`／`truncated`／`path`／`fileHash`／`editRef` 在同一项顶层。顶层 `online` 只在整次响应出现一次；`source` 标明 `online`／`disk`。`range: { start, end, total, unit: "utf16" }` 左闭右开，不切断代理对。`important` 在 `node.important`；`lastChange` 不在读取视野里，见[重要标记与最近更新](#重要标记与最近更新)。

`--start`／`--length` 以 UTF-16 为单位、左闭右开；显式续读片段用返回的 `range.end`，不按字数估。`--length` 只接受 1—16000，传 `0` 是参数错误（`INVALID_ARGUMENT`，退出码 2 并给出范围）；只取元数据用 `--meta`，不要用零长度试探。搜索结果先看默认 10 项（`--limit` 最多 100，`--page` 翻页），确认 nodeId 再读正文，不把整页摘要当成正文依据。

日常使用已绑定主题的稳定 ID：`search "<关键词>" --topic "<topicId>" --workspace "<工作区>"`。`topics` 用于解析用户给出的名称、目录和真实 ID，`read <topicId>` 的 overview 用于定位主线与分支，`read --node` 用于正文与写前凭据；不要用全局 activeNode 或浏览器选中项决定写入主题。

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
