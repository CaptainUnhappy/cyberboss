# Session bootstrap v2: the file-queue worker goes FIRST and is verified, because
# without it nothing the guards queue (bridge/WeFlow restarts) is ever consumed.
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$log = Join-Path $root 'session-bootstrap.log'
function L($m) { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $m) -Encoding utf8 }
L ("bootstrap v2 session=" + (Get-Process -Id $PID).SessionId + " user=" + [Environment]::UserName)

$worker = Join-Path $repoRoot 'scripts\isolated-session\s4-worker.ps1'
$hb = Join-Path $root 's4\heartbeat.txt'
if (Test-Path -LiteralPath $worker) {
  $before = if (Test-Path $hb) { (Get-Item $hb).LastWriteTime } else { Get-Date '2000-01-01' }
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$worker) -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(45); $ok = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if ((Test-Path $hb) -and (Get-Item $hb).LastWriteTime -gt $before) { $ok = $true; break }
  }
  L ("worker heartbeat advancing = " + $ok + " (" + $(if (Test-Path $hb) { (Get-Content $hb -Raw).Trim() } else { 'none' }) + ")")
} else { L "worker script missing: $worker" }

if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process "$env:SystemRoot\explorer.exe" | Out-Null; L 'explorer started'; Start-Sleep -Seconds 8 }
if (-not (Get-Process Weixin -ErrorAction SilentlyContinue)) { $wx = if ($env:CYBERBOSS_WECHAT_EXE) { $env:CYBERBOSS_WECHAT_EXE } else { Join-Path ${env:ProgramFiles} 'Tencent\Weixin\Weixin.exe' }; if (Test-Path $wx) { Start-Process $wx | Out-Null; L 'Weixin started' } } else { L 'Weixin already running' }
Start-Sleep -Seconds 20
if (-not (Get-Process WeFlow -ErrorAction SilentlyContinue)) { $wf = Join-Path $root 'WeFlow\WeFlow.exe'; if (Test-Path $wf) { Start-Process $wf | Out-Null; L 'WeFlow started' } } else { L 'WeFlow already running' }
Start-Sleep -Seconds 25
$br = Join-Path $repoRoot 'scripts\isolated-session\bridge-restart.ps1'
if (Test-Path -LiteralPath $br) { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $br *>> $log; L 'bridge restarted' }
L 'bootstrap v2 done'