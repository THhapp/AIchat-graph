@echo off
setlocal EnableExtensions
call "%~dp0scripts\launch-entry.cmd" Daily %*
exit /b %ERRORLEVEL%
