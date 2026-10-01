# probe-uia-worker.ps1 - answer ONE question: can the signed UIA worker start
# from a properly elevated RunLevel=Highest task on this machine?
#
# Run it ELEVATED (it needs admin to register a highest-privilege task):
#   Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<this file>'
#
# It registers a temporary probe task, prints what that task's context actually
# was (elevated or not) and whether the worker survived, then removes the probe.
# The cua-uia-worker task is left registered only if the worker actually runs.
#
# ASCII only: PowerShell 5.1 reads BOM-less files as the ANSI code page.

$ErrorActionPreference = 'Continue'
$stage = Join-Path ${env:ProgramFiles} 'Cua'
$helper = Join-Path $stage 'cua-driver-uia.exe'
$probeOut = Join-Path $env:TEMP 'cb-elev-probe.txt'
$probeScript = Join-Path $env:TEMP 'cb-elev-probe-child.ps1'

Remove-Item -LiteralPath $probeOut -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $helper)) {
  Write-Host "helper not staged: $helper"
  exit 2
}

# The child the probe task runs: record its own elevation, then try the worker.
$child = @"
`$ErrorActionPreference = 'Continue'
`$me = [Security.Principal.WindowsIdentity]::GetCurrent()
`$isAdmin = ([Security.Principal.WindowsPrincipal]`$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
"isAdmin=`$isAdmin user=`$(`$me.Name)" | Set-Content -LiteralPath '$probeOut'
`$sig = Get-AuthenticodeSignature -LiteralPath '$helper'
"signature=`$(`$sig.Status)" | Add-Content -LiteralPath '$probeOut'
try {
  `$p = Start-Process -FilePath '$helper' -PassThru -ErrorAction Stop
  "started pid=`$(`$p.Id)" | Add-Content -LiteralPath '$probeOut'
  Start-Sleep -Seconds 4
  `$n = (Get-Process -Name 'cua-driver-uia' -ErrorAction SilentlyContinue | Measure-Object).Count
  "helper running count=`$n" | Add-Content -LiteralPath '$probeOut'
} catch {
  "start failed: `$(`$_.Exception.Message)" | Add-Content -LiteralPath '$probeOut'
}
"@
Set-Content -LiteralPath $probeScript -Value $child -Encoding UTF8

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$probeScript`""
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'cb-elev-probe' -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'cb-elev-probe'
Start-Sleep -Seconds 14
$info = Get-ScheduledTaskInfo -TaskName 'cb-elev-probe' -ErrorAction SilentlyContinue
Write-Host ("probe task result = 0x{0:X8}" -f $info.LastTaskResult)
Unregister-ScheduledTask -TaskName 'cb-elev-probe' -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "--- child report ---"
if (Test-Path $probeOut) { Get-Content -LiteralPath $probeOut } else { Write-Host "(no report: the child never ran)" }

$running = Get-Process -Name 'cua-driver-uia' -ErrorAction SilentlyContinue
Write-Host "--- verdict ---"
if ($running) {
  foreach ($p in $running) { Write-Host "UIA worker IS RUNNING: pid=$($p.Id) session=$($p.SessionId)" }
} else {
  Write-Host "UIA worker is NOT running."
}
