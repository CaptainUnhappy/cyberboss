@echo off
rem quarkctl launcher - always uses a REAL interpreter.
rem The isolated session's `python` is the Microsoft Store stub, so the
rem interpreter is pinned by configuration rather than by a literal path:
rem CYBERBOSS_PYTHON wins, then the historical miniconda install, then PATH.
setlocal
set "PY=%CYBERBOSS_PYTHON%"
if not defined PY if exist "D:\Tools\miniconda3\python.exe" set "PY=D:\Tools\miniconda3\python.exe"
if not defined PY for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY set "PY=%%i"
if not defined PY (
  echo quarkctl: no real interpreter found; set CYBERBOSS_PYTHON to python.exe
  exit /b 2
)
if not exist "%PY%" (
  echo quarkctl: interpreter not found at %PY%
  exit /b 2
)
"%PY%" "%~dp0..\quarkctl.py" %*
exit /b %ERRORLEVEL%
