/**
 * CLI 命令单一来源：参数、约束、示例、结果字段与 help JSON 全部从这里派生。
 *
 * - parseCommandArgs 直接使用本表生成 parseOptions 的 OptionSpec，命令模块不再
 *   各写一份选项清单，避免"帮助与实际解析"漂移；
 * - 帮助文本与 help --json 也只是本表的渲染；
 * - 语义规则（原子性、凭据、批前 ref、局部名称等）写在 constraints／
 *   input.semanticNotes，不伪称 JSON Schema 能完整表达。
 */
import { parseOptions, type OptionSpec, type ParsedArgs } from "./args.js";
import { UsageError } from "./errors.js";
import { OUTPUT_OPTIONS, WORKSPACE_OPTION } from "./options.js";

export type CommandGroup = "read" | "write" | "workspace" | "meta";

export type ParameterType = "string" | "path" | "integer" | "enum" | "flag";

/** 一个命令参数（选项）；同时是 parseOptions 可消费的 OptionSpec。 */
export interface CommandParameter extends OptionSpec {
  readonly type: ParameterType;
  readonly valueName?: string;
  readonly required?: boolean;
  readonly defaultValue?: string | number;
  readonly values?: readonly string[];
  readonly description: string;
  /** 不能同时出现的参数名（不含 --）。 */
  readonly conflicts?: readonly string[];
  /** 必须与这些参数一起出现（不含 --）。 */
  readonly requires?: readonly string[];
}

export interface PositionalSpec {
  /** 例如 "<topicId|relative-path>"。 */
  readonly name: string;
  readonly required?: boolean;
  readonly description: string;
}

export interface JsonInputSpec {
  readonly kind: "json";
  readonly description: string;
  readonly schema: Record<string, unknown>;
  readonly semanticNotes: readonly string[];
}

export interface ResultSpec {
  readonly fields: readonly string[];
  readonly states?: readonly string[];
  readonly next?: readonly string[];
}

export interface CommandSpec {
  readonly name: string;
  readonly group: CommandGroup;
  readonly summary: string;
  /** 完整用法行，每行以 aichat 开头。 */
  readonly usage: readonly string[];
  readonly positionals?: readonly PositionalSpec[];
  readonly parameters: readonly CommandParameter[];
  /**
   * 互斥必填组：必须至少给出其中一项（如正文三选一）。
   * 单个参数的 required 只能表达"每个都要给"，这里补足"至少一个"的语义。
   */
  readonly requiredOneOf?: readonly (readonly string[])[];
  readonly input?: JsonInputSpec;
  readonly constraints: readonly string[];
  readonly examples: readonly string[];
  readonly result: ResultSpec;
}

/* ------------------------------------------------------------------ *
 * 公共参数（全 CLI 只在此定义一次）
 * ------------------------------------------------------------------ */

const WORKSPACE: CommandParameter = {
  ...WORKSPACE_OPTION,
  type: "path",
  valueName: "<path>",
  description: "工作区目录；省略时使用当前目录（serve 必须显式给出）",
};

const JSON_FLAG: CommandParameter = {
  ...OUTPUT_OPTIONS[0],
  type: "flag",
  description: "机器可读 JSON（默认输出）",
};

const TEXT_FLAG: CommandParameter = {
  ...OUTPUT_OPTIONS[1],
  type: "flag",
  description: "简短人类摘要",
};

const VERBOSE: CommandParameter = {
  name: "verbose",
  boolean: true,
  type: "flag",
  description:
    "输出服务地址／HTTP 状态／transactionId／journalCleaned／touchedFiles／created.paths 等详细诊断",
};

const OUTPUT_PARAMETERS = [JSON_FLAG, TEXT_FLAG] as const;

function stringParameter(
  name: string,
  description: string,
  extra: Partial<CommandParameter> = {},
): CommandParameter {
  return { name, type: "string", description, ...extra };
}

function integerParameter(
  name: string,
  description: string,
  extra: Partial<CommandParameter> = {},
): CommandParameter {
  return { name, type: "integer", description, ...extra };
}

function enumParameter(
  name: string,
  values: readonly string[],
  description: string,
  extra: Partial<CommandParameter> = {},
): CommandParameter {
  return { name, type: "enum", values, description, ...extra };
}

function booleanParameter(
  name: string,
  description: string,
  extra: Partial<CommandParameter> = {},
): CommandParameter {
  return { name, boolean: true, type: "flag", description, ...extra };
}

/** 正文来源：整篇／文件／stdin，三选一。 */
const BODY_SOURCE_PARAMETERS = [
  stringParameter("body", "内联正文（短正文；长正文请用 --body-file／--body-stdin）", {
    conflicts: ["body-file", "body-stdin", "append-file", "replace-file"],
  }),
  stringParameter("body-file", "从文件读取整篇正文", {
    valueName: "<file>",
    conflicts: ["body", "body-stdin", "append-file", "replace-file"],
  }),
  booleanParameter("body-stdin", "从 stdin 读取整篇正文", {
    conflicts: ["body", "body-file", "append-file", "replace-file"],
  }),
] as const;

const NODE_STATE_PARAMETER = enumParameter(
  "state",
  ["agreed", "proposed", "reference"],
  "节点状态：agreed 已定／proposed 提议／reference 参考",
);

/** create 系列：省略摘要时由正文首段派生。 */
const SUMMARY_PARAMETER = stringParameter(
  "summary",
  "卡片摘要；省略时由正文首段派生",
);

/** edit：摘要已经存在，不传时保持现状，不按正文重建。 */
const EDIT_SUMMARY_PARAMETER = stringParameter(
  "summary",
  "新摘要；不传则保持现有显式概述，不按正文重建",
);

const BRANCH_SIDE_PARAMETER = enumParameter(
  "side",
  ["left", "right"],
  "源记录保留的侧向元数据；当前前端统一向右，不影响落点",
);

const BRANCH_ORDER_PARAMETER = integerParameter("order", "同一来源下旁支排序值（非负整数）");

const WRITE_RESULT: ResultSpec = {
  fields: [
    "ok",
    "command",
    "workspaceId",
    "topicId",
    "requestId",
    "state",
    "revision",
    "changedNodeIds",
    "created.topicId",
    "created.nodeIds",
    "created.aliases",
    "refs",
    "diagnostics?",
    "replayed?",
    "summary?",
    "--verbose: httpStatus",
    "--verbose: service.url／instanceId／rootPath",
    "--verbose: transactionId",
    "--verbose: journalCleaned",
    "--verbose: touchedFiles",
    "--verbose: created.topicPath／paths",
  ],
  states: ["committed", "noop", "committed_refresh_pending"],
  next: [
    "aichat read --node <nodeId> --workspace <path>",
    "aichat status <requestId> --workspace <path>",
  ],
};

const WRITE_CONSTRAINTS = [
  "写入需要该工作区正在运行的服务（aichat serve），且服务接口版本必须与本 CLI 一致。",
  "已有节点的 ref 只能来自同一服务实例的在线读取；过期 ref 返回 412，整体不写盘。",
  "写入是原子的：唯一 next／成环／跨主题等结构错误返回 422（VALIDATION_FAILED）；占位／语义冲突返回 409（OPERATION_CONFLICT）；均不部分落盘。",
  "结果不明（超时／断线）返回 RESULT_UNKNOWN（退出码 8）：先 aichat status 查询，不要换 requestId 重发。",
] as const;

/* ------------------------------------------------------------------ *
 * batch 输入文件（CLI 层格式）
 * ------------------------------------------------------------------ */

/** 已有节点目标：协议只允许 {ref}，不能用局部名称指向已有目标。 */
const BATCH_TARGET_SCHEMA = {
  type: "object",
  required: ["ref"],
  additionalProperties: false,
  properties: {
    ref: { type: "string", description: "同一主题批前在线读取得到的 ref" },
  },
} as const;

/** 来源选择：ref 指向批前已有节点，local 指向本批 create（仅 create.from／connect.from 可用）。 */
const NODE_SELECTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ref: { type: "string", description: "同一主题批前在线读取得到的 ref" },
    local: { type: "string", description: "本批 create 的局部名称；只在本输入内有效" },
  },
  oneOf: [{ required: ["ref"] }, { required: ["local"] }],
} as const;

const REPLACE_ITEM_SCHEMA = {
  type: "object",
  required: ["old", "new"],
  additionalProperties: false,
  properties: {
    old: { type: "string", minLength: 1, description: "必须非空且在目标正文中恰好匹配一次" },
    new: { type: "string" },
  },
} as const;

const EDIT_PATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    state: { enum: ["agreed", "proposed", "reference"] },
    summary: { type: ["string", "null"], description: "null 表示移除显式摘要" },
    body: { type: "string", description: "整篇替换正文" },
    bodyFile: {
      type: "string",
      description: "CLI 读取文件内容作为 body（相对输入文件目录）；不发送给服务",
    },
    append: { type: "string", description: "追加片段" },
    appendFile: {
      type: "string",
      description: "CLI 读取文件内容作为 append（相对输入文件目录）；不发送给服务",
    },
    replace: { type: "array", minItems: 1, items: REPLACE_ITEM_SCHEMA },
    replaceFile: {
      type: "string",
      description: "CLI 读取 [{old,new}] 或 {replace:[...]} 作为 replace；不发送给服务",
    },
  },
} as const;

const BATCH_OPS_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    oneOf: [
      {
        type: "object",
        required: ["op", "target"],
        additionalProperties: false,
        properties: {
          op: { const: "edit" },
          target: BATCH_TARGET_SCHEMA,
          patch: EDIT_PATCH_SCHEMA,
        },
      },
      {
        type: "object",
        required: ["op", "as", "from", "flow", "title", "description"],
        additionalProperties: false,
        oneOf: [{ required: ["body"] }, { required: ["bodyFile"] }],
        properties: {
          op: { const: "create" },
          as: { type: "string", description: "本批唯一的局部名称" },
          from: NODE_SELECTOR_SCHEMA,
          flow: { enum: ["next", "branch"] },
          title: { type: "string" },
          body: { type: "string" },
          bodyFile: {
            type: "string",
            description: "CLI 读取文件内容作为 body（相对输入文件目录）；不发送给服务",
          },
          description: { type: "string" },
          summary: { type: "string" },
          state: { enum: ["agreed", "proposed", "reference"] },
          important: { type: "boolean" },
          side: { enum: ["left", "right"] },
          order: { type: "integer", minimum: 0 },
        },
      },
      {
        type: "object",
        required: ["op", "target", "description"],
        additionalProperties: false,
        properties: {
          op: { const: "connect" },
          target: BATCH_TARGET_SCHEMA,
          from: NODE_SELECTOR_SCHEMA,
          flow: { enum: ["next", "branch"] },
          description: { type: "string" },
          side: { enum: ["left", "right"] },
          order: { type: "integer", minimum: 0 },
        },
      },
      {
        type: "object",
        required: ["op", "target", "important"],
        additionalProperties: false,
        properties: {
          op: { const: "important" },
          target: BATCH_TARGET_SCHEMA,
          important: { type: "boolean" },
        },
      },
    ],
  },
} as const;

const BATCH_INPUT: JsonInputSpec = {
  kind: "json",
  description: "一次原子批次：一个已存在 topic 内的 edit／create／connect／important 操作清单。",
  schema: {
    type: "object",
    required: ["topicId", "ops"],
    additionalProperties: false,
    properties: {
      topicId: { type: "string", description: "已存在的稳定 topicId；本批不创建主题" },
      ops: BATCH_OPS_SCHEMA,
    },
  },
  semanticNotes: [
    "bodyFile／appendFile／replaceFile 只存在于 CLI 输入文件：由 aichat 读取并转成 body／append／replace 后发送，服务端不读本机路径。",
    "相对路径基准：--input 为输入文件所在目录；--input-stdin 为调用时 cwd。",
    "同一正文模式最多一个来源（body 与 bodyFile、append 与 appendFile、replace 与 replaceFile 分别互斥），三种模式之间也互斥。",
    "所有已有节点 ref 按批前一次在线读取解释；任一 ref 过期则整体 412，不部分写入。",
    "edit／connect／important 的 target 只能是 {ref}（已有节点）；local 只出现在 create.from 与 connect.from，用于引用本批 create。",
    "local 只在本次输入内有效且必须唯一；create 可以按 local 前向引用本批其他 create。",
    "create 的 body 与 bodyFile 恰好给一个；edit.patch 的 body／append／replace 三种正文模式互斥，每个模式最多一个来源。",
    "一批只提交一次事务；同 requestId 重放返回原响应（含 aliases／refs），不会重复创建。",
    "唯一 next／成环／跨主题等结构错误整体 422（VALIDATION_FAILED）；占位／语义冲突整体 409（OPERATION_CONFLICT）；源文件不变；CLI 不自动改写调用方给出的关系。",
    "append 的空白规范化由 storage 统一处理；CLI 不再自行前置空行。",
    "dry-run 只检查并返回文件清单：不写盘、不写 agentLog、不更新 lastChanges。",
  ],
};

/* ------------------------------------------------------------------ *
 * 命令表
 * ------------------------------------------------------------------ */

const COMMANDS: readonly CommandSpec[] = [
  /* -------------------------------- read -------------------------------- */
  {
    name: "topics",
    group: "read",
    summary: "列出工作区内的主题（一节点一份 Markdown 的分组结果）。",
    usage: ["aichat topics --workspace <path> [--json|--text]"],
    parameters: [WORKSPACE, ...OUTPUT_PARAMETERS],
    constraints: [
      "只读磁盘；不读取服务缓存快照。",
      "没有主题的合法工作区返回空数组并以 0 退出。",
    ],
    examples: ["aichat topics --workspace .", "aichat topics --workspace D:/notes --json"],
    result: {
      fields: [
        "ok",
        "command",
        "source",
        "root",
        "schemaVersion",
        "workspace",
        "topics[].topicId",
        "topics[].title",
        "topics[].dir",
        "topics[].path",
        "topics[].nodeCount",
        "topicCount",
        "diagnostics",
      ],
      next: ["aichat read <topicId> --workspace <path>"],
    },
  },
  {
    name: "search",
    group: "read",
    summary: "按标题、摘要、正文搜索节点；从磁盘扫描。",
    usage: [
      "aichat search <query> --workspace <path> [--topic <topicId>] [--limit <1-100>] [--page <n>]",
    ],
    positionals: [
      { name: "<query>", required: true, description: "搜索词（必填）" },
    ],
    parameters: [
      WORKSPACE,
      stringParameter("topic", "限定到某个稳定 topicId"),
      integerParameter("limit", "每页条数，默认 10，最大 100", {
        defaultValue: 10,
      }),
      integerParameter("page", "0 起的页码，默认 0", { defaultValue: 0 }),
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "排序规则由 index/search 统一裁决：标题 > 摘要 > 正文。",
      "只搜索当前磁盘扫描结果；不读服务缓存。",
    ],
    examples: [
      "aichat search 记录 --workspace .",
      "aichat search 记录 --workspace . --limit 20 --page 1",
    ],
    result: {
      fields: [
        "ok",
        "command",
        "source",
        "root",
        "query",
        "hits[].nodeId",
        "hits[].topicId",
        "hits[].title",
        "hits[].path",
        "hits[].snippet",
        "hits[].field",
        "hits[].fileHash",
        "page",
        "limit",
        "totalHits",
        "hasMore",
        "truncated",
        "diagnostics",
      ],
      next: [
        "aichat read --node <nodeId> --workspace <path>",
        "aichat search <query> --page <n+1> --workspace <path>",
      ],
    },
  },
  {
    name: "read",
    group: "read",
    summary:
      "渐进读取：主题概览／结构，或按 node 读取正文片段；在线优先，服务不可用时读磁盘。",
    usage: [
      "aichat read <topicId|relative-path> --workspace <path> [--view overview|structure] [--from <nodeId>]",
      "aichat read --topic <topicId|relative-path> --workspace <path>",
      "aichat read --node <nodeId> [--node <nodeId> ...] [--budget <1-1000000>] [--offline]",
      "           [--start <n>] [--length <1-16000>|--full]",
      "aichat read --node <nodeId> ... [--from-heading <标题> [--occurrence <n>]]",
      "           [--budget <1-1000000>] [--offline]",
      "aichat read --node <nodeId> ... --meta [--budget <1-1000000>] [--offline]",
      "           （--meta 不能与 start／length／full／from-heading／occurrence 同用）",
      "aichat read --cursor <token> [--budget <1-1000000>] [--offline]",
    ],
    positionals: [
      {
        name: "<topicId|relative-path>",
        required: false,
        description: "主题稳定 ID 或 topic.md 的相对入口路径；不能与 --node 同用",
      },
    ],
    parameters: [
      WORKSPACE,
      stringParameter("topic", "主题稳定 ID 或相对入口路径（与位置参数二选一）", {
        conflicts: ["cursor"],
      }),
      stringParameter("node", "要读取正文的节点 ID；可重复", {
        repeatable: true,
        conflicts: ["cursor"],
      }),
      enumParameter("view", ["overview", "structure", "content"], "读取视图，默认由参数推导", {
        conflicts: ["cursor"],
      }),
      stringParameter("from", "structure 读取的子树起点 nodeId", { conflicts: ["cursor"] }),
      integerParameter("budget", "整次响应 UTF-16 预算，默认 12000，最大 1000000", {
        defaultValue: 12000,
      }),
      stringParameter("cursor", "上一页 page.next 续读标记；只可另带 --budget／--offline", {
        conflicts: [
          "topic",
          "node",
          "view",
          "from",
          "start",
          "length",
          "full",
          "from-heading",
          "occurrence",
          "meta",
        ],
      }),
      integerParameter("start", "起始 UTF-16 偏移（0 起）", { conflicts: ["cursor"] }),
      integerParameter("length", "片段长度（1-16000）", { conflicts: ["cursor"] }),
      booleanParameter("full", "返回整段正文；与 --length 互斥", {
        conflicts: ["length", "cursor"],
      }),
      stringParameter(
        "from-heading",
        "从正文标题定位起点（不含 # 号；重名时配合 --occurrence）",
        { conflicts: ["cursor"] },
      ),
      integerParameter("occurrence", "同名标题中的第几个（0 起），只能与 --from-heading 同用", {
        requires: ["from-heading"],
        conflicts: ["cursor"],
      }),
      booleanParameter("meta", "只返回元数据（不含正文）；不能与其他正文参数同用", {
        conflicts: ["start", "length", "full", "from-heading", "occurrence", "cursor"],
      }),
      booleanParameter("offline", "只读磁盘，不联系服务"),
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "默认 read <topic> 是 overview；read --node 默认 content；--from 默认 structure。",
      "在线读取返回顶层 refs（nodeId → 不透明凭据），写入命令的 --ref 来自这里。",
      "离线读取 refs 为 {}，不能用于写入；online.reason 说明离线原因。",
      "budget.used 等于原始 stdout（紧凑 JSON + 换行）长度；分页走 page.next 的 --cursor。",
      "--from-heading／--occurrence 映射到服务的 section／section-index；--occurrence 从 0 起。",
      "content 的 item 不再内嵌 editRef，读取后直接 refs[node.id]。",
    ],
    examples: [
      "aichat read . --workspace D:/notes",
      "aichat read --node n_0123456789abcdef0123456789abcdef --workspace .",
      'aichat read --node n_... --from-heading "第二节" --occurrence 0 --workspace .',
      'aichat read --cursor "<page.next>" --budget 20000 --workspace .',
    ],
    result: {
      fields: [
        "ok",
        "command",
        "source",
        "root",
        "online",
        "workspaceId",
        "view",
        "topicId",
        "topicTitle",
        "scope",
        "items",
        "boundaries?",
        "page.hasMore",
        "page.next?",
        "budget",
        "fingerprint",
        "refs",
      ],
      next: [
        "aichat read --cursor <page.next> --budget <n> --workspace <path>",
        "aichat read --node <nodeId> --workspace <path>",
        "aichat read <topicId> --view structure --from <nodeId> --workspace <path>",
      ],
    },
  },
  {
    name: "validate",
    group: "read",
    summary: "校验磁盘结构、工作区元数据与全图约束。",
    usage: ["aichat validate --workspace <path> [--json|--text]"],
    parameters: [WORKSPACE, ...OUTPUT_PARAMETERS],
    constraints: [
      "只读磁盘；不读取服务缓存快照。",
      "图无效时 graph 为 null 且 graphSkipped=true，不用过滤后的残缺图冒充有效。",
    ],
    examples: ["aichat validate --workspace ."],
    result: {
      fields: [
        "ok",
        "command",
        "source",
        "root",
        "schemaVersion",
        "workspace",
        "topics",
        "storageDiagnostics",
        "diagnostics",
        "graphSkipped",
        "graph",
      ],
      states: ["valid", "invalid"],
      next: ["按 diagnostics 修复源文件后重新运行 aichat validate"],
    },
  },

  /* -------------------------------- write ------------------------------- */
  {
    name: "edit",
    group: "write",
    summary: "按在线读取得到的 ref 原位修改一张卡片（标题／状态／摘要／正文）。",
    usage: [
      "aichat edit --ref <ref> [--title <t>] [--state agreed|proposed|reference] [--summary <s>]",
      "            [--body <text>|--body-file <file>|--body-stdin]",
      "            [--append-file <file>|--replace-file <json>] [--workspace <path>] [--verbose]",
    ],
    requiredOneOf: [
      ["title", "state", "summary", "body", "body-file", "body-stdin", "append-file", "replace-file"],
    ],
    parameters: [
      WORKSPACE,
      stringParameter("ref", "节点凭据；来自 read 顶层 refs[nodeId]", { required: true }),
      stringParameter("title", "新标题"),
      NODE_STATE_PARAMETER,
      EDIT_SUMMARY_PARAMETER,
      ...BODY_SOURCE_PARAMETERS,
      stringParameter("append-file", "追加片段文件；内容追加到正文末尾", {
        valueName: "<file>",
        conflicts: ["body", "body-file", "body-stdin", "replace-file"],
      }),
      stringParameter("replace-file", "局部替换 JSON：[{old,new}] 或 {replace:[...]}", {
        valueName: "<json>",
        conflicts: ["body", "body-file", "body-stdin", "append-file"],
      }),
      VERBOSE,
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "至少给出 title／state／summary／body 系列／append-file／replace-file 中一项修改。",
      "整篇替换、追加、局部替换三种正文模式互斥；append 的空白规范化由 storage 统一处理。",
      "replace-file 的 old 必须非空且唯一匹配；不提供全局替换。",
      ...WRITE_CONSTRAINTS,
    ],
    examples: [
      'aichat edit --ref <ref> --append-file 补充.md --workspace .',
      'aichat edit --ref <ref> --title "新的标题" --state agreed --workspace .',
    ],
    result: WRITE_RESULT,
  },
  {
    name: "branch",
    group: "write",
    summary: "从来源节点新建一张旁支卡片（flow=branch），并写明为什么接在这里。",
    usage: [
      "aichat branch --from-ref <ref> --title <t> --description <why>",
      "               (--body <text>|--body-file <file>|--body-stdin)",
      "               [--summary <s>] [--state ...] [--side left|right] [--order <n>]",
      "               [--workspace <path>] [--verbose]",
    ],
    requiredOneOf: [["body", "body-file", "body-stdin"]],
    parameters: [
      WORKSPACE,
      stringParameter("from-ref", "来源节点凭据", { required: true }),
      stringParameter("title", "新卡片标题", { required: true }),
      stringParameter("description", "为什么接到来源（非空单行说明）", { required: true }),
      NODE_STATE_PARAMETER,
      SUMMARY_PARAMETER,
      BRANCH_SIDE_PARAMETER,
      BRANCH_ORDER_PARAMETER,
      ...BODY_SOURCE_PARAMETERS,
      VERBOSE,
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "正文必须给出：--body／--body-file／--body-stdin 三选一。",
      "side／order 只影响同一来源下的旁支顺序；不改变主线 next。",
      ...WRITE_CONSTRAINTS,
    ],
    examples: [
      'aichat branch --from-ref <ref> --title "旁支" --description "记录另一个方向" --body-stdin --workspace .',
    ],
    result: WRITE_RESULT,
  },
  {
    name: "next",
    group: "write",
    summary: "在来源节点之后纵向续写一张卡片（flow=next）；来源已有 next 时明确冲突。",
    usage: [
      "aichat next --from-ref <ref> --title <t> --description <why>",
      "             (--body <text>|--body-file <file>|--body-stdin)",
      "             [--summary <s>] [--state ...] [--topic-id <topicId>] [--workspace <path>] [--verbose]",
    ],
    requiredOneOf: [["body", "body-file", "body-stdin"]],
    parameters: [
      WORKSPACE,
      stringParameter("from-ref", "上一张卡片的凭据", { required: true }),
      stringParameter("title", "新卡片标题", { required: true }),
      stringParameter("description", "为什么在这条线继续（非空单行说明）", { required: true }),
      NODE_STATE_PARAMETER,
      SUMMARY_PARAMETER,
      stringParameter("topic-id", "显式主题 ID；默认沿用来源所属主题"),
      ...BODY_SOURCE_PARAMETERS,
      VERBOSE,
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "正文必须给出：--body／--body-file／--body-stdin 三选一。",
      "来源已有 next 时服务返回 409；不会自动挤掉旧主线，也不替调用方决定插入位置。",
      "需要插入到中间时使用 insert。",
      ...WRITE_CONSTRAINTS,
    ],
    examples: [
      'aichat next --from-ref <ref> --title "下一步" --description "继续追问" --body-stdin --workspace .',
    ],
    result: WRITE_RESULT,
  },
  {
    name: "connect",
    group: "write",
    summary: "修改一张卡片接到的来源／flow／side／order 与连接说明。",
    usage: [
      "aichat connect --ref <ref> --description <why>",
      "                [--from-ref <ref>] [--flow next|branch] [--side left|right] [--order <n>]",
      "                [--workspace <path>] [--verbose]",
    ],
    parameters: [
      WORKSPACE,
      stringParameter("ref", "目标节点凭据", { required: true }),
      stringParameter("description", "最终连接说明（必填；可以只改说明）", { required: true }),
      stringParameter("from-ref", "新的来源节点凭据"),
      enumParameter("flow", ["next", "branch"], "新的连接角色；root 不可改接，只允许 next／branch"),
      BRANCH_SIDE_PARAMETER,
      BRANCH_ORDER_PARAMETER,
      VERBOSE,
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "只改说明时也必须给出 --description（连接语义的一部分）。",
      "root 节点不允许改接；--flow 只接受 next／branch。",
      "flow=next 时不能带 side／order；完整重排多处入边用 rearrange。",
      ...WRITE_CONSTRAINTS,
    ],
    examples: [
      'aichat connect --ref <ref> --from-ref <other-ref> --flow branch --description "改接到这里更准确" --workspace .',
    ],
    result: WRITE_RESULT,
  },
  {
    name: "insert",
    group: "write",
    summary: "在 after 与 before 两张当前相邻卡片之间插入一张新卡片。",
    usage: [
      "aichat insert --after-ref <ref> --before-ref <ref> --title <t>",
      "               --description <after→新卡> --next-description <新卡→before>",
      "               (--body <text>|--body-file <file>|--body-stdin)",
      "               [--summary <s>] [--state ...] [--workspace <path>] [--verbose]",
    ],
    requiredOneOf: [["body", "body-file", "body-stdin"]],
    parameters: [
      WORKSPACE,
      stringParameter("after-ref", "前一张卡片凭据", { required: true }),
      stringParameter("before-ref", "后一张卡片凭据（当前必须是 after 的真实 next）", {
        required: true,
      }),
      stringParameter("title", "新卡片标题", { required: true }),
      stringParameter("description", "after 到新卡的连接说明", { required: true }),
      stringParameter("next-description", "新卡到 before 的连接说明", { required: true }),
      NODE_STATE_PARAMETER,
      SUMMARY_PARAMETER,
      ...BODY_SOURCE_PARAMETERS,
      VERBOSE,
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "正文必须给出：--body／--body-file／--body-stdin 三选一。",
      "入口先验证 after 与 before 是当前真实相邻 next（after.nextId === before.id、同主题）；非相邻整体 409（操作冲突），不降级、不重排。",
      "插入编译成 create N from after next + connect before from N next，一次事务提交，不落临时旁支。",
      "after／before 凭据必须来自同一服务实例的在线读取；过期凭据返回 412。",
      ...WRITE_CONSTRAINTS,
    ],
    examples: [
      'aichat insert --after-ref <refA> --before-ref <refB> --title "补一问" --description "先追问这一点" --next-description "再回到原问题" --body-stdin --workspace .',
    ],
    result: WRITE_RESULT,
  },
  {
    name: "batch",
    group: "write",
    summary: "一次原子提交同一主题内的多节点 edit／create／connect／important。",
    usage: [
      "aichat batch (--input <file.json>|--input-stdin) [--dry-run] [--workspace <path>] [--verbose]",
    ],
    parameters: [
      WORKSPACE,
      stringParameter("input", "批次 JSON 文件路径", {
        valueName: "<file.json>",
        conflicts: ["input-stdin"],
      }),
      booleanParameter("input-stdin", "从 stdin 读取批次 JSON", { conflicts: ["input"] }),
      booleanParameter("dry-run", "只检查并返回将改动的文件清单；不写盘"),
      VERBOSE,
      ...OUTPUT_PARAMETERS,
    ],
    input: BATCH_INPUT,
    constraints: [
      "--input 与 --input-stdin 必须且只能给一个。",
      "输入限定一个已存在 topic；不创建主题、不跨主题。",
      "已有节点的 ref 全部按批前快照解释；同节点可分别 edit／connect／important，但同类操作不能重复。",
      "一批只 commit 一次；结构错误 422、占位／语义冲突 409、过期 ref 412，均整体拒绝、不部分落盘。",
      ...WRITE_CONSTRAINTS,
    ],
    examples: [
      "aichat batch --input batch.json --workspace .",
      "aichat batch --input-stdin --dry-run --workspace . < batch.json",
    ],
    result: {
      fields: [
        "ok",
        "command",
        "workspaceId",
        "topicId",
        "requestId",
        "state",
        "revision",
        "changedNodeIds",
        "created.topicId",
        "created.nodeIds",
        "created.aliases",
        "refs",
        "diagnostics?",
        "replayed?",
        "summary?",
        "--dry-run: dryRun",
        "--dry-run: state=checked",
        "--dry-run: summary",
        "--dry-run: files[].path／beforeSha256／nextSha256／deleted",
        "--verbose: httpStatus／service／transactionId／journalCleaned／touchedFiles／created.paths",
      ],
      states: ["committed", "noop", "committed_refresh_pending", "checked"],
      next: [
        "aichat read --node <nodeId> --workspace <path>",
        "aichat status <requestId> --workspace <path>",
      ],
    },
  },
  {
    name: "rearrange",
    group: "write",
    summary: "一次提交多处最终入边；服务端同批安全排序后只 commit 一次。",
    usage: [
      "aichat rearrange (--input <spec.json>|--input-stdin) [--workspace <path>] [--verbose]",
    ],
    parameters: [
      WORKSPACE,
      stringParameter("input", "重排 JSON 文件路径", {
        valueName: "<spec.json>",
        conflicts: ["input-stdin"],
      }),
      booleanParameter("input-stdin", "从 stdin 读取重排 JSON", { conflicts: ["input"] }),
      VERBOSE,
      ...OUTPUT_PARAMETERS,
    ],
    input: {
      kind: "json",
      description: "每项给出节点的最终来源、flow 与连接说明。",
      schema: {
        type: "object",
        required: ["edits"],
        additionalProperties: false,
        properties: {
          edits: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["ref", "fromRef", "flow", "description"],
              additionalProperties: false,
              properties: {
                ref: { type: "string" },
                fromRef: { type: "string" },
                flow: { enum: ["next", "branch"] },
                description: { type: "string" },
                side: { enum: ["left", "right"] },
                order: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
      semanticNotes: [
        "每项只写最终关系与说明，不写 requestId／expectedFiles。",
        "side／order 只允许 flow=branch；服务端在同一批候选里先腾空再落位。",
        "所有 ref 按批前在线读取解释；过期 ref 412，结构错误 422，占位／语义冲突 409，均整体拒绝。",
      ],
    },
    constraints: [
      "调用方只写最终关系，不手工排序中间状态。",
      "一批只 commit 一次；结构错误 422、占位／语义冲突 409，均整体拒绝。",
      ...WRITE_CONSTRAINTS,
    ],
    examples: ["aichat rearrange --input rearrange.json --workspace ."],
    result: WRITE_RESULT,
  },
  {
    name: "important",
    group: "write",
    summary: "设置或取消一张卡片的重要标记。",
    usage: [
      "aichat important (--ref <ref>|--node <nodeId>) (--on|--off) [--workspace <path>] [--verbose]",
    ],
    parameters: [
      WORKSPACE,
      stringParameter("ref", "节点凭据；与 --node 二选一"),
      stringParameter("node", "节点 ID；先在线读取取得凭据，与 --ref 二选一"),
      booleanParameter("on", "设为重要；与 --off 二选一"),
      booleanParameter("off", "取消重要；与 --on 二选一"),
      VERBOSE,
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "--ref 与 --node 必须且只能给一个。",
      "--on 与 --off 必须且只能给一个。",
      "只翻转重要标记，不改变编号、连接或正文。",
      ...WRITE_CONSTRAINTS,
    ],
    examples: ["aichat important --node n_... --on --workspace ."],
    result: WRITE_RESULT,
  },
  {
    name: "create-topic",
    group: "write",
    summary: "创建独立主题（isolated）及其实例起点。",
    usage: [
      "aichat create-topic --topic-title <t> [--directory <单层目录>] [--title <t>]",
      "                     (--body <text>|--body-file <file>|--body-stdin)",
      "                     [--summary <s>] [--state ...] [--workspace <path>] [--verbose]",
    ],
    requiredOneOf: [["body", "body-file", "body-stdin"]],
    parameters: [
      WORKSPACE,
      stringParameter("topic-title", "新主题标题", { required: true }),
      stringParameter("directory", "主题目录名（单层）；默认由标题派生", { valueName: "<name>" }),
      stringParameter("title", "起点卡片标题；默认同 --topic-title"),
      NODE_STATE_PARAMETER,
      SUMMARY_PARAMETER,
      ...BODY_SOURCE_PARAMETERS,
      VERBOSE,
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "正文必须给出：--body／--body-file／--body-stdin 三选一。",
      "只创建新主题，不接入已有主题。",
      "目录碰撞或标题不合法时拒绝，不覆盖已有目录。",
      ...WRITE_CONSTRAINTS,
    ],
    examples: [
      'aichat create-topic --topic-title "新主题" --body "起点正文" --workspace .',
    ],
    result: WRITE_RESULT,
  },
  {
    name: "create-root",
    group: "write",
    summary: "为空工作区建立第一个主题与起点（root）卡片；只用于尚无内容的工作区。",
    usage: [
      "aichat create-root --topic-title <t> --title <t>",
      "                    (--body <text>|--body-file <file>|--body-stdin)",
      "                    [--summary <s>] [--state ...] [--workspace <path>] [--verbose]",
    ],
    requiredOneOf: [["body", "body-file", "body-stdin"]],
    parameters: [
      WORKSPACE,
      stringParameter("topic-title", "新主题标题；目录自动派生（工作区必须尚无任何节点）", {
        required: true,
      }),
      stringParameter("title", "起点卡片标题", { required: true }),
      NODE_STATE_PARAMETER,
      SUMMARY_PARAMETER,
      ...BODY_SOURCE_PARAMETERS,
      VERBOSE,
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "正文必须给出：--body／--body-file／--body-stdin 三选一。",
      "create-root 只用于空工作区：工作区已有任何节点（含已有根）时返回 409（OPERATION_CONFLICT），不会给已有主题加第二根。",
      "一次创建「新主题 + 它的 root 节点」；后续内容用 branch／next／insert／batch。",
      "标题或派生目录格式不合法返回 422（VALIDATION_FAILED）。",
      ...WRITE_CONSTRAINTS,
    ],
    examples: [
      'aichat create-root --topic-title "条目整理" --title "新的起点" --body-stdin --workspace .',
    ],
    result: WRITE_RESULT,
  },

  /* ----------------------------- workspace/service ---------------------- */
  {
    name: "init",
    group: "workspace",
    summary: "新建一个工作区（不覆盖已有目录）。",
    usage: ["aichat init <path> [--name <name>] [--json|--text]"],
    positionals: [
      { name: "<path>", required: false, description: "新工作区目录；也可用 --workspace 给出一次" },
    ],
    parameters: [
      stringParameter("name", "工作区显示名；默认取目录名"),
      WORKSPACE,
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "目标目录已存在时拒绝，不覆盖任何文件。",
      "路径只能给出一次（位置参数或 --workspace）。",
    ],
    examples: ["aichat init D:/notes --name 思路库"],
    result: {
      fields: ["ok", "command", "root", "workspaceId", "schemaVersion", "name", "files"],
      next: ["aichat serve --workspace <path>", "aichat topics --workspace <path>"],
    },
  },
  {
    name: "serve",
    group: "workspace",
    summary: "为指定工作区启动本机服务（默认 127.0.0.1:4317）。",
    usage: ["aichat serve --workspace <path> [--port <1-65535>] [--json|--text]"],
    parameters: [
      WORKSPACE,
      integerParameter("port", "监听端口；默认 4317", { defaultValue: 4317 }),
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "必须显式给出 --workspace（不默认当前目录）。",
      "服务把描述文件写到 <root>/.aichat/runtime/service.json。",
    ],
    examples: ["aichat serve --workspace D:/notes"],
    result: {
      fields: ["ok", "command", "url", "workspaceId", "instanceId", "rootPath", "port", "pid", "state"],
      states: ["serving", "stopped"],
      next: ["aichat topics --workspace <path>"],
    },
  },
  {
    name: "whoami",
    group: "workspace",
    summary:
      "核对 CLI、服务、描述文件与磁盘身份，并报告接口兼容性与构建是否一致。",
    usage: ["aichat whoami --workspace <path> [--json|--text]"],
    parameters: [WORKSPACE, ...OUTPUT_PARAMETERS],
    constraints: [
      "接口版本缺失或不匹配时仍完成诊断（不因此抛错）；普通命令在 resolve 阶段报 INTERFACE_MISMATCH（退出码 7）。",
      "报告本 CLI program、服务 program、interface.compatible、build.same、descriptor／identity／diskWorkspaceId。",
      "不猜其他程序路径、不自动切换服务或工作区。",
    ],
    examples: ["aichat whoami --workspace ."],
    result: {
      fields: [
        "ok",
        "command",
        "root",
        "url",
        "cli",
        "service",
        "interface.expected",
        "interface.actual",
        "interface.compatible",
        "build.same",
        "descriptor",
        "identity",
        "diskWorkspaceId",
      ],
      next: ["接口不匹配时重新构建并重启服务，再运行 aichat whoami"],
    },
  },
  {
    name: "status",
    group: "workspace",
    summary: "查询一次写入请求的状态；unknown 不证明成功或失败。",
    usage: ["aichat status <requestId> --workspace <path> [--json|--text]"],
    positionals: [
      { name: "<requestId>", required: false, description: "写入请求的 UUID；也可用 --input 指定 ChangeRequest 文件" },
    ],
    parameters: [
      WORKSPACE,
      stringParameter("input", "从 ChangeRequest JSON 读取 requestId", {
        valueName: "<json>",
        conflicts: ["request-id"],
      }),
      stringParameter("request-id", "requestId（与位置参数二选一）", {
        conflicts: ["input"],
      }),
      ...OUTPUT_PARAMETERS,
    ],
    constraints: [
      "state=unknown 表示服务没有该记录，不要据此推断写入一定成功或一定失败。",
      "只读查询，不重发写请求。",
    ],
    examples: ["aichat status <requestId> --workspace ."],
    result: {
      fields: ["ok", "command", "requestId", "state", "known", "httpStatus", "status", "service"],
      states: ["committed", "noop", "committed_refresh_pending", "unknown"],
    },
  },
  {
    name: "check",
    group: "workspace",
    summary: "只验证一次底层变更集合，不写盘。",
    usage: ["aichat check --input <json> --workspace <path> [--json|--text]"],
    parameters: [
      WORKSPACE,
      stringParameter("input", "ChangeRequest JSON 文件", { valueName: "<json>", required: true }),
      ...OUTPUT_PARAMETERS,
    ],
    input: {
      kind: "json",
      description: "底层 ChangeRequest（workspaceId／requestId／expectedFiles／operations）。",
      schema: {
        type: "object",
        required: ["workspaceId", "requestId", "expectedFiles", "operations"],
        properties: {
          workspaceId: { type: "string" },
          requestId: { type: "string", format: "uuid" },
          expectedFiles: {
            type: "object",
            additionalProperties: { type: ["string", "null"] },
            description: "相对路径 → 批前真实文件哈希；新文件为 null",
          },
          operations: { type: "array" },
        },
      },
      semanticNotes: [
        "CLI 原样发送文件文本，不补 expectedFiles 哈希、不改写 workspaceId。",
        "普通维护优先使用 edit／batch／insert；check／apply 用于显式复杂变更或排查。",
      ],
    },
    constraints: [
      "只验证不落盘；不写 agentLog、不更新 lastChanges。",
      "requestId 相同且请求体相同时，服务按幂等返回原结果。",
    ],
    examples: ["aichat check --input request.json --workspace ."],
    result: {
      fields: ["ok", "command", "requestId", "httpStatus", "service", "result"],
      states: ["checked", "committed", "noop"],
    },
  },
  {
    name: "apply",
    group: "workspace",
    summary: "提交一次底层变更集合（须带真实旧哈希）。",
    usage: ["aichat apply --input <json> --workspace <path> [--json|--text]"],
    parameters: [
      WORKSPACE,
      stringParameter("input", "ChangeRequest JSON 文件", { valueName: "<json>", required: true }),
      ...OUTPUT_PARAMETERS,
    ],
    input: {
      kind: "json",
      description: "底层 ChangeRequest（workspaceId／requestId／expectedFiles／operations）。",
      schema: {
        type: "object",
        required: ["workspaceId", "requestId", "expectedFiles", "operations"],
        properties: {
          workspaceId: { type: "string" },
          requestId: { type: "string", format: "uuid" },
          expectedFiles: {
            type: "object",
            additionalProperties: { type: ["string", "null"] },
            description: "相对路径 → 批前真实文件哈希；新文件为 null",
          },
          operations: { type: "array" },
        },
      },
      semanticNotes: [
        "expectedFiles 必须是调用方实际读到的旧哈希；过期返回 412 且不覆盖。",
        "普通维护优先使用 edit／batch／insert；apply 是底层通道。",
      ],
    },
    constraints: [
      "旧哈希过期（412）时整体不写盘。",
      "结果不明时先 aichat status 查询，不换 requestId 重发。",
    ],
    examples: ["aichat apply --input request.json --workspace ."],
    result: {
      fields: ["ok", "command", "requestId", "httpStatus", "service", "result"],
      states: ["committed", "noop", "committed_refresh_pending"],
    },
  },

  /* --------------------------------- meta ------------------------------- */
  {
    name: "help",
    group: "meta",
    summary: "显示分组帮助或单命令机器说明；不访问工作区与服务。",
    usage: [
      "aichat --help",
      "aichat <command> --help",
      "aichat help <command>",
      "aichat help <command> --json",
      "aichat help --json",
    ],
    positionals: [
      { name: "<command>", required: false, description: "要查看的命令名；省略时显示总目录" },
    ],
    parameters: [JSON_FLAG, TEXT_FLAG],
    constraints: [
      "帮助是纯本地信息：不解析 --workspace、不连接服务、不需要有效工作区。",
      "未知命令明确失败（退出码 2），不输出半份帮助。",
      "单命令帮助只包含该命令，不附带整份命令大全。",
    ],
    examples: ["aichat --help", "aichat batch --help", "aichat help batch --json"],
    result: {
      fields: [
        "ok",
        "command",
        "group",
        "interfaceVersion",
        "programVersion",
        "summary",
        "usage",
        "parameters",
        "input?",
        "constraints",
        "examples",
        "result",
      ],
      next: ["aichat help <command> --json", "aichat --help"],
    },
  },
  {
    name: "version",
    group: "meta",
    summary: "输出版本、接口版本与构建身份；不访问工作区与服务。",
    usage: ["aichat version [--json|--text]", "aichat --version", "aichat -V"],
    parameters: [...OUTPUT_PARAMETERS],
    constraints: [
      "构建信息缺失时回退 package 版本并标记 manifest=dev；损坏时 manifest=invalid，不抛不可诊断异常。",
      "接口版本固定为 2；与服务的接口不匹配时由 resolve 阶段报 INTERFACE_MISMATCH。",
    ],
    examples: ["aichat --version", "aichat version --json"],
    result: {
      fields: [
        "ok",
        "command",
        "program.name",
        "program.version",
        "program.interfaceVersion",
        "program.buildId",
        "program.commit",
        "program.builtAt",
        "program.manifest",
        "runtime.node",
        "runtime.executable",
      ],
    },
  },
];

export const COMMAND_SPECS: Readonly<Record<string, CommandSpec>> = Object.freeze(
  Object.fromEntries(COMMANDS.map((spec) => [spec.name, spec])),
);

export const COMMAND_GROUPS: readonly {
  readonly id: CommandGroup;
  readonly title: string;
  readonly description: string;
}[] = [
  { id: "read", title: "Read", description: "读取主题、搜索与校验（只读磁盘）" },
  { id: "write", title: "Write", description: "在线写入（需要该工作区的服务）" },
  {
    id: "workspace",
    title: "Workspace & service",
    description: "初始化、服务、请求状态与身份诊断",
  },
  { id: "meta", title: "Help & version", description: "帮助与版本（不需要工作区／服务）" },
];

export function getCommandSpec(name: string): CommandSpec | undefined {
  return COMMAND_SPECS[name];
}

export function commandNames(): readonly string[] {
  return COMMANDS.map((spec) => spec.name);
}

/** 参数表的 OptionSpec 形态：parseOptions 与帮助共用同一份定义。 */
export function optionSpecsFor(spec: CommandSpec): readonly OptionSpec[] {
  return spec.parameters.map((parameter) => ({
    name: parameter.name,
    ...(parameter.boolean === true ? { boolean: true as const } : {}),
    ...(parameter.repeatable === true ? { repeatable: true as const } : {}),
  }));
}

/** 按命令表解析参数；命令不存在是用例错误。 */
export function parseCommandArgs(command: string, args: readonly string[]): ParsedArgs {
  const spec = getCommandSpec(command);
  if (spec === undefined) throw new UsageError("未知命令 " + command);
  return parseOptions(args, optionSpecsFor(spec), spec.positionals?.length ?? 0);
}

/** 取必填选项；错误消息由参数定义生成，不各写一份。 */
export function requireParameter(
  parsed: ParsedArgs,
  command: string,
  name: string,
): string {
  const value = parsed.values.get(name);
  if (value !== undefined) return value;
  const parameter = getCommandSpec(command)?.parameters.find((item) => item.name === name);
  throw new UsageError("缺少 --" + name + (parameter ? "：" + parameter.description : ""));
}

/** 可重复选项（如 --node）。 */
export function repeatedParameter(parsed: ParsedArgs, name: string): readonly string[] {
  return parsed.lists.get(name) ?? [];
}
