# Agent Note: bot 工具层接入微信任意文件发送

Status: implemented

## Problem

个人号那条 UIA 桥已经有能力把任意文件发成真正的微信附件（见 [微信发文件（CF_HDROP 剪贴板粘贴通道）](2026-09-30-weixin-file-send-clipboard.md)），但它当时只是一个 HTTP 端点：**bot 的 agent 没有工具可调**。所以用户即使在微信里说"把这个文件发我"，bot 也只能回到"我发不了文件"或发公网链接 —— 能力在，通路没接上。

三个具体缺口：

1. **工具层没有入口**：`ProjectToolHost` 里只有 `cyberboss_channel_send_file`，它走官方 bot 通道（`ChannelFileService`），因此继承 iLink 的 `context_token` 约束 —— 只能回复，不能主动发。
2. **跨账户路径**：桥以 `cwinprobe` 身份运行，只能读 `C:\ProgramData\cwin-probe\outbound-images`；bot 以 `79388` 身份运行，文件通常在工作区里。直接把工作区路径交给桥会得到 `WinError 5`（这正是并发那篇 [跨用户文件路径把媒体收发掐死](../../implemented/bug-fix/2026-09-30-cross-user-media-paths.md) 记录的同一类故障）。
3. **账本无法确认**：图的核验靠 `contentKind === "image"` 的 FIFO 匹配，文本靠内容 hash 匹配；而文件行在 WeFlow 里的 `content` 是**原始 appmsg XML**，`contentHash` 永远对不上、`contentKind` 也不是 `image`。桥的 `/api/send-file` 当时返回 `verified:false` 且没有 `localId`，于是这条发送在账本里只能是 `failed_uncertain`，永远无法变成 verified。

## Decision

**1. 桥侧新增文件核验**（`scripts/weflow-uia-bridge.py`）

- `BridgeState.message_matches_file(message, file_name)`：按 `isSend=1` + **`rawContent` 里 `<title>` 等于附件名**匹配。**刻意不比对 `localType`** —— 实测文件消息是 `localType=25769803825`（一个 64 位复合值），按字面值猜会 fail-closed；附件名才是稳定键。
- `BridgeState.dispatch_file_and_verify(contact, talker, file_path, timeout)`：与 `dispatch_image_and_verify` 同构 —— 发送前取基线 localId 集合，发送后轮询，命中新行即返回 `{dispatched, verified, localId}`。
- `/api/send-file` 改为接收 `timeout` 并调用带核验的版本。

**2. bot 侧新增出站服务**（`src/services/channel-file-outbound-service.js`）

- `stageForBridge(sourcePath)`：算 sha256；**已在共享目录内则原地使用**，否则按 `名字-<sha256前12位><扩展名>` 复制进 `config.generatedImageOutboundDir`（该值在本部署里已经是共享目录 `C:\ProgramData\cwin-probe\outbound-images`，与桥的 `--image-root` 同源）。内容寻址命名让重复发送既不会撞名也不会覆盖。
- `sendToCurrentChat({ filePath, timeoutMs })`：暂存后调用 `sendWeFlowUiaFile`，回传 `requestedPath / stagedPath / staged / size / sha256` 供调用方核对。
- **默认 60 秒核验窗口**，不是 0：零等待只能得到 `verified:false`，那会让每次调用都长得像失败。

**3. 桥客户端新增发送函数**（`src/integrations/weflow-outbound.js`）

- `sendWeFlowUiaFile(...)`：与 `sendWeFlowUiaImage` 同构（账本 claim → HTTP → 核验 → `markVerified`/`markFailed`），差别是 `contentKind: "file"`、账本文本记为 `[文件] <附件名>`（这样读侧按 localId 回来时 `contentHash` 能对上），以及不再需要 `imageDigest` 语义。

**4. 工具注册**（`src/tools/tool-host.js`、`create-project-tooling.js`）

- 新工具 `cyberboss_channel_send_file_any`，`{ filePath, timeoutMs? }`。**与 `cyberboss_channel_send_file` 并存**：两个工具走**不同通路**（官方 bot 通道 vs 个人号桥），不是重复实现 —— 前者受 `context_token` 约束只能回复，后者随时可发。
- `createProjectTooling` 新增 `weflowMessageLedger` 注入口，`app.js` 构造时传入同一个账本实例，使工具发送与 bot 其它出站共用一份去重/核验状态。

**5. 运行时指令补上工具选择规则**（`templates/weixin-operations.md`）

新建工具之后立刻暴露出一个会让功能"装了但用不对"的缺口：那行既有指令只说"生成/拿到本地文件就直接发给用户"，**没说是哪个工具** —— 而两个文件工具的能力边界完全不同（`cyberboss_channel_send_file` 在 `weflow-uia` 下最终调只收 PNG 的 `/api/send-image`，见 `src/adapters/channel/weixin/index.js`，所以发视频**必然失败**）。因此补了一条并列说明，并明确 **默认用 `cyberboss_channel_send_file_any`**，同时说明它接受共享目录之外的路径、会自行暂存。

注入路径：`loadWechatInstructions()`（`src/adapters/runtime/shared-instructions.js`）在开新 thread 时把 persona + operations 拼进回合文本，缓存键含 mtime，所以改文件即时可读；**但已存在的 thread 不会自动重读**，需要 `/reread`。

## Verification

真机端到端（2026-09-30 13:12），脚本 `tmp/verify-channel-send-file-any.js` 与 `tmp/verify-file-outbound.js`：

| 检查 | 结果 |
|---|---|
| 工具已注册 | `listTools()` 含 `cyberboss_channel_send_file_any`，description 带结构化签名 |
| 共享目录内的文件 | `localId=338`、`verified:true`、`staged:false`、账本 `localId=338 totallen=155` = 本地字节数 |
| **共享目录外的文件**（工作区 `tmp/`） | 暂存到 `outbound-images/staging-test-131246-cd7780af5fe5.txt`，`byte-equal size=true md5=true`，`localId=339`、`verified:true`，账本 `localId=339 totallen=225` = 本地字节数 |
| 匹配器单测 | 对真实行形状命中；文件名不符 / `isSend=0` 均不命中 |

`npm run check` 通过（新服务已加入该脚本的 `--check` 链）。桥的重启走 `scripts/isolated-session/bridge-restart.ps1` 投递到会话 4 队列，`/healthz`、`/readyz`、`/api/probe` 三绿。

## Alternatives considered

- **复用 `cyberboss_channel_send_file`，让它内部自动选通路**：最强理由是工具只有一个、agent 不必理解两条通路的差别。否决原因是两条通路的**语义与前提不同**：官方通道需要 `context_token`（只有回复窗口内可用），桥通道需要目标桌面空闲且会抢占前台。合成一个工具就必须在内部猜"现在能不能走官方通道"，猜错的表现是**静默失败或延迟送达**；分开则 agent 自己知道什么时候能用哪条。
- **只在桥侧做，不接进 bot 工具层**（即停在 HTTP 端点）：最强理由是改动面最小、已验证可用，而且我可以像本轮一样手动调用。否决原因是它把能力绑在"有人工在电脑前调 curl"上 —— 用户在微信里说"发给我"时 bot 仍然做不到，而这正是需求本身。
- **不新增核验，接受 `verified:false`**：最强理由是不用改桥、改动面小。否决原因是它让**去重机制失效**：账本条目永远停在 `failed_uncertain`，同一次发送重试时 `describeExistingFileDelivery` 只能返回 uncertain，用户会收到重复文件；而且真失败与"只是没确认"无法区分。
- **把文件内容内联进请求体，由桥落盘**：最强理由是彻底绕开跨账户路径问题。否决原因是 4–60 MB 的 base64 会放大请求体、并把"路径可读"这个简单前提换成内存与超时风险，收益不抵成本。
- **按 `localType` 精确匹配文件消息**：最强理由是类型判定最直接。否决原因是该值是 64 位复合量（实测 `25769803825`），换客户端版本可能变化，按字面值匹配会在升级后静默失配；附件名与发送内容一一对应，更稳。
- **把暂存目录新增一个专用配置项**：最强理由是语义更清晰（"文件暂存"与"生成图片"分开）。否决原因是本部署里 `CYBERBOSS_GENERATED_IMAGE_OUTBOUND_DIR` **已经**是两个账户共同的读写目录，且桥的 `--image-root` 同源；再加一个配置项等于把同一个物理目录登记两次，迟早漂移。

## 后续修复：三个真实缺陷（2026-09-30 下午，真机复现后修）

首次实现只验证到"2.7 MiB 视频能送达"，随后一次真实用户请求（"把演示视频发我"）暴露出三个缺陷。它们共同的表现是**工具看起来很失败、但微信其实收到了**，对 agent 和用户都是误导。

**缺陷 1：核验窗口被架空。** `sendWeFlowUiaFile` 缺省回退到 `config.weflowBridgeTimeoutMs`，而部署里 `CYBERBOSS_WEFLOW_BRIDGE_TIMEOUT_MS=30000` —— 那是**传输预算**，不是媒体核验窗口。调用方按体积算出的窗口被这个 30 秒覆盖，于是 59 MiB 的发送在桥仍忙碌时客户端就放弃了。改为独立的 `DEFAULT_FILE_VERIFY_TIMEOUT_MS`，文本/图片两条路径不动。

**缺陷 2：窗口又开得过大。** 一度把窗口放到 300 秒。实测视频行**在开始发送后约 12–14 秒就出现了**，但桥会**占满整个窗口**（它同时持有 `send_lock`），客户端在 ~302 秒撞上自己的套接字上限断开，桥写响应时抛 `ConnectionAbortedError`，日志留下 `client disconnected before the response was written`。于是一次**已成功送达**的发送被报成 `fetch failed`。收紧为 60s 起、每 MiB +5s、上限 180s，客户端预算为窗口 +90s。修复后同一文件 **5 秒**返回 `verified: true`。

**缺陷 3（最关键）：暂存重命名破坏了核验。** 跨账户暂存原本把文件命名为 `名字-<sha256前12位>.mp4`。而桥是按**附件名**核验的（`message_matches_file` 比对 `<title>`），微信显示的就是传给它的那个名字 —— 于是 `<title>` 永远对不上，每次发送都 `verified:false` 且没有 localId，账本把成功送达记成不确定，**去重随之失效**。改为**保留原文件名、用摘要命名的子目录去重**（`staged/<sha256前16位>/原名`）。

**缺陷 4：视频消息根本没有 `<title>`。** 视频行是 `<videomsg length=... playlength=... compress=.../>`，文件匹配器看不见它。新增 `message_matches_video`（`localType=43` + `isSend=1`，`length` 只作参考不作要求，因为微信会转码：实测 59.4 MiB 源到达时是 5.2 MB / `compress="2"`），`/api/send-file` 新增 `kind` 参数，按扩展名自动区分视频与文件。

**缺陷 5（不是代码缺陷，是指令缺陷）：persona 只教怎么"读"媒体，没教怎么"发"媒体。**

工具修好、重启 bot 之后，用户 15:19 再发一次同样的请求，bot **仍然只回文字 + 公网链接**。查 persona 指令（`$CYBERBOSS_HOME/weixin-instructions.md`，会话创建时加载）发现：`## 链接、图片、文件和视频` 一节完整讲了怎么**读**链接/图片/文档/视频，**完全没有**"把文件发给用户"的规则。所以 agent 面对"发给我"时只能自己发明办法 —— 它选了发链接，还写下"我没有发文件的权限"。

修法是两层：

1. **persona 新增 `## 把文件真正发给他（重要）`**：明确两个工具的分工（`_any` 发文件与视频、另一个只回复且只收 PNG）、点名禁止的四类替代行为（公网链接 / 让他去 Downloads 拿 / 因文件大放弃 / 声称没权限），并要求 `verified:false` 时如实说没确认。
2. **置顶记忆 `capability/wechat_file_delivery`**（经 `MemoryService.remember` 写入，非手改 JSON）：`pinned: true` 使其免于裁剪且检索得分最高（实测检索"发文件 视频 给他"排第一）。

**注意生效时机**：persona 与 operations 都只在**开新 thread** 时读取（缓存键含 mtime，但已存在的 thread 不会重读）。所以改完仍需要 `/reread` 或 `/new`。记忆是**按需检索**注入（`inbound-turn.js` 的 `memoryItems` 段由调用方传入），不是每回合强制，所以它不能单独保证行为。

**缺陷 6：`/new` 清错了绑定层，所以"新建对话"根本没有换会话。**

排查的第一版结论（"DSH 会话把工具列表钉死，必须 `/new`"）**只对了一半**，而且把责任推给了 DSH。实测证明真正的故障在 cyberboss 自己：

- 微信窗口的 thread 存在 **conversation 层**：`threadIdByConversationByRuntime["dsh-acp"]["weflow:wxid_ubo0cy5xh4px22"][workspace]`。
- 而 `handleNewCommand`（`src/core/app.js`）调 `startFreshThreadDraft({ bindingKey, workspaceRoot })` 时**没有传 `conversationKey`**，于是适配器走 `else` 分支清的是 `threadIdByWorkspace` 那一层（`src/adapters/runtime/dsh-acp/index.js:443-447`）。
- 下一轮 `resolveSessionId` 仍能从 conversation 层读到旧 id → `resumeSession` → **日志原文 `dsh-acp resumed session 52851026-…`**。所以 `/new` 报"已切换"，实际还在同一个会话里、拿着同一份旧工具表。

**修法**：`handleNewCommand` 用 `resolveConversationKeyForSource(normalized)` 取会话作用域（与 prepared 路径同一套解析：`sessionScope` → `chatId`），再传给 `startFreshThreadDraft`。顺带把 `resolveConversationKeyForPrepared` 重构为对同一底层函数的委托，避免两条路径各写一份 DSL。

**关于 DSH 的那一半结论仍然成立**：DSH session 的工具集合在**创建时**确定，之后新增的 MCP 工具不会进入已存在的会话 —— 所以加新工具后确实必须让目标会话重建。但**重建的前提是 `/new` 真的换掉了会话**，而在这之前它没有。

**已做的现场修复**：用 `SessionStore.setThreadIdForConversation(..., "")` 把 `weflow:wxid_ubo0cy5xh4px22` 的绑定清空（备份 `dsh-sessions.json.bak-stalebinding`），使下一轮直接新建会话。**注意 `SessionStore` 只在构造时 `load()` 一次、`getBinding` 读的是内存**，所以清完必须重启 bot 才会生效，否则内存里的旧值会被 `updateBinding` 写回。

## Consequences

- **收益**：agent 现在有正式工具可以把任意本地文件真正发进微信（不再依赖发公网链接或人工调端点）；跨账户路径由服务层统一处理，调用方只给一个普通绝对路径；文件发送进入账本，具备去重与失败可见性；桥对文件消息第一次有了可复用的核验手段。
- **代价**：
  - 新增了跨三个文件的契约（桥端点契约、`sendWeFlowUiaFile` 的账本语义、工具 schema），任何一处改动都要同步其余两处。
  - 发送会**覆盖用户剪贴板**且不可还原（`CF_HDROP` 的固有限制，见基础通道笔记）。
  - 工具要等满核验窗口才能返回 `verified`；默认 60 秒意味着长文件发送会有可感知等待。
  - 暂存是**再复制一份**到共享目录（内容寻址命名），磁盘上因此存在两份；未实现清理。
  - 桥的改动只在**会话 4 内重启后**生效，本地代码更新与运行态可能不同步。
- **遗留**：`BridgeState.dispatch_file`（无核验版）在 HTTP 层已无调用方，仅作保留；暂存目录没有清理策略（内容寻址命名意味着同一文件重复发送只占一份，但不同文件会持续累积）。
- **尚未验证的一格**：`ProjectToolHost.invokeTool` 路径已逐字节验证，但"用户在微信里说一句 → agent 自己挑中这个工具并传对路径"**仍未验证** —— 它需要目标会话重建后才有工具可用（见缺陷 6）。截至本轮结束，bot 那个窗口绑定的仍是 9/18 创建的旧会话，因此 agent 依旧看不到工具。
- **验证自造的噪声**：测试期间发出的文件被 bot 的入站轮询当成入站消息拾回，在 `weflow-inbox-cursor.json` 的 `deadLetters` 里留下 4 条 `media_export_deadline_exceeded`（bot 无法把出站附件再导出给自己）。不影响功能，但下次做同类验证要预期这一现象，别误判成故障。
- **测试残留**：调试期间往用户微信里发了 4 条重复的演示视频（`localId=365/367/369/371`）。微信桌面端不支持程序化撤回，只能由用户手动删除。

## Testing

无自动化测试入库（整条链路依赖真实微信客户端 + GUI 自动化）。两个验证脚本放在 `tmp/`（不入库）：`verify-file-outbound.js` 直接驱动服务层，`verify-channel-send-file-any.js` 走 `ProjectToolHost.invokeTool` 并额外校验暂存后的字节等价。桥侧匹配器可用模块导入做纯函数单测（`message_matches_file` / `message_matches_video` 均已如此验证，含"入站视频行不得命中"的否定用例）。

修复后的端到端证据（2026-09-30 14:39，59.4 MiB 原片）：调用返回 `verified: true, localId: 376`，**耗时 5 秒**；对照修复前同一文件为 ~302 秒后 `fetch failed`。

**微信会对视频转码**，所以"本地字节数"不能作为送达判据：同一份 59.4 MiB 源在账本里是 `length=5228888`、`compress="2"`、`playlength=38`。判据应取 `playlength`（时长）+ 出现时间 + 新的 localId，而不是逐字节相等 —— 这一点与文件附件（`<totallen>` 与本地一致）不同。

**同时确认"文件太大发不了"是错误假设**：用户 agent 曾据此改发公网链接。实测 59.4 MiB 经微信视频通道可以正常送达，微信自行转码到约 5 MB。

## 同日后续：同一条路由上的"发送条数"限制

这篇确认了桥通道"随时可发"；同一天稍后把 `templates/weixin-operations.md` 里残留的官方通道前提（每个用户输入最多 10 条分片、任务变长要提前收尾）也一并删掉，把补发通知里的 `context_token` 解释换成一句中立文案，并让小号路由上的遗留内容独立成条发出（不再拼在新回复前面）—— 见 [小号通道取消发送限制：分片预算、context_token 通知、遗留内容拼接](2026-09-30-weixin-xiaohao-no-send-limits.md)。本篇第 5 条记的注入路径与 `/reread` 前提不变。
