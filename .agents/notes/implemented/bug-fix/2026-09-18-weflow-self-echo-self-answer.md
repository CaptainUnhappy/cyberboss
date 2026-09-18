# Agent Note: WeFlow 自回声不再被当成人工输入（修掉"自问自答"）

Status: implemented

## Problem

迁移到「机器人账号跑在 RDPWrap 隔离会话里」之后（bot 读 Azzy 的库、写 Azzy 的微信），机器人的**每一条回复**都以"自己账号的发出消息"（`direction=outgoing`）出现在同一个库里。而 `src/core/app.js` 的路由逻辑是：

```js
if (classification?.origin === "cyberboss") { /* 回声，吞掉 */ return true; }
...
if (message?.direction === "outgoing") {
  effectiveMessage = { ...message, origin: "self_manual" };   // ← 当成"操作员亲手发的指令"
}
```

`self_manual` 是给"同号人工触发"（`scripts/weflow-self-manual-e2e.js`）用的语义：操作员在机器人自己的账号里打字，也算一次指令。问题在于**它同时是回声匹配失败时的兜底** `src/integrations/weflow-message-ledger-store.js:classifyObservedOutgoing()`：

- 未匹配 → `classification("self_manual")`（第 244/268/292/299/327 行，共 5 处）
- 能匹配上的窗口很窄：`MATCHABLE_STATUSES = {sending, failed_uncertain}`，而 `DEFAULT_MATCH_WINDOW_MS = 120_000`（**2 分钟**）；已 `verified` 的条目**不再可匹配**。

于是只要一条回复的回声**晚于 2 分钟**被观察到（轮询积压、重启后重放、状态已 verified），匹配失败 → 兜底 `self_manual` → **机器人把自己的回复当成指令，再回答一次自己**，对话开始自问自答。

**实测证据**（2026-09-18 11:46–11:49，用户只发了 2 条 `hi`）：

- 账本里出现 **4 条 `inbound_ack`**（每条对应一轮），多出来的两条正是机器人自己那两条回复；
- 会话里出现 3 组「处理中 + 正式回复」，其中一条回复内容为"咋还学上了"——即模型看到自己被回显的文本后作出的反应。

## Change

`src/core/app.js`（`handleObservedWeFlowMessage` 里的回声/人工分流处）：

1. **只有带 `[test]` 标记的发出消息**才允许走"同号人工"路径（复用既有的 `isTestSessionRequest()`，与仓库 E2E 的触发前缀一致）；其余未匹配的发出消息一律按**自己的回声**吞掉，并打印
   `[cyberboss] WeFlow self echo suppressed localId=… matchedBy=… marker=[test] missing`。
2. 把 `markPipelineUserInbound(...)` 移到守卫**之后**：被抑制的回声不再污染"用户入站"时间线。

改动集中在 1 处（全仓库 `origin: "self_manual"` 只有这一处赋值），无新配置项。

## Decision

在 `src/core/app.js` 的回声/人工分流处加**标记守卫**：只有带 `[test]` 的发出消息才允许走"同号人工"路径，其余未匹配的发出消息一律按自己的回声吞掉；同时把 `markPipelineUserInbound(...)` 移到守卫之后。不新增配置项。

## Alternatives considered

- **只放宽匹配窗口**（`CYBERBOSS_WEFLOW_OUTGOING_REPLAY_WINDOW_MS` / `matchWindowMs`）：仍然是有竞态的启发式——轮询积压或重启重放一旦超出窗口就复现，治标不治本。
- **把全部未匹配的发出消息都当回声**（彻底删掉"同号人工"语义）：会连带废掉 `e2e:weflow-self-manual`（它依赖"操作员在自己账号里发 `[test]`"这条路径），损失一个已验收的测试通道。
- **用本地 id 精确配对**：派发时还不知道回声的 `localId`（要等回声回来才回填），覆盖不了"第一次观察到"的场景。
- **新增开关 `CYBERBOSS_WEFLOW_ALLOW_SELF_MANUAL=false`**：能解决，但多一个必须记得设的旋钮；用 `[test]` 标记表达同一意图更显式，也不与既有 E2E 约定冲突。

## Consequences

- 机器人**不会再回复自己的回复**；正常对话变为「N 条入站 → N 组回复」。
- 代价（预期内）：**在机器人自己的账号里直接打字不再触发回复**——操作员应从**另一个账号**发给它（迁移后即为柳毓琳 → Azzy 这条真实入站），或显式带上 `[test]` 做手工测试。
- `[probe]` 之类没有 `[test]` 的探针文本不会再被路由（本轮用到的探针因此只剩日志可看）。
- `npm run check` 通过；`node --check src/core/app.js` 通过。

## Verification

- 代码：`npm run check` 全绿（exit 0）。
- 运行态：重启栈后 `WeFlow inbox enabled chat=wxid_ubo0cy5xh4px22 baseUrl=http://127.0.0.1:5051`、`canary inbox enabled chat=wxid_ty69l7hjiqt012 contact=Ally`，游标文件重建并持续刷新。
- 待补的一次真实端到端复核（需要一条**真实入站**）：从柳毓琳手机发一条 → 期望「1 条入站 → 1 组回复」，且账本 `inbound_ack` 只 +1。
