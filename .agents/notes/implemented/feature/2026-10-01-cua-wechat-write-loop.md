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

因此成本模型是**结构性的、可预测的**：目标会话已打开 → 零成本；需要切换 → **一次前台激活**。写入与发送都是后台（UIA ValuePattern + PostMessage），从不抢焦点。

**2026-10-01 第十二轮把"一次前台点击"量成了数字与边界**（50ms 采样 `GetForegroundWindow`，探针 `scripts/cua-wechat-foreground-live.js`）：

| 路径 | 切换成功？ | 前台代价 |
|---|---|---|
| 后台/无障碍点击会话行（含带 `capture_id` 的像素点击） | **否**（客户端直接忽略） | **零** |
| 搜索框：后台 `set_value` 写入 + 把回车投给搜索框元素 | **否**（客户端不拿 UIA 写值当过滤输入） | **零** |
| `delivery_mode:"foreground"` 点击会话行 | **是** | **150–300ms 瞬时激活**，随后焦点自动归还 |

三次采样 151 / 313 / 252ms，采样序列形如 `35688 → 20384 → 35688`。**结论：这个客户端上做不到"完全零前台的切换"**——两条免点击候选都是"零前台但切不动"，而能切的那条必然短暂夺走前台（若用户此刻正在打字，那 150–300ms 的击键可能被投给微信）。方法上有一条硬教训：判断抢占必须高频采样，只在动作前后各采一次会得出"没抢"的错误结论（第一版守卫就是这么被骗的）。

**另一条零成本路径：会话恰好已打开时，方向白拿。** `PreviewInboundSource.readOpenConversation()` 在 `deepRead=false` 时也会检查"变化的对端是不是当前打开的会话"，是则用一次后台快照读气泡方向（无点击、无焦点变化）。生产已上线并抓到证据：`cua inbox stats … directionFree=1 selfManual=6`。

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

### 7. 驱动会话**有生命周期**，会悄悄死掉（2026-10-01 第九轮）

不是读文档读出来的，是环境自己撞出来的：一小时前用过的标签再次调用时，驱动回了一句

```
session has ended; tool call 'list_windows' was rejected. Call start_session with
session '<label>' to start it again, or use a new session label.
```

实测这条拒绝的形状（0.31.0）：**退出码 1、stdout 为空、这句话在 stderr 上**；对同一标签调 `start_session` 得到 `revived: true`，随后调用恢复正常。`end_session` 可复现同一状态。

这暴露两个独立缺陷，都在 `CuaSession`：

1. **失败不可读**：原来的 `call()` 只读 `error.stdout`，而这句话在 stderr 上 —— 于是"会话死了"和"驱动什么都没说"在日志里长得一模一样（`reason: "refused"`、`detail: undefined`）。修：先 stdout 后 stderr；`outcome()` 认这句话为 `session-ended` 并带上退出码。
2. **会长久失声**：入站轮询的会话是**按进程**建的（`cyberboss-inbox-<pid>`），要连续跑几小时。会话一死，之后每一次调用都被拒 —— 机器人还在跑，但永远不再回消息，而且看不出为什么。修：`call()` 认出这句话后 `start_session` 一次并**重放被拒的调用一次**。

重放是安全的，理由不是"重试通常没事"，而是**驱动是拒绝执行而不是执行后报错**——被拒的 `type_text` 一个字符都没打进去。且只重放一次，所以真正死掉的驱动不会变成无限重试。

为了让这段逻辑能离线验证，`CuaSession` 多了 `exec` 注入缝（默认仍是 `execFileSync`），测试可以复现"退出码 1 + stdout 空 + stderr 带这句话"的真实契约。

### 8. 第一次完整真机回合：四处"静默丢失"（2026-10-01 第十轮）

跑通一次真实入站 → 模型回合 → CUA 回复，暴露出四个**互相独立**的缺陷。它们都是"看起来在跑、其实没送到"的类型，只有真机回合能抓出来：

1. **入站信封的 senderId 曾是空串**。CUA 回复目标写成 `{userId: ""}` 是把它当"没有 wxid"的占位符，可同一个字段也是消息的 `senderId`，而 `PendingInboundStore` 要求它非空 —— 真消息被判 `invalid pending inbound message`，只留一行 warn，用户永远收不到回答。现在身份由 `resolveLocalInboxIdentity()` 统一决定：UIA 路径用**会话显示名**，官方通道用 replyUserId，**空值直接抛错**（在还能看见原因的地方失败）。
2. **回复被路由回官方 iLink**。`applyWeFlowReplyRoute()` 只把 `weflow-uia` 抄进 payload，其它 provider 一律丢弃 → `wechat-cua` 的回复带着微信显示名打到 iLink API：`sendMessage ret=-3 errmsg=invalid arguments`。回合跑完、答案存在、就是没送到。现在路由白名单是 `{weflow-uia, wechat-cua}`；`resolveReplyTargetForBinding()` 也不再对所有 binding 硬编码 `weixin`，而是按 id 形状选通道（`@im.wechat` → 官方，其余 → 本地桌面路径）。
3. **token 的失效规则不是"超时"**。实测（`scripts/cua-wechat-token-live.js`）：token **不会随时间过期**（空闲 8 秒仍然可用），但**任何后续快照都会让它失效 —— 自己的会话、别的会话、别的进程都一样**。驱动每个窗口只保留**一个当前快照**。于是发送阶梯必须"被拒 → 重新快照 → 用新 token 重试"，拿旧 token 重试等于必然再被拒一次。按回车那一步有额外闸门：**只有文本还在输入框里才补按**，框空了就交给回读判定 —— 盲按会发第二条。
4. **窗口最小化会让写侧整体失效**（读侧照常）。表现极具误导性：拒绝码是 `stale_element_token`，真正的原因藏在 `window_minimized`。现在被拒时若判定为最小化，先 `bring_to_front` 一次再重试（只在失败路径付一次前台激活）。另外 `daemon is not running on \\.\pipe\cua-driver` 会在守护进程**活着并服务其它调用者**时出现（两个 `cua-driver call` 抢管道），它是传输层失败、请求根本没到，所以重试一次是安全的。

顺带补上的安全策略：**输入框里不是我们写的字就不碰**（人工可能在打字），只清理**本进程自己**留下的未发出文本，并把新消息留在框里的事实写进 step 记录，避免"一次按回车被拒 = 机器人从此哑掉"。

### 8b. 最小化窗口下的**发送**同样要自愈（2026-10-04 实测事故）

§8 第 4 条提到"最小化会让写侧整体失效"，当时的修法只加在**打字**那一步：被拒 → 判定最小化 →
`bring_to_front` 一次 → 重试。**发送（按回车）那一步没有做同样的事**，于是留下了一个能让人彻底
收不到回复的坑，2026-10-04 真的踩了：

- 现象：用户问"为什么没回复 azzy"，而且**消息还卡在聊天框**；
- 实读微信：会话列表行是 `Azzy\n[草稿]\n…`，输入框里躺着 51 个字——那是机器人几小时前的回复；
- 因果链：回复文字**打进去了**（打字那步自愈成功或当时窗口正常），按回车时窗口在任务栏 →
  `window_minimized` 拒绝 → 发送那一步没有恢复窗口、直接返回 `ok:false`，
  **文字就留在框里变成微信草稿**；之后每次给这个会话发送都撞上"框里有未发出文本"的守卫
  （那条守卫本意是保护人工输入），于是**这个人的通道彻底哑掉**，日志里只有一行
  `refusing to type over`。

修法：发送被 `window_minimized` 拒绝时，走和打字同一条自愈路径——`restoreMinimized`
（SW_SHOWNOACTIVATE，不抢前台）→ 重新快照 → 文本仍在框里才补按回车；
恢复失败时保持 `certainNotSent: true`，让上层按"确定没发出"去重试而不是丢弃。
新增 step `unminimize-send`，这样运维从 `steps` 里一眼能看出这次发送付过恢复代价。

回归测试 `test/wechat-cua-minimized-send.test.js`（注入式 session，不需要桌面）：
被拒一次 → 恰好恢复一次并发出；恢复不了 → `ok:false` 且 `certainNotSent:true`。

运维兜底：`scripts/cua-rescue-draft.js <聊天> [--send|--clear|--text …]`
——读输入框里到底有什么、把卡住的草稿发出去、或清掉它。这次就是靠它把那条 51 字的回复送出去的。

### 9. 方向**可读**了：靠像素，不靠猜（2026-10-01 第十一轮）

§3 说"方向不可读"是**只测了 `文件传输助手`** —— 一个自己跟自己说话的会话，左右两边本来就不分。这一轮在真实的 1:1 会话（柳毓琳、Azzy）上重测：

- UIA 树**确实没有方向**：对方发的 `hi` 和自己发的 `处理中` 都是 `frame={x:785,w:722}` 的 ListItem，role/actions 完全一样。这条旧结论成立。
- **但截图有**：本账号发出的消息是**绿底气泡、头像在右**，对方发来的是**白底气泡、头像在左**。截图就在每次 `get_window_state` 的返回里（`screenshot_png_b64`），元素还自带 `screenshot_frame`（截图坐标系，可直接索引）。

于是新增 `src/integrations/wechat-cua/pixels.js`：自带 PNG 解码（node `zlib`，~80 行，不引第三方图像库），按气泡区域采样判方向。**两个坑都是实测踩出来的**：

1. **颜色不是"微信绿"**。采样实测本客户端的气泡是 **(152,240,152)**，不是通常引用的 `#95EC69` (149,236,105)。按后者做"颜色 ± 容差"匹配时，蓝色通道差 47 卡在容差边缘，绿气泡的 green share 只有 0.004 —— **每一条自己发的消息都被判成对方发的**。改成色相判据（绿通道够亮且明显高于红蓝）后，旧的 `#95EC69` 也能通过。
2. **别采头像**。气泡行横跨整个消息区，两端是头像（对方在左、自己在右）。采样带取行宽的 35%–90%，把头像排除在外。

实测分离度：对方侧 0.000 / 0.000，自己侧 0.119 / 0.224 / 0.316 / 0.423，阈值 0.05 落在空档里。真机复核（`scripts/cua-wechat-directions-live.js`）与肉眼看到的截图逐条一致。

**由此得到的判定规则**（`PreviewInboundSource`）：

| 观测 | 结论 |
|---|---|
| 白气泡 | 对方发来的用户消息 → 进回合 |
| 绿气泡 + 账本认识 | 我们自己发的回声 → 丢弃 |
| 绿气泡 + 账本不认识 | **同一账号的人发的**（本机手打，或该账号在别的设备上发）→ 记为 `origin: self_manual`，不当作对端的消息回 |
| 读不到（无截图/无 frame） | `unknown` → 退回账本判定，**绝不默认成"对方发的"** |

第三条正是用户要的"同账号消息也要入账"；而第二条让"机器人重启后账本为空"这个真实缺口消失了 —— 以前重启后自己的消息会被当成新消息回一遍，现在方向本身就能挡住。

代价说明：方向只有**读气泡**才拿得到。会话恰好已打开时，读它是**零成本**的（`readOpenConversation()`，一次后台快照，生产已抓到 `directionFree` 正向变化）；会话没打开时，`deepRead` 才会为了方向付一次前台激活——所以生产把它关着，用"机会式方向 + 回声账本"。

### 10. "安静地聋掉"：驱动进程会死，而旧读者把死当成"没有新消息"（2026-10-01 第十二轮）

驱动守护进程今天自己死过一次（`status` 从 running 变成 not running，所有调用回
`Cua Driver daemon is not running on \\.\pipe\cua-driver`）。真正的麻烦不是它死了，而是**死得看不出来**：

`readRows()` 拿到失败的快照后，`elements(snap)` 返回空数组 → 每一拍都是"会话列表里没有行" →
没有事件、没有错误、没有日志。机器人进程活着、心跳正常、**听不见任何东西**。

三处修改：

1. **失败必须响亮**：`readRows()` 现在检查 `snap.__failed` 并抛错（`cua snapshot failed: …`），
   不再让"读不到"和"空列表"长得一样。
2. **能自愈就自愈**：`src/integrations/wechat-cua/daemon.js` 提供 `driverStatus()` /
   `ensureDriverRunning()`——先看 `cua-driver status`，必要时走**驱动自己的** `autostart kick`
   拉起注册项，注册项不可用时才 `serve` 分离启动。这不是机器人自己发明提权：`autostart enable`
   本来就是给守护进程准备的开机项。
3. **自愈要克制、要出声**：`WeChatCuaInboxSource` 连续失败到阈值（默认 3 次）才尝试一次，随后
   60 秒冷却（不会变成重启风暴）；拉起成功时警告里写明"在此之前它听不见"；拉不起来则用
   `error` 级别直说 **DEAF** 并给出修复命令。读成功后连续失败计数清零，下一次故障照常上报。
   非驱动故障（比如"看不到微信窗口"）只报告，不去重启驱动——那只会在错误的层面折腾。

另外把这条通道接进了 `doctor`（此前**完全没有**覆盖）：`probeWeChatCua()` 按真正会坏的顺序检查
——守护进程在不在 → 微信窗口在不在（最小化单独报 `window-minimized`，因为读得了、写必失败）→
允许名单是不是空的（空=谁都不回）→ 每个允许对端有没有会话映射（缺映射发送会硬失败）。
实测：生产配置下 `doctor` 输出 `ilink` ready、`wechat-cua` ready、`notReady` 为空。

### 11. 确定性失败 → 延迟 → 补发：闭环有了三件证据，也露出两个哑巴故障（2026-10-02 第十三轮）

需求是"不能抢前台，也不能因此丢回复"。做法是：CUA 确信没发出去（`deliveryUncertain === false`，
例如"这个会话没打开且不允许切前台"）时**先入延迟队列、再记失败**，等会话回到前台后由重试闸门补发。
这一轮把三件证据一次性攒齐（脚本：`tmp/exp6-driver.js`，自己动手切换会话并打时间戳，其余时间只旁观）：

| 证据 | 实测 |
| --- | --- |
| ① 延迟入账（直接读 `~/.cyberboss/deferred-system-replies.json`） | `senderId: "文件传输助手"`、`provider: "wechat-cua"`、`attemptCount: 0`、`lastError: "\"文件传输助手\" is not the open conversation and foreground switching is disabled (CYBERBOSS_WECHAT_CUA_NO_FOREGROUND_SWITCH); the reply should be deferred rather than stealing the foreground"` |
| ② 全程零前台 | 50ms 采样 724 次（实测周期 73ms）：`transitions` 只有一条 `pid 0`（采样起点，无前台窗口），**对微信 pid 的转换为 0**；`unattributedWeChatTransitions: []` |
| ③ 恢复会话后补发 | 日志 `deferred retry delivered sender=文件传输助手 count=1`，且全程无 `invalid arguments`（上一次同类 bug 是把补发打到官方 iLink） |

时间线（同一轮）：ack `11:21:29` → 切走 `11:21:39`（本次点击 1 次成功）→ 延迟入账 `11:21:51` → 采样停
`11:22:34` → 切回 `11:22:46` → 补发成功 `11:23:25`。

这一轮同时暴露两个**不报错的故障**，都已修：

1. **"按了回车"≠"发出去了"**。不带 delivery mode 的 `press_key` 会被驱动回答
   `✅ Sent return via SendInput`，而文字还留在输入框里；同一时刻改 `delivery_mode:"foreground"`
   立刻发出（连续两次实测）。修法：发送的判据只认**输入框是否为空 + 预览行是否有这段话**，
   框里还有原文就再用前台模式补按一次，框已空则绝不重按（重按=发第二条）。
2. **义务账本把 CUA 行读成旧桥**。`reply-obligations.json` 的读回归一化里写死了
   `sourceProvider: "weflow-uia"`，于是 CUA 义务重载后全部改姓"已经不能发信的通道"（当天 13 条
   CUA 义务无一例外）。这是同一族 provider 硬编码的第六处，修法是保留写入时的 provider。

### 12. 交接后操作者的两条抱怨：焦点不还、处理中太慢（2026-10-02 第十四轮）

原话：「还是没有将原始焦点还原」「"处理中"回复过慢不是第一时间回复的」。两条**共用同一个根因**，都是量出来的：

**根因一：每次驱动调用 1.5–2.0s。** `cua-driver call` 每次都起一个新进程（各 4 次实测：`list_windows` 1495/1587/1593/1607ms，`get_window_state` 1540/2032/1676/1620ms），而一次发送要 4–6 次调用、一次切换要 ~5 次。`cua-driver mcp` 是一条常驻 stdio 连接，同样的调用实测 164/179/150/144ms 与 155/146/141ms —— **差 10 倍**。新增 `mcp-transport.js`（worker 线程持有 mcp 子进程，主线程用 `receiveMessageOnPort` 同步取回，客户端的同步 API 一行没改）+ `mcp-transport-worker.js`（把 MCP 回答映射回 `cua-driver call` 打印的形状，refusal 仍落在 `payload.refusal.code`）。它是**优化不是依赖**：任何异常都退回 CLI 并冷却 120s，`CYBERBOSS_CUA_MCP_TRANSPORT=0` 可关。实测 `findWeChatWindow` 33.7s → 0.67s、`currentConversation` 1.8s → 0.22s。

**根因二：发送走的是"抢了不还"的那条路。** 50ms 采样、把 chrome(12744) 停在最前，四条路都量了：

| 发送方式 | 发出去了吗 | 前台代价 |
| --- | --- | --- |
| `press_key return`（无 delivery mode，PostMessage） | **没有**（微信忽略；驱动回答"✅ 已发送"） | 零 |
| `press_key return delivery_mode=foreground`（SendInput） | 发出去了 | **抢走且不还**：全程 10544ms，采样结束时微信仍在前台 |
| 点击 UIA 树里的 `Button "发送"`（前台点击） | 发出去了 | 124ms 后归还，但单次调用 ~1.9s |
| **`type_text "\n"`（前台）** | 发出去了 | **146ms 的单次调用，微信只在前台 125ms** |

于是发送主路径改成"后台写值 + 一次前台换行"，点 `发送` 按钮作为重试梯级（微信可被配置成 Ctrl+Enter 发送，那时换行只是插入换行符：输入框仍留着 `text\n`，`sendVerdict` 因此容忍结尾换行，`send-again` 跳过换行改点按钮），没有按钮时才退回前台回车。**那个"报了成功却没发出去"的模式彻底不用了。**

**顺带修掉的两处：**
- **最小化不再是死路**：旧策略是"拒绝 + 延迟"（因为当时只知道 `bring_to_front` 能恢复、而它会一直留在前台）。实测 `ShowWindow(SW_SHOWNOACTIVATE)` 恢复窗口后**前台 pid 不变**（两次），于是改成"静默恢复后继续发送"。之前操作者把微信最小化过一次，整个通道哑掉：处理中和回复都发不出去。
- **"处理中"的两段延迟都砍了**：读会话轮询 3000ms → 1500ms（新增 `CYBERBOSS_WECHAT_CUA_POLL_MS`）；发送阶梯里的固定 sleep 600/1500 → 80/250ms（UIA 写入本来就是同步确认的，这些只是等重绘）；`ensureConversation` 把自己的快照一起返回，发送路径不再多读一次窗口（省一次调用，也避免刚拿到的 token 被自己下一次读作废）。每个 step 现在都带 `ms`，`inbound acknowledged` 日志也带 `latencyMs`/`sendMs` —— 以后不用再猜。

**更正（重要）：§11 里"会话全程零前台、724 次采样"那条证据是无效的。** 采样脚本的 `Add-Type -MemberDefinition '...'` 多了一个 `]`，类型注册失败后每一拍都写 `0`，而"永远 0"看起来和"前台从未动过"一模一样 —— 我据此下了结论。修正后的采样器（去掉那个 `]`）才是本节的数字来源：一次切换 126ms、一次发送 190ms（按钮路径）/125ms（换行路径），**两次都归还焦点**；整段 70 秒窗口里微信累计只在前台 506ms，且每次都由驱动主动归还。这个坑已写进 `docs/wechat-cua-channel.md`。

## Verification

- 离线（本轮新增，反证都做过）：`test/wechat-cua-client.test.js` 14/14（+ "驱动说发了、框里还在 → 前台补按一次"，且补按模式必须是 `foreground`）、`test/reply-obligation-store.test.js` 14/14（+ CUA 义务重载后仍姓 `wechat-cua`）、`test/stream-delivery.test.js` 38/38（+ CUA 目标按桌面 provider 路由、"确定失败才延迟"与"不确定绝不延迟"的正反两例）。删掉任一处修复，对应断言立刻红。

- 离线：`test/wechat-cua-session.test.js` 6/6（活会话零重放、会话死掉后复活并**恰好重放一次**、重放再失败就放弃、参数错误不赖会话、`start_session` 不自递归、stderr 拒绝在 `outcome()` 里可读）。**反证**：把恢复分支单独删掉（保留注入缝），该套件在第二条就红 —— 说明它真的在测这个缺陷，而不是恰好一起通过。
- 真机（`scripts/cua-wechat-session-live.js`，只读，不点击）：
  ```
  1. list_windows on a live session: 22 window(s)
  2. end_session -> {"active":false,...}
  3. after end_session, raw call -> failed=true reason=session-ended exit=1
  4. through CuaSession.call -> 22 window(s), revivals=1, revived=true
  5. WeChat visible after recovery: pid 12920, window 25628362
  PASS: an ended driver session is detected, revived once, and the refused call is repeated
  ```
- **真机完整回合（2026-10-01 15:29 / 15:37，本项目的验收标准）**：机器人带 `CYBERBOSS_ENABLE_WECHAT_CUA` + `..._INBOX` 跑在 worktree，允许名单只有 `文件传输助手`；用 `scripts/cua-wechat-inject-live.js` 往真实会话里注入一条**机器人没有账本记录的**行变化（在 UI 层等价于"从别处来了条新消息"），然后看它自己走完：
  ```
  inject : PASS: "CUA-E2E-153646 请用一句话回复：闭环成功，并附上你看到的这条消息的编号。" is now visible as an unexplained row change
  bot    : [cyberboss] dsh-acp resumed session 3e46ce89-... for window weflow:文件传输助手
  readback: y=600 "CUA-E2E-153646 请用一句话回复：闭环成功，并附上你看到的这条消息的编号。"
            y=691 "闭环成功，CUA-E2E-153646"      <- 模型回合的回答，由 CUA 写进真实微信
  ```
  日志里**没有** `failed to deliver reply`（修复前每一轮都有）。注入脚本自己也印证了重试逻辑：`type` 与 `return` 两步各被拒一次 `stale_element_token`，重新快照后通过。
- 离线（本轮新增）：`test/wechat-cua-liveness.test.js` 6/6（失败的快照必须抛错而不是空列表；连续失败到阈值才恢复且受冷却限制；非驱动故障只报告不重启驱动；`status`/`autostart kick`/`serve` 三级路径各有断言）、`test/doctor-probes.test.js` 12/12（+ wechat-cua 的驱动没起、窗口最小化、允许名单为空、缺映射、就绪五种判定）。
- 真机：`node bin/cyberboss.js doctor` 在生产配置下输出 `ilink` ready、`wechat-cua` ready、`notReady: []`，退出码 0。
- 离线：`test/wechat-cua-session.test.js` 7/7（+ 传输层失败重试一次且不算会话死亡）、`test/wechat-cua-client.test.js` 13/13（+ 被拒后从新快照重试、只补按一次回车、空框不补按、别人的草稿不覆盖、自己的残留先清、最小化先恢复）、`test/local-inbox-identity.test.js` 5/5（身份 + 回复通道路由）、`test/stream-delivery.test.js` 33/33（+ 普通回复必须带上来源通道的 provider）。每个新断言都做过**反证**：单独撤掉对应修复，测试立刻红。
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

- **每次切换会话有一次 150–300ms 的前台激活**（实测区间，非估计值）。这意味着"机器人发消息时你的桌面会被短暂占用几百毫秒、随后焦点自动归还"。两条免点击候选（后台/像素点击、搜索框）都已实测**切不动**，所以这条成本在当前客户端上**消不掉**；能做的只有减少切换次数（回复尽量落在已打开的会话上）与时刻盯住成本（`scripts/cua-wechat-foreground-live.js`，它会在测量无效时拒绝下结论）。
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
