#!/usr/bin/env node
/**
 * Build the Windows x64 portable package:
 *   .local/packages/AIchat-graph-<version>-win-x64/      (unpacked package)
 *   .local/packages/AIchat-graph-<version>-win-x64.zip   (download artifact)
 *
 * Run npm run build first (this script refuses to package missing/stale build
 * outputs), then npm run package:windows. The package contains the compiled app,
 * production node_modules installed into the staging app, the official Node runtime,
 * the native thin launcher and the fixed distribution layout. It never contains
 * source, tests, .local data, real workspaces or machine-local configuration.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packagesRoot = path.join(root, '.local', 'packages');

function fail(message) {
  console.error('package:windows 失败：' + message);
  process.exit(1);
}

function requireFile(relative, hint) {
  const absolute = path.join(root, ...relative.split('/'));
  if (!existsSync(absolute)) fail('缺少 ' + relative + '。' + (hint ?? ''));
  return absolute;
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(root, ...relative.split('/')), 'utf8'));
}

function findCompiler() {
  const candidates = [process.env.CC, 'gcc'].filter((entry) => typeof entry === 'string' && entry.length > 0);
  for (const candidate of candidates) {
    try {
      const target = execFileSync(candidate, ['-dumpmachine'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!/x86_64|amd64/i.test(target)) {
        fail('需要 64 位 MinGW gcc，当前 ' + candidate + ' 目标为 ' + target);
      }
      return candidate;
    } catch {
      // try next candidate
    }
  }
  fail('找不到 64 位 MinGW gcc。请安装 MinGW-w64 x64 并把 gcc 放入 PATH（或设置 CC），再重试；本项只要求构建机具备。');
  return '';
}

function runGitVersion(nodeExe) {
  return execFileSync(nodeExe, ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function checkForbiddenContent(label, target) {
  const forbidden = ['.local', 'src', 'tests', '.git', 'coverage'];
  for (const name of forbidden) {
    if (existsSync(path.join(target, name))) fail(label + ' 包含不应发布的目录：' + name);
  }
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'local.env.json') fail(label + ' 含本机绑定 local.env.json：' + path.join(current, entry.name));
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
}

function createZip(zipPath, stagingParent, stagingName) {
  rmSync(zipPath, { force: true });
  try {
    execFileSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', stagingParent, stagingName], { stdio: 'inherit' });
  } catch {
    console.log('tar.exe 生成 ZIP 失败，改用 PowerShell Compress-Archive...');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Compress-Archive -LiteralPath '" + path.join(stagingParent, stagingName) + "' -DestinationPath '" + zipPath + "' -CompressionLevel Optimal -Force",
    ], { stdio: 'inherit' });
  }
  if (!existsSync(zipPath) || statSync(zipPath).size === 0) fail('ZIP 没有生成：' + zipPath);
}

const pkg = readJson('package.json');
const version = pkg.version;
const nodeVersion = pkg.engines?.node;
if (typeof version !== 'string' || version.length === 0) fail('package.json 缺少 version');
if (typeof nodeVersion !== 'string') fail('package.json engines.node 缺失');
if (process.versions.node !== nodeVersion) {
  fail('构建机 Node 版本 ' + process.versions.node + ' 与 engines.node ' + nodeVersion + ' 不一致；请用指定版本构建，保证随包运行时一致。');
}

const buildInfoPath = requireFile('dist/build-info.json', '请先运行 npm run build。');
const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
if (buildInfo.version !== version) fail('dist/build-info.json 版本 ' + buildInfo.version + ' 与 package.json ' + version + ' 不一致；请重新构建。');
if (typeof buildInfo.buildId !== 'string' || buildInfo.buildId.length === 0) fail('dist/build-info.json 缺少 buildId；请重新构建。');

for (const relative of [
  'dist/next/cli.js',
  'dist/portable/update.js',
  'dist/web/index.html',
  'dist/offline/reader.js',
  'dist/offline/reader.css',
  'package-lock.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
  'docs/cli.md',
  'docs/workspace.md',
  'skills/aichat-graph/SKILL.md',
  'scripts/install-skill.ps1',
  'native/windows/launcher.c',
  'native/windows/aichat.cmd',
  'native/windows/更新已有程序.cmd',
  'native/windows/开始使用.md',
  'native/windows/node-LICENSE.txt',
]) {
  requireFile(relative, relative.startsWith('dist/') ? '请先运行 npm run build。' : '仓库内容不完整，请检查工作树。');
}

const compiler = findCompiler();
const stagingName = 'AIchat-graph-' + version + '-win-x64';
const stagingRoot = path.join(packagesRoot, stagingName);
const zipPath = path.join(packagesRoot, stagingName + '.zip');
if (!stagingRoot.startsWith(packagesRoot + path.sep) || !zipPath.startsWith(packagesRoot + path.sep)) {
  fail('打包路径超出 .local/packages：' + stagingRoot);
}
mkdirSync(packagesRoot, { recursive: true });
rmSync(stagingRoot, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(stagingRoot, { recursive: true });
const appRoot = path.join(stagingRoot, 'app');
const runtimeRoot = path.join(stagingRoot, 'runtime');
mkdirSync(appRoot, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });

console.log('1/6 编译原生入口...');
const exePath = path.join(stagingRoot, 'AIchat-graph.exe');
execFileSync(compiler, [
  '-O2',
  '-s',
  '-municode',
  '-mwindows',
  '-static',
  '-finput-charset=UTF-8',
  '-o',
  exePath,
  path.join(root, 'native', 'windows', 'launcher.c'),
  '-lole32',
  '-lshell32',
  '-luser32',
], { stdio: 'inherit' });
if (!existsSync(exePath) || statSync(exePath).size < 8 * 1024) fail('原生入口没有生成或过小：' + exePath);

console.log('2/6 复制包根文件与运行时...');
copyFileSync(path.join(root, 'native', 'windows', 'aichat.cmd'), path.join(stagingRoot, 'aichat.cmd'));
copyFileSync(path.join(root, 'native', 'windows', '更新已有程序.cmd'), path.join(stagingRoot, '更新已有程序.cmd'));
copyFileSync(path.join(root, 'native', 'windows', '开始使用.md'), path.join(stagingRoot, '开始使用.md'));
copyFileSync(process.execPath, path.join(runtimeRoot, 'node.exe'));
copyFileSync(path.join(root, 'native', 'windows', 'node-LICENSE.txt'), path.join(runtimeRoot, 'LICENSE'));
if (runGitVersion(path.join(runtimeRoot, 'node.exe')) !== 'v' + nodeVersion) {
  fail('复制到包内的 node.exe 版本不是 v' + nodeVersion);
}
const distributionManifest = {
  kind: 'aichat-graph-portable',
  schemaVersion: 1,
  platform: 'win32-x64',
  buildId: buildInfo.buildId,
  nodeVersion,
};
writeFileSync(path.join(stagingRoot, 'distribution.json'), JSON.stringify(distributionManifest, null, 2) + '\n', 'utf8');

console.log('3/6 复制 app 程序与文档...');
cpSync(path.join(root, 'dist'), path.join(appRoot, 'dist'), { recursive: true });
mkdirSync(path.join(appRoot, 'docs'), { recursive: true });
copyFileSync(path.join(root, 'docs', 'cli.md'), path.join(appRoot, 'docs', 'cli.md'));
copyFileSync(path.join(root, 'docs', 'workspace.md'), path.join(appRoot, 'docs', 'workspace.md'));
mkdirSync(path.join(appRoot, 'skills'), { recursive: true });
cpSync(path.join(root, 'skills', 'aichat-graph'), path.join(appRoot, 'skills', 'aichat-graph'), {
  recursive: true,
  filter: (source) => path.basename(source) !== 'local.env.json',
});
mkdirSync(path.join(appRoot, 'tools'), { recursive: true });
copyFileSync(path.join(root, 'scripts', 'install-skill.ps1'), path.join(appRoot, 'tools', 'install-skill.ps1'));
copyFileSync(path.join(root, 'LICENSE'), path.join(appRoot, 'LICENSE'));
copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), path.join(appRoot, 'THIRD_PARTY_NOTICES.txt'));
copyFileSync(path.join(root, 'package.json'), path.join(appRoot, 'package.json'));
copyFileSync(path.join(root, 'package-lock.json'), path.join(appRoot, 'package-lock.json'));

console.log('4/6 安装 app 生产依赖（npm ci --omit=dev --ignore-scripts）...');
const comspec = process.env.ComSpec ?? 'cmd.exe';
execFileSync(comspec, ['/d', '/s', '/c', 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund'], {
  cwd: appRoot,
  stdio: 'inherit',
  timeout: 900_000,
});
rmSync(path.join(appRoot, 'package-lock.json'), { force: true });
if (!existsSync(path.join(appRoot, 'node_modules'))) fail('app/node_modules 没有生成');
const moduleCount = readdirSync(path.join(appRoot, 'node_modules')).length;
if (moduleCount === 0) fail('app/node_modules 为空');

console.log('5/6 校验包内布局并走一次自包含入口...');
for (const relative of [
  'AIchat-graph.exe',
  'aichat.cmd',
  '更新已有程序.cmd',
  '开始使用.md',
  'distribution.json',
  'runtime/node.exe',
  'runtime/LICENSE',
  'app/package.json',
  'app/dist/next/cli.js',
  'app/dist/portable/update.js',
  'app/dist/web/index.html',
  'app/docs/cli.md',
  'app/skills/aichat-graph/SKILL.md',
  'app/tools/install-skill.ps1',
  'app/LICENSE',
  'app/THIRD_PARTY_NOTICES.txt',
  'app/node_modules',
]) {
  const absolute = path.join(stagingRoot, ...relative.split('/'));
  if (!existsSync(absolute)) fail('包内缺少 ' + relative);
}
checkForbiddenContent('app', appRoot);
const smoke = execFileSync(path.join(runtimeRoot, 'node.exe'), [path.join(appRoot, 'dist', 'next', 'cli.js'), '--help'], {
  cwd: stagingRoot,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120_000,
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!/aichat/i.test(smoke)) fail('包内 CLI 自检没有输出帮助内容');
checkForbiddenContent('包根', stagingRoot);

console.log('6/6 生成 ZIP...');
createZip(zipPath, packagesRoot, stagingName);
const listing = execFileSync('tar.exe', ['-t', '-f', zipPath], { encoding: 'utf8', timeout: 120_000 });
for (const expected of ['AIchat-graph.exe', 'distribution.json', '更新已有程序.cmd', 'app/dist/next/cli.js', 'runtime/node.exe']) {
  if (!listing.includes(expected)) fail('ZIP 缺少 ' + expected);
}

console.log('');
console.log('打包完成：');
console.log('  程序目录：' + stagingRoot);
console.log('  ZIP：' + zipPath + '（' + (statSync(zipPath).size / 1024 / 1024).toFixed(1) + ' MB）');
console.log('  buildId：' + buildInfo.buildId);
console.log('  运行时：Node v' + nodeVersion + '（随包）');
