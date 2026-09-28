# Agent Note: 陈旧的 shared-wechat.pid 不再被读成「核心已死」——从新鲜 pipeline activity 采纳真实 PID

Status: implemented

## Problem

2026-09-28 早上，心跳报了一个**假的**核心故障，并因此做了一次有破坏性的机械重启：

1. 09:37 用户改了 `.env`（canary 目标 `Ally` → `Azzy`，留了备份 `.env.bak-canary-20260928-093755`），09:45:14 用 `C:\ProgramData\cwin-probe\bot-direct.cmd`（`node bin\cyberboss.js start --checkin`）**直接**起了一个新 bot（PID 18704）。这条路不走 `shared-start.js`，所以 `C:\Users\79388\.cyberboss\logs\shared-wechat.pid` 里还是旧值 `33708`（09-27 那轮之后就死了）。
2. 心跳因此把 `cyberboss` 判成 `pid=33708, alive=false, identityVerified=false`，把 `activity` 判成 `activity_pid_mismatch`：`Get-PipelineActivityHealth` 的 `ExpectedPid` 来自那份陈旧 pid 文件，而 activity 快照里写的是 18704。10:14:54 同一指纹确认两次后，触发机械 `Restart`：`cyberboss-service.ps1` 先按 activity 把 pid 文件恢复成 18704，**再把 18704 整棵进程树停掉** —— 一个正在每秒钟写 activity、09:48 还在跑真实对话（`lastTurnCompletedAt=01:48:25Z`）的 bot 被杀，随后另起 31424。
3. 故障形态是「**记账落后于事实**」，不是「进程消失」。只读 pid 文件时，这两种情况的快照一模一样 —— 但后果完全不同：前者重启是纯破坏，后者重启才是修复。`bot-direct.cmd` 这类现场启动方式（改完 `.env` 立刻生效）天然不写 pid 文件，所以这不是一次性意外。

## Decision

`scripts/cyberboss-watchdog.ps1` 的 `Get-HealthSnapshot`：pid 文件里的 PID 通不过 `Test-VerifiedPidAlive` 时，**先尝试用新鲜 pipeline activity 反证存活**，再决定「核心已死」：

- 新增 `Repair-BridgePidFileFromActivity`（判据与 `cyberboss-service.ps1` 里的同名函数一致）：activity 快照 schema 可解析、`updatedAt` 在 120 秒内、其 `pid` 进程存活 **且命令行匹配 `$BridgeCommandPattern`** → 采纳该 PID、原子重写 pid 文件（新增 `Write-PidFileAtomic`），并往看门狗日志写一条 `core PID file recovered from fresh pipeline activity PID <n>`。
- 采纳后 `$bridgePid` / `$bridgeAlive` / `$bridgeProcessAlive` 都按真实进程计算，下游 `Get-PipelineActivityHealth -ExpectedPid $bridgePid` 随之对齐：快照由 `cyberboss alive=false + activity_pid_mismatch` 变成 `cyberboss pid=<bot> alive=true verified=true + activity healthy`，失败组件为空。
- 反向保护（这是「不掩盖真崩溃」的关键）：activity 陈旧/缺失、PID 已死、命令行不匹配（不是 bot）→ 一律不采纳，真崩溃照旧被归因，不会因为「120 秒前刚写过 activity」而被判成健康。

写之前检索了 `.agents/notes/`（proposed + implemented + rejected）：同主题只有 [RDPWrap 隔离会话部署契约](../process/2026-09-18-rdpwrap-isolated-session-deployment.md) 第 7 条「跨账号进程的身份只能用端点归属证明」。那是**跨账号**（命令行读不到）的桥；本篇是**同账号**（命令行读得到）的核心 bot，判据从「端点归属」换成「新鲜 activity + 命令行」，原理相同、落点不同，因此新开一篇并双向互链，不改那篇的结论。「看门狗与维修工会话」那篇讲的是故障怎么交给人修，与本篇的判据无关。

## Alternatives considered

- **让 bot 自己写 pid 文件**（`bin/cyberboss.js` 启动时写、退出时删）：覆盖所有启动路径，最根治。但它动的是运行时启动契约，影响每次启动与所有部署，而且 pid 文件的所有权会从 launcher 转到 bot，`shared-start.js` 的 `child.on("exit") → removePidFileIfMatches` 与 `ensureBridgeNotRunning` 的去重语义都要跟着改。本轮只修「误报」这一侧，把「记账」留在原位。
- **只让 `bot-direct.cmd` 自己写 pid 文件**：那是 `C:\ProgramData` 里的现场脚本，不受仓库纪律约束；换台机器、换个人手工起 bot 又会漏。修在判据侧才收敛。
- **发现 pid 文件与 activity 不一致就直接重启**：这正是本次事故里造成伤害的动作（把「记账落后」升级成「服务中断」），等于保留 bug。
- **放宽成「activity 新鲜就算活着」**：会把「bot 崩了但 120 秒前刚写过 activity」误判成健康。必须叠加「PID 存活 + 命令行匹配」两条独立证据。

## Consequences

- 收益：机械 `Restart` 不再因为陈旧 pid 文件而杀掉正在服务的进程；用户手工启动 bot（例如改完 `.env` 直接 `node bin\cyberboss.js start`）这种现场操作不再被误判成故障，也不会白吃反抖动预算（4 次/天）。
- 收益：看门狗与 `cyberboss-service.ps1` 的恢复判据同源，两边不会再各说各话。
- 代价：看门狗在**检测**路径上第一次落盘（原子重写 pid 文件）。写的是它自己刚刚验证过的事实，且只在 pid 文件校验失败时发生；健康路径只多一次 activity 解析。
- 实测（2026-09-28 10:19:56，持有 `Local\CyberbossHeartbeatWatchdog` 互斥体复刻事故现场）：把 pid 文件写成 `33708` → `Get-HealthSnapshot` 给出 `cyberboss pid=31424 alive=True verified=True`、`activity healthy=True reason=""`、失败组件为空，并把 pid 文件修回 31424；activity 陈旧两小时、或 activity 里的 PID 指向非 bot 进程时，采纳函数都返回 0。
- 环境注记：本机 `Get-CimInstance Win32_Process` / `Get-WmiObject` 在带文件沙箱的 agent 会话里被拒（同一句在无沙箱上下文里可见 421 个进程），所以命令行判据必须在看门狗/服务的真实上下文里验证，agent 会话内的复刻要放开沙箱才准。
