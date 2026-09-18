# Agent Note: 同号人工输入靠账本归因，而不是靠 `[test]` 标记

Status: implemented

本笔记**取代** [同号自回声修复](../../archived/bug-fix/2026-09-18-weflow-self-echo-self-answer.md) 里的标记守卫决定（那篇已归档，保留事件与备选记录）。

## Problem

迁移到「机器人账号跑在隔离会话」后，机器人自己的每一条回复都以"本账号的发出消息"（`direction=outgoing`）出现在同一个库里。`src/core/app.js` 的分流是：

```js
if (classification?.origin === "cyberboss") { /* 账本认领 → 回声，吞掉 */ return true; }
...
if (message?.direction === "outgoing") {
  effectiveMessage = { ...message, origin: "self_manual" };   // 操作员在自己账号里打字
}
```

**前半段才是回声防线**：账本（`weflow-message-ledger-store.classifyObservedOutgoing`）认得这条发出消息是我们自己发的，就吞掉、不路由。同号人工输入之所以一直可用，正是因为它落在"账本不认领"的那一侧。

问题出在**账本认领会漏**：

```js
// resolveEntryMatchWindowMs
if (entry.expectedDirection === "incoming") return nativeMatchWindowMs;   // 本人回复：整段保留期
if (entry.status === "failed_uncertain") return uncertainMatchWindowMs;   // 15 分钟
return matchWindowMs;                                                     // 2 分钟  ← 未核验的发出
```

而 UIA 桥的**严格确认**（搜索框焦点 → 结果稳定性 → 按回车）会让一次发送本身耗时**数分钟**。于是回声行往往在 `sendingAt + 3min` 才被轮询到 → 超出 2 分钟窗口 → 匹配失败 → 回落成 `self_manual` → 机器人把这**自己的回复**当成操作员指令 → 自问自答。

实测（2026-09-18 11:43–11:49）：用户手发 2 条 `hi`，账本出现 4 条 `inbound_ack`，多出的两条正是机器人自己的回复。

第一次修复（[旧笔记](../../archived/bug-fix/2026-09-18-weflow-self-echo-self-answer.md)）选择了**标记守卫**：只有带 `[test]` 的发出消息才算人工输入，其余一律吞掉。它止住了自问自答，但**代价是砍掉了同号人工输入这一正常用法** —— 用户随后在 Azzy 里打字就再也得不到回复（`WeFlow self echo suppressed … marker=[test] missing`）。方向错了：**回声该由账本归因来挡，不该由标记来挡。**

## Decision

1. **撤掉 `[test]` 标记守卫**（`src/core/app.js`）：未匹配的发出消息恢复为 `origin: "self_manual"`，同号人工输入继续可用。`markPipelineUserInbound` 保持在 outgoing 分支之后（不再有被抑制的分支，位置不再影响语义）。
2. **把漏认领的根因补掉**（`src/integrations/weflow-message-ledger-store.js` 的 `resolveEntryMatchWindowMs`）：**任何未核验的发出条目**都使用有界的追赶窗口 `uncertainMatchWindowMs`（默认 15 分钟），而不是"仅 `failed_uncertain` 才给 15 分钟、其余只给 2 分钟"。
   安全性依据（现在是事实）：已核验（`verified`）的条目被 `MATCHABLE_STATUSES` 排除，**不可能**吞掉之后的人消息；唯一残留风险是"一条从未被观察到的发送 + 15 分钟内出现完全相同的发出文本"，而这与原本就给 `failed_uncertain` 的窗口是同一个已接受的取舍。
3. 归因判据保持为 `talker + contentHash + contentKind + expectedDirection + 时间窗`（`localId` 精确匹配优先），不引入任何新配置项、不引入标记前缀。

## Alternatives considered

- **保留 `[test]` 标记守卫、只把窗口放宽**：止漏最稳，但直接废掉同号人工输入（用户明确要求恢复），且把"我们自己的回声"与"操作员手打的字"混成同一类，语义上就错了。**已实现并撤销**，全过程保留在归档笔记里。
- **给 `[test]` 换成别的显式前缀（如 `/cmd`）**：本质同上一路，只是把门槛换个字；仍要求操作员记住标记，仍然牺牲同号可用性。
- **未核验的发出条目永不过期（用整段保留期）**：漏认领彻底消失，但一条从未被观察到的发送会在 7 天里持续吞掉同文本的人消息；有界窗口是更小的代价。
- **在派发侧持续刷新 `sendingAt`**：能让窗口贴着真实发送时间走，但覆盖面小于"直接给未核验条目追赶窗口"，且桥内部重试对账本不可见；本轮未采用（若后续仍见漏认领，这是下一个该动的地方）。

## Consequences

- **同号人工输入恢复**：在机器人自己的账号里打字 → 触发一轮（不再是静默丢弃）。
- **回声仍被挡住**，而且挡在正确的地方：账本认领（`WeFlow echo consumed … matchedBy=local_id`），而不是靠标记。
- 代价：未核验的发出条目在 15 分钟内仍可能吞掉同文本的人消息（与既有 `failed_uncertain` 窗口同风险，有界、可接受）。
- 影响面：`src/core/app.js`（撤守卫）与 `src/integrations/weflow-message-ledger-store.js`（窗口）两个文件；`npm run check` 通过。
- 与投递握手方案（`proposed/feature/2026-09-18-weflow-reply-delivery-handshake.md`）的关系：那篇解决"发不出去"（重传 + 完成校验），本篇解决"发出去了但没被认领"（归因窗口）；两者互补，都指向同一句话——**账本是唯一权威**。

## Verification

2026-09-18 14:00，以"同号人工"身份经桥（8776）发一条到主收件箱会话：

```
send -> {"dispatched":true,"verified":true,"localId":"35"}
[cyberboss] inbound acknowledged message=weflow:7177484520041474571
[cyberboss] dsh-acp resumed session dbc79ab4-… for window weflow:wxid_ubo0cy5xh4px22
[cyberboss] WeFlow echo consumed direction=outgoing localId=36 matchedBy=local_id
[cyberboss] WeFlow echo consumed direction=outgoing localId=37 matchedBy=local_id
inbound_ack: 107 → 108（+1）
```

一次入站 → 恰好一组回复；机器人自己的两条发出消息（localId 36/37）被账本认领并吞掉 → 无自问自答。
