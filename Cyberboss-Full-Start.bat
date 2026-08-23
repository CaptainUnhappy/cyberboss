@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Cyberboss - Full Start

rem Cyberboss project directory (the directory containing this BAT file).
set "CYBERBOSS_ROOT=%~dp0"
set "CYBERBOSS_ROOT=%CYBERBOSS_ROOT:~0,-1%"

rem Override this path before launching when the UIA bridge is moved:
rem   set CYBERBOSS_WEFLOW_UIA_ROOT=D:\path\to\wechat-weflow-bridge
if not defined CYBERBOSS_WEFLOW_UIA_ROOT set "CYBERBOSS_WEFLOW_UIA_ROOT=D:\Projects\Akasha-WeChat\wechat-weflow-bridge-ob11-public"

set "WEIXIN_EXE=%ProgramFiles%\Tencent\Weixin\Weixin.exe"
set "WEFLOW_EXE=%LOCALAPPDATA%\Programs\WeFlow\WeFlow.exe"
set "UIA_STATUS_URL=http://127.0.0.1:8766/status"

echo ============================================================
echo  Cyberboss full local startup
echo ============================================================
echo  Cyberboss: %CYBERBOSS_ROOT%
echo  UIA Bridge: %CYBERBOSS_WEFLOW_UIA_ROOT%
echo.

if not exist "%CYBERBOSS_ROOT%\package.json" (
  echo [ERROR] Cyberboss package.json not found.
  goto :failed
)
if not exist "%CYBERBOSS_ROOT%\scripts\cyberboss-service.ps1" (
  echo [ERROR] Cyberboss service script not found.
  goto :failed
)
if not exist "%CYBERBOSS_WEFLOW_UIA_ROOT%\main.py" (
  echo [ERROR] WeFlow UIA bridge main.py not found:
  echo         %CYBERBOSS_WEFLOW_UIA_ROOT%\main.py
  goto :failed
)

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe is not available on PATH. Install Node.js 22 or newer.
  goto :failed
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd is not available on PATH.
  goto :failed
)
where python.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python.exe is not available on PATH.
  goto :failed
)

rem 1. Desktop WeChat.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "if (Get-Process -Name 'Weixin' -ErrorAction SilentlyContinue) {exit 0}; exit 1" >nul 2>nul
if errorlevel 1 (
  if exist "%WEIXIN_EXE%" (
    echo [1/5] Starting desktop WeChat ...
    start "WeChat" "%WEIXIN_EXE%"
    timeout /t 3 /nobreak >nul
  ) else (
    echo [WARN] Weixin.exe was not found. Open and sign in to desktop WeChat manually.
  )
) else (
  echo [1/5] Desktop WeChat is already running.
)

rem 2. WeFlow and its local API on port 5031.
call :weflow_ready 1
if errorlevel 1 (
  if exist "%WEFLOW_EXE%" (
    echo [2/5] Starting WeFlow ...
    start "WeFlow" "%WEFLOW_EXE%"
  ) else (
    echo [ERROR] WeFlow.exe was not found:
    echo         %WEFLOW_EXE%
    goto :failed
  )
  call :weflow_ready 30
  if errorlevel 1 (
    echo [ERROR] WeFlow API port 5031 did not become ready.
    echo         Open WeFlow, sign in, and enable its API service.
    goto :failed
  )
) else (
  echo [2/5] WeFlow API is already ready on port 5031.
)

rem 3. Direct UIA bridge on port 8766. Keep its console minimized for logs.
call :uia_ready 3
if errorlevel 1 (
  echo [3/5] Starting WeFlow Direct UIA Bridge ...
  start "WeFlow UIA Bridge" /min /D "%CYBERBOSS_WEFLOW_UIA_ROOT%" cmd.exe /k "title WeFlow UIA Bridge ^& python main.py"
  call :uia_ready 45
  if errorlevel 1 (
    echo [ERROR] UIA Bridge did not become ready on port 8766.
    echo         Review the minimized "WeFlow UIA Bridge" window.
    goto :failed
  )
) else (
  echo [3/5] WeFlow Direct UIA Bridge is already ready.
)

rem 4. Shared Codex app-server and the single Cyberboss process.
call :cyberboss_process_ready
if errorlevel 1 (
  echo [4/5] Starting shared Codex App Server and Cyberboss ...
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CYBERBOSS_ROOT%\scripts\cyberboss-service.ps1" -Mode Start
  if errorlevel 1 goto :failed
) else (
  echo [4/5] Cyberboss is already running; duplicate startup skipped.
)

rem 5. Print final status. The random check-in switch remains controlled by .env;
rem reminder deadlines still use the independent persistent reminder queue.
echo [5/5] Verifying final status ...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$file=Join-Path $HOME '.cyberboss\cyberboss.pid';" ^
  "if (-not (Test-Path -LiteralPath $file)) {throw 'Cyberboss process lock is missing'};" ^
  "$pidValue=[int](Get-Content -LiteralPath $file -Raw).Trim();" ^
  "if (-not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {throw ('Cyberboss PID {0} is not running' -f $pidValue)};" ^
  "$ready=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8765/readyz' -TimeoutSec 3;" ^
  "if ($ready.StatusCode -lt 200 -or $ready.StatusCode -ge 300) {throw 'Shared App Server is not ready'};" ^
  "Write-Host ('  Cyberboss: running PID {0}' -f $pidValue);" ^
  "Write-Host '  Shared App Server: ready on port 8765'"
if errorlevel 1 goto :failed

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=Invoke-RestMethod -Uri '%UIA_STATUS_URL%' -TimeoutSec 3;" ^
  "Write-Host ('  UIA Bridge: running={0}, WeFlow={1}' -f $s.running,$s.weflow_connected);" ^
  "Write-Host ('  Send source: {0} ({1})' -f $s.send_source,$s.send_source_label)"
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo  Startup complete. You may close this window.
echo  Send /bot or /azzy in the configured WeChat control chat
echo  to switch the outbound source.
echo ============================================================
echo.
if not "%CYBERBOSS_NO_PAUSE%"=="1" pause
exit /b 0

:weflow_ready
set "WAIT_SECONDS=%~1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline=(Get-Date).AddSeconds(%WAIT_SECONDS%);" ^
  "do {try {$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5031/api/v1/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) {exit 0}} catch {}; Start-Sleep -Milliseconds 500} while ((Get-Date) -lt $deadline); exit 1" >nul 2>nul
exit /b %ERRORLEVEL%

:uia_ready
set "WAIT_SECONDS=%~1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline=(Get-Date).AddSeconds(%WAIT_SECONDS%);" ^
  "do {try {$s=Invoke-RestMethod -Uri '%UIA_STATUS_URL%' -TimeoutSec 2; if ($s.running -and $s.weflow_connected) {exit 0}} catch {}; Start-Sleep -Milliseconds 500} while ((Get-Date) -lt $deadline); exit 1" >nul 2>nul
exit /b %ERRORLEVEL%

:cyberboss_process_ready
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$file=Join-Path $HOME '.cyberboss\cyberboss.pid'; if (-not (Test-Path -LiteralPath $file)) {exit 1}; $value=(Get-Content -LiteralPath $file -Raw).Trim(); $pidValue=0; if (-not [int]::TryParse($value,[ref]$pidValue)) {exit 1}; if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {exit 0}; exit 1" >nul 2>nul
exit /b %ERRORLEVEL%

:failed
echo.
echo ============================================================
echo  Startup stopped. Review the error above.
echo ============================================================
echo.
if not "%CYBERBOSS_NO_PAUSE%"=="1" pause
exit /b 1
