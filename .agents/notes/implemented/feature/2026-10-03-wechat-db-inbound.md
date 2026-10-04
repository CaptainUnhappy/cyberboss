# Agent Note: 入站改读数据库（纯 Python 解密微信 4.x，退役 WeFlow 读侧）

Status: implemented

## Problem

个人号通道的**读**侧在两天内失去了全部三条路：

- **WeFlow 桥**：它自带的 `lib/wcdb_api.dll` 是闭源组件，内置联网授权（`api.weflow.top`）。2026-10-01 起该服务不再应答，`InitProtection` 返回 `-101`、`wcdb_init` 返回 `-1000`，读取能力整体不可用。生产环境已用 `CYBERBOSS_ENABLE_WEFLOW_INBOX=false` 关掉。
- **wx-cli**：Windows 上只有内存扫描，hook 路径（`--hook-seconds`）是 macOS 专用，`--key` 在 0.3.0 里根本不支持，实测始终 `无法解密 session.db`。
- **Cua 截图读**（[CUA 写侧闭环](2026-10-01-cua-wechat-write-loop.md) 的入站半边）：能跑，但结构性受限——一行会话只是"最后一条消息的预览"，连发的两条会塌成一条；**方向靠像素猜**（因此必须有回声账本兜底）；没打开的会话完全看不见；每次深读还要抢一次前台。生产的 `cua inbox stats` 是 `polls=2500+ delivered=0 events=0`：它一直在跑，但什么都读不到。

同时微信 4.x 的库本身是**标准 SQLCipher 4**：密钥可由运行中的微信进程内存导出，解密与查询纯 Python 就能做。于是"读"不该再依赖任何第三方二进制。

## Decision

### 1. 读库，不读屏；写侧不动

新增入站源 `wechat-db`：

```
scripts/wechat-db-inbox-read.py    纯 Python 读取（+ --serve JSON-lines 常驻模式）
scripts/wechat_db_reader/          vendored：db_crypto / db_reader / content_codec（MIT，来自 wx-assist fork）
src/integrations/wechat-db/worker.js  长驻子进程 + 帧协议 + 超时 + 重启
src/integrations/wechat-db/inbox.js   轮询、基线、去重、交给 app
```

出站**完全不动**：回复仍走 Cua（`wechat-cua`）。这条链路替换的只是"怎么听见"，不是"怎么说话"。

### 2. 常驻 worker，而不是每次轮询起一个进程

一次性调用每次都要重新解密它碰到的每一页（实测冷启动 **1307ms**，且随消息分片增长）；常驻进程把解密快照缓存在内存里，**热轮询 3-50ms**。差距不是优化，是"2 秒轮询"能不能成立的问题。

### 3. 数据库行带来的、截图给不了的东西

| 能力 | Cua 截图 | 数据库行 |
|---|---|---|
| 一条消息 = 一个事件 | 一行会话 = 一条预览，连发塌陷 | 每行一条 |
| 正文 | 截断的预览 | 完整（zstd 解压后） |
| 方向 | 靠像素/账本猜 | `real_sender_id` 直接给出 |
| 身份 | 只有显示名 | 发送者 wxid + server id + local id |
| 未打开的会话 | 看不见 | 一样读 |
| 前台成本 | 深读要抢一次前台 | 零 |

### 4. 两个读源不能同时开

同一条消息会被读两遍、拿到两个不同的 id、被回答两次。因此 `ensureWechatDbInboxStarted` 先启动，`ensureWeChatCuaInboxStarted` 在检测到它时**跳过并说明原因**。Cua 读源保留为密钥无法提取时的退路，一行环境变量即可切回。

### 5. 范围默认是"没人"，不是"所有人"

`CYBERBOSS_WECHAT_DB_INBOX_CHATS` 为空时回落到 WeFlow 的入站范围（`CYBERBOSS_WEFLOW_INBOX_CHATS`/`_CHAT`，运营已经筛选过）；仍然为空则**不读任何会话**并报错。持有一个真实微信号的机器人不能因为某个变量没设就开始回复陌生人。

### 6. 密钥由外部提供

`CYBERBOSS_WECHAT_DB_KEY`（64 hex）。Cyberboss 自己**不扫描内存**：目前由 wx-assist 源码版引导步骤导出。密钥失效时读取器抛 `KeyMismatchError: 密钥与数据库不匹配`，轮询日志会一直说这句话，而不是安静地变成"没人说话"。

### 7. 机器上有两个微信号时，让密钥决定读哪个

本机同时存在 `wxid_ty69l7hjiqt012_f2b4`（Ally，Cua 通道登录的号）和 `wxid_s3178hwvzsl922_9e02`（Azzy 自己的客户端）。按目录名取第一个会拿到**密钥打不开的那个账号**，报出来的却像"密钥错了"。因此未指定 `CYBERBOSS_WECHAT_DB_WXID` 时逐个账号用首页 HMAC 试开。

### 8. 图片要真的取到，而不是 `[图片]`

用户的原始抱怨是「图没收到 我这边只有『图片』两个字」——读库如果还是给占位符，等于没修。实测（2026-10-03）这条链路是通的：

1. 行的 `packed_info_data` 里有图片 md5；
2. 文件在 `<账号>/msg/attach/<md5(talker)>/<YYYY-MM>/Img/<md5><后缀>.dat`；
3. `.dat` 是 V2 容器：`[07 08 V2 08 07][aes_size][xor_size][pad][AES-128-ECB][raw][XOR 尾巴]`；
4. **AES 密钥是推导出来的，不用扫内存**：`aes_key = md5(f"{uin}{wxid_base}")[:16]`、`xor_key = uin & 0xFF`，`uin` 从 `%APPDATA%\Tencent\xwechat\net\kvcomm` 的文件名里读；
5. 解出来的图写进 `<cache>/media/`，交给 app 落进 `<state>/inbox/<日期>/` 并挂到本轮对话上。

踩到的坑（都写进代码注释了）：

- **后缀顺序反直觉**：`_t` 是缩略图（实测 720×240 的图只有 180×102；1280×1356 的原图只有 171×180），裸名有时是 `wxgf`（微信的 HEVC 容器），而 `wxgf` 解出来的第一帧可能是**空白画布**。
- **"能直接读的图优先"这条规则也是错的**（2026-10-03 用户反馈「好像没有正常获取原始图片」）：微信对那条消息只留了 3447B 的 `_t` 缩略图（**171×180**）和一个 `wxgf` 原件，前者"能直接读"，于是被选中，而原件用 ffmpeg 解出来是 **1280×1356**。现在改成**按像素面积选**：每个变体都解码（容器走 ffmpeg），丢掉空白帧，面积最大的赢，平手时原件优先；缩略图只在没有别的选择时才用。
- **ffmpeg 要吃解码后的载荷**，不是 `.dat` 文件本身：喂 `.dat` 会报 `could not find codec parameters`；正确做法是切到第一个 NAL 起始码，再 `-f hevc`。
- AES 段必须**按 PKCS7 去掉填充**（`plain[:aes_size]`），否则文件尾部多 16 字节。

实测结果（`tmp/probe-selection.py`，同一批真实消息）：

| md5 | 旧规则选中 | 新规则选中 |
|---|---|---|
| `4b4cad98`（大号发的截图） | `_t` JPEG **171×180** 3.4KB | 原件 ffmpeg 解码 **1280×1356** 694KB |
| `1daabe4f` | `_t` JPEG 1280×1355 109KB | 原件 ffmpeg 解码 1280×1356 694KB |
| `61ebd0e1` | — | `""` 是空白 HEVC → 正确落到 `_h` 1280×1355 690KB |
| `234c3908` / `ecd2aa49`（自测图） | 相同 | 720×240 / 800×300（就是原图尺寸） |

用户发的 800×300 测试图落盘为 `..._h.png` 800×300；语音/视频/文件仍未解析。

## Evidence

单元（21 项，全绿）：

```sh
node --test test/wechat-db-inbox.test.js   # 10：基线/去重/回声/延后重试/游标跨重启
node --test test/wechat-db-worker.test.js  # 11：帧/关联/超时杀进程/崩溃重启/优雅退出
```

真实库（`scripts/wechat-db-read-probe.js`，走真实 config → worker → reader → source）：

```
-- baseline poll --  {"status":"baselined","processed":0,"failures":0} 1311ms
-- second poll  --   {"status":"ok","processed":0,"failures":0} 9ms
柳毓琳 (wxid_ubo0cy5xh4px22) unread=0
  [me] "处理中"   [me] "【自检2】…"   [peer] "hi"   [me] "咋啦"
文件传输助手 (filehelper) / Azzy (wxid_s3178hwvzsl922) 同样读到，方向正确
```

生产端到端（`scripts/wechat-db-selfcheck.js`：用底层发送器往本账号微信里打字 = 运营手打，因此不进回声账本）：

```
+  7316ms  typed ok=true verified=true
+ 37452ms  2: turn signal  inbound acknowledged message=weflow:818340b7053c0361c024a7d9fcbee075 latencyMs=2481 sendMs=2604
+ 37969ms  3: reply landed -> "文件传输助手 数据库收到 1791003971027 13:06"
+ 63225ms  4: self-answer on the probe text seen=false (must be false)
+ 46388ms  wechat-db inbox stats polls=30 delivered=1 suppressed=2 deferred=0 errors=0 lastPollMs=1337
```

`suppressed=2` 是机器人自己的两条出站（`处理中` + 回复），被回声账本挡住，没有再触发出站——这正是 Cua 读源必须靠账本、而数据库方向让它变成"额外保险"的地方。

稳态轮询耗时（生产日志）：`lastPollMs` 1337（有写入、需重解密）/ 37 / 50。轮询是"上一次结束后再排下一次"，慢轮询只会推迟，不会叠加。

顺带修掉两处**关闭路径缺口**：`closeWeChatCuaInbox()` 定义了却从没在 shutdown/finally 里被调用；新加的 `closeWechatDbInbox()` 必须调用，否则重启会留下一个仍持有解密快照的 Python 子进程。

### 9. 原图：微信没下载时，替它把会话打开一次（CDN 路已试死）

用户反馈「还是没有获取到原图」。查清的事实链：

- 微信先写 `<md5>_t.dat`（预览），**原图只在会话被渲染时才下载**：实测那条消息的 `.dat` 晚了 **22 秒**，正好是机器人回复时代替它打开了会话的那一刻。
- **直连 CDN 行不通**：消息体里的 `cdnthumburl`/`cdnbigimgurl` 定位符在
  `novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=…` 上一律 `HTTP 400`
  （换 host、换参数形状、换 UA、走/不走代理都试过，返回体为空）；`fileid` 形状是 403。
  官方 iLink 通道的 `/download?encrypted_query_param=` 是另一套契约（`media-receive.js`）。
  WeFlow 的 JS 里确实有 `parseImageInfo`（取 md5/aeskey/cdnthumburl）和 `downloadImage`，
  但它缓存下来的 32 张图（%APPDATA%\weflow\cache\api-media）说明取图那步是它自己的客户端能力。
- 因此走**可行的那条**：读取器报告 `imageQuality`，Node 侧发现是 `thumbnail` 就
  **用 Cua 打开那一个会话一次**（每会话 30 秒冷却），等 2.5 秒后重读数据库，拿到原图再投递；
  仍拿不到就保留预览并在文本里说明。开关 `CYBERBOSS_WECHAT_DB_IMAGE_UPGRADE`。
- 窗口最小化时 `ensureConversation` 会拒绝（`window_minimized`）：先
  `restoreMinimized`（SW_SHOWNOACTIVATE，不抢前台）再点一次。

验证：

- 单测 `test/wechat-db-inbox.test.js`：预览 → 打开一次 → 重读得原图；冷却期内不再点；
  重读没变好时保留预览而不是丢掉附件；原图不触发打开。
- 真实链路 `scripts/wechat-db-image-upgrade-live.js`（把一条已有原图的消息强制标成预览，
  其余全是生产代码）：`restored minimized window: {"ok":true}` → 打开会话 →
  `wechat-db image upgrade chat=柳毓琳 improved=1 waitedMs=2500` → 质量回到 `original`，
  `upgrades=1 upgraded=1`。
- 仍未覆盖：**对端真发一张图**（只有对方设备能造出"原图尚未下载"的初始状态），
  这条留给用户发一张图后看日志确认。**2026-10-03 的下一步工作补齐了这条的一半**（见 §10）：
  真实发送与真实读取器都跑通了，唯一没法自造的是"对端设备"这一个前提。

### 10. 原图流程收尾：看得见、判得对、验证得到（第三轮）

用户要求"继续实现原始图片获取流程并端到端验证"。做完这件事冒出来的**三个真实缺陷**：

1. **读侧把"哪张图、多大、来自哪个变体"丢掉了。** `MediaResolver.last_quality` 是解析器上的
   一个字段，`summarize_message` 在每次 `resolve_image()` 之后读它——一张快照里有第二张图时，
   第二张的 `thumbnail` 就会盖住第一张的 `original`。Node 侧据此判断"有没有变好"，于是
   `imageUpgraded` 会数出假提升。现在 `resolve_image()` 把
   `quality / width / height / source` 记进 `self.resolution`，**由调用它的那条消息当场取走**，
   并随消息上报 `imageQuality` / `imageSize` / `imageSource`。
2. **缓存里的成品会活得比它的来源长。** `<cache>/media/<md5>.png` 只要比"现存变体的最新
   mtime"新就会被直接复用；而"来源文件被删掉"时，"最新 mtime"会退化成剩下的那个 `_t.dat`
   或 0，于是**一张已经不在磁盘上的原图继续被报成 `original`**。实测把 4b4cad98 的 `.dat`
   挪走后，读侧仍然回答 `original`（图片报告里表现为 `original` + "本地文件未取到"）。
   现在复用的前提是"它声称的那个变体仍然存在"：`md5.png` 要求 `""`/`_h` 在，`md5_thumb.jpg`
   只要求 `_t` 在。
3. **"原图没拿到"在生产里看不出来。** 交付一张 171x180 和一张 1280x1356，日志里都是
   `kind=image`。现在每条图片消息一行
   `wechat-db inbox image chat=… quality=… size=… source=…`（`thumbnail`/`missing` 走 warn），
   统计行追加 `imageOriginal/imageFallback/imageThumbnail/imageMissing`。

**验证过程中被推翻的两条旧说法**（写下来，因为它们决定了这条路还能不能走）：

- **"打开会话就会把原图拉下来"只在"客户端正在下载"时成立。** 实测
  （`scripts/wechat-db-image-redownload-probe.js`）：把某张图的 `<md5>.dat` 挪走，
  再用 Cua 打开那个会话，**2 分钟内原文件没有回来**。所以 image upgrade 能救"客户端还在拉"的图，
  救不了"客户端已经没有"的图。
- **"缩略图先到、原图 22 秒后才到"不是唯一形态。** 用真实剪贴板发一张真图
  （`scripts/wechat-db-image-arrival-probe.js`，每 2s 看一次磁盘）：`.dat` / `_h.dat` / `_t.dat`
  **全部在发送后 2 秒内落地**，根本没有"只有预览"的窗口。同一台机器上，对端那两条消息的原图
  也都比缩略图早（19:50:42 对次日 14:18）。因此这条路主路径上是顺的，`_t` 只在少数情况下胜出。

**顺带暴露的一件事**：这台客户端上 `<md5>.dat`（wxgf/HEVC 原件）**经常解出空白帧**——4b4cad98、
32e9b7e4、c6188ec0 三条真实消息都是如此，真正能看的是旁边的 `_h`。这正好是"按像素面积选"
存在的理由：把空白帧算成面积 0，`_h` 就赢了（实测
`quality=fallback size=1600x1000 source=c6188ec0…_h.dat`）；否则一条坏原件会盖掉一张好图。

验证（全部走真实读取器 + 真实客户端，见 [入站延迟实测](../testing/2026-10-03-inbound-ack-latency-measured.md)
的"原图"一节）：图片报告 6/6 张图报出真实像素（1280x1356 / 1600x1000 / 1260x2800 / 1920x1080 …）；
强制预览 → 打开会话 → 重读 = `improved=1 waitedMs=2500 size=180x102->800x300`；生产重启后
真实发送立刻打出 `wechat-db inbox image chat=文件传输助手 quality=fallback size=1600x1000`。
一条命令走完整条链：`node scripts/wechat-db-image-e2e.js <png>`（发送 → 读取器判定 → 附件路径
→ 生产日志），实测 900x1400 的图 8.1s 内全链贯通、`quality=original`。

### 11. 两个自己造出来的性能回归（同日修掉）

改完 §10 后重启生产，日志立刻变成 `slow poll costMs=8200`（修复前稳态 40-99ms）。
两个原因，都是这一轮的改动"看起来更严谨"造成的：

1. **空白帧标记文件把缓存打废了。** 旧代码把 ffmpeg 的输入写成
   `<cache>/media/<md5><suffix>.hevc`，这份"我试过了"的标记比从 `_h` 发布的 `.png` **新**，
   于是 `_cached_winner` 的"比所有来源都新"判据每轮都失败 → 每轮重新选变体 → 每轮重跑 ffmpeg。
   现在 ffmpeg 的结果落在**任何候选列表都不会看一眼**的名字下（`<md5><suffix>.hevc[.png]`），
   而且新鲜度由**比较载荷字节**决定而不是 mtime：重新发的图会重新判定，没变的图永不重复解码。
2. **等待预算对"永远不会来的原图"每轮都付一次。** 4b4cad98 的原件是永久空白帧、`_t` 是唯一可用
   变体，于是每一次轮询都走完整 8000ms 预算。现在等待是"每张图、每个磁盘状态**一次**"：
   来源文件的 mtime 没变就不再等——磁盘没变，再等也给不出别的答案。

顺手收掉一个让"到底哪张是成品"变成时间戳竞赛的隐患：命中缓存时会**删掉没胜出的那一份**
（`_prune_stale`）。`4b4cad98_thumb.jpg`（图片还像预览时写下的）和 `4b4cad98.png` 同时在盘的
那段窗口里，答案取决于两个 mtime，现场表现就是同一条消息既 `quality=original` 又
"本地文件未取到"。

实测（`scripts/wechat-db-timing-probe.py`，同一进程内连查三次）：

| 会话 | poll#1 | poll#2 | poll#3 |
|---|---|---|---|
| 柳毓琳（原件永久空白） | 12875ms（冷解密 + 8000ms 等待） | **15ms** | 32ms |
| 文件传输助手（9 张图） | 93ms | 63ms | 78ms |
| Azzy | 31ms | 32ms | 15ms |

修完重启生产：`slow poll` 只在冷启动那一次出现（9369ms，与改动前同量级），
稳态 `lastPollMs=120-133ms`。

回归测试：`test/wechat-db-media-resolver.test.js`（3 项，真读取器 + 合成 attach 目录，**不需要密钥**：
`.dat` 按 V2 容器手工构造、AES 密钥固定注入）——原图落地后必须升级、来源消失后不许再报
"original"、等待只付一次。

### 12. 视频：本体取不到（已证实），但封面能取到（2026-10-04）

用户报「视频消息收到了，但文件本体没下来——inbox 里还是只有图，没有视频」。把那条真实消息
（柳毓琳 localId=77，35 秒 / 8.2MB）查到底：

**本体确实不在机器上，而且不是读取器的错：**

- 行的 XML 只有 CDN 坐标：`cdnvideourl` / `aeskey` / `length=8610009` / `md5` / `newmd5`；
- 全盘（`msg/attach`、`msg/video`、`msg/file`、以及账号根目录递归）**没有任何 mp4**，
  也没有任何 8.6MB 量级的文件；
- 原因：微信只在**播放**收到的视频时才下载它，这条从没被播放过；
- CDN 直取也不行：`novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=…` 恒 400
  （与图片同一条死路；换 host 时 `dldir1.qq.com` 甚至回 `file not exist`）。

**封面能取到，而且文件名规则是查出来的、不是猜的：**

- 文件在 `<account>/msg/video/<YYYY-MM>/<32hex>_thumb.jpg`；
- 三个"看起来像"的键都不对：`newmd5`（那是视频自己的 id）、`cdnthumburl` 里的 UUID
  （`bcb732d9-…`）、`packed_info_data` 的 md5——把整行所有 32hex/UUID 形状的值逐个拿去磁盘上找，
  **一个都不匹配**；
- 真正可靠的绑定是：**同月目录 + mtime 与行的 `create_time` 最接近**（实测差 5 秒，客户端在消息
  落地时写下封面），并用**行自带的 `cdnthumblength` / `cdnthumbwidth` / `cdnthumbheight`**
  逐张校验（10,312B / 224×398 三者全中）。两个候选一样近时宁可不给，也不把别人的封面发出去。

于是视频消息现在的形态是：**封面文件 + 一句实话**——

```
[视频]（这是封面 224x398；35s / 8.2MB 的视频本体没有下载到本地——微信只在播放时才下载收到的
视频，CDN 也取不到（HTTP 400）；需要原片的话请对方用「文件」方式重发一次）
```

读取器统计行加了 `videoThumbs`。**仍缺**：文件消息（`localType=49` + app type 6）的落地解析——
`msg/file/<YYYY-MM>/` 确实存在真文件，但当前数据库里没有一条文件行可以据此验证命名规则，
所以这一半等一次真实发送再实现，不先猜。

## Alternatives considered

1. **把 `db_reader` 移植成纯 Node。** Node 24 有 `node:sqlite` 和 zstd，理论上可行，长期也最干净（去掉 Python 依赖）。否决理由：43KB+ 的读取层里全是踩出来的坑（分片路由、占位会话、`real_sender_id` 的 Name2Id 映射、群聊 `wxid:\n正文` 前缀、压缩内容的 hex 形态），重写等于把那些坑再踩一遍，而且要等到全部对齐才能上线；现在是"读侧已经断了"的救火期。用 vendored 文件 + 一个 JSON 协议子进程，当天就能跑通，且把风险限制在一个已验证的组件里。
2. **每次轮询起一个一次性 Python 进程**（照抄 `wechat-cli-inbox` 的调用方式）。否决理由：实测冷启动 1.3s，随分片增长，2 秒轮询下等于持续满载；且每次都要重写解密快照文件。
3. **继续修 wx-cli 的密钥加载。** 否决理由：它的 Windows 读取是内存扫描，hook 是 macOS-only，密钥加载不是 bug 而是没实现；而且它自己也要一份解密层。
4. **让 WeFlow 的 DLL 复活。** 否决理由：闭源 + 联网授权，服务端不在我们手里；已经失效一次就会再失效一次。
5. **保留 Cua 读源并行跑，互为备份。** 否决理由：两源同开必然重复回答（id 不同，去重层挡不住）。真正的备份是"关掉 db 源就退回 Cua 源"，而不是同时开。

## Consequences

- 入站不再依赖闭源二进制、不抢前台、不受"会话没打开"限制；未读数和全量历史也一并可用（后续做摘要/检索的地基）。
- 代价一：**多了一个运行时依赖**——Python 3.9+ 与 `pycryptodome`、`zstandard`。缺依赖时轮询会明确报错，不会静默。
- 代价二：**密钥是运营负担**。账号重新登录后密钥轮换，需要重新提取并更新 `.env`；期间通道会持续报 `KeyMismatchError`。
- 代价三：读的是**别人的客户端落盘的数据**，只能在"这台机器 + 已登录账号"范围内工作；换机器要重来。
- 代价四：**语音 / 视频 / 文件**仍未解析（图片已解析，见 §8），这几种目前仍是 `[语音]` 这类占位。
- 代价五：图片解析依赖 `uin` 推导密钥，ffmpeg 只在 `wxgf` 原件时才需要；两条都可被 `CYBERBOSS_WECHAT_DB_IMAGE_KEY` / `CYBERBOSS_WECHAT_DB_FFMPEG` 覆盖。
- 代价六（§10 之后的已知缺口）：**"交付时还只有预览"没有补救路径**。消息一旦投递就被记入 seen 集合，
  原图在 10 秒之后才落地的话，那一轮就永远是预览——只能靠用户重发一次。要补就得让"迟到升级"
  去发一条独立消息（缓存里有图，但没有"只发一张图"的出站原语），这属于下一轮，不在本轮范围。
- 副作用（正）：`filehelper`（文件传输助手）也被读，于是"同号手打 → 机器人回答"这条自检路径不再依赖截图方向判断。
- 运维：两个 Cyberboss 共用同一账号时必须各给一个 `CYBERBOSS_WECHAT_DB_CACHE_DIR`，否则明文快照互相覆盖（Windows `WinError 5`）。
