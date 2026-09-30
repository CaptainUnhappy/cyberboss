# Agent Note: 双渠道一等契约：通道能力由 `doctor` 只读探测，不靠发消息验证

Status: implemented

## Problem

两条消息通道**早就在跑**，但没有任何一处"声明"它们的存在：

1. **官方 iLink bot 通道**：HTTPS 打 `ilinkai.weixin.qq.com`（`ilink/bot/getupdates` 长轮询、`ilink/bot/sendmessage`、`ilink/bot/getuploadurl` + CDN 上传），出站**必须携带入站带来的 `context_token`**，否则 `ret: -2 prepare failed`（[实测契约](../../implemented/architecture/2026-09-30-ilink-bot-api-observed-contract.md)）。身份来自 `~/.cyberboss/accounts/<id>-im.bot.json`。
2. **个人号通道**：本地 UI 自动化，`provider === "weflow-uia"` → 写侧 `scripts/weflow-uia-bridge.py`（HTTP 8776）驱动微信，读侧 WeFlow（HTTP 5051）提供消息库。**没有回复窗口**，所以可以主动多发（[小号发送限制取消](2026-09-30-weixin-xiaohao-no-send-limits.md)）。

问题是**"哪条在跑"只活在 `provider` 字符串里**：`weixin/index.js` 的 `sendTextChunks` 按 `provider === "weflow-uia"` 二选一，`app.js` / `stream-delivery.js` / `system-message-dispatcher.js` / `reply-obligation-store.js` 各有分支。后果是具体的：

- **装完机器人没有"通道是否就绪"的判据。** `npm run doctor` 现在只打印 `channel.describe()` 的静态配置（`stateDir` / `baseUrl` / `accountsDir`），它回答的是"配置在指哪里"，不是"这条通道现在能不能发"。于是唯一的验证方式是**真的发一条消息看它回不回** —— 而发消息需要消耗/携带 `context_token`，在官方通道上不是无害操作。
- **故障表现为"不回复"而不是"通道 X 未就绪"。** 读侧 WeFlow 的 `/api/v1/health` 会一直 200 而 `/api/v1/messages` 突然 500（实测复发 3 次），这时机器人一条消息都读不到；写侧桥挂了则表现为回复发不出去。两者在日志里长得都很像"对方没理我"。
- **迁移到此为止。** 换机后判断"新机器装好了没"只能靠碰运气；[换机迁移手册](../../../../docs/migrate-device.md) 里因此只能写"发一条自测消息"。
## Decision

### 1. 通道枚举成为配置，而不是字符串分支

新增可选键 **`CYBERBOSS_ENABLED_CHANNELS`**（逗号分隔，取值 `ilink` / `weflow-uia`），`config.enabledChannels` 是它的解析结果。语义严格向后兼容：

- **未设置** ⇒ 两条通道都"被考虑"，**可用性仍由现有键推导**（`ilink`：`accounts/` 里有没有已配对账号；`weflow-uia`：`CYBERBOSS_ENABLE_WEFLOW_INBOX` + `CYBERBOSS_WEFLOW_TOKEN` + `CYBERBOSS_WEFLOW_INBOX_CHATS`）。不新增启动门槛、不改任何现有判据。
- **设置了** ⇒ 只探测列出的通道，并作为**显式声明**参与 `doctor` 的退出码。
- 路由**不变**：出站 provider 继续由路由字段显式决定，不引入隐式回落（`resolveCheckinReplyRoute` 那个"非 `weflow:` 前缀就启动即报错"的姿态保持不变）。

### 2. `doctor` 逐通道只读探测

`src/core/doctor-probes.js` 导出 `probeChannels(config, { fetchImpl })` → 一组**结构化结论**：

```
{ channel: "ilink",       enabled: true, ready: false, reason: "no-paired-account", detail: "…" }
{ channel: "weflow-uia",  enabled: true, ready: true,  reason: "", detail: "reader=ok writer=ready" }
```

**每条判据都复用既有已验证的接口，不新造协议**：

| 通道 | 探测步骤（全部只读） | 判据来源 |
|---|---|---|
| `ilink` | ① `accounts/` 里有已配对账号且 token 非空；② `ilink/bot/getconfig`（**只读会话检查**）的返回码 | `ret: 0` ⇒ 就绪；`-14` ⇒ `stale-token`（需重新扫码）；网络失败 ⇒ `unreachable`。**不发消息**（`sendmessage` 会消耗 `context_token`，绝不能当探针） |
| `weflow-uia` | ① 配置开关 + token 齐备；② 读侧 `/api/v1/health` 必须 200；③ 读侧 `/api/v1/messages` 用真实 token 查一次必须 200（**只有 health 通不算通**）；④ 写侧 `/readyz` 200；⑤ 写侧 `/api/probe` 且 `foreground != 0` | 判据全部抄自 [RDPWrap 隔离会话部署契约](../../implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md)（读侧 500 与客户端最小化的失败签名都在那里实测过） |
`app.printDoctor()` 是 `async`：先打印原来的静态快照，再打印逐通道结论；`bin/cyberboss.js doctor` 的退出码为 **0 当且仅当所有 enabled 通道 `ready === true`**（`summarizeChannels()` 算这个结论，`enabled=false` 的通道不参与判定）。

### 3. 结构化输出优先

`doctor` 的人类可读输出保持简洁，但结论以 JSON 打印（与现有 `printDoctor` 的做法一致），便于脚本化：迁移手册里那条"新机 doctor 全绿"因此可以被机器判定，而不是靠人看日志。

## Verification

1. `node bin/cyberboss.js doctor` 在**两条通道都不通**时输出两条 `ready=false` 且各带 `reason=`，退出码非 0；两条都通时输出两条 `ready=true`，退出码 0。
2. **探测不发消息**：`ilink` 分支只允许 `notifystart`；可在测试里用假的 `fetchImpl` 断言"没有以 `ilink/bot/sendmessage` 为路径的请求"。
3. `CYBERBOSS_ENABLED_CHANNELS=ilink` 时**只**输出 ilink 一条结论，且 weflow 的探测**根本不执行**（断言假 fetch 没被调用）。
4. 未设置 `CYBERBOSS_ENABLED_CHANNELS` 时，行为与现有配置兼容：weflow 未启用就是 `enabled=false, ready=false, reason="disabled"`，而不是报错。
5. 离线测试 `test/doctor-probes.test.js`：用假 `fetchImpl` 覆盖五条路径 —— ilink 就绪 / ilink `-14` 陈旧 token / weflow 读侧 health 200 但 messages 500（必须 `ready=false`）/ weflow 写侧 `/api/probe` 返回 `foreground: 0`（必须 `ready=false`）/ 全部就绪。
6. `npm run check` 保持通过（新文件加进 `--check` 列表）。

## Consequences

**收益（已实测）**

- `doctor` 现在回答的是"这条通道能不能发"，而不是"配置指在哪里"。2026-09-30 在本机实测输出：`ilink enabled=true ready=true detail="getconfig ok (read-only session check)"`、`weflow-uia enabled=true ready=true detail="reader=ok writer=ready foreground=1639902 desktopIdleSeconds=362"`，退出码 0 —— 两条通道的就绪状态第一次是一个**可机读的字符串**。
- 两个历史上靠人肉发现的故障现在有判据：读侧 `/api/v1/health` 200 而 `/api/v1/messages` 500（复发 3 次、表现为"又不回复"）会落到 `reason=reader-messages-failed` 并把 `-105` 签名带出来；写侧丢失输入桌面（客户端被最小化）会落到 `reason=writer-desktop-unavailable`。**这些判定不需要发任何消息。**
- 迁移有了机器判据：[换机迁移手册](../../../../docs/migrate-device.md) 里"新机 doctor 全绿"不再是靠人看日志，而是退出码。
- `CYBERBOSS_ENABLED_CHANNELS` 让"这台机器打算跑哪几条通道"从 `provider` 字符串的隐式分支变成一个显式声明，且**未设置时行为与从前完全一致**（可用性仍由既有键推导），所以它不可能改变机器人实际在做什么。

**代价与边界**

- `doctor` 从纯本地打印变成**会发网络请求**的命令（默认 5 秒超时、失败只归因不抛错）。它仍然不写任何状态：不发消息、不动游标、不请求 `/api/probe?move=1`。
- **`ilink` 的结论在机器人正在运行时可能偏悲**：实测契约里有一条"并发轮询同一个 bot 会改变返回码"，所以长轮询期间 `getconfig` 的判据是软判据，不能当成硬故障。
- `ilink` 就绪**不等于现在能发**：官方通道每条出站都要消耗入站带来的 `context_token`，`ready=true` 只证明账号与 token 还在、会话没死。真正"能发"取决于最近有没有入站。
- 退出码语义变了（原来恒 0）。已核对 `cyberboss-service.ps1` 与看门狗都没有调用 `doctor`（它们用各自的功能探针），所以没有打断既有自动化；但**将来若有人把 `doctor` 接进看门狗，必须先接受"非 0 = 通道不健康"**。
- 通道抽象**没有**收敛：`provider === "weflow-uia"` 的分支仍在 `app.js` / `stream-delivery.js` / `system-message-dispatcher.js` / `reply-obligation-store.js` 里。本轮只做了读路径的判据，发送路径的注册表留到有端到端回归之后（理由见下面的备选方案）。
- 测试：`test/doctor-probes.test.js` 离线 9 例覆盖 ilink 未配对 / 就绪 / `-14` 陈旧 token、weflow 未配置 / 读侧 500 / 写侧丢桌面 / 全部就绪 / 通道过滤 / 退出码判定，并断言**没有任何 `sendmessage` 请求、也没有 `move=1`**；`npm run check`、`npm run verify-notes`、`npm run verify-portable` 全绿。

- **探测会碰真机端点（已按下面的约束实现）。** `getconfig` 只是官方通道的**只读会话检查**，但它仍然是一次网络调用；`/api/probe` 用的是**只读形式**（不带 `?move=1`），不碰鼠标 —— 这是既有契约里明确的"健康一拍零扰动"。测试里断言了这两点：**没有任何 `sendmessage` 请求，也没有 `move=1`**。
- **`getconfig` 与长轮询可能互相干扰。** 实测契约里有一条：并发轮询同一个 bot 会改变返回码，排查时"不要一边跑监听一边发探测"。所以机器人在跑时 `doctor` 的 ilink 结论是**软判据**，不能当硬故障处理。
- **`doctor` 从纯本地打印变成有网络副作用的命令。** 约束：探测带 5 秒超时、失败只归因不抛错、**机器人启动路径绝不调用它**（`start` 不受影响）。
- **启用通道的显式声明有被写死的风险。** 一旦有人把 `CYBERBOSS_ENABLED_CHANNELS` 写进 `.env` 就再没清过，将来新增第三条通道会被静默过滤。缓解：未设置是默认值（此时两条都参与），且文档里把它写成"排查用开关"而不是必填项。

## Alternatives considered

- **什么都不做，继续保持隐式双渠道。** 最强理由：两条通道今天都在正常工作，`provider` 分支虽然散但**已经被测试覆盖**，动它属于"没坏就别修"；而且任何"通道就绪"的自动化判断都有假阳/假阴，可能比人工判断更误导。否决原因是它把**迁移与故障排查的成本永久留给人**：换机后没有判据、读侧 500 时没有判据，两个真实故障（复发 3 次的读侧 500、跨账号看不见的写侧）都只能靠"发一条消息看回不回"发现。
- **把通道抽象成正式的 adapter 注册表（`channels/*` 各自实现 `send`/`receive`/`probe`），彻底去掉 `provider === "weflow-uia"` 分支。** 最强理由：这才是"双渠道一等"的完整形态，也是 Cua 那条线（[驱动面必须可替换](../../proposed/architecture/2026-09-30-cua-as-drive-surface.md)）最终要的接缝；`stream-delivery.js` 里那二十来处分支会一次性收敛。否决原因（本轮）是爆炸半径：发送语义里混着账本、幂等键、`dispatch`/`verify` 判定、desktopInputLease、媒体与分片预算，任何一处挪动都可能把"能收不能答"变成"随机丢件"，而现在**没有能覆盖这些路径的端到端回归**。先做探测（读路径、零风险），把注册表留给有测试护栏的那一轮。
- **给每条通道加一个 `probe()` 方法挂到 adapter 上，而不是新建模块。** 最强理由：更贴现有的 adapter 契约，`describe()` 旁边就是 `probe()`，读代码的人一眼能找到。否决原因：`weixin/index.js` 是发送热路径（679 行、被 20 多个分支依赖），把只读探测混进去会**扩大热路径的改动面**；而探测天然是"跨通道对比"的（要一起打印、一起算退出码），独立模块更容易测。
- **用"发一条真消息到自己的群/文件传输助手"作为就绪判据。** 最强理由：这是唯一能证明**端到端真的通**的判据，比任何握手都硬；而且失败时的报错就是真实的发送失败。否决原因是三条：官方通道上 `sendmessage` 会消耗 `context_token`，把探测变成有代价的状态变更；个人号通道上发消息会在用户的微信里留下一条可见的噪声（用户对"机器人乱发消息"零容忍）；而且这个判据**无法区分"读侧坏了"和"写侧坏了"**，恰恰是本案要区分的两件事。
- **只做 `weflow-uia` 的探测，官方通道暂不管（因为它现在没在跑）。** 最强理由：最小改动，解决当下唯一在发生的问题。否决原因是这次任务的原话就是"保留双渠道，两个都作为一等公民"——只给在跑的那条做判据，等于把"官方通道将来启用时会发生什么"继续留白；而 ilink 的探测成本只是**一次只读的 `getconfig`**。
- **改 `doctor` 的退出码，同时保留"任何情况都返回 0"。** 最强理由：退出码变化是对外契约的破坏，脚本化调用方（例如将来的看门狗或 CI）可能因此中断。否决原因是迁移验收与"通道不健康"这两件事**都需要一个机器判据**，而 `doctor` 是唯一现成的入口；已核对现有服务与看门狗都不调用它，破坏面为零。折中做法（把结论只放进 JSON、退出码不变）会让"新机装好了没"重新变回人眼判断。
