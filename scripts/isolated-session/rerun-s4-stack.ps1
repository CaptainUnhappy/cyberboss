# rerun-s4-stack.ps1 - re-run the session bootstrap task on demand.
#
# Why COM instead of `schtasks.exe`: this machine hands console creation to
# Windows Terminal, so every `schtasks` call flashes a terminal window on the
# USER's desktop (deployment contract, hard constraint 2). Schedule.Service COM
# starts the task without spawning a console process.
#
# The old version of this file shelled out to schtasks.exe and targeted a task
# named `cwin-s4-stack`, which no longer exists.
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$script:log = Join-Path $root 'rerun-s4-stack.log'
function L($m) { Add-Content -LiteralPath $script:log -Value ("[{0}] {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $m) -Encoding utf8 }

$taskName = if ($env:CYBERBOSS_BOOTSTRAP_TASK) { $env:CYBERBOSS_BOOTSTRAP_TASK } else { 'cwin-s1-session-bootstrap' }
L "=== re-run $taskName ==="
try {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $folder = $service.GetFolder('\')
  $task = $folder.GetTask($taskName)
  $folder.GetTask($taskName).Run($null) | Out-Null
  L "run requested; state=$($task.State)"
} catch {
  L ("run failed: " + $_.Exception.Message)
}
L 'done'
Get-Content -LiteralPath $script:log -Tail 5
