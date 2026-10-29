@echo off
rem Portable program CLI entry: use the packaged Node runtime, not the system PATH.
setlocal EnableExtensions
set "ROOT=%~dp0"
if not exist "%ROOT%runtime\node.exe" (
  echo [AIchat-graph] Missing runtime\node.exe in this program package.
  echo Please extract the complete downloaded ZIP again.
  exit /b 1
)
if not exist "%ROOT%app\dist\next\cli.js" (
  echo [AIchat-graph] Missing app\dist\next\cli.js in this program package.
  echo Please extract the complete downloaded ZIP again.
  exit /b 1
)
"%ROOT%runtime\node.exe" "%ROOT%app\dist\next\cli.js" %*
exit /b %ERRORLEVEL%
