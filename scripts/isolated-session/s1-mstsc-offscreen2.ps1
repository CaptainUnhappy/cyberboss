$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$out = Join-Path $root 's1-mstsc-offscreen2-report.txt'
$o = New-Object System.Collections.Generic.List[string]
function L($m) { [void]$o.Add([string]$m) }

$src = @"
using System; using System.Text; using System.Runtime.InteropServices;
public class OF2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public static IntPtr Found = IntPtr.Zero;
  public static bool Cb(IntPtr h, IntPtr l) {
    StringBuilder c = new StringBuilder(300); GetClassNameW(h, c, 600);
    if (c.ToString().IndexOf("TscShell") >= 0) { Found = h; return false; }
    return true; }
  public static IntPtr Find() { Found = IntPtr.Zero; EnumWindows(new EnumProc(Cb), IntPtr.Zero); return Found; }
  public static string Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return (r.R-r.L) + "x" + (r.B-r.T) + "@" + r.L + "," + r.T + " iconic=" + IsIconic(h) + " visible=" + IsWindowVisible(h); }
  public static string MoveOff(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, hh = r.B - r.T;
    ShowWindow(h, 9);   // un-minimize first, never minimize
    bool sp = SetWindowPos(h, IntPtr.Zero, 1930, 0, w, hh, 0x0010 | 0x0040);  // NOACTIVATE | SHOWWINDOW
    System.Threading.Thread.Sleep(700);
    return "moveOff=" + sp + " -> " + Rect(h); }
  public static string Restore(IntPtr h, int x, int y) {
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, hh = r.B - r.T;
    bool sp = SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0010 | 0x0040);
    System.Threading.Thread.Sleep(600);
    return "restore=" + sp + " -> " + Rect(h); }
}
"@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue

L ('=== mstsc 挪出屏幕外 ' + (Get-Date -Format 'HH:mm:ss') + ' ===')
$h = [OF2]::Find()
if ($h -eq [IntPtr]::Zero) { L '  未找到 TscShellContainerClass ✗' }
else {
    $before = [OF2]::Rect($h)
    L ('  before: ' + $before)
    L ('  ' + [OF2]::MoveOff($h))
    # 记住原位置，便于回滚
    $r = New-Object 'OF2+RECT'
    [void][OF2]::GetWindowRect($h, [ref]$r)
    L ('  (off-screen rect now ' + ($r.R - $r.L) + 'x' + ($r.B - $r.T) + '@' + $r.L + ',' + $r.T + ')')
}
$o -join "`r`n" | Out-File $out -Encoding utf8
$o -join "`r`n"

