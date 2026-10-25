@echo off
rem Shared argument forwarding for Daily, Development and UpdateDaily.
setlocal EnableExtensions
set "LAUNCH_PS1=%~dp0launch.ps1"
set "LAUNCH_MODE=%~1"
shift
set "LAUNCH_WORKSPACE="
set "LAUNCH_PORT="
set "LAUNCH_NOBROWSER="
set "LAUNCH_HELP="
set "AICHAT_LAUNCH_WORKSPACE="

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="-NoBrowser" goto opt_nobrowser
if /I "%~1"=="-Workspace" goto opt_workspace
if /I "%~1"=="-Port" goto opt_port
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

:opt_port
shift
if "%~1"=="" goto missing_port
set "LAUNCH_PORT=%~1"
shift
goto parse_args

:opt_help
set "LAUNCH_HELP=1"
shift
goto parse_args

:args_done
set "PAUSE_ON_FAIL=1"
if defined LAUNCH_NOBROWSER set "PAUSE_ON_FAIL="
if not exist "%LAUNCH_PS1%" goto missing_script
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" set "PS_EXE=pwsh.exe"
set "PS_ARGS=-Mode %LAUNCH_MODE%"
if defined LAUNCH_HELP set "PS_ARGS=%PS_ARGS% -Help"
if defined LAUNCH_NOBROWSER set "PS_ARGS=%PS_ARGS% -NoBrowser"
rem Workspace and port travel in the environment to preserve quoting.
set "AICHAT_LAUNCH_WORKSPACE=%LAUNCH_WORKSPACE%"
set "AICHAT_LAUNCH_PORT=%LAUNCH_PORT%"
"%PS_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCH_PS1%" %PS_ARGS%
set "LAUNCH_EXIT=%ERRORLEVEL%"
goto after_run

:missing_script
echo [AIchat-graph] Missing scripts\launch.ps1 next to the shared entry.
goto argument_error
:missing_workspace
echo [AIchat-graph] -Workspace needs a directory.
goto argument_error
:missing_port
echo [AIchat-graph] -Port needs an integer from 1024 to 65535.
goto argument_error
:unknown_arg
echo [AIchat-graph] Unknown argument: %~1
:argument_error
echo Usage: start.cmd / start-dev.cmd / update-daily.cmd (run with -Help for options)
set "LAUNCH_EXIT=1"
set "PAUSE_ON_FAIL=1"
:after_run
if not "%LAUNCH_EXIT%"=="0" if defined PAUSE_ON_FAIL pause
exit /b %LAUNCH_EXIT%
