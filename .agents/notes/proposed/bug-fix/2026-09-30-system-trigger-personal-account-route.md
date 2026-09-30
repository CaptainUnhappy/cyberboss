# Agent Note: 系统触发（check-in / 提醒）应落在用户自己的会话与投递路由

Status: proposed

## Problem

2026-09-30 [恢复 check-in](../../implemented/feature/2026-09-30-restore-checkin-and-start-timeline.md) 后实测到两个叠加的缺口，它们一起让"主动唤醒"变成"会醒、会想说、说不出去"，而且想说的内容不具体。

**缺口 1：系统触发的投递只走官方通道，而官方通道需要回复窗口。** `SystemMessageDispatcher.buildPreparedMessage`（`src/core/system-message-dispatcher.js:38`）把 `provider` 固定为 `"system"`、`chatId` 取 `senderId`（本例 = 官方 bot openid `o9cq803f…@im.wechat`）。`src/adapters/channel/weixin/index.js:97` 只认 `provider === "weflow-uia"` 才走个人号桥，否则一律 `sendText({contextToken})` 走官方通道。而 `context_token` 只能由入站消息产生（[iLink 实测契约](../../implemented/architecture/2026-09-30-ilink-bot-api-observed-contract.md)：`ret=-2 prepare failed` = 缺有效 token），入站产生的窗口又被那条回复本身用掉。实测：check-in 在用户最后一条入站 42 分钟后触发，用落盘的旧 token 发送 → `ret=-2` → 进 `deferred-system-replies.json` 等"下一次入站补发"。

**缺口 2：系统触发自成会话，拿不到用户的聊天上下文。** `resolveConversationKeyForSource`（`src/core/app.js:4237`）返回 `chatId`，而系统触发的 `chatId = senderId` ⇒ 新建独立会话（实测 `52ee56a6-…`），与用户的窗口会话（`weflow:wxid_ubo0cy5xh4px22` → `d6a60ead-…`）不是同一个。于是 agent 只能靠 memory/timeline 猜，产出的是"今天过得咋样"这种最泛的问候 —— 而 memory 里 pinned 的偏好恰好写着"主动消息要短、自然、具体"。

附带事实（同一次排查发现，不改行为）：`runSystemCheckinPoller` 与 `createProjectTooling` 用 `new SessionStore({filePath: config.sessionsFile})` 解析目标，即 codex 时代的 `sessions.json`；DSH 时代真正在用的 `dsh-sessions.json` 里该 binding 的 `activeWorkspaceRoot` 是 `user/cyberboss`，而 legacy 文件里停在 `user/Unhappy`，于是日志实测 `checkin poller ready … workspace=D:/Projects/cyberboss/user/Unhappy`。

## Proposal

让系统触发**可以携带一条"个人号聊天路由"**，把投递与会话一次解决：

1. `SystemMessageQueueStore.normalizeSystemMessage` 白名单增加可选 `chatId` / `provider`（缺省时行为与今天完全一致：`chatId = senderId`、`provider = "system"`）。
2. `SystemMessageDispatcher.buildPreparedMessage` 用条目上的 `chatId` / `provider`（缺省回落到 `senderId` / `"system"`）。
3. `dispatchSystemMessage` 的"无 token 就重映射到唯一在线用户"分支要认得显式路由：路由为 `weflow:` 时**不重映射**（重映射会把 `chatId` 一起换掉，路由就丢了）。
4. 目标来源用配置表达，不写死：`CYBERBOSS_CHECKIN_CHAT=weflow:wxid_ubo0cy5xh4px22`（poller 已有 `CYBERBOSS_CHECKIN_USER_ID` / `CYBERBOSS_CHECKIN_WORKSPACE` 两个先例），provider 由 `weflow:` 前缀推导为 `weflow-uia`。
5. 目标解析改用**当前运行时**的会话存储（`runtimeAdapter.getSessionStore()`），legacy `sessions.json` 只作为回落 —— 否则工作区会一直停在被淘汰的那份记录上。

落地后的预期：check-in 的 `conversationKey` = `weflow:<talker>` ⇒ 与用户同一个会话（上下文里就有今天发生的事），reply target 带 `provider=weflow-uia` + `weflowTalker` ⇒ 经个人号桥发出，**没有回复窗口**，也就没有 `ret=-2` 与 deferred 队列。

## Alternatives considered

- **只把 check-in 的 `senderId` 写成 `weflow:<talker>`**：改动最小（一行 `.env`），但 `dispatchSystemMessage` 会因为该 key 没有 context token 而把它重映射回唯一在线用户，`chatId` 随之复原，路由拿不到 —— 只改配置达不到目的。
- **给官方通道加"常驻 token 刷新"**：最强理由是官方通道才是"正牌 bot"，个人号桥依赖桌面 UIA、更脆。否决：`context_token` 由服务端按入站消息发放，没有刷新接口；主动推送在这个通道上不是"还没做"，而是协议上不成立。
- **让 agent 自己用工具把消息发出去（绕开系统回复路径）**：现有工具里只有 `cyberboss_channel_send_file_any`（任意文件、走个人号桥），没有"发一段文本"的工具。可行但等于让模型自己选题材去调发送 API，把"该不该发、发给谁"的判断从框架挪进提示词，更难审计。
- **保持现状，只在提示词里要求 agent"少发、发具体"**：不减一个失败点。上下文缺失是结构性的（独立会话），不是措辞问题。
- **顺带把提醒（reminder）与 `cyberboss_system_send` 一起改**：它们走同一条系统触发路径，但要先确认各自的目标语义（提醒可能刻意要发到官方通道），所以本次提案只承诺 check-in 这一条的配置入口，其余按同一机制逐步接入。

## Acceptance criteria

- `checkin-config`/`.env` 指定 `weflow:` 聊天后，check-in 回合的 session 与用户窗口会话**同 id**（`dsh-sessions.json` 的 `threadIdByConversationByRuntime["dsh-acp"]["weflow:<talker>"]` 不新增条目即证明复用）。
- 用户不说话的时段里 check-in 产生的消息**直接送达**（账本出现 `verified` 条目，`deferred-system-replies.json` 不新增 check-in 条目）。
- 未配置 `CYBERBOSS_CHECKIN_CHAT` 时行为与今天逐字节一致（回归测试锁死缺省分支）。
- `npm run check` 与 `npm run verify-notes` 绿。

## Risks

- 这是**投递主链路**的改动：路由判断写错会把回复发到错误的会话（用户看到串台）。必须先用 `[test]` 会话或小号窗口验证，再放开到用户会话。
- check-in 与用户回复共用一个会话，意味着主动回合会把内容写进该会话历史（上下文变长、`/compact` 压力上升）；若用户不喜欢，需要退回"独立会话 + 个人号投递"的半套方案。
- 个人号桥依赖桌面 UIA（窗口前台、桌面空闲等约束），比 HTTP 通道更脆；桥不可用时 check-in 消息仍要靠 deferred 兜底。
