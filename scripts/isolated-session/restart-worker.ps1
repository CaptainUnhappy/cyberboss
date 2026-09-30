$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$log = Join-Path $root 'channel-worker-restart.txt'
Remove-Item $log -ErrorAction SilentlyContinue
$o = New-Object System.Collections.Generic.List[string]
function A($m) { [void]$o.Add([string]$m) }
try { Stop-ScheduledTask -TaskName 'cwin-s1-session-bootstrap' -ErrorAction Stop; A 'bootstrap task stopped' } catch { A "stop: $($_.Exception.Message)" }
Start-Sleep -Seconds 2
# Kill the other powershell processes in THIS session only. The session id is
# read at runtime: it was 4 when this recipe was written and became 3 after a
# reconnect, which is exactly how a hardcoded filter silently kills nothing.
$selfSession = (Get-Process -Id $PID).SessionId
foreach ($p in (Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $selfSession -and $_.Id -ne $PID })) {
  try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; A "killed same-session powershell pid=$($p.Id)" } catch { A "kill $($p.Id) failed" }
}
Start-Sleep -Seconds 2
try { Start-ScheduledTask -TaskName 'cwin-s1-session-bootstrap' -ErrorAction Stop; A 'bootstrap task restarted' } catch { A "restart failed: $($_.Exception.Message)" }
$dl = (Get-Date).AddSeconds(25)
$hbFile = Join-Path $root 's4\heartbeat.txt'
while ((Get-Date) -lt $dl -and -not (Test-Path $hbFile)) { Start-Sleep -Seconds 2 }
A ('heartbeat: ' + (Get-Content $hbFile -Raw -Encoding utf8 -ErrorAction SilentlyContinue))
A ('worker-status: ' + (Get-Content (Join-Path $root 's4\worker-status.txt') -Raw -Encoding utf8 -ErrorAction SilentlyContinue))
$o -join "`r`n" | Out-File $log -Encoding utf8
