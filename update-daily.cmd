@echo off
rem Build, package and replace the fixed daily program in .local\daily.
rem The daily .aichat settings and all external workspaces are preserved.
setlocal EnableExtensions
set "ROOT=%~dp0"
pushd "%ROOT%"

echo [AIchat-graph] Checking the daily program is not running...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'SilentlyContinue'; $target = Join-Path (Get-Location).Path '.local\daily'; if (-not (Test-Path -LiteralPath $target -PathType Container)) { exit 0 }; $needle = [IO.Path]::GetFullPath($target).TrimEnd('\\'); $self = $PID; $found = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and (($_.ExecutablePath -and $_.ExecutablePath.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0)) }); if ($found.Count -gt 0) { $found | ForEach-Object { Write-Output ('  in use: ' + $_.Name + ' pid ' + $_.ProcessId) }; exit 3 }; exit 0"
if errorlevel 3 (
  echo [AIchat-graph] The daily program is running. Exit its discussion service first.
  echo update-daily.cmd will not stop it.
  popd
  pause
  exit /b 1
)

echo [AIchat-graph] 1/3 npm run build
call npm run build
if errorlevel 1 goto fail

echo [AIchat-graph] 2/3 npm run package:windows
call npm run package:windows
if errorlevel 1 goto fail

set "PACKAGE="
for /d %%D in ("%ROOT%.local\packages\AIchat-graph-*-win-x64") do set "PACKAGE=%%~fD"
if not defined PACKAGE (
  echo [AIchat-graph] No packaged distribution found under .local\packages.
  goto fail
)

echo [AIchat-graph] 3/3 replace .local\daily (keep .aichat)
node "%ROOT%dist\portable\update.js" --source "%PACKAGE%" --target "%ROOT%.local\daily" --allow-legacy --create-target --yes
if errorlevel 1 goto fail

echo [AIchat-graph] Daily program updated. Start it with start.cmd.
popd
exit /b 0

:fail
echo [AIchat-graph] update-daily failed. See the messages above.
popd
pause
exit /b 1
