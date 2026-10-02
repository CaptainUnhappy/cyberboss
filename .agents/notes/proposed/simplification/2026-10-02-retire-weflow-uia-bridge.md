# Agent Note: 退役 WeFlow UIA 桥：把桌面输入面收敛成 CUA 一家

Status: proposed

## Problem

RDP 隔离会话栈已在 2026-10-01 拆掉（[退役记录](../../implemented/process/2026-10-01-retire-rdp-isolated-session-stack.md)），桌面自动化只剩 CUA 一条实路（`provider: "wechat-cua"`，见 [CUA 写循环笔记](../../implemented/feature/2026-10-01-cua-wechat-write-loop.md)）。但旧输入路径整套还在树里：

- **桥本体**：`scripts/weflow-uia-bridge.py`、`scripts/weflow-uia-search-identity-probe.py`、`scripts/weflow_window_selection.py`、`scripts/weflow-self-manual-e2e.js`、`test/test_weflow_uia_bridge.py`。
- **拉起链**：`scripts/shared-common.js` 的 `ensureWeFlowUiaBridge()`（内含 pid/log 文件、python 探测、30×200ms 等待）、`scripts/shared-start.js:24` 的调用与日志、`scripts/cyberboss-service.ps1:851` 对桥脚本的存在性断言、`scripts/cyberboss-watchdog.ps1:4779` 的桥 healthz 文案。
- **provider 字面量**：`weflow-uia` 在 `src/` 里 40 处、跨 12 个文件；`test/` 里 16 个文件。

它现在**已经是死的**：`CYBERBOSS_ENABLE_WEFLOW_INBOX=false` 时 `ensureWeFlowUiaBridge()` 直接返回 `{status:"skipped"}`（`shared-common.js:437-443`），启动日志里只留一句 `WeFlow UIA bridge skipped`。桥要驱动的那个「隔离会话里的微信」也不存在了。

失败条件（都在过去 48 小时真实发生过）：

1. **每个桌面行为要写两遍**。同一个 provider 门槛漏改连续出现五次——回复路由（`applyWeFlowReplyRoute` 只认旧桥）、「处理中」回执、延迟判定、遗留前缀、延迟重试白名单。第五次直接把 CUA 的补发打到了官方 iLink（`sendMessage ret=-3 invalid arguments`）。留着一个不可达的桌面 provider，就是给第六次留位置。
2. **诊断被死路径污染**。`doctor` 会报一个永远不会 ready 的通道；读代码的人要在两条桌面路径之间反复确认哪条是活的。
3. **换机不可移植**。桥依赖 python + 特定窗口选择策略；CUA 通道只依赖 driver 与微信窗口。

## Proposal

分两步走，先删运行时、再收 provider，两步各自可独立回滚：

**第一步：删掉桥运行时（纯删除，不动 provider 语义）**
删上面列的 5 个文件 + 拉起链 5 处；`shared-common.js` 里与被删函数绑定的 pid/log 常量、`ensureLogDir()` 调用点、`module.exports` 条目同步清掉；服务与看门狗脚本改成不认识桥（不报错、不等待）。删除前先确认没有 markdown 链接指向这些文件（`npm run check-anchors`），与删 `scripts/isolated-session/`（25 个文件）时同一条纪律。

**第二步：把 provider 面收敛成「一个可写、一个只读别名」**
可写的桌面 provider 只有 `wechat-cua`。`weflow-uia` 降级为**只读历史别名**：只允许出现在读旧状态的地方（`deferred-system-replies.json`、`reply-obligations.json` 里 2026-10-02 之前写入的条目），并且发信路径遇到它必须**大声拒绝**（`legacy provider weflow-uia is not deliverable`），而不是静默失败或走 iLink。其余字面量统一改为桌面 provider 集合判断（`DESKTOP_PROVIDERS` / `REPLY_ROUTE_PROVIDERS` / `isDesktopReplyTarget()`），让「桌面类」只有一个定义点。

迁移顺序（不可颠倒）：先把现有 `weflow-uia` 遗留条目清空/过期，再删字面量；否则旧条目会变成永远送不出的僵尸。**实测（2026-10-02 19:10，`~/.cyberboss/`）**：

| 账本 | 条目 | 其中 `weflow-uia` |
| --- | --- | --- |
| `deferred-system-replies.json` | 10 | 7 条，全部 `exhausted`（已是死行，可直接删） |
| `reply-obligations.json` | 147 | **144 条 live**（另有 3 条 `wechat-cua`） |

144 条 live 义务意味着「谁欠谁一条回复」的账本里绝大多数行属于一个已经不存在、也不可写的通道；退役时必须显式把它们结算成过期（而不是留在账本里等一个永远不来的重试）。

开放问题：只读别名要不要留。倾向留一个版本，因为义务账本里可能还有未结算的历史行；若统计结果是零，就直接硬删。

## Alternatives considered

- **留着桥当后备**——最强论据是「CUA 通道曾被证明会瞎」（`cua-driver` 守护进程死掉时机器人静默失聪），多一条输入路径似乎更稳。否掉的理由是这条后备**物理上已经不存在**：它要的隔离会话微信已经拆了，真出事时它不是后备而是幻觉；而且 CUA 的失聪已经用「快照失败要吵」+ 自愈 + doctor 探针修掉了。
- **一次硬删 provider 字面量**——最干净，代码里再也不出现第二个桌面 provider。否掉的现实约束是旧队列/义务账本里可能还有 `weflow-uia` 行，硬删会让它们变成「读得出、送不出」的僵尸，而这正是本次要消灭的那类 bug。先统计后决定。
- **维持现状（什么都不做）**——论据是桥已经不启动，`skipped` 一行日志不花任何运行时成本。否掉的理由是成本不在运行时而在**每次改桌面行为时的双份判断**，这个成本已经在两天内以五个 bug 付过账了。

## Acceptance criteria

- `rg -n "weflow-uia" src/` 的结果只剩「读旧状态」的位置，且每处带注释说明为什么还认这个字符串；可写路径无一处。
- `npm run check`、全套测试、`npm run verify-notes`、`scripts/verify-portable.js` 全绿；`npm run check-anchors` 无新增断链。
- `doctor` 只报 `ilink` + `wechat-cua` 两个通道，且没有桥探针。
- 一条真机回归：向非当前会话的对端发信 → 拒发（`deliveryUncertain=false`）→ 延迟入账 → 恢复会话后补发成功（本次三证据同一套实验）。
- 被删的 5 个脚本在仓库内（含 docs / notes / 脚本注释）无残留引用。

## Risks

- **旧条目变僵尸**：迁移顺序错了就会造出一批送不出的历史条目。缓解：先统计再删，且发信路径对遗留 provider 大声拒绝。
- **服务/看门狗脚本半改**：`cyberboss-service.ps1` 的存在性断言会让服务启动直接 throw。缓解：与删除同一次提交改完，并真的跑一遍服务包装脚本的语法检查。
- **回滚**：两步各自一个提交，`git revert` 即恢复脚本与拉起链；provider 收敛一步若出问题，回滚不涉及数据格式（只读别名不改落盘结构）。
