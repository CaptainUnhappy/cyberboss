# Agent Note: 系统触发带上个人号聊天路由（check-in 不再被回复窗口挡住）

Status: implemented

## Problem

2026-09-30 [恢复 check-in](../feature/2026-09-30-restore-checkin-and-start-timeline.md) 后实测到两个叠加的缺口，它们一起让"主动唤醒"变成"会醒、会想说、说不出去"，而且想说的内容不具体。

**缺口 1：系统触发的投递只走官方通道，而官方通道需要回复窗口。** `SystemMessageDispatcher.buildPreparedMessage` 把 `provider` 固定为 `"system"`、`chatId` 取 `senderId`（本例 = 官方 bot openid `o9cq803f…@im.wechat`）。`src/adapters/channel/weixin/index.js:97` 只认 `provider === "weflow-uia"` 才走个人号桥，否则一律 `sendText({contextToken})` 走官方通道。而 `context_token` 只能由入站消息产生（[iLink 实测契约](../architecture/2026-09-30-ilink-bot-api-observed-contract.md)：`ret=-2 prepare failed` = 缺有效 token），入站产生的窗口又被那条回复本身用掉。实测：check-in 在用户最后一条入站 42 分钟后触发，用落盘的旧 token 发送 → `ret=-2` → 进 `deferred-system-replies.json` 等"下一次入站补发"。

**缺口 2：系统触发自成会话，拿不到用户的聊天上下文。** `resolveConversationKeyForSource`（`src/core/app.js:4237`）返回 `chatId`，而系统触发的 `chatId = senderId` ⇒ 新建独立会话（实测 `52ee56a6-…`），与用户的窗口会话（`weflow:wxid_ubo0cy5xh4px22` → `d6a60ead-…`）不是同一个。于是 agent 只能靠 memory/timeline 猜，产出的是"今天过得咋样"这种最泛的问候 —— 而 memory 里 pinned 的偏好恰好写着"主动消息要短、自然、具体"。

## Decision

1. **队列条目可以携带自己的投递路由**：`SystemMessageQueueStore.normalizeSystemMessage` 白名单增加可选 `chatId` / `provider`。两者都为空时**不写这两个键**，所以旧队列文件与旧写入方的行为逐字节不变。
2. **dispatcher 透传而不是自行决定**：`SystemMessageDispatcher.buildPreparedMessage` 用条目上的 `chatId` / `provider`，缺省回落 `senderId` / `"system"`。
3. **check-in 的路由来自配置且必须显式**：`resolveCheckinReplyRoute`（`src/app/system-checkin-poller.js`）读 `CYBERBOSS_CHECKIN_CHAT`，只接受 `weflow:` 前缀并把 provider 推导为 `weflow-uia`；给了非 `weflow:` 的值就**启动即报错**，不静默回落到那条发不出去的通道。`.env` 现配 `CYBERBOSS_CHECKIN_CHAT=weflow:wxid_ubo0cy5xh4px22` 与 `CYBERBOSS_CHECKIN_WORKSPACE=D:\Projects\cyberboss\user\cyberboss`。
4. **路由挂在 `chatId`/`provider` 上，`senderId` 不动**。senderId 仍是官方用户 ⇒ binding 键与 token 解析语义不变；`dispatchSystemMessage` 的"无 token 就重映射到唯一在线用户"分支只改 `senderId`，因此不再需要给那个分支加守卫（这是落地时相对提案的简化）。
5. **两件事一次解决**：会话键来自 `chatId` ⇒ 触发复用用户窗口会话（有上下文）；reply target 带 `provider=weflow-uia` + `weflowContact/weflowTalker` ⇒ 经个人号桥发出，没有回复窗口。

## Verification

- 单测：`node --test test/system-inbound.test.js` → 新增 4 例全绿（队列路由落盘 + 缺省不带键 / dispatcher 透传与回落 / `dispatchSystemMessage` 端到端保持路由 / `resolveCheckinReplyRoute` 校验）。同文件 1 例既存失败 `quoted attachments retain their origin and reference through persistence`：把测试文件回退到 `HEAD` 版本同样失败，与本次改动无关。`npm run check` 绿。
- 真机（重启后 bot PID 6788，日志 `cyberboss.service.20260930-174615.out.log`）：
  - `checkin reply route weflow:wxid_ubo0cy5xh4px22 provider=weflow-uia`（启动即确认路由生效，且 workspace 已是被钉住的 `user/cyberboss`，不再是 `user/Unhappy`）
  - `checkin queued id=2926637c-2465-4c57-8a66-ff94f61d311e`
  - `dsh-acp resumed session d6a60ead-a7f4-4146-9570-9a4ca2c1848f for window weflow:wxid_ubo0cy5xh4px22` ⇒ **复用了用户窗口会话**（缺口 2 消除）
  - 账本 `2026-09-30T09:48:33.039Z status=verified localId=422 expectedDirection=outgoing`，紧跟 `WeFlow echo consumed direction=outgoing localId=422` ⇒ **经个人号桥真实送达**（缺口 1 消除）
  - `deferred-system-replies.json` 全程 `{"replies":[]}`：没有 `ret=-2`、没有待补发

## Alternatives considered

- **只把 check-in 的 `senderId` 写成 `weflow:<talker>`**：改动最小（一行 `.env`）。否决原因有两层：`resolvePreferredSenderId` / binding 都按 senderId 建键，换掉它会换 binding；而且 `dispatchSystemMessage` 会因为该 key 没有 context token 而把它重映射回唯一在线用户，`chatId` 随之复原 —— 只改配置拿不到路由。落地形态因此改成"路由独立于 senderId"。
- **给官方通道加"常驻 token 刷新"**：最强理由是官方通道才是"正牌 bot"，个人号桥依赖桌面 UIA、更脆。否决：`context_token` 由服务端按入站消息发放，没有刷新接口；主动推送在这个通道上不是"还没做"，而是协议上不成立。
- **让 agent 自己用工具把消息发出去（绕开系统回复路径）**：现有工具里只有 `cyberboss_channel_send_file_any`（任意文件、走个人号桥），没有"发一段文本"的工具。可行但等于让模型自己选题材去调发送 API，把"该不该发、发给谁"的判断从框架挪进提示词，更难审计。
- **保持现状，只在提示词里要求 agent"少发、发具体"**：不减一个失败点。上下文缺失是结构性的（独立会话），不是措辞问题。
- **顺带把提醒与 `cyberboss_system_send` 一起改**：它们走同一条系统触发路径，但目标语义可能不同（提醒或许刻意要发到官方通道），所以本次只给 check-in 一个显式配置入口，其余按同一机制逐步接入。

## Consequences

- **收益**：主动唤醒的两个堵点同时消失 —— 实测 `localId=422 verified` + `deferred-system-replies.json` 保持空 + 回合复用用户窗口会话。改动面小且向后兼容：不配置就是旧行为，旧队列文件不产生新键。
- **代价与已知上限**：check-in 与用户回复共用会话，主动回合会写进该会话历史（上下文变长、`/compact` 压力上升）；个人号桥依赖桌面 UIA（窗口前台、桌面空闲等约束），比 HTTP 通道脆，桥不可用时仍靠 deferred 兜底（只是现在兜底条目自带可用的路由）；配置写错（非 `weflow:`）会让 poller 启动即失败 —— 这是刻意的，`checkin poller stopped: …` 是可见的失败而不是静默降级。
- **未做的部分**：目标解析（`resolvePreferredSenderId` / `resolvePreferredWorkspaceRoot`）仍默认读 codex 时代的 `sessions.json`，check-in 靠 `CYBERBOSS_CHECKIN_WORKSPACE` 显式钉住工作区；要彻底消除漂移需让它改用当前运行时的会话存储（`runtimeAdapter.getSessionStore()`），涉及 tooling 的构造顺序，留给下一次。
