param([ValidateSet('show','hide','status')][string]$Mode = 'status')
$ErrorActionPreference = 'Continue'
# Machine bindings: dot-source the shared header instead of hardcoding the probe root.
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$out = Join-Path $root "rdp-client-$Mode-report.txt"
$o = New-Object System.Collections.Generic.List[string]
function L($m) { [void]$o.Add([string]$m) }

$HOLD = Join-Path $root 'rdp-client-hold.txt'
$OFF_X = 1930
$OFF_Y = 0
$ON_X = 0
$ON_Y = 0

$src = @"
using System; using System.Text; using System.Runtime.InteropServices;
public class RD {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static IntPtr Found = IntPtr.Zero;
  public static bool Cb(IntPtr h, IntPtr l) {
    StringBuilder c = new StringBuilder(300); GetClassNameW(h, c, 600);
    if (c.ToString().IndexOf("TscShell") >= 0) { Found = h; return false; }
    return true; }
  public static IntPtr Find() { Found = IntPtr.Zero; EnumWindows(new EnumProc(Cb), IntPtr.Zero); return Found; }
  public static string Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return (r.R-r.L) + "x" + (r.B-r.T) + "@" + r.L + "," + r.T + " visible=" + IsWindowVisible(h) + " iconic=" + IsIconic(h); }
  public static string Place(IntPtr h, int x, int y) {
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, hh = r.B - r.T;
    if (IsIconic(h)) ShowWindow(h, 4);            // SW_SHOWNOACTIVATE
    bool ok = SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0010 | 0x0040);   // NOACTIVATE | SHOWWINDOW
    System.Threading.Thread.Sleep(500);
    return "place(" + x + "," + y + ")=" + ok + " -> " + Rect(h); }
}
"@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue

L ("=== rdp-client " + $Mode + "  " + (Get-Date -Format 'HH:mm:ss') + " ===")
$h = [RD]::Find()
if ($h -eq [IntPtr]::Zero) { L '  未找到 RDP 客户端窗口（TscShellContainerClass）✗ —— 会话可能未连接'; ($o -join "`r`n") | Out-File $out -Encoding utf8; $o -join "`r`n"; exit 1 }
L ("  before: " + [RD]::Rect($h))

switch ($Mode) {
    'show' {
        Set-Content -Path $HOLD -Value ("hold " + (Get-Date -Format 's')) -Encoding utf8
        L ("  已放置暂停文件（保活不再挪走它）: " + $HOLD)
        L ("  " + [RD]::Place($h, $ON_X, $ON_Y))
    }
    'hide' {
        Remove-Item $HOLD -Force -ErrorAction SilentlyContinue
        L "  已移除暂停文件（保活恢复停靠）"
        L ("  " + [RD]::Place($h, $OFF_X, $OFF_Y))
    }
    default {
        L ("  暂停文件: " + (Test-Path $HOLD) + "   当前位置见上")
    }
}
$o -join "`r`n" | Out-File $out -Encoding utf8
$o -join "`r`n"

