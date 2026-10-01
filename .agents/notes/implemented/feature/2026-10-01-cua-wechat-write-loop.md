# Agent Note: CUA 驱动微信写侧闭环（无 RDP、无第二账号）

Status: implemented

## Problem

机器人要"像人一样在微信里说话"，只有两条路：官方 iLink 通道（纯 HTTPS，**只能回复**，每条出站都消耗入站带来的 `context_token`）与个人号桌面自动化。个人号这条路此前靠 RDPWrap 造出的**第二个交互式 Windows 会话**（`cwinprobe` 账号 + 常驻 mstsc + 保活/重连/远控守卫 + 文件队列 + 10 个配方），代价是一整套重依赖：跨账号杀不掉进程、会话号漂移、控制台弹窗、明文密码，以及"客户端一最小化就发不出去"。

用户的要求是**彻底移除 RDP**。此前我判过"不可行"（[Cua 作为驱动面](../../proposed/architecture/2026-09-30-cua-as-drive-surface.md) §5），依据是 0.3.2 版本上"三种输入方式全部投递成功但不生效"。那个判断**建立在错误的前提上**：这台机器装的是 0.3.2，而当前发布线是 0.31.0。

## Decision

### 1. 结论：写侧闭环成立，不需要 RDP、不需要第二账号、不需要提权

升级到 **Cua Driver 0.31.0** 后，在用户自己的桌面会话（session 2）上实测通过完整闭环：

```
window : pid=12920 id=25628362 minimized=false
open   : "Azzy"                                  ← 目标会话未打开
  open    route=global_input mode=foreground     ← 前台点击切换会话（唯一的焦点成本）
  type    route=accessibility mode=background effect=confirmed
  return  route=synthetic_events mode=background
ok     : true
verify : preview row: "CUA-MODULE-ESCALATED-132422"
now open: "文件传输助手"
elapsed: 38 s
```

截图与树双重确认：消息进了聊天（气泡 + 时间戳），会话行预览同步更新，输入框清空。

### 2. 抢前台的真实代价：**每次"切换会话"一次，发送本身零成本**

三级阶梯实测（`scripts/wx-cua-select.js`）：

| 级别 | 手段 | 结果 |
|---|---|---|
| 1 | UIA Invoke（无障碍，后台） | 报 `✅ Performed UIA Invoke`，**窗口毫无变化** —— 与 2026-09-23 那次 mmui 按钮实测一致 |
| 2 | 选中行后 `press_key return`（PostMessage，后台） | 报 `📨 Sent return`，**同样无效** |
| 3 | `click delivery_mode:"foreground"`（SendInput） | ✅ **唯一有效的一级** |

因此成本模型是**结构性的、可预测的**：目标会话已打开 → 零成本；需要切换 → **一次短暂的前台点击**（实测总耗时 38 s，其中绝大部分是快照开销，点击本身是瞬时）。写入与发送都是后台（UIA ValuePattern + PostMessage），从不抢焦点。

### 3. 读侧：正文**可读**，方向**不可读**（此节 2026-10-01 第三轮纠正）

同一棵树上可寻址的东西：会话列表 16 行 `ListItem`（窄行，`300×78`，`对端 / 预览 / 时间 / 未读徽标`）、消息输入框 `Edit`（按对端命名）、以及**打开会话后的消息气泡**。

**我先前写过"消息正文读不到"，那是错的。** 实测：气泡是宽 `ListItem`（`722×68`），**`label` 就是消息文本**，按 `y` 排序即为有序消息列表：

```
y=176 w=722 "收到，RDP 重连后链路正常"
y=245 w=722 "[probe] s4 bridge after fg fix"
y=451 w=722 "9月18日 11:03"        ← 时间戳行，读的时候要剔除
```

**读不到的只有方向**：收发气泡都是同一个 List 的全宽子元素，树里没有对齐或角色区分。因此"这条是不是我发的"**只能靠回声账本判断，绝不能从元素上推断** —— 这是本设计里最容易搞错的一处，写进了 `readConversation()` 的注释。

两个后果：

- **能做的**：定位会话、判断"当前打开的是谁"、读出**有序的消息文本列表**（于是"用户连发三条"可以是三个事件，而不是一条预览事件 —— `deepRead` 模式用水印实现）、确认某条出站是否落在预览里。
- **不能做的**：逐条消息的方向与精确时间、媒体路径、跨会话历史。跨会话历史仍只有读库路径（WeFlow）。

结论：**写侧换 Cua（拆掉 RDP）；读侧单会话内已自足，跨会话历史仍需 WeFlow。**

### 3b. 媒体：**文件可发，图片不可发**（2026-10-01 实测）

| 动作 | 结果 |
|---|---|
| `clipboard_write({ file_path })` | ✅ `CF_HDROP`，`supported: true`，粘贴落地 |
| `clipboard_write({ image_path })` | ❌ **被拒绝**：`error_code: clipboard_unavailable`、`supported: false` |
| `clipboard_write({ text })` | ✅ `CF_UNICODETEXT` |
| `hotkey ["ctrl","v"]` + `background` | ❌ **修饰键丢失，打进字母 `v`** —— 这不是"较弱的粘贴"，是另一个动作 |
| `hotkey ["ctrl","v"]` + `foreground` | ✅ SendInput，对象真的进 composer |

真机端到端：文件 → 剪贴板 → 前台 Ctrl+V → composer 出现对象（UIA 值里的 `U+FFFC`）→ 回车 → 会话出现 `文件\ncua-file-probe2.txt\n29B`。

**成本**：粘贴必须前台（`focusCosts: ["paste:foreground"]`），切换到未打开的会话再加一次前台点击。

**两条踩出来的规矩**

1. **粘贴一律前台**：后台路径会把字母 `v` 打进输入框。
2. **验证按内容，不按条数**：会话列表会滚动 —— 真机上文件明明发出去了（最后一条就是文件气泡），消息条数却从 6 降到 5，用计数判断会得到**假失败**。

**不可用的部分要说清楚**：图片发送在此构建上不是"还没调好"，而是**驱动拒绝把图片放进剪贴板**，所以这条路根本不存在。要发图只能走文件路径（对方收到的是文件，不是图片）。这条一旦上游修复，`sendMedia({ imagePath })` 就会自动开始工作（它已经支持该参数并会如实返回拒绝原因）。

### 4. 0.31.0 的接口变化（踩过的坑）

- `element_index` 被 **`element_token`** 取代，且 token **属于某一次快照**；一次 CLI 调用一个进程一个会话，所以"快照→动作"必须在**同一个 `session` 标签内**完成，否则 `stale_element_token`。
- 元素字段是 **`label`**（0.3.x 是 `name`）。
- 响应区分**投递**与**生效**：`route` / `effect` / `verified` / `refusal.code` / `escalation`。`✅` 只表示投递成功。本模块的 `outcome()` 保留这个区分，不把"投递"洗成"生效"。
- **拒绝是精确的，不是模糊的**：多传一个它不认识的参数（例如把 `findWeChatWindow` 返回的对象连 `bounds` 一起 spread 进去）会得到 `invalid_arguments: type_text: unknown argument bounds`，而不是静默失败。所以所有驱动调用都经过 `toTarget()` 白名单。

### 5. 闭环（2026-10-01 第二轮补全）

- **入站源**（`src/integrations/wechat-cua/inbound.js`）：读会话行 → 解析出 `对端 / 预览 / 时间 / 未读数` → 与上一拍比较得出事件。规则明确写死：首拍只建基线不回放、纯重排不算新消息、未读徽标是更强信号、允许名单外的对端一律忽略。行与气泡按**几何**区分（行窄 `~300`、气泡宽 `~722`），因为"含换行"不足以区分——预览本身可以带换行，混起来会把消息归给错误对端。
- **深度读会话**（`deepRead`）：行变化时打开该会话，按 `y` 读有序消息列表，用**每对端水印**（记住最后读到的消息文本）只发出新消息。这样"连发三条"是三个事件而不是一条被坍缩的预览。代价是打开会话要一次前台点击，所以默认关闭、按需开启。
- **回声账本**（`SentLedger`）：这是**本设计最危险的失败模式**的闸门 —— 出站改变会话行 → 行变化就是入站信号 → 机器人自问自答。账本按对端记住"我刚发过什么"，`runLoop` 默认启用。RDP 时代的部署踩过同一个坑并用账本解决，UIA 读者信息更少，闸门只能更严。
- **循环**（`src/integrations/wechat-cua/loop.js`）：`runOnce` 是单回合（读 → 决策 → 发 → 验证），`runLoop` 是常驻轮询；两端都可注入，因此能在不碰微信的情况下被测试，也能在真机上跑。

### 6. 接入机器人本体（2026-10-01 第七、八轮）

| 半边 | 位置 | 开关 | 默认 |
|---|---|---|---|
| 出站 | `provider === "wechat-cua"` → `sendWeChatCuaText`（契约与桥对等） | `CYBERBOSS_ENABLE_WECHAT_CUA` | 关 |
| 入站 | `WeChatCuaInboxSource` → **复用** `handleWeFlowInboxMessage`（同一回合管线） | `CYBERBOSS_ENABLE_WECHAT_CUA_INBOX`（须 `mode=start`） | 关 |

talker 是 wxid 而会话行按**显示名**标注，所以映射必须显式给（`CYBERBOSS_CUA_CHAT_BY_TALKER="wxid=显示名,..."`）；**没有映射就硬失败**，绝不回退猜测 —— 发错人是这里最严重的失败。

**空允许名单 = 谁都不回**（`CYBERBOSS_WECHAT_CUA_ALLOW_PEERS`）：`PreviewInboundSource` 把 `null` 当作"不限制"，所以空名单会被换成一个永不匹配的哨兵值。这条是接线自检抓出来的漏洞，不是读代码读出来的。

**冒烟实测**（安全配置：允许名单=`微信团队`，永不触发回合）：

```
[cyberboss] cua inbox enabled pollMs=3000 deepRead=false peers=["微信团队"]
```

机器人带两端启动成功、运行 40 秒无异常、**没有发出任何东西**（会话逐条核对过）。

**顺带查清的既有运维问题**：`.env` 的 `CYBERBOSS_WEFLOW_BASE_URL=http://127.0.0.1:5051`，而 WeFlow 现在监听 **5031**（`/api/v1/health` → 200）。表现为日志刷 `WeFlow push/outgoing poll failed: fetch failed` 与 deferred 补发失败。实测 `deferred-system-replies.json` **0 条**，所以没有积压误发风险；但这说明"读侧端口"与配置不一致，切换前必须对齐（或按纯 CUA 配置把 `CYBERBOSS_ENABLE_WEFLOW_INBOX=false`）。

## Verification

- 离线：`test/wechat-cua-client.test.js` 7/7（写侧：已打开零成本、只在后台级失败后升级且用最新 token、点了没变化不算切换、以预览行验证发送、文字没落地绝不按回车、投递≠生效、搜索框不被误认为消息框）；`test/wechat-cua-inbound.test.js` 7/7（读侧：解析、首拍不回放、回声抑制、允许名单、未读徽标、纯重排、账本防自答）。
- 真机（`scripts/cua-wechat-loop-live.js`）：
  ```
  read   : 8 conversation row(s) via Cua
  baseline: primed with 8 peer(s); events emitted = 0 (must be 0)
  send   : action=sent verify=preview row: "CUA-LOOP-053403-OUT"
           open   {"cost":"none","route":"already-open"}
           type   {"route":"accessibility","mode":"background","effect":"confirmed","landed":true}
           return {"route":"synthetic_events","mode":"background","escalation":"foreground"}
  VERDICT: closed loop OK (read -> decide -> send -> verify)
  ```
- 真机（`scripts/cua-wechat-reader-live.js`，故意关闭回声抑制以证明读取器真的能感知变化）：
  ```
  primed : 8 peer(s), events=0
  send   : sent verify=preview row: "READER-PROBE-053456"
  observed: 1 event(s) -> {"peer":"文件传输助手","text":"READER-PROBE-053456","confidence":"preview-changed"}
  stable  : 0 event(s) on the next poll (must be 0)
  VERDICT: reader observes row changes exactly once
  ```
- 清理纪律：所有探针默认发完即清空输入框、`--dry` 只打字不发送；真发目标固定为 `文件传输助手`（自己给自己）。探针文本形如 `CUA-LOOP-053403-OUT`，便于事后辨认与清理。

## Consequences

**收益**

- 写侧不再需要：第二个 Windows 账号、常驻 mstsc、保活/重连/远控守卫、文件队列与队列工人、`cwinprobe` 的密码、跨账号进程身份判据。这些是 [RDPWrap 隔离会话部署契约](../../implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md) 里几乎所有失败模式的来源。
- 读侧（会话定位、当前会话判定、出站确认、入站事件）在**最小化甚至屏幕外**的窗口上都可用，且零抢焦点。
- 失败信号是结构化的：`refusal.code`、`effect`、`escalation` 让"投递了但没生效"第一次可以被代码区分，而不是靠看日志猜。
- **闭环可以在没有读库器的情况下闭合**：入站靠会话行预览，出站靠 UIA 写入 + 回车，验证靠预览行。

**代价与边界**

- **每次切换会话有一次前台点击。** 这意味着"机器人发消息时你的桌面会被短暂占用"。缓解手段是已有的空闲门槛（`MIN_CANARY_DESKTOP_IDLE_SECONDS`）与节流，但**这条成本消不掉** —— 除非微信将来暴露可用的后台选中通路。
- **入站的方向不可读。** 消息文本可读（见 §3），但收发不分，回声归因只能靠"文本前缀匹配 + 时间窗"的账本，比读库账本弱：如果用户恰好发来与我们刚发出**完全相同**的文本，会被账本误吞。这是本设计已知的、无法从 UIA 消除的边界。
- **跨会话历史仍需读库器。** 单会话内可以读到有序消息，但没有历史回放、没有媒体路径、没有跨会话检索。WeFlow 目前在本机报 `-101` 拒绝引导（API `/health` 200、`/messages` 500），且在 5031 而非 `.env` 配的 5051 —— 怀疑那份是给退役 Ally 栈配的实例，未解决。
- **单次操作约 16–38 秒**（大部分是快照与睡眠），比原来的 UIA 桥慢。出站排队/节流策略要按这个量级设计。
- **依赖个人版 Cua Driver 的接口稳定性**：0.3.2 → 0.31.0 就发生了 `element_index` → `element_token` 这类破坏性变化。模块里所有驱动交互都收敛在 `src/integrations/wechat-cua/client.js`，升级时只改这一处。
- **尚未接入机器人本体**：闭环是独立可跑的（模块 + 脚本 + 测试），还没有替换 `weflow-outbound` 的发送路径，也没有把入站源接进 `pending-inbound-store` 那条回合管线。接入前要决定 `provider` 路由（`weflow-uia` 与新通道）如何共存，以及读侧"预览 vs 完整正文"的降级语义。
- **WeFlow 读侧当前不可用（2026-10-01 实测）**：把它搬到交互会话后，`wcdb.log` 每 ~7 秒报 `[bootstrap] native runtime policy mismatch value=-101`，API `/health` 200 而 `/messages` 500 —— 与笔记里 `-105` 那次同族（锚点状态），重建锚点无效。它在 **5031** 监听而非 `.env` 配的 5051，怀疑这一份是给退役的 Ally 栈配置的实例。这条是"读正文"的唯一途径，仍未解决。

## Alternatives considered

- **回到 RDPWrap（把 session 3 重建起来）。** 最强理由：它是经过数月实战的形态，所有失败模式都有现成的看门狗与配方；而且它的防抢占是**结构性**的（驱动面在另一个桌面，用户的桌面物理上不参与），本方案只是"一次点击"级别的近似。否决原因是用户明确要求移除，且它的代价清单（第二账号、密码、跨账号身份、会话漂移、控制台弹窗、队列工人自愈导致的"杀了又活"）已经反复咬人 —— 本轮拆机时就再次被咬：跨账号杀不掉进程，只能把脚本丢进队列让工人自己执行。
- **把 Cua daemon 装进隔离会话，读写入都换 Cua（保留 RDP 但换驱动面）。** 最强理由：既拿到 Cua 的读能力，又保留结构性防抢占；命名管道同 SID 问题也可通过让 daemon 跑在隔离会话内绕开。否决原因是它保留了整套重依赖，而用户的目标恰恰是删掉它们 —— 收益（更好的读）可以由"读侧留 WeFlow"以更低成本拿到。
- **只做提权：把 Cua 的前台路径换成 UIAccess 助手。** 最强理由：官方文档把 UIAccess 描述为前台升级的正规做法。否决原因是**实测它不需要** —— `delivery_mode:"foreground"` 用 SendInput 直接生效；而且助手在本机历史上因未签名而根本无法启动，为一个非必需的组件引入"能向提权进程注入输入"的边界不划算。
- **只保留官方 iLink 通道，彻底放弃个人号自动化。** 最强理由：零 GUI 依赖、零抢焦点、迁移成本最低，而且这次的经验表明个人号自动化每换一层实现都要重学一遍客户端脾气。否决原因是官方通道**只能回复**（主动发起、check-in、提醒都做不到），而这是本项目一半的价值；且本轮已经证明写侧可以在没有 RDP 的前提下成立。
- **用 `set_value` 直接写消息框并找一个"发送"按钮 invoke 掉，完全避开键盘。** 最强理由：纯 UIA 语义路径，理论上不需要前台也不需要 SendInput，是最干净的形态。否决原因是实测消息框是自绘 `Group`（`chat_input_field.qt_scrollarea_viewport`），`set_value` 报告 `✅ Set AXValue` 而值仍是空的；发送按钮同理。微信只接受真的到达窗口的输入。
