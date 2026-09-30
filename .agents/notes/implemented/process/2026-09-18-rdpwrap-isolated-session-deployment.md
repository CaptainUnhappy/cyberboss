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

1. **必须存在一个"已连接且未最小化/未隐藏"的 RDP 客户端**（**远控进行中的例外窗口见** [远控期间自动让出 RDP 客户端](../feature/2026-09-20-remote-control-rdp-client-handoff.md)：ToDesk / GameViewer 被控时会挑中 session 4，守卫在那段时间主动停掉客户端、远控结束后再拉回来）。客户端一断、一最小化或一隐藏，隔离会话就失去输入桌面（`GetForegroundWindow()=0`、`SetCursorPos` 返回 False）→ 桥报 `WeChat main window could not be activated` → **回复发不出去**（收消息仍正常，因为读侧只是文件/HTTP）。客户端被别的窗口挡住不影响注入（2026-09-18 实测：失效原因是**被最小化**，不是被遮挡）。
   **不想看见它时，把它挪到屏幕外（如 `x=1930`，屏幕宽 1920），不要最小化、不要隐藏** —— 屏幕外同样保持"已连接 + 可注入"（实测 `setCursorPos=True`）。会话桌面里的 WeFlow 每约 30 秒会自己起一次 `powershell.exe` + `conhost.exe`，那画面只出现在 RDP 窗口**内部**，停靠屏幕外即可不看见。
2. **自动/周期性助手一律不得 spawn 控制台子系统子进程**（`tasklist.exe` / `taskkill.exe` / `schtasks.exe` / `cmd.exe` …）。本机把"创建控制台"交给 Windows Terminal，于是每次 spawn 都在**用户自己的桌面**上冒出一个终端窗口：`CREATE_NO_WINDOW` 只能削弱不能消除（实测 10 次 `tasklist` 仍产生 5 次可见终端事件），`powershell.exe -WindowStyle Hidden` 作为计划任务动作同样可见（实测 `CASCADIA_HOSTING_WINDOW_CLASS vis=True` + `PseudoConsoleWindow vis=True`）；`wscript.exe //B` + `hidden-run.vbs`（`WshShell.Run(cmd, 0, True)`）实测只产生隐藏的 `ConsoleWindowClass`（`vis=False`）。替代做法：进程枚举/终止走 Toolhelp32 + `TerminateProcess`；启动计划任务走 `Schedule.Service` COM；跑 PS 脚本走 VBS 包装器。
   这是 2026-09-18 用户第二次报"一直在弹 cmd 窗口"的真正根因：`rdp-autologin.py` 在重连期间**每 1 秒 spawn 一次 `tasklist.exe`**，一次重连 ≈ 110 个终端窗口；用户说的"好像是 rdp 重启就出现"完全正确 —— 那正是重连助手在跑。早先本笔记把锅归给 WeFlow 每 30 秒的控制台窗口，那只在 RDP 窗口画面里可见，与用户桌面上的弹窗无关（已更正）。
3. **机器人栈必须由计划任务启动，不能从 agent 会话里 `Start-Process`**：那样会继承 agent 沙箱（AppContainer），窗口激活与注入全部失效。运维命令是 `Start-ScheduledTask -TaskName cwin-s1-restack`。
4. **RDP 客户端必须正常显示启动**：`rdp-autologin.py` 原来用 `STARTF_USESHOWWINDOW` + 默认 `wShowWindow=0`（SW_HIDE）启动 mstsc，等于把会话置于不可注入状态；已改为 `SW_SHOWNORMAL`。
5. **同号人工输入与回声归因**：账本是唯一权威 —— 账本认领的发出消息按回声吞掉，未认领的按 `self_manual` 路由（见 [归因笔记](../bug-fix/2026-09-18-weflow-self-echo-attribution.md)）。
6. **官方通道身份只能有一个消费者**：不能同时跑两份 bot。
7. **跨账号进程的"身份"只能用端点归属证明**：桥活在 session 4（`cwinprobe`），session 1 的非管理员进程**读不到它的命令行**（2026-09-22 实测：PID 35260 的 `CommandLine` 为空，而同一个调用者能读到 session 1 的全部 PID）。所以"命令行匹配"（`Test-VerifiedPidAlive`）永远验证不了隔离会话里的桥，后果是双重的：看门狗把它报成 `uia=alive=false,health=true,ready=true`（`uia` 判失败又连带把 canary 判失败），`cyberboss-service.ps1` 的 PID 文件校验与停机路径则直接抛错 —— **所有机械 Restart/FullRestart 在动任何东西之前就中止**（2026-09-22 16:15 实测：`PID file points to live PID 35260 with an unexpected command`）。现在的判据是**端点归属**：PID 存活**且是该端口唯一监听者**即视为已验证（TCP 表跨账号可读）；停机路径遇到"命令行读不到 + 是唯一属主"的进程**不动它**（它由自己会话里的配方管），而不是抛错。别再退回命令行匹配。**只校验还不够**（2026-09-29 实测）：`Test-UiaBridgePidVerified` 只回答「文件里记的那个 PID 是不是桥」，回答不了「文件里没有桥的 PID 时该记谁」。桥被野重启后 pid 文件滞后（09-28 14596→23088、09-29 23088→37756），看门狗就报 `uia=alive=false,health=true,ready=true`，每次都要等一次机械 `Restart` 才把文件补齐 —— 而那次 Restart 顺手把**健康的核心**也重启了。现在看门狗也在校验失败时用**唯一端点属主**把 pid 文件原子修回来（与服务脚本同源，且不抛错），见 [看门狗也用端点属主修回陈旧的桥 PID 文件](../bug-fix/2026-09-29-watchdog-recovers-uia-pid-file-from-endpoint-owner.md)。
   **同一堵墙也挡着 WeFlow（5051）**：`Test-WeFlowOwnsApiPort` 原来用 `Win32_Process.ExecutablePath` 比对 `WeFlow.exe` 路径，跨账号同样是空值，于是每一轮机械 Restart/FullRestart 都在这里中止（2026-09-22 15:30、2026-09-23 16:45 与 18:15 三次实测 `local WeFlow API port 5051 has an unverifiable owner`）。现在读不到 Exe 路径时退回**功能身份**：该监听者必须能用本项目的 token 答出 `/api/v1/health` 与一条 `/api/v1/messages` 查询（`Test-WeFlowFunctionalReady`）。
8. **bot 的"身份"必须能匹配它真实的启动方式**：`$BridgeCommandPattern` 原来是 `(?:^|[\\/])bin[\\/]cyberboss\.js\s+start(?:\s|$)`，只认 `./bin/cyberboss.js`（`/` 前缀）或绝对路径。2026-09-27 实测有人以 **`node bin\cyberboss.js start --checkin`**（相对路径，`bin` 前面是空格）启动机器人 ⇒ 模式**匹配不上**，连锁三件事：① 看门狗报 `cyberboss` 不可用（`pid=0, alive=false`）；② 服务不肯用 activity 文件里的 PID 修 PID 文件（`Repair-BridgePidFileFromActivity` 同样要过这个模式）；③ 服务于是再起一个 bot，那一个被机器人自身的单例锁拒绝后退出，而 `shared-start.js` 的 cleanup（`removePidFileIfMatches`）顺手**把真正那个 bot 的 PID 文件删掉** —— 最终呈现为"机器人明明活着在收消息，看门狗却一直说它死了、还反复计划 Restart"。现在前缀类改成 `(?:^|[\s\\/])`，两种写法都认；**服务与看门狗这两处必须保持一致**。2026-09-28 又出现同一症状的另一种成因：有人直接 `node bin\cyberboss.js start --checkin` 起 bot（**不经 `shared-start.js`**，所以 pid 文件从未更新），文件里停在更早的死 PID 上 ⇒ 看门狗照样判「核心已死」，机械 Restart 把一个正在正常收发的 bot 杀掉。现在 pid 校验失败时允许用 120 秒内的 pipeline activity 反证存活，见 [陈旧 pid 文件不再判成「核心已死」](../bug-fix/2026-09-28-stale-shared-pid-file-activity-adoption.md)。

**保活与静默**

代码在 `scripts/isolated-session/`（**已入库**，计划任务指向仓库路径）：`rdp-keepalive.py`（保活）、`rdp-autologin.py`（重连 + 点掉证书框）、`rdp-client.ps1`（查看开关）、`hidden-run.vbs`（无窗口跑 PS）、`bridge-restart.ps1`（在隔离会话内重启 8776 桥）、`weflow-restart.ps1`（重启 5051 读侧）、`wechat-restart.ps1`（重启机器人号的微信）、`rdp-remote-guard.py` + `register-guard-task.py`（远控期间让出客户端，见 [远控让出笔记](../feature/2026-09-20-remote-control-rdp-client-handoff.md)）。`cwin-s1-rdp-keepalive` / `-reconnect` 用 `pythonw.exe` 执行，`-show` / `-hide` 用 `wscript.exe //B //NoLogo hidden-run.vbs` 执行 —— 两者都不产生可见控制台。

**探针通道**：保活优先走 **HTTP** `GET http://127.0.0.1:8776/api/probe`（桥就在隔离会话内，进程内直接回答"输入桌面还在不在"，即时返回），失败才退回会话内文件队列。之所以要这条专用通道：文件队列是共享的，另一个 workload 连续占用时会排队数分钟，旧实现因此把正常会话误判成故障。

- `/api/probe`（只读，不碰鼠标）：`{"ok", "foreground", "className", "movedCursor": null, "cursor": null}`，`ok = foreground != 0`。健康一拍**零扰动**。
- `/api/probe?move=1`（强校验，会 `SetCursorPos(300,300)`）：额外的 `movedCursor`。只在只读判定为"坏"时才请求。
- 实测：客户端被最小化 → `{"ok": false, "foreground": 0}`；恢复后 → `{"ok": true, "foreground": 1115708}`。
- **两路都拿不到测量 ⇒ 不重连**（`exit 2`）：桥挂了或队列忙，重连都修不好，只会白丢两分钟自动化。

`cwin-s1-rdp-keepalive` 每 5 分钟探一次（只影响 session 4）。两条 2026-09-18 实测出来的判定规则：

- **先摆正窗口，再考虑重连**。探针失败时先把客户端窗口重新摆正（**最小化就恢复**，即使暂停文件存在也恢复：暂停文件只决定摆回 `(0,0)` 还是停靠 `(1930,0)`），再复探一次，只有仍然失败才触发 `cwin-s1-rdp-reconnect`。早先版本在暂停文件存在时直接跳过摆正，于是"客户端被最小化 → 探针必然失败 → 每 5 分钟重连一次"，而每次重连都带一串弹窗：**用户看到的"反复弹窗"其实是这条循环**。
- **探针没回音 ≠ 会话坏了**。会话内队列是共享的（实测另一个 workload 的 `q1..q10` 脚本连续占用数分钟），`(no probe output)` 只说明 worker 忙，此时**不重连**，直接 `exit 2` 等下一拍。没有这条，队列一忙就会误杀 RDP 连接。

**在隔离会话内重启 8776 桥**（把 `scripts/isolated-session/bridge-restart.ps1` 丢进 `C:\ProgramData\cwin-probe\s4\in`，worker 会取走执行）：

1. 桥的进程必须活在**会话 4**（它驱动那个桌面），所以不能在 session 1 起。
2. 脚本必须自己从 `.env` 读 `CYBERBOSS_WEFLOW_TOKEN` / `ALLOWED_TALKERS` 并设 `CYBERBOSS_WEFLOW_BASE_URL=127.0.0.1:5051`、`DEFAULT_SEND_SOURCE=azzy`、`STATE_DIR=C:\ProgramData\cwin-probe\state4` —— 队列 worker 不继承项目环境。**漏了 token，新进程会立刻以 `CYBERBOSS_WEFLOW_TOKEN is required` 退出，而旧进程已经被杀**：2026-09-18 15:48–15:50 就这样把发信通道打断了 2 分钟（账本实测该窗口 0 条消息，未丢件）。脚本现在把自检写进 `s4\bridge-restart-report.txt`。

`-WindowStyle Hidden` 挡不住计划任务那一瞬的窗口创建，`-LogonType S4U` 在本机被拒（需要"作为批处理作业登录"权限）。

**操作员查看/操作会话桌面时的开关**（保活会持续把窗口挪走，所以需要显式暂停）：

```powershell
Start-ScheduledTask -TaskName cwin-s1-rdp-show   # 客户端挪回 (0,0) + 放置暂停文件
Start-ScheduledTask -TaskName cwin-s1-rdp-hide   # 移除暂停文件 + 停靠回 (1930,0)
```

暂停文件是 `C:\ProgramData\cwin-probe\rdp-client-hold.txt`：存在期间保活只探针、不挪窗口（但仍会把最小化的客户端恢复回来）。给微信账号扫码登录等"必须看着会话桌面"的操作，先 `-show`，做完 `-hide`。

**在隔离会话内重启 WeFlow 读侧（5051）**：把 `scripts/isolated-session/weflow-restart.ps1` 丢进 `C:\ProgramData\cwin-probe\s4\in`。

- **失败签名**：`/api/v1/health` 返回 200，但 `/api/v1/messages` 一律 **HTTP 500** → 机器人读不到任何新消息（`WeFlow outgoing poll failed ... HTTP 500` 刷屏），**能收不能答**。2026-09-18 实测持续约 2 小时（14:40–16:55），期间用户消息全被漏看。
- **恢复判据不能只看端口**：必须用真实 token 打一次 `/api/v1/messages` 并拿到 200；脚本已内置这一步（`READER OK = ...`，写入 `s4\weflow-restart-report.txt`）。
- 重启只是杀 `WeFlow.exe`（会话 4）再 `Start-Process C:\ProgramData\cwin-probe\WeFlow\WeFlow.exe`；配置在应用侧，不需要额外参数。
- **但 `-105` 那一种 500 重启治不了（2026-09-25 实测）**：当 500 的 body 是 `{"error":"错误码: -105"}`、且 `%APPDATA%\weflow\logs\wcdb.log` 在刷 `[bootstrap] native runtime policy mismatch value=-105` 时，问题在 **WCDB 的离线防回拨锚点状态**，不是进程卡死 —— 重启 WeFlow（含 guard 每 15 分钟一次）连做多次都无效。锚点分三处：`%LOCALAPPDATA%\WeFlow\Runtime\anchor-v7-<id>.bin`、`%LOCALAPPDATA%\WeFlow\State\native-anchor-v7-<id>.bin`、`HKCU\Software\WeFlow\Runtime\AnchorV7-<id>`。解药是 [09-11 方案](../../../docs/remediation-plan-2026-09-11.md) §修复F 第 3 条（重建状态）：**实测只删注册表那个 `AnchorV7-*` 值就够了** —— WeFlow 起来后立刻写了一个**新的 `<id>`** 锚点，`/api/v1/messages` 马上从 500 变 200（原文要求"成对删"，实测只删注册表侧即可，文件留着不影响）。已入库配方 `scripts/isolated-session/weflow-anchor-rebuild.ps1`（先把锚点值与文件备份到 `repair\weflow-anchor-backup-<ts>\`，删值、重启、探活；**若读侧仍不通就自动把导出的字节还原**，所以不会丢锚点）。
- 触发条件值得记：这次 `-105` 的起点是 2026-09-23 21:15 的**非正常关机**（`Kernel-Power 41` + `EventLog 6008`），当晚又多次重启 —— 那套 WCDB 库被留在未 checkpoint 的中间态（多个 `.db-wal` 恰好卡在 4 MB、mtime 停在崩溃时刻）。**先看机器有没有非正常关机，再看锚点。**

**在隔离会话内重启微信（机器人号 Azzy）**：把 `scripts/isolated-session/wechat-restart.ps1` 丢进 `C:\ProgramData\cwin-probe\s4\in`。

- 微信**必须活在会话 4**：桥只驱动那个桌面，session 1 里的 `Weixin.exe` 桥永远找不到（`/readyz` 一直 503 `wechatWindow:false`），而看门狗的存活判定是**跨会话**的 `Get-Process Weixin` —— 于是"session 1 有个微信"会把真正的故障**盖住**。2026-09-23 18:14:50 机械修复里的 `Ensure-WeixinStarted` 就在 session 1 起了这样一个野实例（PID 40124）。
- **恢复判据只看桥的 `/readyz`**（它能看见"已登录的主聊天窗口"才返回 200）。`Get-Process Weixin` 只说明进程起来了，**说明不了登没登录**、更说明不了在哪个会话。
- `/readyz` 一直 503 而微信进程活着时，**先看登录窗是什么**：实测崩溃/被杀之后回来的是 `mmui::LoginWindow`，上面写着 `当前登录用户Azzy` + 一个 **`进入微信`** 按钮 —— 那只是"续用已记住的会话"，**不需要手机**，脚本会自动点掉它。点法有讲究：**`InvokePattern.Invoke()` 对 mmui 按钮会"返回成功但什么都不做"**（2026-09-23 实测：调用返回了、`/readyz` 仍是 503），所以脚本改用 UIA 取按钮矩形的中心做**物理点击**，并按桥的 `activate_window()` 手法（AttachThreadInput + ShowWindow + BringWindowToTop + SetForegroundWindow）**先把窗口激活** —— 否则点击会落到当时在前台的那个窗口上。脚本只信 `/readyz`，不信任何一次点击的返回值。
- 只有当登录窗**真的要求扫码**时才需要人：`Start-ScheduledTask -TaskName cwin-s1-rdp-show` → 拿 Azzy 的手机扫码 → `-hide`。脚本报告里会写 `READY = True/False`，`resume outcome:` 一行给出是否找到登录窗、是否点到按钮。
- 刚杀掉另一个 Weixin 实例后**立刻重启可能秒退**（2026-09-23 18:16 实测 launcher 进程直接消失，18:19 再试就稳定留在会话 4）：失败就隔几秒重试一次，别急着判定"起不来"。
- **会话号不是常量（2026-09-24 实测）**：隔离会话在一次丢失 + 重连后**从 4 变成 3**（RDPWrap 重连会给一个新号），而配方里 `SessionId -eq 4` 这类过滤全部失配 —— 微信明明已经在正确的会话里跑着，`Get-Session4WeixinPids` 却返回空，于是"续用已记住的会话"的点击被**静默跳过**、桥的 `/readyz` 一直 503，看起来像"微信根本起不来"。配方是**在目标会话内部**执行的，所以会话号应当取 `(Get-Process -Id $PID).SessionId`；`wechat-restart.ps1`（`Get-IsolatedWeixinPids`）与 `weflow-restart.ps1` 已改成这样。队列目录名 `s4\` 只是历史名字，与当前会话号无关；判断"在哪个会话"永远用运行期取值，不要写字面量。

**一个桌面只能有一个自动化**：机器人的出站要激活微信窗口，而同一个隔离桌面里还有别的 agent 在跑 UIA 自动化（实测对方 `q74-real.ps1` / `q75-uia.ps1` 运行时，桥返回 **502 `WeChat main window could not be activated`**）。此时机器人把回复转成 `deferred_durable` 存进 `deferred-system-replies.json`，**在同一位发件人的下一条入站消息时一并补发**（`app.js` 的 `drainForSender`）—— 所以排队不等于丢失，但也不会自己重试。要立刻拿到回复：让对方停一下桌面自动化，或在微信里再发一句。

**回滚**：`Copy-Item .env.bak-<日期> .env -Force` 后 `Start-ScheduledTask cwin-s1-restack`。

## Alternatives considered

- **留在 session 1 做驱动，只靠桥内的"桌面空闲 ≥300 秒"门槛避让**：桥确实有 `MIN_CANARY_DESKTOP_IDLE_SECONDS=300`，但那只覆盖 canary/看门狗路径；且用户一用电脑就永远等不到窗口。已实测这条路持续失败。
- **session 0 / 隐藏桌面**：实测 `OpenInputDesktop` 失败、`WinSta0` 拒绝访问、`SetCursorPos` 失败 —— 服务会话里没有可注入的交互桌面。
- **虚拟机（L3）**：能隔离但成本与依赖最重，用户明确排除。
- **把机器人号也留在外面（Ally 在外）**：曾经可行，但出站驱动仍然落在用户会话里，抢占问题原样存在。最终把机器人号也搬进隔离会话。
- **`-LogonType S4U` 跑保活**：最正统的"无窗口"解法，但注册被拒（缺批处理登录权限），改用 `pythonw`。
- **靠 `CREATE_NO_WINDOW` / `-WindowStyle Hidden` 压住弹窗**：实测都不够（见约束 2 的计数）——窗口创建发生在这些开关生效之前，且本机把控制台交给 Windows Terminal。最终改成"根本不 spawn 控制台子进程"。
- **"探针没回音也照样重连"**：等于让共享队列的忙闲决定 RDP 连接的生死，实测一次夸克网盘自动化就把连接误杀了一次；改为只对**有明确否定结论**的探针重连。
- **把保活探针换成截图/窗口枚举自证**：能绕开共享队列，但要在会话内起进程（又回到控制台窗口问题），收益不抵成本。最终采用的是**桥内 `/api/probe`**（进程内、无新进程、可只读可强校验）。
- **让保活直接读桥的 `/readyz`**：`/readyz` 只查"微信窗口是否存在"（UIA），客户端被最小化、会话失去输入桌面时它照样返回 `ready`，是假绿；因此另加 `/api/probe` 测输入桌面本身。

## Consequences

- 收益：机器人的收发完全在隔离会话完成，用户桌面不参与；桥的失败模式从"抢占 + 遮挡 + 沙箱"收敛为"客户端是否连着"这一条，且这条有保活兜底。用户桌面上的控制台弹窗归零（实测：同一条重连路径 133 秒内产生 **0** 个可见终端事件，修复前是每 1 秒一个）。
- 代价：多了一个必须活着的 RDP 客户端（`mstsc`）与一个 Windows 账号（`cwinprobe`）；隔离会话的资源占用与真实微信一致；保活/重连助手必须永远避开控制台子进程，这条约束会跟着每一次"顺手加一行 tasklist"复发。
- 已知缺口：① **投递没有握手** —— 发送失败不重传、不通知（账本里已积累数十条 `status=failed`），方案见 [投递握手提案](../../proposed/feature/2026-09-18-weflow-reply-delivery-handshake.md)；② 隔离会话内的 Agent Room executor 曾因串行执行卡死，文件队列 `C:\ProgramData\cwin-probe\s4\{in,out,done}` 是更可靠的后备通道，但它**是共享资源**：另一个 workload（实测夸克网盘 `q1..q10`）占用时队列会排队数分钟，保活探针已改走 HTTP，队列只作为退路。
- 遗留缺口（2026-09-22 实测，**未修**）：`scripts/shared-common.js` 的 `ensureWeFlowUiaBridge()` 在 8776 **探不通**时会删掉 PID 文件并**在 session 1 自己 spawn 一个桥** —— 这正是"两个桥抢 8776"的来源（一个在 session 1 看不到微信窗口，canary 触发就挂到 25s 超时）。端点恢复后它又因为 HTTP 通而"保留现状"，所以两个监听者可以长期并存。按本契约该走会话 4 的 `bridge-restart.ps1`，但仓库里还没有这条交接。
- 同类遗留（2026-09-23 实测，**未修**）：`cyberboss-service.ps1` 的 `Ensure-WeixinStarted` 用**跨会话**的 `Get-Process Weixin` 判"已经在跑"，缺失时又**在 session 1 `Start-Process` 微信** —— 这既是 18:14:50 那个野实例的来源，也让"session 1 有微信"永久掩盖会话 4 里微信已死/未登录。按契约它该交给会话 4 的 `wechat-restart.ps1`（脚本已入库）；本轮没改，是因为当时没有已登录的微信可用来验证这条交接。
- 桥多了一个 HTTP 契约 `/api/probe`（只读 / `?move=1` 强校验），它测的是"隔离会话的输入桌面"，与 `/readyz`（窗口存在性）不是一回事；改桥的探针语义要同步本笔记。
- **`/api/probe` 同时回报 `desktopIdleSeconds`**（隔离会话自己的空闲秒数，`GetLastInputInfo`，只读、不注入）。为什么必须由桥来报：看门狗跑在 session 1，它自己的 `GetLastInputInfo` 量的是**用户桌面** —— 于是"用户一动键鼠就把 canary 的空闲门槛按住"，canary 永远等不到重跑，记录里的陈旧失败也永远清不掉（2026-09-22 17:00 实测：本地 idle=51s，同一时刻隔离桌面 idle=**2327s**，而机器人侧 `userIdleSeconds=2221`）。看门狗的 `Get-DesktopInputIdleState` 现在**优先取桥的 `desktopIdleSeconds`**，拿不到才退回本地测量，返回值里多一个 `source` 字段标明来源（`isolated-session-bridge` / `local-session-fallback`）。改这个字段要同时改看门狗与保活。
- 部署脚本已入库到 `scripts/isolated-session/`（`rdp-keepalive.py` / `rdp-autologin.py` / `rdp-client.ps1` / `hidden-run.vbs` / `bridge-restart.ps1` / `weflow-restart.ps1` / `weflow-guard.ps1` / `wechat-restart.ps1` / `rdp-remote-guard.py` / `register-guard-task.py`）。
- **迁移缺口已闭合（2026-09-30）**：原先还留在 `C:\ProgramData\cwin-probe\` 且**从未入库**的配方现在都在仓库里 —— 三个被计划任务直接引用的（`bot-direct.cmd`、`s1-restack.ps1`、`s1-mstsc-offscreen2.ps1`）加上队列工人与启动链条（`s4-worker.ps1`、`session-bootstrap.ps1`、`s4-start-stack.ps1`、`restart-worker.ps1`、`rerun-s4-stack.ps1`、`start-wechat-stack.cmd`）。在这之前"在新机器上从仓库重建这套部署"是不成立的：任务动作指向的文件根本不在仓库里。
- **计划任务变成可重建的声明**：`scripts/isolated-session/register-tasks.py` 声明全部 11 个任务，路径由脚本位置推导（`CYBERBOSS_REPO_ROOT` / `CYBERBOSS_QUEUE_ROOT` / `CYBERBOSS_PYTHON(W)` / `CYBERBOSS_NODE_EXE` 可覆盖），走 Schedule.Service COM（不 spawn `schtasks.exe`，硬约束 2）。实测注册→读回→删除走通，零残留。两个实测坑：XML 的 `RunLevel` 只能写 `LeastPrivilege`（COM 层面显示为 `Limited`）；`cwin-s4-worker` 这个任务在本机已不存在，工人现在由 `cwin-s1-session-bootstrap`（登录触发）拉起。
- **机器绑定清零**：这些脚本里的绝对路径改由环境变量或 `machine_paths.py` / `queue-root.ps1` 推导，唯一保留的字面量是"env 查找的兜底默认值"；`npm run verify-portable` 现在 0 容忍其余形式（基线文件已删除）。
- **凭据**：`rdp-autologin.py` 原先内联隔离账号明文密码，现改为 `CYBERBOSS_ISOLATED_ACCOUNT_PASSWORD`，缺失即**启动失败并说明原因**。该字面量从未进入本契约所在的分支提交，但存在于 `main` 的未推送历史里 —— 操作者需轮换该账号密码。

**读侧看门狗 `cwin-weflow-guard`（2026-09-23 起）**：WeFlow 的 `/api/v1/health` 一直 200，但 `/api/v1/messages` 会突然变成 **HTTP 500**，此时机器人**一条消息都读不到**（表现为"又不回复"）。2026-09-18 至 09-23 之间实测复发 **3 次**，而服务控制器在"health 通、消息 500"这一支是**刻意保留进程**的，看门狗的修复路径也够不到会话 4 的程序 —— 所以每次都要人发现。

现在 `scripts/isolated-session/weflow-guard.ps1` 每 15 分钟（计划任务 `cwin-weflow-guard`，走 `hidden-run.vbs` 静默执行）打一次 messages API：健康就记一行 `reader healthy`；非 2xx 就把 `weflow-restart.ps1` 丢进 `C:\ProgramData\cwin-probe\s4\in`，由会话 4 的 worker 执行重启（幂等：已在队列里就不重复投）。日志 `C:\ProgramData\cwin-probe\repair\weflow-guard.log`。

**教训（第二次踩）**：这个仓库里**含非 ASCII 的 `.ps1` 必须带 UTF-8 BOM**，否则 PowerShell 5.1 按 GBK 读，脚本直接解析失败（2026-09-18 的 `cyberboss-watchdog.ps1` 就是这样整体停摆 4 天）。`weflow-guard.ps1` 因此刻意写成纯 ASCII。

**搜索结果稳定性窗口（2026-09-23 修）**：微信在 18:19 被更新程序重启后，桥的发送开始稳定失败，日志给出确切原因 —— `target not confirmed: … ordered search content identity had not repeated yet (polls=1, window=2.0s)`：桥需要**连续两次看到同一份搜索弹窗内容**才敢按 Enter，而窗口只有 2.0 秒，慢的时候只轮询到 1 次，于是 fail-closed 完全发不出去（表现为"又不回复"，且与空间/抢桌面无关）。修法：`MAX_SEARCH_RESULT_STABILIZATION_SECONDS` 3.0 → **12.0**，并新增下限 `MIN_SEARCH_RESULT_STABILIZATION_SECONDS = 6.0`，窗口取 `max(下限, min(上限, 调用方超时))`，保证至少有两次轮询的时间。修复后实测 `POST /api/send → dispatched=true verified=true`。

**会话号会变，脚本不得硬编码（2026-09-24 实测）**：重启后隔离会话的 id 从 **4 变成 3**，于是 `weflow-restart.ps1` 里 `Where-Object { $_.SessionId -eq 4 }` 的"杀旧进程"一步**什么都没杀**，旧 WeFlow 继续拿着失效的库密钥占着 5051，读侧恒 500 —— 白排查数小时。同一坑当天出现三次（另一个会话的 `rdp-remote-guard` 也按 session 4 写死）。因此所有脚本一律按**进程名/路径/端口**定位，禁止按会话号筛选。

**启动器的桥检查会误判并拒绝启动机器人（2026-09-24）**：`shared-start.js` 校验桥的 pid 文件时会读那个进程的命令行；桥以 cwinprobe 身份跑在隔离会话里，session 1/2 的启动器**读不到它的命令行**，于是报 `WeFlow UIA bridge already_running_unknown_pid pid=…` 并**拒绝拉起机器人本体**；即使勉强起来，运行时也会 `dsh request timed out: initialize`（回合起不来 → `pendingInbound` 积压、`reply obligations reached no-reply timeout` = 用户看到"不回复"）。绕过办法：`cwin-s1-bot` 任务 + `bot-direct.cmd` **直接执行 `node bin/cyberboss.js start --checkin`**，不经过启动器的桥校验。

**状态目录原子写被拒（复发性根因）**：`EPERM: operation not permitted, rename '…\.cyberboss\.weflow-inbox-cursor.json.tmp'` 反复出现，打断入站/回声轮询 → 入站积压 → 不回复。怀疑杀软/索引器实时扫描 `C:\Users\79388\.cyberboss\`；待办：写入加"重试+退避"，并把游标目录迁到 `D:\`。

**心跳窗口与重启通知必须用不同窗口（2026-09-28）**：`cyberboss-watchdog-restart-notification.js:496` 的 `assertTargetIsolation` 会**抛错**拒绝"通知窗口 == 心跳窗口"（防止两类流量在账本里混淆）。现在：重启通知 → `wxid_s3178hwvzsl922`（Azzy 自聊，`CYBERBOSS_WATCHDOG_NOTIFY_CHAT`），心跳 → `wxid_6r2qv9w2hgth22`（另一个 Azzy 会话）。看门狗新增 `CYBERBOSS_WATCHDOG_NOTIFY_CHAT/_DISPLAY_NAME` 两个键，缺省回落 inbox。

**原子写被拒（EPERM）已加退避 + 兜底（2026-09-28）**：`C:\Users\79388\.cyberboss\` 下的原子写在 Windows 上会被 `rename()` 返回 `EPERM/EBUSY/EACCES` —— 目标文件被别的进程打开时就会这样（杀软实时扫描、搜索索引器、或第二个读者）。症状是入站/回声轮询被反复打断（`EPERM … rename '.weflow-inbox-cursor.json.<pid>.<ts>.tmp'`）→ 入站积压 → 表现为"不回复"。修法（`src/integrations/weflow-inbox.js: writeJsonAtomic`）：rename 失败时按 25/75/150/300/600 ms 退避重试 5 次；仍失败则**拷贝到目标并删除临时文件**（记一条 `atomic write fell back to in-place` 警告）——原子性让位于"游标必须能推进"。

**离线回归测试（2026-09-28）**：`test/weflow-inbox-atomic-write.test.js` 用 `vm` 加载 `writeJsonAtomic` 的真实函数文本，再起一个子进程把目标文件按只读句柄占住（Windows 上这种占用会让 `rename()` 返回 `EPERM`），跑两个场景：占 400 ms → 退避重试救回（实测 567 ms，未走兜底）；占 2500 ms → 重试到顶走原地拷贝（实测 1168 ms，数据完整）。两个场景都断言不留 `.tmp`。跑法：`node test/weflow-inbox-atomic-write.test.js`。
