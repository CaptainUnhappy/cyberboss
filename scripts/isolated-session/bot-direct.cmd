@echo off
rem bot-direct.cmd - start the bot WITHOUT the shared launcher.
rem
rem Why this exists: `shared-start.js` refuses to start the bot when it cannot
rem verify the WeFlow UIA bridge (it reads the bridge pid file and, from another
rem Windows account, cannot read that process's command line). When the bridge
rem already runs inside the isolated session, this is the supported bypass: the
rem scheduled task `cwin-s1-bot` runs this file directly.
rem
rem Machine bindings come from the environment with fallbacks, so this file
rem survives a moved checkout (it used to hardcode one machine's checkout path).

setlocal
if not defined CYBERBOSS_REPO_ROOT set "CYBERBOSS_REPO_ROOT=%~dp0..\.."
if not defined CYBERBOSS_QUEUE_ROOT set "CYBERBOSS_QUEUE_ROOT=C:\ProgramData\cwin-probe"

set "LOGDIR=%CYBERBOSS_QUEUE_ROOT%\stack"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1

cd /d "%CYBERBOSS_REPO_ROOT%" || exit /b 1
node bin\cyberboss.js start --checkin >> "%LOGDIR%\bot-direct.out.log" 2>> "%LOGDIR%\bot-direct.err.log"
