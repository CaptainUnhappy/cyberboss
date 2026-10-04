# Agent Note: 迟到原图升级——立刻交付预览保「处理中」，原图落地后补进同一轮

Status: implemented

## Problem

对端发来的图，**原图常常比预览晚到**。2026-10-03 的真实一例（用户用 azzy 发图）：

```
23:54:21  0f3acc99…_t.dat      4,869B   预览 157x210
23:54:26  inbox 交付 localId=193     imageUpgrades=0 imageUpgraded=0
23:54:35  0f3acc99….dat       18,102B   原图，比预览晚 14 秒
```

那一轮跑的是 157×210 的预览，而且**没有任何补救**：消息交付后进 seen 集合，之后再也不会被看第二眼。
两个已实测的事实决定了这条路的边界：

- **原图晚到是真的**（本例 14 秒；本机自测的真实发送是 2 秒内三份齐全；另有一条对端图的原图早于缩略图）。
- **打开会话取不回原图**：把这张图的 `.dat` 挪走、用 Cua 打开会话，2.5 分钟内没有重新下载
  （`scripts/wechat-db-image-redownload-probe.js`）。所以"迟到的原图"只能在它落地的那一刻抓住。

当前实现是"交付前等"（读侧 8s 预算 + 交付前开一次会话再等 2.5s）。用户对这条路的取舍说得很清楚：

> 可以晚回复"正式消息"，但绝对要最快回复"处理中"

而"交付前等"恰好违背这一条：**ack 是在消息交付给应用之后才发的**，等待发生在它之前，
所以等待每多一秒，「处理中」就晚一秒。

### 还有一件更糟的事：图从来没到过模型手里

查这条链路时顺手验了一下"读取器给的本地文件能不能被应用持久化"，答案是**不能**：
`persistIncomingWeixinAttachments` 的下载步骤只认 `directUrls` / `encryptQueryParam`（官方 iLink 通道的
契约），而 wechat-db 读取器给的是**本地路径**。实测（`tmp/probe-local-attachment-persist.js`）：

```
path only (what the wechat-db reader sends)
  saved : 0   failed: attachment did not include a supported download reference
```

也就是说：日志一路报 `quality=original size=900x1400`，文件在磁盘上也确实存在，**但那一轮没有图片**——
模型看到的只有 `[图片]` 加一句说明。用户从 2026-10-02 起抱怨的"图没收到 / 没有正常获取原始图片"，
一半的原因在这里，而不在选择规则、也不在等待时长。

修法：`downloadAttachmentPayload` 增加"本地文件"分支（`path` / `absolutePath` / `file://` URL），
按扩展名给 content-type，其余逻辑不变（远程候选仍然照旧）。`file://` 不能直接喂给 `fetch`——
Node 对它的回答是 "fetch failed"，所以这一步必须自己读文件。

## Decision

把"等"从**交付之前**移到**轮次开始之前**：

1. 只有预览的图片**立即交付**（保持到达即 ack：实测 2.6-5s），并记为"待升级"
   （`pendingImageUpgrades`，键是信封 id）。
2. 同一轮里交付之后才花等待预算：读侧 8s 预算 + 交付后 `imageUpgradeNoticeMs`（默认 2.5s）
   再重读一次；不开第二次会话（per-chat cooldown 挡住重复点击）。
3. 之后每次轮询都对"待升级"清单重读一次；`imageQuality` 变成 `original`/`fallback` 时调用
   `onImageUpgraded(message, info)`。
4. 应用侧 `handleWechatDbImageUpgraded`：重新持久化原图，然后**按 pendingId 在 pending shared
   draft 里替换同一条消息**（`pendingInboundStore.replaceSharedContentMessage`，不动静默窗口——
   升级不是对端的新活动）。静默窗口结束时触发的那一轮因此拿到原图，
   **不多出第二条消息、不多跑一轮**。
5. 原图在轮次开始之后才到：`handleWechatDbImageUpgraded` 找不到草稿，打一行
   `image upgrade arrived too late to swap` 就结束。不补发、不重投。
6. 超过 `imageUpgradeDeadlineMs`（默认 90s）还没变好：丢掉清单项并 warn（`gave up after …`）。

### 一条不能破的边界

升级**只能改草稿，不能触发新一轮**。判据是能不能按 `pendingId` 找到它；找不到就什么都不做。
单测覆盖了"轮次已开始"这个分支。

## Alternatives considered

1. **交付后补发一张原图到同一个聊天。** 用户明确否掉（"先不做"）：会给真实联系人多发一条消息，
   而且 Cua 侧发图的成功判据很弱（image bubble 不进无障碍树，`readConversation` 看不到），
   等于用一个"无法自证成功"的写侧去换一点画质。
2. **把读侧等待预算从 8s 抬到 20s。** 能覆盖 14 秒这一例，但它延迟的是 ack（见 Problem），
   而且轮询会被独占同样时长，其他会话的发现一起推迟。用户否决。
3. **只在模型侧说明"这是预览"。** 成本为零，但用户的原话是"还是没有获取到原图"——
   说明它不是想要一句解释，而是想要那张图。而且事后证明：光有说明时**连说明里的那张预览也没到模型手里**。
4. **等原图期间不进轮，收到就重投消息、让去重层挡住第二轮。** 需要给去重层开口子，
   而它现在是"同一 pendingId 直接忽略"（`pending-inbound-store.enqueueSharedContent`），
   改它等于让"重复投递"变成正常路径——代价比收益大。

## Consequences

- 「处理中」不再为图片等待买单：交付在看见预览的那一刻发生，和文字消息同一条路径。
- 正式回复里拿到的是原图（只要它在轮次开始前落地，即静默窗口内——实测本例 14 秒，窗口 15 秒）。
- 代价一：`pendingImageUpgrades` 是**内存态**。机器人重启后清单丢失，那些图停在预览；
  可接受（重启后消息已进 seen，本来也不会被看第二眼），但要知道这条边界。
- 代价二：图片消息因此多一次"交付后等待 + 重读"（约 2.5s + 一次 snapshot 调用），
  它推迟的是**下一次轮询**，不再是 ack。
- 代价三：本地附件分支让 `persistIncomingWeixinAttachments` 多了一种输入形状。判据是
  "路径存在且是文件"，否则照旧走远程候选——所以它不可能把一次真正的远程下载变成静默失败。
- 收益（超出本笔记原计划）：**图片终于真的到模型手里了**。这一条比"迟到升级"本身更重要。

## Verification

- 单测：`test/wechat-db-inbox.test.js`（20 项，新增 3 项）——预览立即交付、原图落地后回调恰好一次
  且不再交付、过期清单项会被放弃、没有回调时行为不变。
- 单测：`test/wechat-db-image-upgrade-swap.test.js`（4 项）——本地文件可持久化、缺失文件明确失败、
  迟到原图替换草稿且**不改静默窗口**、轮次已开始时不产生任何副作用。
- 单测：`test/pending-inbound-store.test.js`——`replaceSharedContentMessage` 替换同一条消息、
  不新增消息、不重置窗口。
- 真机：`tmp/probe-local-attachment-persist.js` 用真实 900×1400 PNG 验证持久化（修复前 `saved: 0`，
  修复后 `saved: 1 -> …\inbox\2026-10-04\e2e-900x1400.png (51743B, image/png)`）。
