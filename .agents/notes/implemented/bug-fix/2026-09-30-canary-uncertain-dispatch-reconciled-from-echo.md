# Agent Note: canary 的 `uncertain` 派发回执用已认证的回声补齐（不再把「发出去但没被桥确认」判成探针失败）

Status: implemented

## Problem

2026-09-29 09:45 起，心跳 canary 连续 4 次以同一个码失败，最后一轮（`92e6a629-ca0a-4363-a23b-d86841977105`，2026-09-30 03:44:53Z）的现场是：

- `trigger-dispatch-started.json` / `manifest.json`：探针把 `[Cyberboss心跳探针 trigger=… nonce=…]` 交给桥（`/api/send`），桥回 `dispatched=true` 但**没有** `verified`（确认窗口到期）。
- `ingested.json`：`triggerLocalId=14`（探针本轮确实进了账本）。
- `reply-dispatched.json`：`{status:"uncertain", ledgerStatus:"failed_uncertain", replyLocalId:""}` —— 桥没在窗口内确认，回执就永远停在这个形态（`writeJsonAtomicOnce`，一次性写）。
- `reply-observed.json`：`{status:"observed", direction:"outgoing", replyLocalId:"15", matchedBy:"content_hash_fifo"}` —— **回复其实发出去了**，读侧看到它、账本按内容哈希配上了；`weflow-canary-inbox-cursor.json` 也已经提交到 `local:15`。
- 但 `validateMilestones` 要求 `resolvedReplyId === dispatchedReplyId === observedReplyId` 且三者都非空 ⇒ 空 `dispatchedReplyId` 让它每轮都判 `reply localId is missing or inconsistent`，60 秒 TTL 到点 → `CANARY_TIMEOUT`。

代价不止"探针红"：`canary=action=failed,repairable=true` 确认两拍后会触发机械 `Restart`，而 Restart 会重启**整栈**。2026-09-30 14:30:39 实测：这次 Restart `Stopping Bridge process tree rooted at PID 31424`（那是健康的机器人）并另起 9932 —— 探针的判据过严，代价是服务中断。

## Decision

`scripts/cyberboss-watchdog-canary.js` 的 `validateMilestones`：当派发回执是**不确定**（`status === "uncertain"` 或 `ledgerStatus === "failed_uncertain"`）、且 `reply-observed` 是**已认证的真实观测**（`status === "observed"`、`direction === "outgoing"`、带 `replyLocalId`）而派发回执**没有** localId 时，用观测到的 localId 补齐判定，并返回 `replyReconciledFromEcho: true`；成功结果与 `detail` 都标明"回执不确定、由已认证回声补齐"。

严格性只在这一处放宽，其余一律照旧：

- 派发回执**有** localId 但与观测不一致 → 仍然失败；
- 观测回执不是 `observed`/不是 `outgoing`/没有 localId → 仍然失败；
- 回复 localId 不大于触发 localId → 仍然失败（顺序判据不变）。

安全性来自观测本身的认证：`reply-observed.json` 只由 app 的心跳 canary 回声处理器写（`src/integrations/weflow-heartbeat-canary.js` 的 `handleReplyEcho`），它要求方向是 outgoing、来源是本项目账本、`messageKind` 等于**本 runId 专用的** key，且文案与 `manifest.replyText` 完全相同。换句话说，这条行已经证明"本项目的这次探针回复发出去了"，比桥自己的确认窗口更强。

## Alternatives considered

- **改 app 侧，让回声到达时把 localId 补写进 `reply-dispatched.json`**（模型侧已经有 `reconciled_from_echo` 这套）：落盘形态更"正确"，别的读者也能受益。但 `reply-dispatched.json` 现在是 `writeJsonAtomicOnce`（一次性写、首个写者胜），要补写就得在同一文件里引入第二个写者并处理并发；而且这份代码（`weflow-heartbeat-canary.js` + 发送路径）正被另一条线高频改动。本轮选在判据侧止血，app 侧补写作为后续项写进报告的残留风险。
- **把 canary 的 60s TTL 拉长**：治标。回执是 `uncertain` + 空 id 且一次性写就，等再久也不会自己补上，只会让每轮探针更慢、更容易撞上 TTL。
- **干脆只认 `reply-observed`，不要派发回执**：会丢掉"这条回复确实由本项目账本发起"的绑定，可能把一条内容相同的野发出行当成探针回复。"缺 localId 的 uncertain 回执"是唯一该放宽的形态。
- **让 canary 失败不再触发机械 `Restart`**：这是升级策略问题（canary 是唯一的端到端探针，历史上确实用重启救回过写侧卡死），改动面比一次判据修复大得多，不在本轮顺手改；已写入报告残留风险。

## Consequences

- 收益：探针不再因为"桥没确认、但消息确实到了"这种时间窗问题判红，也不再因此把健康的核心重启掉。四次失败的直接原因（`uncertain` + 空 localId）被消掉。
- 收益：判定与"谁写了这条回执、凭什么信它"对齐 —— 认证来自账本 `messageKind` + 精确文案 + 方向，而不是桥的时间窗。
- 代价：放宽了一处窄缝 —— 理论上"没发出去、但读侧恰好有一条同 runId `messageKind`、同文案的 outgoing 行"会被当成成功；要造出这个形态，等于本项目的这次探针回复真的发过。
- 实测（2026-09-30 14:35，用失败 run `92e6a629` 的**真实**回执重放）：旧判据 `{ok:false,detail:"reply localId is missing or inconsistent"}`（与日志里的失败码一致）→ 新判据 `{ok:true,triggerLocalId:"14",replyLocalId:"15",replyReconciledFromEcho:true}`，随后 `inspectCursorDrain` 用当前的 `weflow-canary-inbox-cursor.json` 得到 `{ok:true,cursorCommittedAt:"2026-09-30T06:33:22.917Z"}` ⇒ 这一轮在修后**会是 healthy**。负例（派发 id 不同、观测不是 `observed`、观测无 id）仍被拒。
- 回归测试：`test/watchdog-canary.test.js` 新增 "an uncertain dispatch receipt is reconciled from the authenticated reply echo"，并同步了既有严格相等断言；`node test/watchdog-canary.test.js` 27/27 通过。
- 本轮无法做 canary 的自然复验：探针日预算 4 次已用满（`nextDue=2026-09-30T09:44:49Z`＝本地 17:44），只能等窗口滚过；`node scripts/repair-verify.js`（同一收发链路的独立验证）已 exit 0。
