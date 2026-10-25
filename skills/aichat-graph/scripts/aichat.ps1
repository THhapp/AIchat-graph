#requires -Version 7.0
<#
.SYNOPSIS
  用固定版本的 CLI 调用 aichat；仓库内、日用快照内和已安装副本共用这一份脚本。

.DESCRIPTION
  解析顺序（前者优先，命中即停）：
    1. -Cli <绝对路径>：本次调用显式指定；
    2. local.env.json 的 cli：本机安装绑定，按“脚本同目录 → Skill 根”查找；
    3. 仓库内推导：<repo>/skills/aichat-graph/scripts → <repo>/dist/cli/index.js。
  都不成立时明确失败并列出尝试过的路径；不猜正式库、不自动切换运行版本、不修改任何配置。
  显式传了 -Cli 但文件不存在时直接失败，不会悄悄改用本机绑定的其他版本。
  local.env.json 缺失或损坏不影响后续查找，只在失败信息里说明。

.PARAMETER Cli
  本次使用的 CLI 入口（绝对路径）。只在本次调用生效，不改本机配置。

.EXAMPLE
  ./scripts/aichat.ps1 topics --workspace "D:/my-workspace"

.EXAMPLE
  $runCli = 'D:/repo/.local/daily/dist/cli/index.js'
  ./scripts/aichat.ps1 -Cli $runCli topics --workspace 'D:/my-workspace'
#>
[CmdletBinding()]
param(
  [Parameter()][string] $Cli,
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]] $CliArgs
)

$scriptDir = Split-Path -Parent $PSCommandPath
$tried = [System.Collections.Generic.List[string]]::new()
$notes = [System.Collections.Generic.List[string]]::new()
$entry = $null

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

# 3. 仓库内相对推导；先确认上一级确实是本仓库，避免把宿主任意祖先目录当成工程根
if (-not $entry -and -not $Cli) {
  $repoRoot = Resolve-Path (Join-Path $scriptDir '../../..') -ErrorAction SilentlyContinue
  $skillMarker = if ($repoRoot) { Join-Path $repoRoot 'skills/aichat-graph/SKILL.md' }
  if ($repoRoot -and (Test-Path -LiteralPath $skillMarker -PathType Leaf)) {
    $candidate = Join-Path $repoRoot 'dist/cli/index.js'
    $tried.Add($candidate)
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $entry = (Resolve-Path -LiteralPath $candidate).Path
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
    [Console]::Error.WriteLine('修复办法：确认 -Cli 指向实际存在的 dist/cli/index.js；本次不会改用本机绑定的其他版本。')
  } else {
    [Console]::Error.WriteLine('修复办法（任选其一）：')
    [Console]::Error.WriteLine(
      '  1. 在 Skill 根（与 scripts 同级）写 local.env.json：' +
      '{ "cli": "<CLI 绝对路径>" }，例如已安装副本指向 .local/daily/dist/cli/index.js；'
    )
    [Console]::Error.WriteLine('  2. 本次调用传 -Cli "<CLI 绝对路径>"；')
    [Console]::Error.WriteLine('  3. 仓库内先在工程根执行 npm run build:node 生成 dist/cli/index.js。')
  }
  exit 7
}

& node $entry @CliArgs
exit $LASTEXITCODE
