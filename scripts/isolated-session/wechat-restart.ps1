# wechat-restart.ps1 - relaunch the bot account's WeChat (Azzy) in the isolated session.
#
# Must run INSIDE the isolated session: the write-side UIA bridge drives that
# session's desktop, so a Weixin.exe started from session 1 can never be found by
# it (the bridge's /readyz stays 503 "wechatWindow: false" while a session-1
# Weixin satisfies the watchdog's session-agnostic process check, which hides the
# real problem).  That is exactly how a session-1 stray appeared on 2026-09-23
# 18:14:50: the mechanical repair called Ensure-WeixinStarted in session 1.
#
# The usual way to run this is to drop the file into C:\ProgramData\cwin-probe\s4\in
# and let the session-4 worker pick it up (it runs as cwinprobe in session 4).
#
# ASCII only: the session-4 worker runs this with powershell.exe -File and the
# host reads BOM-less files as the ANSI code page.

$ErrorActionPreference = 'Continue'
$root = 'C:\ProgramData\cwin-probe'
$report = Join-Path $root 's4\wechat-restart-report.txt'
$exe = 'C:\Program Files\Tencent\Weixin\Weixin.exe'
$bridgeReadyz = 'http://127.0.0.1:8776/readyz'
Start-Transcript -Path $report -Force | Out-Null

"whoami=$([Environment]::UserName) session=$((Get-Process -Id $PID).SessionId) started=$(Get-Date -Format o)"
"exe exists = $(Test-Path -LiteralPath $exe)"

foreach ($process in @(Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq 4 })) {
  try { Stop-Process -Id $process.Id -Force -ErrorAction Stop; "killed previous session-4 weixin pid=$($process.Id)" }
  catch { "kill $($process.Id) failed: $($_.Exception.Message)" }
}
Start-Sleep -Seconds 2

$launcher = Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -PassThru
"launcher pid=$($launcher.Id)"

# The bridge answers /readyz with the logged-in main chat window it can actually
# see.  Polling it is the only verdict that proves the *isolated* session has a
# usable WeChat, and it stays 503 while the account still needs a QR login.
$ready = $false
for ($attempt = 1; $attempt -le 40; $attempt++) {
  Start-Sleep -Seconds 3
  $session4 = @(Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq 4 } | ForEach-Object { $_.Id })
  try {
    $response = Invoke-WebRequest -Uri $bridgeReadyz -TimeoutSec 5 -UseBasicParsing
    if ($attempt -eq 1 -or $attempt % 5 -eq 0) {
      "attempt $attempt : session4 weixin pids=$($session4 -join ',') readyz=$($response.StatusCode) $($response.Content)"
    }
    if ($response.StatusCode -eq 200) { $ready = $true; break }
  } catch {
    if ($attempt -eq 1 -or $attempt % 5 -eq 0) {
      "attempt $attempt : session4 weixin pids=$($session4 -join ',') readyz=ERR $($_.Exception.Message)"
    }
  }
}

$titles = @(Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq 4 } | ForEach-Object { "$($_.Id):$($_.MainWindowTitle)" })
"session4 weixin windows: $($titles -join ' | ')"
"READY = $ready"
if (-not $ready) {
  "WeChat is running in session 4 but the bridge still cannot see a logged-in main chat window; a QR/window login is required (see the RDPWrap deployment note)."
}
Stop-Transcript | Out-Null
