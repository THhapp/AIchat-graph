@echo off
rem Daily entry: run the fixed portable program under .local\daily.
setlocal EnableExtensions
set "DAILY_EXE=%~dp0.local\daily\AIchat-graph.exe"
if not exist "%DAILY_EXE%" (
  echo [AIchat-graph] Daily program is not prepared:
  echo   "%DAILY_EXE%"
  echo Run update-daily.cmd once in this folder to build and install it.
  pause
  exit /b 1
)
start "" /wait "%DAILY_EXE%" %*
exit /b %ERRORLEVEL%
