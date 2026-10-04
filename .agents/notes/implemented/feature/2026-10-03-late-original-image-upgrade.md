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

## 上线后改掉的两处（2026-10-04）

**一、同一行看起来被交付了两次——其实不是。** 日志里 `localId=66 … early=preview` 出现两行，
时间相差 93.8 秒，而这份日志里只有一个 `inbox enabled`。真相：那两次来自**两个不同的守护进程**
（第二次启动时它的日志覆盖了同名文件，只留下自己的尾部）。诊断被记在这里，因为差点照着
一个不存在的 bug 改代码。仍然顺手把 `seen` 集合的构造挪到提前交付**之后**（顺序更明确，
单测 `a preview is handed over exactly once per poll, even while it is watched` 锁住
"一行一轮只交付一次"），但要说清楚：生产里的双行不是它造成的。

**二、每次轮询都等满 2.5 秒（真实缺陷）。** 待升级清单里有条目就无条件等 2.5 秒 + 重读，
于是稳态 `slow poll costMs=2730-2946`、整个轮询周期 2.7-2.9 秒（三个会话都受它拖累）。
这跟上一轮"每轮都等 8 秒"是同一类错误：**没有变化的东西不该再等**。
修法 `shouldWaitForImages()`：只有"源文件的指纹（imageSize|imageSource）变了"或"这个条目还从没等过"
才付这笔等待；没有轮到等的轮询照常重读一次（便宜）并继续判断。

**三、同一张预览被反复"交接"，把 inbox 目录灌满。** 观察侧的证据：`<state>/inbox/2026-10-03/`
里同一张图出现 **46 份**带 `-N` 后缀的副本（两张图共 100 个文件、460KB）。原因是我这边的
`notifyPendingImageUpgrades` 每一轮都把"没变化的预览"再交接一次，应用侧就再持久化一份。
修法：交接按**指纹**（`imageSize|imageSource`）去重，且条目创建时就记下当前指纹（那一份已经被交付
时持久化过了）；`fallback`（能看的非原件）仍然算提升。用 `tmp/probe-duplicate-persist.js`
逐轮计数验证：六轮轮询里 `onMessage` 对同一张图只被调用一次，副本数从 5 不再增长。

**仍然存在、但已被限定的一件小事**：每次**启动**会多出一份副本（两张图各一份）。探针证明
inbox 侧一轮只交接一次，所以那第二份来自应用侧的持久化路径（`persistIncomingWeixinAttachments`
有两处调用点：常规入站与升级交接），没有继续深挖——它每天每张图最多一份、约 4KB，
`tmp/cleanup-inbox-flood.js --apply` 可以清掉历史副本。这一条写在这里，是为了下一个人不必
把它当成本轮遗留的未知故障。

**四、同一张旧预览每 90 秒被重新交付一次（把一个真实消息挤掉了）。** 用户报"azzy 消息还是没回复"，
查日志发现同两行（`localId=66`、`localId=190`）在**一次启动里被交付了 14 次**，每次 `lagMs` 都是
21 小时。因果链是这样的：

1. 提前交付只对"待升级清单里有条目"的行生效，而这个条目**在 90 秒升级窗口结束时会被删掉**；
2. 条目一没，下一轮的第一个循环重新看到 `quality=thumbnail` 又把条目建回来（`deliveredAtMs = 0`）；
3. 于是同一张图每 90 秒再交付一次——**无限循环**，每次都在应用侧生成一轮；
4. 这些"21 小时前的图"堆成的轮次，就是真实消息得不到回答的原因。

修法：把"已经交付过"从条目上移到**按消息 id 的独立标记**（`imageHandedOver`，有界集合，不随条目
删除而消失）。`rememberSeen` 仍然在交付那一刻调用，保证同一轮里主循环不会再交付它。
回归测试 `a row handed over early is never delivered again, watcher or not`（清空清单后仍只交付一次）。

实测：修复前一次启动 14 次交付；修复后 180 轮轮询里**只有 2 次**（就是那两行各一次），
`delivered=2` 不再增长。

**这一条与"消息没回复"的关系要说清楚**：它确实制造了大量假轮次、也确实可能挤掉真消息，
但用户那条 11:53 的图在我多次重启守护进程的时间窗内（11:54-12:00 我重启了四次），
所以"那一轮有没有跑完、回复有没有发出去"**没有直接证据**（当时的日志已被同名文件覆盖）。
日志里另有一组长期存在的 `deferred reply gave up … error=fetch failed`（指向
`CYBERBOSS_SHARED_PORT=8767`，而该端口当前没有监听），这是与图片无关的另一条线索，
需要下一次真实消息来定位。

**五、用户那条"没回复"的图，其实是被规则静默掉了。** 用户报"azzy 消息还是没回复"。查 DSH 会话记录
（`~/.dsh/sessions/--D-Projects-cyberboss-user-cyberboss--/004fcf30-…`，用 `scripts/dsh-transcript.py`）：

- 那一轮的输入带了 `Current-turn attachment/reference boundary`（"优先解释或分析本轮附件"）；
- 助手的推理原文：*"Now a full-size screenshot (1220x2712) arrived, no text. It's a JD product page
  screenshot for the nubia NaviX Ultra AI phone… **No text message. Lone image, no task → per rules
  silent.**"*；
- 也就是说：**图到了、被看懂了，然后按规则故意不回**。前两张图它其实回了（同一份记录里为
  157×210 的缩略图拟过回复）。

规则在 `~/.cyberboss/weixin-instructions.md`：第 2 节把"单独发送的图片"列进"仅收件"，
判断示例里直接写"单发一张图：静默"。用户选择改成"单发图片就正常分析回复"，因此：

- 第 2 节的收件清单里移除图片/视频，并加一句"用户本人单独发来的图片/视频一律当任务处理
  （转发来的聊天记录里的图片仍按收件规则）"；
- 判断示例改为"单发一张图：直接看图回一句——看到什么说什么，不静默、不反问"。

这个文件是**运营本地状态**（`config.weixinInstructionsFile` 指向 state 目录，不在仓库里），
`shared-instructions.js` 按 `mtime` 缓存，所以改完下一轮就生效、不需要重启。
仓库里的 `templates/weixin-instructions.md` 是另一份（本项目里两者本就不一致），没有跟着改。

## 补上「原图为什么从来没落盘」的那个上游开关（2026-10-04 晚）

上面整篇讲的是**原图落盘之后**怎么抓、怎么换。用户 2026-10-04 报的是更前面的一段——
「图片/视频/文件取不到」。查下来：原图常常**根本没被写进磁盘**，而那个开关不在本仓库里，在 WeFlow：

- `%APPDATA%\weflow\WeFlow-config.json` 的 `autoDownloadWhitelist` + `autoDownloadHighRes`。
  WeFlow 的「自动下载」（设置 → 自动下载，仅 win32-x64）会往**微信进程里装内存 Hook**
  （日志：`[ImageDownloadService] attempting to hook PID … / hook successful`），按白名单
  **强制微信把原图落盘**。非空白名单 = 只对这些会话生效；留空 = 全部会话；关掉 = 只留预览。
  UI 自己的警告是「此功能通过内存 Hook 修改微信行为，具有一定的风险。请尽量仅在白名单模式下针对必要会话开启。」
- 读侧 `scripts/wechat-db-inbox-read.py` **只读磁盘**（`<md5>.dat` 原图 / `<md5>_h.dat` / `<md5>_t.dat` 预览；
  全文 0 处 `http`/`5031`/`weflow` 引用）。上游不落盘时，读侧等到超时也只能拿 `_t` 预览——
  这就是 `tmp/shared-prod.log` 里每 90 秒一轮的
  `image upgrade chat=… gave up after 90…ms: still 171x180 from <md5>_t.dat`。

本机两个具体缺口：

1. **WeFlow 根本没在跑**：最后一次运行是 10-02 23:37（`%APPDATA%\weflow\logs\wcdb.log` 的 mtime），
   5031 无监听 ⇒ 没有 Hook，没有任何会话会落原图。
2. **白名单少了机器人真正在读的会话**：入站白名单是
   `CYBERBOSS_WECHAT_DB_INBOX_CHATS=wxid_ubo0cy5xh4px22,filehelper,wxid_s3178hwvzsl922`
   （柳毓琳 / 文件传输助手 / Azzy），而 WeFlow 三个列表里**没有一个含 `filehelper`**，推送列表还缺 Azzy。

修法（改的是本仓库之外的配置 + 运行时，因此没有代码 diff）：

- `autoDownloadWhitelist` 增补 `filehelper`（媒体实际缺的那一个会话）；
- `messagePushFilterList` 增补 `wxid_s3178hwvzsl922`、`filehelper`；
- `notificationFilterList` 增补 `filehelper`；
- 启动 WeFlow 6.2.0（5031 那条），确认 Hook 装进了 `weixin.exe`；
- **故意不加** `wxid_ty69l7hjiqt012`（Ally）：那是本机微信**当前登录的账号自己**
  （`CYBERBOSS_WECHAT_DB_WXID`），给自己配白名单没有意义——这一点值得写下来，因为白名单
  是按 talker 书写的，很容易顺手把机器自己的号也塞进去。

原文件已备份为同目录 `WeFlow-config.json.bak-20261004-194421`（4380B）；改后 4453B，
`Compare-Object` 显示**只有这三个数组**新增了条目。

**考虑过但没用的两条**：**把白名单留空**（= 全部会话，一行改动就能让所有会话都落原图）——
它把内存 Hook 的作用面从 3 个会话扩到全部，而 UI 明确建议"仅在白名单模式下针对必要会话开启"；
**只改 `autoDownloadWhitelist`**——改动最小，但推送/通知两个列表会继续与"机器人真正在读的三个会话"不一致，
下次排查还得重新对一遍账。

**边界（必须写清楚）**：这个 Hook 是在**收到消息的那一刻**决定要不要落原图，所以它**不会**回头补下载
已经停在预览的历史图片——这与本篇 Problem 里「打开会话取不回原图」那条实测是一致的、互相印证。
要确认端到端，需要一张**新到**的图（见 Verification 的未验证项）。

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

- 单测：`test/wechat-db-inbox.test.js`（22 项，新增 5 项）——预览立即交付、原图落地后回调恰好一次
  且不再交付、基线期看到的预览也会继续盯、过期清单项会被放弃、同一行一轮只交付一次、
  没有回调时行为不变。
- 单测：`test/wechat-db-image-upgrade-swap.test.js`（4 项）——本地文件可持久化、缺失文件明确失败、
  迟到原图替换草稿且**不改静默窗口**、轮次已开始时不产生任何副作用。
- 单测：`test/pending-inbound-store.test.js`——`replaceSharedContentMessage` 替换同一条消息、
  不新增消息、不重置窗口。
- 真机：`tmp/probe-local-attachment-persist.js` 用真实 900×1400 PNG 验证持久化（修复前 `saved: 0`，
  修复后 `saved: 1 -> …\inbox\2026-10-04\e2e-900x1400.png (51743B, image/png)`）。
- 真机（生产，强制预览状态）：11:32:23 把 `<md5>.dat` 挪走 → `inbox image chat=Azzy
  quality=thumbnail size=157x210`；11:32:42 原图落地 → `image upgrade chat=Azzy improved=1
  size=157x210->1280x1706`，10.0 秒内抓到；该消息的轮次 12 小时前已跑完，于是正确地打出
  `image upgrade arrived too late to swap … waitedMs=10062`（边界那一半也因此有了真机证据）。
- 真机（稳态成本）：`slow poll` 从每轮一次（2730-2946ms）降到只剩冷启动那一次，
  稳态 `lastPollMs=132-139ms`（三个会话）。
- **仍未验证**：`image upgrade swapped into the pending turn …` 这一行需要一张**刚到达**的图
  （旧消息的轮次早开始了），只能由对端设备发一张才会出现。实现侧它由
  `wechat-db-image-upgrade-swap` 的四个单测覆盖（含"轮次已开始则不动作"）。
- 真机（2026-10-04 19:45，自动下载白名单补齐后启动 WeFlow 6.2.0）：
  `[HttpService] HTTP API server started on http://127.0.0.1:5031`、`/api/v1/health` → `200 {"status":"ok"}`、
  `netstat` 显示 `127.0.0.1:5031 LISTENING pid=35696`、
  `[ImageDownloadService] attempting to hook PID: 28704` + `[ImageDownloadService] hook successful`
  （Hook 确实进了 `weixin.exe`，不是只起来了 HTTP 服务）。
- 配置：改前/后 4380B → 4453B，`Compare-Object` 只多出三个数组的新增项；改后 `ConvertFrom-Json` 通过，
  WeFlow 启动并接管该文件后内容仍含 `filehelper`（mtime 19:45:28，未被回写覆盖）。
- **仍未验证（本节的落点）**：白名单会话里**一张新到的图**是否真的以 `<md5>.dat` 原图落盘、
  进而让读侧报 `quality=original`。Hook 只在收消息时生效，历史预览不会被追补，所以这一条
  只能等对端（或用文件传输助手）真发一张图，再用读侧日志核对。
- 反证（同一次真机，Hook 装上之后）：那两张**历史**预览在 19:45 装上 Hook 后仍继续
  `image upgrade chat=柳毓琳/Azzy gave up after ~90s: still 171x180 / 180x102`（19:47:56 仍在打），
  也就是说"打开会话 + 强制下载 Hook"都补不回已经停在预览的老图 —— 本节那条边界从"推断"变成"实测"。
