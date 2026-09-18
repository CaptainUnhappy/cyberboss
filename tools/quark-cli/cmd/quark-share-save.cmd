@echo off
rem quark-share-save.cmd - one-shot: open a share link, pick files, save to the drive,
rem then verify the entry landed in "转存的内容".
rem
rem Usage:
rem   quark-share-save.cmd <share-url> [name-filter] [--enter <folder>] [--only]
rem Example:
rem   quark-share-save.cmd "https://pan.quark.cn/s/3a7aac9d4f7c#/list/share" ".pdf" --enter 跨境电商 --only
setlocal enabledelayedexpansion
set EXE=D:\Tools\QuarkCloudDrive\quark_cloud_drive.exe
set OPS=%~dp0..\cdp-ops.js
set URL=%~1
set FILTER=%~2
if "%FILTER%"=="" set FILTER=.pdf

if "%URL%"=="" (
  echo usage: quark-share-save.cmd ^<share-url^> [name-filter] [--enter folder] [--only]
  exit /b 2
)

echo [1/6] closing any running client...
taskkill /im quark_cloud_drive.exe /f >nul 2>&1
timeout /t 3 /nobreak >nul

echo [2/6] launching client with DevTools port and the share url...
start "" "%EXE%" --remote-debugging-port=9222 "%URL%"
timeout /t 22 /nobreak >nul

echo [3/6] share page state
node "%OPS%" share-info
if not "%~3"=="" (
  echo [4/6] entering folder %~3
  node "%OPS%" share-enter --name "%~3"
  timeout /t 3 /nobreak >nul
) else (
  echo [4/6] no folder to enter
)

echo [5/6] selecting %FILTER%
node "%OPS%" share-select --name "%FILTER%" --only

echo [6/6] saving and verifying
node "%OPS%" share-save
timeout /t 3 /nobreak >nul
node "%OPS%" main-open-saveas
node "%OPS%" main-refresh
node "%OPS%" main-list --filter "%FILTER%"
echo done.
