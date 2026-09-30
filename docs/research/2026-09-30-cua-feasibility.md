# Cua (trycua/cua) 调研报告 — 能否取代 RDPWrap 隔离会话

- 调研日期：以抓取时刻为准，仓库最新 commit 为 **2026-09-29T22:52:32Z**
- 方法：只取一手来源（GitHub REST API、`raw.githubusercontent.com` 源码、`api.github.com`、PyPI JSON API、`cua.ai/docs/*`、`cua.ai/docs/llms-full.txt`）
- 所有断言后附 URL。无法从一手来源确认的一律标 `未证实`
- 被调研对象版本锚点：**Cua Driver 0.30.4**（stable，2026-09-28）、contract `0.8.0`

---

## 0. 摘要（先给结论的事实底座）

1. Cua 已经**不是** 2025 年那个「Lume = Apple Silicon macOS VM」的项目。当前主线是 **Cua Driver**（Rust，跨平台，后台驱动本机桌面）+ **Cua Fleets**（托管云桌面）+ **Sandbox SDK**（QEMU/Hyper-V 本地沙箱）。
2. **Windows 是一等公民**：`cua-driver` 官方支持 Windows 10/11，PowerShell 一行安装，**不需要管理员权限**，有 Windows x64/arm64 的 binary、npm optionalDependencies、PyPI wheel。
3. Windows 上的 Cua Driver 走 **Win32 / UI Automation / native input / targeted window messages**，默认 **background delivery**（不抢前台、不动真实指针）。
4. **但是**：Windows 上 Cua Driver **必须有交互式桌面会话**（Session 1+）。SSH 落地的 Session 0 完全看不到窗口。这一点是本次调研的**决定性约束**。
5. Windows **guest** 也被支持，但走的是另一条路：`Image.windows()`（Server 2022 / Win11），本地用 **Hyper-V 或 QEMU**，云端用 Fleet 的 Windows containerDisk，以及仓库里的 **QEMU-in-Docker Windows 11 容器**。**没有** 任何形式「Windows 宿主机上的无头虚拟显示器」给你跑 GUI 程序。

---

## 1. Cua 是什么（组件、版本、日期）

### 1.1 仓库元数据（一手：`api.github.com/repos/trycua/cua`）

`trycua/cua`（Organization `trycua`）；description "Scale computer-use 2.0 with open-source drivers, cross-OS fleets, and benchmarks…"；`created_at` **2025-01-31T15:02:49Z**，`pushed_at` **2026-09-29T23:48:57Z**；stars **27 479** / forks **1 925** / subscribers 92；`open_issues_count` **1 003**；GitHub 识别 license = **MIT**；topics 含 `windows`、`windows-sandbox`、`macos`、`lume`、`virtualization-framework`。
（stars/contributors/open issues 等成熟度指标详见第 8 节。）

### 1.2 目录即组件（一手：`api.github.com/repos/trycua/cua/contents/libs`）

`libs/` 实际 15 项：`cua-bench`、`cua-bench-s1`、`cua-driver`、`cua-driver-fixtures`、`cua-s1`、`cuabot`、`fleet`、`kasm`、`lume`、`lumier`、`python`、`qemu-docker`、`typescript`、`xfce`、`xfce-cua`。
https://api.github.com/repos/trycua/cua/contents/libs

**重要结构变化：已合并为单一 monorepo。** 旧的独立仓库**不存在**了——`api.github.com/repos/trycua/lume` 与 `/cua-bench` 都返回同一个 repo id `925270205`（即 302 到 `trycua/cua`）；`trycua/cua-train` 为 404。Lume 现在在 `libs/lume`（Swift，`VERSION` = **0.5.3**）。根目录**没有** `pnpm-workspace.yaml`（404），根 `package.json` 没有 `workspaces` 字段，真正的 TS workspace 是嵌套的 `libs/typescript/package.json`；Python 侧由根 `pyproject.toml` 的 `[tool.uv.workspace]` 管理（注意：release-please 跟踪的 `libs/python/cua-sandbox` **不在** members 列表里）。
`release-please` 按组件独立发版，manifest 记录：`cua-perception 0.2.1`、**`cua-driver 0.30.4`**、`lume 0.5.3`、`cua-sandbox 0.8.0`。**注意仓库级 `v0.1.x` tag 已废弃**——最新的 `v0.1.13` 指向 2025-03-17 的 commit；真正的发行线是组件 tag（`cua-driver-rs-v*`、`lume-v*`、`sandbox-v*`、`computer-server-v*`）。

| 组件 | 作用 | 版本 / 日期 |
|---|---|---|
| **Cua Driver**（`libs/cua-driver`，Rust workspace + Python/TS SDK） | 后台 computer-use 驱动，**MCP over stdio**，也可当 CLI；可嵌入应用进程 | **0.30.4**（2026-09-28）；nightly `0.30.5-nightly.20260929` |
| **Cua Fleets**（`libs/fleet`） / **Sandbox SDK**（`libs/python/cua-sandbox`） | 托管云桌面池（pool/claim，需 `run.cua.ai` 凭据） / 统一沙箱 API（本地 QEMU/Hyper-V 或 Fleet） | `@trycua/fleet` 0.1.2 / sandbox 0.8.0 |
| **computer-server**（`libs/python/computer-server`） | guest 内 HTTP/WS + MCP 服务，端口 8000 | **0.3.46**，MIT |
| **Lume**（`libs/lume`，Swift） | Apple Silicon 上的 macOS/Linux VM（Virtualization.framework） | **0.5.3**（2026-08-11） |
| **Lumier** / **cua-bench** / **CUA-S1** / **cua CLI** | Lume 的 Docker 封装 / 任务构建与评测 / 小型专用决策模型（权重在 HF）/ 通用 CLI+MCP | cua-cli 0.1.15、cua-bench 0.2.11、cua-computer 0.5.19、cua-agent 0.8.4 |
| 已废弃 | `cua-som`（AGPL）、`cua-agent` 的 `omni` extra | 2026-09-29 commit `e2c1840` |

### 1.3 macOS-only vs 跨平台（关键区分）

- **macOS-only**：`lume`（Apple Virtualization.framework，Apple Silicon 宿主）、`cua-driver permissions` 子命令、`CuaDriver.app` bundle（TCC 授权用）、Computer History 预览。
  https://cua.ai/docs/reference/cua-driver/cli-reference · https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/README.md
- **跨平台（macOS + Windows + Linux）**：`cua-driver` 本体与全部 59 个 MCP 工具、`cua-computer-server`、Sandbox SDK。
  https://cua.ai/docs/reference/cua-driver/platform-support
- **Linux 侧 caveat**：Linux 要求 x86_64 桌面会话 + X11/XWayland + AT-SPI 2；Wayland 的原生键盘注入是已知缺口。
  https://cua.ai/docs/llms-full.txt（"Requires an x86_64 Linux desktop session with X11 or XWayland, plus AT-SPI 2"）

---

## 2. 决定性问题：Cua 能不能承载 / 驱动 Windows？

### 2.1 区分两件事（本报告的核心区分）

- **(a) Cua 从外部「控制」一台 Windows 机器** → **可以，且是一等支持**（Cua Driver on Windows）。
- **(b) Cua 「承载」一个 Windows guest** → **可以，但走沙箱/Sandbox SDK 路线**（Hyper-V / QEMU / Fleet），与 (a) 是两套完全不同的东西。

### 2.2 (a) 控制 Windows：官方支持

`cua-driver` 平台矩阵原文：

> "cua-driver supports Windows, macOS, and Linux."
> Windows 行：**"Supported. Canonical coverage includes Electron, Tauri, WPF, WinUI 3, and WebView2. Some background Chromium gestures and elevated-integrity boundaries remain unavailable or unproven."**

https://cua.ai/docs/reference/cua-driver/platform-support

安装（Windows）：`irm https://cua.ai/driver/install.ps1 | iex` 然后 `cua-driver autostart kick`。

> **"Requirements: Windows 10/11 or Windows Server with an interactive desktop session and PowerShell."**
> "the script selects the right install path for the host and _does not require administrator access_."

**Windows 上不需要任何 OS 权限授予**——`mcp-tools-windows` 原文："Windows requires no special permissions."（Accessibility / Screen Recording 那套 TCC 只属于 macOS。）
https://cua.ai/docs/how-to-guides/driver/install · https://cua.ai/docs/reference/cua-driver/mcp-tools-windows · https://cua.ai/docs/llms-full.txt（该页原文为 "Requires Windows 10/11 with an interactive desktop session and PowerShell"，两处措辞不同，Server 的说法见 install 页）

发布产物实证（`cua-driver-rs-v0.30.4` release assets）：`cua-driver-rs-0.30.4-windows-x86_64.zip`、`-windows-arm64.zip`、`install.ps1`、`release-manifest.json`、`checksums.txt`，以及 `cua_driver-0.30.4-py3-none-win_amd64.whl` / `win_arm64.whl`、npm `trycua-cua-driver-win32-arm64-msvc-0.30.4.tgz`。
https://api.github.com/repos/trycua/cua/releases

### 2.3 (a) 的硬约束：必须有交互式桌面（Session 1+）

官方 Windows-over-SSH 文档明确：Windows OpenSSH 跑在 **Session 0**，`EnumWindows` / `GetForegroundWindow` / `PrintWindow` / UIA / `BitBlt` 都按调用者的 WindowStation 作用域，所以 `cua-driver call list_windows` 返回 `[]`——"even though the user's RDP session has 12 windows open"。`cua-driver doctor` 的原文警告：

> "[warn] interactive session: running in Session 0 (services); window-driving tools
> (list_windows, click, type_text, get_window_state) will return empty results.
> **These APIs need an attached interactive desktop.**"

解决方案是「交互式会话里的 daemon + 命名管道」：`cua-driver-serve` 作为 `LogonType: Interactive` 的计划任务跑在 **Session 1+（RDP / console）**，Session 0（SSH）侧的 `cua-driver mcp` / `cua-driver call` 通过 `\\.\pipe\cua-driver` 代理请求。

关键细节（对 cyberboss 直接相关）：
- `cua-driver autostart enable` 注册的是 **`LogonType: Interactive`** 的计划任务；`cua-driver autostart kick` 立即拉起。
- **`Disc`（已断开的 RDP 会话）仍然算活的交互式会话**："A disconnected session remains in `Disc` state and is still a live interactive session." —— 这对 cyberboss 是**利好**：RDP 连一次后断开即可长期托管 daemon，不必像现在那样让 mstsc 一直开着且不最小化。
- 命名管道**按账号私有**：不同账号能发现管道但连接得到 `Access is denied`。两边 `whoami /user` 的 SID 必须完全一致。PR #3318 的结论是 "Session 0 is not the blocker. A same-SID Session 0 client can connect to the interactive Session 1 daemon." —— **同账号是硬前提**。
- 非交互环境下仍可用的只有 `list-tools` / `describe` / `dump-docs`；`serve`、direct MCP、`CuaDriver.create()` 在没有交互式桌面时**在接收动作前就拒绝**；裸 `cua-driver mcp` 在 Session 0 里**fail closed，绝不静默回落到别的会话**。
- 用户会话必须处于 `Active` 或 `Disc`（`query session`），`kick` 才能把 daemon 放进 Session 1+。
- 未支持 / 未证实：**锁屏桌面**（issue #1745 仍 open，仅为愿望）、Windows Server Core、Windows containers。

来源：https://cua.ai/docs/how-to-guides/driver/windows-ssh · https://cua.ai/docs/reference/cua-driver/process-model

### 2.4 (b) 承载 Windows guest：官方支持，三条路

| 路径 | Guest | 运行时 | 宿主要求 | 来源 |
|---|---|---|---|---|
| Sandbox SDK 本地 | `Image.windows()` → **Windows Server 2022 VM** | **Windows 宿主上有 Hyper-V 就用 Hyper-V；否则 Docker 包 QEMU；再否则裸机 QEMU** | 需要硬件虚拟化 | https://cua.ai/docs/reference/sandbox-sdk/runtime-support |
| Sandbox SDK 本地 | `Image.windows('11')` → **Windows 11 VM** | Windows runtime selection；本地 ISO 安装路径 | "Requires a suitable host, installation media, and guest setup" | 同上 |
| Fleet 云 | Server 2022 containerDisk `public.ecr.aws/k5j5w0x5/cua-windows-2022:main-bac7daa3` | KubeVirt + **UEFI/OVMF 固件**（BIOS 起不来） | 云 | https://api.github.com/repos/trycua/cua/pulls/3125 |
| **QEMU-in-Docker** | **Windows 11 Enterprise Eval** | QEMU/KVM in Docker | Linux 宿主 + `/dev/kvm` | `libs/qemu-docker/windows/` |

QEMU-in-Docker 实证（`libs/qemu-docker/windows/Dockerfile`，VERSION **0.1.3**）：基镜像 `FROM trycua/windows-local:latest`；`RAM_SIZE="8G"`、`CPU_CORES="8"`、`VERSION="win11x64-enterprise-eval"`、`DISK_SIZE="30G"`、`ARGUMENTS="-qmp tcp:0.0.0.0:7200,server,nowait"`；`EXPOSE 5000 8006`（5000 = cua-computer-server API，8006 = noVNC）。Windows ISO 需**自己提供**（`src/vm/image/README.md` 要求下载 Windows 11 Enterprise Evaluation 并重命名为 `setup.iso`）。
https://raw.githubusercontent.com/trycua/cua/main/libs/qemu-docker/windows/Dockerfile · …/VERSION

**Lume 不支持 Windows guest**（只做 macOS/Linux guest，且宿主必须是 Apple Silicon；"Lume runs on Apple Silicon Macs. macOS 13 or later is required."，每宿主最多两个 macOS guest，最低 8 GB RAM / 50 GB 磁盘）。
https://raw.githubusercontent.com/trycua/cua/main/docs/content/docs/reference/lume/limits.mdx

---

## 3. Windows 宿主上的 API 面

### 3.1 Cua Driver（推荐路径，本地 IPC）

- 形态：**Rust 二进制 `cua-driver`**，Windows 上暴露 **59 个 MCP 工具**（macOS 58 / Linux 62），通过单一 **stdio MCP server** `cua-driver mcp`；每个工具也能命令行调用 `cua-driver <name> '<JSON-args>'`。
- contract manifest 实测：`"transport": "mcp_stdio"`、`"contract_version": "0.8.0"`、`"mcp_protocol_version": "2025-06-18"`、`"experimental": true`。
  https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/contract/manifest.json
- Windows UI API：**Win32 + UI Automation (UIA) + native input + targeted window messages**；**不需要任何 OS 权限授予**（"Windows requires no special permissions."，Accessibility/Screen Recording 那套 TCC 只属于 macOS）。

已从 manifest 逐个核实存在的工具（platform 字段均为 `macos/windows/linux`）：`click`、`clipboard_read`、`clipboard_write`、`drag`、`end_session`、`escalate_session`、`get_agent_cursor_state`、`get_cursor_position`、`get_desktop_state`、`get_screen_size`、`get_session`、`get_session_state`、`get_window_state`、`hotkey`、`invoke_menu`、`list_apps`、`list_sessions`、`list_windows`、`move_cursor`、`parse_visual_regions`、`press_key`、`scroll`（manifest 抓取被截断）。官方 Windows 页另列 `set_value`、`set_window_frame`、`bring_to_front`、`kill_app`、`launch_app`、`double_click`、`right_click`。
来源：https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/contract/manifest.json · https://cua.ai/docs/reference/cua-driver/mcp-tools-windows

### 3.2 关键工具语义（原文摘要）

- `get_window_state({pid, window_id})` → 一次调用同时返回 **UIA `elements[]`（每个带 `element_token`）+ 截图**（`include_screenshot` 默认 true；`capture_mode` 已废弃且被忽略）。
- `click({pid, element_token})` → accessibility 路径；`click({pid, window_id, x, y})` → 像素路径。`delivery_mode`: `"background"`（默认，不前置不抬窗）/ `"foreground"`（短暂前置后恢复）。
- 动作响应带 `effect`（`confirmed`/`partial`/`unverifiable`/`suspected_noop`/`refused`）、`route`（`accessibility`/`synthetic_events`/`global_input`/`system_api`/`dom`/`trusted_input`）、`escalation{target, reason}` —— **`confirmed` 只在 AX 回读成功时给出**。
- `list_windows` 字段：`window_id`(HWND)、`pid`、`app_name`、`title`、`bounds`、`z_index`、`is_on_screen`、`minimized`。`list_apps` 同时列出「运行中」与「已安装未运行」的桌面/UWP 应用。
- `clipboard_read` / `clipboard_write`（text / image_path / file_path 三选一；内容永不进遥测）。

来源：https://cua.ai/docs/reference/cua-driver/mcp-tool-notes · https://cua.ai/docs/reference/cua-driver/action-selection-policy

### 3.3 computer-server（另一条路；**不是** per-action REST）

**重要纠正**：`/screenshot`、`/click`、`/type`、`/key`、`/clipboard`、`/file`、`/window`、`/screen_size` 这类 HTTP 路径**一律不存在**。computer-server 是**单一 command-dispatch 面**。

`main.py` 里 `@app.(get|post|delete|websocket)` 的**完整 13 条路由**（源码实测）：

| 路由 | 说明 |
|---|---|
| `GET /status` | `{"status":"ok","os_type":…,"features":[…]}` |
| `GET /commands` | 返回全部命令名 + 参数签名 + 别名表 |
| `WS /ws` | **主控通道**（消息协议见下） |
| `POST /cmd` | HTTP 回退通道，响应是 SSE |
| `POST /responses` | agent 代理（跑 `ComputerAgent`，最多 2 轮；未装则 501） |
| `POST /playwright_exec` | `visit_url` / `click` / `type` / `scroll` / `web_search` |
| `POST /pty`、`GET /pty/{pid}`、`DELETE /pty/{pid}`、`POST /pty/{pid}/stdin`、`POST /pty/{pid}/resize`、`GET /pty/{pid}/stream`、`WS /pty/{pid}/ws` | PTY 家族 |
| 挂载的 `POST /mcp` | MCP over streamable HTTP |

- 绑定：`uvicorn.run(app, host="0.0.0.0", port=8000)`，但 CLI 默认 host 是 **`127.0.0.1`**。`POST /cmd` body = `{"command": "<name>", "params": {…}}`；响应 `media_type="text/plain"`，SSE 帧为 `data: {"success": true, <result 平铺在顶层>}` 或 `data: {"success": false, "error": "<msg>"}`；可选云认证头 `X-Container-Name` / `X-API-Key`（仅当 `CONTAINER_NAME` 已设置时）。
- `WS /ws`：云模式下**第一条消息必须是** `{"command":"authenticate","params":{"api_key":…,"container_name":…}}`，否则回 `"First message must be authentication"` 并关闭；之后每条都是 `{"command","params"}`。WS 单消息上限 10 MB。两个 ASGI 中间件可拦截一切（`UnavailableWithoutContainerMiddleware` → 503/1008；`VNCBackendScopeGuard` → `/playwright_exec`、`/responses`、`/pty*` 返回 409）。
- **完整命令注册表**（真正的 API 面）：`screenshot`、`get_screen_size`、`get_cursor_position`、`left_click`、`right_click`、`double_click`、`move_cursor`、`drag`、`drag_to`、`mouse_down`、`mouse_up`、`scroll`/`scroll_down`/`scroll_up`/`scroll_direction`、`type_text`、`press_key`、`hotkey`、`key_down`、`key_up`、`copy_to_clipboard`、`set_clipboard`、`run_command`、`read_text`/`write_text`/`read_bytes`/`write_bytes`、`file_exists`、`directory_exists`、`get_file_size`、`list_dir`、`create_dir`、`delete_file`、`delete_dir`、`open`、`launch`、`get_accessibility_tree`、`find_element`、`get_current_window_id`、`get_application_windows`、`get_window_name/size/position`、`set_window_size/position`、`maximize_window`、`minimize_window`、`activate_window`、`close_window`、`get_desktop_environment`、`set_wallpaper`、`version`。
  条件注册：`multitouch_gesture`（仅 Android）、`get_desktop_state`/`get_capture_scope_state`/`escalate_capture_scope`（仅 Cua Driver 后端）。别名：`type`→`type_text`、`key`→`press_key`、`tap`/`click`→`left_click`、`shell`/`exec`→`run_command`、`read_file`→`read_text`、`ls`→`list_dir`、`mkdir`→`create_dir`、`rm`→`delete_file`、`rmdir`→`delete_dir`。
- Windows 实测响应形状：`screenshot` → `{"success":true,"image_data":"<base64>","format":"png"}`；`get_screen_size` → `{"success":true,"size":{"width":…,"height":…}}`；`get_cursor_position` → `{"success":true,"position":{"x":…,"y":…}}`；`run_command` → `{"success":…,"return_code":…,"stdout":…,"stderr":…}`。
- **Windows 上它会驱动「它自己所在那台机器的桌面」**：`handlers/windows.py` 用 `win32api.GetSystemMetrics(win32con.SM_CXSCREEN)` 读本机指标，并有 `require_unlocked_desktop` 装饰器——锁屏时**返回错误而不是假装成功**。后端 `--backend cua-driver` 时桌面动作委托给 Cua Driver；VNC 后端只覆盖屏幕/指针/滚动/键盘，其余（shell、files、PTY、browser、windows）**明确拒绝**而非静默在 server 本机执行。

来源（源码）：`libs/python/computer-server/computer_server/main.py`、`…/handlers/windows.py`、`…/handlers/factory.py`、`libs/python/cua-sandbox/cua_sandbox/transport/computer_server.py`、`libs/python/computer-server/README.md`（均位于 https://github.com/trycua/cua/tree/main/libs/python/computer-server ）· https://pypi.org/pypi/cua-computer-server/json

### 3.4 Windows 上 Cua Driver 的两条硬限制（对 cyberboss 决定性）

**限制 1：`cua-driver` 没有文件与 shell 工具。** 59 个 Windows 工具里**不存在** `file_read` / `file_write` / `list_directory` / `run_command` / `shell`。官方原文："**Cua Driver does not read or write files directly. It drives the apps that open those files.**" 文件/shell 要走 **`computer-server`（Python，原生支持 Windows，`pywin32` 依赖）**。
https://cua.ai/docs/reference/cua-driver/mcp-tools-windows · https://cua.ai/docs/how-to-guides/recipes/automate-a-legacy-windows-app-behind-a-vpn

**限制 2：`cua-driver` 没有 HTTP REST API。** 传输只有三种：**stdio MCP**、**Windows 命名管道 `\\.\pipe\cua-driver`（`--socket`）**、以及一个**默认关闭的 loopback HTTP MCP 监听器**（需同时设 `CUA_DRIVER_RS_MCP_HTTP_PORT` 与 `CUA_DRIVER_RS_MCP_HTTP_TOKEN`，**仅设端口会导致 daemon 启动失败**）。有人正式提过要 REST（issue #1858，open，理由正是 Session 0 拿不到桌面），**未实现**。要「Node 直接 HTTP/WebSocket 调 Windows 桌面」，正确做法是**在那台 Windows 上跑 `computer-server`**，用 `/ws`、`/cmd`、`/status` 或 `/mcp`。
https://cua.ai/docs/concepts/sdk-mcp-and-hosting · https://github.com/trycua/cua/issues/1858

### 3.5 Node.js 集成路径（都不需要 Python 客户端代码）

- **进程内 SDK**：`npm install @trycua/cua-driver` → `import { CuaDriver } from "@trycua/cua-driver"`；`optionalDependencies` 含 **`@trycua/cua-driver-win32-x64-msvc`** 与 **`-win32-arm64-msvc`**（共 6 个平台包）；导出 `.`、`./fleet`、`./electron`、`./embedded`；方法 `getDesktopState`/`getScreenSize`/`getCursorPosition`/`moveCursor`/`click`/`drag`/`scroll`/`typeText`/`pressKey`/`hotkey`，外加通用 `listToolsJson()` / `callTool()`。
  https://registry.npmjs.org/@trycua/cua-driver/latest · https://cua.ai/docs/reference/cua-driver/sdk-reference
- **MCP stdio / 命名管道**：`cua-driver mcp` 或 `cua-driver mcp --socket \\.\pipe\cua-driver`；一次性调用用 `cua-driver call <tool> '<json>'`。**注意命名管道只授予 daemon 属主 SID**，并在读取请求前校验对端进程 SID："Clients running as another user or security principal are rejected… This is an intentional fail-closed change from the earlier broad local ACL."
  https://cua.ai/docs/concepts/sdk-mcp-and-hosting

### 3.6 安装产物（官方；负向结果已穷尽核对）

- Windows：`irm https://cua.ai/driver/install.ps1 | iex`（**无需管理员**，落到 `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin`，包缓存在 `%USERPROFILE%\.cua-driver\packages\releases\`）。**确认不存在**：`microsoft/winget-pkgs` 的 `manifests/t/TryCua` → **404**、`manifests/c/Cua` → **404**；Chocolatey `substringof('cua')` → **空结果**；release assets 里**没有** `.msi`、独立 `.exe`、`.deb`、`.rpm`、apt repo。
- macOS：`install.sh`，只发 `.tar.gz`（**无 `.dmg`**）；`trycua/homebrew-tap` → **404**。Linux：同一个 `install.sh`，release body 自称 **"Linux preview builds"**。
- pip/uv：`pip install cua-driver`（含 win_amd64/win_arm64 共 5 种 wheel）、`pip install cua-computer-server`；`cua-cli`/`cua-sandbox` 需私有索引 `--extra-index-url https://wheels.cua.ai/simple`。双通道：`cua-driver channel set stable|nightly`、`check-update`、`update --apply`。
- **`cua-driver autostart` 在 Windows 上最成熟**："Windows registers a logon Scheduled Task. macOS and Linux currently print manual-recipe guidance."

来源：https://cua.ai/docs/how-to-guides/driver/install · https://api.github.com/repos/trycua/cua/releases/tags/cua-driver-rs-v0.30.4 · https://cua.ai/docs/reference/cua-driver/cli-reference

---

## 4. 无头 / 虚拟显示器：Windows 上**没有**

这是本次调研里对 cyberboss 最不利的一条，必须直说：

1. Cua Driver 在 Windows 上**必须挂在交互式桌面会话**（Session 1+）。Session 0 被描述为「没有 attached interactive desktop」，工具返回空结果。没有任何「创建虚拟显示器 / headless display」的开关。**`https://cua.ai/docs/reference/cua-driver/headless.md` → HTTP 404**：根本不存在 headless 文档页。
   https://cua.ai/docs/how-to-guides/driver/windows-ssh · https://cua.ai/docs/reference/cua-driver/process-model
2. 全仓库文档搜索 `headless` / `virtual display` / `VirtualDisplay` / `Xvfb` / `WHPX`：只有一处提「no attached display」，说的是 **Linux 远程机上的 Gnumeric demo**（"…on a remote machine with no attached display or GPU."）；另一处是进程拓扑讨论。**"Headless" 只在 Linux 上被明确承认，且要你自己把桌面会话拉起来**：install 页原文 "a headless server has no windows to drive until you start a desktop session (for example `xfce4` under `Xvfb`)"。**Windows 上不存在等价能力。**
   https://cua.ai/docs/llms-full.txt
3. 那「不占用户物理桌面」怎么实现？Cua 的答案是**换一个桌面**，而不是在同一桌面上造虚拟屏：① 把 daemon 放进另一个交互式会话（RDP / console，**断开连接也仍然有效**）——与 RDPWrap 做的事**语义相同，但约束更宽松**；② **开一台 Windows VM**（QEMU/Hyper-V），VM 里的桌面天然与宿主隔离。
4. **源码层面的结论（不只是文档）**：QEMU 用 `-vga std -vnc :N -display none` —— `-display none` 关掉的是**宿主窗口**，guest 仍渲染到它自己模拟的标准 VGA 帧缓冲并经 VNC 观看；这**不是**虚拟显示器驱动。全代码库**没有** `VirtualDisplay` / dummy display 组件。Linux 上虚拟显示器是**用户的活**（`handlers/linux.py`："1. Install Xvfb… 2. Run with virtual display: `xvfb-run python -m computer_server`"）。仅有的内建 headless 开关是 **Android 的 `-no-window`** 与 **Tart 的 VNC-headless macOS/Linux VM**，都不涉及 Windows。
   来源：`cua_sandbox/runtime/qemu.py`（588-596 行）、`…/runtime/android_emulator.py`、`computer_server/handlers/linux.py`
5. **WHPX 在 Windows guest 上被刻意避开**：源码注释 "WHPX has MMIO bugs with OVMF pflash — use TCG for UEFI VMs"（UEFI/Windows guest 走 TCG 软件模拟，慢）。WHPX 只用于非 UEFI 场景与 Android 模拟器（`qemu.py` 约 421 行、`compat.py` 400-405 行）。
6. 附带证据：Windows Chrome/Edge 的 typed browser 支持标注为 **"Validated. … An interactive desktop is required."**（https://cua.ai/docs/reference/cua-driver/limits）

---

## 5. 沙箱 / 隔离模型与资源需求

| 隔离级别 | 实现 | 需要什么 | 来源 |
|---|---|---|---|
| **无隔离（本机）** | Cua Driver 直接驱动安装它的那台机器 | 交互式桌面会话 | https://cua.ai/docs/concepts/how-sandboxes-work |
| **Container** | Linux 容器（共享宿主内核）+ XFCE + KasmWeb 远程显示栈 | Docker | 同上 |
| **Full VM** | macOS→Apple Virtualization；**Windows→QEMU 或 Hyper-V**；Android→QEMU；Linux→裸机 QEMU | 硬件虚拟化（Linux 需 `/dev/kvm`） | 同上 |
| **Cloud** | Fleet 池/claim，KubeVirt VM | `CUA_CLIENT_ID` / `CUA_CLIENT_SECRET` 与 `run.cua.ai` | https://cua.ai/docs/tutorials/your-first-cloud-fleet |

资源需求（实测自 Dockerfile，属**默认值**而非最低要求）：Windows 11 QEMU 容器 **RAM 8G / CPU 8 核 / DISK 30G**（镜像 `win11x64-enterprise-eval`）；Fleet Windows Server 2022 池的验证跑在 **4 cpu / 4Gi** 上并成功 Ready（123 秒）；PR #551 示例 `RAM_SIZE=4G`/`CPU_CORES=4`/`DISK_SIZE=20G`，首次建 golden image 15–20 分钟、之后 2–5 分钟。
来源：https://raw.githubusercontent.com/trycua/cua/main/libs/qemu-docker/windows/Dockerfile · https://api.github.com/repos/trycua/cua/pulls/3125 · https://api.github.com/repos/trycua/cua/pulls/551

镜像清单（`sandbox-sdk/os-image-catalog` 表格）：Ubuntu 24.04（VM/容器）、Omarchy/Hyprland、NixOS×2、**Windows Server 2022**、macOS 15/26。
https://cua.ai/docs/reference/sandbox-sdk/os-image-catalog

---

## 6. 无头 / 云部署（Linux server、Docker、K8s）

- **可以**。Cua Driver 官方支持 Linux（x86_64 桌面会话 + X11/XWayland + AT-SPI 2；最小 Debian/Ubuntu 需先装 `libxi6`、`at-spi2-core`）。https://cua.ai/docs/how-to-guides/driver/install
- **Kubernetes**：Fleet 后端是 KubeVirt（PR #3125 引用了 `virt-launcher` 日志与 VMI phase），仓库里有 Kustomize 与 CRD `images.images.cua.ai`（`clusters/base/cua-images/crd.yaml`；其 recipe `osType` 枚举**只有 linux**、`kind` 只有 vm、`build.diskSize` 默认 40Gi），但**全仓库没有任何 Helm chart**，**控制面是否可自托管未文档化** → `未证实`。官方 IaC 路径是 **Terraform provider**（`libs/fleet/terraform-provider-fleets`，资源 `fleets_pool`，另有公开镜像仓库 https://github.com/trycua/terraform-provider-fleets ）。
- **Docker 镜像确有**：Docker Hub 组织 `trycua` 共 **16 个公开仓库**（`lumier`、`cua-ubuntu`、`cua-xfce`、`xfce-cua`、`windows-local`、`qemu-local`、`cua-linux`、`cua-windows`、`cua-qemu-{linux,windows,android}`、`cua-droid`、`cua-android-docker`、`winarena`、`winarena-base`、`cuabot`）；`trycua/xfce-cua:latest` 已核实可**匿名 pull**（约 450 MB；`trycua/cua-xfce:latest` 达 7.1 GB）。**没有**名为 `computer-server` 的独立镜像——它是**烤进** xfce-cua / cua-xfce / cua-ubuntu / qemu-* 镜像里的。公有 ECR `public.ecr.aws/k5j5w0x5` 也可匿名 pull（`cua-ubuntu-24.04` 的 tags/list 已验证）。`libs/qemu-docker/{linux,windows,android}` 里的 Windows 镜像 build 标签是 `trycua/cua-qemu-windows:latest`，base `trycua/windows-local:latest`（自述 "forked and simplified from dockurr/windows"，见 PR #551）。
- **`ghcr.io/trycua/*`（macOS sandbox 镜像）无法匿名拉取**（manifest 404 / token 403）→ 可能为私有，`未证实`。
- **API key / 托管服务**：只有 **Fleet 云**需要凭据（`CUA_CLIENT_ID` / `CUA_CLIENT_SECRET`，或 `FLEETS_TOKEN`，或 GitHub OIDC `cua wif-token github`），且建 pool 可能需要付款方式。**两个陷阱**：`CUA_API_KEY` 是 **legacy**，其默认 host `https://api.cua.ai` **已退役**，带上它反而会把调用**绕开** Fleet；`cua sb launch <image>` 不带 `--pool` 走旧 VM API，「today 不可用」。本地 Cua Driver、computer-server、QEMU 容器**不需要**任何 key。另有一个 headless 陷阱：无 Secret Service 的 Linux 上 `cua auth login` 会在浏览器授权**之后**失败（"No secure credential store is available"）。
  https://cua.ai/docs/reference/cua-cli/authentication · https://cua.ai/docs/tutorials/your-first-cloud-fleet

---

## 7. 许可（逐文件核实）

根 `LICENSE.md` = **MIT**（`Copyright (c) 2025 Cua AI, Inc.`；README 引用块 `license = {MIT}`，CITATION.cff 同步）。`LICENSING.md` 的完整清单里**除下列三处外全是 MIT**（`libs/cua-bench/LICENSE` 为 "Copyright (c) 2024-2025 TryCua"；`libs/kasm/LICENSE` 含 Kasm Technologies 版权部分；其余为 `libs/{cua-bench-s1,cua-s1}/python/LICENSE`、`libs/lume/metal-capability-shim/LICENSE`、`libs/python/{cua,cua-fleet}/LICENSE`、`libs/typescript/{computer,core,fleet}/LICENSE`）：

1. **`libs/python/som/LICENSE` = AGPL-3.0-or-later**（完整未修改的 AGPLv3 文本，含第 13 节 "Remote Network Interaction"）—— 可选包，2026-09-29 已标 deprecated。
2. **`…/cua-perception/models/licenses/AGPL-3.0-only.txt` = AGPL-3.0-only** —— 对应 OmniParser 图标检测器（来源 `microsoft/OmniParser-v2.0`，revision `6600256cb0f1b07651e3bc86166196307bad7e2d`；维护者 2026-09-24 决定以 AGPL-3.0-only 分发，自注 "This is a maintainer decision, not a legal opinion"）。
3. **`…/models/licenses/Apache-2.0.txt` = Apache-2.0** —— 对应 PP-OCRv5 检测/识别模型（上游含 Ultralytics YOLO 系；"Ultralytics sells separate commercial licenses. Cua cannot grant any right beyond the AGPL-3.0 terms"）。

来源：https://raw.githubusercontent.com/trycua/cua/main/LICENSING.md · https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/docs/perception-third-party-notices.md

**AGPL 的触发条件（官方原文警告，按原样对待）**：

> "The extension is not MIT licensed. Its OmniParser icon detector is AGPL-3.0-only… redistributing the extension, or offering it to users over a network, can require you to provide the AGPL corresponding source. If your organization does not accept AGPL components, do not install the extension."

`cua-perception` 是 `cua-driver` 的**可选扩展**，默认安装**从不下载**它；不装则 `parse_visual_regions` 返回 `not_installed`，Driver 本身仍是 MIT。
https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/README.md

**其他边界**：通过 **ClawHub 发布的每个 skill 副本按 MIT-0 分发**（仓库仍是 MIT）；`cua-driver` 的 Rust workspace crates 与缺失 license 字段的 Python 包已在 CI 中补声明 MIT，并有 `ci-spdx-headers.yml` 强制 SPDX 头；`computer-server` 单包 PyPI `info.license = "MIT"`；`@trycua/computer`/`@trycua/fleet`/`@trycua/core` 均 MIT（带 SLSA provenance）。**没有找到** BSL / SSPL / Commons Clause / source-available / field-of-use / 商业限制条款，根目录也**没有 NOTICE 文件**。

---

## 8. 成熟度信号

| 指标 | 值 | 来源 |
|---|---|---|
| stars / forks | 27 479 / 1 925 | https://api.github.com/repos/trycua/cua |
| contributors / open issues | **132 个账号**（含 bot；Top `f-trycua` 1670、`ddupont808` 839） / **1 003** —— 官方原文："The issue tracker is an intake queue and historical record, not a promise that every open item is scheduled or ready for implementation." | `…/contributors?per_page=100&anon=1` · `CONTRIBUTING.md` |
| 最新 commit / 签名 | 2026-09-29T22:52:32Z，**PGP verified** | https://api.github.com/repos/trycua/cua/commits?per_page=5 |
| 发版模型 / `Latest` | `release-please` 按组件独立发版（`tag-separator: "-"`，`draft: true`），同一 tag 同时发 GitHub Releases + PyPI + npm；`/releases/latest` 指向 `sandbox-v0.8.0`（2026-09-15），**不是**最新 driver | `release-please-config.json` · `…/releases/latest` |
| **代码签名** | macOS：Developer ID（team-id `YCK386LBJ7`）+ Notarized + stapled，含 Node runtime addon 的裸 Mach-O；**Windows：每个 zip 里每个 PE 文件都有 Cua AI, Inc. 的、带时间戳的有效 Authenticode 签名**；发布前（`source: artifacts`）与发布后（`source: release`）各校验一次 | `.github/workflows/cua-driver-release-signatures.yml` |
| `@trycua/computer` 0.2.1 / `@trycua/fleet` 0.1.2 / `@trycua/core` | 均 MIT，带 **SLSA provenance**（`predicateType = https://slsa.dev/provenance/v1`）与 registry signature（keyid `SHA256:DhQ8wR5APBvFHLF/…`） | https://registry.npmjs.org/@trycua/computer |
| PyPI 签名 / 成熟度标签 | 抽查的每个 wheel/sdist 都是 `has_sig: false`；`cua-sandbox` = **Alpha**，`cua-bench`/`cua-cli`/`cua-driver` = **Beta** | https://pypi.org/pypi/cua-driver/json |

**付费 / 托管服务（确有，但 OSS 核不需要）**：Cua Fleet 按量计费，公开单价 **CPU $0.044625/vCPU/hour、Memory $0.0223125/GiB/hour**；营销页称 "SOC 2 Type I · BYOC available · MIT licensed · On-prem available"（https://cua.ai/#pricing）。`cua-sandbox` 的 PyPI 描述原文 **"Cloud by default."**，部分包需私有 wheel index（`--extra-index-url https://wheels.cua.ai/simple`）。`cua-cli` 认证走 OIDC device authorization（`https://auth.cua.ai/realms/cyclops-cs`），token 存 OS 凭据库；旧 `https://api.cua.ai` API-key 通道已 legacy。**本地路径（Cua Driver / computer-server / QEMU 容器）不需要任何 key 或账号。**

**默认遥测（两处，都是 opt-out）**：Cua Driver 的 content-free telemetry 默认开启（`cua-driver telemetry disable`）；Lume 默认开启，记录 pseudonymous installation / release / command / API-event 元数据（不采集 prompt、VM/镜像名、文件路径、命令参数、VM 内容），`lume config telemetry disable` 或 `LUME_TELEMETRY_ENABLED` 关闭；`cua-core` 把 `posthog>=3.20.0` 作为硬依赖。
https://raw.githubusercontent.com/trycua/cua/main/libs/lume/README.md

**负向结果（同样重要）**：`registry.npmjs.org/@trycua/cua` → **404**、`/@trycua/lume` → **404**；`pnpm-workspace.yaml` → 404；`licenses/AGPL-3.0.txt` → 404；`libs/lume/Cargo.toml` → 404（lume 是 Swift）；根目录**没有**无扩展名 `LICENSE`、`LICENSE.txt`、`NOTICE`、`COPYING`（只有 `LICENSE.md` 1069 B + `LICENSING.md` 6402 B）；`api.github.com/repos/trycua/cua-train` → 404；`cua-driver-rs 0.30.4 darwin-universal.tar.gz` 的 GitHub build-provenance attestation → **404**（签名走 Authenticode / Developer ID，不走 attestation）。

**pre-1.0 churn 的硬证据**：① contract manifest 自标 `"experimental": true`，`release-please-config.json` 对 3 个包设 `bump-minor-pre-major: true`；② `fix(cua-driver)!: … (#3873)` 是**带 `!` 的破坏性变更**，移除 `element_index`/`snapshot_id`，只接受 `element_token`（CHANGELOG 另有 0.26.0 "ClickInput now requires target, position, and delivery_mode"、0.11.0 "replace language MCP clients with Rust SDKs"）；③ **有一次版本撤回**：`[0.13.0] (2026-07-28) > Retracted: 0.13.0 was published unintentionally and is not supported.`，另注 0.30.1 的改动也在从未发布的 `cua-driver-rs-v0.30.0` tag 里；④ 2026-09-26 → 09-28 **三天发了五个版本**（0.30.0–0.30.4）；⑤ 2026-08-13 才修好「**Fleet 上 Windows image 从来没成功启动过**」的固件 bug，PR 自陈 "This code path has never been able to boot a Windows image on Fleet."，且相关集成测试 `skipif(not os.environ.get("CUA_API_KEY"))` 在 CI 里**全程跳过**；⑥ 文档里仍有已失效的旧路径，`computer-server` 自己 README 的文档链接也已跳到无关页面（当前文档站**没有** computer-server 页）。
https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/rust/CHANGELOG.md

**Windows 支持的现实成熟度（正面与负面都列）**：
- 正面：有**专门的 `Windows` label**（GitHub label id 11958948215），维护者还维护了一份索引 issue **#3442 "Cua Driver/Windows: Consolidated issue map and maintainer priorities"**；`repo:trycua/cua windows in:title` 命中 **379** 条；`cua-driver autostart` 在 Windows 上最成熟（"Windows registers a logon Scheduled Task. macOS and Linux currently print manual-recipe guidance."）；CI 里有 Windows 交互式桌面 lane（`scripts/CI/Windows/run-rust-e2e.ps1 -RequireGui`）与 Session 0 拒绝契约测试。**Windows guest 也确实能启动并跑 GUI 应用**：官方 Minecraft 配方记录本地 **热启动约 30 秒**，guest 内 `cua-driver` 的 `list_tools()` **通告 55 个工具**；Fleet 侧实测 `cua-windows-2022` guest 为 "Windows Server 2022 Standard Evaluation, build `10.0.20348.0`"，`computer-server` 返回了合法的 **164,398 字节 PNG 截图**（冷 claim 绑定耗时 487 秒）。
- 负面：backlog 里有大量**尚未收敛**的 Windows 输入层问题（见第 9 节选项 B 的第 7/8 条；其中 #3449 是 P0、#2218/#2015/#3179 是 P1）；**没有任何一条 Windows guest 的 QEMU 集成测试在 CI 里真跑过** —— PR #4372/#4373（2026-09-30，仍 open）的作者自述 "A Windows QEMU guest integration run was not available in this environment"。

来源：https://github.com/trycua/cua/issues/3442 · https://cua.ai/docs/how-to-guides/sandbox/minecraft · https://cua.ai/docs/how-to-guides/sandbox/run-codex-native-computer-use-on-windows-fleet · https://api.github.com/repos/trycua/cua/pulls/4372

**关于 `prerelease` 标签的说明（避免误判）**：`cua-driver-rs-v0.30.4` 在 GitHub 上被标为 `prerelease: true`，但 release body 解释：「GitHub's label is used only to keep this monorepo's repository-wide "Latest" pointer from switching between independently released products. A plain Cua Driver SemVer is a stable release; npm and PyPI publish it on their normal stable channels.」→ **0.30.4 应视为 stable**。
https://api.github.com/repos/trycua/cua/releases/tags/cua-driver-rs-v0.30.4

---

## 9. 对 cyberboss 的集成推演

### 9.0 现状锚点（来自本仓库文档，非推测）

- 端口：WeFlow 5051、UIA 桥 8776、DSH GUI 3080；**「桥必须跑在隔离会话内」** —— `docs/2026-09-28-handover.md`
- 隔离账号 `cwinprobe`；任务 `cwin-s1-bot`、`cwin-weflow-guard`、`cwin-s1-rdp-keepalive`（5 分钟保活）
- 已知坑：**「不要用 schtasks.exe 起可见程序」**（会闪窗，改用 `Schedule.Service` COM）；**跨账号读不到隔离会话里桥进程的命令行**（导致 `already_running_unknown_pid` 回滚）
- 写侧基线：UIA 发送单条 ~11.6 s 固定流水线（搜索稳定 2s + 选中确认 2s + 输入 + 渲染 + 账本观察）；`/api/send` 串行占用已从 36 250 ms 压到 5 531 ms

### 选项 A：Linux 宿主 + Windows guest VM（QEMU/Hyper-V），WeChat 跑在 VM 里

- **支持证据**：`Image.windows('11')` / `libs/qemu-docker/windows`（VERSION 0.1.3）就是为一件事存在的——把 Windows 桌面放进容器/QEMU，并用 computer-server（5000 端口）+ noVNC（8006）暴露出来。`Image.windows()` 在 Windows 宿主上首选 **Hyper-V**。这**正面解决**了「不占用户物理桌面」的原始诉求：VM 有自己完整的交互式桌面，无需 mstsc 保活、无需第二个 Windows 账号、无跨会话命令行不可读问题，且整机可复制 → **顺带解决「可移植到另一台机器」**。
- **反对证据**：
  1. **没有一键脚本**。该路径要求自己 `docker build`（base `trycua/windows-local:latest` 本身还要先 build，见 PR #551 步骤 1）、准备 `setup.iso` / Windows ISO、`--cap-add NET_ADMIN`、`/dev/kvm`。
  2. 需要用 noVNC 或 computer-server 在 VM 里**完成微信扫码登录**（文档没有任何微信相关先例）→ `未证实`。
  3. 微信在 VM 里属于新设备环境，风控未知 → `未证实`（见第 10 节）。
  4. 读侧 WeFlow 与 `wcdb_api.dll` 必须能在 VM 里复现；已有文档记录 WeFlow 原生组件曾出现 `-105` 离线防回拨状态损坏，且历史上靠杀软/EDR 排除项与重装解决 —— 换环境等于把这条已排掉的雷重新埋一遍。
  5. Windows licensing：官方明确「**Published Windows images do not include production or commercial Windows licensing. Bring your own appropriate Microsoft license…**」（`os-image-catalog`）。示例镜像用的是 `win11x64-enterprise-eval`（**评估版**，有到期限制）。
  6. 需要 Linux 宿主（Windows 宿主 + Hyper-V 是另一条已声明但更少证据的路；`runtime-support` 只写了一行 "Hyper-V when available on Windows"，没有 how-to）。

### 选项 B′（新发现，值得单独评估）：保留 RDP 建会话，但让 mstsc 可以断开

- 如果本机走的是**标准 Windows RDP**（而非 RDPWrap 的补丁），那么官方明确 **`Disc` 状态已足够**。这意味着可以把「保持 mstsc 连接且不最小化」这条约束删掉，只保留「RDP 服务 + 一个已登录的交互式会话」。
- 组合方案：**RDP（建会话，可断开） + Cua Driver（会话内的自动化）**。这比「RDPWrap + mstsc 常连 + 手写 UIA 桥」少一个常驻 GUI 客户端和一套 keepalive 任务。
- 仍未解决：会话号漂移、跨账号命名管道拒绝、微信 UIA 树可用性 —— 前两条在选项 B 的反对证据里已列。

### 选项 B：同一台 Windows 机器上跑 Cua computer-server / cua-driver，驱动「隐藏/虚拟桌面」

- **支持证据**：
  - `cua-driver` 官方支持 Windows 10/11，PowerShell 一行装、**不需要管理员**，Node/TS 侧有 `@trycua/cua-driver`（含 `win32-x64-msvc` / `win32-arm64-msvc` optionalDependencies），所以 cyberboss 这个 CommonJS 项目**不必引入 Python**。
  - 默认 `delivery_mode: background` + 设计目标即 **"operate an app in the background while the developer keeps coding… The visible agent cursor is an overlay; the real mouse pointer stays where the user left it."**
  - 有官方 Windows 后台示例：WPF 应用、Windows 桌面 app 填单打票、Claude Code 构建 WPF CRM 后回归验证。
  - 按 `element_token` 的 accessibility 路径是**可验证的**（`effect: "confirmed"` 需要 AX 回读），比现在「注入 Enter 然后轮询账本观察」的 11.6 s 流水线在语义上更干净。
- **反对证据（决定性）**：
  1. **它不创造虚拟桌面**。第 4 节已核实：Windows 上必须挂**已存在的**交互式桌面会话。因此若要保持「不占用户前台」，**仍然需要第二个 Windows 会话**——也就是仍然需要 RDPWrap / mstsc 那一套来**造出**这个会话。**Cua 替换掉的是 8776 那个 UIA 桥，不是 RDPWrap 虚拟屏幕。**
     - 唯一实质性的减负：官方确认 **`Disc`（已断开的 RDP）会话仍然有效**，所以如果这个第二会话是用常规 RDP 建的，就**不需要让 mstsc 一直连着且不最小化**——这确实干掉了 cyberboss 目前最脆的一环（`cwin-s1-rdp-keepalive` 5 分钟任务 + 必须保持窗口不被最小化）。但注意：RDPWrap 的价值恰恰在「Windows 家庭版/单用户版也能多会话」；如果本机 RDP 本来可用，这一条是净收益，否则不成立。
  2. 官方 SSH 文档推荐的拓扑（交互式会话里的 daemon + 命名管道）与 cyberboss 今天的做法**同构**，只是把「800 行 Python + pywinauto」换成「Rust + MCP」。收益是工程质量，不是架构简化。
  3. 命名管道**按账号私有**，跨账号连接 `Access is denied`；cyberboss 恰好横跨 `cwinprobe` 与主账号 —— 这比今天的「跨账号读不到命令行」更硬：**要么统一账号，要么再加一层代理**。
  4. 微信 Windows 客户端的 UIA 树质量 `未证实`。反证：cyberboss 自己选择「读走 WeFlow（本地 DB/HTTP）、写才走 UIA」，这个架构选择本身就暗示 UIA 不足以可靠读消息。
  5. 升降权边界：官方把 elevated-integrity 标为 platform boundary（"a lower-integrity process cannot generally inject input into a higher-integrity target"，未来只是「检测并证明拒绝」而不是绕过）。若 WeChat 以提升完整性运行，后台注入会被结构化拒绝。
  6. **是否与微信兼容完全未证实**：Cua 的 Windows canonical coverage 列的是 Electron / Tauri / WPF / WinUI 3 / WebView2。微信 Windows 客户端是自绘 DirectUI 系（`WeChatAppEx` / `WeChatOCR` 一类），**不在已验证名单里**。必须自己 POC。
  7. **【对 cyberboss 最致命的一条】open issue #2083：「RDP clients drop text input」。** 原文：`type_text` "fails silently against RDP clients … because the RDP client's input handling is scancode-based, not Unicode-based"，且 "right now the only known working path requires genuinely stealing foreground focus, **which breaks the no-foreground contract**"。cyberboss 的隔离会话**恰恰**就是 RDP 造出来的 —— 这条 issue 直指本项目的核心组合，且状态是 **open（P2）**。若它成立，选项 B/B′ 的写侧（输入文本/回车）在 RDP 会话里要么静默失败，要么退回抢占前台 —— 而抢占前台正是我们要消灭的东西。
     https://github.com/trycua/cua/issues/2083
  8. 其他已记录的 Windows 行为坑（都影响写侧）：background click 上的 `modifier` 被丢弃；带 `element_token` 的 `scroll` 在 Windows 上**当前是 no-op**；Windows ARM64 的原生 ConsoleHost 被**硬拒绝**；从标题栏/边框起手的拖拽返回 `background_unavailable`；UIA `CoCreateInstance` 超时（实测 >4000ms）时会退回 Win32-only 枚举（issue #3895）。另有一条 P0：进程内 TypeScript SDK 在显示缩放下会抓到 DPI 虚拟化后的像素（issue #3449，修复 PR #3450 仍 open，native lane 用例 42/43 复现失败）。
     https://github.com/trycua/cua/issues/3449 · https://github.com/trycua/cua/issues/3895

### 选项 C：保留 WeChat 在本机，但彻底停止 UI 自动化

- 支持证据是**负向的**：第 4/9 节所有证据都指向「在单台 Windows 机器上，不占用户桌面地驱动 GUI 应用，今天没有现成方案」。
- 前提是把写侧换成非 GUI 通道（官方 bot 通道 iLink 已经是这样），即：小号/大号 GUI 通道整体退役。这**不是** Cua 能帮忙的方向；列出它是为了让「换 Cua」与「砍掉 GUI 通道」这两个决策不被混为一谈。

### 推荐的最小验证（POC），按性价比排序

1. **最便宜、信息量最大**：在**当前隔离会话里**装 `cua-driver`，只跑只读，判断微信客户端是否可被 UIA 触达 —— `cua-driver call list_apps`（看 Weixin.exe 是否在列）、`cua-driver call list_windows --pid <Weixin pid>`、`cua-driver call get_window_state --pid <pid> --window-id <hwnd>`，看 `elements[]` 是否非空、是否包含会话列表/输入框/发送按钮。
2. 若第 1 步可用，**必须先复现/排除 open issue #2083**：在这个 RDP 会话里试 `type_text` 与 `press_key`（回车），看 `effect` 是 `confirmed` 还是 `suspected_noop`/`refused`，并**同时观察用户前台窗口与真实指针有没有被动**。若 `type_text` 在 RDP 会话静默失败，选项 B 直接出局。
3. 若第 1 步 UIA 树不可用：只剩选项 A。先做离线验证——把 WeFlow + Weixin 装进 `libs/qemu-docker/windows` 风格的 VM，确认 ①微信能扫码登录并稳定在线 ②WeFlow 的 `wcdb_api.dll` 在该环境能过 bootstrap。

> 注意：`cua-driver` **不能读写文件、不能执行命令**（官方："Cua Driver does not read or write files directly. It drives the apps that open those files."）。POC 里需要读文件/跑命令的部分，要么另起 `computer-server`，要么用项目现有通道。

---

## 10. Cua 明确不解决的问题（对 cyberboss 的缺口清单）

1. **Windows 上不提供虚拟/无头显示器**，必须有一个**已存在**的交互式桌面会话（物理 console / RDP）。→ 若目标是「干掉 RDPWrap」，Cua Driver 单独用**做不到**。
2. **微信客户端不在已验证应用清单内**（Cua 的 Windows canonical coverage 是 Electron/Tauri/WPF/WinUI 3/WebView2）；自绘控件能否给出可用 UIA 树 `未证实`，必须自行 POC。
3. **扫码登录自动化没有先例**：官方教程只有 Calculator / LibreOffice / Inkscape / Gnumeric / WPF CRM / legacy postal app / Windows 填单打票；**微信风控 / 设备指纹更无任何一手资料**（VM 或容器里跑微信是否会封号，风险由项目承担）。
4. **读侧（WeFlow）完全在 Cua 之外**：Cua 不提供 WCDB 解密 / 本地消息库读取。`get_window_state` 理论上能读 UI 文本，但那是**替代** WeFlow 而非集成，可用性 `未证实`；且已有 `wcdb_api.dll` → `-105`（"离线防回拨状态损坏或无法安全保存"，历史上靠杀软/EDR 排除 + 完整重装恢复）记录，**换环境等于重新暴露**。
5. **Windows licensing 由使用者承担**：官方原文 "Published Windows images do not include production or commercial Windows licensing. Bring your own appropriate Microsoft license covering your intended use, including the applicable hosting and virtualization rights."；示例镜像是 `win11x64-enterprise-eval`（评估版，有到期限制）。
6. **GPU / 显示需求已知很弱**：官方 Minecraft 配方记录 guest 的 GPU 是 **"Microsoft Basic Display Adapter"，只提供 OpenGL 1.1**（无 3D 加速）；本地 Windows guest 需要**硬件虚拟化**——"a Linux x86_64 machine with `/dev/kvm`, or an Intel Mac"，且配方用 `-cpu host`，而 QEMU 只在 KVM/HVF 下接受它（**Apple Silicon 上跑 x86_64 guest 走 TCG 时 `-cpu host` 直接被拒**）。QEMU Windows Dockerfile 里没有任何 GPU 直通参数。微信是否依赖 GPU 渲染 → `未证实`。
7. **AGPL 边界**：`cua-perception`（OmniParser 图标检测器，AGPL-3.0-only）与 `libs/python/som`（AGPL-3.0-or-later，已 deprecated）不可随意安装 / 再分发 / 网络提供。MIT 的 `cua-driver` 核心不受影响，但**别把 perception 打进分发包**。
8. **pre-1.0 破坏性变更**：`#3873` 直接移除 `element_index`/`snapshot_id`；跟 main 会持续吃 `!` 变更。建议钉版本、用 `cua-driver check-update` 而非自动升级。**默认遥测两处都开启**（见第 8 节），需显式关闭。
9. **命名管道 / 账号模型与 cyberboss 的跨账号现状冲突**：官方明确跨账号 `Access is denied`，**同 SID 是硬前提**。
10. **`cua-driver` 不能读写文件、不能执行命令**：要文件/shell 必须另跑 `computer-server`（Python）。

---

## 未证实 / 未能回答的问题（显式列出）

1. **Windows 宿主上用 Hyper-V 承载 Windows guest 的完整步骤、最低硬件、嵌套虚拟化要求** —— `runtime-support` 只有一行 "Hyper-V when available on Windows"，无 how-to。
2. **官方 winget / MSI / Chocolatey 包是否存在** —— docs 与 release assets 中均未见；另核查了 `TryCua`/`Cua` 两个 publisher 目录与 Id 子串搜索，但**不能排除**改名的第三方包。
3. **微信 Windows 客户端的 UIA 树质量**，以及 Cua Driver 能否在 background 模式完成「搜索 → 选中 → 输入 → 发送」全链路。
4. **在 QEMU/Hyper-V Windows guest 里运行微信的可行性与封号风险。**
5. **`cua-driver` 在 Windows 上创建独立 desktop object / WindowStation 的能力**（文档只到 Session 0/1 的会话边界）。
6. **是否有可自托管的 Fleet 控制面**（后端是 KubeVirt；仓库有 Kustomize + CRD 但**无 Helm chart**，对外只见托管 `run.cua.ai`；官方 IaC 只有 Terraform provider）。
7. **`cua-sandbox` 的确切当前版本**：`runtime-support` 页写 0.8.0，`image` 页写 0.7.0（`.release-please-manifest.json` 写 0.8.0，故本报告取 0.8.0）。
8. **Cua Driver 在 Windows 上的完整 59 工具清单** —— manifest 抓取被截断，只逐个核对了 22 个；`mcp-tools-windows` 页同样被截断。
9. **VM 内 WeChat 与宿主 WeFlow 的连通方案**（端口映射 / 网络模式）—— 无一手文档。
10. **`cua-driver` 安装到 `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin` 这一确切路径**、以及 **`trycua/windows-local` base image 的内部构成** —— 均来自并行调研分支引用的 `install.ps1` / PR #551，本次未在主文档二次核实。
11. **GitHub 发布的 release 总数与最老 release 日期** —— 并行调研触发未认证 60 次/小时限流（`page=10` 起 403）。
12. **`type_text` 是否真的会在 cyberboss 这个 RDPWrap 会话里失败** —— issue #2083 描述的是「RDP 客户端」的通用缺陷，但没指明是 RDPWrap 的 loopback 客户端还是微软原生 RDP，也没指明 Windows 版本。**只能实测**（本报告把它当**否决性风险**对待）。
13. **headless 的边界**：官方只在 Linux 上承认 headless（且要用户自己起 `Xvfb`）；Windows 侧完全**没有** headless / 虚拟显示器 / 分辨率文档（`headless.md` 404）。所以「Windows 不能 headless」是**文档与源码的强负向证据**，而非一份明确的「不支持」声明。
14. **微软 Basic Display Adapter（OpenGL 1.1）能否跑微信**；以及**锁屏 / 已注销 console 下 `cua-driver` 是否有任何可用行为**（issue #1745 open，仅为愿望）。

---

## 结论（对 cyberboss 的可行性判断）

**一句话：把 RDPWrap 换成 Cua —— 今天不可行，而且方向错了；但 Cua 值得用于替换 8776 那个手写 UIA 桥。**

**1. Cua 不解决「虚拟屏幕防抢占」这个原始诉求。** Cua Driver 在 Windows 上**要求一个已存在的交互式桌面会话**；它既不创建虚拟显示器，也没有 Session 0 / headless 模式。官方给出的「跨会话」方案（交互式会话里的 daemon + `\\.\pipe\cua-driver` 命名管道）与 cyberboss 今天用 RDPWrap + mstsc 维持第二个会话的做法**语义完全一致**——你仍然需要一个活的交互式会话，仍然需要某种机制让它活着。**RDPWrap 的替代品 Cua 提供不了**；替代品是「Windows guest VM」（选项 A），那是 Cua 的另一条产品线。

**2. 选项 B 在今天也拿不到「不占用户前台」这个收益 —— 而且 open issue #2083 直指它的死穴。** 因为第 1 点，选项 B 的实际形态是「隔离会话（RDP 造的）里装 cua-driver daemon，8776 桥换成 MCP 调用」。但 **#2083（open, P2）明确记录：`type_text` 对 RDP 客户端静默失败**，因为 RDP 客户端的输入处理是**扫描码（scancode）而非 Unicode**，而「唯一已知可行路径需要真正抢占前台焦点，**这违反 no-foreground 契约**」。cyberboss 的隔离会话恰恰是 RDP 造的，而写侧的核心动作就是**输入文本并回车**。所以选项 B 的净收益（结构化 `effect` 回读、`element_token` 定位、Rust 稳定性、去掉 800 行 Python + pywinauto）要先扣掉三笔：① **同账号硬约束**（命名管道只授予 daemon 属主 SID，与现在横跨 `cwinprobe`/主账号直接冲突）；② **RDP 输入缺陷**（#2083）可能让写侧要么静默失败、要么退回抢前台；③ `cua-driver` **没有文件/shell 工具**，文件与命令仍要另跑 `computer-server`。**这是「有条件值得做的重构」，不是「解决 RDPWrap 脆弱性」。**

**3. 选项 A 是唯一真正解决原始诉求的路径，但它是一次架构搬迁，不是替换一个组件。** `libs/qemu-docker/windows`（VERSION 0.1.3，`win11x64-enterprise-eval`，8G/8核/30G，5000=computer-server，8006=noVNC）＋ `Image.windows()` 的 Hyper-V/QEMU 选择器，确实提供了「一台自带完整交互式桌面、与宿主完全隔离、可整机复制」的 Windows。它能一次性消掉：mstsc 保活、`cwinprobe` 跨账号、`tasklist.exe` 闪窗、会话号漂移、以及可移植性。代价同样明确：没有一键脚本，需要自己 build base image + 提供 Windows ISO/授权，需要重新验证微信扫码登录与风控、WeFlow 的 `wcdb_api.dll` bootstrap、以及 VM 网络下 WeFlow 5051 的连通方式。

**因此，要让 Cua 变成可行，必须先满足以下任一前提：**

- **前提 A（推荐先验证，但有一条否决性风险）**：在**当前隔离会话**里装 `cua-driver`，跑 `list_apps` / `list_windows` / `get_window_state` 三个只读调用，确认**微信客户端的 UIA 树非空且能定位会话列表与输入框**；若成立，**紧接着必须专门验证 #2083**（在这个 RDP 会话里 `type_text` 是否真能落进微信输入框）。这两步都过，选项 B 才有实质重构价值（但**不替代** RDPWrap）。任一步不过 → 选项 B 出局。
- **前提 B**：接受把 bot 与 WeChat 一起搬进 **Windows guest VM**（Linux 宿主 + QEMU/KVM 容器最省事），并**先离线验证两件事**：①微信能在该 VM 里扫码登录并长期在线且不触发风控；②WeFlow 的 `-105` 类原生组件问题在 VM 里能过 bootstrap。两者都过，选项 A 成立；任一不过，项目应当回到「保留 RDPWrap」或「砍掉 GUI 通道、只留官方 bot API」。
- **明确不建议**：把「换 Cua」当成「去掉 RDPWrap」的同义词来做。这两件事在 Cua 的当前能力边界下**是正交的**。
