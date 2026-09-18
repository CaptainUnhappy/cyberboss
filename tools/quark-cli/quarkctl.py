#!/usr/bin/env python
"""quarkctl - drive the Quark cloud-drive desktop client from a CLI.

Purpose
-------
The Quark client can only be driven through its GUI: it ships no CLI, no local
HTTP API, and no documented URL scheme for drive paths (only a file-association
handler that opens a share link in a viewer). So any automation has to talk to
its window. This tool wraps that in a scriptable CLI.

Where it runs
-------------
Inside the isolated RDP session (session 4) where the client runs as
``cwinprobe``, or from session 1 for the read-only subcommands
(``status``/``verify``/``windows``) - the client's ``User Data`` directory is
world-readable, so those work from either session.

Invocation from session 4
-------------------------
The session's ``python`` is the Microsoft Store stub; always use the real
interpreter: ``D:\\Tools\\miniconda3\\python.exe``. ``cmd/quarkctl.cmd`` does
that for you.

Subcommands
-----------
status          client window / foreground / picker / download-db / download dir
windows         top-level windows, flagging anything covering the client
close           post WM_CLOSE to matching windows (never steals focus)
shot            screenshot the session desktop to a PNG
pref            pin or clear the client's download directory (preference.json)
row             select a file row by index
click           click or hover at a client-relative point, report what changed
download        click the toolbar download button, report picker/task/db effects
keys            keyboard strategy: tab N times, then press a key
probe-keys      try candidate shortcuts on the selected row, one shot each
picker          inspect / drive the save-location dialog
verify          download dir + client task table state

Known limitation (measured 2026-09-18)
--------------------------------------
The client's **top action bar** (the ``下载 / 分享 / 复制 ...`` row that appears
after selecting a file) does not react to synthesized input: real-mouse
(SetCursorPos + mouse_event), window messages (PostMessage), hover, and ten
candidate keyboard shortcuts all produced no effect, while the same machinery
does drive the file list (row selection, context menus). The client's own task
table (``download.db``) confirms it: no download task is ever created.

So this CLI can reach the save-location dialog *if* the button is pressed by a
real pointer, and it can then inspect/drive that dialog. It cannot yet press
that button. Next attempt should be a Chromium accessibility tree
(``--force-renderer-accessibility`` at client launch) plus UIA Invoke, which
bypasses pointer synthesis entirely; ``probe-keys`` is already in place to
re-verify any shortcut that a future client version may add.
"""

import argparse
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("ki", KEYBDINPUT),
                ("pad1", ctypes.c_int), ("pad2", ctypes.c_int)]


INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

WM_CLOSE = 0x0010
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_MOUSEMOVE = 0x0200
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101

VK_TAB = 0x09
VK_RETURN = 0x0D
VK_ESCAPE = 0x1B
VK_SPACE = 0x20
VK_CONTROL = 0x11
VK_MENU = 0x12
VK_SHIFT = 0x10
VK_A = 0x41
VK_V = 0x56

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_MOVE = 0x0001


# ---------------------------------------------------------------- logging

def log(kind, **fields):
    parts = ["%s=%s" % (k, v) for k, v in fields.items()]
    print("%-9s %s" % (kind, " ".join(parts)))
    sys.stdout.flush()


# ---------------------------------------------------------------- win32 helpers

def window_text(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value


def class_name(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    user32.GetClassNameW(hwnd, buf, 512)
    return buf.value


def window_rect(hwnd):
    r = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return (r.left, r.top, r.right, r.bottom)


def client_origin(hwnd):
    p = POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(p))
    return (p.x, p.y)


def is_visible(hwnd):
    return bool(user32.IsWindowVisible(hwnd))


def pid_of(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def top_level_windows():
    out = []

    def cb(hwnd, _):
        out.append(hwnd)
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def client_pids():
    """Pids that own a visible top-level window whose title looks like the drive.

    The client is Chromium-based, so its window class (Chrome_WidgetWin_1) is
    shared with Chrome/Edge/Electron apps on the same desktop; matching on the
    class alone picks the wrong window. Titles are the reliable signal: the
    client's window is titled after the drive / a drive page.
    """
    markers = ("夸克", "网盘", "分享链接", "上传", "传输", "备份")
    pids = []
    for hwnd in top_level_windows():
        if not is_visible(hwnd):
            continue
        if not class_name(hwnd).startswith("Chrome_WidgetWin"):
            continue
        title = window_text(hwnd)
        if not title:
            continue
        if any(m in title for m in markers):
            pid = pid_of(hwnd)
            if pid not in pids:
                pids.append(pid)
    return pids


def main_window():
    """The client's main window: the largest visible titled window of its pid."""
    pids = client_pids()
    best_pid, best_hwnd, best_area = None, None, 0
    for hwnd in top_level_windows():
        if not is_visible(hwnd):
            continue
        pid = pid_of(hwnd)
        if pid not in pids:
            continue
        if not class_name(hwnd).startswith("Chrome_WidgetWin"):
            continue
        title = window_text(hwnd)
        if not title:
            continue
        l, t, r, b = window_rect(hwnd)
        area = max(0, r - l) * max(0, b - t)
        if area > best_area:
            best_pid, best_hwnd, best_area = pid, hwnd, area
    return best_pid, best_hwnd


def foreground():
    hwnd = user32.GetForegroundWindow()
    return hwnd, pid_of(hwnd) if hwnd else 0, class_name(hwnd) if hwnd else "", window_text(hwnd) if hwnd else ""


def activate(hwnd):
    fg = user32.GetForegroundWindow()
    fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    my_tid = kernel32.GetCurrentThreadId()
    t_tid = user32.GetWindowThreadProcessId(hwnd, None)
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    if fg_tid:
        user32.AttachThreadInput(my_tid, fg_tid, True)
    user32.AttachThreadInput(my_tid, t_tid, True)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)
    user32.AttachThreadInput(my_tid, t_tid, False)
    if fg_tid:
        user32.AttachThreadInput(my_tid, fg_tid, False)
    time.sleep(0.25)


def window_under(x, y):
    return user32.WindowFromPoint(POINT(int(x), int(y)))


def set_cursor(x, y):
    return bool(user32.SetCursorPos(int(x), int(y)))


def mouse_click(x, y, settle=0.25):
    if not set_cursor(x, y):
        return False
    time.sleep(settle)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.12)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(0.9)
    return True


def mouse_double_click(x, y, settle=0.25):
    """Two rapid down/up pairs - some list rows only open on a real dblclick."""
    if not set_cursor(x, y):
        return False
    time.sleep(settle)
    for _ in range(2):
        user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        time.sleep(0.04)
        user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        time.sleep(0.06)
    time.sleep(0.9)
    return True


def post_click(hwnd, x, y):
    lp = (int(y) << 16) | (int(x) & 0xFFFF)
    user32.PostMessageW(hwnd, WM_MOUSEMOVE, 0, lp)
    time.sleep(0.05)
    user32.PostMessageW(hwnd, WM_LBUTTONDOWN, 1, lp)
    time.sleep(0.08)
    user32.PostMessageW(hwnd, WM_LBUTTONUP, 0, lp)
    time.sleep(0.9)
    return True


def send_key(vk):
    arr = (INPUT * 2)()
    arr[0].type = INPUT_KEYBOARD
    arr[0].ki.wVk = vk
    arr[1].type = INPUT_KEYBOARD
    arr[1].ki.wVk = vk
    arr[1].ki.dwFlags = KEYEVENTF_KEYUP
    sent = user32.SendInput(2, arr, ctypes.sizeof(INPUT))
    time.sleep(0.3)
    return sent


def send_combo(mod, vk):
    arr = (INPUT * 4)()
    arr[0].type = INPUT_KEYBOARD
    arr[0].ki.wVk = mod
    arr[1].type = INPUT_KEYBOARD
    arr[1].ki.wVk = vk
    arr[2].type = INPUT_KEYBOARD
    arr[2].ki.wVk = vk
    arr[2].ki.dwFlags = KEYEVENTF_KEYUP
    arr[3].type = INPUT_KEYBOARD
    arr[3].ki.wVk = mod
    arr[3].ki.dwFlags = KEYEVENTF_KEYUP
    sent = user32.SendInput(4, arr, ctypes.sizeof(INPUT))
    time.sleep(0.4)
    return sent


def send_text(text):
    arr = (INPUT * (len(text) * 2))()
    for i, ch in enumerate(text):
        arr[2 * i].type = INPUT_KEYBOARD
        arr[2 * i].ki.wScan = ord(ch)
        arr[2 * i].ki.dwFlags = KEYEVENTF_UNICODE
        arr[2 * i + 1].type = INPUT_KEYBOARD
        arr[2 * i + 1].ki.wScan = ord(ch)
        arr[2 * i + 1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
    sent = user32.SendInput(len(arr), arr, ctypes.sizeof(INPUT))
    time.sleep(0.35)
    return sent


def set_clipboard(text):
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    if not user32.OpenClipboard(None):
        return False
    try:
        user32.EmptyClipboard()
        data = ctypes.create_unicode_buffer(text)
        size = ctypes.sizeof(data)
        kernel32.GlobalAlloc.restype = ctypes.c_void_p
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        if not handle:
            return False
        kernel32.GlobalLock.restype = ctypes.c_void_p
        ptr = kernel32.GlobalLock(ctypes.c_void_p(handle))
        ctypes.memmove(ptr, data, size)
        kernel32.GlobalUnlock(ctypes.c_void_p(handle))
        user32.SetClipboardData(CF_UNICODETEXT, ctypes.c_void_p(handle))
        return True
    finally:
        user32.CloseClipboard()


def screenshot(path):
    from ctypes import windll
    gdi32 = windll.gdi32
    width = user32.GetSystemMetrics(0)
    height = user32.GetSystemMetrics(1)
    hdc = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, width, height)
    gdi32.SelectObject(mem, bmp)
    SRCCOPY = 0x00CC0020
    gdi32.BitBlt(mem, 0, 0, width, height, hdc, 0, 0, SRCCOPY)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long),
                    ("biHeight", ctypes.c_long), ("biPlanes", wintypes.WORD),
                    ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                    ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD)]

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = width
    bi.biHeight = -height
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0
    stride = width * 4
    buf = ctypes.create_string_buffer(stride * height)
    gdi32.GetDIBits(mem, bmp, 0, height, buf, ctypes.byref(bi), 0)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(0, hdc)

    import struct
    import zlib

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = bytearray()
    for y in range(height):
        raw.append(0)
        row = buf[y * stride:(y + 1) * stride]
        for x in range(width):
            b, g, r = row[4 * x], row[4 * x + 1], row[4 * x + 2]
            raw += bytes((r, g, b))
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)
    return path


def find_dialog(title_contains):
    for hwnd in top_level_windows():
        if not is_visible(hwnd):
            continue
        if class_name(hwnd) != "#32770":
            continue
        if title_contains in window_text(hwnd):
            return hwnd
    return None


def dialog_children(hwnd):
    out = []

    def cb(h, _):
        out.append((h, class_name(h), window_text(h), window_rect(h)))
        return True

    cbptr = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(cb)
    user32.EnumChildWindows(hwnd, cbptr, 0)
    return out


# ---------------------------------------------------------------- client paths

def user_data_dir():
    return os.path.join(os.environ.get("LOCALAPPDATA", ""), "QuarkCloudDrive", "User Data")


def download_dir_default():
    return os.path.join(os.environ.get("USERPROFILE", ""), "Downloads")


def download_db_path():
    root = os.path.join(user_data_dir(), "persistence")
    if not os.path.isdir(root):
        return None
    for name in os.listdir(root):
        cand = os.path.join(root, name, "download.db")
        if os.path.isfile(cand):
            return cand
    return None


# ---------------------------------------------------------------- subcommands

def cmd_status(args):
    pid, hwnd = main_window()
    log("status", client_pid=pid, main_hwnd=hex(hwnd) if hwnd else None)
    if hwnd:
        log("window", rect=window_rect(hwnd), client_origin=client_origin(hwnd),
            title=window_text(hwnd), visible=is_visible(hwnd))
    fg_hwnd, fg_pid, fg_cls, fg_title = foreground()
    log("foreground", hwnd=hex(fg_hwnd) if fg_hwnd else None, pid=fg_pid,
        cls=fg_cls, title=fg_title[:40])
    dlg = find_dialog("选择文件")
    log("picker", present=bool(dlg), hwnd=hex(dlg) if dlg else None)
    db = download_db_path()
    if db:
        st = os.stat(db)
        log("download_db", path=db, size=st.st_size,
            mtime=time.strftime("%H:%M:%S", time.localtime(st.st_mtime)))
    d = download_dir_default()
    files = sorted(x for x in os.listdir(d) if x != "desktop.ini") if os.path.isdir(d) else []
    log("download_dir", path=d, entries=len(files), sample=",".join(files[:5]))
    return 0


def cmd_windows(args):
    pid, main = main_window()
    log("windows", client_pid=pid, main_hwnd=hex(main) if main else None)
    for hwnd in top_level_windows():
        if not is_visible(hwnd):
            continue
        title = window_text(hwnd)
        cls = class_name(hwnd)
        l, t, r, b = window_rect(hwnd)
        area = max(0, r - l) * max(0, b - t)
        if not title or area < args.min_area:
            continue
        flag = "CLIENT" if hwnd == main else ("COVER" if area > 100000 else "")
        log("window", hwnd=hex(hwnd), pid=pid_of(hwnd), rect=(l, t, r, b),
            cls=cls, title=title[:60], flag=flag)
    return 0


def cmd_close(args):
    if not args.cls and not args.title:
        log("close", ok=False, error="pass --cls and/or --title so nothing is closed by accident")
        return 1
    closed = []
    for hwnd in top_level_windows():
        if not is_visible(hwnd):
            continue
        title = window_text(hwnd)
        cls = class_name(hwnd)
        if args.cls and args.cls.lower() not in cls.lower():
            continue
        if args.title and args.title not in title:
            continue
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        closed.append("%s|%s" % (hex(hwnd), title[:40]))
    time.sleep(1.0)
    log("close", cls=args.cls, title=args.title, count=len(closed), windows=";".join(closed))
    return 0 if closed else 4


def cmd_shot(args):
    path = args.out if os.path.isabs(args.out) else os.path.join(os.getcwd(), args.out)
    screenshot(path)
    log("shot", path=path, size=os.path.getsize(path))
    return 0


def cmd_pref(args):
    pref = os.path.join(user_data_dir(), "preference.json")
    if not os.path.isfile(pref):
        log("pref", ok=False, error="preference.json not found")
        return 2
    with open(pref, "r", encoding="utf-8") as fh:
        raw = fh.read()
    backup = pref + ".quarkctl.bak"
    if not os.path.exists(backup):
        with open(backup, "w", encoding="utf-8") as fh:
            fh.write(raw)
    try:
        data = json.loads(raw)
    except Exception as exc:
        log("pref", ok=False, error="preference.json is not valid JSON: %s" % exc)
        return 2
    setting = data.setdefault("global:setting", {})
    pos = setting.setdefault("downloadPosition", {})
    if args.disable:
        pos["enable"] = False
        pos["lastSavePath"] = ""
    else:
        pos["enable"] = True
        pos["lastSavePath"] = args.dir
        pos["where"] = args.dir
    with open(pref, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    log("pref", ok=True, path=pref, enable=pos.get("enable"),
        where=pos.get("where"), lastSavePath=pos.get("lastSavePath"), backup=backup)
    return 0


def cmd_row(args):
    pid, hwnd = main_window()
    if not hwnd:
        log("row", ok=False, error="client window not found")
        return 2
    activate(hwnd)
    cx, cy = client_origin(hwnd)
    y = args.first_y + (args.index - 1) * args.row_height
    x = args.checkbox_x
    log("row", target_client=(x, y), target_screen=(cx + x, cy + y))
    mouse_click(cx + x, cy + y)
    if args.shot:
        screenshot(args.shot)
        log("shot", path=args.shot)
    return 0


def region_hash(bytes_blob, width, height, region):
    """Cheap content hash of a rectangular region of a raw BGRA frame."""
    import hashlib
    left, top, right, bottom = region
    h = hashlib.sha256()
    for y in range(max(0, top), min(height, bottom)):
        row = bytes_blob[y * width * 4:(y + 1) * width * 4]
        h.update(row[max(0, left) * 4:min(width, right) * 4])
    return h.hexdigest()[:16]


def grab_screen():
    """Raw BGRA frame of the session desktop plus its size."""
    from ctypes import windll
    gdi32 = windll.gdi32
    width = user32.GetSystemMetrics(0)
    height = user32.GetSystemMetrics(1)
    hdc = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, width, height)
    gdi32.SelectObject(mem, bmp)
    gdi32.BitBlt(mem, 0, 0, width, height, hdc, 0, 0, 0x00CC0020)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long),
                    ("biHeight", ctypes.c_long), ("biPlanes", wintypes.WORD),
                    ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                    ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD)]

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = width
    bi.biHeight = -height
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0
    stride = width * 4
    buf = ctypes.create_string_buffer(stride * height)
    gdi32.GetDIBits(mem, bmp, 0, height, buf, ctypes.byref(bi), 0)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(0, hdc)
    return buf.raw, width, height


def ensure_front(hwnd, tries=3):
    """Make sure `hwnd` owns the foreground before synthesizing a click.

    A synthesized click lands on whatever window is on top at that point. In
    this session a full-screen WeFlow window regularly sits above the client and
    silently swallows every click, which reads as "the app ignores my clicks".
    So: activate, verify, and only then click.
    """
    for i in range(1, tries + 1):
        fg = user32.GetForegroundWindow()
        if fg == hwnd:
            return True, "already-front", i
        activate(hwnd)
        time.sleep(0.3)
        if user32.GetForegroundWindow() == hwnd:
            return True, "activated", i
    top = window_under(*client_origin(hwnd))
    return False, "could not take the foreground; top window under the client origin is %s (%s)" % (
        hex(top) if top else None, class_name(top) if top else "?"), tries


def cmd_click(args):
    pid, hwnd = main_window()
    if not hwnd:
        log("click", ok=False, error="client window not found")
        return 2
    ok, how, tries = ensure_front(hwnd)
    log("front", ok=ok, how=how, tries=tries)
    if not ok and not args.force:
        log("click", ok=False, error="client is covered; refusing to click blind "
                                     "(pass --force to click anyway)")
        return 6
    cx, cy = client_origin(hwnd)
    sx, sy = cx + args.x, cy + args.y
    child = window_under(sx, sy)
    log("click", client=(args.x, args.y), screen=(sx, sy), hwnd=hex(hwnd),
        under=hex(child) if child else None, under_cls=class_name(child) if child else None)
    before = None
    if args.region:
        frame, w, h = grab_screen()
        before = region_hash(frame, w, h, tuple(args.region))
        log("click", region=args.region, hash_before=before)
    if args.hover:
        set_cursor(sx, sy)
        time.sleep(args.settle)
    else:
        if args.mode in ("mouse", "both"):
            if args.double:
                mouse_double_click(sx, sy)
            else:
                mouse_click(sx, sy)
            time.sleep(args.settle)
        if args.mode in ("message", "both") and child:
            p = POINT(args.x, args.y)
            user32.ScreenToClient(child, ctypes.byref(p))
            post_click(child, p.x, p.y)
            time.sleep(args.settle)
    if args.region:
        frame, w, h = grab_screen()
        after = region_hash(frame, w, h, tuple(args.region))
        log("click", hash_after=after, region_changed=(after != before))
    dlg = find_dialog("选择文件")
    log("click", done=True, picker=bool(dlg), picker_hwnd=hex(dlg) if dlg else None,
        foreground=foreground()[3][:40])
    if args.shot:
        screenshot(args.shot)
        log("shot", path=args.shot)
    return 0


def click_toolbar_download(hwnd, args, label):
    ok, how, tries = ensure_front(hwnd)
    log("front", label=label, ok=ok, how=how, tries=tries)
    if not ok and not args.force:
        return "covered", None
    cx, cy = client_origin(hwnd)
    sx, sy = cx + args.dl_x, cy + args.dl_y
    child = window_under(sx, sy)
    log("click", label=label, screen=(sx, sy), child=hex(child) if child else None,
        child_cls=class_name(child) if child else None, mode=args.mode)
    if args.mode in ("mouse", "both"):
        mouse_click(sx, sy)
        time.sleep(args.settle)
        dlg = find_dialog("选择文件")
        if dlg:
            return "picker", dlg
    if args.mode in ("message", "both") and child:
        p = POINT(args.dl_x, args.dl_y)
        user32.ScreenToClient(child, ctypes.byref(p))
        post_click(child, p.x, p.y)
        time.sleep(args.settle)
        dlg = find_dialog("选择文件")
        if dlg:
            return "picker", dlg
    return "nothing", None


def cmd_download(args):
    pid, hwnd = main_window()
    if not hwnd:
        log("download", ok=False, error="client window not found")
        return 2
    activate(hwnd)
    covers = [h for h in top_level_windows()
              if is_visible(h) and h != hwnd and pid_of(h) != pid
              and window_rect(h)[2] - window_rect(h)[0] > 800]
    if covers and not args.ignore_covers:
        log("download", warn="windows cover the client; consider 'close --cls ...' first",
            covers=";".join("%s|%s" % (hex(h), window_text(h)[:30]) for h in covers))
    db = download_db_path()
    before = os.stat(db).st_mtime if db else 0
    result, dlg = click_toolbar_download(hwnd, args, "attempt-1")
    log("download", attempt=1, result=result)
    if result == "covered":
        log("download", ok=False, error="the client is covered by another window; "
                                        "close it (see 'windows') or pass --force")
        return 6
    if result != "picker" and args.hard:
        result, dlg = click_toolbar_download(hwnd, args, "attempt-2")
        log("download", attempt=2, result=result)
    if result == "picker":
        log("download", ok=True, picker=hex(dlg), note="save dialog is up; run 'picker' next")
        return 0
    after = os.stat(db).st_mtime if db else 0
    if after != before:
        log("download", ok=True, note="client task table changed without a dialog")
        return 0
    log("download", ok=False, error="neither the save dialog nor a client task appeared")
    return 3


def cmd_keys(args):
    pid, hwnd = main_window()
    if not hwnd:
        log("keys", ok=False, error="client window not found")
        return 2
    activate(hwnd)
    dlg_before = find_dialog("选择文件")
    for i in range(1, args.tabs + 1):
        send_key(VK_TAB)
        if args.shot_each:
            path = "%s-tab%02d.png" % (args.shot_each, i)
            screenshot(path)
            log("keys", step=i, shot=path)
    if args.key == "enter":
        send_key(VK_RETURN)
    elif args.key == "space":
        send_key(VK_SPACE)
    elif args.key == "down":
        send_key(0x28)
    time.sleep(args.settle)
    dlg = find_dialog("选择文件")
    log("keys", tabs=args.tabs, key=args.key, picker_before=bool(dlg_before),
        picker_after=bool(dlg), picker_hwnd=hex(dlg) if dlg else None)
    if args.shot:
        screenshot(args.shot)
        log("shot", path=args.shot)
    return 0


def cmd_probe_keys(args):
    pid, hwnd = main_window()
    if not hwnd:
        log("probe", ok=False, error="client window not found")
        return 2
    db = download_db_path()
    dl = download_dir_default()

    def snapshot():
        m = os.stat(db).st_mtime if db else 0
        files = set(os.listdir(dl)) if os.path.isdir(dl) else set()
        return m, files

    candidates = [
        ("alt+d", (VK_MENU, 0x44)),
        ("alt+s", (VK_MENU, 0x53)),
        ("ctrl+d", (VK_CONTROL, 0x44)),
        ("ctrl+j", (VK_CONTROL, 0x4A)),
        ("ctrl+s", (VK_CONTROL, 0x53)),
        ("enter", (0, VK_RETURN)),
        ("shift+enter", (VK_SHIFT, VK_RETURN)),
        ("alt+enter", (VK_MENU, VK_RETURN)),
        ("space", (0, VK_SPACE)),
        ("f2", (0, 0x71)),
    ]
    if args.only:
        wanted = set(x.strip() for x in args.only.split(","))
        candidates = [c for c in candidates if c[0] in wanted]

    for label, (mod, key) in candidates:
        activate(hwnd)
        before_db, before_files = snapshot()
        if mod:
            send_combo(mod, key)
        else:
            send_key(key)
        time.sleep(args.settle)
        after_db, after_files = snapshot()
        dlg = find_dialog("选择文件")
        new_files = after_files - before_files
        path = None
        if args.shot_each:
            path = "%s-%s.png" % (args.shot_each, label.replace("+", "_"))
            screenshot(path)
        log("probe", combo=label, picker=bool(dlg), db_changed=(after_db != before_db),
            new_files=",".join(sorted(new_files)) or "-", shot=path)
        if dlg or after_db != before_db or new_files:
            log("probe", hit=label)
            return 0
    log("probe", hit=None, note="no candidate produced a visible effect")
    return 3


def cmd_picker(args):
    dlg = find_dialog("选择文件")
    if not dlg:
        log("picker", present=False)
        return 2
    kids = dialog_children(dlg)
    log("picker", present=True, hwnd=hex(dlg), title=window_text(dlg), children=len(kids))
    for h, cls, text, rect in kids[:24]:
        log("child", cls=cls, text=(text or "")[:24], rect=rect)
    if args.enter:
        send_key(VK_RETURN)
        time.sleep(1.5)
        log("picker", after_enter=not bool(find_dialog("选择文件")))
        return 0
    if args.dir:
        if not set_clipboard(args.dir):
            log("picker", warn="clipboard open failed")
        send_combo(VK_CONTROL, VK_A)
        send_combo(VK_CONTROL, VK_V)
        time.sleep(0.6)
        send_key(VK_RETURN)
        time.sleep(1.5)
        gone = not bool(find_dialog("选择文件"))
        log("picker", pasted=args.dir, closed=gone)
        return 0 if gone else 3
    return 0


def cmd_desktop(args):
    """Is the session desktop actually rendering?

    Background: the isolation keepalive probes GetForegroundWindow +
    SetCursorPos, and both can keep reporting healthy while the desktop renders
    nothing (client minimized). Any GUI automation on such a desktop is a no-op
    against a black screen, so every drive step should check this first.
    """
    frame, w, h = grab_screen()
    step = args.step
    total = 0
    bright = 0
    seen = set()
    for y in range(0, h, step):
        base = y * w * 4
        for x in range(0, w, step):
            off = base + x * 4
            b, g, r = frame[off], frame[off + 1], frame[off + 2]
            lum = (r * 299 + g * 587 + b * 114) // 1000
            total += 1
            if lum > args.threshold:
                bright += 1
            seen.add((r >> 4, g >> 4, b >> 4))
    ratio = bright / total if total else 0.0
    fg_hwnd, fg_pid, fg_cls, fg_title = foreground()
    log("desktop", size=(w, h), sampled=total, bright_ratio=round(ratio, 4),
        distinct_colors=len(seen), threshold=args.threshold)
    log("desktop", rendering=ratio > args.min_ratio,
        foreground=fg_title[:40] or "(none)", fg_cls=fg_cls)
    if args.out:
        screenshot(args.out)
        log("shot", path=args.out)
    return 0 if ratio > args.min_ratio else 5


def mouse_wheel(clicks, settle=0.4):
    """Scroll the client content (negative = down)."""
    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                    ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
                    ("time", ctypes.c_ulong), ("dwExtraInfo", ULONG_PTR)]

    class MINPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("mi", MOUSEINPUT),
                    ("pad1", ctypes.c_int), ("pad2", ctypes.c_int)]

    MOUSEEVENTF_WHEEL = 0x0800
    arr = (MINPUT * 1)()
    arr[0].type = 0
    arr[0].mi.dy = int(clicks * 120)
    arr[0].mi.dwFlags = MOUSEEVENTF_WHEEL
    sent = user32.SendInput(1, arr, ctypes.sizeof(MINPUT))
    time.sleep(settle)
    return sent


def cmd_wheel(args):
    pid, hwnd = main_window()
    if not hwnd:
        log("wheel", ok=False, error="client window not found")
        return 2
    ok, how, tries = ensure_front(hwnd)
    if not ok:
        log("wheel", ok=False, error="client is not in front")
        return 6
    cx, cy = client_origin(hwnd)
    set_cursor(cx + args.x, cy + args.y)
    time.sleep(0.3)
    sent = mouse_wheel(args.clicks)
    log("wheel", clicks=args.clicks, at=(args.x, args.y), sent=sent)
    if args.shot:
        screenshot(args.shot)
        log("shot", path=args.shot)
    return 0


def find_window_by_title(part):
    """Largest visible top-level window whose title contains `part`."""
    best, best_area = None, 0
    for hwnd in top_level_windows():
        if not is_visible(hwnd):
            continue
        if part not in window_text(hwnd):
            continue
        l, t, r, b = window_rect(hwnd)
        area = max(0, r - l) * max(0, b - t)
        if area > best_area:
            best, best_area = hwnd, area
    return best


def cmd_clickwin(args):
    """Click a client-relative point inside a *specific* client sub-window.

    The client's share dialog and action bar live in their own top-level windows
    inside the same process; clicking the main window at those coordinates is not
    always the same thing.
    """
    hwnd = None
    if args.hwnd:
        hwnd = int(args.hwnd, 16) if args.hwnd.lower().startswith("0x") else int(args.hwnd)
        if not user32.IsWindow(hwnd):
            log("clickwin", ok=False, error="hwnd %s is not a window" % args.hwnd)
            return 2
    else:
        hwnd = find_window_by_title(args.window)
    if not hwnd:
        log("clickwin", ok=False, error="no window with title containing %r" % args.window)
        return 2
    activate(hwnd)
    time.sleep(0.4)
    cx, cy = client_origin(hwnd)
    l, t, r, b = window_rect(hwnd)
    sx, sy = cx + args.x, cy + args.y
    child = window_under(sx, sy)
    log("clickwin", window=args.window, hwnd=hex(hwnd), rect=(l, t, r, b),
        client_origin=(cx, cy), target=(sx, sy),
        under=hex(child) if child else None, under_cls=class_name(child) if child else None)
    if args.hover:
        set_cursor(sx, sy)
        time.sleep(args.settle)
    else:
        if args.mode in ("mouse", "both"):
            mouse_click(sx, sy)
            time.sleep(args.settle)
        if args.mode in ("message", "both") and child:
            p = POINT(args.x, args.y)
            user32.ScreenToClient(child, ctypes.byref(p))
            post_click(child, p.x, p.y)
            time.sleep(args.settle)
    dlg = find_dialog("选择文件")
    log("clickwin", done=True, picker=bool(dlg), foreground=foreground()[3][:40])
    if args.shot:
        screenshot(args.shot)
        log("shot", path=args.shot)
    return 0


def cmd_restart(args):
    """Restart the client, optionally with a Chromium DevTools port.

    Rationale: synthetic input (mouse messages, PostMessage, keyboard, UIA) does
    not reach the client's in-page controls on this machine, but the client *is*
    Chromium. Launching it with --remote-debugging-port exposes the page to CDP,
    which lets us drive it by evaluating JavaScript instead of faking input.
    """
    exe = args.exe
    if not os.path.isfile(exe):
        log("restart", ok=False, error="client executable not found: %s" % exe)
        return 2
    # back up preference.json before touching the client
    pref = os.path.join(user_data_dir(), "preference.json")
    if os.path.isfile(pref):
        backup = pref + ".quarkctl.bak"
        if not os.path.exists(backup):
            try:
                with open(pref, "r", encoding="utf-8") as src, open(backup, "w", encoding="utf-8") as dst:
                    dst.write(src.read())
                log("restart", preference_backup=backup)
            except OSError as exc:
                log("restart", warn="preference backup failed: %s" % exc)

    killed = []
    rc = os.popen('tasklist /fi "imagename eq quark_cloud_drive.exe" /fo csv /nh').read()
    for line in rc.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[1].isdigit():
            killed.append(int(parts[1]))
    for pid in killed:
        os.system("taskkill /pid %d /f >nul 2>&1" % pid)
    log("restart", killed=killed)
    time.sleep(4)

    argv = [exe]
    if args.debug_port:
        argv.append("--remote-debugging-port=%d" % args.debug_port)
    if args.url:
        argv.append(args.url)
    os.spawnl(os.P_NOWAIT, exe, *argv)
    log("restart", launched=exe, extra=argv[1:])
    time.sleep(args.wait)
    pid, hwnd = main_window()
    log("restart", client_pid=pid, main_hwnd=hex(hwnd) if hwnd else None)
    return 0


def cmd_cdp(args):
    """Probe the Chromium DevTools endpoint and list page targets."""
    import json as _json
    import urllib.request

    url = "http://127.0.0.1:%d/json" % args.port
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            targets = _json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as exc:
        log("cdp", ok=False, port=args.port, error=str(exc))
        return 3
    log("cdp", ok=True, port=args.port, targets=len(targets))
    for t in targets:
        log("target", type=t.get("type"), title=(t.get("title") or "")[:40],
            url=(t.get("url") or "")[:60], ws=bool(t.get("webSocketDebuggerUrl")))
    return 0


def cmd_verify(args):
    db = download_db_path()
    if db:
        st = os.stat(db)
        with open(db, "rb") as fh:
            blob = fh.read()
        log("verify", db=db, bytes=len(blob),
            db_mtime=time.strftime("%H:%M:%S", time.localtime(st.st_mtime)),
            rows_hint=blob.count(b"download_task"))
    d = download_dir_default()
    if not os.path.isdir(d):
        log("verify", download_dir=d, exists=False)
        return 0
    entries = [x for x in sorted(os.listdir(d)) if x != "desktop.ini"]
    log("verify", download_dir=d, entries=len(entries))
    for name in entries:
        full = os.path.join(d, name)
        try:
            if os.path.isdir(full):
                # report real contents: a folder hides the whole download otherwise
                total = 0
                count = 0
                partial = 0
                for root, _dirs, files in os.walk(full):
                    for f in files:
                        fp = os.path.join(root, f)
                        try:
                            total += os.path.getsize(fp)
                        except OSError:
                            pass
                        count += 1
                        if f.endswith((".qkdownloading", ".part", ".tmp", ".crdownload")):
                            partial += 1
                log("verify", dir=name, files=count, bytes=total,
                    mib=round(total / 1048576.0, 1), partial=partial)
            else:
                log("verify", file=name, bytes=os.path.getsize(full),
                    mib=round(os.path.getsize(full) / 1048576.0, 1))
        except OSError as exc:
            log("verify", entry=name, error=str(exc))
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="quarkctl", description="drive the Quark desktop client")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("status", help="client window, foreground, picker, download state")
    s.set_defaults(func=cmd_status)

    s = sub.add_parser("windows", help="list top-level windows and flag anything covering the client")
    s.add_argument("--min-area", type=int, default=20000)
    s.set_defaults(func=cmd_windows)

    s = sub.add_parser("close", help="post WM_CLOSE to windows matching --cls/--title (no focus theft)")
    s.add_argument("--cls", default=None)
    s.add_argument("--title", default=None)
    s.set_defaults(func=cmd_close)

    s = sub.add_parser("shot", help="screenshot the session desktop")
    s.add_argument("--out", default="shot.png")
    s.set_defaults(func=cmd_shot)

    s = sub.add_parser("pref", help="pin or clear the client's download directory")
    s.add_argument("--dir", default=download_dir_default())
    s.add_argument("--disable", action="store_true")
    s.set_defaults(func=cmd_pref)

    s = sub.add_parser("row", help="select a file row by index")
    s.add_argument("--index", type=int, default=1)
    s.add_argument("--checkbox-x", type=int, default=70)
    s.add_argument("--first-y", type=int, default=249)
    s.add_argument("--row-height", type=int, default=44)
    s.add_argument("--shot", default=None)
    s.set_defaults(func=cmd_row)

    s = sub.add_parser("click", help="click/hover at a client-relative point")
    s.add_argument("--x", type=int, required=True)
    s.add_argument("--y", type=int, required=True)
    s.add_argument("--hover", action="store_true")
    s.add_argument("--double", action="store_true", help="send a double click instead of a single one")
    s.add_argument("--mode", choices=["mouse", "message", "both"], default="mouse")
    s.add_argument("--settle", type=float, default=2.5)
    s.add_argument("--region", type=int, nargs=4, metavar=("L", "T", "R", "B"),
                   help="screen region to hash before/after; use it to prove a click had an effect")
    s.add_argument("--force", action="store_true", help="click even if the client is covered")
    s.add_argument("--shot", default=None)
    s.set_defaults(func=cmd_click)

    s = sub.add_parser("download", help="click the toolbar download button and report the effect")
    s.add_argument("--dl-x", type=int, default=533)
    s.add_argument("--dl-y", type=int, default=172)
    s.add_argument("--settle", type=float, default=3.0)
    s.add_argument("--mode", choices=["mouse", "message", "both"], default="mouse")
    s.add_argument("--hard", action="store_true", help="retry once with the other layer")
    s.add_argument("--force", action="store_true", help="click even if the client is covered")
    s.add_argument("--ignore-covers", action="store_true")
    s.set_defaults(func=cmd_download)

    s = sub.add_parser("keys", help="keyboard strategy: tab N times then press a key")
    s.add_argument("--tabs", type=int, default=1)
    s.add_argument("--key", choices=["enter", "space", "down", "none"], default="enter")
    s.add_argument("--settle", type=float, default=2.0)
    s.add_argument("--shot", default=None)
    s.add_argument("--shot-each", default=None)
    s.set_defaults(func=cmd_keys)

    s = sub.add_parser("probe-keys", help="try candidate shortcuts on the selected row")
    s.add_argument("--only", default=None)
    s.add_argument("--settle", type=float, default=2.0)
    s.add_argument("--shot-each", default=None)
    s.set_defaults(func=cmd_probe_keys)

    s = sub.add_parser("picker", help="inspect / drive the save-location dialog")
    s.add_argument("--dir", default=None)
    s.add_argument("--enter", action="store_true")
    s.set_defaults(func=cmd_picker)

    s = sub.add_parser("desktop", help="check whether the session desktop renders (black-screen guard)")
    s.add_argument("--step", type=int, default=16)
    s.add_argument("--threshold", type=int, default=24)
    s.add_argument("--min-ratio", type=float, default=0.02)
    s.add_argument("--out", default=None)
    s.set_defaults(func=cmd_desktop)

    s = sub.add_parser("clickwin", help="click a client-relative point inside a named sub-window")
    s.add_argument("--window", default=None, help="substring of the target window's title (ASCII-safe)")
    s.add_argument("--hwnd", default=None, help="target window handle, decimal or 0x-hex (preferred: "
                                                "non-ASCII titles get mangled by the ANSI console)")
    s.add_argument("--x", type=int, required=True)
    s.add_argument("--y", type=int, required=True)
    s.add_argument("--hover", action="store_true")
    s.add_argument("--mode", choices=["mouse", "message", "both"], default="mouse")
    s.add_argument("--settle", type=float, default=2.5)
    s.add_argument("--shot", default=None)
    s.set_defaults(func=cmd_clickwin)

    s = sub.add_parser("wheel", help="scroll inside the client (negative clicks = scroll down)")
    s.add_argument("--clicks", type=int, default=-3)
    s.add_argument("--x", type=int, default=640)
    s.add_argument("--y", type=int, default=400)
    s.add_argument("--shot", default=None)
    s.set_defaults(func=cmd_wheel)

    s = sub.add_parser("restart", help="restart the client, optionally with a DevTools port")
    s.add_argument("--exe", default=r"D:\Tools\QuarkCloudDrive\quark_cloud_drive.exe")
    s.add_argument("--debug-port", type=int, default=0)
    s.add_argument("--url", default=None)
    s.add_argument("--wait", type=float, default=25.0)
    s.set_defaults(func=cmd_restart)

    s = sub.add_parser("cdp", help="probe the Chromium DevTools endpoint")
    s.add_argument("--port", type=int, default=9222)
    s.set_defaults(func=cmd_cdp)

    s = sub.add_parser("verify", help="download dir + client task table state")
    s.set_defaults(func=cmd_verify)

    return p


def main(argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 1
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
