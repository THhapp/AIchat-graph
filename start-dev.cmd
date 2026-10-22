@echo off
setlocal EnableExtensions
call "%~dp0scripts\launch-entry.cmd" Development %*
exit /b %ERRORLEVEL%
