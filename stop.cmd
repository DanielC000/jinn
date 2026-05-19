@echo off
REM Gracefully stop the Jinn gateway daemon. Looks up the pid from
REM %USERPROFILE%\.jinn and sends SIGTERM.
setlocal
cd /d "%~dp0"
node packages\jimmy\dist\bin\jimmy.js stop
pause
endlocal
