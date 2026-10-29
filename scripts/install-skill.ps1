#requires -Version 5.1
<#
.SYNOPSIS
  把便携包内的通用 Skill 同步到明确指定的宿主副本，保留本机绑定 local.env.json。

.DESCRIPTION
  本脚本位于程序包的 app\tools\install-skill.ps1；只复制通用内容：
  app\skills\aichat-graph 下的 SKILL.md、references\、scripts\。

  Skill 是可选组件：程序首次打开不会安装或修改任何宿主目录，只有用户主动运行本脚本
  才会写入目标目录。local.env.json 属于本机绑定，不覆盖已有 workspace 等内容；
  其中的 cli 字段会更新为当前程序包的 aichat.cmd，避免留下失效入口。

  必须显式指定 -HostName（workbuddy 或 codex，命令行写作 -Host）或 -Target，
  二者只能选一个。脚本只使用 Windows 自带 PowerShell 5.1 可用的语法。

.PARAMETER HostName
  宿主名称，通过 -Host 指定：workbuddy 解析为 $env:USERPROFILE\.workbuddy\skills\aichat-graph，
  codex 解析为 $env:USERPROFILE\.codex\skills\aichat-graph。不能与 -Target 同时使用。
  参数名为 HostName 是为了避开 PowerShell 自动变量 $Host。

.PARAMETER Target
  已安装副本目录的绝对路径。不能与 -Host 同时使用。

.PARAMETER Source
  通用 Skill 来源目录；默认当前程序包的 app\skills\aichat-graph。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File app\tools\install-skill.ps1 -Host workbuddy

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File app\tools\install-skill.ps1 -Target "C:\Users\me\.codex\skills\aichat-graph"
#>
[CmdletBinding()]
param(
  [Alias('Host')][string] $HostName,
  [string] $Target,
  [string] $Source
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
  # 旧宿主控制台编码不可改时不影响文件复制与结果输出。
}

$usage = @'
用法：
  powershell -NoProfile -ExecutionPolicy Bypass -File app\tools\install-skill.ps1 (-Host workbuddy|codex | -Target <绝对目录>) [-Source <目录>]

  -Host workbuddy   同步到 $env:USERPROFILE\.workbuddy\skills\aichat-graph
  -Host codex       同步到 $env:USERPROFILE\.codex\skills\aichat-graph
  -Target <目录>    同步到指定绝对目录；与 -Host 二选一
  -Source <目录>    通用内容来源；默认为本程序包 app\skills\aichat-graph
'@

function Write-UsageError([string] $Message) {
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

$toolsDirectory = Split-Path -Parent $PSCommandPath
$appRoot = Split-Path -Parent $toolsDirectory
$distributionRoot = Split-Path -Parent $appRoot
$manifestPath = Join-Path $distributionRoot 'distribution.json'
$packageCmd = Join-Path $distributionRoot 'aichat.cmd'

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  [Console]::Error.WriteLine('本脚本必须位于完整便携包的 app\tools 目录：缺少 ' + $manifestPath)
  [Console]::Error.WriteLine('请重新完整解压下载的 ZIP 后再安装 Skill。')
  exit 7
}
if (-not (Test-Path -LiteralPath $packageCmd -PathType Leaf)) {
  [Console]::Error.WriteLine('程序包缺少 aichat.cmd：' + $packageCmd)
  exit 7
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
$Target = [IO.Path]::GetFullPath($Target)

if (-not $Source) { $Source = Join-Path $appRoot 'skills\aichat-graph' }
$Source = [IO.Path]::GetFullPath($Source)
if ($Source -eq $Target) { Write-UsageError '参数错误：-Source 与目标目录不能相同。' }

if (-not (Test-Path -LiteralPath (Join-Path $Source 'SKILL.md') -PathType Leaf)) {
  [Console]::Error.WriteLine('来源不是完整的 Skill 目录：' + $Source)
  exit 7
}
$generic = @('SKILL.md', 'references', 'scripts')
foreach ($relative in $generic) {
  if (-not (Test-Path -LiteralPath (Join-Path $Source $relative))) {
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
$config = [ordered]@{}
$configReadable = $false
$configError = $null
$workspaceKept = $null
if ($configExisted) {
  try {
    $previous = ([IO.File]::ReadAllText($configPath)).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($previous) {
      foreach ($property in $previous.PSObject.Properties) { $config[$property.Name] = $property.Value }
      if ($config.Contains('workspace')) { $workspaceKept = [string]$config['workspace'] }
    }
    $configReadable = $true
  } catch {
    $configError = $_.Exception.Message
  }
}

# 目录整体替换，避免旧文件残留；local.env.json 不在替换范围内。
foreach ($relative in @('references', 'scripts')) {
  $to = Join-Path $Target $relative
  if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
  Copy-Item -LiteralPath (Join-Path $Source $relative) -Destination $to -Recurse
}
Copy-Item -LiteralPath (Join-Path $Source 'SKILL.md') -Destination (Join-Path $Target 'SKILL.md') -Force

# cli 绑定按实际分发布局更新；已有 workspace 等本机内容保留。
$config['cli'] = $packageCmd
if (-not $config.Contains('source')) { $config['source'] = $Source }
$config['installedAt'] = (Get-Date).ToString('yyyy-MM-dd')
$json = ($config | ConvertTo-Json -Depth 8) + [Environment]::NewLine
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($configPath, $json, $utf8NoBom)

Write-Output ''
Write-Output 'Skill 同步结果（只核对文件，不代表宿主已完整可用）：'
Write-Output ('  宿主：' + $hostLabel)
Write-Output ('  程序包：' + $distributionRoot)
Write-Output ('  来源：' + $Source)
Write-Output ('  目标：' + $Target)
Write-Output ('  来源 SKILL.md SHA-256：' + $sourceHash)
if ($configExisted -and $configReadable) {
  Write-Output '  local.env.json：已保留已有内容，cli 已更新为当前程序包入口。'
} elseif ($configExisted) {
  Write-Output ('  local.env.json：原文件无法解析（' + $configError + '），已按当前程序包入口重写；原 workspace 需要你确认后补回。')
} else {
  Write-Output '  local.env.json：已创建（cli 指向当前程序包入口）。'
}
Write-Output ('  cli：' + $packageCmd)
if ($workspaceKept) {
  Write-Output ('  workspace：' + $workspaceKept + '（未修改）')
} else {
  Write-Output '  workspace：尚未绑定。需要时请在 local.env.json 填写讨论库绝对路径，或调用时显式传 --workspace。'
}
Write-Output ''
Write-Output '请按实际宿主核对（文件一致或 --help 成功不等于宿主已完整可用）：'
Write-Output ('  "' + $packageCmd + '" version')
Write-Output ('  "' + $packageCmd + '" whoami --workspace "<实际讨论库>"')
