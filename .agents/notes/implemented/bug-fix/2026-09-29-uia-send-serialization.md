# Agent Note: UIA 发送串行化——一次发送占用 36 秒的主因

Status: implemented

## Problem

用户反馈"处理中/回复有明显延迟"。账本只能给出"创建 → 被观察到"，无法回答时间花在哪里：

| 证据 | 数值 |
|---|---|
| 账本 建 → 确认（多次采样） | 3.4 / 4.0 / 4.9 / 5.0 / 6.8 / 11.4 s |
| 桥自身 `/api/send` 耗时（打点） | **36250 ms** |
| 其中消息已可见的时刻 | 请求开始后 12.4 s |

读 `scripts/weflow-uia-bridge.py:2471 dispatch_and_verify` 后根因明确：回车之后是一个
「读 API 里能否看到这条新消息」的循环，上界是调用方传进来的 `timeout`（机器人给的是 30 s），
而**整个循环都在 `with self.send_lock` 里面**。也就是说一次发送会把桥独占 36 秒，后续发送
（回执、正式回复、连发的第二条）只能排队 —— 这才是"连发更慢 / 偶发 409 / uncertain"的来源，
不是搜索稳定窗本身。

## Decision

1. **打点**：`/api/send` 的耗时写进 `bridge-timing.log`。
   注意会话 worker 启动桥时**丢弃 stdout**（`bridge4.log` 只留 58 B），所以打点必须自己落盘：
   `C:\ProgramData\cwin-probe\bridge-timing.log` 两个账号都能读。
2. **开关**：新增 `CYBERBOSS_WEFLOW_SEND_VERIFY_SECONDS`，只收紧 `/api/send` 的观察等待，
   未设置 = 保持旧行为（默认 30 s 上界）。
3. **透传**：`bridge-restart.ps1` 显式 `$env:CYBERBOSS_WEFLOW_SEND_VERIFY_SECONDS = Get-EnvValue ...`
   —— 会话 worker 只挑几个变量传给它启动的进程，不继承 `.env`。
4. **取值**：8 → 4（实测两档投递都被账本确认），`.env` 现为 4。

实测（同一份打点文件）：

```
36 250 ms  →  13 266 ms (8s)  →  9 936 ms (4s)
```

每档都验证过：`dispatch` 先是 `uncertain_pending`，随后 `already_verified`（localId 201/202），
说明桥提前返回**不会**让消息丢——投递核验由机器人侧账本兜住。

## Alternatives considered

- **保持 30 s 等待**：串行化代价太大（每次发送独占 36 s），且这段等待与机器人自己的账本核验重复。
- **在机器人侧把 `timeout` 传小**：能生效，但把"桥该等多久"这个决定散落到调用方；且有多个调用点
  （通知、回执、正式回复）需要同步改，容易漏。放在桥里一个开关更集中。
- **把回车后的核验改成异步**（先返回、后台核验再回写账本）：收益最大，但要动桥的并发模型
  （send_lock 语义、账本状态机），风险显著高于本次；留作后续选项。
- **彻底去掉核验**：会丢掉 409/冲突语义（"输入框里已有内容""搜索结果未确认"这些判断依赖它）。
- **只靠读代码不测**：这次的结论完全来自打点数字（36.25 s vs 12.4 s 可见），不测就是猜。

## Consequences

收益：单次发送占用 36.25 s → 9.94 s（−73%），串行队列的排队时间同比例缩短；回执/回复的
"入队 → 落屏"随之变快；有了一份可持续观测的 `bridge-timing.log`。

代价与边界：

- 桥更常返回"已发出但未在桥内确认"，**机器人侧账本核验成为投递正确性的承重墙**（本来也是）。
  若哪天真依赖桥的 verified 字段做幂等，要重新评估。
- 4 秒是实测出来的边界值，不是理论值；遇到慢桌面/大搜索仍可能更慢，此时 `uncertain_pending`
  会变多（账本重试会收敛，但日志噪声上升）。
- 过程中踩到两个坑，写在这里防重犯：① 半应用的补丁**删掉了桥的访问日志**（`2238611` 只写了半行），
  靠"写入后回读 + `py_compile` 失败即 `git checkout`"才发现并修复（`e41dc45`）；
  ② 重启配方与复制文件同名会被 worker 去重，**必须换文件名并确认监听 pid 变化**才算真重启。
## 追加（同日，13:16）：分段打点落地，9.2 秒的构成

打点过程本身踩了三次坑，值得记下来（每次都靠"回读 + `py_compile` + 失败即还原"挡住）：

1. 第一版锚点用了嵌套数组存"期望次数"，PowerShell 把第三项当成锚点文本 → ABORT；
2. 第二版对 `deadline = time.monotonic() + max(1.0, timeout)` 用固定 8 空格替换，而它有两处且缩进不同
   → `IndentationError` → 还原。**正确做法**：`[regex]::Replace` 的 MatchEvaluator 里取
   `$m.Groups[1].Value` 作为该匹配自身的缩进；
3. 第三版取时间戳用 `getattr(self, "_request_started_at")`，但 `dispatch_and_verify` 属于**发送引擎**，
   与 HTTP handler 没有对象关系（既无该属性也无 `.server`）→ 打点静默。
   **最终做法**：`do_POST` 里写模块级全局 `globals()["_last_send_request_at"]`，调用点读它。

落地后的三段（一次真实发送）：

```
pre-foreground   141 ms   前台激活/准备——可忽略
typed           5031 ms   搜索 + 选中 + 输入 + 回车（含 2s 搜索稳定 + 2s 选中确认两份固定等待）
send took       9218 ms   回车后到 HTTP 返回 ≈ 4.19 s，正好顶到 SEND_VERIFY_SECONDS=4 的上限
```

结论：**可见延迟 ~11.6 s 的两大块是"搜索+选中+输入 5.0 s"与"回车后观察 4.2 s"**，
前台激活不是原因（0.14 s）。下一步有两条路：

- **治本**：目标会话已打开时跳过搜索+选中（省 ~4 s）。**必须先有可靠断言**（判定不了就退回慢路径），
  因为发错窗口是不可接受的失败模式；
- **后置 4.2 s**：它精确等于上限，说明桥在观察窗口内没等到它要找的可见性；要么查清它在等什么
  （读 API 可见性延迟），要么把上限降到 2 s 并观察 `uncertain_pending` 是否变多。
## 追加（同日，13:17）：观察等待压到 2 秒并实测通过

`.env` 的 `CYBERBOSS_WEFLOW_SEND_VERIFY_SECONDS` 从 4 再降到 **2**，两次真实发送都直接
`already_verified`（localId 208/209），**没有出现 `uncertain_pending` 或失败**，分段打点：

```
pre-foreground  344 / 170 ms
typed          5358 / 5281 ms
send took      7563 / 7436 ms
```

累计曲线（每次改动都有实测支撑，无收益的一律回退）：

| 档位 | 单次发送占用 |
|---|---|
| 原始（占满调用方 30s 超时） | 36 250 ms |
| 8 s | 13 266 ms |
| 4 s | 9 936 / 9 218 ms |
| **2 s** | **7 563 / 7 436 ms** |

注意两点边界判断：

- **代码默认值保持保守**（未设环境变量 = 旧行为）。2 s 是在本部署实测出来的值，样本只有几次，
  写进 `.env` 而不是改默认值——换环境/换负载时应当重新验证，而不是默默继承一个激进值。
- 剩下的 `typed ≈ 5.3 s` 才是下一块大头（含 2 s 搜索稳定 + 2 s 选中确认两份固定等待）。
  治本方案"目标会话已打开时跳过搜索+选中"预计省 ~4 s，但**必须先把"当前会话 == 目标会话"的判定做成
  可靠断言**（判定不了就退回慢路径）：发错窗口属于不可接受的失败模式，宁可慢。
## 追加（同日，13:22）：快路径与分段定位的最终结果

开关与快路径都落地后，一次真实发送的完整分段（`bridge-timing.log`，投递 `verified`）：

```
pre-foreground      108 ms
fastpath-probe=yes  875 ms   确认"当前会话就是目标"
fastpath-used       875 ms   → 跳过 select_exact_contact_session
pre-asserts         875 ms
pre-write          2125 ms   写入前断言段（两次 confirm + Click + 三个 require_*）≈1.25 s
typed              3313 ms   写入 + 断言 + 回车 ≈1.19 s
send took          5531 ms   回车后观察 ≈2.2 s（受 SEND_VERIFY_SECONDS=2 约束）
```

**累计曲线**：36 250 ms → 13 266 → 9 936 → 7 436 → **5 531 ms**（−85%）。

一个重要修正：跳过"搜索+选中"**没有**带来预期的 4.8 s 收益。原因是 `select_exact_contact_session`
开头先按 `session_item_<contact>` 在会话列表里直接找行（L1803），**当前会话已打开时本来就是直接命中**，
并不走搜索框。真正的成本在写入前后的断言与回车后观察：

- 探针 0.9 s（快路径的依据，不算浪费）
- 写入前断言 1.25 s（两次 `confirm_current_chat_target` + `Click` + `require_no_competing_desktop_input`
  + `require_foreground_continuity` + `require_focused_chat_input`）
- 写入+回车 1.19 s
- 回车后观察 2.2 s（已是 2 s 上限）

后续可选（按收益/风险）：① 复用探针的确认结果、省掉写入前的重复确认（~0.5-0.8 s，但要先确认那两次
确认是否仍防着"选中后渲染竞态"）；② 把回车后观察改成异步（~2 s，收益最大，属并发模型改动，风险最高）。
两者都没做——当前 5.5 s 已在"不动并发模型、不删安全断言"的前提下接近地板。
## 追加（同日，13:46）：再挤一段 —— 3.70 s → 3.16 s

断言段细分打点（`pre-idle-assert` / `pre-focus-assert`）把写入前的 1.25 s 拆开：

```
pre-asserts       952 ms
pre-idle-assert  1702 ms   +750 ms  两次 confirm + Click（其中第一次与快路径探测重复）
pre-focus-assert 2375 ms   +673 ms  require_no_competing_desktop_input
pre-write        2389 ms   +14  ms
pre-focus-assert 3389 ms   +1000 ms write_chat_input_without_clipboard（UIA SetValue + 读回校验）
pre-focus-assert 3514 ms   +125 ms
typed            3671 ms   +157 ms  写入后校验 + 回车
send took        3702 ms   +31  ms  零等待返回
```

改动：**快路径下跳过紧跟其后的那次重复 `confirm_current_chat_target`**（探测刚用同一个 root/contact
做过同一断言），慢路径与其余断言（Click、桌面空闲检查、前台连续性、输入框聚焦、写入后读回校验）**全部保留**。

实测（两次发送，含一次三条 dispatch 才收敛）：**3 156 ms**，`already_verified` id=219/220，无重复行。

累计：**36 250 → 3 156 ms（−91%）**。剩余结构：探测 0.95 s + 确认/点击 ~0.4 s + 桌面空闲断言 0.67 s +
UIA 写入 1.0 s + 尾部 0.16 s，**都是真实动作或安全断言**，再往下压就必须动安全边界（不建议）。