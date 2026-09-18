# quarkctl — 夸克网盘客户端的命令行驱动

夸克桌面客户端**没有 CLI、没有本地 HTTP API、也没有"打开网盘路径"的 URL 协议**（它注册的处理器只会把分享链接丢进内置浏览器）。想自动化就只能驱动它的窗口。这个工具把这件事包成一条 CLI，并且**每一步都自证**（打印机器可读的状态行），所以失败时能直接看出是哪一层没生效。

## 已验证可用的两条驱动通道（2026-09-18）

| 通道 | 适用对象 | 做法 | 状态 |
|---|---|---|---|
| **CDP（首选）** | 客户端的**网页层**：主窗口 `index.html`、分享对话框 `share-link-window`、设置窗、收银台 | 客户端以 `--remote-debugging-port=9222` 启动后，用 `cdp-ops.js` 读 DOM、勾选、点按钮；点击用 **`Input.dispatchMouseEvent`（真实输入事件）**，不是 `element.click()` | ✅ 已成 CLI |
| **窗口消息/真鼠标（备选）** | **原生层**：窗口、保存目录对话框「选择文件」、Flutter 播放器 | `quarkctl.py` 的 `windows` / `clickwin` / `click` / `picker`；**坐标必须是"窗口客户区坐标"**（`client_origin` 不等于 (0,0) 时尤其注意） | ✅ 已成 CLI |

> **踩坑记录（两条最贵的）**
> 1. **坐标语义搞错**：`clickwin --x/--y` 是**客户区坐标**。分享窗 `rect=(190,66,1090,686)`、保存按钮 DOM 在 `client (777,568,103x32)` ⇒ 应传 **client (829,584)**，而不是屏幕 (1019,650) 或别的估计值。修正后一击命中。
> 2. **页面里"点元素"不等于"用户点击"**：`el.click()` 对 Quark 的 React 组件**无效**（保存按钮实测无反应）；必须走 CDP `Input.dispatchMouseEvent` 或窗口级真实鼠标事件。

## 快速开始（CDP 通道）

```bash
cd /d D:\Projects\cyberboss\tools\quark-cli

node cdp-ops.js list-targets                 # 有哪些页面
node cdp-ops.js share-info                   # 分享窗：分享者/文件列表/保存按钮/AX 提示
node cdp-ops.js share-enter --name 跨境电商    # 双击进入分享里的文件夹
node cdp-ops.js share-select --name .pdf --only   # 只勾选 PDF（--only 会取消其它勾选）
node cdp-ops.js share-save                   # 点「保存」并回报按钮状态与提示
node cdp-ops.js main-open-saveas             # 主页面切到「转存的内容」
node cdp-ops.js main-refresh                 # 点列表刷新控件，再读回列表长度
node cdp-ops.js main-list --filter 夸克网盘免费  # 在转存内容里找条目（含文本命中）
node cdp-ops.js main-click-button --text 下载   # 点工具栏按钮（按文字定位，不靠坐标）
```

辅助脚本：`cdp-drive.js`（`list/frames/dom/text/click/eval/ax/axclick`）、`cdp-ax-click.js`（按**无障碍名**定位并派发真实鼠标事件，支持 `dbl` 双击）、`cdp-eval-file.js`（把 JS 文件注入页面执行，避免 shell 转义把 `\s` 之类吃掉）。

## 端到端配方（分享链接 → 只要其中一个 PDF）

```
1) 隔离会话里带调试端口启动客户端（从 session 1 启动；会话内 schtasks 会被拒）
   Stop-Process -Name quark_cloud_drive -Force
   Start-Process 'D:\Tools\QuarkCloudDrive\quark_cloud_drive.exe' -ArgumentList '--remote-debugging-port=9222','<分享链接>'
2) node cdp-ops.js share-info                    # 看列表：条数是"当前目录"的条目
3) node cdp-ops.js share-enter --name <文件夹名>  # 若列表里是文件夹，先双击进去
4) node cdp-ops.js share-select --name .pdf --only
5) node cdp-ops.js share-save                    # 成功判据：转存内容里出现该条目
6) node cdp-ops.js main-open-saveas && node cdp-ops.js main-refresh
7) node cdp-ops.js main-list --filter <关键字>     # 确认条目已在网盘
```

**重要**：`保存` 成功后**分享窗不一定关闭**，必须在 `转存的内容` 里**点刷新**再核对列表——这是机主确认过的判据。


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

### 端到端成功记录（2026-09-18，同一晚）

人工点 `下载` 之后整条链跑通，可作为"成功长什么样"的基线：

```
输入：分享链接 https://pan.quark.cn/s/081f01685709
① 保存到网盘：存储 2.10 → 3.20/10G（后为 4.60/10G），转存列表出现带「最新」的条目
② 选中文件夹 → 点动作栏 下载
③ 落地：C:\Users\cwinprobe\Downloads\许蓝方正妹博士性学教室：男女那些羞羞事[性爱必备知识][MP4]\
   31 个 .mp4，合计 1,944,969,888 字节（1,854.9 MiB），partial=0
   最旧 18:38:45 / 最新 18:44:18（18:01 点下、约 43 分钟下完）
   另有单集 mp4 91,009,324 字节落在 Downloads 根目录（更早那次人工下载）
```

`download.db` 从空表长到 290,816 字节（`download_task` 出现 17 次），证明任务确实进了客户端自己的队列。

### 一个把排查带偏的 CLI bug（已修）

`verify` 早先只报**目录项自身的字节数**（`os.path.getsize`，Windows 上目录通常只有 24KB），于是"下载中"看起来像"卡在 24576 字节"。现在 `verify` 会 **walk 目录内容**，输出 `dir=… files=N bytes=… mib=… partial=N`。若当时用了修好的版本，就不会误判"卡住"。

## 结论与下一步

结论：**卡在"按下动作栏按钮"这一步**——不是账号权益（VIP 弹窗只属于"在线解压"那条产品线，点「下载」时不出现），也不是遮挡或黑屏（两者都已排除后仍无效）。

下一步只剩"绕过指针合成"这一条路：

1. **Chromium 无障碍树 + UIA `Invoke`**：已实测 `--force-renderer-accessibility` 重启后，UIA 里**依然没有动作栏元素**（主窗口 `descendants=2`，只有 `Chrome Legacy Window`），而且带参数启动会弹「发生个人资料错误」、页面变空白——这条路本机走不通，除非客户端有其它开启无障碍的方式。
2. **真实指针输入**：人工点一次按钮，之后交给 `picker` / `verify`；或从 RDP 客户端所在会话（session 1）注入真实鼠标事件，让 RDP 通道把它送进 session 4。
3. **彻底绕开客户端**：走网页版/后端接口下载（需要该账号的 cookie，客户端 cookie 加密，成本较高）。

## 相关笔记

- `.agents/notes/implemented/testing/2026-09-18-quark-share-download-in-isolated-session.md`（分享链接的验证结论与三次复现记录）
- `.agents/notes/implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md`（隔离会话的运行约束：客户端必须可注入、禁止 spawn 控制台子进程）
