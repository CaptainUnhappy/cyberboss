# bridge-restart.ps1 - relaunch the isolated session's UIA bridge (port 8776).
#
# Must run INSIDE the isolated session: the bridge drives that session's desktop,
# so starting it from session 1 would put it on the wrong desktop.  The usual way
# is to drop this file into C:\ProgramData\cwin-probe\s4\in and let the session-4
# worker pick it up.
#
# The worker inherits no project environment, and the bridge refuses to start
# without CYBERBOSS_WEFLOW_TOKEN, so the values are read from .env here.  Skipping
# that step once took the send path down for two minutes (the new process exited
# with "CYBERBOSS_WEFLOW_TOKEN is required" while the old one was already dead).
#
# ASCII only: the session-4 worker runs this with powershell.exe -File and the
# host reads BOM-less files as the ANSI code page.

$ErrorActionPreference = 'Continue'
# Machine bindings: dot-source the shared header instead of hardcoding the
# checkout path, and take the interpreter from the environment.
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$log = Join-Path $root 'bridge4.log'
$err = Join-Path $root 'bridge4.err.log'
$bridge = Join-Path $repoRoot 'scripts\weflow-uia-bridge.py'
$python = if ($env:CYBERBOSS_PYTHON) { $env:CYBERBOSS_PYTHON } else { 'python' }
$port = 8776

# The session-4 worker captures only start/exit of a queued script, so keep the
# verdict where a later diagnosis can read it.
$report = Join-Path $root 's4\bridge-restart-report.txt'
Start-Transcript -Path $report -Force | Out-Null

function Test-Listen {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

$old = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'weflow-uia-bridge' -and $_.CommandLine -match "$port" })
foreach ($process in $old) {
  try { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop; "killed pid=$($process.ProcessId)" }
  catch { "kill $($process.ProcessId) failed: $($_.Exception.Message)" }
}
Start-Sleep -Seconds 6
"port $port free = $(-not (Test-Listen))"

$envLines = Get-Content $envFile -Encoding utf8
function Get-EnvValue([string]$name) {
  return (($envLines | Where-Object { $_ -match "^$name=" }) -replace "^$name=", '').Trim()
}
$env:CYBERBOSS_WEFLOW_TOKEN = Get-EnvValue 'CYBERBOSS_WEFLOW_TOKEN'
$env:CYBERBOSS_WEFLOW_BASE_URL = 'http://127.0.0.1:5051'
$env:CYBERBOSS_WEFLOW_ALLOWED_TALKERS = Get-EnvValue 'CYBERBOSS_WEFLOW_ALLOWED_TALKERS'
$env:CYBERBOSS_WEFLOW_DEFAULT_SEND_SOURCE = 'azzy'
$env:CYBERBOSS_WEFLOW_SEND_VERIFY_SECONDS = Get-EnvValue 'CYBERBOSS_WEFLOW_SEND_VERIFY_SECONDS'
$env:CYBERBOSS_STATE_DIR = if ($env:CYBERBOSS_STATE_DIR) { $env:CYBERBOSS_STATE_DIR } else { Join-Path $root 'state4' }
"token loaded = $([bool]$env:CYBERBOSS_WEFLOW_TOKEN)  allowedTalkers = $([bool]$env:CYBERBOSS_WEFLOW_ALLOWED_TALKERS)"

Remove-Item $log, $err -Force -ErrorAction SilentlyContinue
$launcher = Start-Process -FilePath $python `
  -ArgumentList @($bridge, '--host', '127.0.0.1', '--port', "$port") `
  -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
"launcher pid=$($launcher.Id)"

for ($i = 1; $i -le 25; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Listen) { break }
}
"port $port listen = $(Test-Listen)"

foreach ($uri in @(
    "http://127.0.0.1:$port/healthz",
    "http://127.0.0.1:$port/readyz",
    "http://127.0.0.1:$port/api/send-source",
    "http://127.0.0.1:$port/api/probe")) {
  try {
    $response = Invoke-WebRequest -Uri $uri -TimeoutSec 10 -UseBasicParsing
    "$uri -> $($response.StatusCode) $($response.Content)"
  } catch {
    "$uri -> ERR $($_.Exception.Message)"
  }
}

if (Test-Path $err) {
  $tail = Get-Content $err -Tail 6 -ErrorAction SilentlyContinue
  if ($tail) { '--- stderr ---'; $tail | ForEach-Object { "  $_" } }
}

Stop-Transcript | Out-Null
