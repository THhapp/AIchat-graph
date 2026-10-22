#requires -Version 7.0
<#
.SYNOPSIS
  以本项目的 CLI 入口调用 aichat，避免在 Skill 里硬编码绝对路径。

.EXAMPLE
  ./scripts/aichat.ps1 topics --workspace "D:/my-workspace"

.NOTES
  从脚本位置推导工程根：<repo>/skills/aichat-graph/scripts/aichat.ps1 → <repo>/dist/cli/index.js
  找不到构建产物时明确失败，不猜别的入口。
#>
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $CliArgs
)

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Resolve-Path (Join-Path $scriptDir "../../..") -ErrorAction Stop
$entry = Join-Path $repoRoot "dist/cli/index.js"

if (-not (Test-Path -LiteralPath $entry)) {
  [Console]::Error.WriteLine("找不到 CLI 入口: $entry；先在工程根执行 npm run build:node")
  exit 7
}

& node $entry @CliArgs
exit $LASTEXITCODE
