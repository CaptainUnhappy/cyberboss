$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'queue-root.ps1')
$out = Join-Path $root 's1-restack-report.txt'
$o = New-Object System.Collections.Generic.List[string]
function L($m) { [void]$o.Add([string]$m) }

$src = @"
using System; using System.Runtime.InteropServices;
public class AC {
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, out uint info, uint len, out uint ret);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr p, uint acc, out IntPtr tok);
  public static string IsAc() {
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out tok)) return "opentoken failed";
    uint isAc; uint ret;
    if (!GetTokenInformation(tok, 29, out isAc, 4, out ret)) return "getinfo failed";
    return "TokenIsAppContainer=" + isAc;
  }
}
"@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue

L ("=== 从任务上下文重启 Cyberboss 栈 " + (Get-Date -Format 'HH:mm:ss') + " ===")
L ("whoami=" + [Environment]::UserName + " session=" + (Get-Process -Id $PID).SessionId + " " + [AC]::IsAc())

# 1) 停掉现有（沙箱内启动的）栈
$targets = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match 'shared-start\.js' -or $_.CommandLine -match 'bin[\\/]cyberboss\.js'
})
foreach ($t in $targets) {
    try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop; L ("  killed node pid=" + $t.ProcessId) } catch { L ("  kill " + $t.ProcessId + " failed: " + $_.Exception.Message) }
}
$bps = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'weflow-uia-bridge' -and $_.CommandLine -notmatch '8776' })
foreach ($b in $bps) {
    try { Stop-Process -Id $b.ProcessId -Force -ErrorAction Stop; L ("  killed bridge pid=" + $b.ProcessId) } catch { L ("  kill bridge " + $b.ProcessId + " failed") }
}
Start-Sleep -Seconds 4

# 2) 以任务上下文（无沙箱）启动共享栈
$logDir = Join-Path $root 'stack'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$outL = Join-Path $logDir 'shared.out.log'
$errL = Join-Path $logDir 'shared.err.log'
Remove-Item $outL, $errL -Force -ErrorAction SilentlyContinue
$p = $nodeExe = if ($env:CYBERBOSS_NODE_EXE) { $env:CYBERBOSS_NODE_EXE } else { Join-Path ${env:ProgramFiles} 'nodejs\node.exe' }
$p = Start-Process -FilePath $nodeExe -ArgumentList 'scripts/shared-start.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $outL -RedirectStandardError $errL -PassThru
L ("  launcher pid=" + $p.Id)

Start-Sleep -Seconds 35
L "--- 现状 ---"
foreach ($port in 8766, 5031) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    L ("  port " + $port + " = " + $(if ($c) { "LISTEN pid=" + $c.OwningProcess } else { "free" }))
}
$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'shared-start\.js' -or $_.CommandLine -match 'bin[\\/]cyberboss\.js' })
foreach ($n in $nodes) { L ("  node pid=" + $n.ProcessId + " :: " + $n.CommandLine.Substring(0, [Math]::Min(60, $n.CommandLine.Length))) }
$bp = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'weflow-uia-bridge' })
foreach ($b in $bp) { L ("  bridge pid=" + $b.ProcessId) }
L "--- launcher stdout ---"
if (Test-Path $outL) { Get-Content $outL -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { L ("  " + $_) } }
L "--- launcher stderr ---"
if (Test-Path $errL) { $e = Get-Content $errL -Tail 10 -ErrorAction SilentlyContinue; if ($e) { $e | ForEach-Object { L ("  " + $_) } } }
L "--- 桥身份（应由任务上下文启动，无沙箱）---"
try {
    $q = Invoke-WebRequest -Uri 'http://127.0.0.1:8766/api/send-source' -TimeoutSec 10 -UseBasicParsing
    L ("  send-source -> " + $q.Content)
} catch { L ("  send-source err: " + $_.Exception.Message) }

$o -join "`r`n" | Out-File $out -Encoding utf8
$o -join "`r`n"

