# Agent Note: 桌面输入中央调度台（注册 + 互斥队列 + 目标窗口声明）

Status: proposed

## Problem

隔离会话（session 4）里现在有**多个互不知情的写入者**同时抢同一份独占资源 —— 一个交互桌面只有**一个前台窗口、一个键盘焦点、一个光标**：

- 微信 UIA 桥（`python.exe weflow-uia-bridge.py --port 8776`）：激活窗口、点会话行、`SendKeys("{Enter}")`、必要时 `SetCursorPos`。
- 会话内文件队列 worker（`powershell.exe` PID 32892）：串行跑 `s4\in\*.ps1`，每个脚本自己 `SendInput` / `SetForegroundWindow`（`s4-fg-azzy.ps1`、`s4-traymenu*.ps1`、`type-text.ps1` …）。
- `rdp-keepalive.py`：`SetWindowPos` 挪客户端，探针里 `SetCursorPos(300,300)`。
- 另一个 agent 会话的 CLI 自动化（夸克那套）也在同一桌面。

后果（2026-09-18 实测）：

1. 桥的发送被别的写入者打断 → **502** `WeChat main window could not be activated`。
2. 更糟的是**自锁**：一轮失败已经把"处理中"打进输入框却没按 Enter，之后每一次发送都撞上它自己的前置条件 —— **409** `target not confirmed: confirmed chat input was not empty before dispatch`，回复全部发不出去。
3. 现有"防抢占"只是**事后检测**，窗口极小：`require_no_competing_desktop_input` 只在动作前后各查一次 `LASTINPUTINFO`（120 ms 窗口），挡得住"此刻有人在点"，挡不住"200 ms 后有人要点"。
4. 桌面仲裁在**普通回复路径上完全不存在**：`src/` 从不发 `requireDesktopIdleSeconds` / `desktopInputLeaseRequest` / `desktopInputLease`，唯一生产者是 `scripts/cyberboss-watchdog-model-canary.js`；桥的 `send_lock` 只在**进程内**，跨进程无效；队列的"认领"只是 `Move-Item`（无 owner、无 TTL、无桌面作用域，两个 worker 实例会并发）。

## Proposal

**中央调度台（broker）持有唯一一把"桌面写锁"，所有会动键鼠 / 激活窗口的动作都必须先持锁，并在任务里声明目标窗口。**

分两个里程碑，先做能立刻止血的那个：

**里程碑 1 —— 共享锁 + 三方接入（不做常驻进程）**

- 锁的形态：进程外（命名互斥体或 `LockFileEx` 独占文件，落 `C:\ProgramData\cwin-probe\locks\desktop-s4.lock`），带 **owner**（clientId + pid + 启动时间）、**TTL/心跳**、**目标窗口声明**。
- 三个写入者先接进来：桥（发送全程持锁）、队列 worker（跑每个脚本期间持锁）、`rdp-keepalive.py`（挪窗口/移光标期间持锁）。
- 桥已有的租约实现可直接泛化：`issue_desktop_input_lease`（`weflow-uia-bridge.py:2072`，`os.link` 原子签发）+ `claim_desktop_input_lease`（`:2127-2248`，`.claim` 硬链接、tick 变化即判 STALE）+ 五个错误码 `CANARY_DESKTOP_LEASE_{MISSING,INVALID,UNKNOWN,STALE,ALREADY_CLAIMED}`（`:937` 等）。现在它绑死在 model-canary 的触发/回复文本上，泛化 = 把"canary 专属上下文"换成"任务信封"。
- **接锁失败 = 退回队列重试**（而不是像今天这样 409 直接失败并留下残字）。

**里程碑 2 —— broker 常驻进程**

- 注册表：`clientId → { 会话 id, 可声明的窗口集合, 是否需要前台, 优先级 }`；未注册者不得持锁。
- 任务信封：`{ clientId, desktopId, targetWindow, action, payload, deadline, idempotencyKey }`；队列 FIFO + 优先级 + 超时回收。
- 审计日志：每次持锁记录"谁、目标窗口、动作、结果、耗时"。今天"是谁抢了桌面"完全查不出来，这是唯一能回答它的机制。

**必须在信封里声明目标窗口**：`{ hwnd | 类名 + 标题模式, pid }`。执行者开锁后、动键鼠前校验"声明的窗口就是当前前台/焦点窗口"，不匹配即释放锁并把任务退回队列。

## Open decisions（已问，用户选择：先不做，记入待办）

1. **形态**：先做里程碑 1（文件锁 + 三方接入），还是直接起常驻 broker？→ 推荐里程碑 1。
2. **粒度**：整个桌面一把锁 + 目标窗口作准入校验，还是每窗口一把锁？→ 推荐桌面一把锁（只有一个前台/焦点/光标，按窗口分锁是假并发）。
3. **声明强制度**：硬前置（不匹配即拒绝执行）还是软校验？→ 推荐硬前置。
4. **外来 CLI**：强制 wrapper，还是只检测让路？→ 推荐 wrapper 覆盖我们能启动的进程；未注册的第三方进程拦不住，只能靠审计日志指认。
5. **抢占失败语义**（下游，待定）：退回队列重试，还是立即失败并释放锁？

## Alternatives considered

- **继续加校验、不加锁**：最省事，且看起来"已经在做"（四条 `require_*`）。但它们的窗口是 120 ms 量级，本质是"事后发现被抢"，无法阻止"即将被抢"；今天的自锁说明失败检测不能替代互斥。已否决。
- **按目标窗口分锁**：并发看起来更高。但 Windows 的输入是桌面级单例（前台窗口、焦点、光标各一个），两个"不同窗口"的任务仍会互相夺焦点 —— 假并发，还多一层窗口身份判定。已否决。
- **把互斥做进桥里**：桥活在会话 4、只懂微信；互斥要保护的是"桌面"这一资源，横跨桥、队列 worker、keepalive 和外来 CLI。放进桥等于让最懂业务的那个组件兼职做基础设施，下一次重构就会被带走。
- **靠队列串行就够了**：队列确实串行，但桥的发送走 HTTP 旁路、根本不排队 —— 冲突正来自"有一个写入者不在队伍里"。
- **给第二个 writer 单独开一个隔离会话（session 5）**：结构上最干净，也在讨论中。它与本提案不互斥：调度台解决"同一桌面内的多个写入者"，session 5 解决"根本不该共享桌面"。真要做 session 5，本提案的里程碑 1 仍是必需品（桥、队列、keepalive 三者之间已经会互撞）。

## Acceptance criteria

1. 两个写入者同时请求时，只有一个拿到锁；另一个在锁释放后自动继续，**且不产生任何一次 409/502**。
2. 任务声明的目标窗口不是当前前台/焦点窗口时，执行者**在执行前**拒绝，并把任务退回队列（不是失败）。
3. 锁持有者崩溃（进程被杀）后，锁在 TTL 内被回收，后续任务无需人工干预即可继续。
4. 审计日志能回答："2026-09-18 16:55 那次 409 是谁在持锁？目标窗口是什么？"
5. 桥的"输入框非空"自锁消失：非空时先清空再重试，或作为可重试的前置失败退回队列。

## Risks

- **约定拦不住未注册者**：第三方 CLI 直接 `SendInput` 时锁形同虚设，只能事后指认。真正的强隔离要 Windows 作业对象/独立窗口站，成本高得多。
- **锁的粒度做成串行化瓶颈**：桌面本来就串行，但 TTL 过长会让一次卡死的脚本拖住整个桌面（现有 worker 的 300 s 超时只杀直接子进程，不留清理）。
- **迁移期双轨**：接入顺序（桥 → worker → keepalive）期间仍可能出现"一方持锁、另一方不知情"，需要按写入者逐个切换并观测审计日志。
- **改桥的前置条件语义有回归风险**：把 409 改成"退回队列"会改变调用方（`src/` 与 canary 脚本）看到的失败模式，需要同步更新它们的重试与记账逻辑。

## 状态

用户 2026-09-22 决定：**先不做**，保持 `proposed`。触发条件仍然成立（同桌面多写入者互相抢占），重启条件是两个自动化再次同时运行并出现 502/409。

