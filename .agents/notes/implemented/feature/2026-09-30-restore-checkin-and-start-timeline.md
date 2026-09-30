# Agent Note: 恢复主动唤醒（check-in）并让时间轴开始记录

Status: implemented

## Problem

**主动唤醒被一行环境变量掐掉了。** `shared-start.js:40` 始终以 `node bin/cyberboss.js start --checkin` 启动机器人，但 `.env` 里 `CYBERBOSS_ENABLE_CHECKIN=false`，而 `resolveCheckinEnabled()`（`src/core/config.js:332`）的判定是：

```js
if (enabled === false) return false;          // env 显式 false 优先
return enabled === true || hasArgFlag(argv, "--checkin");
```

也就是**显式 false 压过 `--checkin`**，`app.start()` 里的 `startWithCheckin` 为假 ⇒ `runSystemCheckinPoller()` 从不启动。证据：2026-09-30 16:18 启动的 bot（PID 17520）日志里没有 `[cyberboss] checkin: enabled`、没有 `checkin poller ready`、没有 `next checkin in …m`。

**时间轴从来没被真正记录过。** `timeline-for-agent` 的权威数据是 `<stateDir>/timeline/timeline-state.json`；实际 `C:\Users\79388\.cyberboss\timeline\` 下只有 `site/` 与 `shots/`，**没有任何 facts/state 文件**。而 `timeline-source-data.js:15` 在 `facts` 为空时回退到 `examples/demo-facts.zh-CN.json`：17:03 构建出的 `site/dashboard-data.json` 因此是 `isDemoData: true`、`availableDates` 落在 2026-03-31～2026-04-19 —— 一份演示数据集，不是用户的生活。

两件事是同一件事：check-in 是唯一在用户不说话时把 agent 叫醒的通道，`templates/weixin-operations.md:8` 又把"不等触发词、随时增量维护时间轴"写成长期职责；唤醒停着，时间轴就没有写入时机。memory.json 里 pinned 的 `checkin_preference`（"白天要收到定时主动消息，不接受连续静默"）也说明这是用户自己要的能力。

## Decision

1. **恢复 = 显式打开开关，而不是删掉那一行。** `.env` 写 `CYBERBOSS_ENABLE_CHECKIN=true`。理由：`resolveCheckinEnabled` 只在 env *未设置* 时让 `--checkin` 生效；显式 `true` 让"带 flag"与"不带 flag"两条启动路径判定一致，也让能力状态在配置里可审计。改前留 `.env.bak-checkin-on-20260930-172153`（原始 `false`）。
2. **重启走守卫式入口**：`scripts\cyberboss-service-launcher.cmd Restart`（内部 `Assert-ServiceStartPrerequisites` → 校验 PID 身份 → 停 → 起），不手工 kill PID；调用时置 `CYBERBOSS_NO_PAUSE=1`，否则 launcher 会 `pause` 挂住。
3. **端到端验证协议（可复现）**：把 `checkin-config.json` 临时压到 `{min:60000,max:120000}`（备份同目录 `.bak-before-e2e-*`）再重启 —— poller 每个循环都重读该文件，所以短区间能让"是否真的唤醒"在分钟级可判定；观察到 `checkin queued` 后立刻把区间写回 `{900000,1800000}`，*不需要*再重启。
4. **时间轴的第一条真实数据走生产工具路径**：`cyberboss_timeline_write`（经 MCP stdio tool host，与机器人会话同一个工具宿主），而不是手写 `timeline-state.json`。内容只写可核实的事实（本次恢复工作本身），机器人此后按 `templates/weixin-operations.md` 的既有职责继续增量补充。

## Verification

实施后逐条实测（bot PID 38712，日志 `cyberboss.service.20260930-172906.out.log`）：

| 验收面 | 实测 |
|---|---|
| poller 启动 | `checkin: enabled` / `checkin poller ready user=o9cq…@im.wechat workspace=…` / `checkin interval range 1m-2m` / `next checkin in 2m at 2026-09-30 17:30:59` |
| 真唤醒 | 17:31:00 `checkin queued id=265daad0-…`；队列被主循环 drain，回合 17:31:40 完成（`lastTurnCompletedAt=09:31:40.995Z`） |
| 区间已还原 | 17:32:12 那次（旧区间排队）之后日志为 `next checkin in 16m at 17:48:12`；`checkin-config.json` 实测 `{900000,1800000}`，`.env` 实测 `CYBERBOSS_ENABLE_CHECKIN=true` |
| 时间轴落盘 | `timeline/timeline-state.json`、`timeline-taxonomy.json`、`timeline-facts.json` 出现；`timeline write` 返回 `events: 1 status: draft` |
| dashboard 不再是 demo | `site/dashboard-data.json` → `meta.isDemoData=false`、`latestDate=2026-09-30`、`availableDates=["2026-09-30"]` |
| 视觉证据 | `tmp/timeline-2026-09-30.png`：覆盖天数 1 天、总时长 25 分钟、1 个时间块（工作 > 编码 17:20-17:45） |

**未通过的一半（见下节）**：第一条主动消息"今天过得咋样"被 agent 生成了，但**没有送达** —— 官方通道返回 `sendMessage ret=-2 errmsg=prepare failed`（= 缺有效 `context_token`），已进 `deferred-system-replies.json` 重试（实测 4 次退避后仍在队列，`exhausted=false`），要等用户下次开口时的"下一次入站补发"路径才可能出去。

## 首轮验证暴露的两个缺口（当日已修其一）

1. **系统触发的投递只走官方通道，而它需要回复窗口。** `SystemMessageDispatcher.buildPreparedMessage`（`src/core/system-message-dispatcher.js:38`）把 `provider` 固定为 `"system"`、`chatId` 取 `senderId`（= 官方 bot openid）。而 `src/adapters/channel/weixin/index.js:97` 只有 `provider === "weflow-uia"` 才走个人号桥（无窗口限制），否则一律走官方通道 + `contextToken`。`context_token` 只能由入站消息产生（见 [iLink 实测契约](../architecture/2026-09-30-ilink-bot-api-observed-contract.md)），所以用户不开口时主动消息发不出去 —— 首轮实测就是 42 分钟前的旧 token 直接 `ret=-2`。**已修**：系统触发可以携带自己的投递路由（`chatId: "weflow:<talker>"` + `provider: "weflow-uia"`），check-in 由 `CYBERBOSS_CHECKIN_CHAT` 配置；次日实测 `localId=422 verified`，`deferred-system-replies.json` 保持空。见 [系统触发带上个人号聊天路由](../bug-fix/2026-09-30-system-trigger-personal-account-route.md)。
2. **系统触发解析到陈旧工作区，并自成会话。** `resolveConversationKeyForSource`（`app.js:4237`）取 `chatId`，而系统触发的 `chatId = senderId` ⇒ 它是**独立会话**，拿不到用户的聊天上下文；`runSystemCheckinPoller` 还用 `SessionStore({filePath: config.sessionsFile})`（codex 时代的 `sessions.json`）解析目标，那里该 binding 的 `activeWorkspaceRoot` 停在 `D:/Projects/cyberboss/user/Unhappy`。**部分已修**：check-in 现在带 `chatId = weflow:<talker>` ⇒ 会话键变成用户窗口（实测 `dsh-acp resumed session d6a60ead-… for window weflow:wxid_ubo0cy5xh4px22`），工作区用 `CYBERBOSS_CHECKIN_WORKSPACE` 钉到 `user/cyberboss`；**遗留**：legacy `sessions.json` 仍是 poller 与 project tooling 的默认解析源（见上面那篇的 Decision 第 5 条，未实施）。

## Alternatives considered

- **删掉 `CYBERBOSS_ENABLE_CHECKIN` 这一行，靠 launcher 的 `--checkin` 生效**：最强理由是"只剩一个真相来源，不会出现 env 与 flag 打架"。否决：`--checkin` 只存在于 `shared-start.js` 这一条路径，绕过它的启动方式（历史上出现过 `node bin\cyberboss.js start` 直接起 bot）会静默地不带唤醒，而失败形态是"什么都不发生"，最难发现。
- **只改 `checkin-config.json` 的区间，不动 env**：改区间不启动 poller（配置只是被读的对象），等于什么都没做。
- **把 E2E 拉长到自然等待 15-30 分钟**：零侵入，但要占用一整个不确定窗口，且失败时无法区分"没到点"与"没启动"。临时缩短区间把结论变成分钟级可判定的事实。
- **手工写 `timeline-state.json` / facts 让 dashboard 立刻有真数据**：最快看到"非 demo"。否决：绕过 `withTimelineWriteLock` 与写入校验（跨天/缺分类会被 CLI 拒绝，手写不会），且内容只能靠外部猜测。
- **等用户开口再验证投递**：可以拿到"补发成功"的结论，但把验证绑在用户行为上；本次选择把"链路通到哪一步、卡在哪一步"用日志与队列状态固定下来（`ret=-2` 就是卡点证据）。

## Consequences

- **收益**：主动唤醒重新成为可观察的事实（poller 日志 + `checkin queued` + 回合完成时间三处可查）；时间轴从演示数据切到真实数据（`isDemoData=false`），写入走的是机器人的生产工具路径，因此"以后能继续记"这件事有据可依；恢复流程与验证协议写成了可复现步骤。
- **代价与已知上限**：`.env` 与 `checkin-config.json` 都在状态目录、不进版本库，换机器要重做；短区间验证期间会真的产生主动消息（本次 2 次触发、1 条待发）；主动消息在用户不开口时**曾经**发不出去（缺口 1，当日已修，修复后实测 `localId=422 verified`）；legacy `sessions.json` 仍是 poller 与 tooling 的默认目标解析源（缺口 2 的遗留部分），工作区靠 `CYBERBOSS_CHECKIN_WORKSPACE` 显式钉住。
- **重访信号**：若 `deferred-system-replies.json` 里再次出现 `ret=-2` 的 check-in 条目，说明投递路由没生效或被改回官方通道；若用户反馈"唤醒消息太泛"，检查该次回合是否还落在用户窗口会话（日志 `dsh-acp resumed session … for window weflow:…`）。
