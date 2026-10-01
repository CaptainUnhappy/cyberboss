# Agent Note: 小号通道取消发送限制：分片预算、context_token 通知、遗留内容拼接

Status: implemented

## Problem

出站通道现在走的是个人号（小号）UIA 桥。实测账本（`weflow-message-ledger.json`，2026-09-30 16:48–16:51）里每一条出站都是 `provider: "weflow-uia"`、`talker: wxid_ubo0cy5xh4px22`。这条路由**不需要 `context_token`**（[bot 工具层接入微信任意文件发送](2026-09-30-channel-send-file-any-tool.md) 已确认：官方 iLink 通道只能回复，桥通道随时可发），但三处仍在按官方通道的前提写死：

1. `templates/weixin-operations.md` 的运行时指令告诉模型："因为 context-token 限制，每个用户输入最多只能收到 10 条分片……任务变长就提前收尾，只发最重要的部分。" 这条预算与小号通道无关，代价是模型主动裁剪答案。
2. 回复发送失败落进 deferred 队列后，补发时给**用户**看的是 `DEFERRED_REPLY_NOTICE`："由于微信 context_token 的限制，上轮对话里有一部分内容当时没能送达……可发送 `/chunk <数字>` 调大最小合并字符数。" 用户把小号通道上收到的这条原文引用回来，明确要求："对于现在的微信小号消息渠道不需要做限制 可以主动多次发送消息。"
3. 下次入站到达时，遗留内容被 `buildEffectiveReplyText` **拼在新回复前面**并加 `===== 本轮模型回复 =====` 胶水头，一条气泡里塞两轮的内容 —— 这个形态同样是"一条出站必须占用一次回复窗口"时代的妥协。

## Decision

1. **运行时指令改为按当前路由描述能力**（`templates/weixin-operations.md`）：删掉 10 条分片预算、`context-token` 前提与"提前收尾"建议，改成"这条路由没有回复窗口、没有分片预算，不必为了凑条数压缩回复"；并明确**一条回答可以分成几条消息、可以连发多条（含自己起的跟进）**。
2. **遗留补发通知改为渠道中立的一句话**（`src/core/app.js` 的 `DEFERRED_REPLY_NOTICE`）：`上轮有一条回复当时没能发出去，现在补上。` —— 不再解释 `context_token`，也不再建议 `/chunk`。`test/stream-delivery.test.js` 里的同名常量同步。
3. **个人号路由上遗留内容独立成条**（`src/core/stream-delivery.js`）：`flushNow` 在发送本轮条目之前，若 `state.deferredReplyPrefix` 非空且目标是 `weflow-uia`（新判定 `isWeFlowUiaReplyTarget`），先调 `sendDeferredPrefixAsOwnMessage` 把**整批遗留内容作为单独一条消息**发出（`sendTextWithRetry` + `preserveBlock`，路由字段沿用 `applyWeFlowReplyRoute`），然后再照常发本轮回复 —— 回复因此不再背胶水头。失败语义不新增：`sendTextWithRetry` 会把这条内容重新入 deferred 队列（自己的重试计时），连入队都失败才回填 `deferredReplyPrefix`，退回旧的拼接形态。非 `weflow-uia` 路由一律保持原样。

之所以可以这样写，是因为**分片条数在代码里本来就不是硬上限**：`packChunksForWeixinDelivery` 的 `maxMessages` 参数在函数体里被 `void maxMessages` 显式忽略，只是软目标；每条的硬上限是 4000 字（`MAX_WEIXIN_CHUNK`）。也就是说，"最多 10 条"从来只活在提示词里。删掉它之后长回答仍会被切成多条气泡，内容不会丢，只是模型不再为预算裁剪。

定时重试那条补发路径（`deliverDeferredReplyBatch`）本来就是独立成条发送的；本次改的是"下一次入站"这条快路径与它给用户看的文案，两条路径现在形态一致。

## Alternatives considered

- **把 10 条改成更大的数字（例如 30 条）**：最强理由是保留"别刷屏"的软约束、diff 最小。否决原因是这个预算的出处是官方通道的 token 窗口，小号没有窗口；凭空留一个数字，模型仍会为了"不超预算"裁剪答案。要防刷屏该用节流（【进度】与"处理中"那套已经有了），不是压缩内容。
- **按 provider 分流：官方通道保留 10 条预算与 context_token 文案，小号另用一套**：最强理由是两条通道的约束确实不同，将来同时启用时各自正确。否决原因是现在只有小号在跑，而模板渲染入口 `renderInstructionTemplate` 只拿得到 `config`，要按 provider 分支就得先把 provider 引进指令注入路径；通知文案中立化后对两条通道都成立（"当时没能发出去"不假设原因），等官方通道真的启用再分不迟。
- **只改通知文案，不动运行时指令**：最强理由是用户引用的就是通知原文，改它最直接。否决原因是用户的原话是"这条通道不需要做限制"，模板里的 10 条预算才是限制本体，只改文案等于把限制留着。
- **在 `primeDeferredRepliesForSender`（入站当口）就直发遗留内容**：最强理由是它最贴近"先把遗留内容补上"的时序，还能复用 `deliverDeferredReplyBatch`。否决原因是那条路径 `drainForSender` 已经把这批条目从盘上摘走，直发就得自己复制一套"失败回队 + 幂等"簿记（重试调度器 `runNow` 里那二十行），而 flush 路径的 `sendTextWithRetry` 本来就带完整失败语义。改动面与风险都不划算。
- **保留拼接，只去掉 `===== 本轮模型回复 =====` 胶水头**：最强理由是 diff 最小、只动 `buildEffectiveReplyText`。否决原因是用户要的是"可以主动多发"，两条内容挤在同一条气泡里的观感并没有变，拆条才是他点头的那件事。
- **对官方通道也拆条**：最强理由是一条代码路径覆盖两种通道、少一个分支。否决原因是官方通道每条出站都要靠入站消息带来新的 `context_token`，多发一条就多一次"窗口已失效"的失败面 —— 那个前缀拼接机制本来就是为它存在的。

## Consequences

收益：

- 模型不再为"10 条预算"裁剪答案，用户能看到完整内容（仍按 ≤4000 字/条切成多条气泡）。
- 小号通道上不会再出现解释 `context_token` 与 `/chunk` 的通知；用户看到的是"补上"加内容。
- 遗留内容独立成一条消息，本轮的正式回复是干净的回复（无胶水头、无两轮混排）。

代价与边界：

- 小号路由下一次入站可能产生**两条出站**（遗留一条 + 回复若干条），桥的串行发送因此多一拍；这是"可以主动多发"的直接代价。
- 补发失败时，遗留内容会带着"上轮有一条回复当时没能发出去，现在补上。"重新出现在队列重试里（与拆条前的文案一致，用户仍能分辨这段是旧的）。
- `isWeFlowUiaReplyTarget` 只认 `provider === "weflow-uia"`：将来若出现第三条不需要回复窗口的通路，必须把它加进这个判定，否则会静默退回拼接形态。
- 模板只对**新 thread** 生效；已经存在的 thread 需要 `/reread` 才会重读（注入路径与缓存键见 [bot 工具层接入微信任意文件发送](2026-09-30-channel-send-file-any-tool.md)）。
- 通知文案中立化后，官方 bot 通道（若启用）也不再解释"为什么当时没送到"——换来的是同一句话在两条通道上都成立。
- **操作者当天确认不改的两项**：回复合并粒度 `minChunkChars` 保持默认 3600（`/chunk` 可调，觉得挤了再调）；发送失败的重试节奏保持 30s/1m/2m/5m、最多 8 次（`src/core/deferred-reply-retry-scheduler.js` 未动，桌面被占用时立刻重试同样发不出去）。
- 测试：`test/stream-delivery.test.js` 的通知常量已同步，并新增两例（小号路由遗留独立成条且回复不拼接；发送失败时重新入队而非拼接），33/33 通过；`npm run check` 与 `npm run verify-notes` 通过。
