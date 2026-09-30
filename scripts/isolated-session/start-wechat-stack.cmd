@echo off
rem start-wechat-stack.cmd - convenience launcher for the isolated-session stack.
rem
rem The real work lives in s4-start-stack.ps1 (which derives every machine path
rem from the environment). This wrapper only exists so a human can double-click
rem or queue a single .cmd; it deliberately does not hardcode the probe root.

setlocal
if not defined CYBERBOSS_REPO_ROOT set "CYBERBOSS_REPO_ROOT=%~dp0..\.."
if not defined CYBERBOSS_QUEUE_ROOT set "CYBERBOSS_QUEUE_ROOT=C:\ProgramData\cwin-probe"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CYBERBOSS_REPO_ROOT%\scripts\isolated-session\s4-start-stack.ps1"
