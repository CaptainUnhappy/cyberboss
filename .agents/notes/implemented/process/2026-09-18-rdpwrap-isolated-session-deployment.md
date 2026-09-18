# Agent Note: RDPWrap 隔离会话部署契约（Windows 虚拟屏幕防抢占）

Status: implemented

## Problem

机器人的收发原本跑在用户自己的会话里（session 1）：UIA 桥要激活窗口、点会话行、注入键鼠。这带来两个代价：

1. **抢占**：任何一次驱动都可能抢走前台窗口与光标（用户明确不接受）。
2. **环境噪声**：同一会话里有沙箱继承、系统权限弹窗、ToDesk 等遮挡、以及"桌面空闲"门槛 —— 桥的失败模式全在这里。

方案是把**驱动面整体搬进一个独立的交互会话**（RDPWrap 本地回环 + 独立 Windows 账号），让收发在那边完成，用户桌面完全不参与。

## Decision

部署形态（2026-09-18 起的事实，改动需同步本笔记）：

| 角色 | 位置 | 账号 / 端口 |
|---|---|---|
| 机器人号（现役） | RDPWrap 隔离会话（session 4，用户 `cwinprobe`） | 微信 **Azzy** `wxid_s3178hwvzsl922` |
| 读侧 WeFlow | 同上 | HTTP **5051**（读 Azzy 的库） |
| 写侧 UIA 桥 | 同上 | HTTP **8776**（驱动 Azzy 的微信；核对走 5051） |
| 机器人本体 | session 1（**必须由计划任务拉起**） | `bin/cyberboss.js`，读 5051 / 写 8776 |
| 对端（真实用户） | 手机 / 大号 | 柳毓琳 `wxid_ubo0cy5xh4px22` |
| 旧机器人号（退役备用） | session 1 | 微信 **Ally** `wxid_ty69l7hjiqt012`（5031/8766 已停） |
| 官方通道 | 公网 | `ilinkai.weixin.qq.com`（不依赖隔离会话） |

**必须遵守的运行约束**

1. **必须存在一个"已连接且未最小化/未隐藏"的 RDP 客户端**。客户端一断、一最小化或一隐藏，隔离会话就失去输入桌面（`GetForegroundWindow()=0`、`SetCursorPos` 返回 False）→ 桥报 `WeChat main window could not be activated` → **回复发不出去**（收消息仍正常，因为读侧只是文件/HTTP）。客户端被别的窗口挡住是可以的。
   **不想看见它时，把它挪到屏幕外（如 `x=1930`，屏幕宽 1920），不要最小化、不要隐藏** —— 屏幕外同样保持"已连接 + 可注入"（实测 `setCursorPos=True`）。
   **为什么必须让它不可见**：隔离会话里的 **WeFlow 自己每约 30 秒起一次 `powershell.exe` + `conhost.exe`**（进程创建实测），也就是每 30 秒在会话桌面上生成一个控制台窗口；会话桌面正渲染在 RDP 客户端窗口里，于是用户看到"一直在弹 cmd 窗口"。这来自 WeFlow 自身，与应用侧代码无关，只能靠让客户端不可见来消除观感。
2. **机器人栈必须由计划任务启动，不能从 agent 会话里 `Start-Process`**：那样会继承 agent 沙箱（AppContainer），窗口激活与注入全部失效。运维命令是 `Start-ScheduledTask -TaskName cwin-s1-restack`。
3. **RDP 客户端必须正常显示启动**：`rdp-autologin.py` 原来用 `STARTF_USESHOWWINDOW` + 默认 `wShowWindow=0`（SW_HIDE）启动 mstsc，等于把会话置于不可注入状态；已改为 `SW_SHOWNORMAL`。
4. **同号人工输入与回声归因**：账本是唯一权威 —— 账本认领的发出消息按回声吞掉，未认领的按 `self_manual` 路由（见 [归因笔记](../bug-fix/2026-09-18-weflow-self-echo-attribution.md)）。
5. **官方通道身份只能有一个消费者**：不能同时跑两份 bot。

**保活与静默**

`cwin-s1-rdp-keepalive` 每 5 分钟在**隔离会话内**探针一次（`GetForegroundWindow` + `SetCursorPos`，只影响 session 4），失效则触发 `cwin-s1-rdp-reconnect` 重连并显式还原客户端窗口（不抢用户焦点）。每次运行还会把客户端**停靠到屏幕外**（幂等），避免重连把窗口带回屏幕上、让 WeFlow 的控制台闪现重新可见。两者都用 **`pythonw.exe`** 执行以彻底避免控制台窗口闪现 —— `-WindowStyle Hidden` 挡不住计划任务那一瞬的窗口创建，`-LogonType S4U` 在本机被拒（需要"作为批处理作业登录"权限）。

**操作员查看/操作会话桌面时的开关**（保活会持续把窗口挪走，所以需要显式暂停）：

```powershell
Start-ScheduledTask -TaskName cwin-s1-rdp-show   # 客户端挪回 (0,0) + 放置暂停文件
Start-ScheduledTask -TaskName cwin-s1-rdp-hide   # 移除暂停文件 + 停靠回 (1930,0)
```

暂停文件是 `C:\ProgramData\cwin-probe\rdp-client-hold.txt`：存在期间保活只探针、不挪窗口。给微信账号扫码登录等"必须看着会话桌面"的操作，先 `-show`，做完 `-hide`。

**回滚**：`Copy-Item .env.bak-<日期> .env -Force` 后 `Start-ScheduledTask cwin-s1-restack`。

## Alternatives considered

- **留在 session 1 做驱动，只靠桥内的"桌面空闲 ≥300 秒"门槛避让**：桥确实有 `MIN_CANARY_DESKTOP_IDLE_SECONDS=300`，但那只覆盖 canary/看门狗路径；且用户一用电脑就永远等不到窗口。已实测这条路持续失败。
- **session 0 / 隐藏桌面**：实测 `OpenInputDesktop` 失败、`WinSta0` 拒绝访问、`SetCursorPos` 失败 —— 服务会话里没有可注入的交互桌面。
- **虚拟机（L3）**：能隔离但成本与依赖最重，用户明确排除。
- **把机器人号也留在外面（Ally 在外）**：曾经可行，但出站驱动仍然落在用户会话里，抢占问题原样存在。最终把机器人号也搬进隔离会话。
- **`-LogonType S4U` 跑保活**：最正统的"无窗口"解法，但注册被拒（缺批处理登录权限），改用 `pythonw`。

## Consequences

- 收益：机器人的收发完全在隔离会话完成，用户桌面不参与；桥的失败模式从"抢占 + 遮挡 + 沙箱"收敛为"客户端是否连着"这一条，且这条有保活兜底。
- 代价：多了一个必须活着的 RDP 客户端（`mstsc`）与一个 Windows 账号（`cwinprobe`）；隔离会话的资源占用与真实微信一致。
- 已知缺口：① **投递没有握手** —— 发送失败不重传、不通知（账本里已积累数十条 `status=failed`），方案见 [投递握手提案](../../proposed/feature/2026-09-18-weflow-reply-delivery-handshake.md)；② 隔离会话内的 Agent Room executor 曾因串行执行卡死，文件队列 `C:\ProgramData\cwin-probe\s4\{in,out,done}` 是更可靠的后备通道。
- 部署脚本与复现包不在仓库内（`C:\ProgramData\cwin-probe\`、`tmp/cwin-lab/`），本笔记是它们在仓库里的锚点。
