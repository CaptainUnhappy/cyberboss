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
| 驱动客户端**顶部动作栏**（选中文件后出现的 `下载/分享/复制…`） | ❌ **无效**：真鼠标（`SetCursorPos`+`mouse_event`）、窗口消息（`PostMessage`）、悬停、以及 10 个候选快捷键全部无反应 |
| 保存对话框（`#32770`，标题「选择文件」） | ⚠️ 能弹出、能转储子控件；但"点确认按钮"无效，用剪贴板粘贴路径 + 回车可以关闭对话框 |
| 客户端任务表 | ❌ 全程 `download.db` 零任务行——即"从未真正开始下载"的机器可读证据 |

结论：**卡在"按下动作栏按钮"这一步**，不是账号权益（VIP 弹窗只属于"在线解压"那条产品线，点「下载」时不出现）。

`windows` 子命令在会话内实测抓到了这层遮挡的现场：

```
flag=CLIENT  hwnd=0x70940 pid=25692 rect=(-8,-8,1288,760)  title=首页 - 夸克网盘
flag=COVER   hwnd=0x3e0814 pid=25692 rect=(420,26,860,726)  title=详情信息        <-- 同一进程的面板
flag=COVER   hwnd=0x130b7a pid=29584 rect=(40,38,1240,713)  title=…073…mp4        <-- 内置播放器
flag=COVER   hwnd=0x20100 pid=15892 rect=(-8,-8,1288,760)   title=WeFlow - 文件资源管理器
```

## 下一步（按优先级）

1. **Chromium 无障碍树 + UIA `Invoke`**：给客户端启动加 `--force-renderer-accessibility`，让动作栏按钮在 UIA 里现身，用 `InvokePattern` 绕开指针合成。这是最可能一次打通的方案。
2. **人工按一次 + CLI 接手**：人工点下「下载」，之后 `picker --dir` / `verify` 由 CLI 完成。
3. **换会话内注入器**（cwin 类分层工具），或在客户端配置里预置下载目录（`pref`）以彻底跳过保存对话框。

## 相关笔记

- `.agents/notes/implemented/testing/2026-09-18-quark-share-download-in-isolated-session.md`（分享链接的验证结论与三次复现记录）
- `.agents/notes/implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md`（隔离会话的运行约束：客户端必须可注入、禁止 spawn 控制台子进程）
