# Agent Note: 回复送出后归还前台窗口（UIA 派发不再抢焦点）

Status: implemented

## Problem

每次自动回复都要靠 UI 自动化驱动微信：激活主窗口、选会话、写编辑器、回车。这套动作会把微信拉到前台，**回复完成后就留在前台**——用户正在别的窗口打字时被打断，且没有任何恢复动作。用户反馈：「回复完成后需要恢复窗口 或者还原焦点」。

桥里原本只有单向的 `activate_window()`（用 `AttachThreadInput` + `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` 抢到前台，抢不到就抛错），没有任何"归还"逻辑；文本与图片两条派发路径都在 `dispatch_and_verify` 里各自调它。

## Decision

1. 新增 `current_foreground_window()` / `restore_foreground_window(handle)`：后者做**尽力而为**的归还——句柄为 0、目标窗口已消失、或它本来就是前台时不动作；目标最小化时先 `SW_RESTORE`；`SetForegroundWindow` 被系统拒绝（不拥有当前前台）只返回 False，**绝不抛出**。返回值只用于观测，不影响派发结果。
2. 新增 `foreground_return()` 上下文管理器：进入时记录当前前台，退出时归还。文本与图片两条派发路径都用 `with foreground_return(), uia_com_apartment():` 包住 **GUI 动作那一段**，而不是包住整个 `dispatch_and_verify`——后续的送达确认只读 WeFlow 本地 API，不需要微信在前台，早点归还可以把抢焦点的时间窗压到最短。
3. 归还放在 `finally`，所以派发抛错（目标未确认、UIA 失败）时同样归还：一次失败的回复也不该留下被抢走的焦点。

## Verification

- 桥套件 60 → 67 全绿（`python test/test_weflow_uia_bridge.py`），新增 7 例：文本/图片两条路径都用 `foreground_return` 包住 GUI 动作（且派发抛错时仍归还）、空句柄与"本来就是前台"不动作、窗口已消失不动作、最小化窗口先 `SW_RESTORE` 再激活、Windows 拒绝时不抛异常、`foreground_return` 在异常路径上归还。
- 真机（`tmp/focus-check.py`）：记录前台窗口句柄 → 经桥向 Azzy 派发一条被验证送达的消息（`dispatched: true, verified: true, localId: 29`）→ 在 +1.5s 与 +35s 两次读取前台，句柄与派发前一致（262824，未变化）。+35s 那次覆盖的是机器人自己回复的派发路径，即两条路径都归还了焦点。

## Alternatives considered

- **在 `dispatch_and_verify` 全部结束（含送达确认）后再归还**：最强理由是"一次操作一次归还"最直观、改动点唯一。否决原因：确认轮询最多要等 `timeout` 秒，用户要在这段时间里一直看着微信留在前台，而确认阶段根本不需要前台。
- **不归还，改为把微信最小化（`SW_MINIMIZE`）**：最强理由是"眼不见为净"，实现只需一行。否决原因：它会改变用户自己的窗口状态（用户可能故意把微信摆在旁边对照），而且最小化不把焦点还给原窗口，用户仍要自己点回去。
- **用 `SetWindowPos(HWND_BOTTOM)` 把微信压到底层**：不抢焦点、不需要 `AttachThreadInput`。否决原因：它不恢复用户原本的前台窗口——被压下去的只是微信，用户原来的窗口不会因此获得焦点，若它本来就不在最上层则毫无帮助。
- **只对"非 canary"路径归还，canary/exact 路径保持微信在前台**：担心 `require_foreground_continuity` 那组闸门依赖前台连续。否决原因：那些闸门都在 `_dispatch_text` 内部、归还之前执行；确认阶段没有任何前台断言，所以两条路径可以统一。

## Consequences

- **收益**：自动回复不再留下被抢走的焦点；抢焦点的时间窗从"整次派发 + 确认"缩短到"仅 GUI 动作那几秒"；失败路径同样归还。
- **代价**：多两次 `GetForegroundWindow` 与一次可能被拒绝的 `SetForegroundWindow`；用户原本最小化的窗口会被恢复成正常窗口（这是"还原"的应有之义，但确实改变了最小化状态）；归还失败只记录在返回值里，没有告警面——排查时需要看日志或再加观测。
- **未覆盖**：只覆盖桥自己的两条派发路径。任何直接调 `activate_window` 的外部脚本（例如 `tmp/` 下的实验脚本）不受影响。
