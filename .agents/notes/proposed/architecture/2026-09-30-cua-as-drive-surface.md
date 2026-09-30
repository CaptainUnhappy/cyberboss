# Agent Note: 用 Cua 替换 RDPWrap 虚拟屏幕：判为不可行，但留下一条有条件重估的路

Status: proposed

## Problem

现状（事实，见 [RDPWrap 隔离会话部署契约](../../implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md)）用 **RDPWrap + 本地回环 RDP 客户端**给机器人造出第二个交互式 Windows 会话，好让 UIA 驱动微信时不抢用户的桌面。代价与坑已经写满一篇笔记：必须有一个**已连接且未最小化**的 mstsc、一个额外 Windows 账号（`cwinprobe`）、跨账号读不到命令行、会话号会从 4 变 3、以及"顺手 spawn 一个 tasklist 就在用户桌面闪终端"。

用户提出改用 [trycua/cua](https://github.com/trycua/cua)。这个提议背后是一个很合理的期待：**如果 Cua 能提供一个虚拟显示/独立桌面，那么"防抢占"这件事就不用靠 RDPWrap 这种外挂式方案，而且换机时也不用再重建一整套隔离会话。**

所以真正要回答的不是"要不要用 Cua"，而是三个可判定的事实问题：

1. Cua 在 Windows 上能不能**凭空造出一个交互式桌面**（headless / virtual display）？
2. 现状的驱动面（UIA 搜索→选中→输入→回车，加剪贴板发文件）能不能**平移到 Cua Driver 的调用面**上，并且不抢前台？
3. 平移之后，"换机迁移"是否变简单？

## Proposal

**结论先写：本轮判为不可行，且"用 Cua 替换 RDPWrap"这个框定本身是范畴错误。** 依据来自 Cua 官方文档与源码（每条都在下面给了出处），不是推测：

### 1. Cua Driver 需要「已经存在的交互式桌面」，它不造桌面

- Cua Driver 支持 Windows 10/11 作为宿主，安装是 `irm https://cua.ai/driver/install.ps1 | iex`（**不需要管理员**），文档明确要求"an interactive desktop session"（[Drive your first app](https://cua.ai/docs/tutorials/drive-your-first-app)）。
- Windows 的会话边界它自己是写明的：**"A daemon running in the interactive user session can see and operate the desktop; a process launched from OpenSSH in Session 0 cannot."**（[Best-effort background](https://cua.ai/docs/concepts/the-no-foreground-contract)）
- 文档里没有 Windows 的 headless / 虚拟显示 / 分辨率配置页（`headless` 页 404），源码里也没有对应组件。也就是说 **"Windows 上没有虚拟显示"是文档 + 源码双重缺席**，属于强否定证据。
- 唯一真正的"独立桌面"是 **guest VM**：`Image.windows()`（Server 2022，本地走 Hyper-V → Docker 包 QEMU → 裸 QEMU）与 `libs/qemu-docker/windows`（Windows 11 Enterprise **eval**，8G/8 核/30G，:5000 `computer-server`、:8006 noVNC）。这与 RDPWrap 是**同一类东西的另一种实现**（造一个别人的桌面），不是替代品。

**本机实测（2026-09-30，比文档更硬的一条）**：这台机器上 Cua Driver 早就装着并在跑 —— `C:\Users\79388\.cua-driver\packages\releases\0.3.2-x86_64-pc-windows-msvc\cua-driver.exe`，进程 13664 自 09-24 常驻，另有登录任务 `cua-driver-serve`。只读调用直接印证了上面的结构性结论：

- `cua-driver status` → `daemon is running`，socket = `\\.\pipe\cua-driver`（**同 SID 的命名管道**：与双账号结构冲突这条是实打实的）。
- `cua-driver call list_windows` → **38 个窗口，全部属于 session 1**（Chrome / ToDesk / GameViewer / 任务管理器…）。
- 同一时刻 `Get-Process Weixin` → **6 个进程全在 session 3**、`MainWindowHandle = 0`；Cua 的窗口列表里**没有任何微信窗口**，`list_apps` 里也**没有 Weixin**。

也就是说：**Cua 看不到它需要驱动的那个窗口**。RDPWrap 造的隔离会话对 Cua 不是"可替代"，而是"前提" —— 要让它够到微信，就得在隔离会话里再起一个 daemon，而那条路又卡在命名管道跨账号与 `type_text` / RDP 两个未知上（见 §2）。这是**一次可复现的现场测量**而非推测，所以 §4 第 1 条（不动驱动面）在本机属于**已验证**，而不是"暂时不动"。

换句话说：**Cua Driver 与 RDPWrap 不是竞争关系。** RDPWrap 解决"没有第二个桌面"，Cua Driver 解决"在已有桌面上操作得更讲卫生"。现状的 RDPWrap 会话对 Cua Driver 而言恰好是它需要的前提。

### 2. 即便把 Cua Driver 装进现有隔离会话，也有两个 veto 级未知

- **`type_text` 在 RDP 会话里可能静默失败。** 上游 open issue **#2083**：RDP 客户端的输入按 **scancode** 而不是 Unicode 处理，导致 `type_text` 静默无效；唯一已知可行的路是"真的把前台抢过来"，那正好违反 no-foreground 契约。本项目的写侧**就是** type-text + Enter，且会话是 RDP 造出来的 —— 这条不实测不能排除。
- **命名管道是同 SID 的。** `\\.\pipe\cua-driver` 跨账号返回 `Access is denied`，与现状 **cwinprobe / 主账号分账号** 的结构直接冲突。
- 另外两个能力缺口：Cua Driver **没有文件工具、没有 shell 工具、也没有 HTTP REST 面**（官方明确 "does not read or write files directly"）；要文件与 shell 得上 Python 的 `computer-server`（`/cmd` `/ws` `/status` `/mcp`）。现在的桥是自带 HTTP 面的 `scripts/weflow-uia-bridge.py`，迁移到 Cua 意味着把 3650 行里的**发送流程**改写成 MCP 调用，并且额外引入 `computer-server` 才能保住文件发送。

### 3. 值得记下来的两个真收益（即使不采用整体替换）

- **`Disc`（已断开）的 RDP 会话也算数**，所以 mstsc **不必**保持连接/不最小化 —— 这直接削掉现状最脆的一条约束（"客户端一断、一最小化就发不出去"）。
- Windows 上 Cua Driver **不需要任何 OS 权限授予**（TCC 是 macOS 的事），安装不落 MSI/winget，npm 包 `@trycua/cua-driver` 带 win32-x64/arm64 原生件 —— 对一个 CommonJS 项目来说**不需要引入 Python**。
- 许可干净：根仓 **MIT**（[LICENSE.md](https://github.com/trycua/cua/blob/main/LICENSE.md)），唯二例外是已弃用的 `libs/python/som`（AGPL-3.0-or-later）与**可选**的 `cua-perception` 扩展（OmniParser 图标检测器 AGPL-3.0-only，不重分发即可）。没有 BSL/商用限制条款；本地路径不要 API key，Cloud Fleet 按用量计费。
- **可部署性已核实（决定 Option A 的成本量级）**：Docker Hub 的 `trycua` 组织有 16 个公开镜像，`trycua/xfce-cua:latest` 匿名可拉；**但没有独立的 `computer-server` 镜像**（它被烤进 xfce/qemu 系列镜像里）。仓库里没有 Helm chart，自建 Fleet 控制面无文档；唯一的官方 IaC 是一个 Terraform provider（`fleets_pool`）。也就是说 **Option A 走"Linux 宿主 + Docker 化 Windows guest"这条路时，镜像是现成的，但控制面要自建。**
- 成熟度：27.5k stars、最新提交 2026-09-29、release-please 分组件发版；但**pre-1.0 抖动是真的**（契约清单自称 experimental、09-29 有移除 `element_index`/`snapshot_id` 的 `!` 破坏性变更、0.13.0 被撤回、三天里五个 0.30.x）。另外**仓库级 `v0.1.x` 标签是过期的**（最新那个指向 2025-03-17），真正的发版线是分组件标签（`cua-driver-rs-v*` 等）。

### 4. 因此本轮的落地决定

1. **不动现状的驱动面，也不把 RDPWrap 换掉。** 现阶段替换没有可验证的收益，且会把"能在用户桌面上不抢焦点"这个赌注押在一个 2026-09 才起步、有 open RDP blocker 的组件上。
2. **写进架构的一条边界：驱动面必须可替换。** 现状把"怎么驱动微信"焊在 `scripts/weflow-uia-bridge.py` 与 `provider === "weflow-uia"` 里。真正的收益不是选 Cua，而是**让"驱动面"成为一个有窄接口的适配器**（发送 / 只读探测 / 就绪判定三条），这样 Cua Driver、自研 UIA、以及将来任何一条通路都只是实现。这正是可迁移性（[可迁移安装与双渠道一等契约](2026-09-30-portable-install-and-dual-channel-contract.md)）需要的接缝：换机与换驱动面共用同一个窄口。
3. **两个 POC 先做，再做任何重估**（顺序不能换）：
   - **POC-1（决定 Option B 生死）**：在现有隔离会话里装 Cua Driver，`get_window_state` 打微信主窗口，看 UIA 树是否**非空且可寻址**（微信自绘控件多，AX 树可能是空的；若为空，Cua 的语义路径失效，只剩像素路径）。
   - **POC-2（决定 Option B 生死）**：`type_text` 往微信搜索框打字，验证 issue #2083 是否命中本机的 RDPWrap 回环会话；失败且必须前台 ⇒ 与防抢占目标直接冲突。
   - **POC-3（只影响 Option A）**：Windows guest 里跑微信 + WeFlow（`wcdb_api.dll` 引导、扫码登录、风控）能不能活。
4. **真正"杀掉 RDPWrap"的只有 Option A**（微信 + 机器人整体搬进 Linux 宿主机上的 Windows guest VM），而它是一次架构迁移：需要自建镜像、Windows 授权、重新验证微信登录与风控，并且要把 WeFlow 的读侧一起搬进去。**它的收益是真实的**（mstsc 保活、跨账号、控制台闪窗、会话号漂移四类问题一起消失，迁移也变成"搬一个镜像"），而且上游**已经提供 Windows guest 的容器镜像与 noVNC 通路**（`libs/qemu-docker/windows`，Win11 Enterprise **eval**、8G/8 核/30G、`:5000` computer-server、`:8006` noVNC），所以"自建镜像"不是从零开始 —— 但 eval 授权、微信风控、WeFlow 的 `wcdb_api.dll` 引导三件事都还没验证。成本与风险都不是本轮能顺手承担的。

## 依据（一手来源）

本篇的每条结论都有一手出处，逐条的取证过程与 URL 清单在 [Cua 调研报告（2026-09-30）](../../../docs/research/2026-09-30-cua-feasibility.md)（版本锚点：**Cua Driver 0.30.4**，contract `0.8.0`；无法从一手来源确认的一律标 `未证实`）。上面正文只保留判定所必需的那几条，转载时不要脱离版本锚点。

## Acceptance criteria

1. 本轮**不新增**对 Cua 的运行期依赖；`package.json`、`scripts/isolated-session/**`、`scripts/weflow-uia-bridge.py` 不出现 Cua 调用（保持可回退）。
2. 交付一份可执行的 POC-1/POC-2 步骤（含安装命令、`cua-driver doctor` / `list_windows` / `get_window_state` 的具体调用与**判定阈值**：树里必须出现可寻址的搜索框与结果行；打字后必须在只读快照里看到文本），以及"失败即停"的判据。
3. 驱动面适配器的接口在**不做 Cua 的情况下**也能先落地并接到现状实现上（发送 / 探测 / 就绪三条），且 `npm run check` 与现有测试保持通过。
4. 若 POC-1 或 POC-2 失败，本笔记就地更新为"Option B 已否决 + 失败签名"，而不是留一篇悬空的提案。

## Risks

- **把范围搞大**：一旦开始"驱动面适配器"重构，很容易滑向重写 3650 行的桥。约束是只抽三条接口，先把现状实现包进去，不改发送流程的语义（账本、幂等键、`dispatch`/`verify` 的判定都不能变）。
- **Cua 的 pre-1.0 抖动**：破坏性变更与撤回版本都发生过，任何 POC 都要记录**确切的版本号**，否则结论无法复现；这也是"不急着替换"的一个正面理由。
- **POC 会碰真机**：`type_text` 与前台升级都可能打断用户。POC 必须在一个**已暂停保活、且用户知情**的窗口里做（`cwin-s1-rdp-show` 那套开关已经存在），失败即停。
- **命名管道同 SID 限制**：如果将来真走 Cua Driver，现状的"两个 Windows 账号"结构必须重新设计；这条不解决，Option B 连第一步都过不去。
- **许可证误伤**：只有选装 `cua-perception` 才引入 AGPL-3.0-only 的 OmniParser 检测器。本仓是 AGPL-3.0-only，兼容性上不是问题，但"要不要分发/托管"是另一件事；不装即可绕开。
- **本笔记的否定结论有时效**：Cua 上游迭代很快（本轮就发生了破坏性变更），且 #2083 若被修掉，Option B 的成本立刻下降。重估触发条件写死在上面 POC 里。

## Alternatives considered

- **按用户字面要求直接把 RDPWrap 换成 Cua。** 最强理由：现状那套（RDPWrap + 常驻 mstsc + 第二个账号 + 保活/重连/看门狗）维护成本极高，用户每天都在为它付代价；Cua 是"给 agent 一台电脑"的正统现代方案，后台投递（不抬窗口、不动真指针）正是防抢占想要的语义；而且它 MIT、装一句 PowerShell、不需要 Python。否决原因是**它不造桌面**：官方文档要求"already existing interactive desktop session"，Session 0 看不见窗口，也没有任何虚拟显示组件（文档页 404 + 源码缺席）。在现状里换上去，等价于"把 RDPWrap 保留着，再在它上面加一层 MCP" —— 成本增加、四类老问题一个没消。
- **Option B：保留隔离会话，把 8776 桥内部的 UIA 实现换成 Cua Driver（MCP → 适配器）。** 最强理由：不需要动部署形态、不需要 Windows 授权、不需要第二台机器；能直接吃到"Cua 管投递、`effect`/`escalation` 给出可机读的成功判据"这类工程改进；`Disc` 会话可用这一点还能顺手去掉"mstsc 必须常驻"的脆弱约束。否决原因是**它现在卡在两个 veto 级未知上**（微信 UIA 树是否可寻址、`type_text` 在 RDP 会话里是否静默失效 #2083），而且命名管道同 SID 与现状的双账号结构冲突、又没有文件/shell 面（文件发送要另起 `computer-server`）。不是永远不行 —— 是**必须先实测**，所以降级为 POC-1/POC-2 的有条件提案。
- **Option A：微信 + 机器人搬进 Windows guest VM（Hyper-V 或 Linux 宿主 QEMU/KVM），用 Cua 的 `computer-server` 遥控。** 最强理由：这是唯一能一次性消掉 RDPWrap 全部四类顽疾的形态（不再需要 mstsc 保活、不再跨账号、不再有控制台闪窗、不再有会话号漂移），而且**迁移形态最优** —— 换机 = 搬一个 VM 镜像；guest 里的前台输入不碰宿主桌面，防抢占是结构性成立的而不是靠纪律。否决原因是它是一次架构迁移而非替换：要自建 Windows 镜像、自备 Windows 授权、重新验证微信扫码登录与风控、把 WeFlow（读 `wcdb_api.dll`）一起搬进 guest 并重新解决"库密钥 + 锚点"那套；上游对"在 VM 里跑微信"没有任何可行性的说法，风控风险完全未知。**不是不做，是本轮不该顺手做。**
- **方案 C：放弃 GUI 驱动，只保留官方 iLink 通道与其它有 API 的通路。** 最强理由：UIA 驱动是整套复杂度的根源（隔离会话、保活、看门狗、跨账号身份、回声归因都因它而生），砍掉它等于砍掉大半个仓库；官方通道是纯 HTTPS，迁移成本几乎为零。否决原因是官方通道**只能回复、每条出站都要消耗入站带来的 `context_token`**（[实测契约](../../implemented/architecture/2026-09-30-ilink-bot-api-observed-contract.md)），拿不到"机器人主动发起"的能力；而本项目一半价值在 check-in / 主动提醒。作为**双渠道里的降级档**保留：个人号通道不可用时，官方通道仍然是一等公民（这正是"双渠道一等契约"要修的东西）。
- **换一个更彻底的隔离：Windows Sandbox / Hyper-V 的会话隔离 / 独立物理机。** 最强理由：都比 RDPWrap 正统，且都有官方支持。否决原因逐条：Windows Sandbox 每次启动都是全新快照（微信登录态不持久）；Hyper-V 没有"共享宿主桌面又隔离输入"的形态；独立物理机把成本抬到另一档，且用户明确排除过虚拟机（见既有契约的备选节）。保持"RDPWrap 仍是当前最优解"这个判断不变。
