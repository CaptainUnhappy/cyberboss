# Agent Note: WeFlow 入站扩为多会话 + 回复按会话路由（Azzy→Ally 没有回复的根因）

Status: implemented

## Problem

Azzy 给本机登录的 Ally 发消息后**永远没有回复**。逐层排查（2026-09-17）：

1. **消息确实到了**：微信 UI `session_item_Azzy` 显示未读 2 条（`你是谁` 09:14、`hi` 09:16）。
2. **WeFlow 也读得到**：`/api/v1/messages?talker=wxid_s3178hwvzsl922` 返回 5 条（含 `isSend=0`）。WeFlow 侧的白名单漏配过，补上后会话与消息都可见。
3. **机器人这一侧完全没动**：`%USERPROFILE%\.cyberboss\logs` 近 20 分钟无写入，也搜不到 Azzy 的 talker。
4. **拦截点（根因一：入站作用域）**：入站目标只有一个 —— `.env` 的 `CYBERBOSS_WEFLOW_INBOX_CHAT=wxid_ubo0cy5xh4px22`（柳毓琳），而 `src/integrations/weflow-inbox.js` 在**待处理事件过滤**与**推送过滤**两处用严格相等比较，Azzy 的消息在"要不要回"之前就被丢掉。
5. **拦截点（根因二：回复路由）**：作用域放开后，入站确实被处理，但回复全部落回**配置里的主会话**。真机触发 Azzy 会话后，台账里 ack 与最终回复的 `talker` 都是 `wxid_ubo0cy5xh4px22`；第一次自动 E2E 报 `processing=0, final=0`（Azzy 会话里什么都没有）。

结论：WeFlow 白名单是必要条件，**不是充分条件**；真正的开关在本仓库的入站作用域，以及回复目标里的会话身份。

## Decision

1. 新增环境变量 `CYBERBOSS_WEFLOW_INBOX_CHATS`（逗号分隔），缺省回退到旧的单值 `CYBERBOSS_WEFLOW_INBOX_CHAT`；`src/core/config.js` 解析成 `weflowInboxChats` 数组并导出。
2. **入站过滤器接受作用域内任意会话**（待处理事件过滤、推送过滤、活动过滤三处），统一走 `config.weflowInboxChats`。
3. **出站轮询跟随作用域**：`pollOutgoingMessagesOnce` 提取 `inboundChatScope()`，逐会话调用 `pollOutgoingMessagesOnceForChat(chat)` 并聚合结果；这样非主会话里"自己发出的消息"也会被观察（否则 `self_manual` 触发在非主会话永远看不见）。
4. **回复按会话路由，载体是 `chatId`**：入站时 `chatId = weflow:<talker>`（既有字段，全程携带）；出站前由 `resolveWeFlowUiaReplyChat(source)` 解析出 talker，同时写入 `weflowContact` 与 `weflowTalker`（桥按 talker 从联系人表解析显示名，`contact` 允许直接给 wxid）。两个解析点：`buildReplyTargetFromPrepared`（回复目标）与 `acknowledgeWeFlowUiaInbound`（"处理中"确认）。
5. **回复 payload 的路由只有一个出口**：`stream-delivery` 的 `applyWeFlowReplyRoute(payload, target)`，被最终回复、系统回复、图片发送失败通知、补发重试四处共用。此前只有 canary 路径转发这两个字段，普通回复静默丢弃。
6. **明确不借用 canary 的 `replyWeflowContact/replyWeflowTalker`**（原因见 Alternatives）。
7. `weflowInboxChat` 保持原样，继续作为主会话：canary 隔离断言（`assertWeFlowCanaryTalkerIsolation`）与"发送源"语义不变。

## Verification

- 单元测试：`test/weflow-inbox.test.js`（含新增 4 例：UIA 路由落 `chatId`、bot 路由不带 UIA 目标、普通 UIA turn 的 `chatId` 解析成 contact/talker、ack 带路由）、`test/stream-delivery.test.js`（新增 1 例：最终回复 payload 带 `weflowContact/weflowTalker`）、`test/weflow-model-canary.test.js`（canary 路由未被削弱）等 154 例全绿；`npm run check` 通过。
- 真机自动 E2E（`npm run e2e:weflow-self-manual`，脚本自己往目标会话发一条无台账的同号人工消息，再等"处理中 + 含唯一标记的最终回复"）：
  - 主会话（柳毓琳，回归）：`ok=true`，trigger 28 → ack 29 → final 30（02:13:53 / 02:14:12Z）。
  - Azzy 会话（本次修复的目标）：`ok=true`，trigger 20 → ack 21 → final 22（02:12:33 / 02:12:52Z）；去掉诊断日志后复跑 trigger 23 → ack 24 → final 25（02:14:39 / 02:14:54Z），两轮都通过 exactly-once、顺序与 8s 静默窗口复核。
  - 台账旁证：修复前 Azzy 触发的 ack/final 记在 `talker=wxid_ubo0cy5xh4px22`；修复后记在 `talker=wxid_s3178hwvzsl922`。
- 排查过程中的一次失败值得留痕：第一次修复把路由挂在 `replyWeflowContact/replyWeflowTalker` 上，真机诊断打印 `prepared replyChat=(empty)`，ack 仍去主会话 —— 字段在到达回复目标前就被剥掉了。

## Alternatives considered

- **复用 canary 的 `replyWeflowContact/replyWeflowTalker` 作为路由载体**（最强候选：零新增契约，这两个字段本来就贯穿 prepared→target→payload，canary 的最终回复已经在转发它们）。否决原因：`stripModelCanaryPreparedFields` 会在**普通入站**上删除这两个字段，这是有意的收容规则（canary 回复路由不得由普通消息影响）；换成新字段 `weflowReplyChat` 同样不行 —— `clonePreparedInboundMessage` 是严格白名单，入站排队/合并时会把未登记的字段丢掉。最后改用已全程携带的 `chatId`，一处解析、零新增字段。
- **用官方 bot 通道（`provider=weixin`）回复非主会话**（最强理由：不抢前台、不依赖 UIA 空闲）。否决原因：持久化的 contextToken 只对 `…@im.wechat` 官方会话存在（实测 `accounts/*.context-tokens.json` 两个账号各一个 openid token），个人 wxid 既没有 token 也无法在本地生成，原生通道发不出去。
- **只给最终回复带路由，不管"处理中"确认**（改动最小）。否决原因：真机第一步就把 ack 发去了主会话（台账 localId 24 → `wxid_ubo0cy5xh4px22`），用户会先看到确认出现在错误会话，比没有回复更容易误解。
- **把 `weflowInboxChat` 直接改成逗号分隔的字符串**：该值同时被当作"单个轮询目标"和"canary 隔离锚点"使用，塞多值会让这两处语义变形。
- **对 2818 行的集成做完整多会话重构**（多游标、多待处理队列）：语义最干净，但改动面覆盖游标状态、补齐逻辑与配对逻辑，回归风险远高于收益。
- **在 WeFlow 侧再放宽（让它推送所有会话）**：WeFlow 已按白名单推送；问题在本仓库的本地过滤，放宽上游不解决本地丢弃。

## Consequences

- **收益**：入站作用域变成显式可配的多目标；回复跟随发送者，多会话入站真正可用（真机 Azzy 会话两轮全绿）。
- **代价**：出站轮询按作用域逐会话发请求（每轮 N 次读取，N=作用域会话数）；目标 talker 必须在 `CYBERBOSS_WEFLOW_ALLOWED_TALKERS` 白名单内，否则回复被 403 拒绝；`senderId` 仍是配置的回复用户（官方 bot openid），所有作用域会话共享一个绑定键，会话隔离依赖 `chatId`/threadId；`weflowInboxChats` 为空时行为与旧版完全一致（升级零影响）。
- **未覆盖**：命令回复（`/help`、`/bind` 等约 30 处 `channelAdapter.sendText`）与部分系统通知仍回落到配置会话 —— 它们各自复制 payload，本次只保证"入站回复链路"（ack + 最终回复 + 系统回复 + 图片通知 + 补发）正确；`senderId` 未按会话拆分，跨会话共享模型会话绑定。
