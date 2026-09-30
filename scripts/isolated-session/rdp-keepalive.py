import ctypes
import datetime
import json
import os
import sys
import time
import urllib.request
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from machine_paths import HOLD_FILE as _HOLD, QUEUE_IN, SUSPEND_FILE as _SUSPEND, log_file  # noqa: E402

PROBE_DIR = str(QUEUE_IN.parent)
PROBE_SCRIPT = os.path.join(str(QUEUE_IN), "keepalive-probe.ps1")
PROBE_OUT = os.path.join(PROBE_DIR, "keepalive-probe.txt")
# The probe script is PowerShell source with this path baked in, so it needs
# PowerShell escaping (a lone backslash is an escape character there).
PROBE_OUT_PS = PROBE_OUT.replace("\\", "\\\\").replace("'", "''")
LOG = str(log_file("rdp-keepalive.log"))
HOLD_FILE = str(_HOLD)
# The remote-control guard parks this file while ToDesk/GameViewer is being
# controlled: the RDP client has to stay down so the remote tool binds to the
# console session (session 1) instead of the isolated one.  It is treated as
# "still wanted" only while it keeps being refreshed, so a guard that dies
# cannot keep the client down forever.
SUSPEND_FILE = str(_SUSPEND)
SUSPEND_FRESH_SECONDS = 600.0
# The bridge runs inside the isolated session, so it can answer the injectability
# question in-process; the shared file queue only serves as the fallback.
BRIDGE_PROBE_URL = "http://127.0.0.1:8776/api/probe"
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
[KA]::Probe() | Out-File '__PROBE_OUT__' -Encoding utf8
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
        fh.write(PROBE_BODY.replace("__PROBE_OUT__", PROBE_OUT_PS))
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(PROBE_OUT):
            time.sleep(0.3)
            with open(PROBE_OUT, encoding="utf-8") as fh:
                return fh.read().strip().lstrip("\ufeff")
        time.sleep(3)
    return "(no probe output)"


def suspend_active():
    """True while the remote-control guard wants the client to stay down.

    The guard refreshes this file every ~5s while a remote-control session is in
    progress.  Staleness is the whole point: if the guard dies, the file ages out
    and the keepalive goes back to its normal job of resurrecting the client.
    """
    try:
        age = time.time() - os.path.getmtime(SUSPEND_FILE)
    except OSError:
        return False
    return 0 <= age <= SUSPEND_FRESH_SECONDS


def http_probe(move=False):
    """Ask the isolated session's bridge whether input injection still works.

    The bridge answers from inside session 4 (see its /api/probe route), which
    makes this a dedicated channel: it cannot be delayed by other automation that
    shares the file queue.  Returns (verdict, text) with verdict None when the
    bridge could not be reached, so the caller can fall back to the queue.
    """
    url = BRIDGE_PROBE_URL + ("?move=1" if move else "")
    try:
        with urllib.request.urlopen(url, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        return None, "unreachable (%s)" % exc
    foreground = int(payload.get("foreground") or 0)
    moved = payload.get("movedCursor")
    text = "fg=0x%X cls=%s setCursorPos=%s cursor=%s" % (
        foreground, payload.get("className") or "", moved, payload.get("cursor"))
    return (foreground != 0 and moved is not False), text


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


def measure(move=False, label="http"):
    """Ask one channel for the session's input-desktop state.

    Returns (verdict, text) where True means injectable, False means measured
    broken and None means no measurement at all.  The bridge answers in-process
    over HTTP, so the healthy path never touches the shared file queue; the queue
    stays as the fallback for when the bridge itself is down.
    """
    if label == "http":
        verdict, text = http_probe(move=move)
        log("probe(http%s): %s" % (",strong" if move else "", text or "unreachable"))
        if verdict is not None:
            return verdict, text
    out = queue_probe()
    log("probe(queue): " + out)
    if out.strip() == PROBE_UNAVAILABLE:
        return None, out
    return ("setCursorPos=True" in out), out


verdict, out = measure()
if verdict is True:
    log("healthy")
    sys.exit(0)
if verdict is None:
    # Neither channel produced a measurement, so nothing is known about the
    # client: a busy queue or a dead bridge cannot be fixed by reconnecting, and
    # reconnecting would cost the session's automation for nothing.
    log("no probe measurement -> not reconnecting")
    sys.exit(2)

# A dead input desktop usually means a displaced client window rather than a dead
# connection, so re-assert the window and confirm with the stronger cursor test
# before tearing the session down.  Reconnecting costs ~2 minutes of automation.
log("unhealthy -> re-asserting the client window")
try:
    log("client(re-assert): " + park_client(force=True))
except Exception as exc:
    log("client re-assert failed: %s" % exc)
time.sleep(3)
verdict, out = measure(move=True)
if verdict is True:
    log("healthy after re-assert")
    sys.exit(0)
if verdict is None:
    log("no probe measurement after re-assert -> not reconnecting")
    sys.exit(2)

if suspend_active():
    # The remote-control guard owns the client right now: it took the client down
    # on purpose so the remote tool binds to the console session, and it will
    # bring the client back and trigger the reconnect when the session ends.
    # Reconnecting here would fight it (the remote tool would grab session 4
    # again mid-session) -- so stand down.
    log("remote-control suspend active -> not reconnecting (guard owns the client)")
    sys.exit(3)

log("unhealthy -> triggering RDP reconnect")
rc, detail = run_task("cwin-s1-rdp-reconnect")
log("reconnect trigger rc=%s %s" % (rc, detail[:80]))

time.sleep(130)
try:
    log("client: " + park_client())
except Exception as exc:
    log("client park failed: %s" % exc)
verdict, out = measure(move=True)
log("after reconnect: " + out)
log("recovered" if verdict is True else "still unhealthy")
