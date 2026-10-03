# Agent Note: 「处理中」的到达时间被测出来了，瓶颈不在读侧

Status: implemented

## Problem

用户的诉求是"第一时间回复处理中"。此前只有一句模糊的抱怨，没有任何可证伪的数字；而这条链路上有三个各自能吃秒级的环节，不测就不知道钱花在哪：

1. **通知**：消息落库 → 机器人看见（轮询间隔 + 单次轮询成本）；
2. **确认**：看见 → `acknowledgeWeFlowUiaInbound` 真的被触发（判据、provider 白名单）；
3. **写入**：`处理中` 三个字真的进到微信气泡里（Cua 写侧阶梯）。

## Decision

### 1. 让每个环节都自己报数

- 入站源：每条投递打一行 `wechat-db inbox delivered talker=… localId=… direction=… lagMs=…`，
  统计行追加 `lastLagMs/maxLagMs`；单次轮询超过 `max(500ms, 间隔)` 时打
  `slow poll costMs=…`（慢轮询会把下一次推迟，而这一点在 delivered/ack 里是看不见的）。
- 读取器：`CYBERBOSS_WECHAT_DB_TIMING=1` 时打每个会话的 `resolve/read/summarize` 耗时。
- 已有的一行恰好是用户视角的数字：`inbound acknowledged … latencyMs=… sendMs=…`。

### 2. 让 `wechat-db` 被当成桌面通道

`sent` 侧的 provider 白名单里加 `wechat-db`（`isDesktopProvider`、`isDesktopReplyTarget`、
`REPLY_ROUTE_PROVIDERS`、`reply-obligation-store.DESKTOP_PROVIDERS`、weixin 适配器的发送分支）。
上一次通道迁移就是因为漏了这种白名单，"处理中"直接静默消失——同样的坑不踩第三次。
（实际派发时 provider 会被改写成 `wechat-cua`，所以这是防御，不是修 bug；但它必须和别的桌面通道行为一致。）

### 3. 把轮询间隔从 2000ms 降到 800ms

轮询成本的实测（`tmp/probe-poll-cost.js`）：冷启动 4935-5042ms，**稳态 142-207ms**。
聊天身份（wxid + 显示名）现在带 10 分钟缓存，稳态只碰消息分片：读取器自报
`resolve=0ms read=0-16ms summarize=0-16ms`，三个会话合计约 50ms。
2000ms 间隔里绝大部分是白等，所以降到 800ms。

## Evidence

**读取器成本**（serve 模式，12 次轮询）：冷 5042ms → 稳态 150-207ms（median 168）。
未加缓存前，每次有消息进来都会重新解密 session.db + contact.db + message 分片，单次轮询 3.4-4.7s。

**发送阶梯**（`tmp/probe-send-steps.js`，会话已打开）：

```
open    route=already-open cost=none
type    669 / 1038 / 1168 ms   landed=true
send    860 / 1222 / 1386 ms
total   1404 / 1842 / 2063 ms
```

**端到端，生产机器人，反复跑**（`scripts/wechat-db-ack-bench.js`：脚本往微信里打字 = 运营手打，
然后读生产日志里机器人自己的两行数字）：

| 配置 | 轮次 | Enter → 机器人看见 | Enter → 「处理中」确认 | 应用侧 sendMs |
|---|---|---|---|---|
| poll=2000ms | 5 | min 3763 / median 4872 / max 5264 ms | — | 2751-3050 ms |
| poll=800ms | 6 | min 3569 / median 3865 / max 5002 ms | 见下 | 2799-3138 ms |

（"Enter → 看见"包含写完 `处理中` 的时间：delivered 那行是在 handler 返回之后才打的。）

**应用侧自报**（10 次以上，`/tmp/ack-bench.json`）：
`inbound acknowledged … latencyMs=60-1163ms`、`sendMs=2799-3138ms`。
`latencyMs` 用的是消息行自己的 `create_time`，而实测该时间戳比本机时钟**超前 1.9-3.7s**
（`lagMs` 连续为负），所以它是乐观值；操作者真实等待以 bench 的本机时钟为准。

## 原图这条路：把"到底拿到没有"变成可测的数字（2026-10-03 第三轮）

用户要求"继续实现原始图片获取流程并端到端验证"。这条流程此前只有一个布尔式的自证
（"强制标成预览 → improved=1"），而**没人知道生产里到底发生没发生**。这一轮先把观测建起来，
再用真实图片和真实客户端把它跑一遍（实现与决策见
[入站改读数据库](../feature/2026-10-03-wechat-db-inbound.md) §10）。

### 1. 读侧报告：每张图报出像素与来源

`node scripts/wechat-db-image-report.js`（真实 worker + 真实读取器，只读）：

```
== 柳毓琳 (wxid_ubo0cy5xh4px22) images=1
   localId=66     original  1280x1356   (cache) 4b4cad984182e0552ba526fe5366f8f5.png
== 文件传输助手 (filehelper) images=1
   localId=302    original  1600x1000   (cache) 32e9b7e4ae39736475b360fd00b4f614.png
== Azzy (wxid_s3178hwvzsl922) images=4
   localId=176    original  1280x1356 ; 187 original 1260x2800 ; 190 original 800x300 ; 191 original 1920x1080
reader media stats: {"resolved":6,"missing":0,"keyFailures":0,"ffmpeg":0,"thumbnailOnly":0,"blankFrames":0,…}
tally: {"original":6,"fallback":0,"thumbnail":0,"missing":0}
```

修复前的同一份报告给出的是 `original` + 空尺寸 + `text: [图片]（本地文件未取到：）`
——"质量"和"路径"来自两个不同的写入点，缓存命中时路径丢了（§10 第 1、2 条缺陷）。

### 2. 真实图片到达时，客户端到底写了什么

`node scripts/wechat-db-image-arrival-probe.js tmp/probe-images/arrival-1600x1000.png`
（真实剪贴板 + Ctrl+V，每 2s 扫一次 attach 目录）：

```
+  9296ms  send(return): refusal=ok  <-- clock starts
+  9321ms  md5=c6188ec0… files: _h.dat 108078B | _t.dat 7500B
+ 11323ms  md5=c6188ec0… files: _h.dat 108078B | _t.dat 7500B | .dat 116236B
```

**结论：预览窗口不存在。** `_h` 与 `_t` 在发送后 25ms 内就有，`.dat` 2 秒后补齐；
此后 90 秒不再变化。这与"缩略图先到、原图 22 秒后才到"那条旧观察不同，两条都记在案。

### 3. 打开会话并不会把原图拉回来

`node scripts/wechat-db-image-redownload-probe.js wxid_ubo0cy5xh4px22 4b4cad98… --open`
（把 `<md5>.dat` 与 `_h.dat` 挪走，60s 后用 Cua 打开会话，全程 170s）：

```
moved away 4b4cad984182e0552ba526fe5366f8f5.dat (42878B)
OPENED 柳毓琳 in 5451ms -- phase B
final: 4b4cad984182e0552ba526fe5366f8f5_t.dat 3447B      <- 原文件始终没有回来
```

所以 image upgrade 的适用范围是"客户端还在下载"，不是"客户端已经不想要了"。

### 4. 生产代码全链路：强制预览 → 打开 → 重读 → 拿到原图

`node scripts/wechat-db-image-upgrade-poll-probe.js wxid_s3178hwvzsl922 190 --restore-on-open`
（走 `pollOnce()`：真实 worker、真实 Cua 打开、真实投递与计数）：

```
09:58:13  hid 6022aac9….dat / _h.dat  (只留 _t)
09:58:23  opened Azzy in 238ms
09:58:23  restored … (the client "downloaded" it)
[cyberboss] wechat-db image upgrade chat=Azzy improved=1 waitedMs=2500 size=180x102->800x300
pollOnce -> {"status":"baselined","processed":0,"failures":0} in 10842ms
stats: imageUpgrades=1 imageUpgraded=1
```

"重读没变好"那一半同样跑过（不恢复原文件）：

```
[cyberboss] wechat-db image upgrade chat=Azzy improved=0 waitedMs=2500
[cyberboss] wechat-db image upgrade chat=Azzy still a preview after 2500ms: 1 picture(s)
             size=180x102 source=6022aac9…_t.dat; the client has nothing better on disk
```

投递出去的 envelope（同一探针，`--force-thumbnail-md5` 让读取器把一张真图报成预览）：

```
delivered 16 message(s), 3 of them pictures
  image localId=176 quality=original size=1280x1356
  image localId=187 quality=original size=1260x2800
  image localId=191 quality=thumbnail size=1920x1080 <<< the one under test
    text: [图片]（微信只下载了缩略图 1920x1080，原图尚未到达）
stats: imageOriginal=2 imageThumbnail=1 imageMissing=0
```

### 5. 生产（重启后的真实进程）

发送后立刻出现的新行，取自 `tmp/shared-prod.log`：

```
[cyberboss] wechat-db inbox stats polls=1 … imageOriginal=0 imageFallback=0 imageThumbnail=0 imageMissing=0
[cyberboss] wechat-db reader: [wechat-db] ffmpeg decoded c6188ec0….hevc to a blank frame; trying another suffix
[cyberboss] wechat-db inbox image chat=文件传输助手 quality=fallback size=1600x1000 source=c6188ec0…_h.dat
```

`quality=fallback` 是这台客户端的常态：`<md5>.dat`（wxgf 原件）解出空白帧，真正能看的是 `_h`，
1600x1000 正是原图尺寸。`_t` 从未在生产里胜出过——也就是说**用户此前抱怨的"没有正常获取原始图片"，
根源不在选择规则，而在"选择结果根本看不见"**。

## Alternatives considered

1. **只凭 `latencyMs` 一个数字判断快慢。** 否决：它用消息行的 `create_time` 作起点，而那个时间戳比本机时钟超前 1.9-3.7s，会把 3.9s 的真实等待报成 281ms。必须同时有本机时钟的端到端数字。
2. **把轮询间隔直接降到 200ms。** 否决：稳态单次轮询 150-200ms（含 RPC 与 JSON），200ms 间隔等于满负荷跑，而收益只是把白等再压 600ms；800ms 是"白等减半、CPU 仍空闲"的折中，实测中位数降到 3865ms 已经证明这一步有效。
3. **把 `处理中` 改成不经校验的 fire-and-forget。** 否决：那正是"驱动说发了、其实没发"的老毛病（PostMessage 那条路就是这么骗人的）。宁可多等 860-1386ms 的校验，也不报一个没落地的确认。
4. **为 ack 单独做一条"极简写侧"（只 type + return，不查会话不校验）。** 暂缓：可以省掉首次快照（约 300-700ms），但它绕过了现有的发送阶梯与回声账本，风险与收益不成比例；等写侧合并快照那次改造一起做。

## 15 秒聚合窗口：端到端验证（同一批工作，2026-10-03）

聚合窗口（`pendingInboundQuietWindowMs`，默认 15000）是行为承诺，所以按行为验证：
`scripts/wechat-db-merge-bench.js` 往真实会话里打字，然后读 **DSH 会话记录**
（`~/.dsh/sessions/.../session.v3.jsonl.zstd`，每条 `user/message` 就是一轮的输入；
用 `scripts/dsh-transcript.py` 解压读取，文件是 zstd 多帧拼接，Node 的
`zstdDecompressSync` 只解第一帧）。

| 轮次 | 输入 | 期望 | 实测 |
|---|---|---|---|
| A（窗口内） | 3 条，间隔 6s（跨度 12s） | 1 轮，含 3 条 | **1 轮，3/3 标记都在同一条 `user/message` 里** |
| B（窗口外，对照） | 2 条，间隔 20s | 2 轮，各 1 条 | **2 轮，各 1 条** |

时间线（本地时钟，来自脚本打的时间戳与记录里的 `time`）：

```
A1 15:55:26.6  A2 15:55:32.6  A3 15:55:38.6   -> 轮次记录 15:56:02.3  （最后一条 +23.7s）
B1 15:56:03.1                                  -> 轮次记录 15:56:24.1  （+21.0s）
B2 15:56:23.1                                  -> 轮次记录 15:56:45.9  （+22.9s）
```

也就是：**窗口 15s + 冲刷/派发约 6-9s** 之后这一轮才真正开始跑；「处理中」在这之前
（每条消息到达后约 3.5-5s）就已经发出，所以用户不会觉得被晾着。

两个附带发现，都记在案以便日后核对：

- 判据用消息行的 `create_time` 作起点，而该时间戳比本机时钟**超前 1.9-3.7s**，因此
  `latencyMs` 会给出负值或偏小的数字；操作者视角要用本机时钟量。
- 3 条 6s 间隔的消息**合并成 1 轮，但发了 2 条「处理中」**（两次独立测量都是 2 条）。
  2026-09-29 的"只对第一条 ack"在这里没有完全成立；聚合是按"轮"的，不是按"处理中"的。

## 「图片没有文字」这条路的 ack 曾经等满 15 秒（2026-10-03 当天修复）

用户问「刚刚消息回复的处理中为什么发送过慢」——查到的原因不是写侧，而是**共享内容路径**：

- 只有图片、没有文字的消息走 `enqueuePendingSharedContentInbound`（等 15 秒看有没有后续文字），
  **ack 被放在"promotion"那一刻**才发；
- 生产日志证据：`inbound acknowledged … latencyMs=16966`（图片消息）；
- 判据本身没问题（`shouldAcknowledgeInbound` 对它是 true），是时机错了。

修法：到达即 ack，promotion 不再重复。

- `handlePreparedMessage` 在入队后调用 `acknowledgeSharedContentOnArrival`（新方法）；
- 一个 burst 只 ack 一次，复用与普通路径相同的 `inboundAckActivityAtMs` 记账（窗口内不重复、
  窗口外新 burst 立刻再 ack）；
- 共享草稿上打 `acknowledgedOnArrival`，promotion（两条合并路径）据此设
  `suppressAcknowledgement` / `acknowledgementStatus = "sent"`，不会补发第二条；
- 为什么不能直接用 `acknowledgeBufferedInboundOnce`：它的 claim 只查 pending store 的
  `scopes`，共享内容在 `sharedScopes` 里，永远 claim 不到——这正是当初"共享路径没有 ack"的根因。

实测（同一类消息，生产）：

| | ack latencyMs |
|---|---|
| 修复前 | **16966** |
| 修复后 | **2664**（sendMs=5069，当时窗口被最小化，写侧偏慢） |
| 修复后 promotion | 不再出现第二条 `inbound acknowledged` |

单测：`test/shared-content-ack-on-arrival.test.js`（5 项：到达即 ack、窗口内不重复、窗口外重新 ack、
自己的消息不 ack、草稿被标记）。

## Consequences

- 「处理中」确实在发：bench 期间机器人打了 10+ 条 `inbound acknowledged`，链路是
  落库 → 轮询 → 判据 → Cua 写入 → 预览校验。
- 轮询间隔减半把"白等"从 0-2000ms 压到 0-800ms，端到端中位数 4872 → 3865ms。
- **剩下的瓶颈是写入本身（约 3s）**：一个 `type_text` 加一个换行发送，各带一次微信无障碍树快照
  （type 669-1168ms、send 860-1386ms）。要再快就得动写侧：合并快照、跳过校验、或缓存会话/输入框
  元素句柄——那是 Cua 客户端那一层的改造，不是读侧能解决的。
- 观测本身有代价：`CYBERBOSS_WECHAT_DB_TIMING=1` 每次轮询打三行，跑完基准就关掉了（默认不开）。
- 一个仍然存在的语义问题：判据本意是"自己发的消息不ack"，但实测 operator 手打的消息**也会**收到
  `处理中`（`prepared` 到判据那一步时 `direction/origin` 已不在）。这不影响用户诉求（手打本来就期望有回应），
  但注释与行为不一致，记在这里以免下次误判。
- 图片这一轮加的是**观测**，不是新能力：四个计数器与 `quality/size/source` 让"模型到底看到了哪张图"
  从日志就能回答。仍然回答不了的是"对端设备那一刻有没有原图"——那需要用户从手机上发一张图，
  本机自测只能把条件强制出来（`--force-thumbnail-md5`）。
