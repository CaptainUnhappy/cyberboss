# Hardened session file-queue worker (v2).
#
# The previous worker stalled: it Start-Process'd each script and blocked on
# WaitForExit(300000), so one wedged script stopped the whole queue (observed three
# times on 2026-09-24, leaving bridge/WeFlow restarts unexecuted). This one:
#   * holds a single-instance lock file, so two workers can never run concurrently;
#   * gives every script a hard timeout and kills it, then moves on;
#   * never lets one failure stop the loop;
#   * rewrites the heartbeat every iteration so liveness is visible from outside.
$ErrorActionPreference = 'Continue'
# s4-worker.ps1 - the file-queue worker that runs the isolated-session recipes.
#
# This is the queue half of the deployment: guards and operators drop a .ps1 into
# <queue-root>\s4\in, this worker moves it to done\ and executes it with a hard
# timeout. Without a live worker, nothing the guards queue is ever executed --
# which is exactly how a bridge/WeFlow restart silently never happens.
#
# It is started by session-bootstrap.ps1 at logon inside the isolated session.
# ASCII only: PowerShell 5.1 reads BOM-less files as the ANSI code page.
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$in = Join-Path $workerRoot 'in'; $out = Join-Path $workerRoot 'out'; $done = Join-Path $workerRoot 'done'
foreach ($d in @($in, $out, $done)) { if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }
$lock = Join-Path $workerRoot 'worker.lock'
$hb = Join-Path $workerRoot 'heartbeat.txt'
$status = Join-Path $workerRoot 'worker-status.txt'

# single instance: an existing live pid wins
if (Test-Path -LiteralPath $lock) {
  $old = (Get-Content -LiteralPath $lock -Raw -ErrorAction SilentlyContinue).Trim()
  if ($old -match '^\d+$' -and (Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue)) {
    exit 0
  }
}
Set-Content -LiteralPath $lock -Value "$PID" -Encoding ascii
"worker2 pid=$PID session=$((Get-Process -Id $PID).SessionId) started=$(Get-Date -Format o)" | Out-File -LiteralPath $status -Encoding utf8

$timeoutSeconds = 240
while ($true) {
  "alive $(Get-Date -Format 'MM-dd HH:mm:ss')" | Out-File -LiteralPath $hb -Encoding utf8
  $files = @(Get-ChildItem -LiteralPath $in -Filter '*.ps1' -ErrorAction SilentlyContinue | Sort-Object Name)
  foreach ($f in $files) {
    $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    $log = Join-Path $out "$name.log"
    try { Move-Item -LiteralPath $f.FullName -Destination (Join-Path $done $f.Name) -Force -ErrorAction Stop } catch { continue }
    "=== $name start $(Get-Date -Format 'HH:mm:ss') ===" | Out-File -LiteralPath $log -Encoding utf8
    try {
      $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $done $f.Name)) -WindowStyle Hidden -PassThru
      if (-not $p.WaitForExit($timeoutSeconds * 1000)) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
        "TIMEOUT ${timeoutSeconds}s -> killed pid=$($p.Id)" | Out-File -LiteralPath $log -Append -Encoding utf8
      } else {
        "exit=$($p.ExitCode)" | Out-File -LiteralPath $log -Append -Encoding utf8
      }
    } catch {
      "launch failed: $($_.Exception.Message)" | Out-File -LiteralPath $log -Append -Encoding utf8
    }
    "=== $name end $(Get-Date -Format 'HH:mm:ss') ===" | Out-File -LiteralPath $log -Append -Encoding utf8
  }
  Start-Sleep -Milliseconds 800
}