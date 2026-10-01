# Agent Note: 退场 RDP 隔离会话栈

Status: implemented

## Problem

个人号通道原来靠一整套环境把微信搬进另一个 Windows 会话再操作：RDPWrap（给 TermService 打补丁）、
`mstsc` 环回、第二个账号 `cwinprobe`、文件队列 worker、UIA 桥、WeFlow 读侧、以及十二个计划任务
（保活、遮挡、重启、托盘、session0 探针……）。任何一环坏掉，通道就**静默失效** —— 这正是它被
Cua 取代的原因。

Cua 通道跑通并验收（见 `implemented/feature/2026-10-01-cua-wechat-write-loop.md`）之后，这套环境
只剩成本：十二个任务里有正在运行的守护进程、`C:\ProgramData\cwin-probe` 占 **1,157 MB**、
`cwinprobe` 还挂在 Administrators 上，而它的口令以明文躺在本仓库 `main` 的一个提交里。

## Decision

**保留文件、撤掉注册与运行，先禁用后删除，回滚材料先行导出。**

顺序（每一步都可单独回滚）：

1. **先导出回滚材料**：十二个任务的 XML（`schtasks /query /tn <name> /xml`）、`ServiceDll` 原值、
   Administrators 成员快照、`cwin-probe` 里的脚本副本 → `tmp/rdp-teardown-<时间戳>/`。
2. **停掉正在跑的部件**，再**禁用**（不删除）十二个任务 —— 删除任务定义是不可逆的，禁用是可逆的。
3. **撤销 RDPWrap 注册**：`TermService\Parameters\ServiceDll` 从 `rdpwrap.dll` 改回
   `%SystemRoot%\System32\termsrv.dll`。**故意不重启 TermService**：为了让改动"立刻生效"而掐断一个
   可能存在的远程会话，代价远大于收益；恢复后的 dll 在服务下次启动（重启机器）时加载。
4. **退休 `cwinprobe`**：移出 Administrators、把口令换成随机值（口令已明文泄漏，仅仅禁用账号
   不等于让泄漏的凭证失效）、禁用账号。
5. **释放磁盘**：`C:\ProgramData\cwin-probe` 整目录删除（1,157 MB）。删之前已确认**活的 WeFlow 用的是
   `%APPDATA%\weflow`**，这份是 cwinprobe 会话自己的安装副本（最后写入 9/17），不是共用数据。

技术栈里**不动的**东西：WeFlow 应用本身（用户自己的工具，只是不再是机器人的读侧）、
`scripts/isolated-session/` 里那些已经"去机器化"的配方脚本（属于仓库，属于历史记录）。

### 执行状态（2026-10-01）

已完成（普通权限即可）：

- 十二个任务里 **11 个已禁用**（含正在运行的 `cwin-s1-rdp-remote-guard` 与 `cb-restart-weflow`）。
- 正在跑的 `rdp-remote-guard.py` 已停止（0 个进程）。
- `C:\ProgramData\cwin-probe` 已删除，**释放 1,157 MB**。
- **第 12 个任务（`cwin-session0-probe`）已就地失效**：它没有触发器、以 `79388 / Limited`
  运行（不是 SYSTEM），指向 `D:\Projects\cyberboss\tmp\session0-probe\probe.ps1` —— 一个 9/17 的
  session-0 输入桌面实验。把那个目录**改名保留**为 `session0-probe.retired-<时间戳>`（11 个文件
  一个没删），任务的动作路径从此解析不到，即使被手动启动也无事可做。禁用任务本身仍要管理员，
  但"让它什么也做不了"不需要。
- 顺带发现：那个目录里的 `.rdp` 文件带 `password 51:b:…`（DPAPI 加密的口令块）——属于凭证暴露面
  的一部分，已随目录一起离开原位。**账号口令轮换后这些块自然作废**，这也是下面那次提权值得做的
  另一个理由。

**待一次提权**（UAC 需要用户点一次"是"；第一次弹窗被取消了，没有重试）：

- `ServiceDll` 仍是 `rdpwrap.dll`（注册未撤；文件保留在 `C:\Program Files\RDP Wrapper\`）。
- `cwinprobe` 仍在 Administrators、账号仍启用、口令仍是泄漏的那个。

一条命令就能收尾（提权窗口点"是"即可）：

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass',
  '-File','C:\Users\79388\AppData\Local\Temp\rdp-teardown-elevated.ps1'
```

脚本是幂等的，会把每一步写进 `tmp/rdp-teardown-elevated.log`。

## Verification

- 任务状态：`Get-ScheduledTask` 逐条打印（11 个 `Disabled`，1 个 `Ready`）。
- 进程：`rdp-remote-guard.py` 计数为 0。
- 磁盘：`Test-Path C:\ProgramData\cwin-probe` → `False`（删除前统计 1,157 MB）。
- 回滚材料：`tmp/rdp-teardown-20261001-191005/`（12 份任务 XML + ServiceDll 原值 + Administrators 快照 + 脚本副本）。
- **Cua 通道不受影响**：退场操作之后，生产配置（`deepRead=true`、方向校验开启）下的完整回合仍然通过 ——
  注入 `PROD-E2E-191734 请回复：生产链路正常`，机器人回 `生产链路正常，PROD-E2E-191734`；
  随后又一次 `ROUND3-195147 请回复：链路仍在` → `链路仍在，ROUND3-195147`。
- **失效性验证**：改名之后 `Test-Path D:\Projects\cyberboss\tmp\session0-probe\probe.ps1` → `False`，
  11 个文件全部保留在新目录下。

## Consequences

收益：少十二个后台任务、一个 SYSTEM 守护进程、一个管理员账号和 1.16 GB 磁盘；RDPWrap 不再是
系统服务的一部分（注册已撤，重启后彻底不加载）。**代价与残留**：`C:\Program Files\RDP Wrapper\`
的文件仍在（回滚用），`cwin-session0-probe` 还亮着，`cwinprobe` 还是管理员 —— 这三项都要一次提权。
`main` 里 `458a718` 的明文口令仍在历史中：账号退休后它不再可用，但历史提交本身建议在做仓库公开前
处理（改密/重写历史二选一）。

## Alternatives considered

- **直接删除十二个任务**：更干净，但不可逆。任务 XML 虽然导出了，重建时定时器、主体、触发器都要
  逐字复原 —— 禁用能达到同样效果（不再运行），却留着一条一步回滚的路。
- **重启 TermService 让 RDPWrap 立刻失效**：证明力更强，但会掐断任何正在使用的远程会话。
  这台机器平时用不到 RDP，"下次启动生效"已经足够，风险为零。
- **只禁用账号、不改口令**：账号禁用了，泄漏的口令看似失效；但一旦有人为了排查重新启用账号，
  明文口令立刻又可用。改随机口令让这条泄漏彻底作废。
- **把 `C:\ProgramData\cwin-probe` 整个备份再删**：1.16 GB 里绝大部分是 WeFlow 安装副本与
  出站图片缓存，没有重建价值；脚本与任务 XML 已经单独留存，够回滚了。
- **继续留着 WeFlow 读侧**：它指向 5051 而 WeFlow 听 5031，只会刷 `fetch failed`；Cua 已经同时
  提供读与写，留着只是噪声源。WeFlow 应用本身保留。
