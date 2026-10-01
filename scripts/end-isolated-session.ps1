# end-isolated-session.ps1 - close the RDP client and terminate the isolated session.
#
# This is the irreversible half of removing the RDPWrap arrangement:
#   * the loopback mstsc client is asked to close (graceful, no kill first), and
#   * the isolated Windows session is logged off through the WTS API.
#
# Why the WTS API and not `logoff.exe`: this build has neither logoff.exe nor
# qwinsta/rwinsta in System32 (checked 2026-10-01), so there is no command-line
# way to end a session here.
#
# Why it needs elevation: the session belongs to the second Windows account
# (`cwinprobe`), and WTSLogoffSession from another account returns
# ERROR_ACCESS_DENIED (5) -- measured on this machine.
#
# Usage (elevated):
#   Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<this file>'
# Read-only inspection (no elevation needed):
#   powershell -NoProfile -File <this file> -Status
#
# ASCII only: PowerShell 5.1 reads BOM-less files as the ANSI code page.

param(
  # Session id to end. Omit to end the session that owns the mstsc client.
  [int]$SessionId = 0,
  [switch]$Status,
  # Also delete the logon-time bring-up task for the isolated stack, if the
  # operator registered one.
  [switch]$RemoveBootstrapTask
)

$ErrorActionPreference = 'Continue'

function Get-Sessions {
  Get-Process -ErrorAction SilentlyContinue | Group-Object SessionId |
    Sort-Object { [int]$_.Name } |
    ForEach-Object { "  session {0}: {1} process(es)" -f $_.Name, $_.Count }
}

if ($Status) {
  Write-Host "sessions:"
  Get-Sessions
  $mstsc = Get-Process -Name mstsc -ErrorAction SilentlyContinue
  Write-Host ("mstsc: " + $(if ($mstsc) { ($mstsc | ForEach-Object { "pid=$($_.Id) session=$($_.SessionId)" }) -join ', ' } else { 'not running' }))
  foreach ($n in @('Weixin', 'WeFlow', 'python')) {
    $p = Get-Process -Name $n -ErrorAction SilentlyContinue
    Write-Host ("{0,-8}: {1}" -f $n, $(if ($p) { ($p | Group-Object SessionId | ForEach-Object { "session $($_.Name) x$($_.Count)" }) -join ', ' } else { 'none' }))
  }
  exit 0
}

# --- 1) ask the RDP client to close -----------------------------------------
$mstsc = @(Get-Process -Name mstsc -ErrorAction SilentlyContinue)
foreach ($p in $mstsc) {
  try {
    if ($p.MainWindowHandle -ne 0) {
      $null = $p.CloseMainWindow()
      Write-Host "asked mstsc pid=$($p.Id) to close"
    } else {
      Stop-Process -Id $p.Id -Force -ErrorAction Stop
      Write-Host "killed mstsc pid=$($p.Id) (no window to close)"
    }
  } catch {
    Write-Host "mstsc pid=$($p.Id): $($_.Exception.Message)"
  }
}
if (-not $mstsc.Count) { Write-Host "no mstsc client running" }
Start-Sleep -Seconds 6

# --- 2) end the isolated session through the WTS API ------------------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WtsApi {
  [DllImport("wtsapi32.dll", SetLastError = true)]
  public static extern bool WTSLogoffSession(IntPtr hServer, int sessionId, bool wait);
}
'@ -ErrorAction Stop

# Default target: the session the mstsc client was looking at is the only other
# interactive one; take the highest session id that is not ours and not 0.
if ($SessionId -eq 0) {
  $mine = (Get-Process -Id $PID).SessionId
  $candidates = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -gt 0 -and $_.SessionId -ne $mine } |
    Select-Object -ExpandProperty SessionId -Unique | Sort-Object
  $SessionId = if ($candidates) { [int]($candidates | Select-Object -Last 1) } else { 0 }
  Write-Host "target session (auto): $SessionId   (mine: $mine)"
}
if ($SessionId -le 0) {
  Write-Host "nothing to end"
  exit 0
}

$ok = [WtsApi]::WTSLogoffSession([IntPtr]::Zero, $SessionId, $true)
$err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
Write-Host ("WTSLogoffSession({0}) -> {1} (win32 error {2})" -f $SessionId, $ok, $err)
if (-not $ok -and $err -eq 5) {
  Write-Host "Access denied: this must run elevated (the session belongs to another account)."
  exit 5
}
Start-Sleep -Seconds 10

# --- 3) report ---------------------------------------------------------------
Write-Host "--- after ---"
Get-Sessions
$still = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $SessionId })
if ($still.Count) {
  Write-Host "session $SessionId still has $($still.Count) process(es)"
} else {
  Write-Host "session $SessionId is gone"
}

if ($RemoveBootstrapTask) {
  $task = Get-ScheduledTask -TaskName 'cwin-s1-session-bootstrap' -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName 'cwin-s1-session-bootstrap' -Confirm:$false
    Write-Host "removed task cwin-s1-session-bootstrap"
  } else {
    Write-Host "no cwin-s1-session-bootstrap task to remove"
  }
}
