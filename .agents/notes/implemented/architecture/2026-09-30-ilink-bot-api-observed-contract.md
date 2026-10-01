# Agent Note: iLink Bot API 实测契约（微信官方 bot 通道）

Status: implemented

## Problem

微信官方 bot 通道（iLink，`https://ilinkai.weixin.qq.com`）只有一份外部协议文档，且**两个错误码的语义在实践中与文档不一致**。2026-09-30 排查"出站媒体发不出去"时，我基于文档把 `errcode: -14` 读成"会话过期、需要重新扫码配对"，并准备据此让用户重扫码 —— 那个判断是错的，如果执行就会让用户白跑一趟登录流程、还会掩盖真正的原因。

这类"错误码与文档不符"的坑没有任何本地记录可查，下一次排查会原样重踩。所以把实测到的契约固化在这里。

## Decision

以下事实由 `scripts/weixin-ilink-probe.mjs` 在真机（bot `wx_a245fd04968c7a4262b20a5d`）上反复实测得出，**三次独立运行结果一致**：

**出站 `sendmessage` 的错误码语义：**

| 响应 | 实测含义 |
|---|---|
| `ret: 0` | 成功 |
| `ret: -2, errmsg: "prepare failed"` | **缺少/无效 `context_token`**。请求体合法，服务端读懂了才拒绝 |

**`errcode: -14` 不是"会话过期"。** 实测：请求体**畸形**（`item_list` 缺失、或 `text_item.text` 为空、或 item 缺字段）时返回 `errcode: -14, errmsg: "session timeout"`；同一时刻请求体合法的调用返回 `ret: -2`。即：

- `-14` 表示**服务端无法为该请求建立上下文**（实测触发条件就是请求体畸形），不是 token 失效
- `notifystart` 在同一时刻返回 `ret: 0`，证明**会话本身健康**
- 因此**不能**用 `-14` 判断"需要重新登录"。插件 `weixin-api.mjs:816` 把 `notifyStart` 的 `-14` 映射成 `stale-token`，那条映射只在 `notifystart` 这个调用上有意义；把同一假设推广到 `sendmessage` 会误导

**校验顺序**（用于判断探测结果的能力边界）：`sendmessage` **先**做请求体结构校验（畸形 → `-14`），**再**校验 `context_token`（缺失 → `-2`）。所以用一个**合法**的 item 探测才能越过结构校验、真正抵达 token 校验；用畸形 item 探测得不到关于 token 的任何信息。

**媒体上传半条链路不需要 `context_token`**（实测通过）：

| 步骤 | 需要 token？ | 实测 |
|---|---|---|
| `ilink/bot/getuploadurl` | 否 | `HTTP 200`，返回 **`upload_full_url`** |
| `POST` CDN `/c2c/upload`（AES-128-ECB 密文） | 否 | `200`，回 `x-encrypted-param` |
| `ilink/bot/sendmessage` | **是** | `ret: -2` |

字段坑：`getuploadurl` 的响应字段是 **`upload_full_url`**（不是 `upload_param`）。插件 `weixinCdnUploadUrl()`（`weixin-api.mjs:335`）优先读前者、回退后者，行为正确；只认 `upload_param` 的客户端会误报"服务没返回上传地址"。

**`getupdates` 的性质**（决定监听怎么设计）：

- 是**真长轮询**：实测挂起约 19.5 秒后返回，不是立即回空
- 传**空 `get_updates_buf` 不回放历史消息**：只从那一点开始投递新消息。所以**监听必须在消息到达之前就在跑**，错过即永久丢失
- 游标是服务端同步状态：**并发轮询同一个 bot 会互相干扰**（实测监听器长轮询期间并发发 `sendmessage` 会改变其返回码）。排查时不要一边跑监听一边发探测

## Consequences

- **收益**：错误码语义有了可复用判据，下一次遇到 `-2` / `-14` 不必重新试错；"上传不需要 token、只有发送需要"这个切分让排查可以半步半步推进；`getupdates` 的三条性质决定了任何"事后补拉"方案都是徒劳，省掉一整类无效尝试。
- **代价**：本记录只覆盖实测到的分支，`-14` 是否还有其它触发条件（如并发轮询）**未收敛** —— 我观察到它在监听器运行期间出现、停掉后仍可复现，但两个变量没有完全分离。若要定论需要单独设计实验（固定请求体、只变并发度），本轮没做。
- 这些是**服务端行为**，上游可以随时改，且不会通知。它们不是契约保证，只是某时刻的快照。

## Alternatives considered

- **只依赖公开协议文档**（[wechatbot.dev/zh/protocol](https://www.wechatbot.dev/zh/protocol)）：最强理由是它是唯一权威来源，且正确给出了 `ret: -2` 的语义（参数错误）和 `context_token` 的强制性 —— 我最初能定位到"缺 token"正是靠它。否决原因是它对 `-14` 的说明（"会话过期，需重新扫码"）**在 `sendmessage` 上会把人带偏**：实测同一时刻会话健康、`notifystart` 返回 0。纯文档推导会得出错误的行动（让用户重扫码）。
- **把结论并入上游补丁笔记**：[微信原生视频发送](../../proposed/feature/2026-09-30-weixin-native-video-send.md) 已经引用了这些事实。否决原因是两者受众不同 —— 那篇是"要不要给上游提这个补丁"的提案，本篇是"这个 API 怎么用"的参考资料；后者会被与视频无关的排查复用（例如将来查图片或文件发送失败）。拆开后删除或改写提案不会带走 API 契约。已在两篇间互链。
- **不做记录，留在对话里**：最强理由是这些都是临时排查产物，`tmp/` 下的脚本还在。否决原因是对话会被压缩、`tmp/` 被 `.gitignore` 忽略，而"`-14` 不等于会话过期"这条恰好是**反直觉**的 —— 不留档必然重踩，且重踩的代价是让用户白跑一次扫码登录。

## Testing

证据来源为 `scripts/weixin-ilink-probe.mjs` 的 `notify` / `order` / `text` / `upload` / `poll` 五个模式，在 2026-09-30 12:19–12:35 之间多次运行：

- `notify` 三次全部 `ret: 0`
- `order` 三次全部三行 `errcode: -14, errmsg: "session timeout"`
- `text`（合法 item）三次全部 `ret: -2, errmsg: "prepare failed"`
- `upload`（`media_type: 2` 与 `3`）两次全部 CDN 上传成功

`tmp/` 不入库，所以三个已验证可用的工具都落在受版本管理的 `scripts/` 下，命名沿用既有的 `scripts/weflow-*-probe.py` / `scripts/weflow-*-e2e.js`：

| 脚本 | 作用 |
|---|---|
| `scripts/weixin-ilink-probe.mjs` | 单点探针：`notify` / `order` / `text` / `upload` / `poll` / `file` / `video` 七个模式 |
| `scripts/weixin-ilink-e2e.mjs` | 端到端自测：`notifystart` → 双路取 `context_token` → 四步发送矩阵（`--sequential` 串行、`--gap-ms` 间隔） |
| `scripts/weixin-ilink-listen.mjs` | 常驻包装器：监听器必须**在消息到达之前**就在跑，所以它负责崩溃自愈与重新武装 |

**活性必须秒级可观测**：长轮询一挂就是 35 秒，"静默挂住"与"正常等待"在外部完全同形。所以 `weixin-ilink-e2e.mjs` 每轮 poll 都重写 `tmp/weixin-e2e-polls.json`（含累计次数与时间戳），不必等 10 分钟心跳。实测两次循环相隔约 19.5 秒，正好是一个长轮询周期 —— 这也是判断"监听器到底在不在轮询"的唯一可靠手段（本次排查中我因为缺少它，误把 `-14` 读成会话死亡）。

**运行的就是受版本管理的那份**（`tmp/` 只留一个启动器），避免"版本库里的副本"与"实际运行的副本"漂移。
