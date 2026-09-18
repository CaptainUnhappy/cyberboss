# weflow-restart.ps1 - restart the WeFlow reader (port 5051) inside the isolated
# session and verify that message queries actually work again.
#
# Must run INSIDE the isolated session: WeFlow reads the WeChat database of the
# cwinprobe account, so it has to live in that session.  Drop this file into
# C:\ProgramData\cwin-probe\s4\in and the session-4 worker picks it up.
#
# Why a restart: WeFlow answers /api/v1/health with 200 while every
# /api/v1/messages query returns HTTP 500, and the reader keeps failing until the
# process is replaced (measured 2026-09-18: messages 500 for ~2 hours, health 200
# the whole time).  A port check alone is therefore not proof of recovery: this
# script asks the messages API with the real token before declaring success.
#
# ASCII only: the session-4 worker runs this with powershell.exe -File and the
# host reads BOM-less files as the ANSI code page.

$ErrorActionPreference = 'Continue'
$root = 'C:\ProgramData\cwin-probe'
$exe = Join-Path $root 'WeFlow\WeFlow.exe'
$envFile = 'D:\Projects\cyberboss\.env'
$port = 5051
$report = Join-Path $root 's4\weflow-restart-report.txt'
Start-Transcript -Path $report -Force | Out-Null

function Test-Listen {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

"=== weflow restart $(Get-Date -Format 'HH:mm:ss') session=$((Get-Process -Id $PID).SessionId) ==="

$before = @(Get-Process WeFlow -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq 4 })
foreach ($process in $before) {
  try { Stop-Process -Id $process.Id -Force -ErrorAction Stop; "killed pid=$($process.Id)" }
  catch { "kill $($process.Id) failed: $($_.Exception.Message)" }
}
Start-Sleep -Seconds 5
"port $port free = $(-not (Test-Listen))"

if (-not (Test-Path $exe)) { "MISSING $exe"; Stop-Transcript | Out-Null; exit 1 }
Start-Process -FilePath $exe | Out-Null
"launched $exe"

for ($i = 1; $i -le 40; $i++) {
  Start-Sleep -Seconds 3
  if (Test-Listen) { break }
}
"port $port listen = $(Test-Listen)"

$envLines = Get-Content $envFile -Encoding utf8
$token = (($envLines | Where-Object { $_ -match '^CYBERBOSS_WEFLOW_TOKEN=' }) -replace '^CYBERBOSS_WEFLOW_TOKEN=', '').Trim()
$inbox = (($envLines | Where-Object { $_ -match '^CYBERBOSS_WEFLOW_INBOX_CHATS=' }) -replace '^CYBERBOSS_WEFLOW_INBOX_CHATS=', '').Trim()
$talker = ($inbox -split ',')[0].Trim()
"token loaded = $([bool]$token)  probe talker = $talker"

$headers = @{ Authorization = "Bearer $token" }
try {
  $health = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 15 -UseBasicParsing
  "health -> $($health.StatusCode) $($health.Content)"
} catch {
  "health -> ERR $($_.Exception.Message)"
}

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$start = $now - 1800
$uri = "http://127.0.0.1:$port/api/v1/messages?talker=$([Uri]::EscapeDataString($talker))&limit=5&start=$start&end=$now"
$messagesOk = $false
for ($i = 1; $i -le 10; $i++) {
  try {
    $response = Invoke-WebRequest -Uri $uri -Headers $headers -TimeoutSec 15 -UseBasicParsing
    "messages -> $($response.StatusCode)"
    $count = @((($response.Content | ConvertFrom-Json).messages)).Count
    "messages in last 30min for $talker = $count"
    $messagesOk = $true
    break
  } catch {
    "messages attempt $i -> ERR $($_.Exception.Message)"
    Start-Sleep -Seconds 6
  }
}
"READER OK = $messagesOk"

Stop-Transcript | Out-Null
