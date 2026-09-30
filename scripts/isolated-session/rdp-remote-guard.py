"""rdp-remote-guard.py -- 远控期间自动让出 RDP 客户端的守卫。

## 为什么需要它

隔离会话（RDPWrap + 回环 mstsc）要求**必须有一个已连接、未最小化的 RDP 客户端**，
否则隔离会话失去输入桌面，UIA 桥发不出消息。代价是机器上长期存在**第二个属于同一
账号的交互会话**（session 4）。

ToDesk / GameViewer 的被控端在选择投屏会话时会挑中那个 RDP 会话，于是远控进来的人
看到的是 RDP 通道里的画面、键鼠也被注入到那边（实测 ToDesk 日志：`Current session
ID: 4` 后紧跟 21 次 `SendInput fail err = 5` 与 `detectDesktopSourceUpdate screens
count 0`），必须手动关掉 RDP 客户端才恢复正常。

本脚本把"手动关"变成自动：**检测到远控会话在进行，就把 RDP 客户端停掉并按住不让
保活把它拉回来；远控结束再放行并重连。**

## 检测信号（实测于 2026-09-20）

远控会话进行中时，远控工具自己的会话日志会持续增长；空闲时静止。一次 20 秒采样：

    +102584  D:\\Program Files\\ToDesk\\Logs\\sessionWEBRTC_*.xlog
    +303     D:\\Program Files\\ToDesk\\Logs\\session*_2026_09_20.log
    +74      %LOCALAPPDATA%\\ToDesk\\Logs\\client*_2026_09_20.log
    （GameViewer 的 server\\log\\*.slog 同样在被控时增长）

所以判定 = "当拍有新字节 + mtime 新鲜"，两个条件都满足才算远控在场，避免把陈旧的
日志文件误判成活跃会话（本机存在 2045 年的假时间戳文件）。

## 硬约束（照抄部署契约）

**不得 spawn 控制台子系统子进程**（tasklist/taskkill/schtasks/cmd...）：本机把创建
控制台交给 Windows Terminal，每次 spawn 都会在用户桌面冒出终端窗口。因此进程枚举
走 Toolhelp32、终止走 TerminateProcess、启动计划任务走 Schedule.Service COM。
本脚本只 import win32com.client（可选）——不再引入别的依赖。

## 状态机（"让一次路"模型，2026-09-20 按用户实测改版）

    idle   --(远控日志开始增长 且 mstsc 在跑)-->  yield   杀掉 mstsc，开始让出窗口
    yield  --(窗口未到)-->                        yield   保持（保活被 suspend 信号挡住）
    yield  --(窗口到期 RESTART_AFTER_SECONDS)-->  idle    触发重连，把 RDP 拉回来
    yield  --(mstsc 已被别人拉回)-->              idle    窗口提前结束

**为什么不是"按住到远控结束"**：用户实测（2026-09-20）——ToDesk 连上后手动重开 RDP，
主桌面照常可用，即**远控与 RDP 可以共存**。所以守卫只需要在"连接那一刻"让一次路，
让远控工具从 session 4 改绑到 session 1（实测 ~4-8s），随后就该把 RDP 还回去；
"按住整个远控期间"会让机器人整段时间发不出消息，是过度设计。
"""
import argparse
import ctypes
import datetime
import json
import os
import re
import sys
import time
from ctypes import wintypes

# ---------------------------------------------------------------- paths / knobs
# Machine bindings come from machine_paths.py (environment first, then the
# historical defaults) so this resident guard works from a moved checkout.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from machine_paths import HOLD_FILE, LOG_DIR, QUEUE_ROOT, REMOTE_LOG_DIRS, SUSPEND_FILE  # noqa: E402

# 为什么不复用 HOLD_FILE：那是运维/保活共用的"窗口摆位"开关（操作员 -show 也会写它），
# 拿它当"禁止重连"会让操作员看会话桌面时把 RDP 客户端永久挡在门外。
# SUSPEND_FILE 才是远控期间真正的"按住"信号：保活脚本看到它既存在又新鲜时不触发重连。
LOG = str(LOG_DIR / "rdp-remote-guard.log")
STATE = str(QUEUE_ROOT / "rdp-remote-guard.state.json")
ONCE_REPORT = str(QUEUE_ROOT / "rdp-remote-guard-once.json")
BRIDGE_PROBE_URL = "http://127.0.0.1:8776/api/probe"

# 被让出的对象：回环 RDP 客户端
TARGET_PROCESS = "mstsc.exe"
TARGET_WINDOW_CLASS = "TscShell"
RECONNECT_TASK = "cwin-s1-rdp-reconnect"

# 一次脉冲内部轮询多久、间隔多少（计划任务每 2 分钟拉起一次本进程）
LOOP_SECONDS = 100.0
POLL_SECONDS = 5.0

# 远控在场判定
GROWTH_GRACE_SECONDS = 25.0     # 最近一次看到增长后，这么久内仍算在场（会话日志约 10s 一行）
CONFIRM_POLLS = 2               # 连续两拍都判定在场才动手（防抖）
FRESH_MTIME_SECONDS = 90.0      # 已废弃：mtime 新鲜度会误判，保留只为兼容旧命令行

# 让出窗口：杀掉客户端后等这么久再把 RDP 拉回来。
# 窗口内远控工具会从 session 4 改绑到 session 1（实测 ~4-8s），改绑完成后 RDP 与
# 远控可以**共存**（2026-09-20 用户手动实验：杀 RDP → 手动重开 → 主桌面正常）。
# 所以守卫的职责不是"整个远控期间按住"，而是"连接那一刻让一次路，然后把 RDP 还回去"。
# 60s → 25s（2026-09-20 提速）：改绑只要 4-8s，窗口留 25s 已经三倍余量；真正的防抢回
# 由 `await_remote_end` 门槛负责，不再依赖"窗口够长"。
RESTART_AFTER_SECONDS = 25.0

# 让路之后必须等到"这次远控真的结束"（日志停止增长）才允许再次让路。
# 没有这道门槛会形成回环：重开 RDP 后 mstsc 又出现、远控日志仍在增长 → 被当成新连接
# 再杀一次 → 每 RESTART_AFTER_SECONDS 掐一次 RDP（2026-09-20 实测复现）。
# 另加一个最小间隔做兜底，防止其他形态的抖动。
MIN_SECONDS_BETWEEN_YIELDS = 300.0

MIN_HOLD_SECONDS = 45.0         # 已废弃：见 RESTART_AFTER_SECONDS（旧的"按住到远控结束"模型）
MAX_HOLD_SECONDS = 6 * 3600.0   # 已废弃：同上

# 仅测试用：只走状态机与暂停文件，不真的终止目标进程
DRY_RUN = False
# 仅测试用：让出窗口结束后不主动重开 RDP（交给保活 5 分钟节拍兜底）
NO_RESTART = False

# 只看**被控会话**日志，而且只认已实证"仅在被控期间增长"的文件。四个坑都踩过：
#   1. `GameViewer\log\client\Log\*.slog` 是 GUI 常驻日志，客户端开着就一直写。
#   2. `GameViewer\log\server\log\log_*.slog` / `streamer_log_controlled_*.slog` 在
#      GUI 本地运行（连自己的 streamer）时也写，实测空闲 +320B/15s。
#   3. `ToDesk\Logs\service*_<日期>.log` 是服务日志，本地 GUI 活动就会写。
#   4. `GameViewer\...\connection_log_controlled_*.slog` 看着像"被控会话"，实测在
#      **没有远控**时也持续增长（+6110B/20s）——它是当前本地流会话的日志。
# 因此目前只保留 ToDesk 的 `session*`：实测只在被控期间增长（远控时 ~10s/行）。
# **UU远程（= GameViewer）目前没有可信的会话级信号 → 让它漏判**（回退到手动关 RDP），
# 因为误判会永久按住 RDP，代价比漏判大得多。找到 UU 的可信信号后再加回来。
# 日志目录是"每台机器的事实"，所以可配置：REMOTE_LOG_DIRS 的第一个存在项生效。
REMOTE_LOG_RULES = [
    (str(d), r"(?i)^session.*\.(log|xlog)$") for d in REMOTE_LOG_DIRS
]

# 名字级别的强信号：只认**刚启动**的实例（本机常驻服务/常驻被控端不算）
ACTIVE_PROC_PATTERNS = [
    r"(?i)^ToDesk\.exe$",           # 远控连接到来时由 ToDesk_Service 按会话拉起
    r"(?i)^GameViewerServer\.exe$",  # 由 GameViewerService 拉起
]
YOUNG_PROC_SECONDS = 7200.0     # 进程年龄阈值：超过就当常驻，不构成"远控在场"

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


def log(msg, path=None):
    line = datetime.datetime.now().strftime("%m-%d %H:%M:%S") + "  " + msg
    try:
        with open(path or LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


# ------------------------------------------------------------------- processes
def procs():
    """[(pid, ppid, name)] via Toolhelp32 -- never spawns tasklist.exe."""
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == INVALID_HANDLE_VALUE:
        return []
    out = []
    try:
        entry = PROCESSENTRY32()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
        ok = kernel32.Process32First(snap, ctypes.byref(entry))
        while ok:
            out.append((int(entry.th32ProcessID), int(entry.th32ParentProcessID),
                        entry.szExeFile.decode('mbcs', 'replace')))
            ok = kernel32.Process32Next(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return out


def pids_of(name, snapshot=None):
    target = name.lower()
    return [p for p, _pp, n in (snapshot or procs()) if n.lower() == target]


def pid_of_class(needle):
    """pid owning the first visible top-level window whose class contains needle."""
    user32 = ctypes.windll.user32

    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    found = []

    def cb(hwnd, _):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, buf, 256)
        if needle in buf.value:
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            found.append((int(pid.value), hwnd))
            return False
        return True

    user32.EnumWindows(ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(cb), 0)
    return found


def kill_pid(pid):
    """TerminateProcess -- taskkill.exe would pop a console window."""
    handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
    if not handle:
        return False
    try:
        return bool(kernel32.TerminateProcess(handle, 1))
    finally:
        kernel32.CloseHandle(handle)


# ------------------------------------------------------------------- detection
def scan_logs():
    """{path: size} for every file matched by REMOTE_LOG_RULES (session-level only)."""
    sizes = {}
    for root, pattern in REMOTE_LOG_RULES:
        if not root or not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root, onerror=lambda e: None):
            for name in files:
                if not re.search(pattern, name):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    sizes[path] = os.path.getsize(path)
                except OSError:
                    continue
    return sizes


def fresh_logs(sizes):
    """已废弃：仅保留给排障脚本引用，判定不再使用（见 remote_session_present）。"""
    now = time.time()
    fresh = []
    for path in sizes:
        try:
            age = now - os.path.getmtime(path)
        except OSError:
            continue
        if 0 <= age <= FRESH_MTIME_SECONDS:
            fresh.append(path)
    return fresh


def remote_session_present(before, now_ts, last_growth, snapshot):
    """返回 (bool, 证据字符串)。

    判定只靠**会话日志的字节增长**。曾经还有一个"mtime 新鲜"的弱信号，实测会误判：
    GameViewer 的 server 日志在会话结束后仍被写（10:49 还在增长，而当时没有远控），
    于是守卫一直认为远控在场。增长是没有歧义的——空闲采样实测 0 个文件增长。
    """
    sizes = scan_logs()
    grew = [p for p, size in sizes.items() if before.get(p) != size]
    if grew:
        for path in grew:
            last_growth[path] = now_ts
    still = [p for p, ts in last_growth.items() if now_ts - ts <= GROWTH_GRACE_SECONDS]
    young = young_active_procs(snapshot, YOUNG_PROC_SECONDS)

    evidence = []
    if still:
        evidence.append("log growth: " + ", ".join(sorted(os.path.basename(p) for p in still)[:4]))
    if young:
        evidence.append("young procs: " + ", ".join("%s(pid=%d)" % (n, p) for p, n in young[:4]))
    if not evidence:
        stale = [n for _p, _pp, n in snapshot
                 if any(re.search(pat, n) for pat in ACTIVE_PROC_PATTERNS)]
        if stale:
            evidence.append("stale resident procs only: " + ", ".join(sorted(set(stale))[:4]))
    return bool(still or young), " | ".join(evidence) or "no remote-control signal"


def young_active_procs(snapshot, max_age_seconds):
    """名字命中且**刚启动**的远控进程 pid。

    `ToDesk.exe` 在本机空闲时也常驻（9-16 起就有一个），只看名字会让守卫永远认为
    远控在场、永远放不开 RDP；所以只认"年龄小于阈值"的实例——被控端进程是远控连接
    到来时才由服务拉起的。进程创建时间走 GetProcessTimes，不 spawn 任何子进程。"""
    if max_age_seconds <= 0:
        return []
    cutoff = time.time() - max_age_seconds
    young = []
    for name in ("todesk.exe", "gameviewerserver.exe"):
        for pid in pids_of(name, snapshot):
            handle = kernel32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                continue
            try:
                creation = wintypes.FILETIME()
                exit_t = wintypes.FILETIME()
                kernel_t = wintypes.FILETIME()
                user_t = wintypes.FILETIME()
                ok = kernel32.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_t),
                                              ctypes.byref(kernel_t), ctypes.byref(user_t))
                if not ok:
                    continue
                ticks = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
                started = ticks / 1e7 - 11644473600.0           # FILETIME -> unix epoch
                if started >= cutoff:
                    young.append((pid, name))
            finally:
                kernel32.CloseHandle(handle)
    return young


# --------------------------------------------------------------- task launcher
def run_task(name):
    """Schedule.Service COM -- schtasks.exe would pop a console window."""
    try:
        import win32com.client
    except ImportError as exc:
        return 1, "win32com unavailable: %s" % exc
    try:
        service = win32com.client.Dispatch("Schedule.Service")
        service.Connect()
        task = service.GetFolder("\\").GetTask(name)
        task.Run("")
        return 0, "started via Schedule.Service"
    except Exception as exc:
        return 1, "Schedule.Service failed: %s" % exc


# ------------------------------------------------------------------- the guard
def touch_suspend(reason):
    """刷新"让出窗口"信号，保活按新鲜度识别它、在窗口内不抢着重连。

    窗口只有 RESTART_AFTER_SECONDS 秒，由守卫自己主动重开；这个文件只是防"守卫在
    窗口里死掉"——过期（600s）后保活恢复自愈。
    """
    try:
        with open(SUSPEND_FILE, "w", encoding="utf-8") as fh:
            fh.write("remote-guard yield %s  %s\n"
                     % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), reason))
    except OSError as exc:
        log("suspend write failed: %s" % exc)


def clear_suspend():
    try:
        os.remove(SUSPEND_FILE)
    except OSError:
        pass


def restore_rdp(state, evidence):
    """让出窗口结束：把 RDP 客户端拉回来，守卫回到空闲。"""
    if NO_RESTART:
        log("yield window over -> restart suppressed (--no-restart)")
    else:
        rc, detail = run_task(RECONNECT_TASK)
        log("yield window over -> restoring RDP: rc=%s %s" % (rc, detail[:80]))
    close_yield_window(state, evidence, await_remote_end=True)


def hold_age(state, now_ts):
    started = state.get("hold_started")
    return (now_ts - started) if started else 0.0


def close_yield_window(state, reason, await_remote_end=None):
    """让出窗口收尾：清信号与窗口状态，回到空闲。

    `await_remote_end=True` 表示"这次远控已经让过路，等它结束后才允许再让"——
    `restore_rdp` 必须传 True，否则重开 RDP 会被当成新连接再杀一次（会形成回环）。
    """
    clear_suspend()
    state["hold_started"] = None
    state["restart_due_at"] = None
    state["killed_pids"] = []
    state["restore_evidence"] = reason
    if await_remote_end is not None:
        state["await_remote_end"] = await_remote_end
    write_state(state)


def write_state(state):
    try:
        tmp = STATE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, STATE)
    except OSError as exc:
        log("state write failed: %s" % exc)


def engage(now_ts, state, evidence):
    """远控刚连上：杀掉 RDP 客户端让路，窗口结束后由守卫自己把它拉回来。"""
    windows = pid_of_class(TARGET_WINDOW_CLASS)
    targets = [pid for pid, _hwnd in windows] or pids_of(TARGET_PROCESS)
    if DRY_RUN:
        killed = []
        log("DRY RUN: would terminate %s pids=%s (%s)" % (TARGET_PROCESS, targets, evidence))
    else:
        killed = [pid for pid in targets if kill_pid(pid)]
    state["hold_started"] = now_ts
    state["restart_due_at"] = now_ts + RESTART_AFTER_SECONDS
    state["last_yield_at"] = now_ts
    # 本次远控已经让过路：必须等它结束后才允许再让（见 MIN_SECONDS_BETWEEN_YIELDS 注释）
    state["await_remote_end"] = True
    state["killed_pids"] = killed
    state["engage_evidence"] = evidence
    log("REMOTE CONNECT -> yielding: killed %s pids=%s; will restore RDP in %.0fs (%s)"
        % (TARGET_PROCESS, killed or "none", RESTART_AFTER_SECONDS, evidence))
    write_state(state)


def trace(path, msg):
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("%s  %s\n" % (datetime.datetime.now().strftime("%H:%M:%S"), msg))
    except OSError:
        pass


def list_candidates(sample_seconds=15.0):
    """排障用：列出当前纳入监视的会话日志，并采样看谁在增长。

    误判过两次（把常驻的客户端/服务日志当成远控在场），所以留这个自检入口：
    空闲时这里必须是 `growing while idle: 0`。
    """
    before = scan_logs()
    print("candidate session logs: %d" % len(before))
    for path in sorted(before):
        print("  %10d  %s" % (before[path], path))
    print("sampling %.0fs ..." % sample_seconds)
    time.sleep(sample_seconds)
    after = scan_logs()
    grew = {p: after[p] - sz for p, sz in before.items() if p in after and after[p] != sz}
    print("growing while idle: %d" % len(grew))
    for path, delta in sorted(grew.items(), key=lambda kv: -kv[1]):
        print("  +%-8d %s" % (delta, path))
    return grew


def once(write=True):
    """单次判定，干跑用：不杀进程、不写暂停文件。"""
    snapshot = procs()
    before = scan_logs()
    time.sleep(12)
    last_growth = {}
    present, evidence = remote_session_present(before, time.time(), last_growth, snapshot)
    mstsc = pids_of(TARGET_PROCESS, snapshot)
    hold = os.path.exists(HOLD_FILE)
    report = {
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "remote_present": present,
        "evidence": evidence,
        "target_pids": mstsc,
        "hold_file": hold,
        "log_candidates": len(before),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if write:
        try:
            with open(ONCE_REPORT, "w", encoding="utf-8") as fh:
                json.dump(report, fh, ensure_ascii=False, indent=2)
        except OSError:
            pass
    return report


def main():
    global HOLD_FILE, SUSPEND_FILE, LOG, STATE, ONCE_REPORT, TARGET_PROCESS, \
        TARGET_WINDOW_CLASS, LOOP_SECONDS, POLL_SECONDS, RESTART_AFTER_SECONDS, \
        FRESH_MTIME_SECONDS, GROWTH_GRACE_SECONDS, CONFIRM_POLLS, DRY_RUN, NO_RESTART

    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="single dry-run report, no action")
    parser.add_argument("--list-candidates", action="store_true",
                        help="列出纳入监视的会话日志并采样看谁在增长（排误判用）")
    parser.add_argument("--loop-seconds", type=float, default=LOOP_SECONDS,
                        help="一次脉冲跑多久；<=0 表示常驻不退出（登录任务用）")
    parser.add_argument("--poll-seconds", type=float, default=POLL_SECONDS)
    parser.add_argument("--trace-file", default="",
                        help="每次轮询的判定轨迹写到该文件（排障用；仅默认路径生效）")
    # 下方开关只服务于"在沙箱/测试环境里验证状态机"：默认值即生产行为。
    parser.add_argument("--hold-file", default="")
    parser.add_argument("--log-file", default="")
    parser.add_argument("--state-file", default="")
    parser.add_argument("--once-report", default="")
    parser.add_argument("--target-process", default=TARGET_PROCESS,
                        help="要停掉的 RDP 客户端进程名（默认 mstsc.exe）")
    parser.add_argument("--target-window-class", default=TARGET_WINDOW_CLASS,
                        help="RDP 客户端窗口类片段（默认 TscShell）")
    parser.add_argument("--confirm-polls", type=int, default=CONFIRM_POLLS,
                        help="连续多少拍判定在场才动手（防抖）")
    parser.add_argument("--restart-after-seconds", type=float, default=RESTART_AFTER_SECONDS,
                        help="让出窗口长度：杀掉客户端后等这么久再把 RDP 拉回来")
    parser.add_argument("--no-restart", action="store_true",
                        help="只让路、不主动重开（等保活 5 分钟节拍兜底；测试用）")
    parser.add_argument("--dry-run", action="store_true",
                        help="只做状态机与标记文件，不真的终止目标进程")
    parser.add_argument("--growth-grace-seconds", type=float, default=GROWTH_GRACE_SECONDS,
                        help="最近一次看到日志增长后仍算在场的秒数")
    parser.add_argument("--fresh-mtime-seconds", type=float, default=FRESH_MTIME_SECONDS,
                        help="已废弃（mtime 新鲜度会误判，见 remote_session_present 注释）")
    parser.add_argument("--paths-dir", default="",
                        help="把暂停文件/suspend/日志/状态/干跑报告整体改到该目录（沙箱自测用）")
    args = parser.parse_args()

    DRY_RUN = args.dry_run
    GROWTH_GRACE_SECONDS = args.growth_grace_seconds
    FRESH_MTIME_SECONDS = args.fresh_mtime_seconds

    if args.paths_dir:
        HOLD_FILE = os.path.join(args.paths_dir, "rdp-client-hold.txt")
        SUSPEND_FILE = os.path.join(args.paths_dir, "rdp-client-suspend.txt")
        LOG = os.path.join(args.paths_dir, "rdp-remote-guard.log")
        STATE = os.path.join(args.paths_dir, "rdp-remote-guard.state.json")
        ONCE_REPORT = os.path.join(args.paths_dir, "rdp-remote-guard-once.json")

    HOLD_FILE = args.hold_file or HOLD_FILE
    LOG = args.log_file or LOG
    STATE = args.state_file or STATE
    ONCE_REPORT = args.once_report or ONCE_REPORT
    TARGET_PROCESS = args.target_process
    TARGET_WINDOW_CLASS = args.target_window_class
    RESTART_AFTER_SECONDS = args.restart_after_seconds
    NO_RESTART = args.no_restart
    CONFIRM_POLLS = max(1, args.confirm_polls)

    if args.list_candidates:
        list_candidates()
        return 0
    if args.once:
        once()
        return 0

    state = {}
    try:
        with open(STATE, encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        state = {}

    # loop_seconds <= 0 表示常驻（计划任务的 ExecutionTimeLimit=PT0S 配合它）。
    deadline = (time.time() + args.loop_seconds) if args.loop_seconds > 0 else None
    before = scan_logs()
    last_growth = {}
    confirm = 0
    # 无条件心跳：即使整段时间没有远控，日志里也能看到守卫活着（排障靠它）。
    log("pulse start loop=%.0fs poll=%.0fs resume_hold=%s"
        % (args.loop_seconds, args.poll_seconds, bool(state.get("hold_started"))))
    while True:
        now_ts = time.time()
        snapshot = procs()
        present, evidence = remote_session_present(before, now_ts, last_growth, snapshot)
        before = scan_logs()

        holding = bool(state.get("hold_started"))
        mstsc = pids_of(TARGET_PROCESS, snapshot)

        if present:
            confirm += 1
        else:
            confirm = 0

        if args.trace_file:
            trace(args.trace_file, "present=%s confirm=%d %s=%s holding=%s await_end=%s | %s"
                  % (present, confirm, TARGET_PROCESS, mstsc, holding,
                     state.get("await_remote_end"), evidence))

        # 远控真的结束了才解除"不许再让路"，否则重开 RDP 会被当成新连接再杀一次。
        if state.get("await_remote_end") and not present:
            state["await_remote_end"] = False
            write_state(state)
            log("remote session ended -> next connection may yield again")

        since_yield = now_ts - (state.get("last_yield_at") or 0)
        may_yield = (not state.get("await_remote_end")) and since_yield >= MIN_SECONDS_BETWEEN_YIELDS

        if not holding and present and confirm >= CONFIRM_POLLS and mstsc and may_yield:
            engage(now_ts, state, evidence)
        elif not holding and present and confirm >= CONFIRM_POLLS and mstsc:
            if args.trace_file:
                trace(args.trace_file, "yield suppressed: await_end=%s since_yield=%.0fs"
                      % (state.get("await_remote_end"), since_yield))
        elif holding:
            age = hold_age(state, now_ts)
            due = state.get("restart_due_at")
            if mstsc:
                # RDP 已经回来了（保活或人工）：让出窗口提前结束，回到空闲。
                log("%s back (pids=%s) -> yield window closed" % (TARGET_PROCESS, mstsc))
                close_yield_window(state, "client returned by other means")
            elif due and now_ts >= due:
                restore_rdp(state, evidence)
            else:
                touch_suspend("yield %.0fs" % age)
                wait = (due - now_ts) if due else 0
                log("yield window (%.0fs elapsed, restore in %.0fs): %s=%s %s"
                    % (age, max(0.0, wait), TARGET_PROCESS, mstsc, evidence))

        if deadline is not None and now_ts >= deadline:
            break
        time.sleep(args.poll_seconds)
    log("pulse end")
    return 0


if __name__ == "__main__":
    sys.exit(main())
