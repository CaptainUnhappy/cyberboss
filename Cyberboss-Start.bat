@echo off
setlocal
title Cyberboss - Start
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cyberboss-service.ps1" -Mode Start
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" echo Cyberboss start failed. Review the log path shown above.
pause
exit /b %EXIT_CODE%
