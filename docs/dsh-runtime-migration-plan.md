# 将 Cyberboss 的 runtime 从 Codex 换成 DSH —— 可行性评估与方案

- 生成时间：2026-09-12
- **状态：方案已实施并通过实测。** 阶段 0（协议打通）与适配器主体已完成；协议实测事实见 `docs/dsh-sdk-protocol-notes.md`
- 结论先行：**可行**，且比预期干净 —— DSH 有一个和 `codex app-server` 形态几乎一致的自动化入口。
- **有 3 个必须你拍板的缺口**，其中「审批流」是需要改变产品行为的那个。

---

## 〇、实施结果（实测）

| 项 | 结果 |
|---|---|
| 协议打通 | ✅ `initialize` → `session/prompt` → `session.event` → `turn/end` → `shutdown` 全通 |
| 适配器 | ✅ `src/adapters/runtime/dsh/{rpc-client,events,index}.js` |
| 真实一轮对话 | ✅ 回复 `DSH_ADAPTER_OK`，`turnId correlation : OK`，约 5 秒 |
| 单测 | ✅ `dsh-events` 19/19、`dsh-rpc-client` 16/16、`dsh-adapter` 6/6、`dsh-integration`（门控）2/2 |
| 全量 JS 套件 | ✅ 50/53（3 个失败是原有硬编码 macOS 路径，与本改动无关） |
| 模型选择器 | ✅ `CYBERBOSS_RUNTIME=dsh`，Codex / ClaudeCode 适配器未改动 |

**实现过程中由测试抓出的两个真实缺陷**（都不是我预想的）：
1. **`turnId` 关联竞态**：DSH 在 `session/prompt` 仍在飞行时就发出 `turn/start`，导致 `sendTurn` 返回的 id 与事件上的 id 不一致。修法是在 prompt 前登记 rendezvous，返回处理器铸造的那个 id。
2. **工作区未预启动**：`ensureRuntime()` 只构造客户端、没调 `start()`；启动是靠客户端自身 `initialize()` 的惰性副作用完成的。任何不经适配器 `initialize()` 就使用 runtime 的路径都会拿到一个"没有进程的"客户端。修法是 spawn 提前到 `ensureRuntime()`。

---

## 一、结论摘要

| 维度 | 判定 |
|---|---|
| 是否有可用的自动化接口 | ✅ `dsh --profile sdk` = **JSON-RPC 2.0 over stdio（换行分帧）** |
| 与现有架构是否同构 | ✅ 和 `codex app-server` 是同一形态，适配器是**移植**而非重写 |
| 协议复杂度 | ✅ 只有 **3 个请求 + 4 个通知**，很小 |
| 多线程/多会话 | ✅ `sessionId` 未知即惰性建会话，天然契合 Cyberboss 的 thread 绑定 |
| 会话持久化 | ✅ `~/.dsh/sessions/<workspace>/` JSONL，且有 SQLite 查询插件 |
| **审批流（批准/拒绝工具调用）** | ⚠️ **SDK 协议明确不支持服务端→客户端请求** → 见第四节缺口 1 |
| **取消当前 turn** | ⚠️ SDK 无 cancel；官方立场是「关闭 runtime 进程即放弃」 |
| **模型列表** | ⚠️ SDK 无 listModels；模型在 `initialize` 时固定 |
| **流式 `reply.delta`** | ⚠️ **拿不到**：一轮只发一个 `assistant/message`，文本一次性到达 |

---

## 二、Cyberboss 现有 runtime 契约（适配器必须实现的 16 个方法）

`src/core/config.js:23`：`runtime: readTextEnv("CYBERBOSS_RUNTIME") || "codex"` —— **已经被设计成可插拔的**。
`src/core/app.js:94`：

```javascript
function createRuntimeAdapter(config) {
  if (config.runtime === "claudecode") return createClaudeCodeRuntimeAdapter(config);
  return createCodexRuntimeAdapter(config);
}
```

`app.js` 实际驱动适配器的调用面（从代码里枚举出来的完整集合）：

```
describe()                  getSessionStore()        initialize()
createClient()              getTurnCapabilities()    close()
onEvent(listener)           supportsExecutionPolicy() startFreshThreadDraft()
sendTurn()                  sendTextTurn()           resumeThread()
cancelTurn()                compactThread()          respondApproval()
refreshThreadInstructions() listTurnGeneratedImages()
```

`onEvent` 必须发出的 8 种事件：

```
runtime.turn.started      runtime.turn.completed   runtime.turn.failed
runtime.reply.delta       runtime.reply.completed  runtime.tool.started
runtime.approval.requested  runtime.context.updated
runtime.media.completed
```

**关键点：`respondApproval` + `runtime.approval.requested` 是 Cyberboss 的核心功能** —— 它把审批请求通过微信发给你、等你在微信里回 yes/no。这是 Codex 的 `app-server` 双向 JSON-RPC 支撑的。

---

## 三、DSH 侧实际提供什么（已从本机实测确认）

### 3.1 入口（`@deepseek-ai/dsh` v0.1.5-rc.1，本机 `_npx` 缓存）

| 命令 | 用途 |
|---|---|
| `dsh --profile sdk` | **JSON-RPC over stdio 服务自动化客户端** ← 我们要的 |
| `dsh --profile sdk-minimal` | 同上，最小 agent 树 |
| `dsh --profile acp` | **ACP（Agent Client Protocol）over stdio** |
| `dsh --profile headless "job"` | 跑一次性会话并打印结果 |
| `dsh web` | Web GUI（= 你正在用的这个） |

> 注意：**SDK 和 ACP 是 profile，不是独立的 bin**。没有 `dsh-sdk` 这样的命令。

`~/.dsh/` 现状：只有 `web` profile 已初始化；`sdk` / `acp` 首次使用会**从内置模板自动初始化**。
`~/.dsh/sessions/` 里**已经存在 `--D-Projects-cyberboss--` 目录** —— DSH 已经按 workspace 给这个项目分好目录了。

### 3.2 协议全文（`@deepseek-ai/dsh-sdk-protocol`）

换行分帧的 JSON-RPC 2.0。**一共 7 个消息**：

| 方向 | 方法 | 载荷 |
|---|---|---|
| C→S | `initialize` | `{cwd, provider, model, reasoningEffort?, maxTokens?}` → `{serverInfo}` |
| C→S | `session/prompt` | `{sessionId, contentBlocks}` → `{messageId}`（**入队回执，不是答案**） |
| C→S | `shutdown` | → `{}` |
| S→C | `session.event` | `{sessionId, event}` — **每个会话的完整事件流，不做过滤** |
| S→C | `session.status` | `{sessionId, status: 'idle'\|'running'}` |
| S→C | `subagent.started` / `subagent.finished` | 子代理生命周期 |

`SessionPromptParams.sessionId` 语义很关键：**未知 id 会惰性创建 agent+session 对** —— 这正好对上 Cyberboss 的 `startFreshThreadDraft` / `resumeThread`。

`SdkEncodedImageBlock` 支持内联图片（png/jpeg/webp/gif）→ Cyberboss 的图片入站可以对接。

### 3.3 事件词汇（`@deepseek-ai/dsh-session`，共 57 种）

`turn/start`、`turn/end`（带 `reason`: completed / aborted / blocked / error / max-tokens / interrupted）、`assistant/message`、`tool/call`、`tool/result`、`user/message`、`approval/asked`、`approval/decided`、`session/title`、`goal/change`、`todo/write`、`deliverables/presented`、`step/start`、`step/end` 等。

**映射到 Cyberboss 的 8 个事件是直接可行的**：

| Cyberboss | DSH |
|---|---|
| `runtime.turn.started` | `turn/start` 或 `session.status=running` |
| `runtime.turn.completed` | `turn/end` (reason=completed) |
| `runtime.turn.failed` | `turn/end` (reason=error / max-tokens / blocked) |
| `runtime.reply.delta` | `assistant/message` / `assistant/attempt` 的 stream |
| `runtime.reply.completed` | `assistant/message`（终态） |
| `runtime.tool.started` | `tool/call` |
| `runtime.approval.requested` | `approval/asked` —— **但它只是审计日志，不可回复** |
| `runtime.context.updated` | `request/context` |
| `runtime.media.completed` | `deliverables/presented` |

---

## 四、三个真实缺口（**必须先决策**）

### 缺口 1：审批流 —— 最严重，会改变产品行为

DSH 的 SDK 协议 README 里明确写着：

> **"Server→client requests are a dead capability — the transport supports them, but the server never sends one; the Python SDK's responder surface exists for future approval flows."**

而 DSH 的审批实现（`@deepseek-ai/dsh-user-approval`）：

- 审批是 **channel-neutral 的 answerer 瀑布**，由**部署方**在 profile 里组合 answerer；
- **"No built-in answerer"** —— 不组合就返回 `unavailable`，**fail closed**（动作被拒）；
- `approval/asked` / `approval/decided` **只是审计日志**，"the human permission UI is not model context"；
- 策略只有 `ask` / `never` 两档，且**没有 allow-always / 记住规则 / 撤销**。

**后果**：走 SDK profile 时，**Cyberboss「把审批发到微信、你回 yes/no」这个功能无法实现**。可选出路：

| 出路 | 代价 |
|---|---|
| **1A. 用 ACP profile 而非 SDK** | ACP 是机器审批通道、支持 call id（DSH 文档称"the ACP machine channel requires a call id"）→ 有可能保留审批。**但需要另写 ACP 适配层**，工作量显著增加 |
| **1B. SDK + 自写 answerer 插件** | 在 DSH 侧写一个 profile 插件，让 answerer 把审批转发给 Cyberboss。但 SDK 协议没有服务端→客户端请求，只能靠**旁路**（如本地 HTTP/文件）传递，是自造协议 |
| **1C. SDK + `policy: never`** | 最简单：所有需要审批的动作**自动被拒**。等于放弃审批功能 —— 但和"无人值守"语义自洽，且不会静默放行 |

> **我的建议：先 1C 跑通端到端，把 1A 作为第二阶段。** 因为 1C 是 fail-closed 的（安全），而 1A 才是保留功能的终点。**绝不要**为了"能跑"把它设成 `danger-full-access` 绕过审批 —— 那等于无声取消了所有权限门。

### 缺口 2：取消 turn

SDK 协议："**No cancel or session-close methods** — a client abandons a turn by closing the runtime process."

Cyberboss 有 `cancelTurn()`（`/stop` 命令）。在 DSH 上只能：

- 关闭该 runtime 进程 → 但 Cyberboss 是多 thread 共享一个 client 的模型，关进程会**连带杀掉其它线程的进行中 turn**；
- 或者：只在"该 runtime 只服务一个 thread"的部署下才安全。

→ **建议：一期把 `cancelTurn` 实现为"关闭并重建该 scope 的 runtime 进程"，并把 `cancelTurn` 的语义在单线程 scope 下验证。** 需要确认 Cyberboss 的 thread↔process 绑定模型（见第六节）。

### 缺口 3：模型列表与能力

SDK 没有 `listModels`。Codex 适配器用 `listModels()` 填 `sessionStore` 的模型目录，并据此判断**是否支持原生图片输入**（`getTurnCapabilities` → `hasImageInputModality`）。

→ **建议：一期用一个静态模型目录**（从 `~/.dsh/settings.yaml` 的 `agent-default-model` 读取 provider/model，加一份手写能力表），`getTurnCapabilities` 返回保守值（`nativeImageInput: false, toolImageRead: true`）。

---

## 五、建议的实现方案

### 5.1 目录与文件

```
src/adapters/runtime/dsh/
  index.js         适配器主体（实现上述 16 个方法）
  rpc-client.js    JSON-RPC over stdio（换行分帧）+ 子进程生命周期
  events.js        DSH SessionEvent → Cyberboss runtime.* 事件映射
  session-store.js 会话记录读写（对标 codex/session-store.js）
  model-catalog.js 静态模型目录
test/
  dsh-rpc-client.test.js
  dsh-events.test.js
  dsh-adapter.test.js
```

`src/core/app.js` 只需加一行：

```javascript
if (config.runtime === "dsh") return createDshRuntimeAdapter(config);
```

`src/core/config.js` 加 DSH 相关项（profile 名、dsh 可执行路径、DSH_HOME、默认 provider/model）。

### 5.2 进程模型（**已定：适配器内部进程池**）

先说一个已核实的关键事实，它直接决定设计：

- `app.js:131`：`this.runtimeAdapter = createRuntimeAdapter(config)` —— **runtimeAdapter 是 app 级单例**，一个实例服务所有 workspace binding。
- 但 `cancelTurn` 是**按 thread 路由**的（`app.js:3138`）：
  ```javascript
  await this.runtimeAdapter.cancelTurn({ threadId, turnId: state.turnId, workspaceRoot });
  ```
  同理 `respondApproval` / `resumeThread` / `compactThread` 都带 `bindingKey` / `threadId` / `workspaceRoot`。

**所以"每 scope 一进程"不是 app 层的事，而是适配器内部的事** —— 对外仍是那 16 个方法的单例，内部按 workspace 维护一个 DSH 子进程池。

而 DSH 侧强制了这个选择：`initialize{cwd, provider, model}` 是**进程级**的，`sandbox-policy.workspaceRoot` 取 `process.cwd()`。

| 方案 | 可行性 |
|---|---|
| **A. 适配器内进程池：每 workspace 一个 `dsh --profile sdk`** | ✅ **唯一正确方案** |
| B. 单进程多 `sessionId` | ❌ 不可行：`cwd` 进程级 → **多 workspace 的沙箱边界会错**（安全相关）；且 `cancelTurn` 无法安全实现 |

**方案 A 的安全要求（不能含糊）**：每个 scope 的子进程必须以**该 scope 的 workspaceRoot 作为 cwd** 启动。
否则 DSH 的 `sandbox-policy.workspaceRoot = process.cwd()` 会把沙箱根设错，等于**静默放宽文件写边界**。适配器里必须有断言：spawn 时 `cwd === scope.workspaceRoot`，不匹配就拒绝启动。

`cancelTurn` 在方案 A 下才成立：关掉**该 workspace 的那一个** DSH 进程、重建，不影响其它 workspace。需确认它不会连带影响同 workspace 内其它线程的进行中 turn（DSH 一个进程内可能有多个 sessionId）。

### 5.3 实施阶段

| 阶段 | 内容 | 可验证产物 |
|---|---|---|
| **0. 协议打通** | 手写最小客户端，对 `dsh --profile sdk` 完成 `initialize` → `session/prompt` → 收到 `session.event` → `shutdown` | 一个能跑通的 Node 脚本 + 打出的原始事件流 |
| **1. 适配器骨架** | `rpc-client.js` + `events.js`，接进 `app.js` | `dsh-rpc-client.test.js` / `dsh-events.test.js` 通过 |
| **2. 端到端只读** | `CYBERBOSS_RUNTIME=dsh` 起服务，发一条微信消息，拿到回复 | 微信里真实收到回复 |
| **3. 审批决策** | 落 1C（never）或启动 1A（ACP） | 审批路径有明确行为 |
| **4. cancelTurn** | 单 scope 关进程重建 | `/stop` 可用 |
| **5. 会话/模型** | session-store + 静态目录 | 会话恢复、模型展示 |

**阶段 0 是最关键的一步**，成本低（半天内），且能在写适配器之前就把"协议猜错"的风险清零。**建议先做阶段 0。**

### 5.4 部署注意

- 现在 `dsh` 是从 **`_npx` 缓存**跑的（`AppData\Local\npm-cache\_npx\...`）。生产化应把它作为**显式依赖**固定版本（`@deepseek-ai/dsh@0.1.5-rc.1`），否则 npx 缓存被清理就断了。
- `dsh --profile sdk` 首次运行会**自动初始化 profile**（从内置模板），这是有副作用的写操作，应显式做一次并纳入部署文档。
- **无协议版本协商**：`serverInfo.version` 是 `0.0.1` 且客户端不校验；README 明说"pre-release stance, no compatibility promise"。→ 适配器必须**锁版本**并在握手时校验 `serverInfo.name === 'deepseek-harness-sdk-runtime'`。

---

## 六、需要你拍板

1. **审批流怎么办？** 1A（上 ACP，保留微信审批，工作量大）/ 1B（自写旁路 answerer，自造协议）/ **1C（`policy: never`，一期先放弃审批，fail-closed）**。
   我建议 **1C 起步、1A 作为目标**。
2. **进程模型选 A 还是 B？** 我建议 A（每 scope 一进程），因为 B 无法正确隔离 workspace 的沙箱边界。
3. **要不要先做阶段 0？** 我建议先花小成本把协议打通，再决定是否投入完整适配器 —— 避免在假设上写几千行。
4. **是否与 Codex 并存？** 我建议**并存**而不是替换：`CYBERBOSS_RUNTIME` 已经支持切换，出问题可以立刻切回 Codex。**不建议删掉 Codex 适配器。**

---

## 七、仍然需要做的事

- ~~Cyberboss 的 thread↔runtime 进程绑定模型~~ → **已核实并实现**：runtimeAdapter 是 app 级单例，进程池放适配器内部（见 5.2）。
- ~~`getTurnCapabilities` 的图片路径~~ → **已实现**：`nativeImageInput: true`（DSH 支持内联 png/jpeg/webp/gif）/ `toolImageRead: false`。**尚未用真实图片端到端验证**。
- **`compactThread` / `refreshThreadInstructions` / `listTurnGeneratedImages`** → 一期按约定返回 no-op / 空数组（`compactThread` 返回 `{compacted:false, reason:"unsupported_by_dsh_sdk"}`）。`/compact` 命令在 DSH 下无效，已如实反映。
- **审批协作 session（第二阶段）**：`respondApproval` 目前返回 `false` 并如实声明不支持。要做成你要的"第二个 session 裁决"，需要新增一个 DSH profile 插件（answerer 注册在 `approval/request` 瀑布上），并把裁决请求桥接到 Cyberboss。协议侧前提**已验证**（见第四节缺口 1：`callId` → 配对 `tool/call` 即得真实命令）。
- **`cancelTurn` 的粒度**：当前按"runtime 所属 thread"选择要拆的 runtime；给不出 thread 提示时会拆掉所有 runtime。需要在实际多线程使用中确认这是否够用。

---

## 八、风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| 沙箱根设错（`cwd` 与 workspaceRoot 不一致） | **高** | ✅ 已实现：spawn 提前到 `ensureRuntime()` 且 cwd 即 workspace；`test/dsh-adapter.test.js` 断言"每个 workspace 用自己作为 cwd spawn、同一 workspace 复用、不同 workspace 不共享" |
| 审批功能静默失效或被迫放开 | **高** | ✅ 已实现 fail-closed：无 answerer 时 DSH 返回 `unavailable` 并拒绝动作（实测文件未被创建）；适配器 `respondApproval` 返回 `false` 而非假装成功 |
| 流式降级被误认为故障 | 中 | 如实写入 `describe().limitations.streamingReplyDelta = false` |
| DSH 是 `0.1.5-rc` 预发布、无协议版本协商 | 中 | ✅ 已实现：握手校验 `serverInfo.name === "deepseek-harness-sdk-runtime"`，不匹配即拒绝 |
| `dsh` 目前从 `_npx` 缓存运行 | 中 | 生产化改为显式依赖（**尚未做**） |
| 丢弃 `/compact` 等能力 | 低 | 如实返回 unsupported，不静默假装成功 |
