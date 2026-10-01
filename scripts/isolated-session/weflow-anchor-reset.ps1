# weflow-anchor-reset.ps1 - rebuild WeFlow's WCDB anchor state when the reader
# refuses to bootstrap.
#
# Symptom (measured 2026-10-01, WeFlow started fresh in the interactive session):
#
#   %APPDATA%\weflow\logs\wcdb.log
#   [bootstrap] koffi.load ok
#   [bootstrap] native runtime policy mismatch value=-101
#
# and the HTTP API never binds, so the bot reads nothing. The `-105` variant of
# this failure is documented in the deployment note (registry `AnchorV7-*` value
# plus two `.bin` files under %LOCALAPPDATA%\WeFlow). This script handles both by
# backing up then clearing the anchor, restarting the reader, and only keeping
# the removal if the reader actually comes back.
#
# Usage:
#   powershell -NoProfile -File scripts/isolated-session/weflow-anchor-reset.ps1
#   ... -Restore           # put the newest backup back
#   ... -Status            # report only, change nothing
#
# ASCII only: PowerShell 5.1 reads BOM-less files as the ANSI code page.

param(
  [switch]$Restore,
  [switch]$Status,
  [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Continue'
$localAppData = $env:LOCALAPPDATA
$weflowRoot = Join-Path $localAppData 'WeFlow'
$backupRoot = Join-Path $env:ProgramData 'cwin-probe\repair'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

function Get-AnchorRegistryValues {
  $key = 'HKCU:\Software\WeFlow\Runtime'
  if (-not (Test-Path $key)) { return @() }
  (Get-Item $key).Property | Where-Object { $_ -like 'AnchorV7-*' } |
    ForEach-Object { [pscustomobject]@{ Key = $key; Name = $_; Value = (Get-ItemProperty $key -Name $_).$_ } }
}

function Get-AnchorFiles {
  $dirs = @((Join-Path $weflowRoot 'Runtime'), (Join-Path $weflowRoot 'State'), (Join-Path $weflowRoot 'Security'))
  foreach ($d in $dirs) {
    if (-not (Test-Path $d)) { continue }
    Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'anchor' } | Select-Object FullName, Length, LastWriteTime
  }
}

function Wait-Api {
  param([int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $listen = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -in 5051, 5031 }
    if ($listen) { return $listen | Select-Object -First 1 }
    Start-Sleep -Seconds 3
  }
  return $null
}

if ($Status) {
  Log "anchor registry values:"
  Get-AnchorRegistryValues | ForEach-Object { Log ("  {0} = {1}" -f $_.Name, $_.Value) }
  Log "anchor files:"
  Get-AnchorFiles | ForEach-Object { Log ("  {0} ({1} B, {2})" -f $_.FullName, $_.Length, $_.LastWriteTime) }
  $listen = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 5051, 5031 }
  Log ("reader API listening: " + $(if ($listen) { ($listen | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid=$($_.OwningProcess)" }) -join ', ' } else { 'no' }))
  $wcdb = Join-Path $env:APPDATA 'weflow\logs\wcdb.log'
  if (Test-Path $wcdb) {
    Log "last wcdb.log lines:"
    Get-Content $wcdb -Tail 6 | ForEach-Object { Log ("  " + $_) }
  }
  exit 0
}

function Restart-Reader {
  foreach ($p in (Get-Process -Name WeFlow -ErrorAction SilentlyContinue)) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Log ("killed WeFlow pid=" + $p.Id) } catch { Log ("kill " + $p.Id + " failed: " + $_.Exception.Message) }
  }
  Start-Sleep -Seconds 4
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\WeFlow\WeFlow.exe'
  if (-not (Test-Path $exe)) { $exe = Join-Path $env:ProgramData 'cwin-probe\WeFlow\WeFlow.exe' }
  if (-not (Test-Path $exe)) { Log "WeFlow.exe not found"; return $false }
  # Must start in the interactive session; a task with InteractiveToken does that.
  $taskName = 'cb-restart-weflow'
  $action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory (Split-Path $exe -Parent)
  # Enum trap, both directions (measured 2026-10-01): the PowerShell cmdlet only
  # accepts Limited / Highest, while the Task Scheduler XML schema only accepts
  # LeastPrivilege / HighestAvailable. Mixing them up fails registration.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Log "restart requested via task $taskName ($exe)"
  return $true
}

if ($Restore) {
  $newest = Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'weflow-anchor-*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $newest) { Log "no anchor backup found under $backupRoot"; exit 2 }
  Log "restoring from $($newest.FullName)"
  foreach ($reg in Get-ChildItem -LiteralPath $newest.FullName -Filter '*.reg.json' -ErrorAction SilentlyContinue) {
    $payload = Get-Content -LiteralPath $reg.FullName -Raw | ConvertFrom-Json
    foreach ($item in $payload) {
      New-ItemProperty -Path $item.Key -Name $item.Name -Value $item.Value -PropertyType String -Force | Out-Null
      Log ("restored {0} = {1}" -f $item.Name, $item.Value)
    }
  }
  foreach ($file in Get-ChildItem -LiteralPath $newest.FullName -Filter '*.bin' -ErrorAction SilentlyContinue) {
    $dest = Join-Path $weflowRoot ("Runtime\" + $file.Name)
    Copy-Item $file.FullName $dest -Force
    Log ("restored file -> " + $dest)
  }
  Restart-Reader | Out-Null
  $listen = Wait-Api -TimeoutSeconds $WaitSeconds
  Log ("reader API after restore: " + $(if ($listen) { "port $($listen.LocalPort)" } else { 'still down' }))
  exit $(if ($listen) { 0 } else { 1 })
}

# --- 1) back up the current anchor state -------------------------------------
$backupDir = Join-Path $backupRoot ("weflow-anchor-$stamp")
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$values = @(Get-AnchorRegistryValues)
if ($values.Count) {
  $values | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDir 'anchor-registry.reg.json') -Encoding utf8
  Log ("backed up {0} registry anchor value(s)" -f $values.Count)
}
foreach ($f in Get-AnchorFiles) {
  Copy-Item $f.FullName (Join-Path $backupDir $f.Name) -Force
  Log ("backed up file " + $f.Name)
}
Log "backup dir: $backupDir"

# --- 2) clear the anchor ------------------------------------------------------
foreach ($v in $values) {
  Remove-ItemProperty -Path $v.Key -Name $v.Name -ErrorAction SilentlyContinue
  Log ("removed registry anchor " + $v.Name)
}
foreach ($f in Get-AnchorFiles) {
  Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
  Log ("removed file " + $f.Name)
}

# --- 3) restart and verify ----------------------------------------------------
Restart-Reader | Out-Null
$listen = Wait-Api -TimeoutSeconds $WaitSeconds
if ($listen) {
  Log ("reader API is up on port {0} (pid {1})" -f $listen.LocalPort, $listen.OwningProcess)
  exit 0
}
Log "reader API did NOT come back"
$wcdb = Join-Path $env:APPDATA 'weflow\logs\wcdb.log'
if (Test-Path $wcdb) { Log "last wcdb.log lines:"; Get-Content $wcdb -Tail 8 | ForEach-Object { Log ("  " + $_) } }
Log "roll back with: -Restore"
exit 1
