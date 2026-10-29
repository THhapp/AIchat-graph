<#
.SYNOPSIS
  AIchat-graph 源码开发启动（仅 Development）。正式日用请使用 start.cmd / .local\daily\AIchat-graph.exe。

.DESCRIPTION
  - 工程目录只由本脚本自身位置推导（<工程>\scripts\launch.ps1），不依赖当前目录或机器级配置。
  - 开发使用独立工作区（默认 .local/development-workspace）与端口 4318，不读写正式日用配置；
    正式日用由便携包程序自行管理默认库，本脚本不复制也不改写它。
  - 同一工作区已有服务时只打开浏览器：不启动第二个写进程，也不重新构建。
  - 端口被其他程序占用时明确失败：不换端口、不结束他人进程。
  - 源码变化时自动 npm run build；服务就绪后才打开浏览器。
  - 服务在当前可见窗口前台运行，进程加入 KILL_ON_JOB_CLOSE 作业对象；
    关闭窗口或 Ctrl+C 都不会留下后台写进程。
  - 旧 Markdown 工作区不自动迁移：先用 CLI import 一次性导入 graph.sqlite。

.PARAMETER Workspace
  开发工作区目录。不存在或空目录会初始化；非空且不是 AIchat-graph 工作区的目录会被拒绝。
  由 start-dev.cmd 启动时，该值通过 AICHAT_LAUNCH_WORKSPACE 传入，避免路径末尾的分隔符、
  空格与中文破坏命令行引号配对。

.PARAMETER NoBrowser
  不打开浏览器（非交互验收用）。失败时的等待回车由 start-dev.cmd 负责。

.PARAMETER Help
  打印用法并退出。
#>
[CmdletBinding()]
param(
  # start-dev.cmd 解析 -Workspace 后放进环境变量，避免路径末尾的 \ 吃掉参数的结束引号。
  [string] $Workspace = $env:AICHAT_LAUNCH_WORKSPACE,
  [ValidateSet('Development')]
  [string] $Mode = 'Development',
  [ValidateRange(0, 65535)]
  [int] $Port = $(if ($env:AICHAT_LAUNCH_PORT) { [int]$env:AICHAT_LAUNCH_PORT } else { 0 }),
  [switch] $NoBrowser,
  [switch] $Help
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LocalRoot = Join-Path $ProjectRoot '.local'
$DefaultWorkspace = Join-Path $LocalRoot 'development-workspace'
$DailyDefaultConfig = Join-Path $LocalRoot 'daily\.aichat\default.json'
$CliPath = Join-Path $ProjectRoot 'dist\next\cli.js'
# 与 src/next/protocol.ts 的 INTERFACE_VERSION 保持一致；用于识别旧接口服务。
$ExpectedInterfaceVersion = 4
if ($Port -eq 0) { $Port = 4318 }
# 开发构建产物：构建后必须齐全，也是判断源码是否比产物新的基准。
$BuildOutputs = @('dist\next\cli.js', 'dist\web\index.html', 'dist\offline\reader.js', 'dist\offline\reader.css', 'dist\build-info.json')
$InputPaths = @('src', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'vite.offline.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.build.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'licenses', 'scripts\generate-notices.mjs', 'scripts\generate-build-info.mjs')

# ===========================================================================
# 辅助函数
# ===========================================================================

function Write-Info([string] $Message) {
  Write-Host ('[AIchat-graph] ' + $Message)
}

<# 失败一律走这里：说明原因与提示，然后以非零码退出；等待回车由 start-dev.cmd 统一处理。 #>
function Fail([string] $Message, [string] $Hint) {
  Write-Host ''
  Write-Host ('[AIchat-graph] 启动失败：' + $Message) -ForegroundColor Red
  if ($Hint) { Write-Host ('              提示：' + $Hint) -ForegroundColor Yellow }
  exit 1
}

function Test-PortOpen([int] $PortNumber) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $PortNumber, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(400)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-PortOwnerText([int] $PortNumber) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($conn) {
      $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
      if ($owner) { return ('（占用进程：' + $owner.ProcessName + ' pid ' + $owner.Id + '）') }
    }
  } catch { }
  return ''
}

<# 给 Node 的原生命令行参数加引号：内部双引号成对转义，末尾反斜杠加倍，
   避免 Windows 命令行把结尾的 \ 当成转义引号。 #>
function ConvertTo-NativeArgument([string] $Value) {
  if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq [char]'\') {
      $backslashes += 1
      continue
    }
    if ($ch -eq [char]'"') {
      [void]$builder.Append([char]'\', ($backslashes * 2 + 1))
      [void]$builder.Append([char]'"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append([char]'\', $backslashes)
      $backslashes = 0
    }
    [void]$builder.Append($ch)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append([char]'\', ($backslashes * 2))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

<# 解析成绝对路径并去掉末尾分隔符：末尾的 \ 会让 Node 收到配对错误的引号。
   只去掉非根目录的尾分隔符，C:\ 与 \\server\share\ 保持原样。 #>
function Resolve-WorkspacePath([string] $Path, [string] $Base = (Get-Location).Path) {
  $expanded = [Environment]::ExpandEnvironmentVariables($Path)
  if (-not [System.IO.Path]::IsPathRooted($expanded)) {
    $expanded = Join-Path $Base $expanded
  }
  $full = [System.IO.Path]::GetFullPath($expanded)
  $root = [System.IO.Path]::GetPathRoot($full)
  while ($full.Length -gt $root.Length -and ($full.EndsWith('\') -or $full.EndsWith('/'))) {
    $full = $full.Substring(0, $full.Length - 1)
  }
  return $full
}

<#
  运行本工程的 CLI 并取回退出码与输出；不经过控制台，避免与服务输出混在一起。
  用 Process／ProcessStartInfo 直接继承环境启动，不走 Start-Process：当环境块里含有
  仅大小写不同的重复变量（例如同时存在 NO_PROXY 与 no_proxy）时，Windows PowerShell
  5.1 的 Start-Process 会在内部合并大小写不敏感的字典处抛 "Item has already been added"。
  两条输出流异步读取，避免任一侧写满管道而互相等待。
#>
function Invoke-Cli {
  param([string[]] $Arguments, [switch] $NodeOnly)
  $process = $null
  try {
    $parts = @($CliPath) + $Arguments
    if ($NodeOnly) { $parts = $Arguments }
    $argumentLine = (@($parts | ForEach-Object { ConvertTo-NativeArgument ([string]$_) })) -join ' '
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodeExe
    $startInfo.Arguments = $argumentLine
    $startInfo.WorkingDirectory = $ProjectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
      return [pscustomobject]@{ ExitCode = -1; StdOut = ''; StdErr = '无法启动 CLI 进程。' }
    }
    $stdOutTask = $process.StandardOutput.ReadToEndAsync()
    $stdErrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      StdOut = $stdOutTask.Result
      StdErr = $stdErrTask.Result
    }
  } catch {
    return [pscustomobject]@{ ExitCode = -1; StdOut = ''; StdErr = $_.Exception.Message }
  } finally {
    if ($process) { $process.Dispose() }
  }
}

function Get-CanonicalWorkspacePath([string] $Path) {
  # Resolve existing ancestors too, so junction aliases cannot bypass isolation.
  $code = 'const fs=require("node:fs"),p=require("node:path");let x=p.resolve(process.argv[1]),tail=[];while(!fs.existsSync(x)){tail.unshift(p.basename(x));const up=p.dirname(x);if(up===x)break;x=up;}process.stdout.write(p.resolve(fs.realpathSync(x),...tail));'
  $result = Invoke-Cli -NodeOnly -Arguments @('-e', $code, $Path)
  if ($result.ExitCode -ne 0) { Fail ('无法核对工作区实际路径：' + $Path) $result.StdErr }
  return $result.StdOut.Trim().TrimEnd('\')
}

function Get-NpmCommand {
  foreach ($name in @('npm.cmd', 'npm')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }
  }
  Fail '找不到 npm。' '请确认 Node.js 已安装并在 PATH 中（本工程要求 Node 24）。'
  return $null
}

function Get-WorkspaceEntries([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  return @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)
}

<# 只读检查：不创建、不删除、不写入任何东西。
   新工作区以 graph.sqlite 识别；只有旧 workspace.json 的目录属于待导入资料，
   启动器不自动迁移，也不改写其中任何文件。 #>
function Assert-WorkspaceUsable([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) {
    Fail ('工作区路径不是目录：' + $Path) '请用 -Workspace 指定一个目录。'
  }
  $entries = Get-WorkspaceEntries $Path
  if ($entries.Count -eq 0) { return }
  if (Test-Path -LiteralPath (Join-Path $Path 'graph.sqlite') -PathType Leaf) { return }
  if (Test-Path -LiteralPath (Join-Path $Path 'workspace.json') -PathType Leaf) {
    Fail ('该目录是旧版 Markdown 资料，还没有 graph.sqlite：' + $Path) ('先用 CLI import --workspace "' + $Path + '" 一次性导入，再启动；启动器不会自动迁移或改写旧文件。')
  }
  Fail ('目录非空且不是 AIchat-graph 工作区：' + $Path) '为避免破坏已有资料，启动器不会在此初始化。请用 -Workspace 指定空目录或已有工作区。'
}

<# 前置检查都通过后才真正建立工作区：只在不存在或空目录时初始化。 #>
function Ensure-Workspace([string] $Path) {
  if (Test-Path -LiteralPath $Path) {
    $entries = Get-WorkspaceEntries $Path
    if ($entries.Count -gt 0) { return }
    # init 只接受不存在的目标；空目录没有数据，可安全移除后重建骨架。
    try {
      Remove-Item -LiteralPath $Path -Force
    } catch {
      Fail ('空目录无法移除，不能初始化：' + $Path) $_.Exception.Message
    }
  }
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    try {
      [void](New-Item -ItemType Directory -Path $parent -Force)
    } catch {
      Fail ('无法创建父目录：' + $parent) $_.Exception.Message
    }
  }
  Write-Info ('初始化空工作区：' + $Path)
  $result = Invoke-Cli -Arguments @('init', $Path, '--name', (Split-Path -Leaf $Path))
  if ($result.ExitCode -ne 0) {
    $detail = $result.StdErr.Trim()
    if (-not $detail) { $detail = $result.StdOut.Trim() }
    Fail ('init 失败（退出码 ' + $result.ExitCode + '）。') $detail
  }
}

<# 该工作区是否已有可复用的同版本服务：直接读 <ws>/.aichat/runtime/service.json，
   再 GET /api/workspace 核对 workspaceId。不依赖 CLI 输出格式，不猜其他路径或端口；
   任何一步不成立都视为没有可复用服务。 #>
function Get-ExistingService([string] $Path) {
  $descriptorPath = Join-Path $Path '.aichat\runtime\service.json'
  if (-not (Test-Path -LiteralPath $descriptorPath -PathType Leaf)) { return $null }
  try {
    $descriptor = (([IO.File]::ReadAllText($descriptorPath)).TrimStart([char]0xFEFF)) | ConvertFrom-Json
  } catch {
    return $null
  }
  if (-not ($descriptor -and $descriptor.url -and $descriptor.workspaceId)) { return $null }
  $url = ([string]$descriptor.url).TrimEnd('/')
  try {
    $response = Invoke-WebRequest -Uri ($url + '/api/workspace') -UseBasicParsing -TimeoutSec 3
    $identity = $response.Content | ConvertFrom-Json
  } catch {
    return $null
  }
  if ($response.StatusCode -ne 200 -or -not $identity) { return $null }
  if ([string]$identity.workspaceId -ne [string]$descriptor.workspaceId) { return $null }
  $serviceInterface = $null
  if ($identity.program -and $identity.program.interfaceVersion) { $serviceInterface = [int]$identity.program.interfaceVersion }
  if ($serviceInterface -ne $ExpectedInterfaceVersion) {
    $actual = if ($null -eq $serviceInterface) { '未声明' } else { [string]$serviceInterface }
    Fail ('该工作区已有服务，但接口版本不匹配（开发启动器需要 ' + $ExpectedInterfaceVersion + '，实际 ' + $actual + '）：' + [string]$descriptor.url) '这不是当前源码版本的服务。请先停止该服务；启动器不会结束其他进程。'
  }
  $instanceId = ''
  if ($descriptor.instanceId) { $instanceId = [string]$descriptor.instanceId }
  return [pscustomobject]@{
    Url = [string]$descriptor.url
    WorkspaceId = [string]$descriptor.workspaceId
    InstanceId = $instanceId
  }
}

# 注意：这里保留 Start-Process 是刻意的——打开浏览器走的是 ShellExecute 路径，
# 不会触发上面提到的环境字典合并在大小写重复变量上失败。
function Open-Reader([string] $Url) {
  if ($NoBrowser) {
    Write-Info ('（-NoBrowser）请手动打开：' + $Url)
    return
  }
  Write-Info ('打开浏览器：' + $Url)
  try {
    Start-Process $Url | Out-Null
  } catch {
    Write-Info ('浏览器打开失败，请手动访问：' + $Url)
  }
}

function Get-NewestWriteTime([string[]] $Paths) {
  $newest = [datetime]::MinValue
  foreach ($relative in $Paths) {
    $target = Join-Path $ProjectRoot $relative
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $item = Get-Item -LiteralPath $target -Force
    if ($item.PSIsContainer) {
      $candidate = Get-ChildItem -LiteralPath $target -Recurse -File -Force -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
      if ($candidate -and $candidate.LastWriteTime -gt $newest) { $newest = $candidate.LastWriteTime }
    } elseif ($item.LastWriteTime -gt $newest) {
      $newest = $item.LastWriteTime
    }
  }
  return $newest
}

<#
  让服务进程跟随本窗口：KILL_ON_JOB_CLOSE 作业对象。关闭窗口或 Ctrl+C 时
  句柄随进程释放，服务被系统一并结束，不依赖它是否来得及优雅退出。
#>
function New-KillOnCloseJob {
  if (-not ('AichatJob' -as [type])) {
    $source = @'
using System;
using System.Runtime.InteropServices;
public static class AichatJob {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimitInformation {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  public static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    ExtendedLimitInformation info = new ExtendedLimitInformation();
    info.LimitFlags = 0x2000;
    int length = Marshal.SizeOf(typeof(ExtendedLimitInformation));
    IntPtr buffer = Marshal.AllocHGlobal(length);
    try {
      Marshal.StructureToPtr(info, buffer, false);
      if (!SetInformationJobObject(job, 9, buffer, length)) return IntPtr.Zero;
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
    return job;
  }
  public static bool Assign(IntPtr job, IntPtr process) { return AssignProcessToJobObject(job, process); }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  }
  return [AichatJob]::Create()
}

# ===========================================================================
# 用法
# ===========================================================================

if ($Help) {
  Write-Host '开发：start-dev.cmd [-Workspace <目录>] [-Port <端口>] [-NoBrowser] [-Help]'
  Write-Host ''
  Write-Host '  开发读取当前工程源码，独立工作区默认 .local/development-workspace，端口默认 4318。'
  Write-Host '  不读写正式日用的默认库与配置；正式日用请用 start.cmd（.local\daily\AIchat-graph.exe）。'
  Write-Host '  -Workspace <目录>  使用指定开发工作区（路径含空格或中文时请加引号）。'
  Write-Host '  -Port <端口>       指定开发服务端口。'
  Write-Host '  -NoBrowser         不打开浏览器（非交互验收用）'
  Write-Host '  旧 Markdown 工作区先执行 CLI import --workspace <目录> 一次性导入 graph.sqlite；'
  Write-Host '  启动器不自动迁移或改写旧文件，也不会结束其他服务进程。'
  exit 0
}

# ===========================================================================
# 1. 解释器与工程位置
# ===========================================================================

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package.json'))) {
  Fail ('工程目录不完整：' + $ProjectRoot) 'launch.ps1 应位于工程根的 scripts 目录下，start-dev.cmd 应位于工程根目录。'
}

$nodeExe = 'node.exe'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodeExe = $nodeCommand.Source }
$nodeVersion = ''
try {
  $nodeVersion = ([string](& $nodeExe --version)).Trim()
} catch {
  $nodeVersion = ''
}
if (-not $nodeVersion) {
  Fail '无法执行 node。' '请确认 Node.js 已安装并在 PATH 中（本工程要求 Node 24）。'
}

# ===========================================================================
# 2. 开发工作区（只解析与只读检查，不建目录）
# ===========================================================================

if ($Workspace) {
  try {
    $workspacePath = Resolve-WorkspacePath $Workspace
  } catch {
    Fail ('工作区路径无法解析：' + $Workspace) $_.Exception.Message
  }
} else {
  $workspacePath = Resolve-WorkspacePath $DefaultWorkspace
}

# 开发不能继承正式日用默认库：读取便携包自己的 <daily>/.aichat/default.json。
if (Test-Path -LiteralPath $DailyDefaultConfig) {
  try {
    $dailyConfig = ([IO.File]::ReadAllText($DailyDefaultConfig)).TrimStart([char]0xFEFF) | ConvertFrom-Json
  } catch {
    Fail '正式日用默认配置无法读取，不能确认开发隔离。' $_.Exception.Message
  }
  if ($dailyConfig -and $dailyConfig.workspace) {
    $dailyWorkspace = Resolve-WorkspacePath ([string]$dailyConfig.workspace) $ProjectRoot
    $dailyWorkspace = Get-CanonicalWorkspacePath $dailyWorkspace
    $developmentWorkspace = Resolve-WorkspacePath $workspacePath
    $developmentWorkspace = Get-CanonicalWorkspacePath $developmentWorkspace
    if ($dailyWorkspace.Equals($developmentWorkspace, [StringComparison]::OrdinalIgnoreCase) -or $dailyWorkspace.StartsWith($developmentWorkspace + '\', [StringComparison]::OrdinalIgnoreCase) -or $developmentWorkspace.StartsWith($dailyWorkspace + '\', [StringComparison]::OrdinalIgnoreCase)) {
      Fail '开发与正式日用工作区相同或相互包含，拒绝启动。' '请用 -Workspace 为开发选择独立目录；本脚本不会改用正式库。'
    }
  }
}
$dailyRoot = Join-Path $LocalRoot 'daily'
$canonicalDailyRoot = [IO.Path]::GetFullPath($dailyRoot).TrimEnd('\')
$canonicalDevelopment = [IO.Path]::GetFullPath($workspacePath).TrimEnd('\')
if ($canonicalDevelopment.Equals($canonicalDailyRoot, [StringComparison]::OrdinalIgnoreCase) -or $canonicalDevelopment.StartsWith($canonicalDailyRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
  Fail '开发工作区不能放在 .local\daily 程序目录内。' '请用 -Workspace 指定独立目录。'
}

Assert-WorkspaceUsable $workspacePath

# ===========================================================================
# 3. 先看该工作区是否已有服务（与服务监听哪个端口无关）
# ===========================================================================

$existing = Get-ExistingService $workspacePath
if ($existing) {
  Write-Info ('该工作区已有服务在运行：' + $existing.Url)
  if ($existing.InstanceId) { Write-Info ('服务实例：' + $existing.InstanceId) }
  Write-Info '不会启动第二个写进程，也不会重新构建。'
  Open-Reader $existing.Url
  exit 0
}

# 没有同工作区的服务时，开发端口必须空闲；被占用就明确失败，不换端口、不动他人进程。
if (Test-PortOpen $Port) {
  $ownerText = Get-PortOwnerText $Port
  Fail ('开发端口 ' + $Port + ' 已被其他程序占用' + $ownerText + '。') '启动器不会切换端口或结束他人进程。请先关闭该程序，或用 -Port 指定其他端口。'
}

# ===========================================================================
# 4. 依赖与构建
# ===========================================================================

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
  $npmCmd = Get-NpmCommand
  Write-Info '首次运行：安装依赖（npm ci，需要网络）…'
  Push-Location -LiteralPath $ProjectRoot
  try {
    & $npmCmd ci
    $npmExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($npmExit -ne 0) {
    Fail ('npm ci 失败（退出码 ' + $npmExit + '）。') '请检查网络与 npm 配置后重新双击启动。'
  }
}

$outputsMissing = $false
$oldestOutput = [datetime]::MaxValue
foreach ($relative in $BuildOutputs) {
  $output = Join-Path $ProjectRoot $relative
  if (-not (Test-Path -LiteralPath $output)) {
    $outputsMissing = $true
  } else {
    $stamp = (Get-Item -LiteralPath $output).LastWriteTime
    if ($stamp -lt $oldestOutput) { $oldestOutput = $stamp }
  }
}

$newestInput = Get-NewestWriteTime $InputPaths
if ($outputsMissing -or ($newestInput -gt $oldestOutput)) {
  $npmCmd = Get-NpmCommand
  if ($outputsMissing) {
    Write-Info '构建产物缺失：开始 npm run build（首次可能较慢）…'
  } else {
    Write-Info '源码比构建产物新：开始 npm run build…'
  }
  Push-Location -LiteralPath $ProjectRoot
  try {
    & $npmCmd run build
    $buildExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($buildExit -ne 0) {
    Fail ('npm run build 失败（退出码 ' + $buildExit + '）。') '请查看上方构建输出中的错误；修好后重新双击启动。'
  }
  foreach ($relative in $BuildOutputs) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $relative))) {
      Fail ('构建完成但缺少产物：' + $relative) '请检查构建配置与 scripts/generate-build-info.mjs 是否被改动。'
    }
  }
}

# ===========================================================================
# 5. 建立工作区（前置检查已全部通过）
# ===========================================================================

Ensure-Workspace $workspacePath

# ===========================================================================
# 6. 前台启动服务，就绪后打开浏览器
# ===========================================================================

Write-Info ('工作区：' + $workspacePath)
Write-Info ('服务地址：http://127.0.0.1:' + $Port)
Write-Info '服务输出如下；按 Ctrl+C 或关闭窗口即可停止（不会留下后台写进程）。'
Write-Host ''

$descriptorPath = Join-Path $workspacePath '.aichat\runtime\service.json'

$serveJob = [IntPtr]::Zero
try {
  $serveJob = New-KillOnCloseJob
} catch {
  Write-Info ('无法创建作业对象（不影响启动，但关闭窗口可能留下服务进程）：' + $_.Exception.Message)
}

$serveProcess = $null
$interrupted = $false
$failure = $null
$failureHint = $null
$ready = $false
$lastProblem = '服务尚未发布描述文件'
$descriptor = $null

try {
  # 逐参数转义后拼给 node：中文、空格与结尾分隔符都不会破坏引号配对。
  $serveArgs = @($CliPath, 'serve', '--workspace', $workspacePath, '--port', [string]$Port)
  $argumentLine = (@($serveArgs | ForEach-Object { ConvertTo-NativeArgument ([string]$_) })) -join ' '
  try {
    # 同样用 ProcessStartInfo：不重定向输出，服务日志直接留在当前可见窗口里。
    $serveStartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $serveStartInfo.FileName = $nodeExe
    $serveStartInfo.Arguments = $argumentLine
    $serveStartInfo.WorkingDirectory = $ProjectRoot
    $serveStartInfo.UseShellExecute = $false
    $serveStartInfo.CreateNoWindow = $false
    $serveStartInfo.RedirectStandardOutput = $false
    $serveStartInfo.RedirectStandardError = $false
    $serveProcess = New-Object System.Diagnostics.Process
    $serveProcess.StartInfo = $serveStartInfo
    if (-not $serveProcess.Start()) {
      $failure = '无法启动服务进程：系统没有返回进程句柄。'
      $failureHint = '请确认 node 可执行。'
    }
  } catch {
    $failure = '无法启动服务进程：' + $_.Exception.Message
    $failureHint = '请确认 node 可执行。'
  }

  if (-not $failure) {
    if ($serveJob -ne [IntPtr]::Zero) {
      try {
        if (-not [AichatJob]::Assign($serveJob, $serveProcess.Handle)) {
          Write-Info '警告：服务进程未能加入作业对象；关闭窗口时可能留下进程，请用 Ctrl+C 停止。'
        }
      } catch {
        Write-Info ('警告：服务进程加入作业对象失败：' + $_.Exception.Message)
      }
    }

    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
      if ($serveProcess.HasExited) {
        $failure = '服务进程已退出（退出码 ' + $serveProcess.ExitCode + '）。'
        $failureHint = '请查看上方服务输出中的具体错误；端口占用、工作区校验失败都会在这里体现。'
        break
      }
      if (Test-Path -LiteralPath $descriptorPath) {
        try {
          $candidate = ([System.IO.File]::ReadAllText($descriptorPath)).TrimStart([char]0xFEFF) | ConvertFrom-Json
          if ($candidate -and $candidate.url -and ([int]$candidate.pid -eq $serveProcess.Id)) {
            $probeUrl = ([string]$candidate.url).TrimEnd('/') + '/api/workspace'
            try {
              $response = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 3
              $identity = $response.Content | ConvertFrom-Json
              $serviceInterface = $null
              if ($identity -and $identity.program -and $identity.program.interfaceVersion) { $serviceInterface = [int]$identity.program.interfaceVersion }
              if ($response.StatusCode -eq 200 -and $identity -and $identity.workspaceId -eq $candidate.workspaceId -and $serviceInterface -eq $ExpectedInterfaceVersion) {
                $descriptor = $candidate
                $ready = $true
                break
              }
              if ($identity -and $identity.workspaceId -eq $candidate.workspaceId) {
                $lastProblem = '服务接口版本不匹配（需要 ' + $ExpectedInterfaceVersion + '，实际 ' + [string]$serviceInterface + '）'
              } else {
                $lastProblem = '服务身份与描述文件不一致'
              }
            } catch {
              $lastProblem = $_.Exception.Message
            }
          }
        } catch {
          $lastProblem = $_.Exception.Message
        }
      }
      Start-Sleep -Milliseconds 300
    }

    if (-not $ready -and -not $failure) {
      $failure = '服务在 90 秒内没有就绪。'
      $failureHint = '最后的问题：' + $lastProblem
    }
  }

  if (-not $failure) {
    Write-Host ''
    Write-Info ('服务已就绪：' + [string]$descriptor.url)
    Write-Info ('工作区身份：' + [string]$descriptor.workspaceId)
    Open-Reader ([string]$descriptor.url)

    # 前台等待：这个窗口就是服务窗口。
    try { $serveProcess.WaitForExit() } catch { }
    if (-not $serveProcess.HasExited) { $interrupted = $true }
  }
} finally {
  if ($serveProcess -and -not $serveProcess.HasExited) {
    try { Stop-Process -Id $serveProcess.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

if ($failure) {
  Fail $failure $failureHint
}
if ($interrupted) {
  # Ctrl+C 或窗口关闭：作业对象会随本进程一起结束服务，这里直接正常退出。
  exit 0
}

$exitCode = 0
if ($serveProcess -and $serveProcess.HasExited) { $exitCode = $serveProcess.ExitCode }
if ($exitCode -ne 0) {
  Write-Info ('服务已退出，退出码 ' + $exitCode + '。')
}
exit $exitCode
