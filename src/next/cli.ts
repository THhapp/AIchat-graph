#!/usr/bin/env node
/**
 * aichat Interface 4 CLI（SQLite 讨论图）。
 *
 * - 读取／检索／校验直接打开 GraphStore（只读），不经过 HTTP；
 * - 写入 POST /api/agent/changes；descriptor 缺失时按约定自启动同版服务；
 * - 默认输出紧凑 JSON；--text 输出简短人类摘要；
 * - 错误统一 stderr JSON { ok:false, error:{ code, message, details?, usage? } }。
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProgramInfo } from '../build-info.js';
import { searchDocuments } from '../index/search.js';
import type { SearchDocument } from '../index/types.js';
import {
  CliFailure,
  EXIT_CODES,
  flag,
  integerOption,
  internalFailure,
  notFoundFailure,
  operationConflictFailure,
  parseCommandArgs,
  repeated,
  requireValue,
  usageFailure,
  validationFailure,
  versionConflictFailure,
  workspaceFailure,
  type CommandSpec,
  type OptionSpec,
  type ParsedArgs,
} from './args.js';
import {
  DEFAULT_SERVICE_PORT,
  defaultServiceDeps,
  ensureService,
  requestRuntimeStop,
  resolveService,
  submitAgentChange,
  waitForServiceStopped,
  type ResolvedService,
  type ServiceDeps,
  type SpawnLike,
} from './client.js';
import {
  canonicalRoot,
  readDefaultConfig,
  resolveWorkspace,
  saveDefaultWorkspace,
  showDefaultConfig,
  type WorkspaceResolution,
} from './config.js';
import {
  currentInstallation,
  isPathInside,
  writeStartupLog,
  type InstallationPaths,
} from './installation.js';
import { DomainError, derivedSummary, findNode, findTopic } from './model.js';
import { INTERFACE_VERSION } from './protocol.js';
import type {
  AgentBatchAction,
  AgentBatchOp,
  AgentChangeAction,
  AgentChangeResponse,
  AgentCheckResponse,
  AgentCreateOp,
  AgentDeleteOp,
  AgentEditOp,
  AgentRearrangeEdit,
  ChangeStatusResponse,
  GraphNode,
  IncomingPatch,
  NodeCreate,
  NodePatch,
  ProgramInfo,
  ReadViewKind,
  ReadViewResponse,
  SearchHit,
} from './protocol.js';
import {
  DEFAULT_READ_BUDGET,
  MAX_READ_BUDGET,
  readView,
  type ReadRequest,
} from './read.js';
import { GraphStore } from './store.js';

export interface ProcessOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 捕获 stdout/stderr 的一次性进程调用；detached 用于浏览器/启动器，不等结果。 */
export type RunProcess = (
  command: string,
  args: readonly string[],
  options?: { readonly detached?: boolean; readonly cwd?: string; readonly windowsHide?: boolean },
) => Promise<ProcessOutcome>;

export interface CliRuntime {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
  readonly spawnImpl: SpawnLike;
  readonly runProcess: RunProcess;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly stdin: () => Promise<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** 安装布局；默认 currentInstallation()，测试注入假 distributionRoot。 */
  readonly installation: InstallationPaths;
  readonly configPath: string;
  readonly startTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly stopTimeoutMs: number;
  /** 测试覆盖：自启动使用的 CLI 入口。 */
  readonly entryPath: string | undefined;
  readonly shutdownSignal: AbortSignal | undefined;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/* ------------------------------------------------------------------ *
 * 选项与命令表（解析与 help 同源）
 * ------------------------------------------------------------------ */

const WORKSPACE_OPTION: OptionSpec = {
  name: 'workspace',
  type: 'path',
  valueName: '<dir>',
  description: '工作区目录（含 graph.sqlite）；默认按环境变量／默认配置解析',
};
const WORKSPACE_ID_OPTION: OptionSpec = {
  name: 'workspace-id',
  type: 'string',
  valueName: '<id>',
  description: '校验工作区身份，不参与定位',
};
const JSON_OPTION: OptionSpec = { name: 'json', type: 'flag', boolean: true, description: '机器可读 JSON（默认输出）' };
const TEXT_OPTION: OptionSpec = { name: 'text', type: 'flag', boolean: true, description: '人类可读摘要' };
const VERBOSE_OPTION: OptionSpec = { name: 'verbose', type: 'flag', boolean: true, description: '写入结果附带 httpStatus 等诊断' };
const NO_START_OPTION: OptionSpec = {
  name: 'no-start-service',
  type: 'flag',
  boolean: true,
  description: '禁止 CLI 自启动后台服务；没有 descriptor 时直接报错',
};
const INTERACTIVE_OPTION: OptionSpec = {
  name: 'interactive',
  type: 'flag',
  boolean: true,
  description: '交互模式：允许原生目录选择器与浏览器；由原生启动器传入',
};
const CHOOSE_WORKSPACE_OPTION: OptionSpec = {
  name: 'choose-workspace',
  type: 'flag',
  boolean: true,
  description: '弹出原生目录选择器选库（需同时给 --interactive）',
};
const NO_BROWSER_OPTION: OptionSpec = {
  name: 'no-browser',
  type: 'flag',
  boolean: true,
  description: '不打开浏览器，只启动／复用服务',
};
const OUTPUT_OPTIONS: readonly OptionSpec[] = [JSON_OPTION, TEXT_OPTION];
const READ_COMMON: readonly OptionSpec[] = [WORKSPACE_OPTION, WORKSPACE_ID_OPTION, ...OUTPUT_OPTIONS];
const WRITE_COMMON: readonly OptionSpec[] = [
  WORKSPACE_OPTION,
  WORKSPACE_ID_OPTION,
  NO_START_OPTION,
  VERBOSE_OPTION,
  ...OUTPUT_OPTIONS,
];

function stringOption(name: string, description: string, extra: Partial<OptionSpec> = {}): OptionSpec {
  return { name, type: 'string', description, ...extra };
}
function pathOption(name: string, description: string, extra: Partial<OptionSpec> = {}): OptionSpec {
  return { name, type: 'path', description, ...extra };
}
function integerOptionSpec(name: string, description: string, extra: Partial<OptionSpec> = {}): OptionSpec {
  return { name, type: 'integer', description, ...extra };
}
function enumOption(name: string, values: readonly string[], description: string, extra: Partial<OptionSpec> = {}): OptionSpec {
  return { name, type: 'enum', values, description, ...extra };
}
function flagOption(name: string, description: string, extra: Partial<OptionSpec> = {}): OptionSpec {
  return { name, type: 'flag', boolean: true, description, ...extra };
}

const BODY_OPTIONS: readonly OptionSpec[] = [
  stringOption('body', '内联正文'),
  pathOption('body-file', '从文件读取正文', { valueName: '<file>' }),
  flagOption('body-stdin', '从 stdin 读取正文'),
];
const NODE_REQUIRED = stringOption('node', '节点 ID', { valueName: '<id>', required: true, repeatable: true });
const IF_REVISION = integerOptionSpec('if-revision', '仅当节点 revision 等于该值时写入', { min: 0 });

const COMMANDS: readonly CommandSpec[] = [
  /* -------------------------------- read -------------------------------- */
  {
    name: 'topics',
    group: 'read',
    summary: '列出工作区内的主题与节点数（直接读 SQLite）。',
    usage: ['aichat topics [--workspace <dir>] [--json|--text]'],
    options: READ_COMMON,
    examples: ['aichat topics', 'aichat topics --workspace D:/discussions'],
    resultFields: ['ok', 'command', 'workspaceId', 'revision', 'topics', 'diagnostics'],
  },
  {
    name: 'validate',
    group: 'read',
    summary: '校验数据库中的图结构（唯一 root／唯一 next／无环／同主题）。',
    usage: ['aichat validate [--workspace <dir>] [--json|--text]'],
    options: READ_COMMON,
    examples: ['aichat validate'],
    resultFields: ['ok', 'command', 'workspaceId', 'revision', 'topics', 'nodes', 'diagnostics'],
  },
  {
    name: 'search',
    group: 'read',
    summary: '按标题 > 摘要 > 正文检索节点（直接读 SQLite）。',
    usage: ['aichat search <query> [--topic <topicId|key>] [--limit <1-100>] [--page <n>]'],
    positionals: [{ name: '<query>', required: true, description: '搜索词' }],
    options: [
      ...READ_COMMON,
      stringOption('topic', '限定主题 ID 或 key', { valueName: '<topicId|key>' }),
      integerOptionSpec('limit', '每页条数，默认 10，最大 100', { min: 1, max: 100, defaultValue: 10 }),
      integerOptionSpec('page', '0 起的页码，默认 0', { min: 0, defaultValue: 0 }),
    ],
    examples: ['aichat search 记录', 'aichat search 记录 --limit 20 --page 1'],
    resultFields: ['ok', 'command', 'source', 'workspaceId', 'query', 'hits', 'page', 'limit', 'totalHits', 'hasMore', 'diagnostics'],
  },
  {
    name: 'read',
    group: 'read',
    summary: '渐进读取：overview／structure／content／resume；正文按预算分页。',
    usage: [
      'aichat read <topicId|key> [--view overview|structure|content|resume] [--node <id>]',
      '           [--from <nodeId>] [--budget <n>] [--cursor <token>]',
      '           [--start <n>] [--length <n>|--full] [--from-heading <t> [--occurrence <n>]] [--meta]',
    ],
    positionals: [{ name: '<topicId|key>', required: false, description: '主题 ID 或 key；content 可只给 --node' }],
    options: [
      ...READ_COMMON,
      enumOption('view', ['overview', 'structure', 'content', 'resume'], '读取视图'),
      stringOption('topic', '主题 ID 或 key', { valueName: '<topicId|key>' }),
      stringOption('from', 'structure 的子树起点 nodeId', { valueName: '<nodeId>' }),
      stringOption('node', '内容读取的节点 ID；可重复', { valueName: '<id>', repeatable: true }),
      integerOptionSpec('budget', '本次响应预算（UTF-16），默认 12000', { min: 1, max: MAX_READ_BUDGET, defaultValue: DEFAULT_READ_BUDGET }),
      stringOption('cursor', 'page.next 续读标记；只可另带 --budget', { valueName: '<token>' }),
      integerOptionSpec('start', '正文起始偏移（0 起）', { min: 0 }),
      integerOptionSpec('length', '正文片段长度（1-16000）', { min: 1, max: 16000 }),
      flagOption('full', '返回整段正文'),
      stringOption('from-heading', '从正文标题定位起点', { valueName: '<标题>' }),
      integerOptionSpec('occurrence', '同名标题中的第几个（0 起），只与 --from-heading 同用', { min: 0 }),
      flagOption('meta', '只返回元数据（不含正文）'),
      flagOption('offline', '兼容选项：本 CLI 读取始终直接读数据库'),
    ],
    examples: ['aichat read <topicId>', 'aichat read <topicId> --view structure --from <nodeId>', 'aichat read --node <id> --from-heading 第二节'],
    resultFields: ['ok', 'command', 'source', 'workspaceId', 'view', 'topicId', 'topicTitle', 'scope', 'anchor?', 'items', 'boundaries?', 'page', 'budget', 'fingerprint'],
  },
  {
    name: 'resume',
    group: 'read',
    summary: '续谈入口：resume <topicId> --node <id>，等价于 read --view resume。',
    usage: ['aichat resume <topicId|key> --node <anchorId> [--budget <n>] [--cursor <token>]'],
    positionals: [{ name: '<topicId|key>', required: true, description: '主题 ID 或 key' }],
    options: [
      ...READ_COMMON,
      stringOption('node', '续谈锚点 nodeId；可重复（第一个作为 anchor）', { valueName: '<id>', repeatable: true }),
      integerOptionSpec('budget', '本次响应预算（UTF-16），默认 12000', { min: 1, max: MAX_READ_BUDGET, defaultValue: DEFAULT_READ_BUDGET }),
      stringOption('cursor', 'page.next 续读标记', { valueName: '<token>' }),
      integerOptionSpec('start', '正文起始偏移（0 起）', { min: 0 }),
      integerOptionSpec('length', '正文片段长度', { min: 1, max: 16000 }),
      flagOption('full', '返回整段正文'),
      stringOption('from-heading', '从正文标题定位起点', { valueName: '<标题>' }),
      integerOptionSpec('occurrence', '同名标题中的第几个（0 起）', { min: 0 }),
      flagOption('meta', '只返回元数据'),
      flagOption('offline', '兼容选项：本 CLI 读取始终直接读数据库'),
    ],
    examples: ['aichat resume <topicId> --node <id>'],
    resultFields: ['ok', 'command', 'source', 'workspaceId', 'view', 'topicId', 'topicTitle', 'scope', 'anchor?', 'items', 'page', 'budget', 'fingerprint'],
  },

  /* -------------------------------- write ------------------------------- */
  {
    name: 'edit',
    group: 'write',
    summary: '按节点 ID＋revision 修改一张卡片（内容／入边说明／来源关系／重要性，一次事务）。',
    usage: [
      'aichat edit --node <id> [--if-revision <n>] [--title <t>] [--state agreed|proposed|reference]',
      '            [--summary <s>|--clear-summary] [--important true|false]',
      '            [--body <text>|--body-file <file>|--body-stdin]',
      '            [--append-file <file>|--replace-file <json>]',
      '            [--description <why>] [--from-node <id> --from-revision <n> --flow next|branch]',
    ],
    options: [
      ...WRITE_COMMON,
      stringOption('node', '节点 ID', { valueName: '<id>', required: true }),
      IF_REVISION,
      stringOption('title', '新标题'),
      enumOption('state', ['agreed', 'proposed', 'reference'], '节点状态'),
      stringOption('summary', '新摘要；删除显式摘要请用 --clear-summary', { valueName: '<s>', allowEmpty: true }),
      flagOption('clear-summary', '显式删除显式摘要；与 --summary 互斥'),
      enumOption('important', ['true', 'false'], 'true 设为重要，false 取消'),
      ...BODY_OPTIONS,
      pathOption('append-file', '追加片段文件', { valueName: '<file>' }),
      pathOption('replace-file', '局部替换 JSON：[{old,new}] 或 {replace:[...]}', { valueName: '<json>' }),
      stringOption('description', '当前入边的说明；只改说明时可单独给出'),
      stringOption('from-node', '新的来源 nodeId；必须与 --from-revision、--flow、--description 同用', { valueName: '<id>' }),
      integerOptionSpec('from-revision', '来源节点的 revision', { min: 0 }),
      enumOption('flow', ['next', 'branch'], '节点关系类型（不改变时省略）'),
    ],
    constraints: [
      '至少给出 title／state／summary／--clear-summary／正文模式／--important／--description／--from-node 中一项。',
      '--summary 与 --clear-summary 互斥；空摘要请用 --clear-summary。',
      '--from-node 必须同时给 --from-revision、--flow 与 --description；只给 --flow 时保留当前来源。',
      '仅 important 变化不替换最近内容更新集合。',
      'root 节点没有入边，任何入边修改由服务整体拒绝。',
      'metadata-only 编辑不读取 stdin；只有显式 --body-stdin 才读。',
    ],
    examples: [
      'aichat edit --node <id> --if-revision <n> --title "新标题"',
      'aichat edit --node <id> --description "改接入边说明"',
      'aichat edit --node <id> --from-node <src> --from-revision <n> --flow branch --description "改接到这里更准确"',
    ],
    resultFields: ['ok', 'command', 'requestId', 'workspaceId', 'topicId', 'state', 'revision', 'changedNodeIds', 'nodeRevisions', 'created', 'summary', 'diagnostics'],
  },
  {
    name: 'important',
    group: 'write',
    summary: '设置或取消节点的重要标记；只翻转标记，不改内容。',
    usage: ['aichat important --node <id> [--if-revision <n>] (--on|--off)'],
    options: [
      ...WRITE_COMMON,
      stringOption('node', '节点 ID', { valueName: '<id>', required: true }),
      IF_REVISION,
      flagOption('on', '设为重要'),
      flagOption('off', '取消重要'),
    ],
    constraints: ['--on 与 --off 必须且只能给一个。', '仅重要标记变化不替换最近内容更新集合。'],
    examples: ['aichat important --node <id> --on'],
    resultFields: ['ok', 'command', 'requestId', 'workspaceId', 'topicId', 'state', 'revision', 'changedNodeIds', 'nodeRevisions', 'created', 'summary', 'diagnostics'],
  },
  {
    name: 'next',
    group: 'write',
    summary: '在来源节点之后新建纵向后继（unique next；已有 next 时冲突）。',
    usage: ['aichat next --from-node <id> --from-revision <n> --title <t> --description <why> (--body <text>|--body-file <file>|--body-stdin)'],
    options: [
      ...WRITE_COMMON,
      stringOption('from-node', '来源节点 ID', { valueName: '<id>', required: true }),
      integerOptionSpec('from-revision', '来源节点 revision', { min: 0, required: true }),
      stringOption('title', '新卡片标题'),
      stringOption('description', '为什么在这条线继续'),
      ...BODY_OPTIONS,
      stringOption('summary', '摘要；省略时由正文派生'),
      enumOption('state', ['agreed', 'proposed', 'reference'], '节点状态'),
    ],
    constraints: ['正文必须给出：--body／--body-file／--body-stdin 三选一。'],
    examples: ['aichat next --from-node <id> --from-revision <n> --title "下一步" --description "继续追问" --body-stdin'],
    resultFields: ['ok', 'command', 'requestId', 'workspaceId', 'topicId', 'state', 'revision', 'changedNodeIds', 'nodeRevisions', 'created', 'summary', 'diagnostics'],
  },
  {
    name: 'branch',
    group: 'write',
    summary: '在来源节点下新建独立方向的旁支（flow=branch）。',
    usage: ['aichat branch --from-node <id> --from-revision <n> --title <t> --description <why> (--body ...) [--side left|right] [--order <n>]'],
    options: [
      ...WRITE_COMMON,
      stringOption('from-node', '来源节点 ID', { valueName: '<id>', required: true }),
      integerOptionSpec('from-revision', '来源节点 revision', { min: 0, required: true }),
      stringOption('title', '新卡片标题'),
      stringOption('description', '为什么从这里旁出'),
      ...BODY_OPTIONS,
      stringOption('summary', '摘要；省略时由正文派生'),
      enumOption('state', ['agreed', 'proposed', 'reference'], '节点状态'),
      enumOption('side', ['left', 'right'], '侧向元数据'),
      integerOptionSpec('order', '同一来源下旁支排序值', { min: 0 }),
    ],
    constraints: ['正文必须给出：--body／--body-file／--body-stdin 三选一。', 'side／order 只影响同一来源下的旁支顺序。'],
    examples: ['aichat branch --from-node <id> --from-revision <n> --title "旁支" --description "另一个方向" --body-stdin'],
    resultFields: ['ok', 'command', 'requestId', 'workspaceId', 'topicId', 'state', 'revision', 'changedNodeIds', 'nodeRevisions', 'created', 'summary', 'diagnostics'],
  },
  {
    name: 'insert',
    group: 'write',
    summary: '在当前相邻的 after→before 之间插入一张卡片。',
    usage: [
      'aichat insert --after-node <id> --after-revision <n> --before-node <id> --before-revision <n>',
      '              --title <t> --description <after→新卡> --next-description <新卡→before> (--body ...)',
    ],
    options: [
      ...WRITE_COMMON,
      stringOption('after-node', '前一张卡片 ID', { valueName: '<id>', required: true }),
      integerOptionSpec('after-revision', '前一张卡片 revision', { min: 0, required: true }),
      stringOption('before-node', '后一张卡片 ID', { valueName: '<id>', required: true }),
      integerOptionSpec('before-revision', '后一张卡片 revision', { min: 0, required: true }),
      stringOption('title', '新卡片标题'),
      stringOption('description', 'after 到新卡的说明'),
      stringOption('next-description', '新卡到 before 的说明'),
      ...BODY_OPTIONS,
      stringOption('summary', '摘要；省略时由正文派生'),
      enumOption('state', ['agreed', 'proposed', 'reference'], '节点状态'),
    ],
    constraints: ['正文必须给出：--body／--body-file／--body-stdin 三选一。', '非相邻 next 由服务整体拒绝，不降级。'],
    examples: ['aichat insert --after-node <a> --after-revision <n> --before-node <b> --before-revision <m> --title "补一问" --description "先追问" --next-description "再回到原问题" --body-stdin'],
    resultFields: ['ok', 'command', 'requestId', 'workspaceId', 'topicId', 'state', 'revision', 'changedNodeIds', 'nodeRevisions', 'created', 'summary', 'diagnostics'],
  },
  {
    name: 'batch',
    group: 'write',
    summary: '一次原子提交同一主题内的 edit／create／delete 操作。',
    usage: ['aichat batch (--input <file.json>|--input-stdin) [--dry-run]'],
    options: [...WRITE_COMMON, pathOption('input', '批次 JSON 文件', { valueName: '<file.json>' }), flagOption('input-stdin', '从 stdin 读取批次 JSON'), flagOption('dry-run', '只检查并返回将改动的节点，不落库')],
    constraints: [
      '输入形状：{ topicId, ops: [edit|create|delete] }；edit.patch 与单卡 edit 使用同一 NodePatch。',
      'bodyFile／appendFile／replaceFile 由 CLI 读取（相对输入文件目录；stdin 用 cwd），服务端不读路径。',
      '本地仅在节点 revision 匹配时提交；一批只提交一次事务，失败不部分落库。',
    ],
    examples: ['aichat batch --input batch.json', 'aichat batch --input-stdin --dry-run < batch.json'],
    resultFields: ['ok', 'command', 'requestId', 'workspaceId', 'topicId', 'state', 'revision', 'changedNodeIds', 'nodeRevisions', 'created', 'summary', 'diagnostics'],
  },
  {
    name: 'rearrange',
    group: 'write',
    summary: '一次提交多处最终入边（安全排序后单次事务）。',
    usage: ['aichat rearrange --input <edits.json>'],
    options: [...WRITE_COMMON, pathOption('input', '重排 JSON 文件', { valueName: '<edits.json>', required: true })],
    constraints: ['输入形状：{ edits:[{target:{id,revision}, from:{id,revision}, flow, description, order?}] }。'],
    examples: ['aichat rearrange --input rearrange.json'],
    resultFields: ['ok', 'command', 'requestId', 'workspaceId', 'topicId', 'state', 'revision', 'changedNodeIds', 'nodeRevisions', 'created', 'summary', 'diagnostics'],
  },
  {
    name: 'delete',
    group: 'write',
    summary: '删除一张叶子卡片（要求 revision 匹配）。',
    usage: ['aichat delete --node <id> --if-revision <n>'],
    options: [...WRITE_COMMON, stringOption('node', '节点 ID', { valueName: '<id>', required: true }), integerOptionSpec('if-revision', '节点 revision', { min: 0, required: true })],
    constraints: ['只能删除没有子节点的叶子卡片；有后继时服务拒绝。'],
    examples: ['aichat delete --node <id> --if-revision <n>'],
    resultFields: ['ok', 'command', 'requestId', 'workspaceId', 'topicId', 'state', 'revision', 'changedNodeIds', 'nodeRevisions', 'created', 'summary', 'diagnostics'],
  },
  {
    name: 'create-topic',
    group: 'write',
    summary: '新建独立主题及其实例起点（root）。',
    usage: ['aichat create-topic --title <t> [--key <k>] [--root-title <t>] (--body ...)'],
    options: [
      ...WRITE_COMMON,
      stringOption('title', '新主题标题'),
      stringOption('key', '稳定的主题 key；默认由标题派生', { valueName: '<key>' }),
      stringOption('root-title', '起点卡片标题；默认同 --title'),
      ...BODY_OPTIONS,
    ],
    constraints: ['正文必须给出：--body／--body-file／--body-stdin 三选一。', '主题 key 在库内唯一。'],
    examples: ['aichat create-topic --title "新主题" --body "起点正文"'],
    resultFields: ['ok', 'command', 'requestId', 'workspaceId', 'topicId', 'state', 'revision', 'changedNodeIds', 'nodeRevisions', 'created', 'summary', 'diagnostics'],
  },

  /* ----------------------------- workspace ------------------------------ */
  {
    name: 'init',
    group: 'workspace',
    summary: '新建一个 SQLite 讨论工作区（不覆盖已有 graph.sqlite）。',
    usage: ['aichat init <path> [--name <name>]'],
    positionals: [{ name: '<path>', required: true, description: '新工作区目录' }],
    options: [stringOption('name', '工作区显示名'), ...OUTPUT_OPTIONS],
    examples: ['aichat init D:/discussions --name 思路库'],
    resultFields: ['ok', 'command', 'root', 'dbPath', 'workspaceId', 'name', 'schemaVersion'],
  },
  {
    name: 'import',
    group: 'workspace',
    summary: '从旧版 Markdown 工作区导入为 SQLite 讨论库。',
    usage: ['aichat import --workspace <dir> [--name <name>]'],
    options: [
      { ...WORKSPACE_OPTION, required: true, description: '要被导入的旧版工作区目录（含 workspace.json）' },
      stringOption('name', '新讨论库显示名'),
      ...OUTPUT_OPTIONS,
    ],
    examples: ['aichat import --workspace D:/old-workspace'],
    resultFields: ['ok', 'command', 'root', 'dbPath', 'workspaceId', 'name', 'topicCount', 'nodeCount'],
  },
  {
    name: 'serve',
    group: 'workspace',
    summary: '为指定工作区启动本机服务（不传 --port 时使用库的端口偏好，其次 4317/自动）。',
    usage: ['aichat serve --workspace <dir> [--port <0-65535>] [--no-browser]'],
    options: [
      WORKSPACE_OPTION,
      integerOptionSpec('port', '显式监听端口；省略时读取 <库>/.aichat/local/runtime.json 的 preferredPort，其次 4317，被占用则自动选择', {
        min: 0,
        max: 65535,
        defaultValue: DEFAULT_SERVICE_PORT,
      }),
      NO_BROWSER_OPTION,
      ...OUTPUT_OPTIONS,
    ],
    examples: ['aichat serve --workspace D:/discussions', 'aichat serve --workspace D:/discussions --port 0'],
    resultFields: ['ok', 'command', 'url', 'workspaceId', 'instanceId', 'revision', 'state'],
  },
  {
    name: 'open',
    group: 'workspace',
    summary: '打开讨论库：复用或启动本机服务，保存为默认库并打开浏览器。',
    usage: [
      'aichat open',
      'aichat open --workspace <dir> [--no-browser]',
      'aichat open --choose-workspace --interactive [--no-browser]',
    ],
    options: [WORKSPACE_OPTION, CHOOSE_WORKSPACE_OPTION, INTERACTIVE_OPTION, NO_BROWSER_OPTION, ...OUTPUT_OPTIONS],
    constraints: [
      '默认库取当前安装的默认配置（distributionRoot/.aichat/default.json）；--workspace 显式指定。',
      '--choose-workspace 必须同时给 --interactive，且不能与 --workspace 同用。',
      '只有原生选择器选中的空目录才会自动 init（目录名为库名）；已有 graph.sqlite 直接打开；非空且无库报错。',
      '服务优先复用 descriptor；描述失效时自启动（不带 --port 0，由服务使用端口偏好）。',
      '成功后保存默认库；浏览器通过原生启动器 --open-url 或 Windows start 打开。',
    ],
    examples: [
      'aichat open',
      'aichat open --choose-workspace --interactive',
      'aichat open --workspace D:/discussions --no-browser',
    ],
    resultFields: ['ok', 'command', 'state', 'workspaceId', 'workspace', 'url', 'instanceId', 'reused', 'program'],
  },
  {
    name: 'stop',
    group: 'workspace',
    summary: '请求当前库的本机服务自行停止（不自启动，不按 PID 杀进程）。',
    usage: ['aichat stop', 'aichat stop --workspace <dir>'],
    options: [WORKSPACE_OPTION, INTERACTIVE_OPTION, ...OUTPUT_OPTIONS],
    constraints: [
      '只读 descriptor 并 POST /api/runtime/stop；descriptor 缺失或连接拒绝视为 not-running 成功。',
      '旧版服务没有停止端点（404）时返回具体错误，不按 PID 杀进程。',
      '请求成功后轮询到端口不可达／descriptor 消失；超时不杀进程。',
    ],
    examples: ['aichat stop', 'aichat stop --workspace D:/discussions'],
    resultFields: ['ok', 'command', 'state', 'workspaceId', 'instanceId'],
  },
  {
    name: 'config',
    group: 'workspace',
    summary: '保存或查看默认工作区配置（<程序根>/.aichat/default.json）。',
    usage: ['aichat config --workspace <dir>', 'aichat config --show'],
    options: [WORKSPACE_OPTION, flagOption('show', '显示当前默认配置'), ...OUTPUT_OPTIONS],
    constraints: ['--workspace 与 --show 必须且只能给一个。', '--workspace 必须是已有 graph.sqlite 的工作区。'],
    examples: ['aichat config --workspace D:/discussions', 'aichat config --show'],
    resultFields: ['ok', 'command', 'configPath', 'exists', 'workspace', 'workspaceId', 'updatedAt'],
  },
  {
    name: 'status',
    group: 'workspace',
    summary: '查询 requestId 的写入状态（直接读 SQLite，不需要服务）。',
    usage: ['aichat status <requestId>'],
    positionals: [{ name: '<requestId>', required: true, description: '写入请求的 UUID' }],
    options: [WORKSPACE_OPTION, WORKSPACE_ID_OPTION, ...OUTPUT_OPTIONS],
    constraints: ['status=unknown 只表示数据库没有该记录，不推断写入成功或失败。'],
    examples: ['aichat status <requestId>'],
    resultFields: ['ok', 'command', 'requestId', 'status', 'httpStatus', 'state', 'recordedAt', 'source'],
  },
  {
    name: 'whoami',
    group: 'workspace',
    summary: '报告接口版本、本地数据库身份与服务身份（不因服务缺失而失败）。',
    usage: ['aichat whoami [--workspace <dir>]'],
    options: [WORKSPACE_OPTION, WORKSPACE_ID_OPTION, ...OUTPUT_OPTIONS],
    examples: ['aichat whoami'],
    resultFields: ['ok', 'command', 'interfaceVersion', 'program', 'workspaceId', 'name', 'rootPath', 'revision', 'instanceId?', 'url?', 'service'],
  },

  /* --------------------------------- meta ------------------------------- */
  {
    name: 'version',
    group: 'meta',
    summary: '输出程序、接口版本与构建身份（不需要工作区）。',
    usage: ['aichat version [--json|--text]', 'aichat --version'],
    options: [...OUTPUT_OPTIONS],
    examples: ['aichat version', 'aichat --version'],
    resultFields: ['ok', 'command', 'program', 'runtime'],
  },
  {
    name: 'help',
    group: 'meta',
    summary: '显示分组帮助或单命令机器说明（不需要工作区与服务）。',
    usage: ['aichat --help', 'aichat <command> --help', 'aichat help <command>', 'aichat help <command> --json', 'aichat help --json'],
    positionals: [{ name: '<command>', required: false, description: '要查看的命令名' }],
    options: [...OUTPUT_OPTIONS],
    examples: ['aichat --help', 'aichat help edit --json'],
    resultFields: ['ok', 'command', 'group', 'interfaceVersion', 'programVersion', 'summary', 'usage', 'parameters', 'constraints', 'examples', 'result'],
  },
];

const COMMAND_BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));
const COMMAND_GROUPS: ReadonlyArray<{ id: CommandSpec['group']; title: string; description: string }> = [
  { id: 'read', title: 'Read', description: '主题、检索、校验与渐进读取（直接读 SQLite）' },
  { id: 'write', title: 'Write', description: '通过本机服务写入；需要 descriptor 或允许自启动' },
  { id: 'workspace', title: 'Workspace', description: '打开／停止、初始化、导入、服务、默认配置与身份诊断' },
  { id: 'meta', title: 'Meta', description: '版本与帮助（不需要工作区）' },
];

/* ------------------------------------------------------------------ *
 * 帮助与版本
 * ------------------------------------------------------------------ */

function programInfo(): ProgramInfo {
  const info = loadProgramInfo();
  return {
    program: 'aichat-graph',
    version: info.version,
    interfaceVersion: INTERFACE_VERSION,
    buildId: info.buildId,
    commit: info.commit,
    builtAt: info.builtAt,
    ...(info.manifest !== undefined ? { manifest: info.manifest } : {}),
  };
}

function versionLine(): string {
  const program = programInfo();
  return program.program + ' ' + program.version + ' interface ' + String(program.interfaceVersion) + ' build ' + program.buildId;
}

function rootHelp(): string {
  const lines: string[] = [
    'aichat — Interface 4（SQLite）讨论图 CLI',
    versionLine(),
    '',
    'Usage: aichat <command> [options]',
    '       aichat <command> --help          只查看该命令',
    '       aichat help <command> --json     机器可读的单命令说明',
    '',
  ];
  for (const group of COMMAND_GROUPS) {
    lines.push(group.title + ' — ' + group.description + ':');
    for (const spec of COMMANDS) {
      if (spec.group !== group.id) continue;
      lines.push('  ' + spec.name.padEnd(14) + spec.summary);
    }
    lines.push('');
  }
  lines.push(
    'Workspace: --workspace <dir> → AICHAT_WORKSPACE → 程序根 .aichat/default.json',
    '读取直接读 SQLite；写入 POST /api/agent/changes；descriptor 缺失时按约定自启动 serve。',
  );
  return lines.join('\n');
}

function describeOption(option: OptionSpec): string {
  const head = '--' + option.name + (option.valueName !== undefined ? ' ' + option.valueName : '');
  const notes: string[] = [];
  if (option.required === true) notes.push('必填');
  if (option.repeatable === true) notes.push('可重复');
  if (option.defaultValue !== undefined) notes.push('默认 ' + String(option.defaultValue));
  if (option.type === 'enum' && option.values !== undefined) notes.push('取值 ' + option.values.join('|'));
  return '  ' + head.padEnd(32) + (notes.length > 0 ? '[' + notes.join('；') + '] ' : '') + option.description;
}

function commandHelpText(spec: CommandSpec): string {
  const lines: string[] = [versionLine(), '', 'aichat ' + spec.name + ' — ' + spec.summary, '', 'Usage:'];
  for (const usage of spec.usage) lines.push('  ' + usage);
  lines.push('', 'Parameters:');
  for (const positional of spec.positionals ?? []) {
    lines.push('  ' + positional.name.padEnd(32) + (positional.required === true ? '[必填] ' : '[可选] ') + positional.description);
  }
  for (const option of spec.options) lines.push(describeOption(option));
  if (spec.constraints !== undefined) {
    lines.push('', 'Constraints:');
    for (const constraint of spec.constraints) lines.push('  - ' + constraint);
  }
  if (spec.examples !== undefined) {
    lines.push('', 'Examples:');
    for (const example of spec.examples) lines.push('  ' + example);
  }
  return lines.join('\n');
}

function parameterDescriptions(spec: CommandSpec): Array<Record<string, unknown>> {
  const parameters: Array<Record<string, unknown>> = [];
  for (const positional of spec.positionals ?? []) {
    parameters.push({ name: positional.name, type: 'string', required: positional.required === true, repeatable: false, description: positional.description });
  }
  for (const option of spec.options) {
    parameters.push({
      name: '--' + option.name,
      type: option.type ?? 'string',
      required: option.required === true,
      repeatable: option.repeatable === true,
      ...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}),
      ...(option.values !== undefined ? { values: [...option.values] } : {}),
      description: option.description,
    });
  }
  return parameters;
}

function commandHelpJson(spec: CommandSpec): Record<string, unknown> {
  const program = programInfo();
  return {
    ok: true,
    command: spec.name,
    group: spec.group,
    interfaceVersion: program.interfaceVersion,
    programVersion: program.version,
    summary: spec.summary,
    usage: [...spec.usage],
    parameters: parameterDescriptions(spec),
    constraints: [...(spec.constraints ?? [])],
    examples: [...(spec.examples ?? [])],
    result: { fields: [...(spec.resultFields ?? [])] },
  };
}

function catalogHelpJson(): Record<string, unknown> {
  const program = programInfo();
  return {
    ok: true,
    command: 'help',
    group: 'meta',
    interfaceVersion: program.interfaceVersion,
    programVersion: program.version,
    summary: '命令目录；单命令完整机器说明用 aichat help <command> --json。',
    commands: COMMANDS.map((spec) => ({ name: spec.name, group: spec.group, summary: spec.summary })),
    groups: COMMAND_GROUPS.map((group) => ({ ...group })),
  };
}

function briefUsage(commandName?: string): string {
  const spec = commandName === undefined ? undefined : COMMAND_BY_NAME.get(commandName);
  if (spec !== undefined) return 'Usage: ' + spec.usage[0];
  return 'Usage: aichat <command> [options]';
}

/* ------------------------------------------------------------------ *
 * 运行时与 IO
 * ------------------------------------------------------------------ */

const DIRECT_EXECUTION = isExecutedDirectly();

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function defaultRunProcess(
  command: string,
  args: readonly string[],
  options: { readonly detached?: boolean; readonly cwd?: string; readonly windowsHide?: boolean } = {},
): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        detached: options.detached === true,
        stdio: options.detached === true ? 'ignore' : ['ignore', 'pipe', 'pipe'],
        windowsHide: options.windowsHide ?? true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    if (options.detached === true) {
      child.unref();
      resolve({ code: 0, stdout: '', stderr: '' });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => err.push(Buffer.from(chunk)));
    child.on('error', (error: Error) => reject(error));
    child.on('close', (code: number | null) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function createRuntime(context: Partial<CliRuntime>): CliRuntime {
  const installation = context.installation ?? currentInstallation();
  return {
    cwd: context.cwd ?? process.cwd(),
    env: { ...process.env, ...(context.env ?? {}) },
    fetchImpl: context.fetchImpl ?? fetch,
    spawnImpl: context.spawnImpl ?? defaultServiceDeps().spawnImpl,
    runProcess: context.runProcess ?? defaultRunProcess,
    sleep:
      context.sleep ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    stdin: context.stdin ?? readStdin,
    stdout: () => undefined,
    stderr: () => undefined,
    installation,
    configPath: context.configPath ?? installation.configPath,
    startTimeoutMs: context.startTimeoutMs ?? 8_000,
    pollIntervalMs: context.pollIntervalMs ?? 100,
    stopTimeoutMs: context.stopTimeoutMs ?? 10_000,
    entryPath: context.entryPath,
    shutdownSignal: context.shutdownSignal,
  };
}

function emitJson(runtime: CliRuntime, payload: Record<string, unknown>): void {
  runtime.stdout(JSON.stringify(payload) + '\n');
}

function humanLines(command: string, payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const state = payload['state'];
  if (state !== undefined) {
    lines.push(command + ' ' + String(state));
    if (payload['workspaceId'] !== undefined) lines.push('workspace ' + String(payload['workspaceId']));
    if (payload['topicId'] !== undefined) lines.push('topic ' + String(payload['topicId']));
    if (payload['workspace'] !== undefined) lines.push('库 ' + String(payload['workspace']));
    if (payload['url'] !== undefined) lines.push('url ' + String(payload['url']));
    if (typeof payload['reused'] === 'boolean') lines.push('reused ' + String(payload['reused']));
    if (payload['revision'] !== undefined) lines.push('revision ' + String(payload['revision']));
    const created = payload['created'] as Record<string, unknown> | undefined;
    if (created !== undefined) {
      const nodeIds = created['nodeIds'];
      if (Array.isArray(nodeIds) && nodeIds.length > 0) lines.push('created nodes: ' + nodeIds.join(', '));
      if (typeof created['topicId'] === 'string') lines.push('created topic: ' + created['topicId']);
    }
    if (created !== undefined) {
      const aliases = created['aliases'];
      if (aliases !== undefined && typeof aliases === 'object' && aliases !== null) {
        const entries = Object.entries(aliases as Record<string, unknown>);
        if (entries.length > 0) lines.push('aliases: ' + entries.map(([key, value]) => key + '=' + String(value)).join(', '));
      }
    }
    if (payload['summary'] !== undefined) lines.push('summary: ' + String(payload['summary']));
    return lines;
  }
  const view = payload['view'];
  if (view !== undefined) {
    lines.push('read ' + String(view) + '  topic ' + String(payload['topicId']) + '  items ' + String(Array.isArray(payload['items']) ? (payload['items'] as unknown[]).length : 0));
    const budget = payload['budget'] as Record<string, unknown> | undefined;
    if (budget !== undefined) lines.push('budget ' + String(budget['used']) + '/' + String(budget['limit']));
    const page = payload['page'] as Record<string, unknown> | undefined;
    if (page !== undefined && page['hasMore'] === true) lines.push('更多：--cursor ' + String(page['next'] ?? ''));
    return lines;
  }
  if (Array.isArray(payload['topics'])) {
    lines.push('topics ' + String((payload['topics'] as unknown[]).length));
    for (const topic of payload['topics'] as Array<Record<string, unknown>>) {
      lines.push('  ' + String(topic['topicId'] ?? topic['id']) + '  ' + String(topic['title'] ?? '') + '  nodes ' + String(topic['nodeCount'] ?? ''));
    }
    return lines;
  }
  if (Array.isArray(payload['hits'])) {
    lines.push(String(payload['totalHits'] ?? 0) + ' hit(s) for "' + String(payload['query']) + '"');
    for (const hit of payload['hits'] as Array<Record<string, unknown>>) {
      lines.push('  ' + String(hit['nodeId']) + ' [' + String(hit['field']) + '] ' + String(hit['title']));
    }
    return lines;
  }
  if (payload['command'] === 'status') {
    lines.push('status ' + String(payload['requestId']) + ': ' + String(payload['status']));
    return lines;
  }
  if (payload['interfaceVersion'] !== undefined) {
    lines.push(versionLine());
    if (payload['workspaceId'] !== undefined) lines.push('workspace ' + String(payload['workspaceId']));
    if (payload['rootPath'] !== undefined) lines.push('root ' + String(payload['rootPath']));
    return lines;
  }
  lines.push(JSON.stringify(payload));
  return lines;
}

/* ------------------------------------------------------------------ *
 * 工作区与快照
 * ------------------------------------------------------------------ */

interface WorkspaceSnapshotContext {
  readonly root: string;
  readonly snapshot: ReturnType<GraphStore['snapshot']>;
  readonly store: GraphStore;
  readonly resolution: WorkspaceResolution;
}

async function resolveCliWorkspace(parsed: ParsedArgs, runtime: CliRuntime): Promise<WorkspaceResolution> {
  return resolveWorkspace({
    cwd: runtime.cwd,
    env: runtime.env,
    explicit: parsed.values.get('workspace'),
    ...(runtime.configPath !== undefined ? { configPath: runtime.configPath } : {}),
  });
}

async function withWorkspaceStore<T>(
  spec: CommandSpec,
  parsed: ParsedArgs,
  runtime: CliRuntime,
  run: (context: WorkspaceSnapshotContext) => Promise<T> | T,
): Promise<T> {
  const resolution = await resolveCliWorkspace(parsed, runtime);
  let store: GraphStore;
  try {
    store = GraphStore.open(resolution.root, { readonly: true });
  } catch (error) {
    throw mapDomainError(error, spec);
  }
  try {
    const snapshot = store.snapshot();
    const expected = parsed.values.get('workspace-id');
    if (expected !== undefined && expected !== snapshot.workspaceId) {
      throw workspaceFailure(
        'WORKSPACE_ID_MISMATCH',
        '工作区身份不匹配：--workspace-id=' + expected + '，实际 ' + snapshot.workspaceId,
        { expected, actual: snapshot.workspaceId, root: resolution.root },
      );
    }
    return await run({ root: resolution.root, snapshot, store, resolution });
  } finally {
    store.close();
  }
}

function mapDomainError(error: unknown, spec?: CommandSpec): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof DomainError) {
    const details = { ...error.details, code: error.code };
    if (error.status === 404) {
      return new CliFailure(error.code, error.message, EXIT_CODES.notFound, { details });
    }
    if (error.status === 412) {
      return versionConflictFailure(error.message, details);
    }
    if (error.status === 409) {
      return operationConflictFailure(error.code, error.message, details);
    }
    if (error.status === 400) {
      return usageFailure(error.message, {
        details,
        ...(spec !== undefined ? { usage: spec.usage[0] } : {}),
      });
    }
    return validationFailure(error.code, error.message, details);
  }
  if (error instanceof Error) return internalFailure(error.message, error);
  return internalFailure(String(error));
}

function resolveTopicId(snapshot: ReturnType<GraphStore['snapshot']>, reference: string): string {
  const topic = snapshot.topics.find((entry) => entry.id === reference || entry.key === reference);
  if (topic === undefined) {
    throw notFoundFailure('TOPIC_NOT_FOUND', '找不到主题：' + reference, { topicId: reference });
  }
  return topic.id;
}

function nodeOf(snapshot: ReturnType<GraphStore['snapshot']>, nodeId: string): GraphNode {
  try {
    return findNode(snapshot, nodeId) as unknown as GraphNode;
  } catch (error) {
    throw mapDomainError(error);
  }
}

/* ------------------------------------------------------------------ *
 * 输入读取（正文／文件／JSON）
 * ------------------------------------------------------------------ */

function bodyModesGiven(parsed: ParsedArgs): boolean {
  return parsed.values.has('body') || parsed.values.has('body-file') || flag(parsed, 'body-stdin');
}

async function readLocalText(runtime: CliRuntime, rawPath: string, label: string): Promise<string> {
  const absolute = path.resolve(runtime.cwd, rawPath);
  try {
    return await fs.readFile(absolute, 'utf8');
  } catch (error) {
    throw usageFailure('无法读取 ' + label + '：' + absolute, {
      details: { field: label, path: absolute },
    });
  }
}

function parseReplacePairs(text: string, label: string): Array<{ old: string; new: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw usageFailure(label + ' 不是合法 JSON', { details: { field: label } });
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['replace'])
      ? ((parsed as Record<string, unknown>)['replace'] as unknown[])
      : null;
  if (list === null || list.length === 0) {
    throw usageFailure(label + ' 必须是 [{old,new}] 或 {replace:[...]} 且非空', {
      details: { field: label },
    });
  }
  return list.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw usageFailure(label + '[' + String(index) + '] 必须是 {old,new}', {
        details: { field: label + '[' + String(index) + ']' },
      });
    }
    const record = entry as Record<string, unknown>;
    const old = record['old'];
    const replacement = record['new'];
    if (typeof old !== 'string' || old.length === 0 || typeof replacement !== 'string') {
      throw usageFailure(label + '[' + String(index) + '] 的 old 必须非空、new 必须是字符串', {
        details: { field: label + '[' + String(index) + ']' },
      });
    }
    return { old, new: replacement };
  });
}

/** 单卡 edit 的正文模式：body／append／replace 互斥，最多一个来源。 */
async function readBodyPatch(parsed: ParsedArgs, runtime: CliRuntime): Promise<{
  body?: string;
  append?: string;
  replace?: Array<{ old: string; new: string }>;
}> {
  const inlineBody = parsed.values.get('body');
  const bodyFile = parsed.values.get('body-file');
  const bodyStdin = flag(parsed, 'body-stdin');
  const bodySources = [inlineBody !== undefined, bodyFile !== undefined, bodyStdin].filter(Boolean).length;
  if (bodySources > 1) {
    throw usageFailure('--body／--body-file／--body-stdin 只能给一个', {
      details: { field: 'body' },
    });
  }
  let body: string | undefined;
  if (inlineBody !== undefined) body = inlineBody;
  else if (bodyFile !== undefined) body = await readLocalText(runtime, bodyFile, 'body-file');
  else if (bodyStdin) body = await runtime.stdin();

  const appendFile = parsed.values.get('append-file');
  const replaceFile = parsed.values.get('replace-file');
  const append = appendFile !== undefined ? await readLocalText(runtime, appendFile, 'append-file') : undefined;
  const replace = replaceFile !== undefined ? parseReplacePairs(await readLocalText(runtime, replaceFile, 'replace-file'), 'replace-file') : undefined;
  const modes = [body !== undefined, append !== undefined, replace !== undefined].filter(Boolean).length;
  if (modes > 1) {
    throw usageFailure('正文修改模式互斥：body／append／replace 只能选一个', {
      details: { field: 'body' },
    });
  }
  return {
    ...(body !== undefined ? { body } : {}),
    ...(append !== undefined ? { append } : {}),
    ...(replace !== undefined ? { replace } : {}),
  };
}

interface JsonInputFile {
  readonly text: string;
  readonly baseDir: string;
  readonly sourcePath: string | null;
}

async function readJsonInput(parsed: ParsedArgs, runtime: CliRuntime, spec: CommandSpec): Promise<JsonInputFile> {
  const input = parsed.values.get('input');
  const fromStdin = flag(parsed, 'input-stdin');
  if (input !== undefined && fromStdin) {
    throw usageFailure('--input 与 --input-stdin 互斥，只能给一个', {
      details: { field: 'input' },
      usage: spec.usage[0],
    });
  }
  if (input === undefined && !fromStdin) {
    throw usageFailure('需要 --input <file.json> 或 --input-stdin', {
      details: { field: 'input' },
      usage: spec.usage[0],
    });
  }
  if (fromStdin) {
    return { text: await runtime.stdin(), baseDir: runtime.cwd, sourcePath: null };
  }
  const absolute = path.resolve(runtime.cwd, input as string);
  try {
    return { text: await fs.readFile(absolute, 'utf8'), baseDir: path.dirname(absolute), sourcePath: absolute };
  } catch {
    throw usageFailure('无法读取 --input 文件：' + absolute, {
      details: { field: 'input', path: absolute },
      usage: spec.usage[0],
    });
  }
}

function parseJsonText(text: string, sourcePath: string | null, command: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw usageFailure(command + ' 的输入不是合法 JSON：' + (sourcePath ?? 'stdin'), {
      details: { path: sourcePath ?? 'stdin' },
    });
  }
}

function ensureRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw usageFailure(label + ' 必须是 JSON 对象', { details: { field: label } });
  }
  return value as Record<string, unknown>;
}

function ensureString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw usageFailure(label + '.' + key + ' 必须是非空字符串', { details: { field: label + '.' + key } });
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * 写入辅助
 * ------------------------------------------------------------------ */

function serviceDeps(runtime: CliRuntime, parsed: ParsedArgs): ServiceDeps {
  const noStartEnv = runtime.env['AICHAT_NO_START_SERVICE'];
  return defaultServiceDeps({
    fetchImpl: runtime.fetchImpl,
    spawnImpl: runtime.spawnImpl,
    sleep: runtime.sleep,
    startTimeoutMs: runtime.startTimeoutMs,
    pollIntervalMs: runtime.pollIntervalMs,
    noStart: flag(parsed, 'no-start-service') || noStartEnv === '1',
    requireInterface: true,
  });
}

interface PreparedWrite {
  readonly root: string;
  readonly workspaceId: string;
  readonly action: AgentChangeAction;
}

function writePayload(
  command: string,
  response: AgentChangeResponse,
  options: { httpStatus: number; verbose: boolean },
): Record<string, unknown> {
  return {
    ok: true,
    command,
    requestId: response.requestId,
    workspaceId: response.workspaceId,
    topicId: response.topicId,
    state: response.state,
    revision: response.revision,
    changedNodeIds: [...response.changedNodeIds],
    // 默认 JSON 就带持久 node revision，调用方无需再读一次即可继续编辑。
    nodeRevisions: { ...response.nodeRevisions },
    created: {
      topicId: response.created.topicId,
      nodeIds: [...response.created.nodeIds],
      aliases: { ...response.created.aliases },
    },
    summary: response.summary,
    diagnostics: response.diagnostics,
    ...(response.replayed === true ? { replayed: true } : {}),
    ...(options.verbose ? { httpStatus: options.httpStatus, instanceId: response.instanceId } : {}),
  };
}

function dryRunPayload(
  command: string,
  response: AgentCheckResponse,
  options: { httpStatus: number; verbose: boolean },
): Record<string, unknown> {
  return {
    ok: true,
    command,
    requestId: response.requestId,
    workspaceId: response.workspaceId,
    topicId: response.topicId,
    dryRun: true,
    state: 'checked',
    summary: response.summary,
    changes: response.changes,
    diagnostics: response.diagnostics,
    ...(options.verbose ? { httpStatus: options.httpStatus } : {}),
  };
}

async function performWrite(
  command: string,
  spec: CommandSpec,
  parsed: ParsedArgs,
  runtime: CliRuntime,
  build: (snapshot: ReturnType<GraphStore['snapshot']>) => AgentChangeAction | Promise<AgentChangeAction>,
): Promise<Record<string, unknown>> {
  const prepared = await withWorkspaceStore(spec, parsed, runtime, async ({ root, snapshot }): Promise<PreparedWrite> => ({
    root,
    workspaceId: snapshot.workspaceId,
    action: await build(snapshot),
  }));
  const deps = serviceDeps(runtime, parsed);
  const service: ResolvedService = await resolveService(prepared.root, prepared.workspaceId, deps);
  const result = await submitAgentChange(service, prepared.action, deps);
  const verbose = flag(parsed, 'verbose');
  if ('dryRun' in result.response && result.response.dryRun === true) {
    return dryRunPayload(command, result.response as AgentCheckResponse, {
      httpStatus: result.httpStatus,
      verbose,
    });
  }
  return writePayload(command, result.response as AgentChangeResponse, {
    httpStatus: result.httpStatus,
    verbose,
  });
}

/** 单卡 edit：NodePatch 一次随 edit 提交；CLI 不做多次 edit+connect+important。 */
async function buildEditAction(
  spec: CommandSpec,
  parsed: ParsedArgs,
  runtime: CliRuntime,
  snapshot: ReturnType<GraphStore['snapshot']>,
): Promise<AgentChangeAction> {
  if (flag(parsed, 'json') && flag(parsed, 'text')) {
    throw usageFailure('--json 与 --text 不能同时使用', { usage: spec.usage[0] });
  }
  const nodeId = requireValue(parsed, spec, 'node');
  const node = nodeOf(snapshot, nodeId);
  const revision = integerOption(parsed, spec, 'if-revision') ?? node.revision;

  const title = parsed.values.get('title');
  const stateRaw = parsed.values.get('state');
  const summary = parsed.values.get('summary');
  const clearSummary = flag(parsed, 'clear-summary');
  const importantRaw = parsed.values.get('important');
  const description = parsed.values.get('description');
  const fromNode = parsed.values.get('from-node');
  const fromRevisionRaw = parsed.values.get('from-revision');
  const flowRaw = parsed.values.get('flow');

  if (summary !== undefined && clearSummary) {
    throw usageFailure('--summary 与 --clear-summary 互斥：删除显式摘要请只给 --clear-summary', {
      details: { field: 'summary', hint: '--clear-summary' },
      usage: spec.usage[0],
    });
  }
  if (summary === '') {
    throw usageFailure('--summary 不能是空字符串；删除显式摘要请用 --clear-summary', {
      details: { field: 'summary', hint: '--clear-summary' },
      usage: spec.usage[0],
    });
  }
  let important: boolean | undefined;
  if (importantRaw !== undefined) {
    if (importantRaw !== 'true' && importantRaw !== 'false') {
      throw usageFailure('--important 只能是 true 或 false，收到 ' + importantRaw, {
        details: { field: 'important' },
        usage: spec.usage[0],
      });
    }
    important = importantRaw === 'true';
  }
  let flow: 'next' | 'branch' | undefined;
  if (flowRaw !== undefined) {
    if (flowRaw !== 'next' && flowRaw !== 'branch') {
      throw usageFailure('--flow 只能是 next 或 branch，收到 ' + flowRaw, {
        details: { field: 'flow' },
        usage: spec.usage[0],
      });
    }
    flow = flowRaw;
  }
  if (fromNode !== undefined && fromRevisionRaw === undefined) {
    throw usageFailure('--from-node 必须同时给 --from-revision', {
      details: { field: 'from-node' },
      usage: spec.usage[0],
    });
  }
  if (fromNode !== undefined && flow === undefined) {
    throw usageFailure('--from-node 必须同时给 --flow next|branch', {
      details: { field: 'from-node' },
      usage: spec.usage[0],
    });
  }
  if ((fromNode !== undefined || flow !== undefined) && description === undefined) {
    throw usageFailure(
      (fromNode !== undefined ? '--from-node' : '--flow') + ' 必须同时给 --description：说明为什么改接／改关系类型',
      { details: { field: fromNode !== undefined ? 'from-node' : 'flow' }, usage: spec.usage[0] },
    );
  }
  let fromRevision: number | undefined;
  if (fromRevisionRaw !== undefined) {
    fromRevision = integerOption(parsed, spec, 'from-revision');
  }

  const wantsBody = bodyModesGiven(parsed) || parsed.values.has('append-file') || parsed.values.has('replace-file');
  const bodyPatch = wantsBody ? await readBodyPatch(parsed, runtime) : {};
  const hasBody = bodyPatch.body !== undefined || bodyPatch.append !== undefined || bodyPatch.replace !== undefined;
  if (
    title === undefined &&
    stateRaw === undefined &&
    summary === undefined &&
    !clearSummary &&
    important === undefined &&
    description === undefined &&
    fromNode === undefined &&
    !hasBody
  ) {
    throw usageFailure(
      'edit 至少需要一项修改：--title／--state／--summary／--clear-summary／正文模式／--important／--description／--from-node',
      { details: { field: 'modification' }, usage: spec.usage[0] },
    );
  }

  const incoming: IncomingPatch | undefined =
    description !== undefined || fromNode !== undefined || flow !== undefined
      ? {
          ...(fromNode !== undefined && fromRevision !== undefined
            ? { from: { id: fromNode, revision: fromRevision } }
            : {}),
          ...(flow !== undefined ? { flow } : {}),
          ...(description !== undefined ? { description } : {}),
        }
      : undefined;
  const patch: NodePatch = {};
  if (title !== undefined) patch.title = title;
  if (stateRaw !== undefined) patch.state = stateRaw as NonNullable<NodePatch['state']>;
  if (clearSummary) patch.summary = null;
  else if (summary !== undefined) patch.summary = summary;
  if (bodyPatch.body !== undefined) patch.body = bodyPatch.body;
  if (bodyPatch.append !== undefined) patch.append = bodyPatch.append;
  if (bodyPatch.replace !== undefined) patch.replace = bodyPatch.replace;
  if (important !== undefined) patch.important = important;
  if (incoming !== undefined) patch.incoming = incoming;
  const action: AgentBatchAction = {
    action: 'batch',
    topicId: node.topicId,
    ops: [{ op: 'edit', target: { id: nodeId, revision }, patch }],
  };
  return action;
}

async function readBodyForCreate(
  parsed: ParsedArgs,
  runtime: CliRuntime,
  spec: CommandSpec,
): Promise<string> {
  const hasBody = bodyModesGiven(parsed) || parsed.values.has('append-file') || parsed.values.has('replace-file');
  if (!hasBody) {
    throw usageFailure('缺少正文：--body／--body-file／--body-stdin 三选一', {
      details: { field: 'body' },
      usage: spec.usage[0],
    });
  }
  const patch = await readBodyPatch(parsed, runtime);
  if (patch.body === undefined) {
    throw usageFailure('新建卡片只能用 --body／--body-file／--body-stdin 给整篇正文', {
      details: { field: 'body' },
      usage: spec.usage[0],
    });
  }
  return patch.body;
}

function nodeCreateFrom(
  parsed: ParsedArgs,
  body: string,
  options: { title: string; allowSide?: boolean },
): NodeCreate {
  const summary = parsed.values.get('summary');
  const state = parsed.values.get('state');
  const side = parsed.values.get('side');
  const orderRaw = parsed.values.get('order');
  const node: NodeCreate = { title: options.title, body };
  if (summary !== undefined) node.summary = summary;
  if (state !== undefined) node.state = state as NonNullable<NodeCreate['state']>;
  if (options.allowSide === true && side !== undefined) node.side = side as NonNullable<NodeCreate['side']>;
  if (options.allowSide === true && orderRaw !== undefined) node.order = Number(orderRaw);
  return node;
}

/* ------------------------------------------------------------------ *
 * 命令实现
 * ------------------------------------------------------------------ */

/**
 * read.ts 的 budget.used 用固定占位计算；CLI 输出是最终 JSON，重新收敛一次，
 * 保证 budget.used 等于真实 stdout 字节（字符）长度，便于调用方按预算续读。
 */
function finalizeReadBudget(response: Record<string, unknown>): Record<string, unknown> {
  const budget = response['budget'] as Record<string, unknown> | undefined;
  if (budget === undefined) return response;
  let used = 0;
  for (let i = 0; i < 6; i += 1) {
    budget['used'] = used;
    const next = JSON.stringify(response).length + 1;
    if (next === used) return response;
    used = next;
  }
  budget['used'] = used;
  return response;
}

async function runReadThenMap(
  command: string,
  spec: CommandSpec,
  parsed: ParsedArgs,
  runtime: CliRuntime,
): Promise<Record<string, unknown>> {
  return withWorkspaceStore(spec, parsed, runtime, async ({ snapshot }) => {
    const nodeIds = [...repeated(parsed, 'node')];
    const cursor = parsed.values.get('cursor');
    if (cursor !== undefined) {
      const conflicts = ['topic', 'view', 'from', 'node', 'start', 'length', 'full', 'from-heading', 'occurrence', 'meta'].filter(
        (name) => (name === 'node' ? parsed.lists.has('node') : parsed.values.has(name)),
      );
      if (conflicts.length > 0) {
        throw usageFailure('--cursor 只能与 --budget／--offline 同用', {
          details: { conflicts },
          usage: spec.usage[0],
        });
      }
    }
    const budget = integerOption(parsed, spec, 'budget', { min: 1, max: MAX_READ_BUDGET }) ?? DEFAULT_READ_BUDGET;
    const cursorView = parsed.values.get('view') as ReadViewKind | undefined;
    if (cursor !== undefined) {
      // cursor 已包含 view／范围／topic；位置参数与 --topic 可省略。
      const topicReference = parsed.values.get('topic') ?? parsed.positional[0];
      const cursorPage = readView(
        snapshot,
        {
          view: cursorView ?? 'content',
          budget,
          cursor,
          ...(topicReference !== undefined ? { topicId: topicReference } : {}),
        },
        'database',
      ) as unknown as Record<string, unknown>;
      return finalizeReadBudget(cursorPage);
    }
    const viewRaw = parsed.values.get('view');
    let view: ReadViewKind;
    if (command === 'resume') view = 'resume';
    else if (viewRaw !== undefined) view = viewRaw as ReadViewKind;
    else if (parsed.values.has('from')) view = 'structure';
    else if (nodeIds.length > 0) view = 'content';
    else view = 'overview';

    const heading = parsed.values.get('from-heading');
    if (parsed.values.has('occurrence') && heading === undefined) {
      throw usageFailure('--occurrence 必须与 --from-heading 一起使用', {
        details: { field: 'occurrence' },
        usage: spec.usage[0],
      });
    }
    if (view !== 'content' && view !== 'resume') {
      for (const forbidden of ['start', 'length', 'full', 'from-heading', 'occurrence', 'meta']) {
        if (parsed.values.has(forbidden)) {
          throw usageFailure('--' + forbidden + ' 只用于 content 读取', {
            details: { field: forbidden },
            usage: spec.usage[0],
          });
        }
      }
    }
    if (view === 'overview' && (nodeIds.length > 0 || parsed.values.has('from'))) {
      throw usageFailure('overview 不接受 --node／--from', { usage: spec.usage[0] });
    }
    if (view === 'structure' && nodeIds.length > 0) {
      throw usageFailure('--node 只用于 content 读取', { usage: spec.usage[0] });
    }
    if (view === 'content' && parsed.values.has('from')) {
      throw usageFailure('--from 只用于 structure 读取', { usage: spec.usage[0] });
    }

    let topicReference = parsed.values.get('topic') ?? parsed.positional[0];
    if (view === 'resume') {
      const anchor = nodeIds[0];
      if (anchor === undefined) {
        throw usageFailure('resume 需要 --node <anchorId> 作为续谈锚点', { usage: spec.usage[0] });
      }
      if (topicReference === undefined) {
        topicReference = nodeOf(snapshot, anchor).topicId;
      }
    } else if (view === 'content') {
      if (nodeIds.length === 0) {
        throw usageFailure('content 读取需要 --node <id>', { usage: spec.usage[0] });
      }
      if (topicReference === undefined) topicReference = nodeOf(snapshot, nodeIds[0] as string).topicId;
    } else if (view === 'structure') {
      const from = parsed.values.get('from');
      if (from !== undefined && topicReference === undefined) {
        topicReference = nodeOf(snapshot, from).topicId;
      }
    }
    if (topicReference === undefined) {
      throw usageFailure('缺少主题：aichat read <topicId|key> 或 --topic', { usage: spec.usage[0] });
    }
    const topicId = resolveTopicId(snapshot, topicReference);
    const start = integerOption(parsed, spec, 'start', { min: 0 });
    const length = integerOption(parsed, spec, 'length', { min: 1, max: 16_000 });
    const occurrence = integerOption(parsed, spec, 'occurrence', { min: 0 });
    const from = parsed.values.get('from');
    const anchor = view === 'resume' ? nodeIds[0] : undefined;
    const request: ReadRequest = {
      view,
      topicId,
      budget,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(nodeIds.length > 0 ? { nodeIds } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
      ...(start !== undefined ? { start } : {}),
      ...(length !== undefined ? { length } : {}),
      ...(flag(parsed, 'full') ? { full: true } : {}),
      ...(heading !== undefined ? { section: heading } : {}),
      ...(occurrence !== undefined ? { sectionIndex: occurrence } : {}),
      ...(flag(parsed, 'meta') ? { meta: true } : {}),
    };
    return finalizeReadBudget(readView(snapshot, request, 'database') as unknown as Record<string, unknown>);
  });
}

async function runTopics(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  return withWorkspaceStore(spec, parsed, runtime, ({ snapshot }) => ({
    ok: true,
    command: 'topics',
    workspaceId: snapshot.workspaceId,
    revision: snapshot.revision,
    topics: snapshot.topics.map((topic) => ({
      topicId: topic.id,
      key: topic.key,
      title: topic.title,
      nodeCount: topic.nodeIds.length,
      revision: topic.revision,
      lastChangeAt: topic.lastChangeAt,
    })),
    diagnostics: [],
  }));
}

async function runValidate(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  return withWorkspaceStore(spec, parsed, runtime, ({ snapshot }) => ({
    ok: true,
    command: 'validate',
    workspaceId: snapshot.workspaceId,
    revision: snapshot.revision,
    topics: snapshot.topics.length,
    nodes: snapshot.nodes.length,
    diagnostics: [],
  }));
}

async function runSearch(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  return withWorkspaceStore(spec, parsed, runtime, ({ snapshot }) => {
    const query = parsed.positional[0] as string;
    const limit = integerOption(parsed, spec, 'limit', { min: 1, max: 100 }) ?? 10;
    const page = integerOption(parsed, spec, 'page', { min: 0 }) ?? 0;
    const topicReference = parsed.values.get('topic');
    const topicId = topicReference !== undefined ? resolveTopicId(snapshot, topicReference) : undefined;
    const nodes = topicId !== undefined ? snapshot.nodes.filter((node) => node.topicId === topicId) : snapshot.nodes;
    const documents: SearchDocument[] = nodes.map((node) => ({
      id: node.id,
      topicId: node.topicId,
      title: node.title,
      summary: node.summary ?? derivedSummary(node.body),
      number: node.number,
      path: '',
      body: node.body,
    }));
    const outcome = searchDocuments(documents, query, { limit, offset: page * limit });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const hits: SearchHit[] = outcome.hits.map((hit) => ({
      nodeId: hit.nodeId,
      topicId: hit.topicId,
      title: hit.title,
      snippet: hit.snippet,
      field: hit.field,
      revision: byId.get(hit.nodeId)?.revision ?? 0,
    }));
    return {
      ok: true,
      command: 'search',
      source: 'database',
      workspaceId: snapshot.workspaceId,
      query,
      hits,
      page,
      limit,
      totalHits: outcome.totalHits,
      hasMore: outcome.truncated,
      truncated: outcome.truncated,
      diagnostics: [],
    };
  });
}

async function runEdit(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  return performWrite('edit', spec, parsed, runtime, (snapshot) => buildEditAction(spec, parsed, runtime, snapshot));
}

async function runImportant(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const on = flag(parsed, 'on');
  const off = flag(parsed, 'off');
  if (on === off) {
    throw usageFailure('important 需要且只能给一个 --on 或 --off', {
      details: { field: on ? 'off' : 'on' },
      usage: spec.usage[0],
    });
  }
  const nodeId = requireValue(parsed, spec, 'node');
  const revision = integerOption(parsed, spec, 'if-revision');
  return performWrite('important', spec, parsed, runtime, () => ({
    action: 'setImportance',
    nodeId,
    important: on,
    ...(revision !== undefined ? { revision } : {}),
  }));
}

async function runNextOrBranch(command: 'next' | 'branch', spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const fromNode = requireValue(parsed, spec, 'from-node');
  const fromRevision = integerOption(parsed, spec, 'from-revision', { required: true }) as number;
  const title = requireValue(parsed, spec, 'title');
  const description = requireValue(parsed, spec, 'description');
  const body = await readBodyForCreate(parsed, runtime, spec);
  return performWrite(command, spec, parsed, runtime, () => ({
    action: command === 'next' ? 'createNext' : 'createBranch',
    from: { id: fromNode, revision: fromRevision },
    description,
    node: nodeCreateFrom(parsed, body, { title, allowSide: command === 'branch' }),
  }));
}

async function runInsert(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const afterNode = requireValue(parsed, spec, 'after-node');
  const afterRevision = integerOption(parsed, spec, 'after-revision', { required: true }) as number;
  const beforeNode = requireValue(parsed, spec, 'before-node');
  const beforeRevision = integerOption(parsed, spec, 'before-revision', { required: true }) as number;
  const title = requireValue(parsed, spec, 'title');
  const description = requireValue(parsed, spec, 'description');
  const nextDescription = requireValue(parsed, spec, 'next-description');
  const body = await readBodyForCreate(parsed, runtime, spec);
  return performWrite('insert', spec, parsed, runtime, () => ({
    action: 'insert',
    after: { id: afterNode, revision: afterRevision },
    before: { id: beforeNode, revision: beforeRevision },
    description,
    nextDescription,
    node: nodeCreateFrom(parsed, body, { title }),
  }));
}

async function runDelete(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const nodeId = requireValue(parsed, spec, 'node');
  const revision = integerOption(parsed, spec, 'if-revision', { required: true }) as number;
  return performWrite('delete', spec, parsed, runtime, () => ({
    action: 'delete',
    target: { id: nodeId, revision },
  }));
}

async function runCreateTopic(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const topicTitle = requireValue(parsed, spec, 'title');
  const key = parsed.values.get('key');
  const rootTitle = parsed.values.get('root-title') ?? topicTitle;
  const body = await readBodyForCreate(parsed, runtime, spec);
  return performWrite('create-topic', spec, parsed, runtime, () => ({
    action: 'createTopic',
    ...(key !== undefined ? { key } : {}),
    topicTitle,
    node: { title: rootTitle, body },
  }));
}

async function runBatch(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const input = await readJsonInput(parsed, runtime, spec);
  const action = await convertBatchInput(parseJsonText(input.text, input.sourcePath, 'batch'), input.baseDir, spec);
  const dryRun = flag(parsed, 'dry-run');
  const prepared = await withWorkspaceStore(spec, parsed, runtime, async ({ root, snapshot }): Promise<PreparedWrite> => ({
    root,
    workspaceId: snapshot.workspaceId,
    action,
  }));
  const deps = serviceDeps(runtime, parsed);
  const service = await resolveService(prepared.root, prepared.workspaceId, deps);
  const result = await submitAgentChange(service, action, deps, undefined, dryRun ? { dryRun: true } : {});
  const verbose = flag(parsed, 'verbose');
  if (dryRun) {
    return dryRunPayload('batch', result.response as AgentCheckResponse, {
      httpStatus: result.httpStatus,
      verbose,
    });
  }
  return writePayload('batch', result.response as AgentChangeResponse, {
    httpStatus: result.httpStatus,
    verbose,
  });
}

async function runRearrange(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const inputPath = requireValue(parsed, spec, 'input');
  const absolute = path.resolve(runtime.cwd, inputPath);
  let text: string;
  try {
    text = await fs.readFile(absolute, 'utf8');
  } catch {
    throw usageFailure('无法读取 --input 文件：' + absolute, { details: { field: 'input', path: absolute } });
  }
  const raw = ensureRecord(parseJsonText(text, absolute, 'rearrange'), 'rearrange 输入');
  const editsRaw = raw['edits'];
  if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
    throw usageFailure('rearrange 输入的 edits 必须是非空数组', { details: { field: 'edits' } });
  }
  const edits: AgentRearrangeEdit[] = editsRaw.map((entry, index) => {
    const label = 'edits[' + String(index) + ']';
    const record = ensureRecord(entry, label);
    const target = ensureExistingSelector(record['target'], label + '.target');
    const from = ensureExistingSelector(record['from'], label + '.from');
    const flowRaw = record['flow'];
    if (flowRaw !== 'next' && flowRaw !== 'branch') {
      throw usageFailure(label + '.flow 只能是 next／branch', { details: { field: label + '.flow' } });
    }
    const description = ensureString(record, 'description', label);
    let order: number | undefined;
    if (record['order'] !== undefined) {
      if (typeof record['order'] !== 'number' || !Number.isInteger(record['order']) || record['order'] < 0) {
        throw usageFailure(label + '.order 必须是非负整数', { details: { field: label + '.order' } });
      }
      order = record['order'];
    }
    const edit: AgentRearrangeEdit = { target, from, flow: flowRaw, description };
    if (order !== undefined) edit.order = order;
    return edit;
  });
  return performWrite('rearrange', spec, parsed, runtime, () => ({ action: 'rearrange', edits }));
}

function ensureExistingSelector(value: unknown, label: string): { id: string; revision: number } {
  const record = ensureRecord(value, label);
  const id = record['id'];
  const revision = record['revision'];
  if (typeof id !== 'string' || id.length === 0) {
    throw usageFailure(label + '.id 必须是非空字符串', { details: { field: label + '.id' } });
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw usageFailure(label + '.revision 必须是非负整数', { details: { field: label + '.revision' } });
  }
  return { id, revision };
}

function ensureSelector(value: unknown, label: string): { id: string; revision: number } | { local: string } {
  const record = ensureRecord(value, label);
  const hasId = record['id'] !== undefined;
  const hasLocal = record['local'] !== undefined;
  if ((hasId ? 1 : 0) + (hasLocal ? 1 : 0) !== 1) {
    throw usageFailure(label + ' 必须且只能给 {id,revision} 或 {local}', { details: { field: label } });
  }
  if (hasLocal) {
    const local = record['local'];
    if (typeof local !== 'string' || local.length === 0) {
      throw usageFailure(label + '.local 必须是非空字符串', { details: { field: label + '.local' } });
    }
    return { local };
  }
  return ensureExistingSelector(value, label);
}

async function convertPatchInput(
  value: unknown,
  baseDir: string,
  label: string,
): Promise<NodePatch> {
  const record = ensureRecord(value, label);
  const allowed = new Set(['title', 'state', 'summary', 'body', 'append', 'replace', 'important', 'incoming', 'bodyFile', 'appendFile', 'replaceFile']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw usageFailure(label + ' 未知字段：' + key, { details: { field: label + '.' + key } });
    }
  }
  const io = { baseDir };
  const inlineBody = typeof record['body'] === 'string' ? record['body'] : undefined;
  const bodyFile = record['bodyFile'];
  const append = typeof record['append'] === 'string' ? record['append'] : undefined;
  const appendFile = record['appendFile'];
  const inlineReplace = record['replace'];
  const replaceFile = record['replaceFile'];
  const sources = [
    inlineBody !== undefined || bodyFile !== undefined,
    append !== undefined || appendFile !== undefined,
    inlineReplace !== undefined || replaceFile !== undefined,
  ].filter(Boolean).length;
  if (sources > 1) {
    throw usageFailure(label + ' 的正文模式互斥（body／append／replace）', { details: { field: label } });
  }
  if (inlineBody !== undefined && bodyFile !== undefined) {
    throw usageFailure(label + ' 的 body 与 bodyFile 互斥', { details: { field: label + '.body' } });
  }
  let body = inlineBody;
  if (bodyFile !== undefined) {
    if (typeof bodyFile !== 'string') throw usageFailure(label + '.bodyFile 必须是字符串', { details: { field: label + '.bodyFile' } });
    body = await readRelativeText(io.baseDir, bodyFile, label + '.bodyFile');
  }
  let appendText = append;
  if (appendFile !== undefined) {
    if (typeof appendFile !== 'string') throw usageFailure(label + '.appendFile 必须是字符串', { details: { field: label + '.appendFile' } });
    appendText = await readRelativeText(io.baseDir, appendFile, label + '.appendFile');
  }
  let replacePairs: Array<{ old: string; new: string }> | undefined;
  if (inlineReplace !== undefined) {
    replacePairs = parseReplaceValue(inlineReplace, label + '.replace');
  } else if (replaceFile !== undefined) {
    if (typeof replaceFile !== 'string') throw usageFailure(label + '.replaceFile 必须是字符串', { details: { field: label + '.replaceFile' } });
    replacePairs = parseReplacePairs(await readRelativeText(io.baseDir, replaceFile, label + '.replaceFile'), label + '.replaceFile');
  }
  const title = record['title'];
  if (title !== undefined && typeof title !== 'string') {
    throw usageFailure(label + '.title 必须是字符串', { details: { field: label + '.title' } });
  }
  const state = record['state'];
  if (state !== undefined && state !== 'agreed' && state !== 'proposed' && state !== 'reference') {
    throw usageFailure(label + '.state 只能是 agreed／proposed／reference', { details: { field: label + '.state' } });
  }
  let summary: string | null | undefined;
  if ('summary' in record) {
    const value = record['summary'];
    if (value !== null && typeof value !== 'string') {
      throw usageFailure(label + '.summary 必须是字符串或 null', { details: { field: label + '.summary' } });
    }
    summary = value as string | null;
  }
  const important = record['important'];
  if (important !== undefined && typeof important !== 'boolean') {
    throw usageFailure(label + '.important 必须是布尔值', { details: { field: label + '.important' } });
  }
  const incoming = record['incoming'] !== undefined ? convertIncoming(record['incoming'], label + '.incoming') : undefined;
  const patch: NodePatch = {};
  if (title !== undefined) patch.title = title;
  if (state !== undefined) patch.state = state as NonNullable<NodePatch['state']>;
  if (summary !== undefined) patch.summary = summary;
  if (body !== undefined) patch.body = body;
  if (appendText !== undefined) patch.append = appendText;
  if (replacePairs !== undefined) patch.replace = replacePairs;
  if (important !== undefined) patch.important = important;
  if (incoming !== undefined) patch.incoming = incoming;
  if (Object.keys(patch).length === 0) {
    throw usageFailure(label + ' 至少要给一处修改', { details: { field: label } });
  }
  return patch;
}

function parseReplaceValue(value: unknown, label: string): Array<{ old: string; new: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw usageFailure(label + ' 必须是非空数组', { details: { field: label } });
  }
  return value.map((entry, index) => {
    const record = ensureRecord(entry, label + '[' + String(index) + ']');
    const old = record['old'];
    const replacement = record['new'];
    if (typeof old !== 'string' || old.length === 0 || typeof replacement !== 'string') {
      throw usageFailure(label + '[' + String(index) + '] 的 old 必须非空、new 必须是字符串', {
        details: { field: label + '[' + String(index) + ']' },
      });
    }
    return { old, new: replacement };
  });
}

function convertIncoming(value: unknown, label: string): IncomingPatch {
  const record = ensureRecord(value, label);
  const allowed = new Set(['from', 'flow', 'description', 'order']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw usageFailure(label + ' 未知字段：' + key, { details: { field: label + '.' + key } });
    }
  }
  const incoming: IncomingPatch = {};
  if (record['from'] !== undefined) {
    incoming.from = ensureExistingSelector(record['from'], label + '.from');
  }
  if (record['flow'] !== undefined) {
    const flow = record['flow'];
    if (flow !== 'next' && flow !== 'branch') {
      throw usageFailure(label + '.flow 只能是 next／branch', { details: { field: label + '.flow' } });
    }
    incoming.flow = flow;
  }
  if (record['description'] !== undefined) {
    const description = record['description'];
    if (typeof description !== 'string' || description.length === 0) {
      throw usageFailure(label + '.description 必须是非空字符串', { details: { field: label + '.description' } });
    }
    incoming.description = description;
  }
  if (record['order'] !== undefined) {
    const order = record['order'];
    if (typeof order !== 'number' || !Number.isInteger(order) || order < 0) {
      throw usageFailure(label + '.order 必须是非负整数', { details: { field: label + '.order' } });
    }
    incoming.order = order;
  }
  if (record['from'] !== undefined && (incoming.flow === undefined || incoming.description === undefined)) {
    throw usageFailure(label + '.from 出现时必须同时给 flow 与 description', {
      details: { field: label + '.from' },
    });
  }
  if ((incoming.flow !== undefined || incoming.from !== undefined) && incoming.description === undefined) {
    throw usageFailure(label + ' 修改入边时必须给 description', { details: { field: label + '.description' } });
  }
  return incoming;
}

async function readRelativeText(baseDir: string, relative: string, label: string): Promise<string> {
  const absolute = path.resolve(baseDir, relative);
  try {
    return await fs.readFile(absolute, 'utf8');
  } catch {
    throw usageFailure('无法读取 ' + label + '：' + absolute, { details: { field: label, path: absolute } });
  }
}

function convertCreateNode(value: unknown, label: string): { node: NodeCreate; bodyFile: string | undefined } {
  const record = ensureRecord(value, label);
  const allowed = new Set(['title', 'body', 'bodyFile', 'summary', 'state', 'important', 'side', 'order']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw usageFailure(label + ' 未知字段：' + key, { details: { field: label + '.' + key } });
    }
  }
  const title = ensureString(record, 'title', label);
  const inlineBody = typeof record['body'] === 'string' ? record['body'] : undefined;
  const bodyFile = typeof record['bodyFile'] === 'string' ? record['bodyFile'] : undefined;
  if ((inlineBody === undefined) === (bodyFile === undefined)) {
    throw usageFailure(label + ' 的 body 与 bodyFile 必须且只能给一个', { details: { field: label + '.body' } });
  }
  const node: NodeCreate = { title, body: inlineBody ?? '' };
  if (record['summary'] !== undefined) {
    if (typeof record['summary'] !== 'string') {
      throw usageFailure(label + '.summary 必须是字符串', { details: { field: label + '.summary' } });
    }
    node.summary = record['summary'];
  }
  if (record['state'] !== undefined) {
    const state = record['state'];
    if (state !== 'agreed' && state !== 'proposed' && state !== 'reference') {
      throw usageFailure(label + '.state 只能是 agreed／proposed／reference', { details: { field: label + '.state' } });
    }
    node.state = state;
  }
  if (record['important'] !== undefined) {
    if (typeof record['important'] !== 'boolean') {
      throw usageFailure(label + '.important 必须是布尔值', { details: { field: label + '.important' } });
    }
    node.important = record['important'];
  }
  if (record['side'] !== undefined) {
    const side = record['side'];
    if (side !== 'left' && side !== 'right') {
      throw usageFailure(label + '.side 只能是 left／right', { details: { field: label + '.side' } });
    }
    node.side = side;
  }
  if (record['order'] !== undefined) {
    const order = record['order'];
    if (typeof order !== 'number' || !Number.isInteger(order) || order < 0) {
      throw usageFailure(label + '.order 必须是非负整数', { details: { field: label + '.order' } });
    }
    node.order = order;
  }
  return { node, bodyFile };
}

async function convertBatchInput(raw: unknown, baseDir: string, spec: CommandSpec): Promise<AgentBatchAction> {
  const record = ensureRecord(raw, 'batch 输入');
  const allowed = new Set(['topicId', 'ops']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw usageFailure('batch 输入未知字段：' + key, { details: { field: key }, usage: spec.usage[0] });
    }
  }
  const topicId = ensureString(record, 'topicId', 'batch 输入');
  const opsRaw = record['ops'];
  if (!Array.isArray(opsRaw) || opsRaw.length === 0) {
    throw usageFailure('batch 输入的 ops 必须是非空数组', { details: { field: 'ops' } });
  }
  const ops: AgentBatchOp[] = [];
  for (const [index, entry] of opsRaw.entries()) {
    const label = 'ops[' + String(index) + ']';
    const opRecord = ensureRecord(entry, label);
    const kind = opRecord['op'];
    if (kind === 'edit') {
      for (const key of Object.keys(opRecord)) {
        if (key !== 'op' && key !== 'target' && key !== 'patch') {
          throw usageFailure(label + ' 未知字段：' + key, { details: { field: label + '.' + key } });
        }
      }
      const target = ensureExistingSelector(opRecord['target'], label + '.target');
      const patch = await convertPatchInput(opRecord['patch'], baseDir, label + '.patch');
      const edit: AgentEditOp = { op: 'edit', target, patch };
      ops.push(edit);
      continue;
    }
    if (kind === 'create') {
      for (const key of Object.keys(opRecord)) {
        if (!['op', 'as', 'from', 'flow', 'description', 'node'].includes(key)) {
          throw usageFailure(label + ' 未知字段：' + key, { details: { field: label + '.' + key } });
        }
      }
      const asName = ensureString(opRecord, 'as', label);
      const from = ensureSelector(opRecord['from'], label + '.from');
      const flow = opRecord['flow'];
      if (flow !== 'next' && flow !== 'branch') {
        throw usageFailure(label + '.flow 只能是 next／branch', { details: { field: label + '.flow' } });
      }
      const description = ensureString(opRecord, 'description', label);
      const converted = convertCreateNode(opRecord['node'], label + '.node');
      const node = converted.node;
      if (converted.bodyFile !== undefined) {
        node.body = await readRelativeText(baseDir, converted.bodyFile, label + '.node.bodyFile');
      }
      if (flow === 'next' && (node.side !== undefined || node.order !== undefined)) {
        throw usageFailure(label + ' 的 flow=next 不能带 side／order', {
          details: { field: label + '.node' },
        });
      }
      const create: AgentCreateOp = { op: 'create', as: asName, from, flow, description, node };
      ops.push(create);
      continue;
    }
    if (kind === 'delete') {
      for (const key of Object.keys(opRecord)) {
        if (key !== 'op' && key !== 'target') {
          throw usageFailure(label + ' 未知字段：' + key, { details: { field: label + '.' + key } });
        }
      }
      const target = ensureExistingSelector(opRecord['target'], label + '.target');
      const deletion: AgentDeleteOp = { op: 'delete', target };
      ops.push(deletion);
      continue;
    }
    throw usageFailure(label + '.op 只能是 edit／create／delete，收到 ' + String(kind), {
      details: { field: label + '.op' },
    });
  }
  return { action: 'batch', topicId, ops };
}

/* ------------------------------------------------------------------ *
 * 占位：以下函数在下一段实现（保持文件结构可读）
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 工作区/元命令
 * ------------------------------------------------------------------ */

async function runInit(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const target = parsed.positional[0] as string;
  const requestedRoot = path.resolve(runtime.cwd, target);
  const name = parsed.values.get('name') ?? path.basename(requestedRoot);
  let store: GraphStore;
  try {
    store = GraphStore.create(requestedRoot, name);
  } catch (error) {
    throw mapDomainError(error, spec);
  }
  try {
    const snapshot = store.snapshot();
    const root = await fs.realpath(requestedRoot);
    return {
      ok: true,
      command: 'init',
      root,
      dbPath: store.dbPath,
      workspaceId: snapshot.workspaceId,
      name: snapshot.name,
      schemaVersion: 1,
    };
  } finally {
    store.close();
  }
}

async function runImport(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const workspaceRaw = parsed.values.get('workspace');
  if (workspaceRaw === undefined) {
    throw usageFailure('import 需要 --workspace <旧版工作区目录>', {
      details: { field: 'workspace' },
      usage: spec.usage[0],
    });
  }
  const sourceRoot = path.resolve(runtime.cwd, workspaceRaw);
  const moduleSpecifier: string = './import.js';
  let loaded: { importV2?: (root: string, name?: string) => Promise<Record<string, unknown>> } | null = null;
  try {
    loaded = (await import(moduleSpecifier)) as { importV2?: (root: string, name?: string) => Promise<Record<string, unknown>> };
  } catch {
    loaded = null;
  }
  if (loaded === null || typeof loaded.importV2 !== 'function') {
    throw new CliFailure(
      'IMPORT_UNAVAILABLE',
      '旧版导入模块不可用（src/next/import.ts／dist/next/import.js 尚未提供）；请先构建导入模块',
      EXIT_CODES.service,
      { details: { sourceRoot } },
    );
  }
  const name = parsed.values.get('name');
  const result = await loaded.importV2(sourceRoot, name);
  return { ok: true, command: 'import', ...result };
}

interface GraphServiceHandle {
  readonly url: string;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly revision: number;
  readonly closed: Promise<void>;
  stop: () => Promise<void>;
}

interface StartGraphServiceOptions {
  readonly root: string;
  readonly port?: number;
  readonly host?: string;
  readonly webRoot?: string | null;
  readonly offlineDirectory?: string;
  readonly appRoot?: string;
}

type StartGraphService = (options: StartGraphServiceOptions) => Promise<GraphServiceHandle>;

interface RuntimeModule {
  readonly startGraphService?: StartGraphService;
}

async function runServe(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const resolution = await resolveCliWorkspace(parsed, runtime);
  // 显式 --port 才传端口；否则由服务读取 .aichat/local/runtime.json 的端口偏好。
  const explicitPort = integerOption(parsed, spec, 'port', { min: 0, max: 65_535 });
  // startGraphService 在 server.js（runtime.js 只导出 GraphRuntime 等，避免循环依赖）。
  const moduleSpecifier: string = './server.js';
  const moduleUnknown: unknown = await import(moduleSpecifier).catch(() => null);
  const runtimeModule = moduleUnknown as RuntimeModule | null;
  const start = runtimeModule === null ? undefined : runtimeModule.startGraphService;
  if (start === undefined) {
    throw new CliFailure(
      'SERVICE_UNAVAILABLE',
      '服务运行时不可用（src/next/runtime.ts／dist/next/runtime.js 尚未提供或未导出 startGraphService）',
      EXIT_CODES.service,
      { details: { root: resolution.root } },
    );
  }
  const handle = await start({
    root: resolution.root,
    ...(explicitPort !== undefined ? { port: explicitPort } : {}),
  });
  // 收到 SIGINT 或服务被 --stop/页面正常关闭，都要让 serve 进程正常退出。
  // 只等信号会在外部 stop 后留下未完成的 top-level await（Node 退出码 13）。
  await Promise.race([waitForSignal(runtime), handle.closed]);
  await handle.stop();
  return {
    ok: true,
    command: 'serve',
    root: resolution.root,
    url: handle.url,
    workspaceId: handle.workspaceId,
    instanceId: handle.instanceId,
    revision: handle.revision,
    state: 'stopped',
  };
}

function waitForSignal(runtime: CliRuntime): Promise<void> {
  const signal = runtime.shutdownSignal;
  if (signal !== undefined) {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve();
    };
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
  });
}

/* ------------------------------------------------------------------ *
 * open / stop：安装布局、原生选择器、服务复用与运行控制
 * ------------------------------------------------------------------ */

interface InspectedWorkspace {
  readonly root: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly revision: number;
  readonly initialized: boolean;
}

function openServiceDeps(runtime: CliRuntime): ServiceDeps {
  // 不强制 installation.cliJsPath：源码运行时 argv[1] 才是当前 CLI 入口，
  // 自启动必须与当前进程同一构建，不能抓一个可能过期的 dist 文件。
  const entryPath = runtime.entryPath;
  return defaultServiceDeps({
    fetchImpl: runtime.fetchImpl,
    spawnImpl: runtime.spawnImpl,
    sleep: runtime.sleep,
    startTimeoutMs: runtime.startTimeoutMs,
    pollIntervalMs: runtime.pollIntervalMs,
    noStart: false,
    requireInterface: true,
    ...(entryPath !== undefined ? { entryPath } : {}),
  });
}

function stopServiceDeps(runtime: CliRuntime): ServiceDeps {
  return defaultServiceDeps({
    fetchImpl: runtime.fetchImpl,
    spawnImpl: runtime.spawnImpl,
    sleep: runtime.sleep,
    startTimeoutMs: runtime.startTimeoutMs,
    pollIntervalMs: runtime.pollIntervalMs,
    noStart: true,
    // 旧服务也要尝试 POST /api/runtime/stop：由 404 给出明确「不支持」错误。
    requireInterface: false,
  });
}

/** 打开/校验库目录；只有 allowInit（原生选择器选中的空目录）才会 init。 */
async function inspectWorkspace(
  runtime: CliRuntime,
  rawRoot: string,
  options: { readonly allowInit: boolean },
): Promise<InspectedWorkspace> {
  const root = await canonicalRoot(path.resolve(runtime.cwd, rawRoot));
  const distributionRoot = await canonicalRoot(path.resolve(runtime.installation.distributionRoot));
  if (isPathInside(distributionRoot, root)) {
    throw workspaceFailure(
      'WORKSPACE_FORBIDDEN',
      '不要把讨论库放进程序目录：' +
        root +
        ' 位于程序目录 ' +
        distributionRoot +
        ' 内；请选择程序目录之外的目录（例如“文档”或临时目录）。',
      { root, distributionRoot, hint: '讨论库、默认配置与启动日志不能放在安装／分发根内。' },
    );
  }
  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    throw workspaceFailure('WORKSPACE_NOT_FOUND', '工作区目录不存在：' + root, { root });
  }
  if (!stat.isDirectory()) {
    throw workspaceFailure('WORKSPACE_NOT_FOUND', '工作区不是目录：' + root, { root });
  }
  const dbPath = path.join(root, 'graph.sqlite');
  if (!existsSync(dbPath)) {
    if (!options.allowInit) {
      throw workspaceFailure(
        'WORKSPACE_NOT_FOUND',
        '工作区没有 graph.sqlite：' + root + '（不会自动初始化；请先 aichat init，或用 --choose-workspace 选择空目录；旧版 Markdown 资料请先 aichat import）',
        { root, dbPath },
      );
    }
    const entries = await fs.readdir(root);
    if (entries.length > 0) {
      throw workspaceFailure(
        'WORKSPACE_NOT_FOUND',
        '选中目录非空且没有 graph.sqlite；不会自动初始化：' + root + '（旧版 Markdown 资料请先 aichat import --workspace <该目录>）',
        { root, dbPath, entries: entries.slice(0, 20) },
      );
    }
    let created: GraphStore;
    try {
      created = GraphStore.create(root, path.basename(root));
    } catch (error) {
      throw mapDomainError(error);
    }
    try {
      const snapshot = created.snapshot();
      return {
        root,
        workspaceId: snapshot.workspaceId,
        name: snapshot.name,
        revision: snapshot.revision,
        initialized: true,
      };
    } finally {
      created.close();
    }
  }
  let store: GraphStore;
  try {
    store = GraphStore.open(root, { readonly: true });
  } catch (error) {
    throw mapDomainError(error);
  }
  try {
    const snapshot = store.snapshot();
    return {
      root,
      workspaceId: snapshot.workspaceId,
      name: snapshot.name,
      revision: snapshot.revision,
      initialized: false,
    };
  } finally {
    store.close();
  }
}

type PickWorkspaceResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly root: string };

/** 原生目录选择器：--pick-workspace，stdout 为 UTF-8 路径；取消 exit 2，错误 exit 1。 */
async function pickWorkspace(runtime: CliRuntime): Promise<PickWorkspaceResult> {
  const launcher = runtime.installation.launcherPath;
  let outcome: ProcessOutcome;
  try {
    outcome = await runtime.runProcess(launcher, ['--pick-workspace'], {
      cwd: runtime.cwd,
      windowsHide: false,
    });
  } catch (error) {
    throw new CliFailure(
      'PICKER_UNAVAILABLE',
      '无法启动原生目录选择器（' +
        launcher +
        '）：' +
        (error instanceof Error ? error.message : String(error)) +
        '；请改用 --workspace <dir>',
      EXIT_CODES.service,
      { details: { launcher } },
    );
  }
  if (outcome.code === 2) return { cancelled: true };
  if (outcome.code !== 0) {
    throw new CliFailure(
      'PICKER_FAILED',
      '原生目录选择器失败（exit ' + String(outcome.code) + '）：' +
        outcome.stderr.trim().slice(0, 500),
      EXIT_CODES.service,
      { details: { launcher, exitCode: outcome.code, stderr: outcome.stderr.slice(0, 2000) } },
    );
  }
  const lines = outcome.stdout
    .replace(/\uFEFF/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.length > 0 ? (lines[lines.length - 1] as string) : '';
  if (last.length === 0) {
    throw new CliFailure(
      'PICKER_FAILED',
      '原生目录选择器没有返回路径（exit 0）',
      EXIT_CODES.service,
      { details: { launcher, stdout: outcome.stdout.slice(0, 500) } },
    );
  }
  const unquoted =
    (last.startsWith('"') && last.endsWith('"')) || (last.startsWith("'") && last.endsWith("'"))
      ? last.slice(1, -1)
      : last;
  return { cancelled: false, root: path.resolve(runtime.cwd, unquoted) };
}

async function resolveOpenWorkspace(
  spec: CommandSpec,
  parsed: ParsedArgs,
  runtime: CliRuntime,
): Promise<{ readonly cancelled: true } | { readonly cancelled: false; readonly workspace: InspectedWorkspace }> {
  const choose = flag(parsed, 'choose-workspace');
  const interactive = flag(parsed, 'interactive');
  const explicit = parsed.values.get('workspace');
  if (choose && !interactive) {
    throw usageFailure('--choose-workspace 需要 --interactive：目录选择器只在交互模式弹出', {
      details: { field: 'choose-workspace' },
      usage: spec.usage[0],
    });
  }
  if (choose && explicit !== undefined) {
    throw usageFailure('--choose-workspace 与 --workspace 不能同时使用', {
      details: { field: 'choose-workspace' },
      usage: spec.usage[0],
    });
  }
  if (choose) {
    const picked = await pickWorkspace(runtime);
    if (picked.cancelled) return { cancelled: true };
    return { cancelled: false, workspace: await inspectWorkspace(runtime, picked.root, { allowInit: true }) };
  }
  if (explicit !== undefined) {
    return { cancelled: false, workspace: await inspectWorkspace(runtime, explicit, { allowInit: false }) };
  }
  const config = await readDefaultConfig(runtime.configPath);
  if (config !== null) {
    return {
      cancelled: false,
      workspace: await inspectWorkspace(runtime, config.workspace, { allowInit: false }),
    };
  }
  if (interactive) {
    const picked = await pickWorkspace(runtime);
    if (picked.cancelled) return { cancelled: true };
    return { cancelled: false, workspace: await inspectWorkspace(runtime, picked.root, { allowInit: true }) };
  }
  throw workspaceFailure(
    'WORKSPACE_NOT_CONFIGURED',
    '没有默认库：请运行 aichat open --choose-workspace --interactive 选择，或 aichat open --workspace <dir>',
    { configPath: runtime.configPath },
  );
}

async function openBrowser(runtime: CliRuntime, url: string): Promise<boolean> {
  const launcher = runtime.installation.launcherPath;
  try {
    if (existsSync(launcher)) {
      await runtime.runProcess(launcher, ['--open-url', url], { detached: true });
      return true;
    }
    if (process.platform === 'win32') {
      // 用完整名 cmd.exe：CreateProcess 对 'cmd' 的解析依赖 PATH/App Paths。
      await runtime.runProcess('cmd.exe', ['/c', 'start', '', url], { detached: true });
      return true;
    }
    if (process.platform === 'darwin') {
      await runtime.runProcess('open', [url], { detached: true });
      return true;
    }
    await runtime.runProcess('xdg-open', [url], { detached: true });
    return true;
  } catch {
    return false;
  }
}

async function runOpen(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const resolved = await resolveOpenWorkspace(spec, parsed, runtime);
  if (resolved.cancelled) {
    return { ok: true, command: 'open', state: 'cancelled' };
  }
  const workspace = resolved.workspace;
  const deps = openServiceDeps(runtime);
  const ensured = await ensureService(workspace.root, workspace.workspaceId, deps);
  const service = ensured.service;
  await saveDefaultWorkspace(runtime.configPath, workspace.root);
  if (!flag(parsed, 'no-browser')) {
    const opened = await openBrowser(runtime, service.baseUrl);
    if (!opened) {
      await writeStartupLog(
        runtime.installation,
        'open: 服务已就绪但无法打开浏览器（' + service.baseUrl + '）；可手动打开该地址。',
      );
    }
  }
  return {
    ok: true,
    command: 'open',
    state: 'opened',
    workspaceId: service.workspaceId,
    workspace: workspace.root,
    url: service.baseUrl,
    instanceId: service.instanceId,
    reused: ensured.reused,
    program: service.program ?? programInfo(),
  };
}

interface StopWorkspace {
  readonly root: string;
  readonly workspaceId: string;
}

async function resolveStopWorkspace(
  spec: CommandSpec,
  parsed: ParsedArgs,
  runtime: CliRuntime,
): Promise<StopWorkspace> {
  const explicit = parsed.values.get('workspace');
  let rawRoot = explicit;
  if (rawRoot === undefined) {
    const config = await readDefaultConfig(runtime.configPath);
    rawRoot = config?.workspace;
  }
  if (rawRoot === undefined) {
    throw workspaceFailure('WORKSPACE_NOT_CONFIGURED', '没有可停止的默认库：请用 aichat stop --workspace <dir>', {
      configPath: runtime.configPath,
      ...(spec.usage.length > 0 ? { usage: spec.usage[0] } : {}),
    });
  }
  const workspace = await inspectWorkspace(runtime, rawRoot, { allowInit: false });
  return { root: workspace.root, workspaceId: workspace.workspaceId };
}

async function runStop(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const target = await resolveStopWorkspace(spec, parsed, runtime);
  const deps = stopServiceDeps(runtime);
  let service: ResolvedService;
  try {
    service = await resolveService(target.root, target.workspaceId, deps);
  } catch (error) {
    if (
      error instanceof CliFailure &&
      (error.code === 'SERVICE_NOT_RUNNING' || error.code === 'SERVICE_UNREACHABLE')
    ) {
      return { ok: true, command: 'stop', state: 'not-running', workspaceId: target.workspaceId };
    }
    throw error;
  }
  const notRunning = { ok: true, command: 'stop', state: 'not-running', workspaceId: service.workspaceId };
  try {
    await requestRuntimeStop(service, deps);
    await waitForServiceStopped(target.root, service.baseUrl, deps, runtime.stopTimeoutMs);
  } catch (error) {
    // 响应前连接断开：服务已经不可达，按 not-running 成功处理。
    if (error instanceof CliFailure && error.code === 'SERVICE_UNREACHABLE') return notRunning;
    throw error;
  }
  return {
    ok: true,
    command: 'stop',
    state: 'stopped',
    workspaceId: service.workspaceId,
    instanceId: service.instanceId,
  };
}

/** open/stop 失败写 installation.startupLogPath（覆盖写，帮助原生启动器诊断）。 */
async function logCommandFailure(
  runtime: CliRuntime,
  command: 'open' | 'stop',
  failure: CliFailure,
): Promise<void> {
  const entry = {
    at: new Date().toISOString(),
    command,
    code: failure.code,
    message: failure.message,
    ...(failure.details !== undefined ? { details: failure.details } : {}),
  };
  await writeStartupLog(runtime.installation, JSON.stringify(entry));
}

async function runConfig(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const show = flag(parsed, 'show');
  const workspace = parsed.values.get('workspace');
  if (show === (workspace !== undefined)) {
    throw usageFailure('config 需要且只能给一个 --workspace <dir> 或 --show', {
      details: { field: 'config' },
      usage: spec.usage[0],
    });
  }
  const configPath = runtime.configPath;
  if (show) return { ...(await showDefaultConfig(configPath)) };
  return { ...(await saveDefaultWorkspace(configPath, workspace as string)) };
}

async function runStatus(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const requestId = parsed.positional[0] as string;
  return withWorkspaceStore(spec, parsed, runtime, ({ store }) => {
    const status: ChangeStatusResponse = store.status(requestId);
    return { ...status, command: 'status' };
  });
}

async function runWhoami(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const resolution = await resolveCliWorkspace(parsed, runtime);
  let store: GraphStore;
  try {
    store = GraphStore.open(resolution.root, { readonly: true });
  } catch (error) {
    throw mapDomainError(error, spec);
  }
  let snapshot: ReturnType<GraphStore['snapshot']>;
  try {
    snapshot = store.snapshot();
  } finally {
    store.close();
  }
  const expected = parsed.values.get('workspace-id');
  if (expected !== undefined && expected !== snapshot.workspaceId) {
    throw workspaceFailure(
      'WORKSPACE_ID_MISMATCH',
      '工作区身份不匹配：--workspace-id=' + expected + '，实际 ' + snapshot.workspaceId,
      { expected, actual: snapshot.workspaceId, root: resolution.root },
    );
  }
  const local = programInfo();
  const payload: Record<string, unknown> = {
    ok: true,
    command: 'whoami',
    interfaceVersion: INTERFACE_VERSION,
    program: local,
    workspaceId: snapshot.workspaceId,
    name: snapshot.name,
    rootPath: resolution.root,
    revision: snapshot.revision,
  };
  const deps = defaultServiceDeps({
    fetchImpl: runtime.fetchImpl,
    spawnImpl: runtime.spawnImpl,
    sleep: runtime.sleep,
    startTimeoutMs: runtime.startTimeoutMs,
    pollIntervalMs: runtime.pollIntervalMs,
    noStart: true,
    requireInterface: false,
  });
  try {
    const service = await resolveService(resolution.root, snapshot.workspaceId, deps);
    payload['instanceId'] = service.instanceId;
    payload['url'] = service.baseUrl;
    payload['service'] = {
      available: true,
      interfaceCompatible: service.interfaceCompatible,
      ...(service.program !== null ? { program: service.program } : {}),
    };
  } catch (error) {
    const failure = error instanceof CliFailure ? error : null;
    payload['service'] = {
      available: false,
      ...(failure !== null ? { code: failure.code, message: failure.message } : { message: String(error) }),
    };
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

function failureEnvelopeFrom(failure: CliFailure): { payload: Record<string, unknown>; exitCode: number } {
  const body: Record<string, unknown> = {
    code: failure.code,
    message: failure.message,
    ...(failure.details !== undefined ? { details: failure.details } : {}),
    ...(failure.diagnostics !== undefined ? { diagnostics: failure.diagnostics } : {}),
    ...(failure.usage !== undefined ? { usage: failure.usage } : {}),
  };
  return {
    payload: { ok: false, error: body },
    exitCode: failure.exitCode,
  };
}

export async function main(argv: readonly string[], context: Partial<CliRuntime> = {}): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const base = createRuntime(context);
  const runtime: CliRuntime = {
    ...base,
    stdout: (text) => {
      stdout += text;
      if (DIRECT_EXECUTION) process.stdout.write(text);
    },
    stderr: (text) => {
      stderr += text;
      if (DIRECT_EXECUTION) process.stderr.write(text);
    },
  };

  const commandName = argv[0];
  const rest = argv.slice(1);
  if (commandName === undefined) {
    runtime.stderr('缺少命令\n\n' + rootHelp() + '\n');
    return { exitCode: EXIT_CODES.usage, stdout, stderr };
  }
  if (commandName === '--version' || commandName === '-V') {
    runtime.stdout(versionLine() + '\n');
    return { exitCode: EXIT_CODES.ok, stdout, stderr };
  }
  if (commandName === '--help' || commandName === '-h') {
    runtime.stdout(rootHelp() + '\n');
    return { exitCode: EXIT_CODES.ok, stdout, stderr };
  }

  try {
    if (rest.includes('--help') || rest.includes('-h')) {
      if (commandName === 'help') {
        runtime.stdout(rootHelp() + '\n');
        return { exitCode: EXIT_CODES.ok, stdout, stderr };
      }
      const spec = COMMAND_BY_NAME.get(commandName);
      if (spec === undefined) throw usageFailure('未知命令 ' + commandName);
      runtime.stdout(commandHelpText(spec) + '\n');
      return { exitCode: EXIT_CODES.ok, stdout, stderr };
    }
    const spec = COMMAND_BY_NAME.get(commandName);
    if (spec === undefined) throw usageFailure('未知命令 ' + commandName);
    const parsed = parseCommandArgs(spec, rest);
    if (flag(parsed, 'json') && flag(parsed, 'text')) {
      throw usageFailure('--json 与 --text 不能同时使用', { usage: spec.usage[0] });
    }
    const payload = await dispatch(spec, parsed, runtime);
    if (payload !== null) {
      if (flag(parsed, 'text')) {
        runtime.stdout(humanLines(spec.name, payload).join('\n') + '\n');
      } else {
        emitJson(runtime, payload);
      }
    }
    return { exitCode: EXIT_CODES.ok, stdout, stderr };
  } catch (error) {
    const spec = commandName === undefined ? undefined : COMMAND_BY_NAME.get(commandName);
    const failure = mapDomainError(error, spec);
    if (commandName === 'open' || commandName === 'stop') {
      await logCommandFailure(runtime, commandName, failure);
    }
    const { payload, exitCode } = failureEnvelopeFrom(failure);
    if (rest.includes('--text')) {
      const failure = payload['error'] as Record<string, unknown>;
      runtime.stderr(String(failure['message']) + '\n');
    } else {
      runtime.stderr(JSON.stringify(payload) + '\n');
    }
    return { exitCode, stdout, stderr };
  }
}

async function dispatch(spec: CommandSpec, parsed: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown> | null> {
  switch (spec.name) {
    case 'init':
      return runInit(spec, parsed, runtime);
    case 'import':
      return runImport(spec, parsed, runtime);
    case 'serve':
      return runServe(spec, parsed, runtime);
    case 'open':
      return runOpen(spec, parsed, runtime);
    case 'stop':
      return runStop(spec, parsed, runtime);
    case 'config':
      return runConfig(spec, parsed, runtime);
    case 'topics':
      return runTopics(spec, parsed, runtime);
    case 'validate':
      return runValidate(spec, parsed, runtime);
    case 'search':
      return runSearch(spec, parsed, runtime);
    case 'read':
    case 'resume':
      return runReadThenMap(spec.name, spec, parsed, runtime);
    case 'edit':
      return runEdit(spec, parsed, runtime);
    case 'important':
      return runImportant(spec, parsed, runtime);
    case 'next':
    case 'branch':
      return runNextOrBranch(spec.name, spec, parsed, runtime);
    case 'insert':
      return runInsert(spec, parsed, runtime);
    case 'batch':
      return runBatch(spec, parsed, runtime);
    case 'rearrange':
      return runRearrange(spec, parsed, runtime);
    case 'delete':
      return runDelete(spec, parsed, runtime);
    case 'create-topic':
      return runCreateTopic(spec, parsed, runtime);
    case 'status':
      return runStatus(spec, parsed, runtime);
    case 'whoami':
      return runWhoami(spec, parsed, runtime);
    case 'version':
      return {
        ok: true,
        command: 'version',
        interfaceVersion: INTERFACE_VERSION,
        program: programInfo(),
        runtime: { node: process.version, executable: process.execPath },
      };
    case 'help': {
      const target = parsed.positional[0];
      if (target === undefined) {
        if (flag(parsed, 'json')) {
          runtime.stdout(JSON.stringify(catalogHelpJson()) + '\n');
        } else {
          runtime.stdout(rootHelp() + '\n');
        }
        return null;
      }
      const targetSpec = COMMAND_BY_NAME.get(target);
      if (targetSpec === undefined) {
        throw usageFailure('未知命令 ' + target + '；运行 aichat --help 查看命令目录');
      }
      if (flag(parsed, 'json')) {
        runtime.stdout(JSON.stringify(commandHelpJson(targetSpec)) + '\n');
      } else {
        runtime.stdout(commandHelpText(targetSpec) + '\n');
      }
      return null;
    }
    default:
      throw usageFailure('未知命令 ' + spec.name);
  }
}

if (DIRECT_EXECUTION) {
  const result = await main(process.argv.slice(2));
  process.exitCode = result.exitCode;
}
