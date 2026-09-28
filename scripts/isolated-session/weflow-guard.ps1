# weflow-guard.ps1 - restart the WeFlow reader when its message API breaks.
#
# Why: WeFlow's /api/v1/health keeps answering 200 while /api/v1/messages returns
# HTTP 500, and in that state the bot reads nothing at all, so replies stop with no
# visible fault (measured three times between 2026-09-18 and 2026-09-23). The
# service controller deliberately preserves a degraded WeFlow process, and the
# watchdog's repair paths cannot reach a session-4 program, so nothing recovered it
# until a human noticed. This guard is the missing deterministic step: it asks the
# messages API, and on failure drops the repository's restart recipe into the
# isolated session's queue, where the session-4 worker runs it.
#
# ASCII only on purpose: PowerShell 5.1 reads BOM-less files as the ANSI code page,
# and a non-ASCII character in a .ps1 silently breaks the whole script's parse.

$ErrorActionPreference = 'Continue'
$root = 'C:\ProgramData\cwin-probe'
$queueIn = Join-Path $root 's4\in'
$recipe = 'D:\Projects\cyberboss\scripts\isolated-session\weflow-restart.ps1'
$queuedName = 'weflow-restart.ps1'
$envFile = 'D:\Projects\cyberboss\.env'
$logDir = Join-Path $root 'repair'
$logFile = Join-Path $logDir 'weflow-guard.log'
$port = 5051

New-Item -ItemType Directory -Force -Path $logDir, $queueIn | Out-Null

function Write-GuardLog([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
  Write-Output $line
}

$envLines = Get-Content -LiteralPath $envFile -Encoding utf8
function Get-EnvValue([string]$name) {
  return (($envLines | Where-Object { $_ -match "^$name=" }) -replace "^$name=", '').Trim()
}

$token = Get-EnvValue 'CYBERBOSS_WEFLOW_TOKEN'
$inbox = Get-EnvValue 'CYBERBOSS_WEFLOW_INBOX_CHATS'
$talker = ($inbox -split ',')[0].Trim()
if (-not $token -or -not $talker) {
  Write-GuardLog 'configuration missing (token or inbox chat); nothing checked'
  exit 65
}

# --- bot liveness -----------------------------------------------------------
# The WeFlow reader can be perfectly healthy while nothing is reading it: on
# 2026-09-28 the bot process died at 12:44 and stayed dead for 27 minutes,
# because cwin-s1-bot only fires on logon (plus manual runs) and the heartbeat
# watchdog's repair budget was in cooldown. Nothing else watched the bot itself.
# Start it again if it is gone; never touch a live one.
$botPattern = 'bin\\cyberboss\.js\s+start'
$botAlive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match $botPattern -and $_.CommandLine -notmatch 'runner\.js' })
if ($botAlive.Count -gt 0) {
  Write-GuardLog ("bot healthy (pid " + ($botAlive.ProcessId -join ',') + ")")
} else {
  # Start through the scheduler's own COM API: schtasks.exe is a console program
  # and this host hands console creation to Windows Terminal, so the user would
  # see a terminal flash (same reason rdp-keepalive.py avoids schtasks.exe).
  $started = $false
  $detail = ''
  try {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    $service.GetFolder('\').GetTask('cwin-s1-bot').Run($null)
    $started = $true
  } catch {
    $detail = $_.Exception.Message
  }
  if ($started) {
    Write-GuardLog "bot missing -> triggered cwin-s1-bot"
  } else {
    Write-GuardLog "bot missing and cwin-s1-bot could not be triggered: $detail"
  }
}
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$uri = "http://127.0.0.1:$port/api/v1/messages?talker=$([Uri]::EscapeDataString($talker))&limit=1&start=$($now - 600)&end=$now"

$status = 0
$detail = ''
try {
  $response = Invoke-WebRequest -Uri $uri -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 15 -UseBasicParsing
  $status = [int]$response.StatusCode
} catch {
  $detail = $_.Exception.Message
  try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = 0 }
}

if ($status -ge 200 -and $status -lt 300) {
  Write-GuardLog "reader healthy (HTTP $status)"
  exit 0
}

$queued = Join-Path $queueIn $queuedName
if (Test-Path -LiteralPath $queued) {
  Write-GuardLog "reader unhealthy (HTTP $status $detail) but a restart is already queued"
  exit 1
}

if (-not (Test-Path -LiteralPath $recipe)) {
  Write-GuardLog "reader unhealthy (HTTP $status $detail) and the recipe is missing: $recipe"
  exit 66
}

Copy-Item -LiteralPath $recipe -Destination $queued -Force
Write-GuardLog "reader unhealthy (HTTP $status $detail) -> queued $queuedName for the session-4 worker"
exit 1
