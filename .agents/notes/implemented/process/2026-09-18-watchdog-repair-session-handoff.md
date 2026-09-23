# Agent Note: 异常时唤醒固定维修工会话（心跳 15 分钟 + 修完走 test-session 验证）

Status: implemented

## Problem

看门狗能**检测**故障，却有一整类故障它**修不了**，而且会把人拖进循环（部署契约见 [RDPWrap 隔离会话部署契约](2026-09-18-rdpwrap-isolated-session-deployment.md)）：

1. 2026-09-18 的 WeFlow 读侧故障（`/api/v1/health` 200、`/api/v1/messages` 全 500）持续约 2 小时。看门狗每 2 分钟就报 `components=weflow,...; plannedRepair=FullRestart`，但它的修复动作只有 `cyberboss-service.ps1 -Mode Restart|FullRestart`，**从不重启 WeFlow**；`cyberboss-service.ps1:832` 在"health 通、消息 500"这一支明确选择保留进程并返回。同一指纹从 09-09 起就反复出现在修复记录里，一次都没修好。
2. 这类无效修复把反抖动预算（4 次/天）吃光，于是真正需要动作时只能 `repair suppressed reason=daily_budget; retryAt=21:23`。
3. 发现异常的是用户（"为什么 Azzy 没回复"），不是系统：看门狗没有把故障交给任何"会修的人"。

## Decision

**1. 心跳从每 2 分钟改为每 15 分钟。** `CyberBOSS Heartbeat Watchdog` 的 `Repetition.Interval` = `PT15M`（原来 `PT2M`）。2 分钟一次的机械探测对"读侧坏了 2 小时"这类故障没有增量价值，只增加噪声与预算消耗。

**2. 判定异常时，除了原有机械重启，再唤醒固定维修工会话（维修工）。**

- 通道：**ACP**。`scripts/repair-dispatch.js` 用仓库里已有的 `AcpRpcClient`（`src/adapters/runtime/dsh-acp/rpc-client.js`）拉起一次性 `dsh --profile acp`，`session/resume` 后 `session/prompt` 投递故障报告，然后关闭；没有常驻进程。
- 会话 id 固定并持久化：`C:\ProgramData\cwin-probe\repair\session.json`（可由 `.env` 的 `CYBERBOSS_REPAIR_SESSION_ID` 覆盖）。现有会话：`69f89dcf-97ff-4df0-a65f-da035c84f0b1`，cwd `D:\Projects\cyberboss`，profile `acp`。
- 工具权限自动批准并记日志（`session/request_permission` → 选 allow 选项）：维修工前面没有人点"同意"，不批准就会卡到超时。
- 看门狗里的调用点是"机械重启之前"（`Ensure-WeixinStarted` 之后）：**detached 启动**（不等它跑完，心跳不被维修工的整轮对话阻塞），并写入 `cyberboss-repair-request.json`（指纹/组件/计划动作）；并发由 dispatch 自己的 `in-progress.json` 锁串行化。开关是 `.env` 的 `CYBERBOSS_REPAIR_ENABLED=true`。

**3. 修完必须走一遍验证流程：用 `test-session` 对大号发一条重启消息。**

`scripts/repair-verify.js`：

- 通过 UIA 桥以**同号身份**向大号（`CYBERBOSS_WEFLOW_INBOX_CHAT` = `wxid_ubo0cy5xh4px22`）发一条 `[test] 服务已重启完成…<marker>`；因为带 `[test]`，这一轮落在保留会话 `test-session`（`src/core/app.js` 的 `TEST_SESSION_KEY`），不会污染真实窗口的上下文；因为没有账本条目，机器人按同号人工消息处理。
- 然后轮询 WeFlow 的 `/api/v1/messages`，直到看到机器人**回复里含该唯一 marker**。退出码 0 = 端到端通（用户同时真的看到了那条重启消息）。
  - 判定"这条是机器人发的"必须读**原始行 schema**：`isSend`（`true`/`1`/`"1"`），因为本机 WeFlow 的响应里**根本没有 `direction` 字段**（`cyberboss-watchdog-canary.js` 与 `src/integrations/weflow-inbox.js` 也是这么归一化的）。2026-09-22 之前这里只认 `direction === "outgoing"`，于是**每一轮成功的往返都被判成超时**：marker 已在库里、大号已收到，轮询却整条跳过。现已同时接受 `isSend` 与 `direction`。
  - 但**只按"发出 + 含 marker"匹配必然误报**：触发消息本身就是同号的发出行，而且我们要求机器人"原样包含标记"，所以**触发文本里也有 marker**。修掉 `direction` 之后的第一版立刻把这个触发器当成了回复，在发出后 21 秒就 `ok=true`（假通过）。真正的判据是**时序**：回复必须是比触发更靠后的那一行 —— 用桥返回的 `sendBody.localId` 作下界，且内容不等于触发文本。判"验证通过"时同时看 `ok` 与 `reply`/`replyLocalId`，只看退出码会被这类假通过骗过。
- 报告写 `C:\ProgramData\cwin-probe\repair\verify-<ts>.json` + `verify.log`。

**4. 维修工的契约**（写进它的 bootstrap 与每次请求文本）：诊断 → 用 `scripts/isolated-session/` 已入库的配方修 → 跑 `node scripts/repair-verify.js` → 把结论写 `report-<ts>.json` → 简短回复。边界：不改 `.env` 端口/账号，不重启用户会话（session 1）的东西。

## Alternatives considered

- **让看门狗直接重启 WeFlow**：看门狗跑在 session 1，而 WeFlow 必须活在 session 4 才能读 `cwinprobe` 的库；跨会话 `Start-Process` 只会得到"错误桌面上的实例"。所以把它交给能在会话 4 里操作的维修工，而不是给看门狗加一条注定失败的分支。
- **把验证做成看门狗健康路径里的固定动作**：要在 4500 行的脚本里改健康分支，风险大于收益；改为写进维修工契约（脚本本身可单独运行、可手动复验）。
- **用 `.env` 记录会话 id**：会话 id 是这台机器的部署事实，不是代码配置；写进仓库会污染 checkout，也容易和别的机器冲突。放 ProgramData。
- **用 DSH `web` profile 的 HTTP 接口唤醒会话**：没有稳定的"给已有会话发消息"契约文档；ACP 这条路已经被 Cyberboss 自己在生产里验证过（`sessionCapabilities {close, list, resume}`）。
- **提高或取消修复预算**：不解决"这类故障机械重启修不好"的根本问题，只是更频繁地做无用功。

## Consequences

- 收益：故障不再等人发现 —— 看门狗把指纹与证据交给一个能读笔记、能看日志、能在会话 4 里动手的会话；机械重启继续兜底快故障，维修工负责它修不了的那类（如 WeFlow 内部 500）。
- 收益：验证是端到端的，而且用户可见：大号会收到一条"服务已重启完成"的 `[test]` 消息，机器人必须回出 marker 才算通过。
- 代价：每次唤醒都消耗一轮真实 agent（时间与 token）；维修工在无沙箱上下文里执行命令，边界只能靠契约文字约束。
- 代价：验证要求出站链路可用。若同一隔离桌面里还有别的自动化在跑（另一个 agent 的 UIA 任务），验证会以桥的 502 失败 —— 那是真实信号（发送被占桌面的对手打断），不是误报。
- 首次实跑记录（2026-09-18 17:14）：`repair-verify.js` 的触发消息**投递成功**（桥 `dispatched=true, verified=true, localId=40`，大号可见），机器人也确实把这一轮路由进了保留会话（日志 `dsh-acp resumed session 984d9210-… for window test-session`），但**回复没发出来** —— 出站再次被 502/abort 挡住（`WeFlow UIA inbound acknowledgement failed: This operation was aborted` → `deferred system reply`），因为同一隔离桌面里另一个 agent 的自动化正在跑。结果是 `ok=false`：这是**真负例**，验证正确指出了"发送侧仍不可用"，而不是误报。
- 第二次实跑记录（2026-09-22 15:41，即上面那条 schema 修复之前）：那一轮**往返其实是通的** —— 小号发 `[test]`（localId 77）→ 机器人回"处理中"（78）→ 回 `REPAIR_OK_…`（79），三条 `isSend=1` 都在大号窗口里；但脚本只认 `direction`，因此 `ok=false` 且 `detail=no reply containing …`。**"marker 没回来"与"读侧认不出 marker"从此必须分开**：前者查 5051 的原始行，后者查这个 schema 判定。
- 同一轮还暴露了验证的两个环境前提：① `repair-verify.js` 必须在能写 `C:\ProgramData\cwin-probe\repair\` 的上下文里跑（否则 `fs.writeFileSync` EPERM，脚本在打印结论前就崩，退出码 1，看起来像验证失败）；② 维修工自己的会话若被文件沙箱限制在工作区内，验证会以这个 EPERM 假失败收场 —— 判 `ok` 之前先确认报告文件真的写出来了。
- 第三次实跑（2026-09-22 15:48）先遇到**假通过**（触发器被当成回复，21 秒返回 `ok=true`），补上 localId 下界后才拿到真通过：触发 localId 80 → 机器人回复含 marker 且 localId > 80。教训与上面的"看证据不看退出码"是同一条。
- **唤醒走自己的门槛，不占机械修复预算**：`Invoke-RepairSessionWake` 维护独立的 `cyberboss-repair-wake.json`（24 小时内最多 6 次、两次之间至少 30 分钟）。理由是当天的事故本身：4 次无效机械重启把 4/天的预算吃光后，看门狗连续 7 小时只打印 `repair suppressed ... reason=daily_budget`，**任何形式的修复都不再被允许**。所以抑制分支（`repair suppressed` 之后）与修复分支**都**会调用唤醒；维修工的会话只在异常时被唤醒，平时不常驻、不被探活（用户 2026-09-18 明确要求）。
- **canary 的"桌面空闲"门槛必须量注入侧**（2026-09-22 修）：`Get-DesktopInputIdleState` 原来用本进程的 `GetLastInputInfo`，而看门狗跑在 session 1 —— 用户一动键鼠门槛就按住，canary 永远不重跑，07:15 的陈旧失败因此被反复当成现役故障，最后把 4/天的机械修复预算吃光、`action=circuit_open`（`retryAt=2026-09-23T02:44`）。现在优先取桥在 `/api/probe` 里回报的隔离会话空闲秒数（实测同一时刻本地 51s vs 隔离桌面 2327s），并新增 `source` 字段。**"门槛量错了会话"和"故障没修好"看起来一模一样**：判 canary 之前先看 `canary.lastAttemptAt` 有没有前进。
- 该轮后续：预算耗尽期间即使 canary 重跑成功，`nextRepairAllowedAt` 也要等 24 小时窗口滚过；只要快照转 healthy 就不需要修复，所以门槛修好后 `circuit_open` 会自动失效而不是卡住。
- **"等预算"不是故障，别报成可修复**（2026-09-23 修）：canary runner 的 `attempts` 每天最多 4 次（`MAX_ATTEMPTS_PER_DAY`），用满后返回 `action=budget_wait` / `detail=budget_daily` / `nextDueAt` 到 24 小时窗口滚过。这个分支原本把 `repairable` 落成 `schedule.lastRepairable !== false` —— **继承上一次失败尝试的可修复性**，于是"只是在等明天"被看门狗当成现役的可修复故障：`canary=action=budget_wait,repairable=true` → `plannedRepair=Restart` → 唤醒维修工，而重启对"等预算"毫无作用。现在 `budgetWait || urgentBudgetWait || demandAlreadyHandled` 一律 `repairable=false`（`urgentBudgetWait` 早就是这样，漏的是 routine 的 `budget_*`）。实测：修前看门狗快照 `action=budget_wait, repairable=true`；修后直接跑 runner 得到 `{"action":"budget_wait","repairable":false,"detail":"budget_daily"}`。注意 `--force` **不越过**这个预算闸门（`decideCanaryDue` 先查 `getCanaryAttemptGate`），所以预算用完当天无法用 `--force` 复验 canary。
- **canary 触发路径自身的两个时间预算问题**（2026-09-23 定位，**未修**）：① `weflow-uia-bridge.select_exact_search_result_with_enter()` 要求连续两次完整一致的搜索结果快照才允许回车，而窗口是 `min(MAX_SEARCH_RESULT_STABILIZATION_SECONDS=3.0, timeout)`，单次快照实测约 2s → 常常只够 1 次轮询，直接 `TARGET_NOT_CONFIRMED`；② `dispatch_and_verify()` 的验证阶段用的是 `deadline = now + timeout`，即**在发送阶段之外又开了一个完整的 timeout**，整条 dispatch 最坏约 `timeout/3 + timeout + timeout ≈ 2.3×timeout`，而 canary 客户端只等 25s（桥被告诉 20s）→ 慢一点就 `CANARY_REQUEST_TIMEOUT`。09-22 至 09-23 的 canary 失败记录基本由这两种码组成。改法要么给整条 dispatch 一个共享 deadline（会影响机器人正常回复路径的 `verified` 语义，需谨慎），要么让稳定化窗口至少容纳两次轮询；两条都动了就**必须**在 canary 可重跑时复验，本轮没动。

## Known gaps

- 验证由维修工契约触发；若它没跑，看门狗不会补跑（可加"健康 + 存在未验证的 dispatch 报告 → 自己跑一次"）。
- `scripts/weflow-self-manual-e2e.js` 仍硬编码旧端口 8766 与旧的单数 `CYBERBOSS_WEFLOW_INBOX_CHAT`，在新部署上会直接抛错，需要单独修。
- 状态目录偶发 `EPERM ... rename .weflow-inbox-cursor.json.tmp -> weflow-inbox-cursor.json`，来源未定位（怀疑杀软或并发写），暂未处理。
- 看门狗是单实例：上一拍还在跑时手动再跑一次会被"已在运行"挡掉，验证唤醒链路要等下一个自然心跳（或先等上一拍结束）。
