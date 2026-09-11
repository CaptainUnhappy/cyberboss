@echo off
setlocal EnableExtensions

set "CYBERBOSS_SERVICE_MODE=%~1"
set "CYBERBOSS_SERVICE_MODE_VALID="
for %%M in (Start Restart FullRestart Stop Status) do (
  if /I "%CYBERBOSS_SERVICE_MODE%"=="%%M" set "CYBERBOSS_SERVICE_MODE_VALID=1"
)

if not defined CYBERBOSS_SERVICE_MODE_VALID (
  >&2 echo Invalid Cyberboss service mode: %CYBERBOSS_SERVICE_MODE%
  exit /b 64
)

set "CYBERBOSS_SERVICE_SCRIPT=%~dp0cyberboss-service.ps1"
if not exist "%CYBERBOSS_SERVICE_SCRIPT%" (
  >&2 echo Cyberboss service script is missing: %CYBERBOSS_SERVICE_SCRIPT%
  exit /b 2
)

title Cyberboss - %CYBERBOSS_SERVICE_MODE%
cd /d "%~dp0.."
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%CYBERBOSS_SERVICE_SCRIPT%" -Mode "%CYBERBOSS_SERVICE_MODE%"
set "CYBERBOSS_SERVICE_EXIT_CODE=%ERRORLEVEL%"

if not "%CYBERBOSS_SERVICE_EXIT_CODE%"=="0" (
  echo.
  >&2 echo Cyberboss %CYBERBOSS_SERVICE_MODE% failed. Review the service output and logs above.
)
if not "%CYBERBOSS_NO_PAUSE%"=="1" (
  echo.
  pause
)
exit /b %CYBERBOSS_SERVICE_EXIT_CODE%
