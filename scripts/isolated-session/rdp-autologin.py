# rdp-autologin.py —— 自动完成 loopback RDP 登录：处理证书警告框 / 凭据框 / 错误框，并等待探针证据文件
import os, sys, time, ctypes, subprocess
from ctypes import wintypes
import win32gui, win32process, win32con
from PIL import Image

# ---- console-free process helpers -------------------------------------------------
# Task Scheduler starts this script through pythonw.exe, which owns no console.
# Every console-subsystem child (taskkill.exe, tasklist.exe) therefore makes
# Windows allocate a brand new console, and this host hands console creation to
# Windows Terminal: the user sees a terminal window appear and disappear.  The
# pid poll further down runs once per second for the whole deadline, so the
# tasklist.exe-per-iteration version painted the screen with ~110 popups per
# reconnect.  Process work therefore stays in-process through Toolhelp32.
TH32CS_SNAPPROCESS = 0x00000002
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
PROCESS_TERMINATE = 0x0001
kernel32 = ctypes.windll.kernel32


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD),
                ('th32DefaultHeapID', ctypes.POINTER(ctypes.c_ulong)),
                ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                ('th32ParentProcessID', wintypes.DWORD),
                ('pcPriClassBase', ctypes.c_long), ('dwFlags', wintypes.DWORD),
                ('szExeFile', ctypes.c_char * 260)]


def process_ids_by_name(name):
    """pids of a live image name, without spawning tasklist.exe."""
    target = name.lower()
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == INVALID_HANDLE_VALUE:
        return []
    pids = []
    try:
        entry = PROCESSENTRY32()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
        ok = kernel32.Process32First(snap, ctypes.byref(entry))
        while ok:
            if entry.szExeFile.decode('mbcs', 'replace').lower() == target:
                pids.append(int(entry.th32ProcessID))
            ok = kernel32.Process32Next(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return pids


def kill_by_name(name):
    """taskkill /F /IM equivalent, without spawning taskkill.exe."""
    killed = []
    for pid in process_ids_by_name(name):
        handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if not handle:
            continue
        try:
            if kernel32.TerminateProcess(handle, 1):
                killed.append(pid)
        finally:
            kernel32.CloseHandle(handle)
    return killed

RDP   = r'D:\Projects\cyberboss\tmp\session0-probe\connect-cwinprobe.rdp'
EV    = r'C:\ProgramData\cwin-probe\evidence-rdp.txt'
DN    = r'C:\ProgramData\cwin-probe\done-rdp.txt'
ER    = r'C:\ProgramData\cwin-probe\probe-error.txt'
LOGP  = r'D:\Projects\cyberboss\tmp\cwin-lab\rdp-autologin.log'
SHOT  = r'D:\Projects\cyberboss\tmp\cwin-lab\rdp-error.png'
PW    = 'CwinProbe#2026'
DEADLINE = float(sys.argv[1]) if len(sys.argv) > 1 else 130.0

buf = []
def L(m):
    line = '%s  %s' % (time.strftime('%H:%M:%S'), m)
    buf.append(line); print(line, flush=True)
    open(LOGP, 'w', encoding='utf-8').write('\n'.join(buf))

for f in (EV, DN, ER):
    try: os.remove(f)
    except OSError: pass
L('关闭旧客户端: %s' % (kill_by_name('mstsc.exe') or '无在跑的 mstsc'))
time.sleep(0.8)

class BMIH(ctypes.Structure):
    _fields_=[('biSize',wintypes.DWORD),('biWidth',wintypes.LONG),('biHeight',wintypes.LONG),('biPlanes',wintypes.WORD),('biBitCount',wintypes.WORD),('biCompression',wintypes.DWORD),('biSizeImage',wintypes.DWORD),('biXPelsPerMeter',wintypes.LONG),('biYPelsPerMeter',wintypes.LONG),('biClrUsed',wintypes.DWORD),('biClrImportant',wintypes.DWORD)]
user32 = ctypes.windll.user32; gdi32 = ctypes.windll.gdi32
def shot(hwnd, path):
    r = win32gui.GetWindowRect(hwnd); w = max(1,r[2]-r[0]); h = max(1,r[3]-r[1])
    hdc = user32.GetWindowDC(hwnd); mdc = gdi32.CreateCompatibleDC(hdc); bmp = gdi32.CreateCompatibleBitmap(hdc,w,h)
    gdi32.SelectObject(mdc,bmp); user32.PrintWindow(hwnd,mdc,2)
    bi = BMIH(); bi.biSize=ctypes.sizeof(BMIH); bi.biWidth=w; bi.biHeight=-h; bi.biPlanes=1; bi.biBitCount=32
    b = ctypes.create_string_buffer(w*h*4); gdi32.GetDIBits(mdc,bmp,0,h,b,ctypes.byref(bi),0)
    Image.frombuffer('RGBA',(w,h),b,'raw','BGRA',0,1).convert('RGB').save(path)
    gdi32.DeleteObject(bmp); gdi32.DeleteDC(mdc); user32.ReleaseDC(hwnd,hdc)

def mstsc_pids():
    # Was: tasklist.exe once per second.  That child process was the popup storm.
    return process_ids_by_name('mstsc.exe')

def dialogs(pids):
    found=[]
    def cb(hwnd,_):
        try:
            _,p = win32process.GetWindowThreadProcessId(hwnd)
            if p in pids and win32gui.IsWindowVisible(hwnd) and win32gui.GetClassName(hwnd)=='#32770':
                kids=[]
                def ccb(ch,_):
                    try:
                        cls=win32gui.GetClassName(ch); t=win32gui.GetWindowText(ch)
                        if cls in ('Button','Edit','Static','SysLink') and (t or cls=='Edit'): kids.append((ch,cls,t))
                    except Exception: pass
                    return True
                win32gui.EnumChildWindows(hwnd, ccb, None)
                found.append((p,hwnd,win32gui.GetWindowText(hwnd),kids))
        except Exception: pass
        return True
    win32gui.EnumWindows(cb,None)
    return found

si = subprocess.STARTUPINFO(); si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
si.wShowWindow = 1  # SW_SHOWNORMAL: a hidden/minimized client leaves the RDP session non-injectable
p = subprocess.Popen(['mstsc.exe', RDP], startupinfo=si)
L('启动 mstsc pid=%d' % p.pid)
t0 = time.time(); seen = {}; shot_done = False
while time.time() - t0 < DEADLINE:
    if os.path.exists(DN) or os.path.exists(ER):
        L('探针完成: done=%s err=%s' % (os.path.exists(DN), os.path.exists(ER))); break
    pids = mstsc_pids()
    if not pids:
        L('mstsc 已退出且无证据文件（连接失败）'); break
    for pid, hwnd, title, kids in dialogs(pids):
        key = (hwnd, title)
        btns = [(ch,t) for ch,cls,t in kids if cls=='Button']
        edits = [ch for ch,cls,t in kids if cls=='Edit']
        label = ' | '.join(t for _,_,t in kids if t)[:90]
        if key not in seen:
            seen[key] = time.time()
            L('对话框 hwnd=%d title=%r 控件=%s' % (hwnd, title, label))
        conn = [(ch,t) for ch,t in btns if ('连接' in t.replace('&','')) and '取消' not in t]
        ok   = [(ch,t) for ch,t in btns if ('确定' in t.replace('&','')) and '取消' not in t]
        canc = [(ch,t) for ch,t in btns if '取消' in t]
        if conn:
            win32gui.PostMessage(conn[0][0], win32con.BM_CLICK, 0, 0)
            L('  -> 点击 %r' % conn[0][1]); time.sleep(1.0)
        elif edits and ok:
            win32gui.SendMessage(edits[-1], win32con.WM_SETTEXT, 0, PW)
            for ch,t in [(c,t) for c,cl,t in kids if cl=='Button' and '记住' in t]:
                win32gui.SendMessage(ch, win32con.BM_SETCHECK, 1, 0)
            L('  -> 填入密码并点击 %r（凭据框）' % ok[0][1])
            win32gui.PostMessage(ok[0][0], win32con.BM_CLICK, 0, 0); time.sleep(1.0)
        elif ok and not canc:
            if not shot_done:
                shot(hwnd, SHOT); shot_done = True
                L('  !! 错误框（已截图 %s）控件文本: %s' % (SHOT, label))
            L('  -> 点击 %r 收尾' % ok[0][1])
            win32gui.PostMessage(ok[0][0], win32con.BM_CLICK, 0, 0); time.sleep(0.5)
    time.sleep(1.0)

for _ in range(20):
    if os.path.exists(DN) or os.path.exists(ER): break
    time.sleep(1.0)
L('结束: done=%s err=%s evidence=%s' % (os.path.exists(DN), os.path.exists(ER), os.path.exists(EV)))
