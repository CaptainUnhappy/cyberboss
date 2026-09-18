# Agent Note: 夸克网盘客户端命令行驱动（tools/quark-cli/quarkctl.py）

Status: implemented

## Problem

隔离会话（session 4）里跑着夸克网盘客户端，日常需要它完成"把分享链接的文件下到本地"这件事。但客户端**没有 CLI、没有本地 HTTP API、也没有"打开网盘路径"的 URL 协议**——它注册的文件关联处理器只会把分享链接丢进内置浏览器；唯一确定的入口是"带 URL 启动"（`quark_cloud_drive.exe <URL>`）。

于是自动化只能驱动它的窗口。而这件事在同一天被证明**不能靠一把梭的 `SendInput` 脚本**：同一个会话里，有的层吃合成输入、有的层完全不吃（见 [分享下载的验证结论](../testing/2026-09-18-quark-share-download-in-isolated-session.md)）。每次试验都写成一次性 `qNN-*.ps1` 的话，下一轮又要从零复现"哪一层失败了"。

需要的是一条**能复用、且失败时能自证失败在哪一层**的命令行入口。

## Decision

落点是一个单文件、零第三方依赖的 Python CLI：`tools/quark-cli/quarkctl.py`（配 `cmd/quarkctl.cmd` 启动器与 `README.md`）。

1. **子命令按"能力层"划分**，每步只做一件事并打印机器可读状态行：`status`（客户端 pid / 窗口几何 / 前台 / 保存对话框 / 任务表 / 下载目录）、`windows`（顶层窗口 + 遮挡标记）、`close`（`PostMessage(WM_CLOSE)` 关窗，**不抢焦点**）、`shot`（GDI 截图，纯 ctypes 实现 PNG 编码）、`pref`（写 `preference.json` 的 `downloadPosition`）、`row`（按行号选中）、`click`（客户端坐标系点/悬停 + 报告命中的子窗口）、`download`（点工具栏「下载」并报告 `picker`/`nothing`/任务表变化）、`keys` / `probe-keys`（键盘策略与快捷键穷举）、`picker`（转储并驱动保存对话框）、`verify`（下载目录 + 任务表快照）。
2. **窗口识别按标题，不按窗口类**：客户端是 Chromium 系，窗口类 `Chrome_WidgetWin_1` 与 Chrome/Edge/Electron 共用。只按类名匹配时，从 session 1 跑会抓到 Chrome 窗口（实测踩到）。改为"可见 + 类名前缀 + 标题含 `夸克`/`网盘`/`分享链接`/`传输`/`备份` 之一"。
3. **进程发现不 spawn 控制台子进程**：pid 从窗口枚举里取（`GetWindowThreadProcessId`），不用 WMI、不用 `tasklist` —— 本机隔离契约禁止周期性助手创建控制台窗口（见 [RDPWrap 隔离会话部署契约](../process/2026-09-18-rdpwrap-isolated-session-deployment.md)）。
4. **解释器写死在启动器里**：隔离会话里的 `python` 是 Microsoft Store 占位符（实测 `py_compile` 直接失败），`cmd\quarkctl.cmd` 固定用 `D:\Tools\miniconda3\python.exe`。
5. **两个会话都能用**：只读子命令从 session 1 也能跑（`User Data` 目录可读），此时 `status` 会诚实报告 `client_pid=None`（客户端只在 session 4，两会话窗口互不可见）。

## Verification

会话内实测（`D:\Tools\miniconda3\python.exe … quarkctl.py <cmd>`，均在 session 4 的队列通道里执行）：

- `py_compile` 通过；`--help` 列出 12 个子命令。
- `status`：正确识别 `client_pid=25692 main_hwnd=0x70940`、`client_origin=(0,0)`、窗口 `1288x760`，并报告 `download.db` 大小/时间戳与下载目录条目数。
- `windows`：把「详情信息」面板（同进程 `pid=25692`）、内置播放器（`FLUTTER_RUNNER_WIN32_WINDOW`）、WeFlow 资源管理器全部标为 `COVER` —— **这正是当天"按钮按不动"的现场**（多个窗口盖在客户端上）。
- `close --cls FLUTTER_RUNNER_WIN32_WINDOW`：成功关闭播放器窗口且不抢焦点（`PostMessage` 路径）。
- `row --index 1`：选中文件行成功（截图可见复选框勾上）。
- `pref --dir …`：`preference.json` 的 `downloadPosition` 被置为 `enable=true` 且目录固定（首写留 `.quarkctl.bak`）。
- 从 session 1 复测：`status` 报 `client_pid=None`（符合预期），`verify` 正确列出该会话的下载目录；`.cmd` 启动器可用。

## Alternatives considered

- **继续用 PowerShell 一次性脚本（`qNN-*.ps1` 入队执行）**：最强理由是零新增组件、与既有会话内队列通道完全一致，且当天所有结论都是这么得到的。否决原因：状态判定散落在每个脚本里，"哪一层失败"要靠人读日志；参数（行号、坐标、目录）无法复用；每次都要重写一遍窗口/坐标逻辑。
- **用 WMI/`tasklist` 找客户端进程，再 `Start-Process` 驱动**：最强理由是代码最短、最常见的写法。否决原因：本机把控制台交给 Windows Terminal，`tasklist`/`schtasks` 之类每次 spawn 都会在**用户桌面**弹出终端窗口（实测 10 次 `tasklist` 产生 5 次可见终端事件），这违反隔离契约；窗口枚举取 pid 可以完全避开。
- **直接上 UI Automation（`InvokePattern`）驱动动作栏**：最强理由是能绕开指针合成，理论上一击命中（也是下一步的首选）。否决原因：当前客户端未开无障碍，Chromium 的 UIA 子树只有 `Chrome Legacy Window` + `Intermediate D3D Window` 两个节点（实测夸克主窗口 `descendants=2`），必须先以 `--force-renderer-accessibility` 重启客户端才能试；在验证"重启是否可接受"之前不把它写成主路径。
- **只做 `pref` + 文档，不写 CLI**：最强理由是当天真正的拦路虎是"动作栏按钮按不动"，而 CLI 并不能修好它。否决原因：这一层是**可复用资产**——它把当天所有实测结论固化成可重放的检查（`windows` 一眼看出遮挡、`verify` 一眼看出任务表是否变化），而且人工按一次按钮之后，`picker`/`verify` 就能接手后续步骤。

## Consequences

- **收益**：夸克客户端第一次有了可脚本化的入口，且**失败可归因**（每步打印状态行：命中哪个子窗口、是否弹出保存对话框、任务表是否变化）。当天最贵的一课被工具化：`windows` 的 `COVER` 标记可以直接指出"有个面板盖在上面"。
- **代价**：多了一个需要跟着客户端 UI 走的工具——行坐标（`--first-y 249`、行高 44）、工具栏按钮位置（`--dl-x/--dl-y`）、保存对话框标题（`选择文件`）都是**实测常量**，客户端改版就要重新标定；这些常量集中放在各子命令的默认参数里，并在 `README.md` 里注明来源。
- **已知缺口**：**动作栏按钮仍按不动**——真鼠标、窗口消息、悬停、10 个候选快捷键（`probe-keys`）全部无反应，而同一套机制能驱动文件列表；因此 `download` 子命令当前会返回 `ok=False`，客户端的 `download.db` 始终零任务行。结论是"卡在按下按钮这一步"，**不是账号权益**（VIP 弹窗只属于在线解压那条产品线）。
- **下一步**：`--force-renderer-accessibility` 重启客户端 + UIA `Invoke`（最可能打通）；或人工按一次后由 CLI 接手（`picker --dir` + `verify`）。
