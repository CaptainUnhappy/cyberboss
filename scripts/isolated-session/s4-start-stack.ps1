$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$log = Join-Path $root 's4-start-stack.log'
function L($m) { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding utf8 }
L ("start stack in session " + (Get-Process -Id $PID).SessionId + " user " + [Environment]::UserName)
# WeChat
if (-not (Get-Process Weixin -ErrorAction SilentlyContinue)) {
  $wx = if ($env:CYBERBOSS_WECHAT_EXE) { $env:CYBERBOSS_WECHAT_EXE } else { Join-Path ${env:ProgramFiles} 'Tencent\Weixin\Weixin.exe' }
  if (Test-Path -LiteralPath $wx) { Start-Process -FilePath $wx | Out-Null; L 'Weixin started' } else { L "Weixin not found at $wx" }
} else { L 'Weixin already running' }
Start-Sleep -Seconds 20
# WeFlow
if (-not (Get-Process WeFlow -ErrorAction SilentlyContinue)) {
  $wf = Join-Path $root 'WeFlow\WeFlow.exe'
  if (Test-Path -LiteralPath $wf) { Start-Process -FilePath $wf | Out-Null; L 'WeFlow started' } else { L "WeFlow not found at $wf" }
} else { L 'WeFlow already running' }
Start-Sleep -Seconds 25
# UIA bridge (canonical recipe loads its own env)
$br = Join-Path $repoRoot 'scripts\isolated-session\bridge-restart.ps1'
if (Test-Path -LiteralPath $br) { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $br *>> $log; L 'bridge-restart done' } else { L "bridge recipe missing: $br" }
# queue worker
$worker = Join-Path $repoRoot 'scripts\isolated-session\s4-worker.ps1'
if (Test-Path -LiteralPath $worker) {
  if (-not (Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId })) { L 'no powershell in session (unexpected)' }
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$worker) -WindowStyle Hidden | Out-Null
  L 'queue worker launched'
} else { L "worker missing: $worker" }
L 'done'