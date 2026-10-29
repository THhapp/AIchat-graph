/**
 * Local program replacement for the portable Windows distribution.
 *
 * Invoked by the native launcher (or update-daily) as:
 *   node app/dist/portable/update.js --source <distributionRoot> --target <distributionRoot>
 *
 * The source is one unpacked new AIchat-graph package; the target is the existing
 * unpacked package directory. Both must carry a valid distribution.json. The app/
 * and runtime/ directories and the root program files are replaced as whole units,
 * distribution.json is written last, and the target's .aichat/ (default workspace,
 * logs, machine settings) is never touched. No user workspace is copied or changed.
 *
 * Flags:
 *   --allow-legacy    target may be the old repo-style .local/daily layout
 *                     (known old entries are replaced; .aichat is preserved)
 *   --create-target   target may be missing or empty (first daily setup)
 *   --yes             do not ask for confirmation on an interactive console
 *
 * This is a local file operation only: no download, no rollback history, no
 * daemon. A failure restores the previous files of this same operation when it
 * can, then reports the concrete reason.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { resolveInstallation, type DistributionManifest } from '../next/installation.js';

const PROGRAM_NAME = 'AIchat-graph';
const ROOT_FILES = ['AIchat-graph.exe', 'aichat.cmd', '更新已有程序.cmd', '开始使用.md', 'distribution.json'] as const;
/** Old repo-style .local/daily entries replaced by the portable layout. */
const LEGACY_ENTRIES = [
  'dist',
  'node_modules',
  'package.json',
  'package-lock.json',
  'skills',
  'docs',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
  'snapshot.json',
  'aichat.cmd',
  'AIchat-graph.exe',
  '更新已有程序.cmd',
  '开始使用.md',
] as const;
const REQUIRED_SOURCE = [
  ...ROOT_FILES,
  'runtime/node.exe',
  'runtime/LICENSE',
  'app/package.json',
  'app/dist/next/cli.js',
] as const;

interface Options {
  readonly source: string;
  readonly target: string;
  readonly allowLegacy: boolean;
  readonly createTarget: boolean;
  readonly yes: boolean;
}

type TargetKind = 'portable' | 'legacy' | 'empty';

class UpdateError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UpdateError';
    this.hint = hint;
  }
}

function usage(): string {
  return [
    'usage: node app/dist/portable/update.js --source <new package dir> --target <existing package dir>',
    '       [--allow-legacy] [--create-target] [--yes]',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): Options {
  let source: string | undefined;
  let target: string | undefined;
  let allowLegacy = false;
  let createTarget = false;
  let yes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source' || arg === '--target') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UpdateError(arg + ' 需要目录参数');
      index += 1;
      if (arg === '--source') source = value;
      else target = value;
    } else if (arg === '--allow-legacy') allowLegacy = true;
    else if (arg === '--create-target') createTarget = true;
    else if (arg === '--yes') yes = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new UpdateError('未知参数：' + arg);
    }
  }
  if (source === undefined || target === undefined) throw new UpdateError('必须同时给出 --source 与 --target');
  return {
    source: path.resolve(source),
    target: path.resolve(target),
    allowLegacy,
    createTarget,
    yes,
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Real path when possible, resolved path for not-yet-existing targets. */
async function canonical(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  const normalizedParent = parent.replace(/[\\/]+$/, '').toLowerCase();
  const normalizedChild = child.replace(/[\\/]+$/, '').toLowerCase();
  if (normalizedParent === normalizedChild) return true;
  return normalizedChild.startsWith(normalizedParent + path.sep) ||
    normalizedChild.startsWith(normalizedParent + '/');
}

async function readSourceManifest(source: string): Promise<DistributionManifest> {
  let manifest: DistributionManifest | null = null;
  try {
    manifest = resolveInstallation(path.join(source, 'app')).manifest;
  } catch {
    manifest = null;
  }
  if (manifest === null) {
    throw new UpdateError(
      '源目录不是完整的 AIchat-graph 程序包（缺少有效的 distribution.json）：' + source,
      '请重新完整解压下载的 ZIP，再从新包运行更新入口。',
    );
  }
  return manifest;
}

/** Running program processes whose command line or image lives under the target. */
async function processesUnder(target: string): Promise<Array<{ pid: number; name: string }>> {
  if (process.platform !== 'win32') return [];
  const script = [
    "$needle = ([string]$env:AICHAT_UPDATE_TARGET).TrimEnd('\\')",
    '$self = 0',
    'if ($env:AICHAT_UPDATE_SELF_PID) { $self = [int]$env:AICHAT_UPDATE_SELF_PID }',
    'try { $procs = Get-CimInstance Win32_Process -ErrorAction Stop } catch { exit 0 }',
    "$found = @($procs | Where-Object { $_.ProcessId -ne $self -and (($_.ExecutablePath -and $_.ExecutablePath.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or (($_.Name -ieq 'node.exe') -and $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0)) })",
    "if ($found.Count -gt 0) { $found | ForEach-Object { Write-Output ('' + $_.ProcessId + '|' + $_.Name) }; exit 3 }",
    'exit 0',
  ].join('; ');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, AICHAT_UPDATE_TARGET: target, AICHAT_UPDATE_SELF_PID: String(process.pid) },
      windowsHide: true,
      timeout: 20_000,
    });
    if (result.status !== 3) return [];
    return String(result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [pid, name] = line.split('|');
        return { pid: Number(pid), name: name ?? 'unknown' };
      });
  } catch {
    return [];
  }
}

async function assertTargetIdle(target: string): Promise<void> {
  if (!(await exists(target))) return;
  const running = await processesUnder(target);
  if (running.length === 0) return;
  const detail = running.map((entry) => entry.name + ' (pid ' + String(entry.pid) + ')').join('，');
  throw new UpdateError(
    '目标程序正在使用中：' + detail,
    '请先从旧程序退出本库服务、关闭程序窗口，再重新运行更新入口；更新不会强制结束任何进程。',
  );
}

async function isLegacyDaily(target: string): Promise<boolean> {
  if (!(await exists(target))) return false;
  const entries = await fs.readdir(target, { withFileTypes: true });
  if (entries.length === 0) return true;
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has('app') || names.has('runtime') || names.has('distribution.json')) return false;
  const packageFile = path.join(target, 'package.json');
  if (await exists(packageFile)) {
    try {
      const parsed = JSON.parse(await fs.readFile(packageFile, 'utf8')) as { name?: unknown };
      if (parsed.name === 'aichat-graph') return true;
    } catch {
      return false;
    }
  }
  const snapshotFile = path.join(target, 'snapshot.json');
  if (await exists(snapshotFile)) {
    try {
      const parsed = JSON.parse(await fs.readFile(snapshotFile, 'utf8')) as { kind?: unknown };
      return parsed.kind === 'aichat-daily';
    } catch {
      return false;
    }
  }
  return false;
}

async function classifyTarget(target: string, options: Options): Promise<TargetKind> {
  if (!(await exists(target))) {
    if (options.createTarget) return 'empty';
    throw new UpdateError('目标程序目录不存在：' + target, '请选择已经解压的旧程序目录，或先使用 update-daily 准备日用目录。');
  }
  const installation = resolveInstallation(path.join(target, 'app'));
  if (installation.kind === 'portable' && installation.manifest !== null) return 'portable';
  if (await isLegacyDaily(target)) {
    const names = await fs.readdir(target);
    const allowed = new Set<string>([...LEGACY_ENTRIES, '.aichat']);
    const unknown = names.filter((name) => !allowed.has(name));
    if (unknown.length > 0) {
      throw new UpdateError(
        '目标目录包含旧布局以外的内容，拒绝整体替换：' + unknown.join('，'),
        '请先把这些内容移出程序目录（讨论库与 .aichat 不需要移动），再回到新包重试。',
      );
    }
    if (options.allowLegacy) return 'legacy';
    throw new UpdateError(
      '目标目录是旧版日用快照，不是便携程序目录：' + target,
      '本入口只替换便携程序包（需要 distribution.json）。旧日用目录请使用 update-daily 迁移。',
    );
  }
  const entries = await fs.readdir(target).catch(() => [] as string[]);
  if (entries.length === 0) {
    if (options.createTarget) return 'empty';
    throw new UpdateError('目标程序目录为空，且未允许新建：' + target);
  }
  throw new UpdateError(
    '目标目录不是 AIchat-graph 程序目录（缺少有效的 distribution.json）：' + target,
    '请选择包含 AIchat-graph.exe 与 distribution.json 的完整解压目录。',
  );
}

async function verifySource(source: string): Promise<DistributionManifest> {
  const manifest = await readSourceManifest(source);
  for (const relative of REQUIRED_SOURCE) {
    if (!(await exists(path.join(source, ...relative.split('/'))))) {
      throw new UpdateError('源程序包不完整：缺少 ' + relative, '请重新完整解压下载的 ZIP，不要只复制部分文件。');
    }
  }
  return manifest;
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.cp(from, to, { recursive: true, force: true, errorOnExist: false });
}

function mapFsError(error: unknown, target: string): UpdateError {
  const code = (error as NodeJS.ErrnoException).code;
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
    return new UpdateError(
      '无法替换目标程序：文件正在被使用（可能仍有服务或程序在运行）。',
      '请先退出本库服务、关闭旧程序窗口，然后从新包重新运行更新入口。目标目录：' + target,
    );
  }
  return new UpdateError('替换程序文件失败：' + detail, '请检查目标目录是否可写，并确认程序与服务已退出。');
}

/**
 * Stage the new package next to the target, then swap app/, runtime/ and the root
 * program files. Old files are only moved into this operation's temporary folder
 * for the duration of the swap and deleted on success; the failure path tries to
 * restore them before reporting.
 */
async function replaceProgram(source: string, target: string, kind: TargetKind): Promise<void> {
  const parent = path.dirname(target);
  const base = path.basename(target);
  const temp = path.join(parent, '.' + base + '.update-' + randomUUID().replace(/-/g, '').slice(0, 12));
  const stage = path.join(temp, 'new');
  const old = path.join(temp, 'old');
  await fs.mkdir(stage, { recursive: true });
  await fs.mkdir(old, { recursive: true });
  try {
    await copyTree(path.join(source, 'app'), path.join(stage, 'app'));
    await copyTree(path.join(source, 'runtime'), path.join(stage, 'runtime'));
    for (const file of ROOT_FILES) {
      const from = path.join(source, file);
      if (await exists(from)) await fs.copyFile(from, path.join(stage, file));
    }
    for (const relative of ['AIchat-graph.exe', 'runtime/node.exe', 'app/package.json', 'app/dist/next/cli.js', 'distribution.json']) {
      if (!(await exists(path.join(stage, ...relative.split('/'))))) {
        throw new UpdateError('准备新程序时缺少文件：' + relative, '请从新包重新解压后重试。');
      }
    }

    await fs.mkdir(target, { recursive: true });
    const entries = kind === 'portable' ? ['app', 'runtime', ...ROOT_FILES] : kind === 'legacy' ? [...LEGACY_ENTRIES] : [];
    for (const entry of entries) {
      const from = path.join(target, entry);
      if (await exists(from)) await fs.rename(from, path.join(old, entry));
    }

    const installed: string[] = [];
    try {
      await fs.rename(path.join(stage, 'app'), path.join(target, 'app'));
      installed.push('app');
      await fs.rename(path.join(stage, 'runtime'), path.join(target, 'runtime'));
      installed.push('runtime');
      for (const file of ROOT_FILES) {
        if (file === 'distribution.json') continue;
        const from = path.join(stage, file);
        if (!(await exists(from))) continue;
        await fs.rename(from, path.join(target, file));
        installed.push(file);
      }
      // distribution.json last: the target is only recognisable as updated when
      // the new program files are already in place.
      await fs.rename(path.join(stage, 'distribution.json'), path.join(target, 'distribution.json'));
      installed.push('distribution.json');
    } catch (error) {
      for (const entry of installed.reverse()) {
        const targetEntry = path.join(target, entry);
        if (await exists(targetEntry)) await fs.rm(targetEntry, { recursive: true, force: true }).catch(() => undefined);
        const oldEntry = path.join(old, entry);
        if (await exists(oldEntry)) await fs.rename(oldEntry, targetEntry).catch(() => undefined);
      }
      throw error;
    }

    for (const entry of entries) {
      const oldEntry = path.join(old, entry);
      if (await exists(oldEntry)) await fs.rm(oldEntry, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function confirm(message: string, options: Options): Promise<void> {
  if (options.yes || !process.stdin.isTTY) return;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(message + ' [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') throw new UpdateError('已取消更新。');
  } finally {
    readline.close();
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const source = await canonical(options.source);
  const target = await canonical(options.target);
  if (isSameOrInside(source, target) || isSameOrInside(target, source)) {
    throw new UpdateError(
      '源与目标不能相同或互相包含：' + source + ' ↔ ' + target,
      '请把新 ZIP 解压到旧程序目录之外，再选择旧程序目录。',
    );
  }
  const sourceManifest = await verifySource(source);
  const kind = await classifyTarget(target, options);
  await assertTargetIdle(target);
  await confirm(
    '将用 ' + source + ' 替换 ' + target + ' 的程序文件。\n' +
      '该目录的 .aichat 设置与所有外部讨论库保持不变。继续？',
    options,
  );
  try {
    await replaceProgram(source, target, kind);
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw mapFsError(error, target);
  }
  console.log('已更新程序：' + target);
  console.log('新程序 buildId：' + sourceManifest.buildId);
  console.log('保留：目标 .aichat 设置与日志；外部讨论库未改动。');
  console.log('请从原位置打开新程序。');
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(PROGRAM_NAME + ' 更新失败：' + message);
  if (error instanceof UpdateError && error.hint !== undefined) console.error(error.hint);
  else console.error('请确认程序都已退出、目标目录可写，并从新包重新运行更新入口。');
  process.exitCode = 1;
});
