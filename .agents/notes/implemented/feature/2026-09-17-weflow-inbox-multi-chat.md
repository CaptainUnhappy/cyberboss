# Agent Note: WeFlow 入站扩为多会话（Azzy→Ally 没有回复的根因）

Status: implemented

## Problem

Azzy 给本机登录的 Ally 发消息后**永远没有回复**。逐层排查（2026-09-17）：

1. **消息确实到了**：微信 UI `session_item_Azzy` 显示未读 2 条（`你是谁` 09:14、`hi` 09:16）。
2. **WeFlow 也读得到**：`/api/v1/messages?talker=wxid_s3178hwvzsl922` 返回 5 条（含 `isSend=0`）。WeFlow 侧的白名单漏配过，补上后会话与消息都可见。
3. **机器人这一侧完全没动**：`%USERPROFILE%\.cyberboss\logs` 近 20 分钟无写入，也搜不到 Azzy 的 talker。
4. **拦截点**：入站目标只有一个 —— `.env` 的 `CYBERBOSS_WEFLOW_INBOX_CHAT=wxid_ubo0cy5xh4px22`（柳毓琳），而 `src/integrations/weflow-inbox.js` 在**待处理事件过滤**与**推送过滤**两处用严格相等比较，Azzy 的消息在"要不要回"之前就被丢掉。

结论：WeFlow 白名单是必要条件，**不是充分条件**；真正的开关在本仓库的入站作用域。

## Decision

1. 新增环境变量 `CYBERBOSS_WEFLOW_INBOX_CHATS`（逗号分隔），缺省回退到旧的单值 `CYBERBOSS_WEFLOW_INBOX_CHAT`；`src/core/config.js` 解析成 `weflowInboxChats` 数组并导出。
2. **只改两处入站过滤器**（待处理事件过滤、推送过滤）：从 `chat === weflowInboxChat` 改为"chat ∈ weflowInboxChats（为空时回退单值）"。
3. **`weflowInboxChat` 保持原样**，继续作为主会话：canary 隔离断言（`assertWeFlowCanaryTalkerIsolation`）与出站轮询 `pollOutgoingMessagesOnce` 都仍用它，因此本次改动不影响既有出站/验证语义。
4. `.env` 配置为 `wxid_ubo0cy5xh4px22,wxid_s3178hwvzsl922`（柳毓琳 + Azzy）。

## Verification

- `node --check` 通过；服务重启后 `/healthz` 200。
- 真机：从 Azzy 发消息 → 机器人应把它纳入入站并按 `push.sessionId` 回给 Azzy（见提交信息记录的实际结果）。
- 既有 JS 套件保持通过（本次只放宽过滤范围，不改变单值配置下的行为）。

## Alternatives considered

- **把 `weflowInboxChat` 直接改成逗号分隔的字符串**：改动最小，但该值同时被当作"单个轮询目标"和"canary 隔离锚点"使用（`pollOutgoingMessagesOnce`、`assertWeFlowCanaryTalkerIsolation`），塞多值会让这两处语义变形。
- **对 2818 行的集成做完整多会话重构**（多目标出站轮询、多游标、多待处理队列）：语义最干净，但改动面覆盖游标状态、补齐逻辑与配对逻辑，回归风险远高于本次收益，且用户当前只需要"Azzy 的消息被处理并回复"。
- **只改推送过滤，不动待处理过滤**：会留下"事件被接受但在恢复待处理队列时又被丢掉"的半截行为（重启后表现不一致）。
- **在 WeFlow 侧再放宽（让它推送所有会话）**：WeFlow 已按白名单推送；问题在本仓库的本地过滤，放宽上游不解决本地丢弃。

## Consequences

- **收益**：入站作用域变成显式可配的多目标；Azzy→Ally 这类跨账号消息能被处理并回复。
- **代价**：多一个环境变量要维护；`weflowInboxChats` 为空时行为与旧版完全一致（升级零影响）。
- **未覆盖**：出站轮询 `pollOutgoingMessagesOnce` 仍只观察主会话（`weflowInboxChat`）——对非主会话的"自己发出的消息"验证仍依赖 canary/其他路径；入站未做每会话独立游标。
