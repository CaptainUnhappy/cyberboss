# Agent Note: WeFlow 回复投递握手（「处理中」+ 完成校验 + 失败重传）

Status: proposed

## Problem

迁移到隔离会话后，机器人的收发全靠 UIA 桥驱动微信窗口。桥一旦不可用（RDP 客户端被最小化/隐藏、会话失去输入桌面等），**发送会静默失败**：入站照常被消费、轮次照常跑完、日志照常写，但对方什么都收不到。

现网实测（2026-09-18 13:15–13:18，隔离会话不可注入的那段窗口）：

```
05:15:11Z  kind=progress     status=failed  attempts=1
05:16:03Z  kind=progress     status=failed  attempts=1
05:16:44Z  kind=(final)      status=failed  attempts=1
05:16:46Z  kind=inbound_ack  status=failed  attempts=1
05:16:48Z  kind=inbound_ack  status=failed  attempts=1
05:18:07Z  kind=(final)      status=failed  attempts=1
```

即：**连「处理中」都没送到**，最终回复也没送到；`attempts=1` 说明**失败即终止，没有重传**，也没有任何面向用户的失败回报。用户侧表现为"发了消息，一直没有回应"，而系统侧一切"正常"。

现有资产（可复用，不必另起一套）：

- `src/core/reply-obligation-store.js` 已有完整投递状态机：`handoff_pending / handoff_uncertain / awaiting_final / final_delivery_pending / delivery_uncertain / verified / deferred_durable`，并记录 `deliveryAttemptCount`、`deliveryVerifiedAt`、`deferredAt`，提供 `markVerified` / `markDeferred` / `reconcileWithLedger`。
- `src/integrations/weflow-message-ledger-store.js` 记录每条消息的 `status`（`planned/sending/verified/failed/failed_uncertain`）与 `attemptCount`，并具备内容哈希去重能力（既用于回声抑制，也可用于重传去重）。
- 桥 `POST /api/send` 已返回 `{dispatched, verified, uncertain, verificationError}`：**送达确认这件事在桥这一层已经具备**。
- `src/core/deferred-system-reply-store.js` 提供"延后到下一次入站再冲"的队列（当前只在特定系统消息上使用）。
- 新装的任务 `cwin-s1-rdp-keepalive`（每 5 分钟探针隔离会话是否可注入）可直接作为"桥恢复健康"的信号源。

## Proposal

把「处理中 → 完成」做成一次**可验证的握手**，并给失败一条确定的路：

1. **SYN-ACK：受理回执必须送达**
   收到入站后发「处理中」；以桥回执 `verified:true`（或账本核对）为送达判据。未送达 → 按退避重试；重试预算耗尽 → **落入 durable 队列**（`markDeferred` → `deferred_durable`），在下一个入站到达时优先冲刷。
2. **ACK：最终回复必须完成校验**
   最终回复发出后，用现有 `reconcileWithLedger` 核对它确实出现在对方库里；未核对上 → 保持 `final_delivery_pending` / `delivery_uncertain`，**不置终态**，等桥恢复后重传。
3. **重传去重（must）**
   重传前必须查账本：同一 `talker + contentHash + direction` 已有 `verified` 条目则**不得重发**（避免重复轰炸）；桥侧 `verified:false` 时按 `uncertain` 处理，交由账本核对裁决。
4. **重试触发（三路都要）**
   ① 下一次入站到达时（复用 `primeDeferredRepliesForSender`）；② 定时扫描（例如每 2 分钟扫 `final_delivery_pending` / `deferred_durable`）；③ **健康事件**——保活任务探到隔离会话恢复后投递一次"可以重传了"的信号。
5. **永不静默（must）**
   重试预算耗尽后，从**官方通道**（`ilinkai`，不依赖隔离会话）给用户发一条失败通知（含被卡住的消息摘要与原因），并记入账本；不允许只写日志。
6. **启动恢复**
   进程启动时把 `final_delivery_pending` / `delivery_uncertain` 重新纳入待办，而不是当成历史。

## Alternatives considered

- **只在桥里加重试**：桥是无状态执行器，进程重启/换实例就丢上下文；且它不知道"这条回复对应哪一轮对话"。重传决策必须属于持有账本的一侧（bot）。
- **失败即写 durable 队列、不做送达校验**：能减少丢失，但仍无法回答"最终回复到底有没有送到"，正是本次问题的核心。
- **无上限重试直到送达**：会造成历史消息在很久之后集中轰炸对方（尤其隔离会话长时间不可用时），且与"回声抑制"叠加时有放大风险。故采用**有界重试 + durable 兜底 + 明确通知**。
- **要求"对方已读回执"**：微信个人号没有可靠的已读回执通道；把判据定在"消息出现在对方库里"（桥的 `verified` / 账本核对）是当前唯一可机械验证的层级。
- **新建一套独立的投递账本**：与 `reply-obligation-store` 的现有状态机重复，且两套状态必然漂移；复用并补齐缺口成本更低。

## Acceptance criteria

- 隔离会话不可注入时发消息：日志出现明确的失败与重试记录；恢复可注入后，**未送达的「处理中」与最终回复被自动重传且只重传一次**（账本中同一 `contentHash` 只有一条 `verified`）。
- 重试预算耗尽时，用户能在**官方通道**收到一条失败通知（不依赖隔离会话）。
- 正常路径无回归：一次入站 → 恰好一组「处理中 + 最终回复」，账本 `inbound_ack` 只 +1（沿用 `2026-09-18-weflow-self-echo-self-answer.md` 的验证方法）。
- `npm run check` 与 `npm run verify-notes` 通过。

## Risks

- **重复投递**：重传与桥内重试叠加可能造成重复消息；靠 `talker + contentHash + direction` 的账本去重与 `verified` 终态约束来兜底，但需要一条针对重复的验收用例。
- **顺序颠倒**：延迟重传可能让「处理中」晚于最终回复到达；需要在重传时判断该轮是否已有更晚的消息送达，必要时跳过回执只补最终回复。
- **与回声抑制的交互**：重传会再次产生"自己的发出消息"，必须确保被 `self echo suppressed` 正确吞掉（同一机制已验证）。
- **通知通道依赖**：失败通知走官方通道，若该通道也不可用，则只能退回日志与看板——需要在实现时明确这一降级。
