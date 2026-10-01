# start-uia-worker.ps1 - start Cua's UIAccess input helper.
#
# Why: on Windows, Cua Driver's `dispatch:"foreground"` escalation needs to swap
# the foreground window, and Windows refuses that for a process that is not at
# UIAccess integrity (the foreground-lock). Cua ships `cua-driver-uia.exe` for
# exactly this, but that binary carries an elevation manifest, so a normal
# process cannot spawn it - measured 2026-10-01:
#
#   Foreground swap to target HWND 0x50d02 was rejected by Windows ...
#   This daemon is not at UIAccess integrity ... Fix: install / spawn the
#   cua-driver-uia worker (UIAccess-manifested PE)
#   -> running cua-driver-uia.exe directly: "The requested operation requires elevation"
#
# ## What this costs you (read before running)
#
# A UIAccess process can send input to, and read the accessibility tree of,
# other processes - including elevated ones. It is a real privilege boundary,
# not a formality. Registering this task means every message the bot sends may
# take the foreground for a moment.
#
# ## How to run it
#
#   1. Run this file ONCE from an **elevated** PowerShell
#      (the task registration needs it; the task itself then runs as you):
#         Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-File','<this file>'
#   2. The helper is registered as a logon task and started immediately.
#
# It is reversible:  Unregister-ScheduledTask -TaskName cua-uia-worker -Confirm:$false
#
# ASCII only: PowerShell 5.1 reads BOM-less files as the ANSI code page.

$ErrorActionPreference = 'Continue'

$candidates = @(
  (Join-Path $env:USERPROFILE '.cua-driver\packages\releases'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Cua')
)
$helper = $null
foreach ($dir in $candidates) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  $found = Get-ChildItem -LiteralPath $dir -Recurse -Filter 'cua-driver-uia.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($found) { $helper = $found.FullName; break }
}
if (-not $helper) {
  Write-Host "cua-driver-uia.exe not found under: $($candidates -join '; ')"
  Write-Host "Install Cua Driver first: irm https://cua.ai/driver/install.ps1 | iex"
  exit 2
}
Write-Host "helper: $helper"

$taskName = 'cua-uia-worker'
# HighestAvailable is required: without it the task starts unelevated and the
# helper's own manifest makes it fail the same way it does from a normal shell.
$action = New-ScheduledTaskAction -Execute $helper
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "registered task: $taskName (RunLevel=Highest, at logon)"

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 5
$proc = Get-Process -Name 'cua-driver-uia' -ErrorAction SilentlyContinue
if ($proc) {
  foreach ($p in $proc) { Write-Host ("running: pid={0} session={1}" -f $p.Id, $p.SessionId) }
} else {
  Write-Host "the helper is not running; check the task's last result:"
  Write-Host "  (Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastTaskResult,LastRunTime)"
}
Write-Host ""
Write-Host "verify with a foreground escalation of your choice, e.g.:"
Write-Host '  cua-driver call click ''{"pid":<pid>,"window_id":<wid>,"x":10,"y":10,"dispatch":"foreground"}'''
Write-Host ""
Write-Host "to undo:  Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
