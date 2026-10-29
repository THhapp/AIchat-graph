/**
 * 分发布局定位：源码仓库与便携包共用 appRoot，但分发根、默认配置、日志、
 * 随包 Node 与真实 Agent 入口不同。所有调用方从这里取值，不靠当前目录猜路径。
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DistributionManifest {
  kind: 'aichat-graph-portable';
  schemaVersion: 1;
  platform: 'win32-x64';
  buildId: string;
  nodeVersion: string;
}

export interface InstallationPaths {
  readonly kind: 'repo' | 'portable';
  readonly appRoot: string;
  readonly distributionRoot: string;
  readonly configPath: string;
  readonly logsDirectory: string;
  readonly startupLogPath: string;
  readonly nodePath: string;
  readonly cliJsPath: string;
  readonly aichatCmdPath: string;
  readonly launcherPath: string;
  readonly skillsDirectory: string;
  readonly toolsDirectory: string;
  readonly updateScriptPath: string;
  readonly manifestPath: string | null;
  readonly manifest: DistributionManifest | null;
  readonly portable: boolean;
}

function moduleAppRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function readManifestSync(manifestPath: string): DistributionManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record['kind'] !== 'aichat-graph-portable' || record['schemaVersion'] !== 1) return null;
    if (record['platform'] !== 'win32-x64') return null;
    if (typeof record['buildId'] !== 'string' || record['buildId'].length === 0) return null;
    if (typeof record['nodeVersion'] !== 'string' || record['nodeVersion'].length === 0) return null;
    return {
      kind: 'aichat-graph-portable',
      schemaVersion: 1,
      platform: 'win32-x64',
      buildId: record['buildId'],
      nodeVersion: record['nodeVersion'],
    };
  } catch {
    return null;
  }
}

/** 识别 appRoot：便携包为 <distributionRoot>/app，源码为仓库根。 */
export function resolveInstallation(appRoot: string = moduleAppRoot()): InstallationPaths {
  const absoluteApp = path.resolve(appRoot);
  const parent = path.dirname(absoluteApp);
  const manifestPath = path.join(parent, 'distribution.json');
  const manifest = existsSync(manifestPath) ? readManifestSync(manifestPath) : null;
  if (manifest !== null) {
    const distributionRoot = parent;
    return buildPaths('portable', absoluteApp, distributionRoot, manifestPath, manifest);
  }
  return buildPaths('repo', absoluteApp, absoluteApp, null, null);
}

function buildPaths(
  kind: 'repo' | 'portable',
  appRoot: string,
  distributionRoot: string,
  manifestPath: string | null,
  manifest: DistributionManifest | null,
): InstallationPaths {
  const portable = kind === 'portable';
  return {
    kind,
    appRoot,
    distributionRoot,
    configPath: path.join(distributionRoot, '.aichat', 'default.json'),
    logsDirectory: path.join(distributionRoot, '.aichat', 'logs'),
    startupLogPath: path.join(distributionRoot, '.aichat', 'logs', 'startup.log'),
    nodePath: portable ? path.join(distributionRoot, 'runtime', 'node.exe') : process.execPath,
    cliJsPath: path.join(appRoot, 'dist', 'next', 'cli.js'),
    aichatCmdPath: portable ? path.join(distributionRoot, 'aichat.cmd') : path.join(appRoot, 'aichat.cmd'),
    launcherPath: path.join(distributionRoot, 'AIchat-graph.exe'),
    skillsDirectory: path.join(appRoot, 'skills', 'aichat-graph'),
    toolsDirectory: path.join(appRoot, 'tools'),
    updateScriptPath: path.join(appRoot, 'dist', 'portable', 'update.js'),
    manifestPath,
    manifest,
    portable,
  };
}

export function currentInstallation(): InstallationPaths {
  return resolveInstallation(moduleAppRoot());
}

export function agentEntryOf(installation: InstallationPaths = currentInstallation()): {
  cliPath: string;
  skillPath: string;
} {
  return {
    cliPath: installation.aichatCmdPath,
    skillPath: path.join(installation.skillsDirectory, 'SKILL.md'),
  };
}

/** 最近一次打开/控制入口的简短错误；覆盖写入，不归档。 */
export async function writeStartupLog(installation: InstallationPaths, message: string): Promise<void> {
  const text = message.trim().slice(0, 4000) + '\n';
  try {
    await fs.mkdir(installation.logsDirectory, { recursive: true });
    await fs.writeFile(installation.startupLogPath, text, 'utf8');
  } catch {
    // 日志失败不能覆盖原始错误；调用方仍返回错误结果。
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
