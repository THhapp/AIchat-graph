@echo off
setlocal EnableExtensions
call "%~dp0scripts\launch-entry.cmd" UpdateDaily %*
exit /b %ERRORLEVEL%
