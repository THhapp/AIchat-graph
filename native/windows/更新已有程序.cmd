@echo off
rem Replace another unpacked AIchat-graph package with this new package.
rem The native launcher shows the folder picker, confirmation and result dialogs.
setlocal EnableExtensions
if not exist "%~dp0AIchat-graph.exe" (
  echo [AIchat-graph] Missing AIchat-graph.exe next to this file.
  echo Please extract the complete downloaded ZIP again.
  pause
  exit /b 1
)
"%~dp0AIchat-graph.exe" --update
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" if not "%CODE%"=="2" pause
exit /b %CODE%
