@echo off
rem quarkctl launcher - always uses the real interpreter.
rem The isolated session's `python` is the Microsoft Store stub, so the
rem interpreter path is pinned here.
setlocal
set PY=D:\Tools\miniconda3\python.exe
if not exist "%PY%" (
  echo quarkctl: interpreter not found at %PY%
  exit /b 2
)
"%PY%" "%~dp0..\quarkctl.py" %*
exit /b %ERRORLEVEL%
