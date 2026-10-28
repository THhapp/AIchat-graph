/**
 * Interface 4 CLI：默认工作区配置与工作区解析。
 *
 * 解析顺序：--workspace → AICHAT_WORKSPACE → <程序根>/.aichat/default.json。
 * --workspace-id 只是身份校验，不参与定位；不猜其他工作区路径。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceFailure } from './args.js';
import { GraphStore } from './store.js';

export const CONFIG_RELATIVE_PATH = '.aichat/default.json';

export interface DefaultConfig {
  workspace: string;
  workspaceId?: string;
  updatedAt?: string;
}

export interface WorkspaceResolution {
  root: string;
  source: 'flag' | 'env' | 'config';
  configPath: string;
  config: DefaultConfig | null;
}

/** 程序根：dist/next/cli.js → 安装根；源码 src/next/cli.ts → 仓库根。 */
export function moduleRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function defaultConfigPath(repoRoot: string = moduleRepoRoot()): string {
  return path.join(repoRoot, CONFIG_RELATIVE_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfig(raw: unknown, configPath: string): DefaultConfig {
  if (!isRecord(raw)) {
    throw workspaceFailure('CONFIG_INVALID', '默认配置文件必须是 JSON 对象：' + configPath, {
      configPath,
    });
  }
  const workspace = raw['workspace'];
  if (typeof workspace !== 'string' || workspace.trim().length === 0) {
    throw workspaceFailure('CONFIG_INVALID', '默认配置文件缺少 workspace：' + configPath, {
      configPath,
    });
  }
  const config: DefaultConfig = { workspace };
  if (raw['workspaceId'] !== undefined) {
    if (typeof raw['workspaceId'] !== 'string' || raw['workspaceId'].length === 0) {
      throw workspaceFailure('CONFIG_INVALID', '默认配置文件的 workspaceId 不合法：' + configPath, {
        configPath,
      });
    }
    config.workspaceId = raw['workspaceId'];
  }
  if (raw['updatedAt'] !== undefined) {
    if (typeof raw['updatedAt'] !== 'string') {
      throw workspaceFailure('CONFIG_INVALID', '默认配置文件的 updatedAt 不合法：' + configPath, {
        configPath,
      });
    }
    config.updatedAt = raw['updatedAt'];
  }
  return config;
}

/** 读取默认配置；不存在返回 null，格式损坏是 workspace 失败。 */
export async function readDefaultConfig(configPath: string): Promise<DefaultConfig | null> {
  let text: string;
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw workspaceFailure('CONFIG_UNREADABLE', '无法读取默认配置：' + configPath, {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw workspaceFailure('CONFIG_INVALID', '默认配置不是合法 JSON：' + configPath, {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return parseConfig(parsed, configPath);
}

export interface ResolveWorkspaceOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly explicit?: string | undefined;
  /** 测试覆盖：默认配置文件的完整路径。 */
  readonly configPath?: string | undefined;
}

/** 规范化真实路径：Windows 8.3 短名会让 descriptor/服务身份比对失败。 */
export async function canonicalRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    return root;
  }
}

/** 定位工作区目录，不打开数据库；身份校验由调用方在打开快照后做。 */
export async function resolveWorkspace(
  options: ResolveWorkspaceOptions,
): Promise<WorkspaceResolution> {
  const configPath = options.configPath ?? defaultConfigPath();
  if (options.explicit !== undefined && options.explicit.trim().length > 0) {
    return {
      root: await canonicalRoot(path.resolve(options.cwd, options.explicit)),
      source: 'flag',
      configPath,
      config: null,
    };
  }
  const fromEnv = options.env['AICHAT_WORKSPACE'];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return {
      root: await canonicalRoot(path.resolve(options.cwd, fromEnv.trim())),
      source: 'env',
      configPath,
      config: null,
    };
  }
  const config = await readDefaultConfig(configPath);
  if (config !== null) {
    return {
      root: await canonicalRoot(path.resolve(options.cwd, config.workspace)),
      source: 'config',
      configPath,
      config,
    };
  }
  throw workspaceFailure(
    'WORKSPACE_NOT_CONFIGURED',
    '没有工作区：请用 --workspace 指定，或先运行 aichat init <path>，或用 aichat config --workspace <dir> 保存默认工作区（配置文件：' +
      configPath +
      '）',
    { configPath },
  );
}

/** 打开数据库并校验 --workspace-id；返回快照后立即关闭。 */
export function verifyWorkspaceIdentity(root: string, expectedWorkspaceId: string): string {
  let store: GraphStore;
  try {
    store = GraphStore.open(root, { readonly: true });
  } catch (error) {
    throw error;
  }
  try {
    const snapshot = store.snapshot();
    if (snapshot.workspaceId !== expectedWorkspaceId) {
      throw workspaceFailure(
        'WORKSPACE_ID_MISMATCH',
        '工作区身份不匹配：--workspace-id=' +
          expectedWorkspaceId +
          '，实际 ' +
          snapshot.workspaceId,
        { expected: expectedWorkspaceId, actual: snapshot.workspaceId, root },
      );
    }
    return snapshot.workspaceId;
  } finally {
    store.close();
  }
}

export interface ConfigShowResult {
  readonly ok: true;
  readonly command: 'config';
  readonly configPath: string;
  readonly exists: boolean;
  readonly workspace: string | null;
  readonly workspaceId: string | null;
  readonly updatedAt: string | null;
}

/** 输出当前默认配置；不存在也是成功结果（exists:false）。 */
export async function showDefaultConfig(configPath: string): Promise<ConfigShowResult> {
  const config = await readDefaultConfig(configPath);
  return {
    ok: true,
    command: 'config',
    configPath,
    exists: config !== null,
    workspace: config?.workspace ?? null,
    workspaceId: config?.workspaceId ?? null,
    updatedAt: config?.updatedAt ?? null,
  };
}

/** 校验目标目录是有效工作区，然后写入默认配置。 */
export async function saveDefaultWorkspace(
  configPath: string,
  workspaceRoot: string,
): Promise<ConfigShowResult> {
  const root = await canonicalRoot(path.resolve(workspaceRoot));
  let store: GraphStore;
  try {
    store = GraphStore.open(root, { readonly: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    throw workspaceFailure('CONFIG_INVALID', '无法打开工作区：' + root, { root });
  }
  let workspaceId: string;
  try {
    workspaceId = store.snapshot().workspaceId;
  } finally {
    store.close();
  }
  const config: DefaultConfig = {
    workspace: root,
    workspaceId,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return {
    ok: true,
    command: 'config',
    configPath,
    exists: true,
    workspace: config.workspace,
    workspaceId,
    updatedAt: config.updatedAt as string,
  };
}
