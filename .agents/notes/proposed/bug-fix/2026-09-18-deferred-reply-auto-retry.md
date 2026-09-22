# Agent Note: 失败的回复自动重试（不再等下一条入站）

Status: proposed

## Problem

一条回复发送失败后，它被存进 `deferred-system-replies.json`（`app.js:1346 deferSystemReply`），而**唯一的补发点**是下一条入站消息：`app.js:1360 primeDeferredRepliesForSender` 把队列里属于该发件人的回复 drain 出来，作为**下一次回复的前缀**（`streamDelivery.setDeferredReplyPrefix`）一起发出去（`app.js:1364`）。

于是失败的时间成本 = **用户下次开口的时间**，可能是几分钟，也可能是几小时（2026-09-18 实测堆到 6 条、年龄 5 小时以上，用户先发现"没回复"）。系统里已经有三套重试机制，唯独最需要重试的这一条没有：

- `INBOUND_ACK_CERTAIN_RETRY_DELAY_MS = 750`（`app.js:83`）："处理中" ack 的短重试。
- `PENDING_INBOUND_COMMIT_RETRY_BASE_MS = 15_000` / `..._MAX_MS = 5 * 60_000`（`app.js:88-89`）：待提交入站的指数退避。
- 回复义务（`reply-obligations.json`）有 `noReplyDeadlineAt`，但它的终态是 `deferred_durable` —— 记录事实，不重试。

## Proposal

给延迟回复队列加一个**定时 drain**，失败后不再依赖下一次入站：

1. `deferSystemReply` 入队成功后，为 `(accountId, senderId)` 安排一次重试定时器：首次 **30 秒**，指数退避（30s → 1m → 2m → 5m 封顶），`attemptCount` 与 `nextRetryAtMs` 随条目持久化（进程重启后仍能续上）。
2. 定时器到点执行 `flushDeferredRepliesForSender(accountId, senderId)`：
   - `drainForSender` 取出该发件人的全部待发回复；
   - 用该发件人**最近一次的 `contextToken`**（`src/adapters/channel/weixin/context-token-store.js`）直接发送这一批（`formatDeferredSystemReplyBatch` 复用现有格式化）；
   - 发送成功 → 结束；失败 → 把这一批**按原 `id` 重新入队**（幂等键就是 `id`），并把 `attemptCount + 1`、`nextRetryAtMs` 推后。
3. **去重**：`drainForSender` 本身就是"取出即移除"，重入队用原 `id`；发送前若队列里已存在同 `id` 条目则跳过，避免"定时器 + 下一条入站"同时补发造成重复。
4. 上限：单条最多 8 次；超过后保留在队列里但标记 `exhausted`，由看门狗/维修工接手（不再无限重试）。

## 相关修复与新增证据（2026-09-22）

这轮排查又暴露三件事，B 实现时要一并处理：

1. **看门狗整体停摆 4 天没人知道**（`794f8ee`）：`cyberboss-watchdog.ps1` 丢了 UTF-8 BOM，PowerShell 5.1 按 GBK 读，脚本里的 `♻️` 变乱码 → 每 15 分钟都解析失败（rc=1），日志从 09-18 17:16 起一行没写。**含中文的 .ps1 必须带 BOM**，这已是第二次踩。
2. **维修工叫不醒**（`14b30f1`）：会话 id 被 DSH 存储丢掉后，唤醒死在 `unknown session`；现在会归档失效 id 并自动重建。（另：维修工的回复文本未采集，ACP 的 `session/update` 通知没订阅，只影响日志可读性。）
3. **成功被当成失败**：桥日志实测出现 `POST /api/send → 200` 紧跟 `client disconnected before the response was written`，机器人侧记为 `failed` 并进 deferred 队列 —— 消息其实发出去了，却还在重试。B 的幂等设计必须覆盖这个场景：**发送结果未知（客户端断开）时，先按消息内容 + 时间窗去重核实，再决定是否重发**，否则补发会变成重复发送。

## Alternatives considered

- **只把 30 秒改成"下一次入站立即补发"**：已经是现状，解决不了"用户不说话就永远不发"。
- **让"处理中" ack 兼任补发通道**：ack 在下一条入站时才发，同样依赖用户开口。
- **直接复用回复义务的重试**：义务存储记录的是"该不该回"，不含回复正文；正文在 deferred 队列里，两套状态合并要动的面更大（还要处理 `_durable` 终态语义），本次不做。
- **无上限重试**：一条永远发不出去的回复会变成每 5 分钟一次的噪声，且掩盖真实故障（桥断了、桌面被抢）。选 8 次上限 + 交给人/维修工。
- **在桥里做重试**：桥只知道自己那一次 HTTP 调用失败，不知道"这条回复属于谁、后来有没有被别的路径发出去"，重试会造成重复发送。重试必须由持有队列与账本的一方（`app.js`）做。

## Acceptance criteria

1. 临时停掉桥（模拟发送失败）→ 发一条消息给机器人 → 桥恢复后 **≤60 秒**内自动收到那条回复，全程不需要再发任何入站消息。
2. 同一批延迟回复在"定时器补发"与"下一条入站前缀"之间**不会重复发送**（按 `id` 去重，日志可见跳过）。
3. 进程重启后仍会继续重试（`attemptCount` / `nextRetryAtMs` 落盘）。
4. 连续失败 8 次后停止重试，条目保留且标记 `exhausted`，日志与看门狗可见。

## Risks

- 这是**回复主链路**的改动：去重做错会重复发送（用户看到两遍），入队/出队做错会漏发。必须先在临时停桥的条件下验证，再放开。
- 定时器与既有 `primeDeferredRepliesForSender` 并发时，两边都可能 drain 到同一批 —— 去重靠 `id`，要写测试锁死。
- 只有"最近一次 contextToken"可用；若该 token 已过期（微信侧），直接发送会失败并进入退避，最终由人接手。这是可接受的降级方向（宁可留在队列，也不要丢）。
