import ctypes
import datetime
import os
import sys
import time
from ctypes import wintypes

PROBE_DIR = r"C:\ProgramData\cwin-probe\s4"
PROBE_SCRIPT = os.path.join(PROBE_DIR, "in", "keepalive-probe.ps1")
PROBE_OUT = os.path.join(PROBE_DIR, "keepalive-probe.txt")
LOG = r"D:\Projects\cyberboss\tmp\cwin-lab\rdp-keepalive.log"
HOLD_FILE = r"C:\ProgramData\cwin-probe\rdp-client-hold.txt"
# queue_probe() reports this when the session-side worker never picked the probe
# up; it is a queue failure, not a verdict on the client.
PROBE_UNAVAILABLE = "(no probe output)"

# The isolated session renders inside the RDP client window. WeFlow spawns a
# PowerShell (with conhost) roughly every 30s of its own accord, so anything the
# client displays is visible to the user - park the client off-screen instead of
# minimizing it (a minimized client loses the session's input desktop).
OFFSCREEN_X = 1930
OFFSCREEN_Y = 0
ONSCREEN_X = 0
ONSCREEN_Y = 0
SW_SHOWNOACTIVATE = 4
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040

user32 = ctypes.windll.user32


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


ENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def find_rdp_client():
    found = []

    def cb(hwnd, _):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, buf, 256)
        if "TscShell" in buf.value:
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(ENUMPROC(cb), 0)
    return found[0] if found else None


def park_client(force=False):
    """Keep the client un-minimized, and off the visible desktop unless held.

    A minimized client costs the session its input desktop - the probe then reads
    GetForegroundWindow()=0 and SetCursorPos()=False - so un-minimizing always
    happens, even while the operator hold file pins the on-screen position.  The
    hold file only decides *where* the window is put back: on-screen at 0,0 for an
    operator who wants to watch the session, off-screen at 1930,0 otherwise.

    An earlier version returned early whenever the hold file existed.  That left a
    minimized client minimized, every probe failed, and the keepalive answered by
    tearing down the connection: one reconnect every five minutes, each of which
    used to paint ~110 console windows over the user's desktop.
    """
    hwnd = find_rdp_client()
    if not hwnd:
        return "no RDP client window"
    hold = os.path.exists(HOLD_FILE)
    rect = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    iconic = bool(user32.IsIconic(hwnd))
    if iconic:
        # SW_SHOWNOACTIVATE restores a minimized window without stealing focus.
        user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
        time.sleep(0.4)
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
    if hold and not force:
        return "hold file present - %s" % (
            "restored a minimized client" if iconic else "leaving the client where it is")
    target_x, target_y = (ONSCREEN_X, ONSCREEN_Y) if hold else (OFFSCREEN_X, OFFSCREEN_Y)
    if rect.left == target_x and rect.top == target_y and not iconic:
        return "already placed at %d,%d" % (target_x, target_y)
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    ok = user32.SetWindowPos(hwnd, None, target_x, target_y, width, height,
                             SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
    time.sleep(0.4)
    return "placed=%s %d,%d from %dx%d@%d,%d" % (bool(ok), target_x, target_y,
                                                  width, height, rect.left, rect.top)


PROBE_BODY = r'''$ErrorActionPreference = 'Continue'
$src = @"
using System; using System.Text; using System.Runtime.InteropServices;
public class KA {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public static string Probe() {
    IntPtr f = GetForegroundWindow();
    StringBuilder c = new StringBuilder(300); GetClassNameW(f, c, 600);
    bool ok = SetCursorPos(300, 300);
    System.Threading.Thread.Sleep(200);
    POINT p; GetCursorPos(out p);
    return "fg=0x" + ((long)f).ToString("X") + " cls=" + c.ToString() + " setCursorPos=" + ok + " cursor=(" + p.X + "," + p.Y + ")";
  }
}
"@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue
[KA]::Probe() | Out-File 'C:\ProgramData\cwin-probe\s4\keepalive-probe.txt' -Encoding utf8
'''


def log(msg):
    line = datetime.datetime.now().strftime("%m-%d %H:%M:%S") + "  " + msg
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def queue_probe(timeout=75):
    try:
        os.remove(PROBE_OUT)
    except OSError:
        pass
    with open(PROBE_SCRIPT, "w", encoding="utf-8-sig") as fh:
        fh.write(PROBE_BODY)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(PROBE_OUT):
            time.sleep(0.3)
            with open(PROBE_OUT, encoding="utf-8") as fh:
                return fh.read().strip().lstrip("\ufeff")
        time.sleep(3)
    return "(no probe output)"


def run_task(name):
    """Start a scheduled task without spawning schtasks.exe.

    schtasks.exe is a console program, so every call makes Windows allocate a
    console; this host hands console creation to Windows Terminal and the user
    sees a terminal window pop up.  CREATE_NO_WINDOW softened but did not remove
    that, so the trigger now goes through the in-process Task Scheduler COM API.
    """
    try:
        import win32com.client
        service = win32com.client.Dispatch("Schedule.Service")
        service.Connect()
        task = service.GetFolder("\\").GetTask(name)
        task.Run("")
        return 0, "started via Schedule.Service"
    except Exception as exc:
        return 1, "Schedule.Service failed: %s" % exc


try:
    log("client: " + park_client())
except Exception as exc:  # never let parking break the probe
    log("client park failed: %s" % exc)

out = queue_probe()
log("probe: " + out)
if "setCursorPos=True" not in out:
    if out.strip() == PROBE_UNAVAILABLE:
        # The queue worker, not the session, is what failed here: the worker also
        # serves other automation (measured: a Quark Cloud Drive run held it for
        # minutes), and a probe that was never picked up says nothing about the
        # client.  Reconnecting cannot fix a busy worker, so leave the connection
        # alone and let the next beat retry.
        log("probe unavailable -> not reconnecting (shared queue worker busy)")
        sys.exit(2)
    # A dead input desktop usually means a displaced client window rather than a
    # dead connection, so re-assert the window and ask once more before tearing
    # the session down.  Reconnecting costs the session's automation ~2 minutes.
    try:
        log("client(re-assert): " + park_client(force=True))
    except Exception as exc:
        log("client re-assert failed: %s" % exc)
    time.sleep(3)
    out = queue_probe()
    log("probe(retry): " + out)
if "setCursorPos=True" in out:
    log("healthy")
    sys.exit(0)

log("unhealthy -> triggering RDP reconnect")
rc, detail = run_task("cwin-s1-rdp-reconnect")
log("reconnect trigger rc=%s %s" % (rc, detail[:80]))

time.sleep(130)
try:
    log("client: " + park_client())
except Exception as exc:
    log("client park failed: %s" % exc)
out2 = queue_probe()
log("after reconnect: " + out2)
log("recovered" if "setCursorPos=True" in out2 else "still unhealthy")
