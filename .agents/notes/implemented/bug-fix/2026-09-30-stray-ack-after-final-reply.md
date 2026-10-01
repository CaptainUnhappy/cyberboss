# Agent Note: 正式回复被当成新消息再回一条「处理中」——含 URL 的回复回声认领失败

Status: implemented

## Problem

用户反馈："bot 正式回复后**有时候**会多发一次'处理中'"。日志与聊天记录对齐后确认是**两条不同的入站事件各回了一条回执**，
而不是同一条消息被回了两次（`inbound acknowledged message=` 行按 message id 去重后无重复）：

| 本地时间 | 聊天行 | 事件 |
|---|---|---|
| 03:07:56 | 用户 "把视频发给我" | 真入站 → 03:08:08 回执 |
| 03:09:00 | **bot 正式回复**（含 `https://files.catbox.moe/…`） | — |
| 03:09:13 | "处理中" | ❌ **给 bot 自己的回复回了一条回执** |
| 03:11:04 | 用户 "无法访问 重新发送视频" | 真入站 |
| 03:12:13 | **bot 正式回复**（含 `https://gofile.io/…`） | — |
| 03:12:24 | "处理中" | ❌ 又一条 |

两条被误认领的回复都**含 URL**，且它们的账本条目状态是 `failed_uncertain`（桥没能核验投递）。

## Decision

回声认领时把 `text` 与 `link` 视为**同一类内容**（`src/integrations/weflow-message-ledger-store.js`）：

```js
const TEXTUAL_CONTENT_KINDS = new Set(["text", "link"]);
function contentKindsCompatible(storedKind, observedKind) { /* 相等，或两者都在 TEXTUAL 里 */ }
```

两处严格相等改成这个判定：`entryMatchesObservedContent`（local_id 分支）与按内容哈希筛选候选的那段。

为什么必须放宽：**发出侧与读入侧对同一条消息推导出的 kind 天生不同**。

- 发出侧：所有文本发送都由 `planAndClaimLedgerOperation` 记为 `contentKind: "text"`（`weflow-outbound.js`）。
- 读入侧：`weflow-inbox.js` 的 `normalizeWeFlowMessage` 先取 `url = extractMessageUrl(...)`，而它会**扫描正文里的 `https?://`**，
  命中就把 `kind` 设为 `"link"`（即便那只是一句普通回复顺带贴了个地址）。

于是含 URL 的回复永远无法与自己的账本条目对上 → `classifyObservedOutgoing` 返回 `self_manual` → app 把它当同号人工输入：
先回一条"处理中"，再排一轮（那一轮因为回合仍被占用而只缓冲，所以用户只看到多出来的"处理中"）。
身份证明本来就由**内容哈希**（或稳定 local id）承担，kind 不该在这里拥有一票否决权。

## Alternatives considered

- **改读入侧：正文含 URL 不再判为 `link`**：最强理由是"一句话里带个地址并不是链接卡片"这个直觉是对的。
  否决原因：`kind` 同时喂给共享内容判定（`isSharedInboxContentMessage` / `isSharedContentOnlyPreparedMessage`）与标题推导，
  改动会波及"带链接的消息算不算需要等 prompt 的共享内容"这条既有行为；而本次故障只出在回声认领，改判定面最小的那一处。
- **改发出侧：文本发送时按同样规则推导 kind（含 URL 记 `link`）**：两边能对上，但账本从此把"文本回复"记成链接，
  语义失真，且未来任何一侧的推导规则再变一次就会复发。
- **只按内容哈希 / local id 匹配，完全去掉 kind 校验**：更简单，但会让"图片条目 vs 文本行"这类跨类型误配失去一道闸门
  （`entryMatchesObservedContent` 里 image 分支依赖它）；保留 family 判定即可覆盖 text/link，不放开 image。
- **不做**：用户每次让 bot 报网址（下载链接、文章链接）都会附赠一条"处理中"，且被误认领的回复还会排队成一轮输入。

## Consequences

收益：含 URL 的回复重新被认领为回声，不再多发"处理中"，也不会再排一轮莫名其妙的输入。
用**真实账本 + 真实聊天行**离线复验（复制一份账本文件后跑分类器）：两条故障行 `kind=link` 现在都得到
`cyberboss / content_hash_fifo`；无 URL 的回复仍是 `local_id`，行为不变。

代价与边界：

- `text` 与 `link` 之间不再有类型闸门：一条**同会话、同方向、文本完全相同**的人工链接消息，若恰好在未核验条目的追赶窗内
  （`uncertainMatchWindowMs`，15 分钟）出现，会被当成回声吃掉。这与既有"未核验同文本即视为自己发的"是同一取舍，
  没有引入新的失败模式——只把适用范围从纯文本扩到含 URL 的文本。
- `image` 与文本之间仍然严格区分；图片的 FIFO 认领路径未改动。
- 测试：`test/weflow-message-ledger-store.test.js` 新增一例（含 URL 的未核验回复按哈希认领、已验证回复按 local id 认领、
  无关的同号链接仍判 `self_manual`），20/20 通过；`npm run check` 通过。

## 未修的相邻问题（另记）

同一次排查还发现一件不相干的事，本笔记不覆盖，已单独写成并落地
[跨用户文件路径把媒体收发掐死](2026-09-30-cross-user-media-paths.md)：
**bot（用户 `79388`）读不到 WeFlow（用户 `cwinprobe`）导出的媒体文件**（真实 ACL 拒绝，已验证），
`chooseMediaPath()` 的 `fs.statSync` 因此把所有入站图片判成"没有媒体" → 事件空等 300 秒后进死信 → 图片进不了运行时。
入站图片/视频/文件与出站图片两个方向都断在这条跨用户路径上。
