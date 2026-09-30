# weflow-anchor-rebuild.ps1 - cure WeFlow's `-105` (WCDB bootstrap / anti-rollback
# anchor) in the isolated session, reversibly.
#
# Signature it fixes: `/api/v1/health` 200 but `/api/v1/messages` 500 with body
# `{"error":"错误码: -105"}`, while `wcdb.log` repeats
# `[bootstrap] native runtime policy mismatch value=-105`. Restarting WeFlow does
# NOT help (it is not a stuck process) - the anchor state itself is bad.
#
# Anchors live in three places and must stay consistent:
#   %LOCALAPPDATA%\WeFlow\Runtime\anchor-v7-<id>.bin
#   %LOCALAPPDATA%\WeFlow\State\native-anchor-v7-<id>.bin
#   HKCU\Software\WeFlow\Runtime\AnchorV7-<id>
# docs/remediation-plan-2026-09-11.md prescribes deleting files AND registry value
# together. Measured 2026-09-25: deleting only the registry value was enough -
# WeFlow immediately rebuilt a fresh anchor (a new <id>) and the reader answered
# 200 again - so this recipe backs up everything, drops the registry value(s),
# restarts the reader, and restores the exported bytes if the reader is still
# broken (nothing to lose, and the anchor is never lost).
#
# Run it by dropping the file into C:\ProgramData\cwin-probe\s4\in (the isolated
# session's worker executes it as cwinprobe). ASCII only: the worker host reads
# BOM-less files as the ANSI code page.

$ErrorActionPreference = 'Continue'
# Machine bindings: dot-source the shared header instead of hardcoding the probe
# root and the checkout path.
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$report = Join-Path $root 's4\weflow-anchor-rebuild-report.txt'
Start-Transcript -Path $report -Force | Out-Null

$sessionId = (Get-Process -Id $PID).SessionId
"=== weflow anchor rebuild $(Get-Date -Format 'MM-dd HH:mm:ss') session=$sessionId user=$([Environment]::UserName) ==="

$anchorFileDirs = @(
  (Join-Path $env:LOCALAPPDATA 'WeFlow\Runtime'),
  (Join-Path $env:LOCALAPPDATA 'WeFlow\State')
)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $root "repair\weflow-anchor-backup-$stamp"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

"--- anchor files on disk ---"
foreach ($dir in $anchorFileDirs) {
  if (-not (Test-Path -LiteralPath $dir)) { "  (missing) $dir"; continue }
  foreach ($file in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'anchor' })) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $backupDir $file.Name) -Force
    "  " + $file.LastWriteTime.ToString('MM-dd HH:mm') + "  " + $file.Length + "B  " + $file.FullName + "  (backed up)"
  }
}

"--- registry anchor value(s) ---"
$keyPath = 'Software\WeFlow\Runtime'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $true)
if ($null -eq $key) { "REFUSING: cannot open HKCU\$keyPath"; Stop-Transcript | Out-Null; exit 1 }
$names = @($key.GetValueNames() | Where-Object { $_ -match 'AnchorV7' })
"  names = $($names -join ', ')"
if ($names.Count -eq 0) {
  "no registry anchor to rebuild; leaving everything as it is"
  $key.Close()
  Stop-Transcript | Out-Null
  exit 1
}
foreach ($name in $names) {
  $bytes = [byte[]]$key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $sha = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '')
  [IO.File]::WriteAllBytes((Join-Path $backupDir "$name.bin"), $bytes)
  "  $name bytes=$($bytes.Length) sha256=$sha (backed up)"
  try { $key.DeleteValue($name, $false); "  deleted $name" } catch { "  delete failed: $($_.Exception.Message)" }
}
$key.Close()
"  backups in $backupDir"

"--- restart the reader ---"
foreach ($process in @(Get-Process WeFlow -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId })) {
  try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch {}
}
Start-Sleep -Seconds 5
$exe = Join-Path $root 'WeFlow\WeFlow.exe'
if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe | Out-Null } else { "MISSING $exe" }
for ($i = 1; $i -le 40; $i++) {
  Start-Sleep -Seconds 3
  if (Get-NetTCPConnection -LocalPort 5051 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1) { "  port 5051 up after $($i * 3)s"; break }
}

$envLines = Get-Content $envFile -Encoding utf8
$token = (($envLines | Where-Object { $_ -match '^CYBERBOSS_WEFLOW_TOKEN=' }) -replace '^CYBERBOSS_WEFLOW_TOKEN=', '').Trim()
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$url = "http://127.0.0.1:5051/api/v1/messages?talker=wxid_ubo0cy5xh4px22&limit=2&start=$($now-86400)&end=$now"
$ok = $false
foreach ($attempt in 1..6) {
  try {
    $response = Invoke-WebRequest -Uri $url -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 25 -UseBasicParsing
    "  attempt $attempt : messages -> HTTP $($response.StatusCode) OK"
    $ok = $true
    break
  } catch {
    $body = ''
    if ($_.Exception.Response) { try { $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); $body = $sr.ReadToEnd() } catch {} }
    "  attempt $attempt : messages -> ERR $body"
    Start-Sleep -Seconds 8
  }
}

if ($ok) {
  "READER OK = True (anchor rebuilt; WeFlow writes a fresh AnchorV7-<id>)"
} else {
  "READER OK = False - restoring the backed-up registry value(s)"
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $true)
  foreach ($name in $names) {
    $file = Join-Path $backupDir "$name.bin"
    if (Test-Path -LiteralPath $file) {
      try { $key.SetValue($name, [byte[]]([IO.File]::ReadAllBytes($file)), [Microsoft.Win32.RegistryValueKind]::Binary); "  restored $name" }
      catch { "  restore $name failed: $($_.Exception.Message)" }
    }
  }
  $key.Close()
}
Stop-Transcript | Out-Null
