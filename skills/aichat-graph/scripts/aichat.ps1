#requires -Version 5.1
<#
.SYNOPSIS
  用实际安装的 AIchat-graph CLI 调用 aichat；源码、便携包和已安装副本共用这一份脚本。

.DESCRIPTION
  解析顺序（前者优先，命中即停）：
    1. -Cli <路径>：本次调用显式指定；
    2. local.env.json 的 cli：本机安装绑定，按“脚本同目录 → Skill 根”查找；
    3. 随包/仓库推导：Skill 位于 app/skills/... 时使用同包 runtime/node.exe + app/dist/next/cli.js；
       源码仓库使用系统 node + dist/next/cli.js。
  都不成立时明确失败并列出尝试过的路径；不猜正式库、不自动切换运行版本、不修改配置。
  显式传了 -Cli 但文件不存在时直接失败，不会悄悄改用本机绑定的其他版本。
  分发入口为包根 aichat.cmd；包装脚本直接执行包内 Node 与 JS，避免长文本反复穿过 shell。
#>
[CmdletBinding()]
param(
  [Parameter()][string] $Cli,
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]] $CliArgs
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {
  # 旧宿主控制台编码不可改时不影响命令执行。
}

$scriptDir = Split-Path -Parent $PSCommandPath
$tried = [System.Collections.Generic.List[string]]::new()
$notes = [System.Collections.Generic.List[string]]::new()
$entry = $null

function Get-NodeAndEntry([string] $Path) {
  if ($Path -match '\.cmd$') {
    $root = Split-Path -Parent $Path
    $manifest = Join-Path $root 'distribution.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
      throw ('包的 distribution.json 不存在：' + $manifest)
    }
    $node = Join-Path $root 'runtime\node.exe'
    $js = Join-Path $root 'app\dist\next\cli.js'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw ('包内 Node 不存在：' + $node) }
    if (-not (Test-Path -LiteralPath $js -PathType Leaf)) { throw ('包内 CLI 不存在：' + $js) }
    return [pscustomobject]@{ Node = $node; Entry = $js }
  }
  return [pscustomobject]@{ Node = 'node'; Entry = $Path }
}

# 1. 本次显式指定；给了却找不到时直接失败，不退回别的版本
if ($Cli) {
  $tried.Add('-Cli ' + $Cli)
  if (Test-Path -LiteralPath $Cli -PathType Leaf) { $entry = (Resolve-Path -LiteralPath $Cli).Path }
  else { $notes.Add('-Cli 指向的文件不存在，未改用本机绑定的其他版本：' + $Cli) }
}

# 2. 本机安装绑定；脚本同目录与 Skill 根都检查，缺失不算错误
if (-not $entry -and -not $Cli) {
  $configCandidates = @(
    (Join-Path $scriptDir 'local.env.json'),
    (Join-Path (Split-Path -Parent $scriptDir) 'local.env.json')
  )
  foreach ($configPath in $configCandidates) {
    if ($entry) { break }
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { continue }
    $config = $null
    try {
      $config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    } catch {
      $notes.Add('local.env.json 无法解析：' + $configPath)
    }
    if ($config -and $config.PSObject.Properties['cli'] -and $config.cli) {
      $configured = [string]$config.cli
      $tried.Add($configPath + ' → ' + $configured)
      if (Test-Path -LiteralPath $configured -PathType Leaf) {
        $entry = (Resolve-Path -LiteralPath $configured).Path
      }
      else { $notes.Add('local.env.json 已配置 cli，但入口不存在：' + $configured) }
    }
  }
}

# 3. 随包或仓库推导；先确认 Skill 标记存在，避免把宿主任意祖先当成工程
if (-not $entry -and -not $Cli) {
  $appRoot = Resolve-Path (Join-Path $scriptDir '../../..') -ErrorAction SilentlyContinue
  $skillMarker = if ($appRoot) { Join-Path $appRoot 'skills/aichat-graph/SKILL.md' }
  if ($appRoot -and (Test-Path -LiteralPath $skillMarker -PathType Leaf)) {
    $distRoot = Split-Path -Parent $appRoot
    $packageManifest = Join-Path $distRoot 'distribution.json'
    $packageNode = Join-Path $distRoot 'runtime\node.exe'
    $packageJs = Join-Path $appRoot 'dist\next\cli.js'
    if ((Test-Path -LiteralPath $packageManifest -PathType Leaf) -and (Test-Path -LiteralPath $packageNode -PathType Leaf) -and (Test-Path -LiteralPath $packageJs -PathType Leaf)) {
      $entry = $packageJs
      $tried.Add($packageNode + ' + ' + $packageJs)
    } else {
      $sourceCandidate = Join-Path $appRoot 'dist/next/cli.js'
      $tried.Add($sourceCandidate)
      if (Test-Path -LiteralPath $sourceCandidate -PathType Leaf) {
        $entry = (Resolve-Path -LiteralPath $sourceCandidate).Path
      }
    }
  }
}

if (-not $entry) {
  [Console]::Error.WriteLine('找不到可用的 aichat CLI 入口。')
  if ($tried.Count -gt 0) {
    [Console]::Error.WriteLine('已尝试：')
    foreach ($item in $tried) { [Console]::Error.WriteLine('  - ' + $item) }
  }
  foreach ($note in $notes) { [Console]::Error.WriteLine('说明：' + $note) }
  if ($Cli) {
    [Console]::Error.WriteLine('修复办法：确认 -Cli 指向实际存在的 aichat.cmd 或 cli.js；本次不会改用本机绑定的其他版本。')
  } else {
    [Console]::Error.WriteLine('修复办法（任选其一）：')
    [Console]::Error.WriteLine('  1. 在 Skill 根（与 scripts 同级）写 local.env.json：{ "cli": "<aichat.cmd 或 cli.js 的绝对路径>" }；')
    [Console]::Error.WriteLine('  2. 本次调用传 -Cli "<入口绝对路径>"；')
    [Console]::Error.WriteLine('  3. 在完整便携包或仓库内运行：包用 aichat.cmd，仓库先 npm run build 生成 dist/next/cli.js。')
  }
  exit 7
}

try {
  $runner = Get-NodeAndEntry $entry
} catch {
  [Console]::Error.WriteLine('CLI 入口无效：' + $_.Exception.Message)
  exit 7
}

& $runner.Node $runner.Entry @CliArgs
exit $LASTEXITCODE
