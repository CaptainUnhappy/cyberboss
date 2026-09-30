@echo off
rem e2e-share-pdf.cmd - end-to-end: bring the client front, find a PDF inside a share
rem link, save it to the drive, verify it landed, then report the download step.
rem
rem usage: e2e-share-pdf.cmd [share-url] [.pdf]
setlocal
rem Derive the tool directory from this file instead of a literal checkout path,
rem and take the interpreter from the environment like quarkctl.cmd does.
pushd "%~dp0.."
set OPS=cdp-ops.js
set REV=quarkctl.py
set "PY=%CYBERBOSS_PYTHON%"
if not defined PY if exist "D:\Tools\miniconda3\python.exe" set "PY=D:\Tools\miniconda3\python.exe"
if not defined PY for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY set "PY=%%i"
set URL=%~1
set EXT=%~2
if "%EXT%"=="" set EXT=.pdf

echo === 0) focus the client window before touching anything ===
"%PY%" "%REV%" focus
node %OPS% bring-front
node %OPS% bring-front --page share-link-window

echo === 1) share contents ===
node %OPS% share-info

echo === 2) search the share for %EXT% (needs a focused page) ===
node %OPS% bring-front --page share-link-window >nul
node cdp-search-share.js "%EXT%"

echo === 3) save whatever is selected ===
node %OPS% share-save

echo === 4) verify inside the drive ===
node %OPS% main-open-saveas
node %OPS% main-refresh
node %OPS% main-list --filter "%EXT%"

echo === 5) local download state ===
"%PY%" "%REV%" verify
echo done.
