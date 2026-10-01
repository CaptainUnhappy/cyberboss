# Agent Note: CUA 驱动微信写侧闭环（无 RDP、无第二账号）

Status: implemented

## Problem

机器人要"像人一样在微信里说话"，只有两条路：官方 iLink 通道（纯 HTTPS，**只能回复**，每条出站都消耗入站带来的 `context_token`）与个人号桌面自动化。个人号这条路此前靠 RDPWrap 造出的**第二个交互式 Windows 会话**（`cwinprobe` 账号 + 常驻 mstsc + 保活/重连/远控守卫 + 文件队列 + 10 个配方），代价是一整套重依赖：跨账号杀不掉进程、会话号漂移、控制台弹窗、明文密码，以及"客户端一最小化就发不出去"。

用户的要求是**彻底移除 RDP**。此前我判过"不可行"（[Cua 作为驱动面](../../proposed/architecture/2026-09-30-cua-as-drive-surface.md) §5），依据是 0.3.2 版本上"三种输入方式全部投递成功但不生效"。那个判断**建立在错误的前提上**：这台机器装的是 0.3.2，而当前发布线是 0.31.0。

## Decision

### 1. 结论：写侧闭环成立，不需要 RDP、不需要第二账号、不需要提权

升级到 **Cua Driver 0.31.0** 后，在用户自己的桌面会话（session 2）上实测通过完整闭环：

```
window : pid=12920 id=25628362 minimized=false
open   : "Azzy"                                  ← 目标会话未打开
  open    route=global_input mode=foreground     ← 前台点击切换会话（唯一的焦点成本）
  type    route=accessibility mode=background effect=confirmed
  return  route=synthetic_events mode=background
ok     : true
verify : preview row: "CUA-MODULE-ESCALATED-132422"
now open: "文件传输助手"
elapsed: 38 s
```

截图与树双重确认：消息进了聊天（气泡 + 时间戳），会话行预览同步更新，输入框清空。

### 2. 抢前台的真实代价：**每次"切换会话"一次，发送本身零成本**

三级阶梯实测（`scripts/wx-cua-select.js`）：

| 级别 | 手段 | 结果 |
|---|---|---|
| 1 | UIA Invoke（无障碍，后台） | 报 `✅ Performed UIA Invoke`，**窗口毫无变化** —— 与 2026-09-23 那次 mmui 按钮实测一致 |
| 2 | 选中行后 `press_key return`（PostMessage，后台） | 报 `📨 Sent return`，**同样无效** |
| 3 | `click delivery_mode:"foreground"`（SendInput） | ✅ **唯一有效的一级** |

因此成本模型是**结构性的、可预测的**：目标会话已打开 → 零成本；需要切换 → **一次短暂的前台点击**（实测总耗时 38 s，其中绝大部分是快照开销，点击本身是瞬时）。写入与发送都是后台（UIA ValuePattern + PostMessage），从不抢焦点。

### 3. 读侧：CUA 是更好的"眼"，但替代不了 WeFlow

同一棵树上可寻址的东西：会话列表 16 行 `ListItem`（`session_item_*`，带 `select`）、消息输入框 `Edit`（按对端命名）、收发时间线 `List "消息"` 的 `ListItem`。

但**消息正文读不到**：微信气泡是自绘的，树里只暴露**会话行预览**（最后一条的摘要）。`elements_complete=false`。所以：

- **能做的**：定位会话、判断"当前打开的是谁"、确认某条出站是否出现在预览里 —— 本闭环的验证就是靠它。
- **不能做的**：拿到历史消息、媒体路径、逐条收发时间线、回声归因。这些是读库能力，WeFlow 存在的理由。

结论：**写侧换 Cua（拆掉 RDP），读侧保留 WeFlow。** 两者互不依赖。

### 4. 0.31.0 的接口变化（踩过的坑）

- `element_index` 被 **`element_token`** 取代，且 token **属于某一次快照**；一次 CLI 调用一个进程一个会话，所以"快照→动作"必须在**同一个 `session` 标签内**完成，否则 `stale_element_token`。
- 元素字段是 **`label`**（0.3.x 是 `name`）。
- 响应区分**投递**与**生效**：`route` / `effect` / `verified` / `refusal.code` / `escalation`。`✅` 只表示投递成功。本模块的 `outcome()` 保留这个区分，不把"投递"洗成"生效"。

### 5. UIAccess 助手：不需要，且在这台机器上不可能

`dispatch:"foreground"` 不需要 UIAccess 就能工作（实测有效）。助手 `cua-driver-uia.exe` 要求 `uiAccess="true"`，Windows 规定它必须住在 `%ProgramFiles%` **且**由受信任根签名：0.3.2 的副本**未签名**（所以永远起不来），0.31.0 的是签名有效的（`CN="Cua AI, Inc."`）。另有一条实测：**注册 `RunLevel=Highest` 的计划任务本身就需要管理员** —— 我先前那些非提权注册从来没真正提权过。

## Verification

- 离线：`test/wechat-cua-client.test.js` 7/7 —— 覆盖"已打开零成本"、"只在后台级失败后才升级且用最新 token"、"点了没变化不算切换"、"发送以预览行为凭据"、"文字没落地就绝不按回车"、"投递≠生效"、"搜索框不会被误认为消息框"。
- 真机：`scripts/cua-wechat-live.js` 两条路径都走过 —— 会话已打开（`cost=none`）与未打开（`route=global_input mode=foreground`），两次都 `ok: true` 且有预览行验证。
- 清理纪律：所有探针默认**发完即清空输入框**、`--dry` 只打字不发送；唯一的真发目标是 `文件传输助手`（自己给自己）。探针文本形如 `CUA-MODULE-ESCALATED-132422`，便于事后辨认与清理。

## Consequences

**收益**

- 写侧不再需要：第二个 Windows 账号、常驻 mstsc、保活/重连/远控守卫、文件队列与队列工人、`cwinprobe` 的密码、跨账号进程身份判据。这些是 [RDPWrap 隔离会话部署契约](../../implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md) 里几乎所有失败模式的来源。
- 读侧（会话定位、当前会话判定、出站确认）在**最小化甚至屏幕外**的窗口上都可用，且零抢焦点。
- 失败信号是结构化的：`refusal.code`、`effect`、`escalation` 让"投递了但没生效"第一次可以被代码区分，而不是靠看日志猜。

**代价与边界**

- **每次切换会话有一次前台点击。** 这意味着"机器人发消息时你的桌面会被短暂占用"。缓解手段是已有的空闲门槛（`MIN_CANARY_DESKTOP_IDLE_SECONDS`）与节流，但**这条成本消不掉** —— 除非微信将来暴露可用的后台选中通路。
- **正文读不到**，所以读侧仍绑在 WeFlow 上；WeFlow 的故障模式（`/health` 200 而 `/messages` 500、WCDB 锚点 `-105`）依旧存在。
- **单次操作约 16–38 秒**（大部分是快照与睡眠），比原来的 UIA 桥慢。出站排队/节流策略要按这个量级设计。
- **依赖个人版 Cua Driver 的接口稳定性**：0.3.2 → 0.31.0 就发生了 `element_index` → `element_token` 这类破坏性变化。模块里所有驱动交互都收敛在 `src/integrations/wechat-cua/client.js`，升级时只改这一处。
- 未接入机器人本体：闭环目前是**独立可跑的**（脚本 + 模块 + 测试），还没有替换 `weflow-outbound` 那条发送路径。替换前需要决定读侧与写侧的路由（`provider` 字段）怎么共存。

## Alternatives considered

- **回到 RDPWrap（把 session 3 重建起来）。** 最强理由：它是经过数月实战的形态，所有失败模式都有现成的看门狗与配方；而且它的防抢占是**结构性**的（驱动面在另一个桌面，用户的桌面物理上不参与），本方案只是"一次点击"级别的近似。否决原因是用户明确要求移除，且它的代价清单（第二账号、密码、跨账号身份、会话漂移、控制台弹窗、队列工人自愈导致的"杀了又活"）已经反复咬人 —— 本轮拆机时就再次被咬：跨账号杀不掉进程，只能把脚本丢进队列让工人自己执行。
- **把 Cua daemon 装进隔离会话，读写入都换 Cua（保留 RDP 但换驱动面）。** 最强理由：既拿到 Cua 的读能力，又保留结构性防抢占；命名管道同 SID 问题也可通过让 daemon 跑在隔离会话内绕开。否决原因是它保留了整套重依赖，而用户的目标恰恰是删掉它们 —— 收益（更好的读）可以由"读侧留 WeFlow"以更低成本拿到。
- **只做提权：把 Cua 的前台路径换成 UIAccess 助手。** 最强理由：官方文档把 UIAccess 描述为前台升级的正规做法。否决原因是**实测它不需要** —— `delivery_mode:"foreground"` 用 SendInput 直接生效；而且助手在本机历史上因未签名而根本无法启动，为一个非必需的组件引入"能向提权进程注入输入"的边界不划算。
- **只保留官方 iLink 通道，彻底放弃个人号自动化。** 最强理由：零 GUI 依赖、零抢焦点、迁移成本最低，而且这次的经验表明个人号自动化每换一层实现都要重学一遍客户端脾气。否决原因是官方通道**只能回复**（主动发起、check-in、提醒都做不到），而这是本项目一半的价值；且本轮已经证明写侧可以在没有 RDP 的前提下成立。
- **用 `set_value` 直接写消息框并找一个"发送"按钮 invoke 掉，完全避开键盘。** 最强理由：纯 UIA 语义路径，理论上不需要前台也不需要 SendInput，是最干净的形态。否决原因是实测消息框是自绘 `Group`（`chat_input_field.qt_scrollarea_viewport`），`set_value` 报告 `✅ Set AXValue` 而值仍是空的；发送按钮同理。微信只接受真的到达窗口的输入。
