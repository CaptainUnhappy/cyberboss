# teardown-isolated-stack.ps1 - stop the session-3 stack (cutover to Cua).
#
# Run INSIDE the isolated session, by queueing it:
#   Copy-Item <this file> C:\ProgramData\cwin-probe\s4\in\
# The file-queue worker picks it up, moves it to done\ and runs it as cwinprobe,
# which is the only context allowed to kill session-3 processes.
#
# Why not from session 1: the bot account cannot terminate another account's
# processes ("Access is denied"), and the queue worker restarts anything that
# disappears while it is alive. So this script stops the consumers first, then
# the worker last - otherwise the worker outlives the teardown and rebuilds it.
#
# It is idempotent and reports every step to <queue>\s4\teardown-report.txt.

$ErrorActionPreference = 'Continue'
# Machine bindings from the environment / this script's own location, like every
# other recipe here (a literal root silently writes the report to the wrong box).
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$report = Join-Path $root 's4\teardown-report.txt'
$log = New-Object System.Collections.Generic.List[string]
function L($m) { [void]$log.Add(("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m)); $log | Set-Content -LiteralPath $report -Encoding utf8 }

L ("teardown start session=" + (Get-Process -Id $PID).SessionId + " user=" + [Environment]::UserName)

function Stop-ByName([string]$name, [string]$label) {
  $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId })
  if (-not $procs.Count) { L ("  $label : none running"); return }
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; L ("  $label : killed pid=" + $p.Id) }
    catch { L ("  $label : kill " + $p.Id + " failed: " + $_.Exception.Message) }
  }
}

# 1) the writer bridge (python serving 8776)
Stop-ByName 'python' 'uia-bridge'
# 2) the reader (WeFlow serves 5051)
Stop-ByName 'WeFlow' 'weflow-reader'
# 3) the WeChat client of this account (graceful close first, then force)
$wx = @(Get-Process -Name 'Weixin' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId })
foreach ($p in $wx) {
  try { $null = $p.CloseMainWindow(); L ("  weixin : asked pid=" + $p.Id + " to close") } catch { }
}
Start-Sleep -Seconds 6
Stop-ByName 'Weixin' 'weixin'
Stop-ByName 'WeChatAppEx' 'weixin-appex'
Start-Sleep -Seconds 2

# 4) the queue worker LAST: while it lives, it restarts what we just stopped.
$self = $PID
$ps = @(Get-Process -Name 'powershell' -ErrorAction SilentlyContinue |
  Where-Object { $_.SessionId -eq (Get-Process -Id $self).SessionId -and $_.Id -ne $self })
foreach ($p in $ps) {
  try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; L ("  worker : killed powershell pid=" + $p.Id) }
  catch { L ("  worker : kill " + $p.Id + " failed: " + $_.Exception.Message) }
}

Start-Sleep -Seconds 3
L '--- remaining in this session ---'
foreach ($n in @('Weixin', 'WeFlow', 'python', 'powershell')) {
  $left = @(Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId })
  L ("  {0,-11} = {1}" -f $n, $left.Count)
}
foreach ($port in 5051, 8776) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  L ("  port {0} = {1}" -f $port, $(if ($c) { 'LISTEN pid=' + $c.OwningProcess } else { 'free' }))
}
L 'teardown done'
