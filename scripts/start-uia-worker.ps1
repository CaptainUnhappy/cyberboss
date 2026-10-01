# start-uia-worker.ps1 - make Cua's UIAccess input helper usable, then start it.
#
# ## Why the helper is needed
#
# On Windows, Cua Driver's `dispatch:"foreground"` escalation has to swap the
# foreground window. Windows refuses that for a process below UIAccess integrity
# (the foreground-lock), and Cua Driver itself is not UIAccess. Measured
# 2026-10-01 against the WeChat desktop client:
#
#   Foreground swap to target HWND 0x50d02 was rejected by Windows ...
#   This daemon is not at UIAccess integrity ... Fix: install / spawn the
#   cua-driver-uia worker (UIAccess-manifested PE)
#
# ## Why "just elevate it" does not work
#
# `cua-driver-uia.exe` declares `<requestedExecutionLevel level="asInvoker"
# uiAccess="true">`. A uiAccess binary must live in a secure location
# (%ProgramFiles% or %SystemRoot%\System32) AND be signed by a certificate
# chained to a trusted root; anywhere else Windows refuses to launch it with
# ERROR_ELEVATION_REQUIRED (0x800702E4) -- which is exactly what a
# RunLevel=Highest scheduled task reported for it.
#
# The default install puts it under `%USERPROFILE%\.cua-driver\packages\...`,
# so this script copies the whole release folder into Program Files (which needs
# elevation once), then starts the helper from there.
#
# ## What running it costs you
#
# A UIAccess process can read the accessibility tree of, and send input to, other
# processes -- including elevated ones. That is a real privilege boundary. Enable
# it only if you accept that the automation may briefly take the foreground.
#
# ## Usage (elevated, once)
#
#   Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<this file>'
#
# Undo:
#   Unregister-ScheduledTask -TaskName cua-uia-worker -Confirm:$false
#   Remove-Item 'C:\Program Files\Cua' -Recurse -Force
#
# ASCII only: PowerShell 5.1 reads BOM-less files as the ANSI code page.

param(
  # Copy into Program Files and register the autostart task (needs elevation).
  [switch]$Install = $true,
  # Only report what is where.
  [switch]$Status
)

$ErrorActionPreference = 'Continue'
$taskName = 'cua-uia-worker'
$targetDir = Join-Path ${env:ProgramFiles} 'Cua'
$installRoot = Join-Path $env:USERPROFILE '.cua-driver\packages\releases'

function Find-Helper([string]$root) {
  if (-not (Test-Path -LiteralPath $root)) { return $null }
  $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter 'cua-driver-uia.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  return $null
}

$sourceHelper = Find-Helper $installRoot
$stagedHelper = Join-Path $targetDir 'cua-driver-uia.exe'

if ($Status) {
  Write-Host "installed helper : $(if (Test-Path $stagedHelper) { $stagedHelper } else { '(not staged)' })"
  Write-Host "source helper    : $(if ($sourceHelper) { $sourceHelper } else { '(not found)' })"
  $proc = Get-Process -Name 'cua-driver-uia' -ErrorAction SilentlyContinue
  Write-Host "running          : $(if ($proc) { ($proc | ForEach-Object { "pid=$($_.Id) session=$($_.SessionId)" }) -join ', ' } else { 'no' })"
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Write-Host "autostart task   : $(if ($task) { "state=$($task.State) runLevel=$($task.Principal.RunLevel)" } else { '(none)' })"
  exit 0
}

if (-not $sourceHelper -and -not (Test-Path $stagedHelper)) {
  Write-Host "cua-driver-uia.exe not found (looked in $installRoot and $targetDir)."
  Write-Host "Install Cua Driver first:  irm https://cua.ai/driver/install.ps1 | iex"
  exit 2
}

# --- 1) stage the whole release next to the helper (it needs its siblings) ----
if ($sourceHelper) {
  $releaseDir = Split-Path $sourceHelper -Parent
  Write-Host "staging $releaseDir -> $targetDir"
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  Copy-Item -Path (Join-Path $releaseDir '*') -Destination $targetDir -Recurse -Force
} else {
  Write-Host "already staged: $stagedHelper"
}

if (-not (Test-Path $stagedHelper)) {
  Write-Host "staging failed: $stagedHelper is missing"
  exit 3
}
Write-Host "helper staged at $stagedHelper"

# --- 2) autostart task so it comes back after a reboot -----------------------
# HighestAvailable: the helper cannot start below UIAccess, and the task has to
# be able to run it without an interactive prompt.
$action = New-ScheduledTaskAction -Execute $stagedHelper
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "registered task: $taskName (RunLevel=Highest, at logon)"

# --- 3) start it now and report ---------------------------------------------
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 6
$proc = Get-Process -Name 'cua-driver-uia' -ErrorAction SilentlyContinue
if ($proc) {
  foreach ($p in $proc) { Write-Host ("helper running: pid={0} session={1}" -f $p.Id, $p.SessionId) }
} else {
  $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
  Write-Host ("helper NOT running; task last result = 0x{0:X8}" -f $info.LastTaskResult)
  Write-Host "0x800702E4 = ERROR_ELEVATION_REQUIRED (the binary is still outside a secure location, or unsigned)"
}
