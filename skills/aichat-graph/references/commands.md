# 命令速查

首次实际操作、命令不熟悉或遇到错误时按相关章节查阅，不必每轮通读。
入口与主题绑定见[工作区与目录职责](workspace.md)，节点写法见[内容维护](maintenance.md)。

## 调用与结果

下文 PowerShell 示例先绑定两个实际位置：

```powershell
$cli = '<实际运行版本>/dist/cli/index.js'
$ws = '<讨论工作区绝对路径>'
node "$cli" topics --workspace "$ws"
```

始终显式传 `--workspace`。默认 JSON 供机器处理，`--text` 为简短人类摘要。
参数以当前入口的 `<命令> --help` 为准；通用 Skill 不保存本机绑定。

| 操作 | JSON 中取值的位置 |
| --- | --- |
| `read --node` 的正文与元数据 | `items[i].node`、`items[i].body` |
| 读取后的写入 token | `items[i].editRef.ref` |
| 高层写命令的提交结果 | `result`，根级另有 `requestId` |
| 单节点写入后的新 token | `result.editRef.ref`，存在时可继续使用 |
| `rearrange` 后的新 token | `result.editRefs[nodeId].ref` |

`editRef` 是带身份、版本和路径的对象；命令参数 `--ref`、`--from-ref` 只接收其中的
`ref` 字符串。不要把整份对象、显示编号或自行拼接的 ID 当作 token。

写命令返回 `ok: true` 后仍看 `result.state`：

- `committed`：已提交。
- `noop`：没有实际内容变化，不需要再提交一次。
- `committed_refresh_pending`：文件已提交，快照刷新待完成。
  按诊断核对服务和源内容，不把它当作没写入而重复创建。
  此时可能没有可继续使用的新凭据。

## 定位和读取

| 命令 | 用途 |
| --- | --- |
| `topics` | 核对真实 topicId、标题、入口路径和节点数 |
| `search <词> --topic <topicId>` | 在绑定主题内搜索标题、概述和正文 |
| `read <topicId>` | 默认 overview，定位主线和直接分支入口 |
| `read <topicId> --view structure` | 主题结构，不含正文和写凭据 |
| `read --node <id>` | 默认 content，读取节点正文和写前凭据 |
| `validate` | 校验磁盘结构；诊断异常时使用，不是每次保存后的固定动作 |

搜索默认 10 项，`--limit` 为 1—100，`--page` 翻页。
排序优先标题、其次概述、最后正文。确认稳定 nodeId 后再读取正文。

### 读取粒度和范围

`read` 的三种粒度可以直接选择，不要求逐层访问：

- **overview**：主题身份、主线和主线节点下的直接分支入口。
  分支入口带子树节点数和继续读取的范围；分支内部默认未展开。
- **structure**：所选范围的节点身份、派生编号、标题、概述、状态及连接。
  不返回正文、长路径、哈希或写凭据。
- **content**：由可重复的 `--node` 指定节点，读取正文或元数据。
  主题位置参数与 `--node` 不能同时给出。

```powershell
node "$cli" read '<topicId>' --workspace "$ws"
node "$cli" read '<topicId>' --view structure --from '<nodeId>' --workspace "$ws"
node "$cli" read --node '<nodeId>' --workspace "$ws"
node "$cli" read --node '<A>' --node '<B>' --meta --workspace "$ws"
```

`--from` 用于 overview／structure 的可达子树；省略 view 时会选择 structure。
起点在主线中段时，范围包含后续 next 及其分支，不只是该节点的旁支。
边界连接解释范围从哪里接入，不自动扩大读取和修改范围。

`read --node` 的 item 包含：

- `node`：含 id、topicId、title、summary、number、from、flow、state、important 等。
- `body`、`range`、`truncated`：本次正文片段及其范围。
- `path`、`fileHash`、`editRef`：源位置、真实字节哈希与在线凭据。
- `bodyOmitted: true`：明确只取元数据，不代表源正文为空。

整次响应的 `source` 是 `online` 或 `disk`，`online.available` 表示在线能力。
离线 item 的 `editRef` 为 null。读取优先连接同工作区服务，服务不可用时回退磁盘；
`read --offline` 可以明确只读磁盘，写入不回退离线。

### 预算与续读

- `--budget` 默认 12000，范围 1—1000000，单位是 UTF-16，不是字节或模型 token。
  它覆盖整次紧凑 JSON、凭据、分页信息和结尾换行；`budget.used` 是实际输出长度。
- content 默认每卡最多 4000 UTF-16，多卡共享整次预算，可能需要多个页面。
  `--meta` 也受分页约束。
- `page.hasMore` 表示当前视图还有页面，`page.next` 是续读 token。
  续读时只传 cursor、工作区和所需预算／输出选项；磁盘 token 另加 `--offline`。
  不重发主题、view、node、from、meta 或正文切片选项。

```powershell
node "$cli" read --cursor '<原样的 page.next>' --budget 12000 --workspace "$ws"
```

- `truncated` 仅表示当前正文片段后面还有内容；末段为 false。
  它不同于 `page.hasMore`，也不同于 overview 的 `scope.note` 所说明的未展开分支。
- `BUDGET_TOO_SMALL`：连最小记录也放不下，按 `error.details.minimum` 调高预算。
- `BUDGET_EXCEEDED`：显式精确片段超预算；调高预算或缩小范围，不依靠静默截断。
- `STALE_READ`（退出码 5）：相关范围发生变化，丢弃旧 cursor，从原范围重新读。
  不混合两批状态；无关主题或不影响本范围的变化不会单独使 token 失效。
- 在线 token 不能离线续读。服务不可达时从磁盘重新开始相应范围，不硬接旧 token。
  程序预算也不能保证宿主永远不截断大输出，按实际任务控制范围。

### 精确片段和章节

- `--start` 为 0—100000000；`--length` 为 1—16000。
  `range: {start,end,total,unit:"utf16"}` 左闭右开，避免切断代理对。
  手动指定下段时使用实际 `range.end`；日常分页优先用 cursor。
- `--full` 从所选起点读到正文末尾，与 `--length` 互斥，仍受整次预算限制。
- `--section '<标题>'` 从该标题开始取片段，默认仍最多 4000 UTF-16。
  它不是只截取这一节，后续可能包含其他章节；结合 `--full` 会读取到正文末尾。
- 标题重名时，`--section-index` 选择同名标题中的第几个，0 起。
  它不是全文标题序号；只能和 `--section` 一起使用。
- `--meta` 不返回正文，不能和 start、length、full、section、section-index 同用。
  只取凭据用 meta，不要传零长度。主题概览／结构也不接受正文切片选项。

```powershell
node "$cli" read --node '<id>' --section '适用范围' --length 1200 --workspace "$ws"
node "$cli" read --node '<id>' --full --budget 30000 --workspace "$ws"
```

## 在线写入

以下命令需要同工作区的运行服务。创建节点的正文来源三选一：
`--body`、`--body-file` 或 `--body-stdin`。

| 命令 | 关键参数与用途 |
| --- | --- |
| `edit` | `--ref`，至少修改 title、state、summary 或正文之一 |
| `branch` | `--from-ref --title --description` 和正文，创建独立方向 |
| `next` | `--from-ref --title --description` 和正文，创建纵向后继 |
| `connect` | `--ref --description`，修改一条现有连接或仅修改其说明 |
| `rearrange` | `--input <json>` 或 `--input-stdin`，批量重排最终入边 |
| `important` | `--node` 或 `--ref`，配合 `--on` 或 `--off` |
| `create-topic` | `--topic-title` 和正文，创建主题及独立根 |
| `create-root` | `--topic-title --title` 和正文，仅用于空工作区 |

### 修改和创建节点

`edit` 的正文模式互斥：整篇替换（body／body-file／body-stdin）、
追加（append-file）、局部替换（replace-file），一次只给一种。
title、state、summary 可以与所选正文模式同次更新。
`--replace-file` 接受 `[{"old":"...","new":"..."}]` 或 `{ "replace": [...] }`；
每个 old 必须非空且唯一匹配，不做含糊的全局替换。

```powershell
node "$cli" edit --ref '<token>' --append-file '<补充正文.md>' --workspace "$ws"
node "$cli" edit --ref '<token>' --state agreed --summary '已明确的要点' --workspace "$ws"

$branchArgs = @(
  'branch', '--from-ref', '<来源 token>',
  '--title', '输入尺寸改变后的设计',
  '--description', '从固定尺寸延伸到可变输入',
  '--body-file', '<分支正文.md>', '--workspace', $ws
)
node "$cli" @branchArgs
```

创建与重连的实际边界：

- branch 与 next 的新提议默认 proposed，不因来源已确认而自动 agreed。
  可显式传 `--state proposed|agreed|reference`，按实际内容判断。
- branch 的 order 默认由服务取现有最大值加 10；日常无需手工分配。
- 来源已有 next 时，`next` 返回 409，不自动插队或顶掉旧后继。
  `next --topic-id` 不能用来绕过主题隔离，通常沿用来源主题即可。
- `connect` 可选 `--from-ref`、`--flow root|next|branch`、`--side`、`--order`。
  仅修改 description 也合法；从 branch 改为 next 时仍须满足唯一后继约束。
- branch、connect、rearrange 仍接受 branch 的 side 元数据。
  当前界面全部向右展开，`--side left` 不会让卡片显示在左侧；不用它微调外观。
- 创建命令没有 `--summary`。先用正文首段提供派生概述；需要显式概述时，
  用创建结果的新 token 或重新读取后执行 `edit --summary`。
- `create-topic` 可带 `--directory '<单层目录名>'`、`--title` 和 `--state`。
  首卡标题默认主题名，目录碰撞拒绝；不自行建元数据或清空工作区绕过创建检查。

高层命令生成 requestId、节点 ID、真实路径与默认顺序。
成功后核对 `result.created`、`result.changedNodeIds` 和新凭据，按需要继续操作。

## 整体整理与重连

`rearrange` 只表达现有节点的最终入边，不同时编辑正文或创建节点。
所有 ref 和 fromRef 都取真实凭据对象的 ref 字符串；只需定位和凭据时可先用 meta。

例如将 A→B→C→D 改为 A→C→B→D：

```json
{
  "edits": [
    {
      "ref": "<C token>", "fromRef": "<A token>",
      "flow": "next", "description": "先比较适用范围"
    },
    {
      "ref": "<B token>", "fromRef": "<C token>",
      "flow": "next", "description": "比较后回到原结论"
    },
    {
      "ref": "<D token>", "fromRef": "<B token>",
      "flow": "next", "description": "后续仍承接该结论"
    }
  ]
}
```

```powershell
node "$cli" rearrange --input '<rearrange.json>' --workspace "$ws"
# stdin 是替代入口，不能与 --input 同时给出
Get-Content -Raw -Encoding utf8 '<rearrange.json>' |
  node "$cli" rearrange --input-stdin --workspace "$ws"
```

- ref 是被改接节点，fromRef 是最终来源，flow 只取 next／branch。
  branch 可另带 side／order；description 必须解释最终连接，不能残留旧边理由。
- 一个来源最多一个 next。目标位置被占时，把占位后继及其他需要换来源的节点
  一起纳入 edits，并各自给出最终位置；工具不隐式挤掉未声明节点。
- 服务在同一候选和事务里腾空、落位，中间状态不写盘，不制造临时旁支。
  过期哈希 412、占位冲突 409、成环或重复 next 422，失败不提交该批源修改。
- 成功后读 `result.editRefs[nodeId].ref`；重排的 `result.editRef` 为 null。
  新凭据只在返回时有效，未返回或刷新待完成时按实际状态重读。
  需要核对最终编号时读 structure，编号由程序派生。
- 单条无占位冲突的改接仍可用 connect；新节点插入已有 next 之前，
  当前需要先创建，再用 rearrange 落位，共两次提交。

## 重要标记与最近更新

节点自身的 `node.important` 表示值得回看，缺省 false。

```powershell
node "$cli" important --node '<nodeId>' --on --workspace "$ws"
node "$cli" important --ref '<真实 token>' --off --workspace "$ws"
```

- node 与 ref 二选一，on 与 off 二选一。
  `--node` 在命令内先在线读 meta，`--ref` 使用已有读取版本，冲突不偷偷补哈希。
- 标记不改变正文、编号或连接。取消会移除源文件中的 important 字段。
- 最近更新来自图接口 `lastChanges[topicId] = { at, nodeIds }`，普通 read 不返回。
  每主题保留最近一批最终真实写盘的内容节点，不累计每轮历史。
  读取、浏览、导出、被动重编号和单独改重要性不会替换该集合。
- 单独编辑旧节点、再创建新问题目前是两次提交，同主题最终只保留后一批更新标记。
  外部直接改文件也不产生这份标记，不能据此推断文件从未修改。

## 能力边界与底层命令

高层 CLI 当前没有独立的 insert、merge 或 delete 命令。
“整合正文”不等于“删除冗余节点”，rearrange 也不会自动合并正文。
需要底层操作时先核对当前变更 schema、真实旧哈希与授权，不能编造新命令。

| 命令 | 用途 |
| --- | --- |
| `check --input <json>` | 验证完整底层变更集合，不写盘 |
| `apply --input <json>` | 提交完整变更集合，包含真实旧哈希和固定 requestId |
| `status <requestId>` | 查询原请求状态；也可 `--input <原变更.json>` |

check／apply 的 JSON 与 rearrange 的 `{edits:[...]}` 不是同一种格式。
`--input-stdin` 目前只在 rearrange 提供，不能推广到 check／apply。
同一批修改只选择托管提交或直接编辑，直接编辑后按实际需要校验。

## 长文本与转义

长正文优先用 UTF-8 文件或 `--body-stdin`，不拼接多层 JSON 和命令行引号。
append-file 会插入段落分隔；replace-file 保存替换对，不把 JSON 再包成正文。

```powershell
Get-Content -Raw -Encoding utf8 '<正文.md>' |
  node "$cli" edit --ref '<token>' --body-stdin --workspace "$ws"
node "$cli" connect --ref '<token>' '--description=改得更“准确”的说明' --workspace "$ws"
```

PowerShell 使用 ASCII 引号包裹参数；含空格、弯引号或复杂内容时优先使用文件、
参数数组和字面量字符串，不把 JSON.stringify 的结果当作 shell 转义。
遇到未知选项先核对 stderr：命令可能在解析阶段就失败，不是保存后“没有更新”。

## 工作区、服务与错误

| 命令 | 用途 |
| --- | --- |
| `init <path> [--name <名称>]` | 初始化不存在的新目录，不覆盖已有库 |
| `serve --workspace <path> [--port <端口>]` | 启动本机服务，默认 127.0.0.1:4317 |
| `whoami --workspace <path>` | 核对描述文件、磁盘和实际服务身份 |

服务管理沿用用户授权；有同工作区服务时不启动第二个写进程。
端口冲突明确失败，不猜其他服务或自动切换工作区。

| 退出码 | 含义及处理 |
| --- | --- |
| 0 | 成功；写入还需看 result.state |
| 2 | 用法、输入、范围或预算错误；先修参数 |
| 3 | 工作区或 workspaceId 不一致 |
| 4 | 412 版本冲突，重读并重新判断 |
| 5 | 409 语义冲突，或 STALE_READ 续读失效 |
| 6 | 422 结构校验失败，或离线 validate 不通过 |
| 7 | 服务不可达、陈旧描述、服务身份不符或启动失败 |
| 8 | 写入结果未知，先查原 requestId 和源内容 |
| 9 | 非标准 HTTP 错误、端点缺失等 |
| 10 | 未预期内部错误，保留具体上下文 |
| 11 | 找不到节点、主题或文件 |

默认 JSON 模式的错误写到 stderr：
`{ok:false,error:{code,message,details?,diagnostics?,usage?}}`。
用法错误也返回 JSON，可能带 error.usage；`--text` 错误才是人类可读文本。
不要只凭退出码猜原因，同码下按 code、message 与 diagnostics 处理。

退出码 8 不换 requestId 盲目重发；status 的 unknown 既不证明成功也不证明失败。
服务重启后重新获取 editRef，不能靠手补哈希恢复旧凭据。
