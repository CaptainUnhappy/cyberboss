# Cyberboss 缺陷治理方案

- 生成时间：2026-09-11 23:59 +08:00（**2026-09-12 修订：`-105` 根因已定性**）
- 基线：`main` @ `fc05014`（本轮已提交 8 个批次，工作树干净）
- 前置状态：线上已恢复 `healthy=true`；`canary` / `transportE2E` / `deferredReplies` 全部转绿，`guard.consecutiveFailures=0`

> **修订说明（两次自我更正）**
>
> 1. 初版把 `-105` 描述为"间歇性、已消失的陈旧故障"。**错。** 它是一次持续 **5 天 14 小时**的真实中断，现已定性，见 §2。
> 2. 初版把重启退出码 `-1` 归因于"launcher 子进程树分离/re-parenting"，并建议**删掉**那个 `throw`。**两处都错。** 真实原因是 PowerShell 5.1 在 `-PassThru` + 重定向下 `.ExitCode` 恒为 `$null`，而且这是**一次回归 —— 且在 `20028d1`（我本轮的提交）里被固化**。正确修法是**只把回退值还原为 `{ 0 }`**，保留 `throw`。见 §4 修复 B。
> 3. 我此前报的 P2「引号正则 bug」**是我的误报**，L123/L124 都正确，见 §5。

---

## 一、核心结论：一次 5 天 14 小时的真实故障，被系统误判成了 flaky

```
WeFlow 原生组件 WCDB 的「离线防回拨锚点」状态损坏
        ↓  数据库无法打开（不是某条请求失败，是整个 DB 层打不开）
GET /api/v1/messages 返回 HTTP 500 {"error":"错误码: -105"}
        ↓  持续 5 天 14 小时（09-04T02:37:54Z → 09-09T17:04:14Z）
canary 读消息失败 → 被当成「发送链路坏了」
        ↓  误分类（见 §3 的三行代码）
看门狗 2/2 确认 → FullRestart 整个微信栈
        ↓
重启「成功」却被记为 controller_error（退出码误判）
        ↓
计入无效修复 → 烧预算 → 升级更重的重启
        ↓
而真正的故障（WCDB 锚点损坏）从头到尾没被处理，最后是自己好的
```

**两句话总结：**
1. 微信被观测层**不可达**了 5 天多，用户期间收不到任何回复，而系统把这段长时间中断表现为"偶发抖动"。
2. 观测层的一次**读**失败，能让系统**重启整个发送栈** —— 这两件事在代码里被混为一谈（`cyberboss-watchdog.ps1:2200`）。

---

## 二、`-105` 定性（已确证）

**`-105` = WeFlow 原生数据组件（WCDB）bootstrap 失败**，由 `wcdb_api.dll` 经 koffi 抛出。

| 证据 | 内容 |
|---|---|
| 字符串表 | `analysis\weflow620\asar-src\dist-electron\wcdbWorker.js:3`：`"-105":"离线防回拨状态损坏或无法安全保存，请检查当前用户目录权限"`；邻近码 `-101` 环境 / `-102` 时钟回拨 / `-103` 组件完整性 / `-104` 调试环境 |
| 已安装包比对 | `…\Programs\WeFlow\resources\app.asar`（v6.2.0）字节级一致 |
| 组装路径 | `toCodeOnlyMessage(e,t=-3999){return \`错误码: ${…}\`}`，在 `ChatService.connectInternal()` 中以 `getLastInitError()` 调用 → **DB 打开阶段就失败**，任何查询都没跑 |
| 原生日志 | `%APPDATA%\weflow\logs\wcdb.log`：`[bootstrap] native runtime policy mismatch value=-105` |

**我自己复核的数字**：该日志内 `policy mismatch` 与 `value=-105` 各出现 **9901 次**，窗口 `2026-08-26T13:34:38Z` → `2026-09-09T17:03:51Z`，按天分布 09-04: 661 / 09-05: 287 / 09-06: 1942 / 09-07: 2210 / 09-08: 3223 / 09-09: 1547。

**它不是间歇性的，是一把锁存 5 天 14 小时。** 那段时间内 **9901 次 DB 打开全部失败，0 次成功**。看起来像"偶发"纯属采样错觉 —— canary 一天只跑 1 次 + 加 3 次重试，"04:0x / 11:4x 聚集"是**canary 的排班表**，不是服务的行为。

**它是在 09-09T17:04:14Z 自己好的**（此后 09-10 记录 5 次打开、4 次成功）。所以我 09-11 那次实测 200 正常，是因为锁已经解了 —— 我当时据此推断"陈旧故障"，方向对但结论错：它不是被谁修好的，是**自己恢复的**。

**未定性**：09-03T10:08 → 09-04T02:37 之间的触发点。它在 09-09 期间**扛过了至少 4 次完整 WeFlow 重启**（1548 次加载全部失败），说明是**磁盘上的持久状态**，不是竞态。

---

## 三、真正该修的地方：三行代码把「读不到」变成了「重启整个栈」

这是本次最重要的发现，也是唯一"修完立刻消除重启风暴"的地方。

**① `scripts/cyberboss-watchdog-canary.js:768-784`** —— `buildFailureOutcome` 只在 `TARGET_NOT_CONFIRMED` 时输出 `repairable: false`：

```javascript
...(code === "TARGET_NOT_CONFIRMED" ? { repairable: false } : {}),
```

读接口失败（`CANARY_HTTP_ERROR`）**不带 `repairable`**。

**② `scripts/cyberboss-watchdog.ps1:2200`** —— 缺失时默认成 `true`：

```powershell
repairable = if ($hasExplicitRepairability) { [bool]$parsed.repairable } else { $action -eq "failed" }
```

**③ 后果链**：`canaryConsecutiveFailures++`（2382-2385）→ `"canary"` 计入失败组件（`L3181: if ($Snapshot.canary.healthy -eq $false) { $failed += "canary" }`）→ 2 次确认（3159-3162）→ **FullRestart**（3325 / 3467）。

**判据本身就是错的**：canary 的**目的**是验证**发送**链路（trigger → reply）。`fetchMessages`（用于 L418 发送前去重、L492 轮询回复）只是**支撑依赖**，而且 **UIA 发送端点根本不需要 WCDB**。所以"读不到消息"永远只意味着**无法验证**，绝不等于**发送坏了**。

> **一句话**：`cyberboss-watchdog.ps1:2200` 这一行，把一次读错误放大成了整个栈的重启。

---

## 四、修复方案

### 修复 A —— canary 读失败不再触发重启（**最高优先，先做这个**）

1. **分工况编码**：`canary.js:954-966` 的 `fetchMessages` 失败标记为独立码 `CANARY_MESSAGES_UNAVAILABLE`，与发送类失败（`CANARY_TRIGGER_*` / `TARGET_NOT_CONFIRMED`）区分。
2. **有界重试**：读失败在单次 run 内重试 3 次、指数退避、总预算 ≤30s。瞬时抖动自愈，不进入失败计数。
3. **显式不可修复**：`canary.js:772-784` 对该码输出 `repairable: false`（`watchdog.ps1:2200` 已经尊重显式值，不需要改 PowerShell）。
4. **新增"无法验证"动作**：仿照 `buildDesktopBusyOutcome`（`canary.js:787-806`，`healthy: null`）增加 `verification_unavailable`，并把该动作加入 `cyberboss-watchdog.ps1:138` 的 `$CanaryDeferredActions`。这样 `L3181` 不会把它计入失败组件，`L2443-2444` / `L3605` 也会按"延后"处理。
   - **注意**：加入 deferred 集合后 `attempts` 预算仍会推进，不会变成紧密重试循环。
5. **重启要缩小爆炸半径**：`watchdog.ps1:3325/3467` —— WeFlow 单点故障**不应** FullRestart 整个栈。

**验证方式**：单测模拟 `fetchMessages` 返回 500 + `{"error":"错误码: -105"}`，断言 ① 不产生 `action:"failed"` ② `repairable === false` ③ 失败组件列表**不含** `canary` ④ 不触发 repair 计划。

---

### 修复 B —— 重启退出码误判（**是一次回归，且是我提交进去的**）

> **自我更正（第二次）。** 我初版把 `-1` 归因于"launcher 子进程树分离 / re-parenting"，**是错的**。真实原因是 PowerShell 5.1 的一个具体行为，与 launcher 无关。更要紧的是：**这不是一直存在的 bug，而是一次回归 —— 并且是我在 `20028d1` 里把它固化下来的。**

**根因**：`scripts/cyberboss-watchdog.ps1:4392`

```powershell
$repairExitCode = if ($null -eq $repairProcess.ExitCode) { -1 } else { [int]$repairProcess.ExitCode }
```

`$repairProcess` 来自 **L4379-4385**，用 `-PassThru -RedirectStandardOutput/-RedirectStandardError` 启动控制器，且**故意不加 `-Wait`**（为了保留 L4386 的 120 秒上限）。**在 Windows PowerShell 5.1 下，`-PassThru` 与输出重定向同时使用时，返回的 `Process` 对象永远不会获知退出码** —— `WaitForExit()` + `Refresh()` 之后 `.ExitCode` 恒为 `$null`。

**我在本机独立复现（PS 5.1.26100.9168，一次干净的三例对照）**：

| 启动形态 | `.ExitCode` |
|---|---|
| **A) `-PassThru` + 重定向，无 `-Wait`** ← 看门狗的写法 | **`$null`**（`HasExited=True`） |
| B) `-PassThru`，无重定向（对照） | `7` ✓ |
| C) `-Wait` + `-PassThru` + 重定向（`cyberboss-service.ps1:940-953` 的写法） | `5` ✓ |

所以 **`$null` 分支是常态路径**，而它现在返回失败哨兵 `-1` → L4399-4401 `throw "$repairMode returned exit code $repairExitCode"` → catch L4458-4471 → L4462 记 `controller_error`。**这个 `throw` 位于 `Wait-WatchdogInfrastructureRecovery`（L4403）与整套就绪判定（L4415-4457）之前**，于是预期中的"以证据判成功"路径（`Complete-VerifiedRepair` L4456）被完全绕过。日志因此**自相矛盾**：L4393-4395 已经把控制器的 stdout（`Readyz: OK`）搬运进日志，然后才抛错。

**回归证据（git）**：

| 提交 | L4392 的回退值 |
|---|---|
| `b6c206d`（2026-08-24） | `{ 0 }` ← **正确：未知退出码 → 交给就绪证据** |
| `bf7ee4e`（本批之前的 HEAD） | `{ 0 }` |
| **`20028d1`（我本轮提交）** | **`{ -1 }`** ← 回归被固化 |

`{ 0 }` 变 `{ -1 }` 这个改动来自 Codex 留下的未提交工作树，**我在做 1.8 万行分批提交时没有逐行审视这一字符级改动，把它一并提交了**。这是我这次交接里最实质的错误 —— 它把一个"未知即放行"的良性回退变成了"未知即失败"，而这条路径恰好是自愈系统的核心。

**危害（已实际发生）**：控制器启动结果共记录 10 次 —— 1 次空（08-23，守卫之前）、**8 次 `-1`**（09-09 起）、1 次真实的 `1`。**最后一次 `repair verified healthy` 是 2026-08-29** —— 也就是说自那以后**没有任何一次修复被记为成功**。而磁盘上的产物恰恰证明重启是成功的（`cyberboss-watchdog-repair.out.log` 14 行、stderr 0 字节、耗时约 6 秒，所以 120 秒超时分支从未触发）。连带后果：`lastSuccessfulRepairAt`、`pendingRepairVerification*` 从未置位，`Complete-VerifiedRepair`（L3520-3535）里的重启通知派发从未执行 → 堆积了 **8 条 `retry_pending` 的陈旧通知**。

**最小修复（推荐）**：把 L4392 的回退值**还原为 `{ 0 }`**：

```powershell
$repairExitCode = if ($null -eq $repairProcess.ExitCode) { 0 } else { [int]$repairProcess.ExitCode }
```

**不要删掉那个 `throw`**（这是我初版的错误建议）。保留 `-ne 0` 抛错有三点好处：
- **真实非零码仍被尊重**（如 09-09 22:22 那次真实的 `1`）；
- 未知码走就绪梯子 —— 栈健康 → `Complete-VerifiedRepair`；不健康 → 照旧 `repair_failed` + `-Ineffective`（L4449-4455），**真实故障仍会被抓到**；
- 改动面只有**一个字符**，语义回到设计初衷（"退出码不可知 ≠ 失败"）。

若要更显式，可写成三态 `{ $null }` + L4399 改为 `if ($null -ne $repairExitCode -and $repairExitCode -ne 0)`，效果等价、可读性更好。**120 秒超时分支（L4386-4389）不要动**。

**验证方式**：现有测试**完全没有覆盖这条路径**（没有任何测试提到 `repairExitCode`/`controller_error`；该启动语句位于 `CYBERBOSS_WATCHDOG_LIBRARY_ONLY` 的 return（L3745）之后，`invokeLibrary` 根本到不了）。在 **`test/watchdog-policy.test.js`**（它已持有 repair 分支的源码切片 ~L400-415 与升级测试 L1404/L1451）中新增：
1. **源码断言**：控制器启动切片**不得**把"退出码不可知"转成非零失败，且 `Wait-WatchdogInfrastructureRecovery` 必须可达；
2. **注入式行为用例**：stub `Start-Process` 返回 `ExitCode=$null` + 健康快照 → 结果为 `verified` 且 `ineffectiveRepairCount` 为 0；快照不健康 → `repair_failed`。

`test/watchdog-restart-notification.test.js:656-678` 可补"修复经证据验证时通知能到达派发"；`weixin-desktop-recovery.test.js` 不是合适位置。

**依赖**：健康判定快照**包含 canary 状态**。若 canary 因与本次修复无关的原因失败，仅凭"证据健康"仍会误判 → **修复 B 应与修复 A 同批上线**。

---

### 修复 C —— 图片发送路径（两个独立缺陷）

**文件**：`scripts/weflow-uia-bridge.py:2532-2561`（`_dispatch_image`）

逐行数过调用点，对照文本路径 `_dispatch_text`：

| 保护 | 文本路径 | 图片路径 |
|---|---|---|
| `confirm_current_chat_target` | 3 次（L2438/2445/2459） | **1 次**（L2544） |
| `require_focused_chat_input` | 4 次（L2447/2451/2461/2479） | **0 次** ← 全文件唯一未覆盖的写入路径 |
| 发送前校验编辑器内容 | ✅ L2474 | ❌（图片无法比对内容） |
| 空编辑器保护 | ✅ `write_chat_input_without_clipboard` L1443 | **无** |

**C1：焦点漂移 → 图片发错窗口（隐私）**
L2545 校验前台**之后**再无校验，直接 L2553 `Ctrl+V`。`Ctrl+V` 是键盘事件，作用于**焦点**窗口 —— 前台 ≠ 焦点。若 `Ctrl+A` 已把草稿换成图片，`Ctrl+V` 会把图片粘进另一个聊天窗口，随后 `Enter` 发出去。

**修法**：在 `Ctrl+V` 前与 `Enter` 前各补一组复校验（与文本路径同级）：

```python
            confirm_current_chat_target(root, contact)
            require_foreground_continuity(window_handle)
            require_focused_chat_input(contact)          # ← 新增：Ctrl+V 前
            automation.SendKeys("{Ctrl}a", waitTime=0.05)
            set_clipboard_dib(png_bytes_to_dib(image_bytes))
            automation.SendKeys("{Ctrl}v", waitTime=0.05)
            time.sleep(0.6)
            root = confirm_current_chat_target(root, contact)
            require_foreground_continuity(window_handle)
            require_focused_chat_input(contact)          # ← 新增：Enter 前
            automation.SendKeys("{Enter}", waitTime=0.05)
```

失败抛 `TargetNotConfirmedError` → HTTP 409 且 `dispatched=false`，与既有语义一致，不会误报"已发送"。

**C2：`Ctrl+A` 静默吞掉用户未发送的草稿**
文本路径明确拒绝覆盖非空编辑器（L1443，注释即写明 "protects a user's unsent draft"），图片路径无此闸 —— **会销毁用户正在打的字且不留痕迹**。

```python
            value_pattern = get_chat_input_value_pattern(input_control)
            if read_chat_input_value(value_pattern):
                raise TargetNotConfirmedError(
                    "confirmed chat input was not empty before image dispatch"
                )
```

加上这道闸后编辑器必为空，原有的 `Ctrl+A` 兜底可一并去掉，进一步缩小破坏面。

**验证方式**：扩展既有 seam `test/test_weflow_uia_bridge.py:2076`（`test_ordinary_text_and_image_recheck_foreground_before_clipboard_or_keys`）：
1. 焦点丢失 → **不得**调用 `SendKeys` / `set_clipboard_dib`，抛 `TargetNotConfirmedError`；
2. 编辑器非空 → 不得覆写，用户文本保留；
3. 正常路径仍能发出（防止加闸加死）。

---

### 修复 D —— 3 个测试硬编码 macOS 路径

| 文件 | 问题 |
|---|---|
| `test/claudecode-approval.test.js` | `/Users/tingyiwen/...`、`/tmp/cb-claude-*` |
| `test/sticker-service.test.js` | `/Users/tingyiwen/Dev/cyberboss/scripts/normalize-sticker-gif.js` |
| `test/timeline-service.test.js` | 期望 `/tmp/timeline-shot.png`，实际 `D:\tmp\...` |

改用 `os.tmpdir()` + `path.resolve()`，比较统一走 `path.normalize()`。注意 `\tmp` 在 Windows 上解析为**当前盘根**（实测 `D:\tmp`），不要依赖。修完测试套件应回到 **48/48**。

---

### 修复 E —— 只补测试，不改代码（见 §5）

---

## 五、更正：我此前报的 P2「引号正则 bug」不存在

> 我用干净字面量重新做了穷尽测试（`[regex]::IsMatch`，而非 `-match`）。**L123/L124 都正确。** 我最初的"复现"是**我自己的测试写错了** —— 把 `-match` 结果塞进字符串插值，`True` 被折叠成空串，于是看起来像 `False`。我基于坏测试报了"已确认缺陷"，抱歉。

```powershell
$WeFlowUiaCommandPattern = 'weflow-uia-bridge\.py"?(?:\s|$)'   # 正确
$SharedStartCommandPattern = 'shared-start\.js"?(?:\s|$)'      # 正确
```

| 命令行 | L123 UIA | L124 shared-start |
|---|---|---|
| `python "…\weflow-uia-bridge.py" --host …` | ✅ | — |
| `node.exe "…\shared-start.js"` | — | ✅ |
| `node.exe "C:\Program Files\…\shared-start.js"` | — | ✅ |

**为什么它其实是对的**：`"?(?:\s|$)` 里那个引号位置虽然写反了，但因为 `"?` 是**可选的**，它永远不参与匹配 —— 真正起作用的是 `(?:\s|$)`，而无论路径是否被引号包裹，`.js`/`.py` 后面总是空白或结尾。**无害的冗余，不是 bug。**

**但缺口是真的：没有测试。** 这类"读起来像 bug"的正则必须用测试锁死，否则下一个人（比如我）就会去"修"它。**建议只加 `test/service-command-pattern.test.js`**，覆盖带引号、路径含空格、不带引号、以及反例不匹配；**不动生产代码**。

---

## 六、优先级与执行顺序

| 优先 | 项 | 危害 | 风险 |
|---|---|---|---|
| **P0** | 修复 A（canary 误分类） | 重启风暴的**唯一放大器** | 低 |
| **P0** | 修复 B（退出码回归，**还原一个字符**） | 自 09-09 起**每次修复都被误记为失败**；最后一次记为成功是 **08-29** | 极低 |
| **P1** | 修复 C（图片路径） | **发错窗口**（隐私）+ 吞用户草稿 | 中 |
| **P2** | 修复 D（测试路径） | 测试套件跨平台不可用 | 极低 |
| **P2** | 修复 E（补正则测试） | 防未来误改 | 极低 |
| **P3** | 修复 F（WeFlow 侧根因） | 见下 | 中 |

**第一批（立刻）**：A + B + D + E —— 直接消除重启风暴与预算浪费，并让测试回到 48/48。
**第二批（需专门验证）**：C —— 唯一触碰"发送"语义，做完单独给验证记录再合并。
**第三批**：F —— WeFlow 侧。

### 修复 F：WeFlow 侧根治（`-105` 本身）

`-105` 的语义是"离线防回拨锚点状态损坏或无法安全保存 → 检查用户目录权限"：

1. **给 `%LOCALAPPDATA%\WeFlow` 加杀软/EDR 排除项** —— 文案直指"无法安全保存"，属写入/权限路径。
2. 锁存时**只重启 WeFlow**并做有界退避（历史上正是这样做才恢复的）—— 绝不要 FullRestart 整个栈。
3. 需要重建状态时，必须**成对**删除 `anchor-v7-*` / `native-anchor-v7-*` 文件**和** `HKCU\Software\WeFlow\Runtime\AnchorV7-*` 注册表值，**不可只删一边**。
4. 用 `%LOCALAPPDATA%\weflow-updater\installer.exe` 走完整重装。
5. 带 `wcdb.log` 的 `policy mismatch` 摘录向 `github.com/hicccc77/WeFlow` 反馈（上游支持正是要这个）。

### 诊断能力补强（这一项让下次从"一周"变"5 分钟"）

`messages` 失败时持久化：HTTP 状态码、响应头（含 `Retry-After`）、脱敏响应体、完整请求 URL/参数、耗时；保留 `error.upstreamCode = -105` 与 canary 自身错误码并列；同时探测 `/api/v1/health` 以区分"服务活着但 DB 打不开"；再加一个**锁存指标** —— 从 `wcdb.log` 解析 `policy mismatch value=(-?\d+)` 的首末时间与成功计数，附三个 anchor 副本的 SHA256 与 `Runtime` 目录 mtime。

> 光这一个指标，就能把这次"一周的偶发谜案"变成一次 5 分钟定位。

---

## 七、附带发现

1. **watchdog 有自主重启权且已实际行使**。23:42 它自行对 `components=canary` 执行 FullRestart，停掉 10800/22736/28428 并全部重启。**未征求任何人同意。** 结合修复 A，这属于"设计如此但目前过于敏感"。
2. **隐藏窗口 = 失败不可见**。`cyberboss-watchdog-hidden.vbs:49` 用 `shell.Run(command, 0, True)`（0 = 无窗口），任务每 2 分钟跑、永久循环。失败只有任务计划程序返回码和 `cyberboss-watchdog.log` 可见 —— 不知道日志路径的机主等于看不见。
3. **`install-cyberboss-watchdog-task.ps1:74`** 的 `Register-ScheduledTask -Force` 会静默覆盖同名任务且无备份（有 `ShouldProcess` 兜底，脚本化执行时无提示）。
4. **`scripts/weflow-self-image-e2e.js`** 无调用方、无 npm 入口，与已跟踪的 `weflow-self-manual-e2e.js` 重名函数 13 个。要么接上 npm script，要么明确它取代旧 harness。
5. **两份新测试缺平台守卫**：`test/watchdog-canary.test.js`、`test/watchdog-model-canary.test.js` 没有同族测试都有的 `process.platform !== "win32"` 跳过，非 Windows CI 上会炸。
6. **⚠ `scripts/cyberboss-watchdog.ps1` 必须保留 UTF-8 BOM。** 该文件含 `♻️` 等非 ASCII 字符；一旦 BOM 丢失，Windows PowerShell 5.1 会按 ANSI 解码，多字节字符变成非法 token，**整个脚本语法错误、看门狗彻底失效**。我在本轮编辑中曾不慎抹掉它（解析报错 `Unexpected token '鈾伙笍'`），已恢复并验证提交后的 blob 首三字节为 `EF BB BF`。**任何工具编辑此文件后都必须校验首三字节**，建议加测试守护 —— 这是一个"静默失效"类风险：脚本不会报错，只会不再工作。

---

## 七之二、修复 G —— 会话选择改为纯键盘（**已提交，待部署**）

**用户报告：账号已被风控。** 证据支持该判断：live bridge 日志（67,455 行 / 2,512 次 send）反复出现

```
exact session did not become the confirmed current chat after
  actions=['SelectionItem.Select', 'InvokePattern.Invoke', 'row.Click']
```

即**物理点击会话列表行**这条兜底在被**反复**触发 —— 正是风控会反应的"扫描并点击会话列表"模式。

**已落地改动**（分支 `fix/keyboard-only-contact-selection`，提交 `3d0d786`）：

1. **删除会话行的物理点击**（原 `weflow-uia-bridge.py:918-931`）。
2. **会话选择一律走搜索框键盘流**：聚焦搜索编辑框 → `SendUnicodeChar` 逐字输入精确名称 → 从两次稳定快照推导有序 `Down` 次数 → 恰好一次 `Enter`。
3. **保留全部非点击校验**（身份唯一性、顺序稳定、焦点连续、计数、末尾单次 `Enter`）—— 防"发错人"能力不变，只去掉鼠标动作。
4. 直连会话列表那条路**降级为只读身份审计**：歧义或身份不符仍 fail closed，但**不再**回退到点击。发送路径里的编辑框聚焦点击（`input_control.Click`）保持不变。

**验证**：Python bridge 测试 **49/49**；原 `test_exact_session_falls_back_select_then_invoke_then_one_hit_tested_click` 已重写为 `test_main_session_selection_never_clicks_a_session_row`，断言选择过程**永不**发出鼠标输入。JS 套件仍 **45/48**（同样那 3 个 mac 路径失败，无新增回归）。

### 必须记录的时间线更正

用户的印象是"9/2 之前正常"，但转录考古（从 253 个 Codex 会话恢复）显示：

| 日期 | 版本 | 选择机制 |
|---|---|---|
| 08-23 17:19 | **424 行（完整恢复）** | 纯键盘 `{Ctrl}f` + 剪贴板粘贴 + `Enter`，**零点击** |
| 08-28 11:24 | 735 行 | 最后一次出现 `{Ctrl}f` |
| **08-29 04:24** | 1221→1402 行 | `{Ctrl}f` **消失**，改为 AutomationId 定位 + `SetFocus` + `SendUnicodeChar`，**并引入 `row.Click` 兜底** |
| 09-02 09:48 | 2816 行 | 已含 `row.Click` |

**纯键盘时代在 8/23–8/29 之间就结束了，不是 9/2；`row.Click` 在 9/2 时已经在跑。** 但用户观察到的现象仍然成立 —— 真正的变化是**点击的触发频率**（日志证明现在被反复触发）。

> **普遍教训**：这类问题的关键指标是「某条兜底路径被触发的**频率**」，而不是它是否存在。建议给兜底路径加触发计数器并纳入健康快照 —— 若当时有这个指标，"9/2 之前正常、之后不正常"会立刻被量化定位。

---

## 八、需要你拍板

1. **修复 A 会降低看门狗的重启敏感度**：读不到消息将不再计入触发重启的失败确认。这是消除重启风暴的关键，代价是某些真实持续故障会更晚被自动处理。是否同意？
2. **修复 B 同样降低敏感度**：`-1` 不再直接判失败，改为以就绪证据为准。是否同意？
3. **修复 C 是唯一触碰发送语义的改动**，建议做完单独给验证记录（含失败路径实测）再决定合并。
4. **修复 F（WeFlow 侧）需要你决定**：是否现在就加杀软排除项 / 重装 WeFlow？这是我唯一建议你**亲自**参与的步骤 —— 而它才是 `-105` 的真正解药。
