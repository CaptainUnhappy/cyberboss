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
# host reads BOM-less files as the ANSI code page.  Chinese UI labels are built
# from code points below for that reason.
#
# Verdict is taken from the bridge's /readyz - the only signal that proves the
# *isolated* session has a usable, logged-in WeChat main window.

$ErrorActionPreference = 'Continue'
# Machine bindings: dot-source the shared header instead of hardcoding the probe
# root; the client path stays overridable because installs differ per machine.
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$report = Join-Path $root 's4\wechat-restart-report.txt'
$exe = if ($env:CYBERBOSS_WECHAT_EXE) { $env:CYBERBOSS_WECHAT_EXE } else { Join-Path ${env:ProgramFiles} 'Tencent\Weixin\Weixin.exe' }
$bridgeReadyz = 'http://127.0.0.1:8776/readyz'
$loginWindowClass = 'mmui::LoginWindow'
# "jin ru wei xin" = the resume button on the remembered-session screen.
# Built with -join: [string]::Concat(<chars>) resolves to an overload that
# returns $null here, which silently disabled the resume click once already.
$enterWeChatLabel = -join @([char]0x8FDB, [char]0x5165, [char]0x5FAE, [char]0x4FE1)
# The isolated session's id is simply whatever session this script runs in.
# Until 2026-09-24 everything hardcoded "session 4"; when the session was lost
# and recreated it came back as session 3, so every `-eq 4` filter matched
# nothing while a WeChat was quietly running in the right session.  Never
# hardcode the id again: a recipe runs *inside* the session it manages.
$isolatedSessionId = (Get-Process -Id $PID).SessionId
Start-Transcript -Path $report -Force | Out-Null

function Get-IsolatedWeixinPids {
  return @(Get-Process Weixin -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq $isolatedSessionId } |
    ForEach-Object { $_.Id })
}

function Test-BridgeReady {
  try {
    $response = Invoke-WebRequest -Uri $bridgeReadyz -TimeoutSec 5 -UseBasicParsing
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

# After an unclean exit WeChat comes back on mmui::LoginWindow showing the
# remembered account plus an "enter" button; resuming it is a normal UIA action
# on this desktop (no phone/QR needed while the session is still remembered).
# The click is only allowed when the window actually lists Azzy.
function Resume-RememberedWeChatSession {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $rootElement = [System.Windows.Automation.AutomationElement]::RootElement
  $children = [System.Windows.Automation.TreeScope]::Children
  $descendants = [System.Windows.Automation.TreeScope]::Descendants
  foreach ($wxPid in Get-IsolatedWeixinPids) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $wxPid)
    foreach ($window in $rootElement.FindAll($children, $condition)) {
      if ($window.Current.ClassName -ne $loginWindowClass) { continue }
      $nodes = $window.FindAll($descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $rememberedAzzy = $false
      $enterButton = $null
      foreach ($node in $nodes) {
        $name = [string]$node.Current.Name
        if ($name -like '*Azzy*') { $rememberedAzzy = $true }
        # Compare the control type by name: AutomationIdentifier equality via -eq
        # is not reliable for Qt-drawn controls (it silently never matched).
        if ($name -eq $enterWeChatLabel `
            -and [string]$node.Current.ControlType.ProgrammaticName -eq 'ControlType.Button') {
          $enterButton = $node
        }
      }
      "login window found: rememberedAzzy=$rememberedAzzy resumeButton=$($null -ne $enterButton) nodes=$($nodes.Count)"
      if (-not $rememberedAzzy) {
        "login window is up but the remembered account is not Azzy; refusing to click"
        return $false
      }
      if ($null -eq $enterButton) { continue }
      # Qt/mmui: InvokePattern reports success and does nothing (measured
      # 2026-09-23: the call returned and readyz stayed 503), so the click is the
      # action that actually resumes the session.  Activation mirrors
      # weflow-uia-bridge.activate_window() - without it the click lands on
      # whatever window happens to be in front.  The caller re-checks /readyz, so
      # nothing here is trusted on its own.
      if (-not ('CyberbossWin32Input' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CyberbossWin32Input {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public static bool Activate(IntPtr h) {
    IntPtr foreground = GetForegroundWindow();
    uint foregroundThread = foreground == IntPtr.Zero ? 0u : GetWindowThreadProcessId(foreground, IntPtr.Zero);
    uint currentThread = GetCurrentThreadId();
    bool attached = foregroundThread != 0u && foregroundThread != currentThread;
    if (attached) { AttachThreadInput(currentThread, foregroundThread, true); }
    try {
      ShowWindow(h, 9);
      BringWindowToTop(h);
      if (!SetForegroundWindow(h)) { return false; }
      System.Threading.Thread.Sleep(250);
      return GetForegroundWindow() == h;
    } finally {
      if (attached) { AttachThreadInput(currentThread, foregroundThread, false); }
    }
  }
  public static void LeftClick(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(150);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
'@
      }
      $rect = $enterButton.Current.BoundingRectangle
      $handle = [IntPtr]$window.Current.NativeWindowHandle
      $activated = [CyberbossWin32Input]::Activate($handle)
      "login window hwnd=$handle rect=$([int]$rect.X),$([int]$rect.Y) $([int]$rect.Width)x$([int]$rect.Height) activated=$activated"
      if (-not $activated) { return $false }
      $clickX = [int]($rect.X + $rect.Width / 2)
      $clickY = [int]($rect.Y + $rect.Height / 2)
      [void][CyberbossWin32Input]::LeftClick($clickX, $clickY)
      "clicked the resume button at $clickX,$clickY"
      return $true
    }
  }
  return $false
}

"whoami=$([Environment]::UserName) session=$isolatedSessionId started=$(Get-Date -Format o)"
"exe exists = $(Test-Path -LiteralPath $exe)"

if (@(Get-IsolatedWeixinPids).Count -eq 0) {
  foreach ($process in @(Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $isolatedSessionId })) {
    try { Stop-Process -Id $process.Id -Force -ErrorAction Stop; "killed previous isolated-session weixin pid=$($process.Id)" }
    catch { "kill $($process.Id) failed: $($_.Exception.Message)" }
  }
  Start-Sleep -Seconds 2
  $launcher = Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -PassThru
  "launcher pid=$($launcher.Id)"
} else {
  "isolated-session weixin already running: $((Get-IsolatedWeixinPids) -join ',')"
}

$ready = $false
$resumeAttempts = 0
for ($attempt = 1; $attempt -le 40; $attempt++) {
  Start-Sleep -Seconds 3
  if (Test-BridgeReady) { $ready = $true; break }
  if ($attempt % 3 -eq 0 -and $resumeAttempts -lt 4) {
    $resumeAttempts++
    "resume attempt $resumeAttempts (readyz still not ok)"
    # Keep the function's own diagnostics: [void](...) would discard the output
    # stream, which is where its "login window found / invoked" lines go.
    $resumeOutcome = Resume-RememberedWeChatSession
    "resume outcome: $(@($resumeOutcome) -join ' | ')"
  }
  if ($attempt -eq 1 -or $attempt % 5 -eq 0) {
    "attempt $attempt : isolated-session weixin pids=$((Get-IsolatedWeixinPids) -join ',') readyz not ok"
  }
}

$titles = @(Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $isolatedSessionId } | ForEach-Object { "$($_.Id):$($_.MainWindowTitle)" })
"isolated-session weixin windows: $($titles -join ' | ')"
try {
  $final = Invoke-WebRequest -Uri $bridgeReadyz -TimeoutSec 5 -UseBasicParsing
  "readyz -> $($final.StatusCode) $($final.Content)"
} catch {
  "readyz -> ERR $($_.Exception.Message)"
}
"READY = $ready"
if (-not $ready) {
  "WeChat is running in session $isolatedSessionId but the bridge still cannot see a logged-in main chat window. If the login window asks for a QR code (not a remembered account), a human must scan it: Start-ScheduledTask -TaskName cwin-s1-rdp-show, scan, then -hide."
}
Stop-Transcript | Out-Null
