# Agent Note: 入站回执只发第一条（"处理中"不再逐条刷）

Status: implemented

## Problem

用户要求："处理中"要**立刻回复**，但**连续消息不要连续发送**"处理中"。

现状（`src/core/app.js`）：到达路径 `routePreparedInbound` 在缓冲消息后立即调用
`acknowledgeBufferedInboundOnce`，所以"立刻回"这条本来就成立（回执与 dispatch 并行，且先发）。
但回执的去重是**按消息**做的：`pendingInboundStore.claimAcknowledgement(scopeKey, pendingId)`
用的是 `pendingId`，于是同一个会话里连发三条，三条各领一次 claim → 用户连收三条"处理中"。

## Decision

在 `acknowledgeBufferedInboundOnce` 里加一层**按会话的时间窗抑制**，并且放在 claim **之前**：

```js
const ackSuppressionKey = normalizeText(buffered?.scopeKey) || normalizeText(prepared?.senderId);
if (ackSentAtMs && Date.now() - ackSentAtMs < WEFLOW_UIA_INBOUND_ACK_REPEAT_SUPPRESS_MS) return false;
```

`WEFLOW_UIA_INBOUND_ACK_REPEAT_SUPPRESS_MS = 60_000`。时间戳表 `this.inboundAckSentAtMs`
懒创建（`Map`），避免改构造函数。

放在 claim 之前是关键：claim 一旦被消费就代表"这条消息的回执已处理"，若先 claim 再抑制，
被抑制的消息会处于"已认领但没发"的半处理状态，重放/重试路径会读到一个说不清的中间态。

## Alternatives considered

- **改 `claimAcknowledgement` 的键为 scopeKey**：动的是持久化存储的语义（durable claim 是
  "这条消息的回执归属"），会影响重放与崩溃恢复；而且窗口逻辑（时间）本来不属于存储层。
- **只在发送成功后记时间戳**：失败时用户什么也收不到，等于把"回执"变成不可靠的静默丢弃；
  当前实现与既有回执语义一致（先记后发，与 claim 的取舍相同）。
- **完全去掉重复回执（无限期抑制）**：长时间不理用户后再回复时，用户会以为消息没送到；
  60 秒窗口是"一轮连续输入"的合理近似。
- **不改，靠 dispatch 的静默期**：审阅发现那只控制**派发**时机，管不到回执条数。

## Consequences

收益：一个会话连发多条只收到一条"处理中"，且仍在到达路径上立刻发出。

代价与边界：

- 窗口是**每会话**的固定 60 秒，不是"直到本轮回合结束"；用户隔 61 秒再发会收到第二条回执
  （这是想要的：新的一轮）。
- 记忆在进程内（`Map`），重启后清空；第一轮消息会重新回执一次，符合预期。
- 未加自动化测试（回执路径依赖 store/渠道适配器；验证方式是实机连发三条只出现一条"处理中"）。
## 追加（同日，策略被用户要求取代）

用户明确要求"处理中"在收到消息后**立刻**发出，所以上面"一轮只回一条"的策略**作废**：现在每条消息
（按 `pendingId` 去重）都立刻回执。实现三处：抑制常量置 0（保留开关便于回退）；`acknowledgeBufferedInboundOnce`
里改为按消息 id 去重、并让 `claimed` 恒为真——原来 `pendingInboundStore.claimAcknowledgement` 的
scope 级门（`scope.acknowledgementStatus`）在上一条回合结束前一直关着，这就是"没第一时间收到处理中"的直接原因。
## 追加（同日，用户的最终口径）

用户在 `9f29a82`（抑制窗 0 → 5 s）之后把口径定死为：**"处理中"要第一时间发，但同一条连续消息只回一条**——
即按 15 秒采集窗口聚合。本节前半段的"每条消息都立刻回执"因此再次被取代，最终方案见
[「处理中」回执按 15 秒采集窗口聚合](../bug-fix/2026-09-29-inbound-ack-collection-window.md)。
这里"scope 级 durable 门在回合结束前一直关着"的观察仍然是事实，也是最终方案不动 store、只在 app 层判窗口的理由。