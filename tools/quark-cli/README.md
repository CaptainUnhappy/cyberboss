# quarkctl — 夸克网盘客户端的命令行驱动

夸克桌面客户端**没有 CLI、没有本地 HTTP API、也没有"打开网盘路径"的 URL 协议**（它注册的处理器只会把分享链接丢进内置浏览器）。想自动化就只能驱动它的窗口。这个工具把这件事包成一条 CLI，并且**每一步都自证**（打印机器可读的状态行），所以失败时能直接看出是哪一层没生效。

## 为什么需要它

- 隔离会话（session 4）里跑着机器人；日常要在这里"把某个分享链接的文件下下来"时，没有可脚本化的入口。
- 直接写 `SendInput` 的脚本会在某些层失效（见下面的"已测边界"），需要按层降级、逐层判定。
- 读侧信息（窗口、前台、保存对话框、客户端任务表、下载目录）本身很有用，值得单独暴露成 `status` / `verify` / `windows`。

## 用法

```powershell
# 在隔离会话里（session 4）跑，或从 session 1 跑只读子命令
D:\Projects\cyberboss\tools\quark-cli\cmd\quarkctl.cmd status
D:\Projects\cyberboss\tools\quark-cli\cmd\quarkctl.cmd windows
D:\Projects\cyberboss\tools\quark-cli\cmd\quarkctl.cmd verify
```

> **客户端只在 session 4 里存在**：从 session 1 跑 `status` 会诚实地报 `client_pid=None`（那是正常的，不是 bug——两个会话的窗口互不可见）。`windows` 在 session 1 里同样可用，能列出 ToDesk / Cua overlay 等遮挡窗口。
>
> 客户端窗口的识别**按标题**（`夸克`/`网盘`/`分享链接`/`传输`/`备份`…），因为它的窗口类 `Chrome_WidgetWin_1` 与 Chrome/Edge/Electron 共用——只按类名匹配会抓错窗口（实测在 session 1 抓到过 Chrome）。

直接从仓库跑（等价，不经过 .cmd）：

```powershell
& D:\Tools\miniconda3\python.exe D:\Projects\cyberboss\tools\quark-cli\quarkctl.py status
```

> 隔离会话里的 `python` 是 Microsoft Store 的占位符，**必须**用上面的真实解释器；`cmd\quarkctl.cmd` 已经写死了这条路径。

### 子命令

| 子命令 | 作用 |
|---|---|
| `status` | 客户端 pid/窗口几何、当前前台窗口、保存对话框是否在场、`download.db` 状态、下载目录内容 |
| `windows` | 列出顶层窗口，把**盖住客户端**的窗口标成 `COVER`（这类遮挡是"点了没反应"的常见原因） |
| `close --cls X [--title Y]` | 用 `PostMessage(WM_CLOSE)` 关窗口，**不抢焦点**（例：`--cls FLUTTER_RUNNER_WIN32_WINDOW` 关内置播放器） |
| `shot --out a.png` | 截会话桌面（GDI，纯 ctypes，无第三方依赖） |
| `pref --dir <路径>` / `pref --disable` | 写客户端 `preference.json` 的 `downloadPosition`（`enable` + `lastSavePath`），首次写会留 `.quarkctl.bak` |
| `row --index N` | 选中第 N 行（点它的复选框） |
| `click --x X --y Y [--hover] [--mode mouse\|message\|both]` | 在客户端坐标系点/悬停，并报告"点到了哪个子窗口、是否弹出了保存对话框" |
| `download [--mode ...] [--hard]` | 点工具栏「下载」，报告结果：`picker`（弹出保存对话框）/ `nothing` / 任务表变化 |
| `keys --tabs N --key enter\|space\|none [--shot-each P]` | 键盘策略：按 N 次 Tab 再按键，逐次截图 |
| `probe-keys` | 在选中行上逐个试候选快捷键（`alt+d`/`ctrl+d`/`ctrl+j`/`enter`…），逐个截图并判定是否有反应 |
| `picker [--dir <路径>] [--enter]` | 检查保存对话框：转储它的子控件；或（`--dir`）用剪贴板粘贴路径 + 回车确认 |
| `verify` | 下载目录文件清单 + 客户端任务表大小/时间戳 |

## 已测边界（2026-09-18，本机实测，别重走）

| 层 | 结果 |
|---|---|
| 驱动客户端**文件列表** | ✅ 有效：按坐标点复选框能选中，右键能出菜单（`row` / `click`） |
| 驱动客户端**顶部动作栏**（选中文件后出现的 `下载/分享/复制…`） | ❌ **无效**：真鼠标（`SetCursorPos`+`mouse_event`）、窗口消息（`PostMessage`）、悬停、Tab 走焦、10 个候选快捷键、以及**剪贴板下载**（`clipboardForDownloadEnable`）全部无反应 |
| 保存对话框（`#32770`，标题「选择文件」） | ⚠️ 能弹出、能转储子控件；但"点确认按钮"无效，用剪贴板粘贴路径 + 回车可以关闭对话框 |
| 客户端任务表 | ❌ 全程 `download.db` 零任务行（唯一一次变化是 SQLite 自己建 `sqlite_stat1/stat4` 统计表 + `DownloadManager` 启动检查点，**不是任务**） |

### 两个先把人骗过的坑（都已用 CLI 防住）

1. **`WeFlow` 全屏窗口盖在客户端上**（`pid=11016`，`rect=(-8,0,1288,760)`）：z-order 实测发现动作栏落点下方是它，点击全被它吃掉——表现就是"点了没反应"。`click`/`download` 现在会先 `ensure_front` 验明正身，盖住时直接拒绝点击（可用 `--force` 强制）。
2. **桌面变黑**：RDP 客户端被最小化后会话桌面不再渲染（截图全黑、区域哈希三次相同），此时任何点击都是空转。保活探针只查 `GetForegroundWindow` + `SetCursorPos`，**在这个状态下仍报 healthy**（实测 16:40–16:48 一直报健康，而截图是黑的）。`desktop` 子命令用亮度采样做这个自检。

### 已确认的分层边界（2026-09-18 同日人工对照实验）

同一天、同一个应用实例、同一个桌面上做了对照：

| 层 | 合成输入 | 人工输入 |
|---|---|---|
| 应用自身的页面导航（刷新、侧栏、切页） | ✅ 生效（点击后页面确实切换） | ✅ |
| **分享对话框**里的勾选行 / `保存` 按钮 | ❌ 无反应（鼠标层+消息层+键盘层+无障碍全部试过） | ✅ **成功**（存储 2.10→3.20/10G，转存列表出现「最新」条目） |
| 选中行后出现的**动作栏**（`下载/分享/复制…`） | ❌ 无反应（含对照组：同排的视图切换按钮也无反应） | ✅ **成功**（用户手动点 `下载` 时传输面板出现 350KB/s 下载，最终落地一个 91MB mp4） |

结论：**这类"内容型"控件只认真实指针输入**；因此可用分工是——**需要按 `保存` / `下载` 的那一下由人点，其余（导航、选目录、验证落地）交给 CLI**。

## 结论与下一步

结论：**卡在"按下动作栏按钮"这一步**——不是账号权益（VIP 弹窗只属于"在线解压"那条产品线，点「下载」时不出现），也不是遮挡或黑屏（两者都已排除后仍无效）。

下一步只剩"绕过指针合成"这一条路：

1. **Chromium 无障碍树 + UIA `Invoke`**：已实测 `--force-renderer-accessibility` 重启后，UIA 里**依然没有动作栏元素**（主窗口 `descendants=2`，只有 `Chrome Legacy Window`），而且带参数启动会弹「发生个人资料错误」、页面变空白——这条路本机走不通，除非客户端有其它开启无障碍的方式。
2. **真实指针输入**：人工点一次按钮，之后交给 `picker` / `verify`；或从 RDP 客户端所在会话（session 1）注入真实鼠标事件，让 RDP 通道把它送进 session 4。
3. **彻底绕开客户端**：走网页版/后端接口下载（需要该账号的 cookie，客户端 cookie 加密，成本较高）。

## 相关笔记

- `.agents/notes/implemented/testing/2026-09-18-quark-share-download-in-isolated-session.md`（分享链接的验证结论与三次复现记录）
- `.agents/notes/implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md`（隔离会话的运行约束：客户端必须可注入、禁止 spawn 控制台子进程）
