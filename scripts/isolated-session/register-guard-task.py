"""register-guard-task.py -- 注册/查看/卸载 "远控期间自动让出 RDP 客户端" 的守卫任务。

注册出来的任务：`cwin-s1-rdp-remote-guard`，每 2 分钟以**当前交互用户**身份拉起
`scripts/isolated-session/rdp-remote-guard.py`（该脚本内部再循环 ~100s，所以全程有
守卫在场）。

为什么不需要管理员：要读的远控日志目录、要写的 `C:\\ProgramData\\cwin-probe`、要终止
的 `mstsc.exe` 都属于当前用户或对 Users 开放（见部署笔记的 ACL 实测）；注册用
`InteractiveToken` + `LeastPrivilege`，即普通用户身份。

为什么不 spawn `schtasks.exe`：本机把创建控制台交给 Windows Terminal，`schtasks`
每次调用都会在用户桌面闪一个终端窗口（部署契约硬约束 2）。注册走 Schedule.Service COM。

用法：
    D:\\Tools\\miniconda3\\python.exe scripts\\isolated-session\\register-guard-task.py
    ... --show      只读回显
    ... --remove    卸载
"""
import argparse
import datetime
import os
import sys
from pathlib import Path

TASK_NAME = "cwin-s1-rdp-remote-guard"
TASK_PATH = "\\"

# Machine bindings are derived, never literal: this file used to hardcode both
# the interpreter and the checkout, so registering the task on a second machine
# silently produced a task pointing at a directory that does not exist there.
REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHONW = os.environ.get("CYBERBOSS_PYTHONW") or str(
    Path(sys.executable).with_name("pythonw.exe")
)
SCRIPT = str(REPO_ROOT / "scripts" / "isolated-session" / "rdp-remote-guard.py")
WORKDIR = str(REPO_ROOT)

TASK_CREATE_OR_UPDATE = 6
TASK_LOGON_INTERACTIVE_TOKEN = 3

TASK_XML = """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Remote-control guard (resident): suspend the loopback RDP client while ToDesk/GameViewer is being controlled, restore it afterwards.</Description>
    <Author>cyberboss</Author>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
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
      <Command>{pythonw}</Command>
      <Arguments>"{script}" --loop-seconds 0</Arguments>
      <WorkingDirectory>{workdir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""


def stamp(msg):
    print("%s  %s" % (datetime.datetime.now().strftime("%H:%M:%S"), msg), flush=True)


def service():
    import win32com.client
    svc = win32com.client.Dispatch("Schedule.Service")
    svc.Connect()
    return svc


def show(svc):
    root = svc.GetFolder(TASK_PATH)
    try:
        task = root.GetTask(TASK_NAME)
    except Exception as exc:
        stamp("task %s NOT FOUND (%s)" % (TASK_NAME, exc))
        return 1
    definition = task.Definition
    trigger = definition.Triggers.Item(1)
    action = definition.Actions.Item(1)
    principal = definition.Principal
    stamp("state=%s  last_run=%s  last_result=0x%X"
          % (task.State, task.LastRunTime, task.LastTaskResult))
    stamp("action   : %s %s" % (action.Path, action.Arguments))
    stamp("trigger  : every %s, duration %s" % (trigger.Repetition.Interval, trigger.Repetition.Duration))
    stamp("principal: user=%s logonType=%s runLevel=%s"
          % (principal.UserId, principal.LogonType, principal.RunLevel))
    return 0


def register(svc):
    xml = TASK_XML.format(pythonw=PYTHONW, script=SCRIPT, workdir=WORKDIR)
    root = svc.GetFolder(TASK_PATH)
    root.RegisterTask(TASK_NAME, xml, TASK_CREATE_OR_UPDATE,
                      None, None, TASK_LOGON_INTERACTIVE_TOKEN, "")
    stamp("registered %s (logon trigger, resident) -> %s %s --loop-seconds 0"
          % (TASK_NAME, PYTHONW, SCRIPT))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--show", action="store_true", help="只回显任务定义")
    parser.add_argument("--remove", action="store_true", help="卸载任务")
    args = parser.parse_args()

    try:
        svc = service()
    except Exception as exc:
        stamp("Schedule.Service unavailable: %s" % exc)
        return 2

    if args.show:
        return show(svc)
    if args.remove:
        svc.GetFolder(TASK_PATH).DeleteTask(TASK_NAME, 0)
        stamp("removed %s" % TASK_NAME)
        return 0

    register(svc)
    return show(svc)


if __name__ == "__main__":
    sys.exit(main())
