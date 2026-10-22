# 命令速查

首次操作或遇到命令问题时阅读，不必每轮重读。入口和目标绑定见[工作区与目录职责](workspace.md)。

入口：`node "<aichat-cli>"`（工程内通常是 `dist/cli/index.js`）。默认输出 JSON；`--text` 为简短人类摘要。始终显式传 `--workspace "<工作区>"`，不要依赖默认当前目录。当前 CLI 的 `--help`／`<命令> --help` 是参数权威；本页保留常用操作与重要边界，不替代完整协议。

## 离线只读

| 命令 | 说明 |
| --- | --- |
| `topics` | 主题列表：topicId、title、真实入口文件、节点数、全部源文件哈希 |
| `search <词> [--topic <topicId>] [--limit 1-100] [--page n]` | 标题→摘要→正文优先级排序；默认 10 项；主题过滤后分页；给出节点真实路径与文件哈希 |
| `read <topicId\|相对路径>` | 读主题元数据与节点清单；不含节点正文 |
| `read --node <id> [--start n] [--length n] [--full] [--section 标题] [--section-index n] [--offline]` | 节点正文片段；默认 4000 UTF-16，上限 16000；`--full` 取全文 |
| `validate` | 校验磁盘结构与全图；失败时不给 graph |

`read --node` 输出要点：

- `range: { start, end, total, unit: "utf16" }`，左闭右开，不切断代理对。
- `truncated`：后面还有内容。
- `file`／`path`／`fileHash`：节点真实源文件与它的字节哈希（格式 2 是节点自己的文件）。
- 有服务时另有 `editRef`；离线时 `online.available=false` 并给原因，**不伪造凭据**。

先定位、读相关范围，再写入。同一轮可维护多个节点，但每次提交使用相应真实读取凭据。需要理解节点完整论证时用 `--full`，不因默认片段短就误以为正文已读完。

日常使用已绑定主题的稳定 ID：`search "<关键词>" --topic "<topicId>" --workspace "<工作区>"`。`topics` 用于解析用户给出的名称、目录和真实 ID，`read <topicId>` 用于核对节点归属；不要用全局 activeNode 或浏览器选中项决定写入主题。

## 在线写入

**格式边界（先看这条）**

| 工作区 | 读取 | 低摩擦写入 | 受控写入 | 转换 |
| --- | --- | --- | --- | --- |
| `schemaVersion: 2`（新默认） | 全部只读命令 | `edit` 片段／追加、`branch`、`next`、`connect`、`create-root` 可用；隔离主题库可 `create-topic` | `check`／`apply` 亦可 | — |
| `schemaVersion: 1`（兼容） | 全部只读命令 | **不可用**（`branch`／`next`／`connect`／`create-root`／`create-topic` 只面向格式 2；`edit` 仅接受整篇 `--body*`，片段／追加会 409） | `check`／`apply` 兼容 | 只在用户明确要求时 `migrate` 隔离生成新目录，**不自动迁移** |

格式由 `topics` 或 `validate` 输出里的 `schemaVersion` 给出，不要假设。"V1 能读"不等于"低摩擦写入口可用"。

**命令（格式 2）** — 均需要该工作区的 `serve`：

| 命令 | 必需 | 说明 |
| --- | --- | --- |
| `edit --ref <ref>` | 至少一项修改 | `--title`／`--state`／`--summary`／`--body*`／`--append-file`／`--replace-file` |
| `branch --from-ref <ref> --title <t> --description <why>` | 正文来源之一 | 横向旁支；默认同主题、右侧、proposed、order 由服务取 max+10 |
| `next --from-ref <ref> --title <t> --description <why>` | 正文来源之一 | 纵向后继；`flow: next`，不带 side／order；来源已有 next 时 409，不插队 |
| `connect --ref <ref> --description <why>` | `--description` | 结构字段全可选：`--from-ref`／`--flow`／`--side`／`--order`；只改描述也合法 |
| `create-root --topic-title <t> --title <t>` | 正文来源之一 | 仅格式 2 的空工作区；主题与根卡一次创建 |
| `create-topic --topic-title <t> [--directory <目录名>] [--title <首节点标题>]` | 正文来源之一 | 在格式 2 隔离主题库中创建新主题与独立 root；首节点标题默认主题名，目录为可选自命名单层目录 |
| `check --input <json>` | — | 只验证底层变更集合，不写盘（V1／V2 共用联合 schema） |
| `apply --input <json>` | — | 提交底层变更集合（V1／V2 共用联合 schema） |
| `status <requestId>` | — | 查询状态；unknown 不证明成功或失败 |

正文来源写法：`--body "短文本"`、`--body-file <路径>`、`--body-stdin`；追加用 `--append-file`，局部替换用 `--replace-file`（`[{old,new}]` 或 `{replace:[{old,new}]}`，`old` 必须非空且唯一匹配）。

```powershell
node "<aichat-cli>" edit --ref "<实际读取凭据>" --append-file "<补充正文.md>" --workspace "<工作区>"
node "<aichat-cli>" branch --from-ref "<实际读取凭据>" --title '输入分辨率改变后的处理' --description '从固定尺寸实例延伸到可变尺寸的网络设计' --body-file "<分支正文.md>" --workspace "<工作区>"
node "<aichat-cli>" create-topic --topic-title 'LeNet 学习' --directory 'lenet' --body-file "<首节点正文.md>" --workspace "<工作区>"
```

不自行生成 nodeId、路径、顺序、哈希或 requestId。托管提交已包含候选结构校验；核对返回结果即可，不要求每次再运行全图 `validate`。直接编辑源文件后、出现结构诊断或怀疑损坏时再校验。同一批修改只选托管提交或直接编辑。

用户明确要求记录新主题时可用 `create-topic`，不必先把整个工作区清空，也不把现有主题的 root 接到新主题。`--directory` 是单层目录名，不是任意路径；不自行创建目录或写元数据来绕过命令。旧 shared 库不自动切换主题模式；创建能力以实际 CLI 的帮助和诊断为准。

> PowerShell 提示：描述里出现中文弯引号（`“”`、`‘’`）时，别用外层双引号包住——PowerShell 会把这些字符当引号，参数被截成多段，CLI 报未知选项而不会写盘。用外层单引号，或干脆走文件：`--description` 之外的长文本用 `--body-file`／`--append-file`／`--replace-file`，整批变更用 `check`／`apply --input <json>`。
>
> ```powershell
> node <aichat-cli> connect --ref <editRef> '--description=改得更“准确”的说明' --workspace "<workspace>"
> ```
>
> 这类被截断的调用在 CLI 解析阶段就失败，不会产生部分写入，但会白跑一次。

## 工作区与服务

| 命令 | 说明 |
| --- | --- |
| `init <path> [--name n] [--format 1\|2]` | 新工作区；默认格式 2；目标已存在则拒绝 |
| `serve --workspace <path> [--port n]` | 默认 127.0.0.1:4317；端口占用明确失败 |
| `whoami` | 核对描述文件、服务与磁盘身份 |

## 迁移

| 命令 | 说明 |
| --- | --- |
| `migrate --source <v1> --destination <new> --preview` | 只计算、不写盘；只输出路径／字节／哈希与缺失 description |
| `migrate --source <v1> --destination <new> [--descriptions <json>]` | 目标必须不存在；发布前自检并全图校验 |

迁移始终隔离生成**新目录**：源保持只读，不原位置换，也不在你未明确要求时发生。缺失 `description` 时会拒绝发布并列出 nodeId，由维护者读源后补齐——不要用空话占位。

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
| 11 | 找不到节点／主题／文件 |

错误统一为 stderr 上的 `{ ok: false, error: { code, message, details?, diagnostics? } }`。

版本冲突后重新读取并重新判断，不能只取最新哈希让旧改动强行通过。语义冲突先检查当前结构，校验失败根据 diagnostics 修正内容。

退出码 8 时，先用原 requestId 查询 `status`，再核对源内容；未知既不证明成功也不证明失败，不换 requestId 盲目重发。服务重启后重新获取 editRef。服务不可达时可继续离线阅读与讨论；启动或直接写文件沿用用户已有授权，否则说明保存受阻。
