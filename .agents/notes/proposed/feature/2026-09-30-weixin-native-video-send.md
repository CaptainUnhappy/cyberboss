# Agent Note: 微信原生视频发送（上游 dsh-im 补丁）

Status: proposed

## Problem

微信通道**只能把视频当文件发**，不能发成微信里可播放的视频气泡。

用户 2026-09-30 要求"发送视频"时暴露的：`dsh_im_return_file`（DSH IM 插件的出站文件工具）把 mp4 交给 `sendFile`，微信侧收到的是 `media_type: 3` / `item.type: 4`（`file_item`）—— 能下载、能播，但没有封面、不是视频气泡。

根因不是"没有能力"，而是**语义层缺一个分支**：

| 层 | 状态 |
|---|---|
| 接收侧 | **已支持视频**：`weixin-api.mjs` 把 `item.type === 5` / `video_item` 归类为 `{ kind: 'video' }` |
| 上传层 | **本来就通用**：`sendArtifact({...}, { mediaType, createItem })` 对 mediaType 无约束，`sendArtifact` 里已存在 `mediaType === 3` 的特例分支 |
| 出站分支 | **缺失**：`artifact-delivery.mjs` 只判 `image/` 前缀，`video/mp4` 落到 `sendFile` |
| 通道闭包 | **缺失**：`weixin-bridge.mjs` 只注入 `sendImage` / `sendFile`，无 `sendVideo` |

同生态的旧实现（本仓库 `src/adapters/channel/weixin/media-send.js`）**是有** `WEIXIN_MEDIA_TYPE.VIDEO = 2` + `type: 5` + `video_item` 路径的 —— 同一个 iLink 协议，第三方 IM 插件只是没做这一步。

## Proposal

向上游 `xmanrui/dsh-im` 提一个三处改动的小补丁，形状与既有图片路径完全对称：

1. **`src/channels/weixin/weixin-api.mjs`** — 新增 `sendVideo`：`mediaType: 2`、`createItem` 产 `type: 5` + `video_item.video_size`。复用 `sendArtifact`，不动其内部。
2. **`src/channels/weixin/weixin-bridge.mjs`** — 在 `sendImage` / `sendFile` 旁补 `sendVideo` 闭包（`#deliverArtifacts` 内）。
3. **`src/channels/shared/semantic/artifact-delivery.mjs`** — `sendMaterializedArtifact` 增加 video 优先分支：provider 提供 `sendVideo` 就走原生，失败**降级**到 `sendFile`；未提供则行为与今天逐字节相同（其它渠道不受影响）。

顺带把 `sendMaterializedArtifact` 里三处 `typeof ... === 'function'` 判定收成一个 `providerSupports` 辅助函数 —— 加第三处之后，重复已经比辅助函数更难读。

补丁与验证脚本落在受版本管理的位置：`dsh-plugins/dsh-im-weixin-video/`（含 `0001-weixin-send-native-video.patch`、`validate-patch.mjs` 与 README）。上游插件代码本身不进本仓库。

写这篇前检索了 `.agents/notes/` 的 proposed + implemented + rejected：同日并发的 [跨用户文件路径把媒体收发掐死](../../implemented/bug-fix/2026-09-30-cross-user-media-paths.md)（已落地）部分重叠但不冲突 —— 那篇讲本仓库**自家 WeFlow/UIA 链路**（个人号、隔离会话、两个 Windows 账户之间的 ACL），本篇讲 **dsh-im 插件链路**（官方 bot 号、iLink 协议）。两者是当前并存的两条微信通路，媒体能力各修各的；共同点是"出站媒体发不出去"这一现象在两边同时存在、根因完全不同（那边是文件路径 ACL，这边是缺 video 分支）。其余命中笔记均为本仓库既有微信实现（UIA 桥、白名单、隔离会话部署），与本篇无决策冲突。

## Mechanism: 出站文件的归属（决定"能不能测"）

这一节是本次排查最有复用价值的部分，比补丁本身重要。

`dsh_im_return_file` 是**两阶段**工具，且投递**绑定回合的所有权**：

- `createOutboundArtifactTool().execute()` 只做 `registry.stage()`；工具成功返回也**没有发送任何东西** —— 所以模型回复只能说"已准备/已排队"。
- 真正投递发生在回合结束，由**发起该回合的 IM 渠道**驱动：`harness-client.mjs:1454` 的 `deliverArtifacts()` 调 `outboundArtifactRegistry.take(sessionId, tracker.turn)`，再交给 `deliverOutboundArtifacts()`。
- 消费者注册在 `harness-client.mjs:1478`（`openConsumer(sessionId, promptRpcId)`），而它**只有 IM 渠道桥会调**（全仓库仅此一处）。
- `artifact.mjs:333-339`：`turn/end` 时若该回合**没有**注册消费者，直接 `discard()` —— 已 commit 的文件被清掉。

**推论**：工具在 DSH Host 里对**所有**会话可见（`lib/index.js` 是 esbuild 单包，`installOutboundArtifactTool` 全局注册），但**从 DSH Web GUI 发起的回合没有任何 IM 渠道消费者**，因此那里的 `dsh_im_return_file` 调用在回合结束时被 `discard`。

这就是为什么本次"从 GUI 侧发视频到微信"的验证**在原理上不可能成立**。第一次尝试时我把"工具在工具目录里可见"误读成"已接到微信投递"，是错的：工具可见 ≠ 有消费者。要做真实验证，**必须从微信侧发起回合**（用户在微信里发一句话），由 weixin 桥注册消费者后，`return_file` 才会被 `take` 并投递。

**第二个限制：`context_token` 不是可选项，是协议强制。** 落盘位置是 `~/.dsh/integrations/dsh-weixin/accounts/<botId>/state.json` 的 `contextTokens.users[...]`，按 `(userId)` 缓存最新一个。

2026-09-30 我用 `scripts/weixin-ilink-probe.mjs`（照插件源码复刻的最小发送器，只依赖 Node 内置模块）做了真机探测，**推翻了此前"token 已过期"的判断**：

| 探测 | 结果 |
|---|---|
| `notifystart` | `ret: 0` → 凭据有效 |
| `getupdates`（空游标） | `ret: 0, msgs: []` → bot 连接存活、无积压 |
| `sendmessage` 文字，**不带** `context_token` | `ret: -2, errmsg: "prepare failed"` |
| `sendmessage` 文字，带**存档** token（seq=11，2026-09-17） | 同样 `ret: -2` |
| `sendmessage` 文字，加 `run_id` | 同样 `ret: -2` |

即：token 有效、连接正常、请求构造正确，**唯一变量就是这个 token 本身**。

权威依据是 iLink 官方协议（[wechatbot.dev/zh/protocol](https://www.wechatbot.dev/zh/protocol)）：`ret: -2` = 参数错误（不是限流），`errmsg: "prepare failed"` 的含义是**缺少/无效 `context_token`**；协议原文明确"`context_token` **不是可选的** —— 没有它，回复无法路由到正确的微信会话""每条入站消息包含 `context_token`，每条出站 `sendmessage` 必须包含它"。同类实现在上游也有同样的记录（[hermes-agent#80125](https://github.com/NousResearch/hermes-agent/issues/80125)：复现步骤明写"用户发一条入站消息后 sendmessage 恢复工作"）。会话级过期是另一个码 `-14`，我们没拿到。

**因此"独立发送器"这条路是通的，但必须由一次入站消息开启窗口**：入站消息产生新 token → 立刻用它出站。

关于怎么拿到那次入站消息，有一个**实测得出的关键性质**（`scripts/weixin-ilink-e2e.mjs` 的 `--list-only` 实测）：

- `getupdates` 是**真长轮询**（实测挂起约 19.5 秒后才返回，不是立即回空）。
- 传**空 `get_updates_buf` 不会回放历史消息** —— 只从那一点开始投递新消息。所以"事后补拉"拿不到任何东西，**监听必须在消息到达之前就在跑**，这也解释了为什么塞满 backlog 的 `deferred` 队列一直没被消费。
- 因此自测脚本必须**两条路同时监听并竞速**：① 自己拿私有游标长轮询（插件死了也能work）；② 盯插件落盘的 `contextTokens`（插件先消费掉消息时靠这条）。谁先拿到新 token 谁赢，然后立刻跑矩阵。只做其中一条都会漏。

第一节哨兵版本（`weixin-watch-and-send`，只盯 `state.json`、依赖插件存活）已被取代并删除，由 `scripts/weixin-ilink-e2e.mjs` 的双路竞速接管。

**媒体上传这半条链路不需要 token，已实测打通**（这缩小了未知面：出站媒体不是"整条不通"，只卡在最后一步）：

| 步骤 | 需要 context_token？ | 实测 |
|---|---|---|
| `ilink/bot/getuploadurl` | 否 | `HTTP 200`，返回 `upload_full_url` |
| `POST` 到 CDN `/c2c/upload`（AES-128-ECB 密文） | 否 | `200`，回 `x-encrypted-param`（视频 776 字节 / 文件 360 字节） |
| `ilink/bot/sendmessage` | **是** | `ret:-2 prepare failed` |

踩到一个坑并已修正：`getuploadurl` 的响应字段是 **`upload_full_url`**（不是 `upload_param`）。插件的 `weixinCdnUploadUrl()` 优先读前者、回退后者，行为正确；我第一版探针只认 `upload_param`，于是误报"服务没返回上传地址"。教训：**对着实时响应写客户端，不要对着源码猜字段**。

完整的实测契约（错误码语义、校验顺序、`getupdates` 的三条性质）单独记在 [iLink Bot API 实测契约](../../implemented/architecture/2026-09-30-ilink-bot-api-observed-contract.md) —— 那篇会被与视频无关的排查复用。其中一条尤其反直觉：**`errcode: -14` 不等于会话过期**，请求体畸形时也会返回它。

## 恢复步骤（人工触发一次即可）

1. **在微信里给 bot 发任意一条消息**（这一步无法替代）。
2. 启动监听器（必须在消息到达**之前**就在跑，因为 `getupdates` 不回放历史）：
   ```sh
   node tmp/weixin-listen-forever.mjs --minutes 720 --gap-ms 4000
   ```
3. 收到后自动跑完四步，结果在 `tmp/weixin-e2e.log`：文字(无 token) → 文字(**新 token**，决定性) → 文件 `media_type:3`/`type:4` → **原生视频 `media_type:2`/`type:5`**。后两步用同一个 mp4、串行间隔 4 秒，可直接对比形态差异。

## Alternatives considered

- **直接改运行中的 `node_modules` 产物**：最强理由是唯一能让**今天**就跑起来的办法 —— 用户的诉求是"能发视频"，不是"能提 PR"。否决原因有三条，且都已核实：① `package.json` 的 `main` 指向 `lib/index.js`，而它是 **esbuild 打包 + minify 后的单文件（8.6 MB），`src/` 只是随包发布的源码副本、不参与运行时加载**，改 `src/` 不生效；② 要改 `lib/index.js` 就得在压缩代码上做结构化字符串替换（`async sendFile(request){return sendArtifact(request,{mediaType:3,...` 与 `async sendImage(request){...mediaType:1` 之间插一段），并同时处理 `clientIdSeed` 里的 `mediaType === 3` 分支 —— 可行但错一次就是静默的错消息，且 8.6 MB 单行文件无法审阅；③ 任何一次 `pnpm install` / 插件升级都会覆盖它，属于"假装修好了"。
- **重建 `lib/index.js`**：最强理由是产物与源码一致时，重建后就能正常打补丁并本地验证。否决原因：`esbuild`、`dingtalk-stream`、`undici`、`qrcode`、`@larksuiteoapi` 等**构建期依赖在这份 profile 里全部缺失**（`@xmanrui/dsh-im/node_modules` 不存在），且 `test/` 也没随包发布 —— 本地重建与回归测试都跑不起来。
- **把 `sendVideo` 做成独立脚本 / 旁路发送器**：最强理由是绕开打包问题、不动第三方包。否决原因：发送所需的 `context_token` 只能来自入站消息（见上节），且 `sendArtifact` 的收据/账本/失败通知都在插件内部，旁路会丢掉投递语义与失败可见性。
- **不做，保持"视频当文件发"**：最强理由是零风险、零维护，且**文件形态的视频功能上是完整的**（能下载能播）。否决原因是它偏离用户预期：微信里"发视频"的心智是可播放气泡，用户要的就是这个；且接收侧已支持视频，出站不对称属于明显的实现缺口而非取舍。
- **改上游同时给 `sendVideo` 加特性开关**：最强理由是避免影响其它渠道与保守用户。否决原因是分支本身已按 provider 能力门控（未提供 `sendVideo` 的渠道走原路径），再加一层开关是冗余配置面。
- **走个人号那条路（UIA 桥）把视频送进微信**：最强理由是它是**唯一一条不依赖官方 bot `context_token`** 的通路 —— 真机实测桥在线（`127.0.0.1:8776`），且它历史上用剪贴板粘贴发过媒体（`outbox/` 里留着 `wechat-pasted.png`、`wechat-sent.png` 等证据），而剪贴板是支持视频文件的，所以技术上很可能可行。**未走的原因不是不可行，而是两重代价**：① 它的 `/api/send-image` 是严格 PNG-only（`load_validated_png` 校验 `image_root` 内 + PNG 签名 + sha256 + Pillow 解码 + 像素上限），要发视频必须改桥的派发逻辑；② 那个桥正在**驱动一个真实的微信桌面客户端**（隔离会话里的个人号），改错会作用在用户的真实账号上，而原始诉求只是"把视频发给我"。**这条路线最终被采纳并已落地**：用户指出"之前成功发出过"后，我给桥加了 `CF_HDROP` 文件剪贴板通道（`POST /api/send-file`），并已真机送达两个视频 —— 完整实现与证据见 [微信发文件（CF_HDROP 剪贴板粘贴通道）](../../implemented/feature/2026-09-30-weixin-file-send-clipboard.md)。**因此本提案不再是"把视频送进微信"的必要条件**，它降级为一个独立的上游改进：让官方 bot 通道在能用的时候把视频发成可播放气泡而不是文件。

## Acceptance criteria

1. 微信侧发起回合、用 `dsh_im_return_file` 返回一个 `.mp4`，微信客户端收到的是**可播放视频气泡**（而非文件消息）；`item.type === 5`。
2. 视频发送失败时**降级**为文件发送，且失败原因进入 `lastMessageFailure`（用户能看到失败提示，不是静默丢失）。
3. 不支持 `sendVideo` 的渠道（如飞书之外的、以及任何未实现的通道）行为与改动前**逐字节相同**。
4. `npm run build && npm test` 在上游仓库通过（本机无构建依赖，需在上游仓库执行）。

## Risks

- **未经真实 provider 验证**：`media_type: 2` 的线上行为仍未实测。已缩小的部分：iLink 协议文档确认"媒体（图片、视频、文件、语音）在上传到微信 CDN 之前使用 AES-128-ECB 加密"，即视频走同一条媒体通道，补丁所用的 `media_type: 2` / `type: 5` / `video_item.video_size` 与 `scripts/weixin-ilink-probe.mjs` 的 `video` 模式一致，且同一形状的**上传半条链路已真机跑通**（`getuploadurl` → CDN 上传成功，返回 `x-encrypted-param`）。**未解的是缩略图**：当前所有媒体类型都发 `no_need_thumb: true`，视频是否另需缩略图字段协议未说明。若微信要求缩略图，补丁会退化成第 2 条验收标准（降级为文件）而不是报错，必须在真机确认。
- **端到端验证卡在一次入站消息上**：`context_token` 是协议强制的出站凭据且只能由入站消息产生（见 Mechanism 节），所以补丁的"原生视频 vs 文件形态"只能在那次窗口内测。三个工具已落库（`scripts/weixin-ilink-probe.mjs`、`scripts/weixin-ilink-e2e.mjs`、`scripts/weixin-ilink-listen.mjs`），第三方常驻长轮询等那次入站，但**尚未拿到窗口**，因此只能验证到"补丁可精确还原目标源码树 + 三个文件语法通过 + 请求构造与协议一致"。
- **上游接受度未知**：改动面小、与既有图片路径对称，但触及十一个渠道共享的语义层（虽已门控）。
- **降级路径的语义**：视频发送失败后自动改发文件，用户会**同时**看到"发送失败"提示和一个文件 —— 需要确认这是否是想要的交互（备选是彻底失败）。
