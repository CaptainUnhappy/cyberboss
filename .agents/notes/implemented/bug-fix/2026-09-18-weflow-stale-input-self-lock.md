# Agent Note: 微信输入框残字自锁（发送失败后所有回复都发不出去）

Status: implemented

## Problem

发送流程在"文字已写进输入框、Enter 还没按"之后失败时（最典型是 502 `WeChat main window could not be activated`，因为同一个隔离桌面里另一个自动化抢走了前台/焦点），那串文字会留在输入框里。

桥原本把"确认过的输入框必须为空"当作硬前置：`write_chat_input_without_clipboard` 读到非空就抛 `TargetNotConfirmedError("confirmed chat input was not empty before dispatch")` → HTTP 409。于是**一次失败把后续全部发送锁死**：2026-09-18 实测，一条 502 留下的"处理中"让之后每一条出站消息都返回 409，机器人读得到消息、答案生成得出来，却一条也发不出去，持续数小时；账本连续记 `failed` / `failed_uncertain`，`deferred-system-replies.json` 越堆越多。

这条前置本身是对的（保护人手写的草稿），错在**没有区分"人的草稿"和"我们自己上一次失败的残字"**，而且失败不可自愈。

## Decision

`write_chat_input_without_clipboard` 在读到非空输入框时，先调用新的 `clear_stale_chat_input(value_pattern, existing)`：

1. `value_pattern.SetValue("")` 清空；
2. 最长 1 秒内轮询确认读到空值；
3. 把**被清掉的内容写进桥日志**（`cleared stale chat input before dispatch: '…'`），保证不是静默丢数据；
4. 只有清不掉（读回仍非空 / `SetValue` 抛错）才继续抛原来那个 `TargetNotConfirmedError`。

开关：`CYBERBOSS_WEFLOW_CLEAR_STALE_INPUT`，**默认开**。若某个部署里那个窗口真的会有人手打草稿，置 `0` 即可恢复"非空就拒绝"的旧行为（日志里也会说明未清理）。

实测（2026-09-18，修复后立即验证）：桥日志出现 `cleared stale chat input before dispatch: '\n处理中'`，紧接的 `POST /api/send` 返回 **200**（修复前同一条路径稳定 409）。

## Alternatives considered

- **保持"非空即拒绝"，让调用方先清**：把责任推给 `src/` 与 canary 脚本，但它们拿不到 UIA 的 `ValuePattern`，只能靠再发一次键鼠（又一次抢占风险）。否决。
- **无条件清空、不留日志**：能修，但静默删除用户可能真的在写的内容，且出问题时无从追查。否决，改为"记下被清掉的内容"。
- **只在 502 之后清**：更保守，但桥无法可靠区分"上一个失败者是我们"与"有人正在打字"，而且 409 也可能来自别的失败路径。否决。
- **把这条前置彻底删掉**：会让"残字 + 新文本"拼接后一起发出去（把两段内容粘成一条消息），比拒绝更糟。否决。
- **改成退回队列重试**（本仓库另有一篇 proposed 的桌面调度台方案讨论互斥）：语义更对，但需要队列与租约先落地；本次先做能立刻止血的一步。

## Consequences

- 收益：发送失败不再变成永久自锁；回复重新流动；被清掉的内容留在桥日志里可追。修复后第一次真实发送即从 409 变为 200。
- 代价：机器人会在极少数情况下清掉"人正在输入框里打的字"。在这个部署里那是不可能的（隔离会话没有人打字），且开关可关。
- 已知缺口：**根因仍在** —— 两个自动化共享一个桌面造成的 502 没有被这条修复解决，只是它的后果不再是死锁。互斥/调度方案见 [桌面输入中央调度台](../../proposed/architecture/2026-09-18-desktop-input-dispatch-center.md)。
