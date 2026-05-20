@echo off
REM Start the Jinn gateway daemon. Logs stream to this window; Ctrl+C or
REM closing the window stops the daemon. Use stop.cmd from another shell
REM if you want a graceful shutdown.
setlocal
cd /d "%~dp0"
node packages\jimmy\dist\bin\jimmy.js start
endlocal
