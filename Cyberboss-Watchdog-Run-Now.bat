@echo off
setlocal
title Cyberboss - Watchdog Check Now
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cyberboss-watchdog.ps1" -Mode Once
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Watchdog check reported an error. Review %USERPROFILE%\.cyberboss\cyberboss-watchdog.log
pause
exit /b %EXIT_CODE%
