# 微信个人号通道（Cua Driver）

这个仓库有两条渠道，彼此独立、都默认关闭：

| 渠道 | 是什么 | 需要什么 |
|---|---|---|
| **iLink 官方渠道** | 微信官方 bot 接口（HTTPS），只能回、不能主动发起 | `CYBERBOSS_ACCOUNT_ID`、context token |
| **个人号桌面通道** | 驱动**本机这个会话里**的微信客户端收发消息 | Cua Driver + 一个已登录的微信桌面客户端 |

个人号桌面通道有两个驱动：

- `weflow-uia` —— 旧方案：WeFlow 读 + UIA 桥写，桥要跑在**独立的 Windows 会话**里（历史上靠 RDPWrap + `mstsc` 环回 + 第二个账号维持）。
- `wechat-cua` —— **当前方案**：全部通过 [Cua Driver](https://github.com/trycua/cua) 完成，**不碰 RDP、不需要第二个账号、不需要提权**。

## 为什么换掉 RDP 那套

防"抢前台"的老办法是让机器人在另一个会话里操作另一个微信实例，代价是一整套环境：RDPWrap、第二个 Windows 账号、文件队列 worker、UIA 桥进程，任何一环坏掉整条通道就静默失效。Cua 直接驱动当前会话的窗口，代价只剩**每次切换会话一次前台点击**（发送本身零成本），换来的是"少四个组件"。

那套环境正在退场（十二个计划任务、RDPWrap 注册、`cwinprobe`、1.16 GB 临时数据），进度与残留见
`.agents/notes/implemented/process/2026-10-01-retire-rdp-isolated-session-stack.md`：Cua 通道不依赖其中任何一项。

## 环境变量

```ini
# 出站：用 Cua 发送（默认 off）
CYBERBOSS_ENABLE_WECHAT_CUA=true

# 入站：轮询会话列表（默认 off；需要 mode=start）
CYBERBOSS_ENABLE_WECHAT_CUA_INBOX=true

# 读整段对话而不是只读预览行（默认 off）
# 打开后每次读会话都要一次前台点击，所以有 20s 冷却
CYBERBOSS_WECHAT_CUA_INBOX_DEEP_READ=false

# 允许回应的对端：**显示名**，逗号分隔
# 留空 = 谁都不回（不是"谁都回"）
CYBERBOSS_WECHAT_CUA_ALLOW_PEERS=文件传输助手

# talker -> 会话显示名。**没有映射就硬失败**，绝不猜（发错人是这里最严重的失败）
CYBERBOSS_CUA_CHAT_BY_TALKER=文件传输助手=文件传输助手

# 可选：驱动路径（默认安装位置）
CUA_DRIVER=C:\Users\<you>\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe
```

Cua Driver 自身需要：0.31.0 或更新（`cua-driver status`），常驻守护进程（`cua-driver serve`，Windows 上可用 `cua-driver autostart enable` 开机拉起）。

## 成本模型（实测 2026-10-02，微信 4.x / Windows 11）

先说**每次驱动调用的固定成本**，它决定了下面所有数字：`cua-driver call` 每次都要起一个新进程，实测 **1.5–2.0s/次**；`cua-driver mcp` 是一条常驻 stdio 连接，**140–180ms/次**。客户端走 MCP（`src/integrations/wechat-cua/mcp-transport.js`，失败自动退回 CLI 并冷却），所以"一次发送 4–6 次调用"从 ~8s 变成 ~1s。这条差异是"处理中来得慢"和"切换时窗口停在前台久"两个抱怨的共同根因。

| 动作 | 代价 |
|---|---|
| 读会话列表 / 读消息 | 后台，零前台 |
| 写文字进输入框 | 后台（UIA 写值，`effect: confirmed`） |
| **发送**（点击输入框右侧的 `发送` 按钮，前台点击） | **约 120–190ms 瞬时激活，焦点自动归还** |
| 按回车发送（无 delivery mode） | 后台，但**微信直接忽略**：驱动回"✅ 已发送"，文字还在输入框 |
| 按回车发送（`foreground`） | 能发出去，但**焦点不归还**（实测 10.5s 后微信仍在前台）→ 已不再使用 |
| **切换会话** | **150–300ms 的瞬时前台激活**（既不是"点了就长期占用"，也不是"不抢"） |
| 发文件 | 粘贴必须前台，一次点击 |
| 发图片 | **做不到**：`clipboard_write({image_path})` 返回 `clipboard_unavailable` |
| 微信**被最小化** | 零前台自动恢复（`ShowWindow(SW_SHOWNOACTIVATE)`，前台 pid 不变）后继续发送 |

### 发送路径：三条都量过（2026-10-02，50ms 采样 `GetForegroundWindow`，停在最前的是 chrome 12744、微信 20384）

| 发送方式 | 发出去了吗 | 前台代价 |
|---|---|---|
| `press_key key=return`（无 delivery mode，PostMessage） | **没有**（微信忽略；驱动却报成功） | 零 |
| `press_key key=return delivery_mode=foreground`（SendInput） | 发出去了 | **抢走且不归还**：全程 10544ms，采样结束时微信仍在前台 |
| **点击 `发送` 按钮 `delivery_mode=foreground`** | 发出去了 | **190ms 后归还**（同一次运行里切换会话是 126ms 后归还，合计 311ms） |

所以发送改走 `发送` 按钮（UIA 树里的 `Button "发送"`），回车只作为"树里没有这个按钮"时的兜底 —— 且兜底也必须用 `foreground`，否则等于没发。

### 前台抢占：免点击候选都量过（2026-10-01）

| 路径 | 切换成功？ | 前台代价 |
|---|---|---|
| 后台/无障碍点击会话行（含带 `capture_id` 的像素点击） | **否**（客户端直接忽略） | **零** |
| 搜索框：后台 `set_value` 写入 + 把回车投给搜索框元素 | **否**（客户端不拿 UIA 写值当过滤输入） | **零** |
| `delivery_mode:"foreground"` 点击会话行 | **是** | **150–300ms**，之后焦点自动归还 |

采样原始序列（对照组，停在最前的是 PowerShell 35688、微信是 20384）：

```
14:25:16.237  35688
14:25:25.699  20384    <- 抢走了
14:25:25.850  35688    <- 151ms 后自己还回去
```

探针：`node scripts/cua-wechat-foreground-live.js foreground|px|search` —— 50ms 采样、会拒绝在"停放窗口从未失去前台"时下结论。

**注意采样器本身的坑**：`Add-Type -MemberDefinition '...'` 里多一个 `]` 就会让类型注册失败，于是每一拍都写 0 —— 看起来和"前台从未动过"一模一样。修正后的采样器在 `scripts/cua-wechat-foreground-live.js` 与 `tmp/focus-real.js`（后者是本次的对照实验）。

所以：**当前客户端上做不到"完全零前台"的切换。** 能保证的是"已打开的会话里发送只花 ~150ms 且归还焦点"与"读取零前台"；切换必须付一次约 150–300ms 的瞬时激活（若用户此刻正在打字，那 150ms 内的击键可能被投给微信——这是真实代价，不粉饰）。

方法上有一条硬教训：**判断"抢不抢前台"必须用高频采样**。只在动作前后各采一次会得出"没抢"的错误结论——我第一版守卫就是这么被骗过去的，151ms 正好落在两次采样之间。

### 最终成本模型（2026-10-02 收尾）

| 场景 | 前台代价 | 说明 |
|---|---|---|
| 读会话列表 / 读消息 | **零** | 后台 UIA 轮询（默认 1500ms 一拍，`CYBERBOSS_WECHAT_CUA_POLL_MS`） |
| 在**已打开**的会话里发送 | **~150ms 瞬时激活，焦点归还** | 后台写值 + 前台点 `发送` 按钮 |
| 方向判定（会话恰好已打开） | **零** | `readOpenConversation()`，一次后台快照 |
| 微信**被最小化**时 | **零** | `ShowWindow(SW_SHOWNOACTIVATE)` 恢复（不激活、不移动），随后照常发送 |
| **切换会话** | 150–300ms 瞬时激活（焦点归还） | 两条免点击候选实测都切不动；可用下面的开关彻底关掉 |

```ini
# 连那 150-300ms 也不要：目标会话没打开时不切换，改为延迟
CYBERBOSS_WECHAT_CUA_NO_FOREGROUND_SWITCH=true
# 读会话的轮询间隔（毫秒），越小"处理中"越快出现；默认 1500
CYBERBOSS_WECHAT_CUA_POLL_MS=1500
# 关掉 MCP 快速通道，退回每次起进程的 CLI（排查用）
CYBERBOSS_CUA_MCP_TRANSPORT=0
```

### 端到端实测（2026-10-02，操作者两条抱怨的收尾数字）

| 指标 | 修前 | 修后 |
|---|---|---|
| 「处理中」从消息可见到发出（外部计时） | 7331ms | **3710ms** |
| 其中：bot 自报 `latencyMs`（被读到 → 发出） | 7316ms | **2521ms** |
| 其中：`sendMs`（写路径本身） | ~4400ms | **2423ms** |
| 一次会话切换的前台占用 | 150–300ms | 121–129ms |
| 一次发送的前台占用 | **10544ms 且不归还** | 61–190ms，**每次都归还** |
| 70 秒窗口内微信累计前台时间 | 10544ms（一次连续占用） | **443ms（4 次，每次 60–130ms）** |

剩下的大头是**驱动每次调用 ~150ms × 5–8 次**，以及读轮询与写路径互相作废 token 造成的重试；下一步可做的是让读与写共用一把锁（同一窗口的 token 只被自己作废），而不是继续加固定 sleep。

打开后的代价必须一并说清：**机器人只在"目标会话已经是当前打开的那个"时才回复**，其余一律排进延迟队列，等会话被打开后再发。默认关。启动日志会明说当前策略：

```
[cyberboss] cua inbox enabled pollMs=3000 deepRead=false foregroundSwitch=on peers=[...]
```

## 谁发的？方向判定（2026-10-01 起可读）

UIA 树不告诉你方向：对方发的和自己发的都是同样宽、同样 role 的 ListItem。**截图告诉你** —— 本账号发出的是绿底气泡（头像在右），对方发来的是白底气泡（头像在左）。`src/integrations/wechat-cua/pixels.js` 自带 PNG 解码，按气泡区域采样判方向。

判定规则：

| 观测到 | 机器人怎么处理 |
|---|---|
| 白气泡 | 对端发来的用户消息 → 进入回合 |
| 绿气泡 + 回声账本认识这段文本 | 自己发的回声 → 丢弃（不自我回复） |
| 绿气泡 + 账本不认识 | 同账号的人发的（本机手打，或该账号在别的设备上发）→ 记为 `origin: self_manual` 入账，不当作对端消息回 |
| 读不到（截图缺失/frame 缺失） | `unknown` → 退回账本判定，绝不默认"对方发的" |

**要方向就得开 `CYBERBOSS_WECHAT_CUA_INBOX_DEEP_READ=true`**：方向只能从"打开的会话"的截图里读，而打开会话要一次前台点击。聊天列表那一行看不出方向，所以这是"确定性 vs 一次点击"的取舍；关闭时退回纯账本判定（旧行为）。

已实测的颜色坑：本客户端的气泡是 **(152,240,152)**，不是常引用的 `#95EC69`；按后者做颜色匹配会把**自己发的消息全判成对方发的**。代码用的是色相判据，两种绿都通过。采样带只取行宽的 35%–90%，避开两侧头像。

## 会踩的坑（都是真机量出来的）

1. **token 只活到下一次快照**。驱动每个窗口只保留一个当前快照，任何后续 `get_window_state`（自己的、别的会话的、别的进程的）都会让旧 token 失效；它**不会**随时间过期。所以"快照→动作"必须用最新快照，被拒就重新快照再试，拿旧 token 重试必然再被拒。
2. **窗口最小化 = 写侧全灭，读侧照常**，而拒绝码可能只显示 `stale_element_token`。当前策略是**拒绝而不抬窗**（抬窗只能靠 `bring_to_front`，它会一直留在前台，正是用户投诉过的"弹我窗口"），并把这次失败标记成"确定没发出去"，交给延迟补发。
3. **"发了回车"不等于"发出去了"**。实测（2026-10-02，连续两次）：不带 delivery mode 的 `press_key` 会返回 `✅ Sent return`，而文字**还留在输入框里**；同一时刻改用 `delivery_mode:"foreground"`（SendInput）立刻发出。所以发送的判据是**输入框空没空 + 预览行有没有这段话**，不是按键的返回；框里还有字就再按一次（前台模式），框已空就绝不重按（会发第二条）。
4. **驱动会话有生命周期**：`session has ended; tool call ... was rejected`（退出码 1，话在 stderr 上）。客户端会自动 `start_session` 复活并重放**被拒**的那一次调用（拒绝 = 没执行，所以重放是安全的）。
5. **两个 `cua-driver call` 抢管道**时，守护进程活着也会回 `daemon is not running`。这是传输层失败、请求没到，客户端会重试一次。
6. **输入框是"有主"的工作区**：不是机器人写的字绝不覆盖、不删除（可能有人在打字）；只清理本进程自己留下的未发出文本。
7. **方向不可读**：UIA 读到的气泡没有"谁发的"信息，入站判断依赖回声账本（`SentLedger`）。这是本设计最薄的一环，写在 `.agents/notes/implemented/feature/2026-10-01-cua-wechat-write-loop.md` 里，没有隐藏。
8. **身份是显示名不是 wxid**：所以 `CYBERBOSS_CUA_CHAT_BY_TALKER` 必须显式配置，绑定的 `senderId` 也是显示名。
9. **义务账本里也要认对 provider**：`reply-obligations.json` 的读回归一化曾经把每一行都写成 `weflow-uia`（包括 CUA 行），于是"谁欠一条回复"的账本指向一个不能发信的通道。第六处同族 bug，已修并有回归测试。
10. **补发内容不带官方通道的包装**：`上轮有一条回复当时没能发出去，现在补上。/===== 上轮对话遗留内容 =====` 是为"一条出站必须占用一次回复窗口"的官方通道准备的。这条通道没有窗口、随时能发，遗留内容就是一条普通回复 —— 格式器 `formatDeferredRepliesForRetry`（`src/core/app.js`）按批次来源分流，桌面类 provider 只拼正文。用户实测把这句通知引用回来过（2026-10-02）。

## 验收与自检

```sh
node bin/cyberboss.js doctor                       # 通道就绪检查（含 wechat-cua）
node scripts/cua-wechat-selftest.js              # 只读自检：守护进程、窗口、开关、映射
node scripts/cua-wechat-session-live.js          # 会话死后能否自愈（只读）
node scripts/cua-wechat-token-live.js            # token 失效规则（只读，用空写测试）
node scripts/cua-wechat-loop-live.js             # 读→决定→发→验证 的写侧闭环（会真发一条到自己）
node scripts/cua-wechat-inject-live.js 文件传输助手 "文本" --clear
                                                 # 往会话里注入一条"来路不明"的新消息，
                                                 # 用来端到端验收入站→模型回合→回复
node scripts/cua-wechat-directions-live.js "柳毓琳" "Azzy"
                                                 # 逐条打印真实会话里每个气泡的方向
                                                 # (IN(peer)/OUT(us)) 与 green share
```

`inject-live` 会自己重试到写入成功：它和机器人的轮询在抢同一个快照，这是**跨进程**才有的竞争（机器人自己进程内的读写不可能交错，因为驱动调用是同步的）。

## 守护进程死了会怎样

会"安静地聋掉"——这是实测过的（2026-10-01 驱动自己死了一次）：读不到的会话列表和"本来就没有新消息"在旧代码里长得一模一样，机器人进程活着但永远不回。现在：

- 快照失败**抛错**，不再被当成空列表；
- 连续 3 次读失败（且失败原因确实是"守护进程不在"）→ 走驱动自己的 `autostart kick` 拉起，必要时退化为分离启动 `serve`；60 秒冷却，不会变成重启风暴；
- 拉不起来就用 `error` 级别直说 **DEAF** 并给出修复命令；
- 读成功后计数清零，下一次故障照常上报。

`cyberboss doctor` 会按"真正会坏的顺序"检查这条通道：守护进程 → 微信窗口（最小化单独报）→ 允许名单非空 → 每个对端都有会话映射。
