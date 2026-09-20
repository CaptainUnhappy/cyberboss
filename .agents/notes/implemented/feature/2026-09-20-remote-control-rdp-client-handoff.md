# Agent Note: 远控期间自动让出 RDP 客户端（会话绑定冲突的守卫）

Status: implemented

## Problem

[RDPWrap 隔离会话部署契约](../process/2026-09-18-rdpwrap-isolated-session-deployment.md) 要求"必须存在一个已连接、未最小化的 RDP 客户端"，代价是机器上长期存在**第二个属于同一账号的交互会话**（session 4）。远控工具（ToDesk / GameViewer）的被控端在选择投屏会话时会挑中那个 RDP 会话，于是从外部远控进来的人看到的是 RDP 通道里的画面、键鼠也被送进那边。

2026-09-20 09:36 的 ToDesk 日志是这套冲突的实证：

```
09:36:00  [SystemLockMonitor] Current session ID: 4, isServiceProcess: false   ← 被控端进程落在 RDP 会话
09:36:22  detectDesktopSourceUpdate screens count 0                            ← 采集源消失
09:36:22  SendInput fail err = 5   ×21                                         ← 注入键鼠被拒
09:36:23  processSessionCloseEvent: Received close event / session conn destroy
09:36:30  start session pid = 30844 → Current session ID: 1                    ← 回落到 console 会话
```

对照 9-18 那份 `sessionkgypwcve_2026_09_18.log`：当天 10 次被控端进程**全部**绑定 session 1，且全天 `SendInput fail` = 0 次。也就是说，冲突只在 RDP 客户端活着的时候出现；用户当时的绕法是**手动关掉 RDP 客户端**再远控。

要解决的是这个绕法：远控开始时自动让出 RDP 客户端，远控结束时自动把它接回来。

## Decision

新增守卫 `scripts/isolated-session/rdp-remote-guard.py`，由计划任务 `cwin-s1-rdp-remote-guard` 拉起（注册脚本 `register-guard-task.py`）：

| 项 | 事实 |
|---|---|
| 形态 | **常驻进程**（`--loop-seconds 0`），每 5s 判一次；任务触发是**登录时**，`ExecutionTimeLimit=PT0S`（无上限） |
| 身份 | 当前交互用户，`InteractiveToken` + `HighestAvailable` —— 不需要管理员 |
| 模型 | **"连接那一刻让一次路"**：杀掉客户端 → 等让出窗口（`RESTART_AFTER_SECONDS`=60s）→ **主动触发重连把 RDP 拉回来** → 回空闲 |

**模型改版的依据（2026-09-20 用户实测）**：ToDesk 连上并让 RDP 让路后，**手动重开 RDP，主桌面照常可用** —— 远控与 RDP **可以共存**。所以守卫不需要"按住整个远控期间"（那会让机器人整段时间发不出消息），只需在连接那一刻把 RDP 让开、等远控工具从 session 4 改绑到 session 1（实测 4–8 秒），随后把 RDP 还回去。

状态机：

```
idle  --(远控日志开始增长 且 mstsc 在跑)-->  yield  杀掉 mstsc，起 60s 窗口
yield --(窗口未到)-->                       yield  保持（suspend 信号挡住保活抢跑）
yield --(窗口到期)-->                       idle   触发 cwin-s1-rdp-reconnect
yield --(mstsc 已被保活/人工拉回)-->        idle   窗口提前结束
```

`rdp-client-suspend.txt` 仍在窗口期刷新，但语义变了：以前是"整个远控期间禁止重连"，现在只是"窗口内别抢跑"，防的是守卫在窗口里死掉（过期 600s 后保活恢复自愈）。

**形态的由来（踩过两次）**：先用"每 2 分钟 `CalendarTrigger` + 内部循环 100s"，实测任务注册成功（`state=3`）却**从不执行**（`last_result=0x41303` 从未运行、无日志）；手动 `schtasks /run` 则能跑（`last_result=0x267009` = 正在运行）。也就是说这台机器上重复触发不生效、手动触发正常，于是改成登录触发的常驻进程——换掉了整个"脉冲"设计。守卫每次脉冲无条件写 `pulse start` / `pulse end` 心跳，就是为了下次一眼分辨"任务没跑"和"跑了但没判定"。

**检测信号（只看"会话日志的字节增长"，且只认已实证"仅在被控期间增长"的文件）**：

| 目录 | 文件名模式 | 覆盖 |
|---|---|---|
| `D:\Program Files\ToDesk\Logs` | `session*.(log\|xlog)`（含 `sessionWEBRTC_*` / `sessionZRTC_*`） | ToDesk / UU远程(ToDesk) ✅ |

判定 = 最近 45s 内看到过增长；空闲时实测**零文件增长**（`--list-candidates` → `growing while idle: 0`）。

**UU远程 = GameViewer（同一个程序）目前是未覆盖的**：`UU远程.lnk` 指向 `Netease\GameViewer\GameViewer.exe`。它的候选日志全试过，没有一个是"只在被控期间增长"的（见下表的坑 4）。因此在用 UU远程 远控时守卫**不会让出 RDP**，用户会看到 session 4 的画面——回退到"手动关掉 RDP 客户端"的老办法，直到找到 UU 的可信信号。

**判据被砍过四轮，四轮都是"把本地常驻日志当成远控在场"的误判**（每一次的代价都是 RDP 被按死、机器人只收不发）：

1. **砍掉"mtime 新鲜"弱信号**：会话结束后日志仍可能被写（实测 10:49 还在增长却无人远控）。增长没有歧义，新鲜度有。
2. **排除客户端日志**：`GameViewer\log\client\Log\*.slog` 是 GUI 常驻日志，客户端开着就一直写（10:39–10:49 按住 600s+）。
3. **排除服务/本地 streamer 日志**：`GameViewer\log\server\log\log_*.slog`、`streamer_log_controlled_*.slog`、`ToDesk\Logs\service*_<日期>.log` 在本地 GUI 活动时也写（实测空闲 +320B/15s，11:58:02 又误杀一次刚重连的 mstsc）。
4. **砍掉 `connection_log_controlled_*.slog`（UU/GameViewer 唯一的候选）**：看着像"被控会话"日志，实测**没有远控时也持续增长**（+6110B/20s）——它记的是当前**本地流会话**。代价是 UU 从此不被覆盖，但误判会永久按住 RDP，比漏判贵得多。
5. **进程信号只认"刚启动"的实例**：`ToDesk.exe` 空闲时也常驻（9-16 起就有一个），只看名字会让守卫永远放不开 RDP。改为 `GetProcessTimes` 取创建时间，年龄超过 `YOUNG_PROC_SECONDS`（7200s）就当常驻、不构成"在场"。

排障入口：`--list-candidates` 列出纳入监视的日志并采样看谁在增长。**空闲时必须是 0**；只要看到常驻文件在里面，判据就错了。

**长按住的次生故障**：被按住约 10 分钟后桥的 `/readyz` 会超时（8776 进程还在，但隔离会话没有输入桌面），`/api/probe` 退化为 `{"ok": false, "foreground": 0}`。所以"误判按住"不只是延迟回复，还会让机器人整段时间发不出消息——这是判据必须偏保守的原因。

**运维坑（重启任务时）**：`Stop-ScheduledTask` + `Start-ScheduledTask` 会让**新旧两个守卫实例同时存在**最多 100s（旧实例不会立刻死），旧实例可能用旧判据再误杀一次。改完代码重启后，等一分钟确认只剩一个 `pythonw` 再下结论。

**状态机与防抖**：连续 2 拍判定在场才动手；按住至少 45s 才允许放行；最长按住 6 小时兜底强制放行（避免守卫逻辑故障时永久占住 RDP）。

**两个文件，两种语义（不要合并）**：

- `rdp-client-hold.txt`（沿用既有约定）：控制台窗口摆位 —— 保活看到它就把客户端摆在 `(0,0)`，否则停靠屏幕外。操作员 `-show` 也写它。守卫**不再写它**（它只影响摆位，与让路无关）。
- `rdp-client-suspend.txt`：让出窗口内的"别抢跑"信号，守卫每拍刷新；`rdp-keepalive.py` 触发重连前检查它，新鲜（≤600s）就 `exit 3` 停手。

**为什么不让 hold 文件兼任"禁止重连"**：实测它并不能阻止保活重连（10:05:34、10:25:34 两次都是"客户端不在 → 触发重连"，hold 只在摆位时被提到）。而把 hold 变成"禁止重连"会让操作员用 `cwin-s1-rdp-show` 看会话桌面时把客户端永久挡在门外。新鲜度过期是**故障安全**：守卫一死，10 分钟后保活恢复自愈（每 5 分钟一拍，实测 10:35:33 触发、10:37:44 恢复）。

## 实测证据（2026-09-20）

在真机、ToDesk 会话进行中跑真实守卫（非 dry-run）：

```
10:01:06  守卫：REMOTE ACTIVE -> engaged: killed mstsc.exe pids=[35480]
10:01:08  ToDesk：processSessionCloseEvent → session conn destroy
10:01:12  ToDesk：start session pid = 22996 → Current session ID: 1
10:01:12  ToDesk：Screen 0 capture started
```

**远控不需要重连**：session 4 的被控端进程随 mstsc 之死而销毁，ToDesk 服务随后自动重建并绑定 session 1，约 4 秒完成。这正是用户想要的效果——他只需等几秒，屏幕就是自己的桌面了。

保活联动也实测过（同一场会话）：

```
10:40:30  保活：client(re-assert): no RDP client window
10:40:33  保活：remote-control suspend active -> not reconnecting (guard owns the client)
```

常驻形态落地后的活体证据（`pythonw` pid=19468，登录触发）：

```
10:45:13  pulse start loop=0s poll=5s resume_hold=True     ← 常驻，无 pulse end
10:46:03  holding (405s): mstsc.exe=[] ...                 ← 每 5s 一拍持续按住
suspend 文件 age=2.7s                                       ← 信号持续刷新
```

窄判据落地后的稳定态（pid=14124，观察 95s 无动作）：

```
11:58:41  pulse start loop=0s poll=5s resume_hold=True
11:58:46  removed hold file / removed suspend file
11:58:46  remote gone -> reconnect rc=0 started via Schedule.Service
（之后 95s 内没有 engaged / holding）
mstsc=19168  hold=False  suspend=False  bridge={"ok": true}
```

对照：宽判据时代同一台机器上被误杀三次（`11:56:26`、`11:58:02`，以及 10:39–10:49 的 600s+ 长按住）。

## 运行约束与已知缺口

1. **守卫只能从计划任务跑，不能从 agent 会话 `Start-Process`** —— 与部署契约第 3 条同因（沙箱/AppContainer 继承）。
2. **`C:\ProgramData` 的子进程写入会被 DSH 沙箱拒**（实测 `PermissionError: [Errno 13]`），所以守卫支持 `--paths-dir` 把暂停文件/日志/状态整体改到仓库内做自测；生产默认值仍指向 `C:\ProgramData\cwin-probe`。
3. **沙箱里起的 mstsc 加载不了 `.rdp` 里那份用户态 DPAPI 凭据**，报"安全包中没有可用的凭证"（已截图 `tmp\cwin-lab\rdp-error.png`）。后果：RDP 客户端**必须**由计划任务/用户上下文拉起，agent 会话里不要试图代劳。
4. **沙箱内查不到计划任务**：`schtasks /query`、`Get-ScheduledTask`、`Schedule.Service` COM 的 `GetFolder('\')` 全部报 `0x80070003`。守卫任务因此由用户手动执行注册脚本完成，agent 侧无法验证注册结果。
5. **按住期间机器人"能收不能答"**：实测此时桥探针返回 `{"ok": false, "foreground": 0}`，UIA 发送路径失效，回复只能按既有约定转 `deferred_durable`。这是方案的固有代价，不是缺陷。
6. **GameViewer 只验证了信号侧**（其 `.slog` 确实在被控时增长），端到端改绑未单独复现。
7. **重复触发在这台机器上不生效**：`CalendarTrigger` + `PT2M` 注册成功却从不执行，登录触发 + 常驻才跑得起来。以后给这台机器加周期性助手，优先考虑"登录常驻"而不是"短周期重复"。
8. **脚本路径是硬编码的绝对路径**（`D:\Tools\miniconda3\pythonw.exe`、仓库在 `D:\Projects\cyberboss`），换机器/换 Python 要改 `register-guard-task.py` 顶部常量。

## Alternatives considered

- **方案 A（本轮之前我提的）：操作员手动开关** —— 沿用 `rdp-client-show/-hide` 的模式，远控前手动停 RDP、远控后手动恢复。最强理由是零新进程、零误判风险、完全可预测。否决原因：用户明确要"自动"，而这一步是**每次远控都要做**的重复劳动；守卫把同一件事做成幂等的自动行为，且保留了暂停文件作为人工覆盖点。
- **B：让保活重连失效，需要时才手动拉起 RDP** —— 最强理由是彻底消除第二个会话，冲突从根上不存在。否决原因：与部署契约"必须存在已连接的 RDP 客户端"直接冲突，机器人会长期处于发不出消息的状态。
- **C：把 RDP 客户端停到屏幕外/最小化，不改会话** —— 最强理由是改动最小。否决原因：**最小化会让隔离会话失去输入桌面**（契约第 1 条已实测），而停到屏幕外根本不改变"session 4 存在"这个事实——远控工具挑会话与窗口位置无关。用户"必须关掉 RDP"的实测也已证明位置不是变量。
- **D：靠远控工具的配置让它绑定 console 会话** —— 最强理由是治本、无自建进程。否决原因：ToDesk 没有会话选择项（注册表、`config.json`、日志里都只有它自己的自动判定），且这条依赖第三方产品行为，不可控、不可测。
- **E：把"检测 + 让出"合并进既有的 5 分钟保活脉冲** —— 最强理由是零新进程、复用已验证的 `Schedule.Service` 触发路径。否决原因：5 分钟粒度意味着远控用户可能对着错误画面等满 5 分钟；保留独立守卫才有秒级响应。守卫与保活之间用 suspend 文件单向通信（守卫写、保活读），避免两个进程互相等锁。
- **E2：每 2 分钟重复触发的短命守卫** —— 本轮先实现了它（`PT2M` + 内部循环 100s），最强理由是进程不常驻、崩了下一拍自动恢复。实测在这台机器上**重复触发根本不执行**（`last_result=0x41303`），手动跑却正常，于是整体换成登录触发的常驻进程。
- **F：用 `WTSQuerySessionInformation` 判断"哪个会话是被投屏的"** —— 最强理由是直接测量远控工具的绑定结果，比日志启发式更本质。否决原因：该 API 只能回答活跃/连接状态，回答不了"ToDesk 选了谁"；真正可靠的私有状态在远控工具进程内，不值得为它注入或读内存。

## Consequences

- 收益：远控不再需要手动关 RDP，实测让路后 4 秒内远控工具就改绑到 console 会话；RDP 在让出窗口（60s）结束后自动回来，**不需要等到远控结束**，机器人只中断约一分钟。
- 代价：多了一个常驻的 `pythonw` 守卫进程（纯 Python，只做文件时间戳与 Toolhelp32 枚举，每 5s 一拍，无控制台窗口）；每次远控连接会让机器人中断约 60 秒（期间回复转 `deferred_durable` 排队）；`rdp-keepalive.py` 为此多了 suspend 检查（唯一被改动的既有脚本）。
- **未验证** → **2026-09-20 已闭环**：完整走通"ToDesk 连接 → 守卫让路 → 远控改绑 session 1 → 60s 后守卫自动重开 RDP → **ToDesk 仍能操控主桌面**"。远控与 RDP 共存成立，用户确认"完美"。
- 误判风险：检测建立在第三方日志的写入行为上，ToDesk/GameViewer 若改变日志策略（换目录、换扩展名、把常驻日志写进被监视目录）会让守卫失灵。失灵方向分两种：**漏判**（不再让出 RDP，回到手动关的老路，安全）与**误判**（把空闲当成远控在场，RDP 被永久按住——已踩过两次，见上文的判据修订）；误判的兜底是 `MAX_HOLD_SECONDS`（6 小时）强制放行。
- 未验证的降沿：远控结束 → 守卫删两个文件 + 触发 `cwin-s1-rdp-reconnect` 这条路只在代码与 dry-run 层验证过，真机降沿要等下一次完整远控会话结束才能确认。
- 与部署契约的关系：契约第 1 条仍是事实（RDP 客户端必须活着），本笔记是它的**例外窗口**——远控进行中允许它不存在，由守卫负责在窗口关闭后把它接回来。
