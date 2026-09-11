@echo off
rem Compatibility entry point: Start now owns readiness for the full local stack.
call "%~dp0scripts\cyberboss-service-launcher.cmd" Start
exit /b %ERRORLEVEL%
