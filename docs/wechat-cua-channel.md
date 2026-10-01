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

## 成本模型（实测 2026-10-01，微信 4.x / Windows 11）

| 动作 | 代价 |
|---|---|
| 读会话列表 / 读消息 | 后台，零前台 |
| 写文字进输入框 | 后台（首试），被拒时升级前台 |
| 按回车发送 | 后台 |
| **切换会话** | **一次前台点击**（UIA Invoke 与后台回车都被客户端忽略） |
| 发文件 | 粘贴必须前台，一次点击 |
| 发图片 | **做不到**：`clipboard_write({image_path})` 返回 `clipboard_unavailable` |

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
2. **窗口最小化 = 写侧全灭，读侧照常**，而拒绝码可能只显示 `stale_element_token`。客户端现在会在被拒后 `bring_to_front` 再重试一次。
3. **驱动会话有生命周期**：`session has ended; tool call ... was rejected`（退出码 1，话在 stderr 上）。客户端会自动 `start_session` 复活并重放**被拒**的那一次调用（拒绝 = 没执行，所以重放是安全的）。
4. **两个 `cua-driver call` 抢管道**时，守护进程活着也会回 `daemon is not running`。这是传输层失败、请求没到，客户端会重试一次。
5. **输入框是"有主"的工作区**：不是机器人写的字绝不覆盖、不删除（可能有人在打字）；只清理本进程自己留下的未发出文本。
6. **方向不可读**：UIA 读到的气泡没有"谁发的"信息，入站判断依赖回声账本（`SentLedger`）。这是本设计最薄的一环，写在 `.agents/notes/implemented/feature/2026-10-01-cua-wechat-write-loop.md` 里，没有隐藏。
7. **身份是显示名不是 wxid**：所以 `CYBERBOSS_CUA_CHAT_BY_TALKER` 必须显式配置，绑定的 `senderId` 也是显示名。

## 验收与自检

```sh
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
