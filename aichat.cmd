@echo off
rem Fixed entry for this program distribution: run the built CLI with Node.
rem Works from the repository root and from a daily snapshot; forwards all arguments.
node "%~dp0dist\cli\index.js" %*
exit /b %ERRORLEVEL%
