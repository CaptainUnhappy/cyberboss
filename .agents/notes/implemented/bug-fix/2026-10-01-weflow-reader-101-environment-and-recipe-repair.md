# Agent Note: WeFlow 读侧 `-101`（电脑环境问题）不可在会话内自愈 + 读侧重启配方被拼接坏了

Status: implemented

## Problem

2026-10-01 00:09 起，读侧出现本机第一次见到的错误码：

- `/api/v1/health` 200，`/api/v1/messages` **500 `{"error":"错误码: -101"}`**；看门狗判 `weflow=messages_http_500` + `inboxQueue=main_outgoing_poll_stale`，00:59 触发机械 `FullRestart`。
- 机械 `FullRestart` **没跑起来**：`cyberboss-service.ps1:829` 抛 `local WeFlow API port 5051 has an unverifiable owner; local services were left running`，看门狗记 `repair_failed`。原因是 WeFlow 的功能身份判据（`Test-WeFlowFunctionalReady`）要求该监听者能用本项目 token **答出一条 `/api/v1/messages` 查询** —— 而这条查询正是坏的，于是「症状」把「身份证明」也一并打断了，任何 WeFlow/FullRestart 修复在动手前就中止。
- 现场还有第三个问题（验证时才暴露）：`node scripts/repair-verify.js` 拿到 `HTTP 502 {"error":"WeChat main window could not be activated"}`，即**写侧也发不出去**。

## Decision

**1. 先定性 `-101`：它是 WeFlow 自己的「电脑环境问题」，属于外部阻塞，会话内修不了。**

WeFlow 自带错误参考页（`analysis\weflow620\asar-src\dist\assets\ErrorReferencePage-*.js`）写明：`-101 / -1000 / -1005 ～ -1010` 同属一组，`category=special, level=blocking, stage=数据组件启动`，`summary=当前电脑环境不适合数据组件正常运行`，`causes=[当前电脑环境阻止数据组件正常运行]`，`actions=[关闭杀毒软件和系统安全防护后重新启动 WeFlow, 仍然出现时更换另一台电脑运行]`。也就是原生组件在**打开数据库之前**就拒绝了环境，所以「重启 WeFlow / 重建锚点」这类动作对它无效。本轮实测证实：`weflow-anchor-rebuild.ps1` 删掉锚点值并重启后，messages 连续 6 次仍是 `-101`，配方按设计**把锚点原样还原**（可逆性生效）。本机环境事实：只有 Windows Defender（SecurityCenter2 只报 `Windows Defender`，`state=397568`）、系统自 09-24 11:08:18 起未重启、配置与路径都正常（`myWxid=wxid_s3178hwzsl922_9e02`、`dbPath=C:\Users\cwinprobe\Documents\xwechat_files` 存在且含该 wxid 目录）。下一步需要的是 `%LOCALAPPDATA%\WeFlow` 的杀软/EDR 排除项或按官方方式重装（`docs/remediation-plan-2026-09-11.md` §修复F），这是**需要管理员/机主**的动作。

**2. 修好被拼接坏的读侧重启配方（本轮唯一的代码修复）。**

`s4\out\weflow-restart.log` 显示 00:54 那一轮是 `TIMEOUT 240s -> killed pid=38108`：配方文件 `scripts/isolated-session/weflow-restart.ps1` 被一次坏编辑搞成了**一份完整正文 + 三份被截断的副本**（后三份的 `$before = ... Where-Object {` 行尾被文件头注释覆盖），于是 worker 单轮里跑了 4 次 kill/relaunch，撑爆 240s 预算，worker 在周期中途把启动器杀掉 —— 守卫每 15 分钟"自愈"一次，实际每次都在中途制造一次重启。现在按 `0087a47` 的干净正文重建，保留 `1d25c3b` 的运行期会话号（不硬编码 4），并补上显式退出码（`READER OK` 为真退 0，否则退 1）让守卫日志能分辨成败。校验：93 行、AST 0 error、单份正文（1 个 `$ErrorActionPreference` / 1 个 `Start-Process`）、纯 ASCII（worker 用 ANSI 读 BOM-less 文件）。

**3. 不放松 WeFlow 的身份判据（本轮有意不做）。**

把「token + health 200 + 端口唯一属主」当成身份证明、或接受「带 `错误码: -N` 的 500」当身份证据，都能让机械修复继续跑；但继续跑的下一步是 `FullRestart` **整栈**——而 `docs/remediation-plan-2026-09-11.md` §修复F 明确要求读侧故障「只重启 WeFlow，绝不 FullRestart 整个栈」。在「只重读侧」的修复模式做出来之前，让它 fail-closed 反而挡住了更糟的动作。这条作为已知缺口记录。

## 同轮附带修复：守卫的 bot 存活判据也只认反斜杠

`scripts/isolated-session/weflow-guard.ps1` 用 `$botPattern = 'bin\\cyberboss\.js\s+start'` 判断机器人是否活着。2026-10-01 实测：活着的机器人命令行是 `"node.exe" ./bin/cyberboss.js start --checkin`（**正斜杠**），该模式对全部 cyberboss 进程 `match=False` ⇒ 守卫每 15 分钟报一次 `bot missing -> triggered cwin-s1-bot`，而机器人一直活着（pid 6788、看门狗 `identityVerified=true`）。这与 09-27 在**服务**和**看门狗**里修过的是同一个坑（RDPWrap 硬约束 8 要求"两处必须保持一致"——现在是第三处）。已把模式统一成 `'(?:^|[\s\\/])bin[\\/]cyberboss\.js\s+start(?:\s|$)'`（与 `cyberboss-service.ps1:134`、`cyberboss-watchdog.ps1:113` 逐字一致），并用当时活的命令行验证 `match=True`、其余 cyberboss 进程全为 False。效果：不再每 15 分钟触发一次注定被单例锁拒绝的 `cwin-s1-bot`（顺便少 96 次/天的日志噪声）。

## 环境取证的结论（为什么不是本地状态问题）

同一轮在 session 3 里做了只读取证，逐项排除了"本地可修"的可能：锚点三件套**齐全且一致**（`Runtime\anchor-v7-…bin` 310B、`State\native-anchor-v7-…bin` 310B，mtime 10-01 00:08；注册表 `AnchorV7-e1c84b9f06d1237a-…` 在位）、`Security\device-root-v1.bin` 在位；`%LOCALAPPDATA%\WeFlow` 对 `Unhappy\cwinprobe` 是 FullControl 且**写测试通过**；WeFlow 6.2.0 的进程里**没有任何非 Windows/非 WeFlow 模块**（注入类判据排除）；配置完整（`myWxid=wxid_s3178hwvzsl922_9e02`、`dbPath` 存在且含该 wxid 目录）。所以 `-101` 只可能来自组件对**机器/安全环境**的判断（Defender 排除项目前无法读取，需要管理员），这也正是官方 action 指向的方向。



## Alternatives considered

- **改功能身份判据，让 500 也能证明身份**：见上，会重新打开「读侧坏了就把整个栈重启」的闸门；而且真正的病（环境/杀软）不会因此好转。等「只重读侧」模式落地后再做。
- **自动重装 WeFlow**（`%LOCALAPPDATA%\weflow-updater\installer.exe`）：官方 action 之一，但属于机主要拍板的重动作，且在 `-101` 未定性前重装未必有效（组件认为环境本身有问题）。
- **继续删除/保留锚点状态**：09-25 用「删注册表 `AnchorV7-*`」治好过 `-105`，所以本轮复用了同一个配方；实测对 `-101` 无效，且配方自动还原，说明锚点不是这一类的病灶 —— 保留这个配方用于 `-105` 是对的，但不能指望它治环境类码。
- **反复重试 `repair-verify`**：不会让读侧恢复，只会往用户对话里多塞 `[test]` 通知；本轮跑一次记录真值就够。

## Consequences

- 收益：读侧的「自愈」链路不再是坏配方 —— 守卫下一拍会用修好的配方跑一次干净的单周期（而不是 4 连跑 + 240s 超时 + 中途被杀），日志与退出码可判读。
- 收益：`-101` 从「未知 500」变成了有官方定义、有处方、有本机证据的**外部阻塞**；下次不必再试重启/锚点。
- 代价：本机读侧在环境条件解除前**一直不可用**（机器人收不到新消息），机械修复被安全地挡在门外；`-100`/`-101` 这类码目前不会自动降级成"只重读侧"。
- 待办（需要人）：关掉隔离会话里那个高权限 Task Manager（见报告的 blocker 2）；给 `%LOCALAPPDATA%\WeFlow` 加杀软排除项或按官方方式重装；考虑把 `Test-WeFlowFunctionalReady` 与修复模式解耦（新增「只重读侧」模式）。
