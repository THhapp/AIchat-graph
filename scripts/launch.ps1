<#
.SYNOPSIS
  AIchat-graph 一键启动器（start.cmd 双击后由 Windows PowerShell 5.1 执行）。

.DESCRIPTION
  - 工程目录只由本脚本自身位置推导（<工程>\scripts\launch.ps1），不依赖当前目录或机器级配置。
  - 默认工作区 %LOCALAPPDATA%\AIchat-graph\workspace；-Workspace <目录> 显式选择并记住到 launcher.local.json。
  - 同一工作区已有服务时只打开浏览器：不启动第二个写进程，也不重新构建。
  - 默认端口 4317 被其他程序占用时明确失败：不换端口、不结束他人进程。
  - 依赖缺失时 npm ci；必需产物缺失或源码比产物新时 npm run build。
  - 新服务就绪后才打开浏览器；服务在当前可见窗口前台运行，进程加入 KILL_ON_JOB_CLOSE
    作业对象，关闭窗口或 Ctrl+C 都不会留下后台写进程。

.PARAMETER Workspace
  工作区目录。不存在或空目录会初始化；非空且不是 AIchat-graph 工作区的目录会被拒绝。
  由 start.cmd 启动时，该值通过 AICHAT_LAUNCH_WORKSPACE 传入，因此路径末尾的分隔符、
  空格与中文都不会破坏命令行引号配对。

.PARAMETER NoBrowser
  不打开浏览器（非交互验收用）。失败时的等待回车由 start.cmd 负责。

.PARAMETER Help
  打印用法并退出。
#>
[CmdletBinding()]
param(
  # start.cmd 解析 -Workspace 后放进环境变量，避免路径末尾的 \ 吃掉参数的结束引号。
  [string] $Workspace = $env:AICHAT_LAUNCH_WORKSPACE,
  [switch] $NoBrowser,
  [switch] $Help
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$CliPath = Join-Path $ProjectRoot 'dist\cli\index.js'
$ConfigPath = Join-Path $ProjectRoot 'launcher.local.json'
$Port = 4317

# ===========================================================================
# 辅助函数
# ===========================================================================

function Write-Info([string] $Message) {
  Write-Host ('[AIchat-graph] ' + $Message)
}

<# 失败一律走这里：说明原因与提示，然后以非零码退出；等待回车由 start.cmd 统一处理。 #>
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
function Resolve-WorkspacePath([string] $Path) {
  $expanded = [Environment]::ExpandEnvironmentVariables($Path)
  if (-not [System.IO.Path]::IsPathRooted($expanded)) {
    $expanded = Join-Path (Get-Location).Path $expanded
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
  那是启动环境本身的形状，不该要求用户去改环境变量。两条输出流异步读取，避免任一侧
  写满管道而互相等待。
#>
function Invoke-Cli {
  param([string[]] $Arguments)
  $process = $null
  try {
    $parts = @($CliPath) + $Arguments
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

<# 只读检查：不创建、不删除、不写入任何东西。 #>
function Assert-WorkspaceUsable([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) {
    Fail ('工作区路径不是目录：' + $Path) '请用 -Workspace 指定一个目录。'
  }
  $entries = Get-WorkspaceEntries $Path
  if ($entries.Count -eq 0) { return }
  if (-not (Test-Path -LiteralPath (Join-Path $Path 'workspace.json'))) {
    Fail ('目录非空且不是 AIchat-graph 工作区：' + $Path) '为避免破坏已有资料，启动器不会在此初始化。请用 -Workspace 指定空目录或已有工作区。'
  }
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
<# 该工作区是否已由同一服务实例持有：whoami 会核对描述文件、服务身份与磁盘根，
   只有四处身份真实一致时才 exit 0；任何失败都视为没有可复用服务。 #>
function Get-ExistingService([string] $Path) {
  if (-not (Test-Path -LiteralPath $CliPath)) { return $null }
  $result = Invoke-Cli -Arguments @('whoami', '--workspace', $Path)
  if (-not $result -or $result.ExitCode -ne 0) { return $null }
  try {
    $parsed = $result.StdOut.Trim() | ConvertFrom-Json
  } catch {
    return $null
  }
  if (-not ($parsed -and $parsed.ok -and $parsed.url)) { return $null }
  $instanceId = ''
  $workspaceId = ''
  if ($parsed.identity) {
    if ($parsed.identity.instanceId) { $instanceId = [string]$parsed.identity.instanceId }
    if ($parsed.identity.workspaceId) { $workspaceId = [string]$parsed.identity.workspaceId }
  }
  return [pscustomobject]@{
    Url = [string]$parsed.url
    WorkspaceId = $workspaceId
    InstanceId = $instanceId
  }
}

function Save-WorkspaceChoice([string] $Path) {
  try {
    $payload = [ordered]@{ workspace = $Path; updatedAt = (Get-Date).ToString('o') }
    $json = ($payload | ConvertTo-Json -Depth 3) + [Environment]::NewLine
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ConfigPath, $json, $utf8NoBom)
  } catch {
    Write-Info ('无法写入 launcher.local.json（不影响本次启动）：' + $_.Exception.Message)
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
  Write-Host '用法：start.cmd [-Workspace <目录>] [-NoBrowser]'
  Write-Host ''
  Write-Host '  默认工作区 %LOCALAPPDATA%\AIchat-graph\workspace；首次运行会初始化空工作区。'
  Write-Host '  -Workspace <目录>  使用指定工作区，并在确认可用后记住到 launcher.local.json'
  Write-Host '                     路径含空格或中文时请加引号；start.cmd 会原样转交。'
  Write-Host '  -NoBrowser         不打开浏览器（非交互验收用）'
  exit 0
}

# ===========================================================================
# 1. 解释器与工程位置
# ===========================================================================

if (-not $env:LOCALAPPDATA) {
  Fail '环境变量 LOCALAPPDATA 不存在，无法确定默认工作区位置。' '请用 -Workspace 显式指定目录。'
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package.json'))) {
  Fail ('工程目录不完整：' + $ProjectRoot) 'launch.ps1 应位于工程根的 scripts 目录下，start.cmd 应位于工程根目录。'
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
# 2. 工作区路径（只解析与只读检查，不建目录）
# ===========================================================================

$workspaceSource = 'default'
$workspacePath = Join-Path $env:LOCALAPPDATA 'AIchat-graph\workspace'

if ($Workspace) {
  try {
    $workspacePath = Resolve-WorkspacePath $Workspace
    $workspaceSource = 'parameter'
  } catch {
    Fail ('工作区路径无法解析：' + $Workspace) $_.Exception.Message
  }
} elseif (Test-Path -LiteralPath $ConfigPath) {
  try {
    $configText = [System.IO.File]::ReadAllText($ConfigPath).TrimStart([char]0xFEFF)
    $config = $configText | ConvertFrom-Json
    if ($config -and $config.workspace -and ([string]$config.workspace).Trim().Length -gt 0) {
      $workspacePath = Resolve-WorkspacePath ([string]$config.workspace)
      $workspaceSource = 'config'
    }
  } catch {
    Write-Info ('launcher.local.json 无法读取，改用默认工作区：' + $_.Exception.Message)
  }
}

Assert-WorkspaceUsable $workspacePath

# ===========================================================================
# 3. 先看该工作区是否已有服务（与服务监听哪个端口无关）
# ===========================================================================

# whoami 会核对描述文件、服务身份与磁盘根，只有真实匹配才 exit 0。
# 必须在端口判断之前做：工作区可能跑在别的端口上，那时 4317 是空的，
# 直接启动第二个写进程只会撞锁。
$existing = Get-ExistingService $workspacePath
if ($existing) {
  Write-Info ('该工作区已有服务在运行：' + $existing.Url)
  if ($existing.InstanceId) { Write-Info ('服务实例：' + $existing.InstanceId) }
  Write-Info '不会启动第二个写进程，也不会重新构建。'
  if ($workspaceSource -eq 'parameter') {
    # 显式选择的库即使已在运行，也应记住为下次默认。
    Save-WorkspaceChoice $workspacePath
  }
  Open-Reader $existing.Url
  exit 0
}

# 没有同工作区的服务时，默认端口必须空闲；被占用就明确失败，不换端口、不动他人进程。
if (Test-PortOpen $Port) {
  $ownerText = Get-PortOwnerText $Port
  Fail ('默认端口 ' + $Port + ' 已被其他程序占用' + $ownerText + '。') '启动器不会切换端口或结束他人进程。请先关闭该程序；若不是本工作区的服务，可先确认它是什么。'
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

# 服务运行时真正需要的产物：CLI 入口、前端页面，以及导出用的离线读者资源。
# 只有产物缺失或源码比产物新才重建，避免每次启动都重编。
$requiredOutputs = @(
  'dist\cli\index.js',
  'dist\web\index.html',
  'dist\offline\reader.js',
  'dist\offline\reader.css'
)
$outputsMissing = $false
$oldestOutput = [datetime]::MaxValue
foreach ($relative in $requiredOutputs) {
  $output = Join-Path $ProjectRoot $relative
  if (-not (Test-Path -LiteralPath $output)) {
    $outputsMissing = $true
  } else {
    $stamp = (Get-Item -LiteralPath $output).LastWriteTime
    if ($stamp -lt $oldestOutput) { $oldestOutput = $stamp }
  }
}

$inputPaths = @(
  'src', 'index.html', 'package.json', 'package-lock.json',
  'vite.config.ts', 'vite.offline.config.ts',
  'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.build.json'
)
$newestInput = Get-NewestWriteTime $inputPaths

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
  foreach ($relative in $requiredOutputs) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $relative))) {
      Fail ('构建完成但缺少产物：' + $relative) '请检查构建配置是否被改动。'
    }
  }
}

# ===========================================================================
# 5. 建立工作区（前置检查已全部通过）
# ===========================================================================

Ensure-Workspace $workspacePath

if ($workspaceSource -eq 'parameter') {
  Save-WorkspaceChoice $workspacePath
}
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
  $serveArgs = @($CliPath, 'serve', '--workspace', $workspacePath)
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
        $failureHint = '请查看上方服务输出中的具体错误；端口占用、写锁冲突或工作区校验失败都会在这里体现。'
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
              if ($response.StatusCode -eq 200 -and $identity -and $identity.workspaceId -eq $candidate.workspaceId) {
                $descriptor = $candidate
                $ready = $true
                break
              }
              $lastProblem = '服务身份与描述文件不一致'
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
