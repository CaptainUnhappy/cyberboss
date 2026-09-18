# Agent Note: RDPWrap 隔离会话部署契约（Windows 虚拟屏幕防抢占）

Status: implemented

## Problem

机器人的收发原本跑在用户自己的会话里（session 1）：UIA 桥要激活窗口、点会话行、注入键鼠。这带来两个代价：

1. **抢占**：任何一次驱动都可能抢走前台窗口与光标（用户明确不接受）。
2. **环境噪声**：同一会话里有沙箱继承、系统权限弹窗、ToDesk 等遮挡、以及"桌面空闲"门槛 —— 桥的失败模式全在这里。

方案是把**驱动面整体搬进一个独立的交互会话**（RDPWrap 本地回环 + 独立 Windows 账号），让收发在那边完成，用户桌面完全不参与。

## Decision

部署形态（2026-09-18 起的事实，改动需同步本笔记）：

| 角色 | 位置 | 账号 / 端口 |
|---|---|---|
| 机器人号（现役） | RDPWrap 隔离会话（session 4，用户 `cwinprobe`） | 微信 **Azzy** `wxid_s3178hwvzsl922` |
| 读侧 WeFlow | 同上 | HTTP **5051**（读 Azzy 的库） |
| 写侧 UIA 桥 | 同上 | HTTP **8776**（驱动 Azzy 的微信；核对走 5051） |
| 机器人本体 | session 1（**必须由计划任务拉起**） | `bin/cyberboss.js`，读 5051 / 写 8776 |
| 对端（真实用户） | 手机 / 大号 | 柳毓琳 `wxid_ubo0cy5xh4px22` |
| 旧机器人号（退役备用） | session 1 | 微信 **Ally** `wxid_ty69l7hjiqt012`（5031/8766 已停） |
| 官方通道 | 公网 | `ilinkai.weixin.qq.com`（不依赖隔离会话） |

**必须遵守的运行约束**

1. **必须存在一个"已连接且未最小化/未隐藏"的 RDP 客户端**。客户端一断、一最小化或一隐藏，隔离会话就失去输入桌面（`GetForegroundWindow()=0`、`SetCursorPos` 返回 False）→ 桥报 `WeChat main window could not be activated` → **回复发不出去**（收消息仍正常，因为读侧只是文件/HTTP）。客户端被别的窗口挡住不影响注入（2026-09-18 实测：失效原因是**被最小化**，不是被遮挡）。
   **不想看见它时，把它挪到屏幕外（如 `x=1930`，屏幕宽 1920），不要最小化、不要隐藏** —— 屏幕外同样保持"已连接 + 可注入"（实测 `setCursorPos=True`）。会话桌面里的 WeFlow 每约 30 秒会自己起一次 `powershell.exe` + `conhost.exe`，那画面只出现在 RDP 窗口**内部**，停靠屏幕外即可不看见。
2. **自动/周期性助手一律不得 spawn 控制台子系统子进程**（`tasklist.exe` / `taskkill.exe` / `schtasks.exe` / `cmd.exe` …）。本机把"创建控制台"交给 Windows Terminal，于是每次 spawn 都在**用户自己的桌面**上冒出一个终端窗口：`CREATE_NO_WINDOW` 只能削弱不能消除（实测 10 次 `tasklist` 仍产生 5 次可见终端事件），`powershell.exe -WindowStyle Hidden` 作为计划任务动作同样可见（实测 `CASCADIA_HOSTING_WINDOW_CLASS vis=True` + `PseudoConsoleWindow vis=True`）；`wscript.exe //B` + `hidden-run.vbs`（`WshShell.Run(cmd, 0, True)`）实测只产生隐藏的 `ConsoleWindowClass`（`vis=False`）。替代做法：进程枚举/终止走 Toolhelp32 + `TerminateProcess`；启动计划任务走 `Schedule.Service` COM；跑 PS 脚本走 VBS 包装器。
   这是 2026-09-18 用户第二次报"一直在弹 cmd 窗口"的真正根因：`rdp-autologin.py` 在重连期间**每 1 秒 spawn 一次 `tasklist.exe`**，一次重连 ≈ 110 个终端窗口；用户说的"好像是 rdp 重启就出现"完全正确 —— 那正是重连助手在跑。早先本笔记把锅归给 WeFlow 每 30 秒的控制台窗口，那只在 RDP 窗口画面里可见，与用户桌面上的弹窗无关（已更正）。
3. **机器人栈必须由计划任务启动，不能从 agent 会话里 `Start-Process`**：那样会继承 agent 沙箱（AppContainer），窗口激活与注入全部失效。运维命令是 `Start-ScheduledTask -TaskName cwin-s1-restack`。
4. **RDP 客户端必须正常显示启动**：`rdp-autologin.py` 原来用 `STARTF_USESHOWWINDOW` + 默认 `wShowWindow=0`（SW_HIDE）启动 mstsc，等于把会话置于不可注入状态；已改为 `SW_SHOWNORMAL`。
5. **同号人工输入与回声归因**：账本是唯一权威 —— 账本认领的发出消息按回声吞掉，未认领的按 `self_manual` 路由（见 [归因笔记](../bug-fix/2026-09-18-weflow-self-echo-attribution.md)）。
6. **官方通道身份只能有一个消费者**：不能同时跑两份 bot。

**保活与静默**

代码在 `scripts/isolated-session/`（**已入库**，计划任务指向仓库路径）：`rdp-keepalive.py`（保活）、`rdp-autologin.py`（重连 + 点掉证书框）、`rdp-client.ps1`（查看开关）、`hidden-run.vbs`（无窗口跑 PS）。`cwin-s1-rdp-keepalive` / `-reconnect` 用 `pythonw.exe` 执行，`-show` / `-hide` 用 `wscript.exe //B //NoLogo hidden-run.vbs` 执行 —— 两者都不产生可见控制台。

`cwin-s1-rdp-keepalive` 每 5 分钟在**隔离会话内**探针一次（`GetForegroundWindow` + `SetCursorPos`，只影响 session 4），探针经会话内文件队列 `C:\ProgramData\cwin-probe\s4\in` 投递。两条 2026-09-18 实测出来的判定规则：

- **先摆正窗口，再考虑重连**。探针失败时先把客户端窗口重新摆正（**最小化就恢复**，即使暂停文件存在也恢复：暂停文件只决定摆回 `(0,0)` 还是停靠 `(1930,0)`），再复探一次，只有仍然失败才触发 `cwin-s1-rdp-reconnect`。早先版本在暂停文件存在时直接跳过摆正，于是"客户端被最小化 → 探针必然失败 → 每 5 分钟重连一次"，而每次重连都带一串弹窗：**用户看到的"反复弹窗"其实是这条循环**。
- **探针没回音 ≠ 会话坏了**。会话内队列是共享的（实测另一个 workload 的 `q1..q10` 脚本连续占用数分钟），`(no probe output)` 只说明 worker 忙，此时**不重连**，直接 `exit 2` 等下一拍。没有这条，队列一忙就会误杀 RDP 连接。

`-WindowStyle Hidden` 挡不住计划任务那一瞬的窗口创建，`-LogonType S4U` 在本机被拒（需要"作为批处理作业登录"权限）。

**操作员查看/操作会话桌面时的开关**（保活会持续把窗口挪走，所以需要显式暂停）：

```powershell
Start-ScheduledTask -TaskName cwin-s1-rdp-show   # 客户端挪回 (0,0) + 放置暂停文件
Start-ScheduledTask -TaskName cwin-s1-rdp-hide   # 移除暂停文件 + 停靠回 (1930,0)
```

暂停文件是 `C:\ProgramData\cwin-probe\rdp-client-hold.txt`：存在期间保活只探针、不挪窗口（但仍会把最小化的客户端恢复回来）。给微信账号扫码登录等"必须看着会话桌面"的操作，先 `-show`，做完 `-hide`。

**回滚**：`Copy-Item .env.bak-<日期> .env -Force` 后 `Start-ScheduledTask cwin-s1-restack`。

## Alternatives considered

- **留在 session 1 做驱动，只靠桥内的"桌面空闲 ≥300 秒"门槛避让**：桥确实有 `MIN_CANARY_DESKTOP_IDLE_SECONDS=300`，但那只覆盖 canary/看门狗路径；且用户一用电脑就永远等不到窗口。已实测这条路持续失败。
- **session 0 / 隐藏桌面**：实测 `OpenInputDesktop` 失败、`WinSta0` 拒绝访问、`SetCursorPos` 失败 —— 服务会话里没有可注入的交互桌面。
- **虚拟机（L3）**：能隔离但成本与依赖最重，用户明确排除。
- **把机器人号也留在外面（Ally 在外）**：曾经可行，但出站驱动仍然落在用户会话里，抢占问题原样存在。最终把机器人号也搬进隔离会话。
- **`-LogonType S4U` 跑保活**：最正统的"无窗口"解法，但注册被拒（缺批处理登录权限），改用 `pythonw`。
- **靠 `CREATE_NO_WINDOW` / `-WindowStyle Hidden` 压住弹窗**：实测都不够（见约束 2 的计数）——窗口创建发生在这些开关生效之前，且本机把控制台交给 Windows Terminal。最终改成"根本不 spawn 控制台子进程"。
- **"探针没回音也照样重连"**：等于让共享队列的忙闲决定 RDP 连接的生死，实测一次夸克网盘自动化就把连接误杀了一次；改为只对**有明确否定结论**的探针重连。
- **把保活探针换成截图/窗口枚举自证**：能绕开共享队列，但要在会话内起进程（又回到控制台窗口问题），收益不抵成本，暂不做。

## Consequences

- 收益：机器人的收发完全在隔离会话完成，用户桌面不参与；桥的失败模式从"抢占 + 遮挡 + 沙箱"收敛为"客户端是否连着"这一条，且这条有保活兜底。用户桌面上的控制台弹窗归零（实测：同一条重连路径 133 秒内产生 **0** 个可见终端事件，修复前是每 1 秒一个）。
- 代价：多了一个必须活着的 RDP 客户端（`mstsc`）与一个 Windows 账号（`cwinprobe`）；隔离会话的资源占用与真实微信一致；保活/重连助手必须永远避开控制台子进程，这条约束会跟着每一次"顺手加一行 tasklist"复发。
- 已知缺口：① **投递没有握手** —— 发送失败不重传、不通知（账本里已积累数十条 `status=failed`），方案见 [投递握手提案](../../proposed/feature/2026-09-18-weflow-reply-delivery-handshake.md)；② 隔离会话内的 Agent Room executor 曾因串行执行卡死，文件队列 `C:\ProgramData\cwin-probe\s4\{in,out,done}` 是更可靠的后备通道，但它**是共享资源**：另一个 workload（实测夸克网盘 `q1..q10`）占用时保活探针会超时，现在只会跳过不会重连，需要时就近看 `s4\in`、`s4\done` 的积压。
- 部署脚本已入库到 `scripts/isolated-session/`（4 个文件，计划任务动作指向仓库路径）；仍留在 `C:\ProgramData\cwin-probe\` 的是历史实验脚本，其中 `s1-restack.ps1`（退役 Ally 栈的端口 8766/5031）与 `s1-mstsc-offscreen2.ps1` **尚未纳入本契约**，`cwin-s1-restack` / `cwin-s1-mstsc-off2` 两个任务保持原样。
