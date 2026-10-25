#requires -Version 7.0
<#
.SYNOPSIS
  把通用 Skill 内容同步到明确指定的宿主副本，保留本机绑定 local.env.json。

.DESCRIPTION
  只覆盖通用内容：SKILL.md、references/、scripts/。
  local.env.json 属于本机绑定（CLI／工作区路径），不覆盖、不生成；缺失时只打印候选内容，
  由使用者确认后自行写入，脚本不伪造路径，也不猜测正式库。

  必须显式指定 -Host（workbuddy 或 codex）或 -Target（绝对目录），二者只能选一个。
  同步后报告来源与目标的绝对路径、来源 SKILL.md 的 SHA-256、local.env.json 是否保留及 cli
  指向的文件是否存在。这些只是文件检查，不代表宿主已完整可用。

.PARAMETER Source
  通用内容的来源目录。默认仓库内 skills/aichat-graph；显式指定时优先于 -Daily。

.PARAMETER Daily
  从日用快照 .local/daily/skills/aichat-graph 同步，保证已安装副本与日用 CLI 同版本。

.PARAMETER HostName
  宿主名称，通过 -Host 指定：workbuddy 解析为 $env:USERPROFILE\.workbuddy\skills\aichat-graph，
  codex 解析为 $env:USERPROFILE\.codex\skills\aichat-graph。不能与 -Target 同时使用。
  参数名为 HostName 是为了避开 PowerShell 自动变量 $Host，命令行仍使用 -Host。

.PARAMETER Target
  已安装副本目录的绝对路径。不能与 -Host 同时使用。

.EXAMPLE
  pwsh scripts/install-skill.ps1 -Daily -Host workbuddy

.EXAMPLE
  pwsh scripts/install-skill.ps1 -Host codex

.EXAMPLE
  pwsh scripts/install-skill.ps1 -Source "D:/path/to/AIchat-graph/skills/aichat-graph" -Target "C:/Users/me/.workbuddy/skills/aichat-graph"
#>
[CmdletBinding()]
param(
  [string] $Source,
  [switch] $Daily,
  [Alias('Host')][string] $HostName,
  [string] $Target
)

$usage = @'
用法：
  pwsh scripts/install-skill.ps1 (-Host workbuddy|codex | -Target <绝对目录>) [-Source <目录>] [-Daily]

  -Host workbuddy   同步到 $env:USERPROFILE\.workbuddy\skills\aichat-graph
  -Host codex       同步到 $env:USERPROFILE\.codex\skills\aichat-graph
  -Target <目录>    同步到指定绝对目录；与 -Host 二选一
  -Source <目录>    通用内容来源；默认仓库 skills/aichat-graph
  -Daily            改用仓库 .local/daily/skills/aichat-graph；显式 -Source 优先
'@

function Write-UsageError {
  param([string] $Message)
  [Console]::Error.WriteLine($Message)
  [Console]::Error.WriteLine($usage)
  exit 2
}

$hostGiven = $PSBoundParameters.ContainsKey('HostName')
$targetGiven = $PSBoundParameters.ContainsKey('Target')

if ($hostGiven -and $targetGiven) {
  Write-UsageError '参数错误：-Host 与 -Target 只能指定一个，不能同时给出。'
}
if (-not $hostGiven -and -not $targetGiven) {
  Write-UsageError '参数错误：必须显式指定 -Host workbuddy|codex 或 -Target <绝对目录>。'
}

if ($hostGiven) {
  $hostValue = if ($null -ne $HostName) { $HostName.Trim().ToLowerInvariant() } else { '' }
  switch ($hostValue) {
    'workbuddy' { $Target = Join-Path $env:USERPROFILE '.workbuddy\skills\aichat-graph' }
    'codex'     { $Target = Join-Path $env:USERPROFILE '.codex\skills\aichat-graph' }
    default     { Write-UsageError ('参数错误：-Host 只能是 workbuddy 或 codex，收到：' + $HostName) }
  }
  $hostLabel = $hostValue
} else {
  if (-not [IO.Path]::IsPathRooted($Target)) {
    Write-UsageError ('参数错误：-Target 必须是绝对路径，收到：' + $Target)
  }
  $hostLabel = '自定义 -Target'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Source) {
  $Source = Join-Path $repoRoot 'skills\aichat-graph'
  if ($Daily) { $Source = Join-Path $repoRoot '.local\daily\skills\aichat-graph' }
}
$Source = [IO.Path]::GetFullPath($Source)
$Target = [IO.Path]::GetFullPath($Target)

if ($Source -eq $Target) {
  Write-UsageError '参数错误：-Source 与目标目录不能相同。'
}

if (-not (Test-Path -LiteralPath (Join-Path $Source 'SKILL.md') -PathType Leaf)) {
  [Console]::Error.WriteLine('来源不是完整的 Skill 目录：' + $Source)
  [Console]::Error.WriteLine('仓库内请先执行 update-daily.cmd，或用 -Daily 指向 .local/daily 的同版本副本。')
  exit 7
}

$generic = @('SKILL.md', 'references', 'scripts')
foreach ($relative in $generic) {
  $from = Join-Path $Source $relative
  if (-not (Test-Path -LiteralPath $from)) {
    [Console]::Error.WriteLine('来源缺少通用内容：' + $relative)
    exit 7
  }
}

$sourceHash = (Get-FileHash -LiteralPath (Join-Path $Source 'SKILL.md') -Algorithm SHA256).Hash

if (-not (Test-Path -LiteralPath $Target)) {
  [void](New-Item -ItemType Directory -Path $Target -Force)
}
$configPath = Join-Path $Target 'local.env.json'
$configExisted = Test-Path -LiteralPath $configPath -PathType Leaf
$config = $null
$configReadable = $false
$configError = $null
$cliPath = $null
$workspacePath = $null

if ($configExisted) {
  try {
    $config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json -ErrorAction Stop
    $configReadable = $true
    if ($config.PSObject.Properties['cli'] -and $config.cli) { $cliPath = [string]$config.cli }
    if ($config.PSObject.Properties['workspace'] -and $config.workspace) { $workspacePath = [string]$config.workspace }
  } catch {
    $configError = $_.Exception.Message
  }
}

# 目录整体替换，避免旧文件残留导致同版本文件不一致；local.env.json 不在替换范围内。
foreach ($relative in @('references', 'scripts')) {
  $to = Join-Path $Target $relative
  if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
  Copy-Item -LiteralPath (Join-Path $Source $relative) -Destination $to -Recurse
}
Copy-Item -LiteralPath (Join-Path $Source 'SKILL.md') -Destination (Join-Path $Target 'SKILL.md') -Force

# 源码树里若混入本机绑定，只提示不复制，避免不同批次之间互相覆盖。
$straySource = Join-Path $Source 'local.env.json'
if (Test-Path -LiteralPath $straySource) {
  [Console]::Error.WriteLine('提示：来源目录含 local.env.json（本机绑定），已忽略，不会复制到安装副本。')
}

Write-Output ''
Write-Output '同步结果（只核对文件，不代表宿主已完整可用）：'
Write-Output ('  宿主：' + $hostLabel)
Write-Output ('  来源：' + $Source)
Write-Output ('  目标：' + $Target)
Write-Output ('  来源 SKILL.md SHA-256：' + $sourceHash)

if ($configExisted) {
  Write-Output '  local.env.json：存在，已保留（未覆盖、未修改）。'
  if ($configReadable) {
    if ($cliPath) {
      $cliExists = Test-Path -LiteralPath $cliPath -PathType Leaf
      $cliState = if ($cliExists) { '文件存在' } else { '文件不存在' }
      Write-Output ('    cli：' + $cliPath + '（' + $cliState + '）')
    } else {
      Write-Output '    cli：未配置，无法定位已安装的 CLI。'
    }
  } else {
    Write-Output ('    无法解析 local.env.json，未读取 cli：' + $configError)
  }
} else {
  Write-Output '  local.env.json：不存在（未生成）。本副本无法定位已安装的 CLI（仓库内或 .local/daily 内的副本靠相对路径定位，可忽略此项）。'
  Write-Output '  若这是宿主 Skill 目录，请确认后自行创建，脚本不会代写：'
  $repoCli = Join-Path $repoRoot '.local\daily\dist\cli\index.js'
  if (-not (Test-Path -LiteralPath $repoCli)) { $repoCli = Join-Path $repoRoot 'dist\cli\index.js' }
  $suggested = [ordered]@{
    _comment = '本机安装绑定。显式 -Cli 优先于此处默认值。'
    cli      = $repoCli
    workspace = '<你的工作区绝对路径>'
    source   = $Source
    installedAt = (Get-Date).ToString('yyyy-MM-dd')
  }
  Write-Output '  可写入的字段（cli 为当前工程最接近的候选，需你确认；workspace 请填实际值）：'
  Write-Output (($suggested | ConvertTo-Json) -replace "`r`n", "`n")
}

Write-Output ''
Write-Output '请按实际宿主核对（文件一致或 --help 成功不等于宿主已完整可用）：'
$cliHint = if ($cliPath) { $cliPath } else { '<cli>' }
$workspaceHint = if ($workspacePath) { $workspacePath } else { '<实际工作区>' }
Write-Output ('  node "' + $cliHint + '" --help')
Write-Output ('  需要时：node "' + $cliHint + '" whoami --workspace "' + $workspaceHint + '"')
