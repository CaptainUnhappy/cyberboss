# Agent Note: 看门狗也用「端点属主」把陈旧的桥 PID 文件修回来（不再只做校验）

Status: implemented

## Problem

2026-09-29 上午，`uia` 单组件故障连续两拍被判失败，代价却是**一次健康核心的重启**：

- 10:44:37 心跳：`uiaBridge = {pid:23088, alive:false, processAlive:false, identityVerified:false, health:true, ready:true}` —— pid 文件里的 23088 已经死了，而 8776 上的桥活得很好（`/healthz {ok:true}`、`/readyz {ok:true,wechatWindow:true}`、`/api/probe` 正常答 `desktopIdleSeconds`），实际属主是 PID **37756**。
- 10:59:41 同一指纹确认 2/2 → `plannedRepair=Restart` → `cyberboss-service.ps1` 的恢复路径 **能**修：`WeFlow UIA Bridge PID file recovered from the sole endpoint owner PID 37756 (identity by endpoint ownership)`；但同一个 `Restart` 动作接着把 `Stopping Bridge process tree rooted at PID 38460`（那是**健康的机器人**）停掉、另起 33348。
- 也就是说：桥的**记账落后**（pid 文件没跟上一次野重启）被读成「桥死了」，而这个判定换来的是机器人被重启 —— 与 09-28 那次核心 pid 文件问题的形态一模一样，只是这次落在跨账号的桥上。

为什么只校验不够：`Test-UiaBridgePidVerified` 的判据（命令行**或**端点归属）只回答「文件里记的这个 PID 是不是桥」，**不回答「文件里没有桥的 PID 时该记谁」**。桥活在自己的会话里、由自己的配方（`scripts/isolated-session/bridge-restart.ps1`）重启，重启后 pid 文件可能滞后或缺失（09-28 的桥是 14596 → 23088，09-29 换成 37756，两次都出现过滞后）。服务脚本从 2026-09-22 就有恢复函数（`Repair-PidFileFromListener -AllowEndpointOwnership`），看门狗一直没有 —— 于是每次野重启都要等一次机械 `Restart` 才把文件补齐，而那一次 Restart 会顺手重启机器人。

## Decision

`scripts/cyberboss-watchdog.ps1` 新增 `Repair-UiaBridgePidFileFromListener`，并在 `Get-HealthSnapshot` 里于 `Test-UiaBridgePidVerified` 失败后调用：

- 判据与服务同源：`$UiaBaseUrl` 必须是 loopback 且端口解析得出；`Get-TcpListenerProcessIds` 在该端口上**恰好一个**监听者；该 PID **存活**；且与 pid 文件里的值**不同**（相同就什么都不做）。
- 满足则用 `Write-PidFileAtomic` 原子写回，并往看门狗日志写一条 `uia bridge PID file recovered from the sole endpoint owner PID <n> (identity by endpoint ownership)`；然后快照用这个 PID 重算 `$uiaPid` / `$uiaProcessAlive` / `$uiaAlive`。
- 不满足（0 个或多个监听者、PID 已死、文件已经正确）→ **什么都不做**，绝不抛错：这是观测路径，看门狗崩掉比漏报更糟（服务脚本那条同源分支会 throw，看门狗不能照抄）。
- 真正的桥死了依然会被归因：没有存活的唯一监听者就没有采纳，`uiaAlive` 仍为 false。

## Alternatives considered

- **维持现状，让服务在机械 Restart 时恢复**：这就是本次现场 —— 文件确实被补上了，但代价是「桥的记账问题 → 重启机器人」。09-28 修核心、09-29 修桥，都是同一类代价，不能再留。
- **让桥自己启动时写 pid 文件**：覆盖它自己的重启路径最根治，但桥是 `python` 脚本 + 会话内配方，野启动（文件队列、手工 `pythonw`）仍可能绕过；而且本次故障的判据在**看门狗侧**，修在判据侧才能立即止血（与 09-28 核心那篇的取舍一致）。
- **把校验放宽成「端点健康即视为存活」，但不修文件**：能消掉误报，但 pid 文件仍然是错的 —— 服务脚本的停机/重启路径、维修工读到的现场都还在用一个死 PID，等于把问题推给别人；而且每次心跳都要重新走一遍「文件错 → 端点对」的推理。
- **在观测路径上照抄服务脚本的 `throw`**：端点开着但属主无法唯一确认时，服务可以中止（它要动手改状态）；看门狗只是观察，抛错会把整拍心跳打成 `heartbeat error`（09-28 11:47 的 `NO_PROXY` 就是这样把一次机械修复打断的），反而更危险。

## Consequences

- 收益：桥的野重启不再被读成「桥死了」，因此不再换来机械 `Restart`，也不会连带重启健康的核心 —— 和 09-28 的核心 pid 文件修复合起来，「陈旧 pid 文件」这一类误判在两个组件上都自愈了。
- 收益：判据与服务脚本同源（端点属主），两边不会再各说各话；文件被修好之后，服务/维修工读到的现场也一致。
- 代价：看门狗在检测路径上多写一个文件（桥的 pid 文件），且多一次 TCP 表查询；只在「记录不可校验」时发生，且是原子替换。健康路径无额外开销。
- 实测（2026-09-29 11:07，持 `Local\CyberbossHeartbeatWatchdog` 互斥体复刻现场）：把 `weflow-uia-bridge.pid` 写成 23088（复刻事故）→ `Get-HealthSnapshot` 给出 `uiaBridge={pid:37756,alive:true,processAlive:true,identityVerified:true,health:true,ready:true}`、失败组件为空（`''`），pid 文件被修回 37756；直接调 `Repair-UiaBridgePidFileFromListener` 也返回 37756。
- 环境注记：`Get-NetTCPConnection` 与写 `C:\Users\79388\.cyberboss\` 在带沙箱的 agent 会话里被拒，复刻需要在放宽沙箱的上下文里做；看门狗自身（计划任务、无沙箱）不受影响。
