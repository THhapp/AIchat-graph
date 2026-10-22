@echo off
rem AIchat-graph launcher entry (double-click friendly).
rem Runs scripts\launch.ps1 with Windows PowerShell 5.1; falls back to pwsh on PATH.
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "LAUNCH_PS1=%SCRIPT_DIR%scripts\launch.ps1"

if not exist "%LAUNCH_PS1%" goto missing_script

rem Accepted arguments: [-Workspace <dir>] [-NoBrowser] [-Help]
rem The workspace is parsed with %~1 and handed over in the environment: a path
rem such as "D:\notes\" would otherwise end in \" and swallow the closing quote.
set "LAUNCH_WORKSPACE="
set "LAUNCH_NOBROWSER="
set "LAUNCH_HELP="
set "AICHAT_LAUNCH_WORKSPACE="

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="-NoBrowser" goto opt_nobrowser
if /I "%~1"=="-Workspace" goto opt_workspace
if /I "%~1"=="-Help" goto opt_help
goto unknown_arg

:opt_nobrowser
set "LAUNCH_NOBROWSER=1"
shift
goto parse_args

:opt_workspace
shift
if "%~1"=="" goto missing_workspace
set "LAUNCH_WORKSPACE=%~1"
shift
goto parse_args

:opt_help
set "LAUNCH_HELP=1"
shift
goto parse_args

:args_done
rem Interactive failures wait for a key; -NoBrowser runs never block.
set "PAUSE_ON_FAIL=1"
if defined LAUNCH_NOBROWSER set "PAUSE_ON_FAIL="

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=powershell.exe"

set "PS_ARGS="
if defined LAUNCH_HELP set "PS_ARGS=%PS_ARGS% -Help"
if defined LAUNCH_NOBROWSER set "PS_ARGS=%PS_ARGS% -NoBrowser"
set "AICHAT_LAUNCH_WORKSPACE=%LAUNCH_WORKSPACE%"

"%PS_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCH_PS1%" %PS_ARGS%
set "LAUNCH_EXIT=%ERRORLEVEL%"
goto after_run

:missing_script
echo [AIchat-graph] Missing launcher script: %LAUNCH_PS1%
echo Keep start.cmd next to the scripts folder in the project root.
set "LAUNCH_EXIT=1"
set "PAUSE_ON_FAIL=1"
goto after_run

:missing_workspace
echo [AIchat-graph] -Workspace needs a directory, for example:
echo   start.cmd -Workspace "D:\my notes\aichat"
set "LAUNCH_EXIT=1"
set "PAUSE_ON_FAIL=1"
goto after_run

:unknown_arg
echo [AIchat-graph] Unknown argument: %~1
echo Usage: start.cmd [-Workspace ^<dir^>] [-NoBrowser] [-Help]
set "LAUNCH_EXIT=1"
set "PAUSE_ON_FAIL=1"
goto after_run

:after_run
if not "%LAUNCH_EXIT%"=="0" if defined PAUSE_ON_FAIL pause
exit /b %LAUNCH_EXIT%
