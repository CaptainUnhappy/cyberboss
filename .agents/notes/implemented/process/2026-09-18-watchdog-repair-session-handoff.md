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
- 已知缺口：① 验证由维修工契约触发；若它没跑，看门狗不会补跑（可加"健康 + 存在未验证的 dispatch 报告 → 自己跑一次"）；② `scripts/weflow-self-manual-e2e.js` 仍硬编码旧端口 8766 与旧的单数 `CYBERBOSS_WEFLOW_INBOX_CHAT`，在新部署上会直接抛错，需要单独修；③ 机械修复预算（4/天）与维修工唤醒共用同一本账，后续可能要把唤醒单独计账；④ 状态目录出现 `EPERM ... rename .weflow-inbox-cursor.json.tmp` 偶发失败，来源未定位（怀疑杀软或并发写），暂未处理。
