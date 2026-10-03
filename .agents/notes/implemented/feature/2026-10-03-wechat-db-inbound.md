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
- 代价四：媒体（图片/语音/文件）**暂未解析**，目前只给出 `[图片]` 这类占位（与 Cua 读源同等能力）。落盘路径解析、`voice_decode` 是下一步可做的增量。
- 副作用（正）：`filehelper`（文件传输助手）也被读，于是"同号手打 → 机器人回答"这条自检路径不再依赖截图方向判断。
- 运维：两个 Cyberboss 共用同一账号时必须各给一个 `CYBERBOSS_WECHAT_DB_CACHE_DIR`，否则明文快照互相覆盖（Windows `WinError 5`）。
