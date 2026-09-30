"""register-tasks.py -- register every cyberboss scheduled task for THIS machine.

Why this file exists: the deployment used to live in 11 scheduled tasks whose
actions contained absolute paths (`D:\\Projects\\cyberboss`, `D:\\Tools\\miniconda3`)
and, worse, three actions pointed at scripts that existed only on one machine
(`C:\\ProgramData\\cwin-probe\\...`) and were never committed. "Rebuild this on
another machine" was therefore not a procedure, it was archaeology.

Now the whole task set is declared here, once, and every path is resolved from
the location of this file. Run it after cloning on a new machine:

    python scripts/isolated-session/register-tasks.py            # register/update all
    python scripts/isolated-session/register-tasks.py --show     # read back, do not touch
    python scripts/isolated-session/register-tasks.py --remove    # unregister all
    python scripts/isolated-session/register-tasks.py --only cwin-weflow-guard

Registration uses Schedule.Service COM and never spawns `schtasks.exe`: this
machine hands console creation to Windows Terminal, so every console child would
flash a terminal window on the user's own desktop (deployment contract, hard
constraint 2).

Environment overrides (all optional):
    CYBERBOSS_REPO_ROOT      checkout root (default: two levels above this file)
    CYBERBOSS_QUEUE_ROOT     queue/report root (default C:\\ProgramData\\cwin-probe)
    CYBERBOSS_PYTHON         python.exe used by recipes (default: this interpreter)
    CYBERBOSS_PYTHONW        pythonw.exe used by resident recipes
    CYBERBOSS_NODE_EXE       node.exe used by bot-direct.cmd / s1-restack.ps1
    CYBERBOSS_WECHAT_EXE     WeChat desktop client path
"""

from __future__ import annotations

import argparse
import datetime
import os
import sys
from pathlib import Path

TASK_PATH = "\\"
TASK_CREATE_OR_UPDATE = 6
TASK_LOGON_INTERACTIVE_TOKEN = 3

REPO_ROOT = Path(__file__).resolve().parents[2]
QUEUE_ROOT = Path(os.environ.get("CYBERBOSS_QUEUE_ROOT") or r"C:\ProgramData\cwin-probe")
ISOLATED = REPO_ROOT / "scripts" / "isolated-session"
SYSTEM_ROOT = Path(os.environ.get("SystemRoot") or r"C:\Windows")
WSCRIPT = SYSTEM_ROOT / "System32" / "wscript.exe"

def _python() -> str:
    override = os.environ.get("CYBERBOSS_PYTHON")
    if override:
        return override
    return sys.executable


def _pythonw() -> str:
    override = os.environ.get("CYBERBOSS_PYTHONW")
    if override:
        return override
    beside = Path(sys.executable).with_name("pythonw.exe")
    return str(beside) if beside.exists() else sys.executable


def _node() -> str:
    override = os.environ.get("CYBERBOSS_NODE_EXE")
    if override:
        return override
    import shutil

    found = shutil.which("node")
    if found:
        return found
    program_files = Path(os.environ.get("ProgramFiles") or r"C:\Program Files")
    return str(program_files / "nodejs" / "node.exe")


PYTHON = _python()
PYTHONW = _pythonw()
NODE = _node()


def _q(*parts: str) -> str:
    return str(QUEUE_ROOT.joinpath(*parts))


def _r(*parts: str) -> str:
    return str(REPO_ROOT.joinpath(*parts))


def _vbs(script: str) -> tuple[str, str]:
    """wscript + hidden-run.vbs keeps a PowerShell recipe windowless."""
    return str(WSCRIPT), '//B //NoLogo "%s" "%s"' % (_r("scripts", "isolated-session", "hidden-run.vbs"), script)


# name -> (trigger, execute, arguments, run_level, description)
TASKS: dict[str, dict] = {
    "cwin-s1-session-bootstrap": {
        "trigger": ("logon", None),
        "execute": "powershell.exe",
        "arguments": '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%s"' % _r(
            "scripts", "isolated-session", "session-bootstrap.ps1"
        ),
        "run_level": "Limited",
        "description": "Inside the isolated session: start the file-queue worker, WeChat, WeFlow and the UIA bridge.",
    },
    "cwin-s1-bot": {
        "trigger": ("interval", "PT1H"),
        "execute": _q("bot-direct.cmd"),
        "arguments": "",
        "run_level": "Limited",
        "description": "Start the bot directly (bypasses shared-start.js bridge verification) every hour; the bot is single-instance.",
    },
    "cwin-s1-rdp-keepalive": {
        "trigger": ("interval", "PT5M"),
        "execute": PYTHONW,
        "arguments": '"%s"' % _r("scripts", "isolated-session", "rdp-keepalive.py"),
        "run_level": "Limited",
        "description": "Probe the isolated session's input desktop via the bridge and recreate the RDP client when it is really gone.",
    },
    "cwin-s1-rdp-reconnect": {
        "trigger": ("none", None),
        "execute": PYTHONW,
        "arguments": '"%s" 110' % _r("scripts", "isolated-session", "rdp-autologin.py"),
        "run_level": "Limited",
        "description": "Reconnect the loopback RDP client to the isolated session and dismiss the certificate dialog.",
    },
    "cwin-s1-rdp-show": {
        "trigger": ("none", None),
        "execute": _vbs(_r("scripts", "isolated-session", "rdp-client.ps1"))[0],
        "arguments": _vbs(_r("scripts", "isolated-session", "rdp-client.ps1"))[1] + " -Mode show",
        "run_level": "Limited",
        "description": "Operator switch: park the RDP client on-screen and hold it there (scan a QR code, inspect the desktop).",
    },
    "cwin-s1-rdp-hide": {
        "trigger": ("none", None),
        "execute": _vbs(_r("scripts", "isolated-session", "rdp-client.ps1"))[0],
        "arguments": _vbs(_r("scripts", "isolated-session", "rdp-client.ps1"))[1] + " -Mode hide",
        "run_level": "Limited",
        "description": "Operator switch: dock the RDP client off-screen and release the hold.",
    },
    "cwin-s1-rdp-remote-guard": {
        "trigger": ("logon", None),
        "execute": PYTHONW,
        "arguments": '"%s" --loop-seconds 0' % _r("scripts", "isolated-session", "rdp-remote-guard.py"),
        "run_level": "Highest",
        "description": "Resident guard: suspend the loopback RDP client while ToDesk/GameViewer is being controlled, restore it afterwards.",
    },
    "cwin-weflow-guard": {
        "trigger": ("interval", "PT15M"),
        "execute": _vbs(_r("scripts", "isolated-session", "weflow-guard.ps1"))[0],
        "arguments": _vbs(_r("scripts", "isolated-session", "weflow-guard.ps1"))[1],
        "run_level": "Limited",
        "description": "Ask WeFlow's messages API every 15 minutes; queue a reader restart when it stops answering.",
    },
    "Cyberboss Heartbeat Watchdog": {
        "trigger": ("interval", "PT15M"),
        "execute": str(WSCRIPT),
        "arguments": '//B //NoLogo "%s"' % _r("scripts", "cyberboss-watchdog-hidden.vbs"),
        "run_level": "Limited",
        "description": "Heartbeat watchdog: verify the bot, bridge and reader, then run the mechanical repair path.",
    },
    "cwin-s1-restack": {
        "trigger": ("none", None),
        "execute": "powershell.exe",
        "arguments": '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%s"'
        % _r("scripts", "isolated-session", "s1-restack.ps1"),
        "run_level": "Limited",
        "description": "Restart the whole bot stack from a task context (no agent sandbox). Used when shared-start.js refuses to start the bot.",
    },
    "cwin-s1-mstsc-off2": {
        "trigger": ("none", None),
        "execute": "powershell.exe",
        "arguments": '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%s"'
        % _r("scripts", "isolated-session", "s1-mstsc-offscreen2.ps1"),
        "run_level": "Limited",
        "description": "Move the RDP client window off-screen from the console session (legacy path kept for recovery).",
    },
}

# Retired, kept here only so a fresh machine does not recreate them:
#   cwin-session0-probe  -> action pointed into the gitignored tmp/ directory
#   cwin-s4-worker       -> superseded by cwin-s1-session-bootstrap
RETIRED = ["cwin-session0-probe", "cwin-s4-worker"]


def stamp(msg: str) -> None:
    print("%s  %s" % (datetime.datetime.now().strftime("%H:%M:%S"), msg), flush=True)


def service():
    import win32com.client

    svc = win32com.client.Dispatch("Schedule.Service")
    svc.Connect()
    return svc


# The live tasks report `runLevel=Limited`, but the Task Scheduler XML schema
# only accepts `LeastPrivilege` / `HighestAvailable`; `Limited` is the COM
# enumeration's display name for LeastPrivilege. Using the display name in XML
# fails registration with "RunLevel:Limited" — measured while building this
# script, so the mapping is explicit here.
RUN_LEVEL_XML = {
    "Limited": "LeastPrivilege",
    "LeastPrivilege": "LeastPrivilege",
    "Highest": "HighestAvailable",
    "HighestAvailable": "HighestAvailable",
}


def build_xml(name: str, spec: dict) -> str:
    trigger_kind, trigger_arg = spec["trigger"]
    if trigger_kind == "logon":
        triggers = "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>"
    elif trigger_kind == "interval":
        # The original tasks also carried a very long repetition duration
        # (P3650D); keeping it matches the live behaviour on this machine.
        triggers = (
            "<TimeTrigger><Enabled>true</Enabled><StartBoundary>%s</StartBoundary>"
            "<Repetition><Interval>%s</Interval><Duration>P3650D</Duration></Repetition>"
            "</TimeTrigger>" % (datetime.datetime.now().replace(microsecond=0).isoformat(), trigger_arg)
        )
    else:
        triggers = ""
    return """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>{description}</Description>
    <Author>cyberboss</Author>
  </RegistrationInfo>
  <Triggers>{triggers}</Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>{run_level}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{execute}</Command>
      <Arguments>{arguments}</Arguments>
      <WorkingDirectory>{workdir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
""".format(
        description=spec["description"],
        triggers=triggers,
        run_level=RUN_LEVEL_XML.get(spec["run_level"], "LeastPrivilege"),
        execute=spec["execute"],
        arguments=spec["arguments"],
        workdir=str(REPO_ROOT),
    )


def show_one(svc, name: str) -> int:
    root = svc.GetFolder(TASK_PATH)
    try:
        task = root.GetTask(name)
    except Exception as exc:  # noqa: BLE001 - COM error text is the useful part
        stamp("task %s NOT FOUND (%s)" % (name, exc))
        return 1
    action = task.Definition.Actions.Item(1)
    stamp("%-28s state=%-8s action=%s %s" % (name, task.State, action.Path, action.Arguments))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="register every cyberboss scheduled task")
    parser.add_argument("--show", action="store_true", help="read back task definitions, change nothing")
    parser.add_argument("--remove", action="store_true", help="unregister the declared tasks")
    parser.add_argument("--only", action="append", default=[], help="limit to one task name (repeatable)")
    parser.add_argument("--dry-run", action="store_true", help="print the XML instead of registering")
    args = parser.parse_args()

    names = args.only or list(TASKS)
    unknown = [n for n in names if n not in TASKS]
    if unknown:
        stamp("unknown task name(s): %s" % ", ".join(unknown))
        return 2

    if args.dry_run:
        for name in names:
            print("=== %s ===" % name)
            print(build_xml(name, TASKS[name]))
        return 0

    try:
        svc = service()
    except Exception as exc:  # noqa: BLE001
        stamp("Schedule.Service unavailable: %s" % exc)
        return 2

    if args.show:
        failures = sum(show_one(svc, name) for name in names)
        return 1 if failures else 0

    root = svc.GetFolder(TASK_PATH)
    if args.remove:
        for name in names:
            try:
                root.DeleteTask(name, 0)
                stamp("removed %s" % name)
            except Exception as exc:  # noqa: BLE001
                stamp("remove %s skipped (%s)" % (name, exc))
        return 0

    stamp("repo root : %s" % REPO_ROOT)
    stamp("queue root: %s" % QUEUE_ROOT)
    stamp("python    : %s" % PYTHON)
    stamp("pythonw   : %s" % PYTHONW)
    stamp("node      : %s" % NODE)
    for name in names:
        spec = TASKS[name]
        xml = build_xml(name, spec)
        try:
            root.RegisterTask(name, xml, TASK_CREATE_OR_UPDATE, None, None, TASK_LOGON_INTERACTIVE_TOKEN, "")
            stamp("registered %s" % name)
        except Exception as exc:  # noqa: BLE001
            stamp("FAILED %s: %s" % (name, exc))
            return 1
    for name in RETIRED:
        try:
            root.GetTask(name)
        except Exception:  # noqa: BLE001 - absent is the expected case
            continue
        stamp("note: retired task %s still exists; remove it with --remove --only %s" % (name, name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
