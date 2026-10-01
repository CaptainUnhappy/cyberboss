# stage-uia-worker.ps1 - put Cua's SIGNED UIAccess worker where Windows allows it.
#
# Windows requires a uiAccess binary to satisfy BOTH:
#   1. live in a secure location (%ProgramFiles% or %SystemRoot%\System32), and
#   2. be signed by a certificate chained to a trusted root.
#
# Cua's own installer unpacks the release under %USERPROFILE%\.cua-driver\packages\,
# so condition 1 is unmet and the worker cannot start (ERROR_ELEVATION_REQUIRED,
# 0x800702E4). Condition 2 is met from cua-driver 0.31.0 on, where
# cua-driver-uia.exe is Authenticode-signed by "Cua AI, Inc.".
#
# This script copies the current release into Program Files and registers the
# autostart task. Run it elevated ONCE per Cua upgrade:
#
#   Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<this file>'
#
# Status-only (no elevation needed):
#   powershell -NoProfile -File <this file> -Status
#
# ASCII only: PowerShell 5.1 reads BOM-less files as the ANSI code page.

param([switch]$Status)

$ErrorActionPreference = 'Continue'
$taskName = 'cua-uia-worker'
$stage = Join-Path ${env:ProgramFiles} 'Cua'
$current = Join-Path $env:USERPROFILE '.cua-driver\packages\current'
$helper = Join-Path $stage 'cua-driver-uia.exe'

function Show-Status {
  Write-Host "release (current) : $current"
  if (Test-Path $current) {
    $resolved = (Get-Item -LiteralPath $current).Target
    if ($resolved) { Write-Host "  -> $resolved" }
  } else {
    Write-Host "  (missing: is Cua Driver installed?)"
  }
  Write-Host "staged helper    : $(if (Test-Path $helper) { $helper } else { '(not staged)' })"
  if (Test-Path $helper) {
    $sig = Get-AuthenticodeSignature -LiteralPath $helper
    Write-Host "  signature      : $($sig.Status)"
    if ($sig.SignerCertificate) { Write-Host "  signer         : $($sig.SignerCertificate.Subject)" }
  }
  $proc = Get-Process -Name 'cua-driver-uia' -ErrorAction SilentlyContinue
  if ($proc) {
    foreach ($x in $proc) { Write-Host "helper running   : pid=$($x.Id) session=$($x.SessionId)" }
  } else {
    Write-Host "helper running   : no"
  }
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    Write-Host ("autostart task   : state=$($task.State) runLevel=$($task.Principal.RunLevel) lastResult=0x{0:X8}" -f $info.LastTaskResult)
  } else {
    Write-Host "autostart task   : (none)"
  }
}

if ($Status) { Show-Status; exit 0 }

if (-not (Test-Path $current)) {
  Write-Host "no Cua release found at $current"
  Write-Host "install first:  irm https://cua.ai/driver/install.ps1 | iex"
  exit 2
}

Write-Host "removing any stale stage at $stage"
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Write-Host "copying $current -> $stage"
Copy-Item -Path (Join-Path $current '*') -Destination $stage -Recurse -Force

if (-not (Test-Path $helper)) {
  Write-Host "copy did not produce $helper"
  Get-ChildItem -LiteralPath $stage | Select-Object -First 10 Name | ForEach-Object { Write-Host "  $_" }
  exit 3
}

$sig = Get-AuthenticodeSignature -LiteralPath $helper
Write-Host "staged helper signature: $($sig.Status)"
if ($sig.Status -ne 'Valid') {
  Write-Host "refusing to register: UIAccess also requires a valid signature."
  Write-Host "Upgrade Cua Driver (cua-driver update --apply); 0.3.x shipped an unsigned worker."
  exit 4
}

$action = New-ScheduledTaskAction -Execute $helper
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "registered task: $taskName (RunLevel=Highest, at logon)"
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 6
Show-Status
