# Agent Note: 心跳修复被大小写重复环境变量打断（含重启通知真实生命周期演练）

Status: implemented

## Problem

2026-09-28 11:47 做"把 ♻️ 心跳守护管家通知真实落到 Azzy 自己窗口"的演练时，打到了一个此前没暴露的硬故障。

演练过程（真实故障注入，不是合成入队）：把 UIA 桥在隔离会话里停掉 → 心跳连续两轮确认
`components=uia,send-source,canary; confirmation=2/2` → 守护脚本启动机械修复，并**成功**把重启通知
落成持久义务（`action=enqueued` / `action=activated`，目标 `wxid_s3178hwvzsl922`）→ 一秒后整轮崩溃：

```
heartbeat error: Item has already been added. Key in dictionary: 'NO_PROXY'  Key being added: 'no_proxy'
```

根因：Windows PowerShell 5.1 在把进程环境复制进**大小写不敏感**的字典时（`Start-Process` 的
环境拷贝、以及任何 `$h.Add($k,$v)` 形式的拷贝）会因同名不同大小写的键抛错。被托管的 shell
（DSH/agent harness、部分 CI）会同时注入 `http_proxy`/`HTTP_PROXY`、`https_proxy`/`HTTPS_PROXY`、
`NO_PROXY`/`no_proxy`。`cyberboss-service.ps1` 里原本只有一个 `Repair-DuplicatePathEnvironment`，
**只修 `Path`/`PATH`**，所以这个洞一直开着。

后果很严重且隐蔽：`$repairStarted = $true` 之后抛出，机械修复**从未运行**，恢复状态被写成
`controller_error / ineffective`；同时因为通知义务已经 activate，用户视角是"通知发了但服务没修"，
而自动化视角是"这轮修复失败"，两边都不对。

真机上的触发条件正是**人工/代理驱动的修复**（应急会话、维修工 session 都从被托管的 shell 里调
守护脚本），也就是最需要它工作的那条路。

## Decision

1. 把 `cyberboss-service.ps1` 的 `Repair-DuplicatePathEnvironment` 泛化为
   `Repair-DuplicateEnvironmentKeys`：按 `ToLowerInvariant()` 分组，任何大小写重复组都收敛成一个键
   （保留首个拼写；`path` 组固定保留 `Path`）。
2. 在 `cyberboss-watchdog.ps1` 的 `$ErrorActionPreference = "Stop"` 之后**立即**调用同一个函数，
   即"任何 Start-Process / 环境拷贝之前先净化"。两个文件都必须保留 UTF-8 BOM（守护脚本里有
   `♻️` 等非 ASCII 文本，BOM 丢失会被 PS 5.1 按 GBK 解析而整体失效——此前已经踩过两次）。
3. 落一份双向自测 `scripts/duplicate-env-keys-selftest.ps1`：A 面在重复键存在时用
   `$h.Add()` 复现 `Item has already been added`，B 面从 `cyberboss-watchdog.ps1` 里**原文抽出**
   函数执行后再跑同一拷贝，必须成功。跑法：`powershell -File scripts/duplicate-env-keys-selftest.ps1`。

同日演练的另外两个真实结论（都已处理）：

- **桥 pid 台账会过期**：注入时被杀的是 pid 14596，重启后真实监听是 23088，而
  `~/.cyberboss/logs/weflow-uia-bridge.pid` 还写着 14596（mtime 是上一次开机）→ 守护脚本把
  `uia` 判成不健康、一直累积确认。修法是跑一次 `cyberboss-service.ps1 -Mode Start`：它的
  `Repair-ManagedPidFiles` 会**按端口唯一属主**（`-AllowEndpointOwnership`）重写 pid 文件，
  此时 `uia`/`send-source` 立刻转绿。注意 `-Mode Start` 会因为 App Server/readyz 不在线而返回
  非零（本部署跑的是 DSH ACP profile，本来就没有 app-server），**这个非零是预期**，不是失败。
- **canary 目标名与通讯录不一致**：`CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME=美女`，而 WeFlow 通讯录里
  `wxid_6r2qv9w2hgth22` 的 `displayName`/`nickname` 都是 `.`，于是桥在
  `exact_contact` 校验处抛 `contact '美女' is not a name of talker ...: ['.']`，探针从未成功过
  → 修复后的验证永远卡住。`.env` 已改为 `.`（备份 `.env.bak-canary-name-*`）。改完探针能跑到
  发送环节，但**仍以 `watchdog canary trigger timed out after 25000ms` 失败**（见下面遗留项）。

## Alternatives considered

- **只在守护脚本里 try/catch 包住 Start-Process**：能吞掉异常但修复依旧没跑，等于把"修复失败"
  伪装成"没报错"；而且 `Invoke-RepairSessionWake` 之类的环境拷贝路径下次还会炸。放弃。
- **在启动器（`shared-start.js`）里净化环境**：只覆盖 node 侧拉起的进程，覆盖不到"人工/代理直接
  调 `cyberboss-watchdog.ps1`"这条最需要的路径。放弃。
- **要求调用方自己清环境**（文档约定）：违反"完全自动、不需要人工介入"的既有要求，且每次
  换宿主都要重新踩。放弃。
- **保留 `Repair-DuplicatePathEnvironment` 另加一个新函数**：两个函数做同一件事，早晚只改一个。
  直接改名泛化，调用点同步（服务脚本里 2 处）。

## Consequences

收益：

- 在被污染的环境里，机械修复不会再因为环境字典冲突整轮崩掉；`Start-Process` 路径恢复可用。
- 双向自测把这次的真实现象固化成可回归的证据，而不是"我改完试了一次好像是好的"。
- 顺带确认了**重启通知的真实生命周期是通的**：真实故障 →（2 次确认）→ 通知落成义务并 activate →
  控制器修复 → drain 派发 → UIA 实发 → 账本核验，账本最后一条为
  `talker=wxid_s3178hwvzsl922 / status=verified / localId=3`，通知记录同步为
  `status=verified, targetTalker=wxid_s3178hwvzsl922, localId=3`。也就是说"通知只发给 Azzy 自己"
  这个目标已经用真链路兑现，不再依赖合成入队。

代价与遗留：

- 净化环境是**进程级副作用**：守护脚本进程里的重复键被合并（保留首个拼写），如果有依赖"读小写
  `no_proxy` 而大写缺失"的行为，理论上会被改变；实测本项目没有这种依赖。
- **canary 仍未绿**：目标改成 `.` 之后触发能走到发送，但 25 秒超时。`.` 这种名字在微信搜索框里
  是**歧义**的（搜索结果顺序不稳定），很可能永远过不了"搜索结果身份重复确认"这道门。要么给
  canary 换一个名字唯一、可搜索的目标（隔离性要求它不能等于通知目标 `wxid_s3178hwvzsl922`，
  剩下顺位的候选是 `wxid_ubo0cy5xh4px22`/"yourself"，但那正是主收件箱），要么给这条探针放宽
  超时/换定位方式。这是产品取舍，需要人来定，不是能单方面改的。
- canary 未绿期间，守护脚本每轮会以 `blocked_nonrestartable` 退出（exit 2），但**不影响收发**：
  通知义务的派发走 drain 路径，已经在本笔记的演练里证明可独立完成。

## 追加（同日）：canary 目标选型的边界 —— "把 canary 指到 yourself/大号" 走不通

用户选了"canary 改到 `wxid_ubo0cy5xh4px22`（yourself，主收件箱窗口）"。实施后发现**产品自带不变量
直接拒绝**，这条路的代价也比看上去大：

1. `src/core/config.js:360` 硬校验：`CYBERBOSS_WEFLOW_CANARY_CHAT must differ from
   CYBERBOSS_WEFLOW_INBOX_CHAT; dedicated canary routing is disabled`。
   `CYBERBOSS_WEFLOW_INBOX_CHATS=wxid_ubo0cy5xh4px22,wxid_ty69l7hjiqt012`，所以 canary 一旦指到
   大号（或指到另一个机器人号 Ally），**bot 直接起不来**——实测控制器 `-Mode Restart` 的新进程
   以这条错误退出，控制器做了回滚（"Partial startup was rolled back without stopping pre-existing
   healthy components"）。换句话说：这不是"没配好"，是设计上不允许 canary 复用收件箱窗口。
2. 更深一层：canary 的验证要 `triggerLocalId` **和** `replyLocalId` 成对（守护脚本判绿的条件）。
   能自动产生"回复"的只有**自己跟自己**的窗口（机器人给自己发、自己再回）。历史上所有绿过的
   canary run，`targetTalker` 都是 `wxid_s3178hwvzsl922`（Azzy 自己）。而 Azzy 自己现在正是
   ♻️ 通知的目标——隔离断言要求两者不同，于是"能自动回复的窗口"和"不能是通知目标"这两条**同时
   成立的候选几乎为空**。
3. 所以 `.env` 已回滚成能启动的形态：`CANARY_CHAT=wxid_6r2qv9w2hgth22`、`CANARY_DISPLAY_NAME=.`
   （该 talker 在 WeFlow 通讯录里 `displayName`/`nickname` 就是 `.`，写"美女"会在桥的
   `exact_contact` 校验处直接报 `contact '美女' is not a name of talker ...: ['.']`）。
   注意这个 target 名字有歧义（`.` 在搜索框里会匹配到别的行），探针仍会
   `canary trigger timed out after 25000ms`。

真正可选的收口方式（都需要人定，且都不是"改个 .env"）：

- **C**：把 ♻️ 通知挪回非自身窗口（例如大号收件箱），canary 用 Azzy 自己——即回到改动前的分工，
  牺牲"通知只发给自己"这条。
- **D**：承认 canary 无法自动化，去掉/放宽"canary 必须绿"这道门（例如修复验证只依赖账本 drain +
  心跳），守护脚本不再把 canary 的失败当成不健康组件。
- **E**：给 canary 一个**专用的第三个账号**（例如把退役的 Ally 重新登录、并把它从 inbox 列表里
  摘掉），这样"能自动回复"与"不是通知目标/不在收件箱"三条同时成立。长期最干净，代价是要重新
  登录一个账号。

另外两个今天顺带看到的真实现象（未处理，供排查）：

- 控制器启停一次会留下 `WeFlow push reconnecting: WeFlow message push returned HTTP 403` 刷屏
  （今天两份服务日志：`20260928-101522` 3605 行、`20260928-123617` 419 行；此前几天的日志 0 行）。
  轮询路径正常（游标 20 秒级推进），所以收发没断，但推送通道是坏的。
- 启动器对桥 pid 文件的**跨账号判读**：`WeFlow UIA bridge already_running_unknown_pid pid=23088`
  会让控制器 `Restart` 的启动健康检查失败并回滚；用 `schtasks /run /tn cwin-s1-bot`
  （`bot-direct.cmd` 直启，绕开启动器）可以把 bot 拉起来。
