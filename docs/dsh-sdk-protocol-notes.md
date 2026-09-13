# DSH SDK 协议 —— 实测参考（Phase 0 结果）

- 生成时间：2026-09-12
- 来源：**对本机 `dsh --profile sdk` 的真实抓包**，不是文档转述
- 探针：`scripts/dsh-probe.js`（可复现，见文末）
- 原始 dump：`%TEMP%\dsh-events.jsonl`、`%TEMP%\dsh-tool-events.jsonl`、`%TEMP%\dsh-approval-events.jsonl`

---

## 一、握手与基本事实（已实测）

| 项 | 实测结果 |
|---|---|
| 传输 | JSON-RPC 2.0，**换行分帧**，stdio |
| 启动 | `node <...>/@deepseek-ai/dsh/lib/bin.js --profile sdk`，`cwd` = workspace |
| `initialize` | `{cwd, provider, model}` → `{serverInfo:{name:"deepseek-harness-sdk-runtime", version:"0.0.1"}}` |
| 首次启动 | 冷启 **~50 秒**（自动初始化 profile）；热启 **~2 秒** |
| `session/prompt` | `{sessionId, contentBlocks}` → `{messageId}`（**入队回执，非答案**） |
| `sessionId` | **客户端生成**；未知 id 惰性创建 agent+session |
| `shutdown` | → `{}`，进程随后退出 |
| stderr | 全程为空（正常路径） |

**首次冷启动 50 秒是个部署现实**，适配器的 `initialize()` 超时必须按此设置，不能沿用 Codex 的短超时。

---

## 二、事件信封结构（**关键，文档没写清**）

```jsonc
{
  "jsonrpc": "2.0",
  "method": "session.event",
  "params": {
    "sessionId": "cb-probe-...",
    "event": {
      "type": "assistant/message",
      "seq": 12,
      "time": 1789287491112,
      "data": { /* ← 真正的载荷在这里，不在顶层 */ },
      "surfaceOp": { /* 可选，仅部分事件有 */ }
    }
  }
}
```

> **踩坑提醒**：载荷在 `event.data`，不在 `event` 顶层。`session/title`、`turn/start`、`assistant/message`、`user/message` 带 `surfaceOp`；`turn/end`、`step/*`、`tool/*` 不带。

---

## 三、精确事件形状（逐字段实测）

```jsonc
// turn/start
{ "turn": 1 }

// turn/end          ← 这才是「本轮结束」信号
{ "turn": 1, "reason": { "kind": "completed" } }
//   reason.kind ∈ completed | aborted | blocked | error | max-tokens | interrupted

// step/start, step/end
{ "turn": 1, "step": 1 }

// user/message      （一次 prompt 会触发 3 次：原文 + 注入的上下文）
{ "content": [{"type":"text","text":"..."}],
  "source": {"kind":"user"}, "role": "user", "id": "<messageId>" }

// session/title
{ "title": "...", "messageSeqs": [8], "source": {"kind":"fallback"} }

// assistant/message
{ "turn": 1, "step": 1,
  "message": { "role":"assistant",
               "content":[{"type":"text","text":"DSH_PROBE_OK"}],
               "source":{"kind":"model","provider":"deepseek-official","model":"deepseek-flash"},
               "id":"e63cfd68-..." },
  "usage": {"inputTokens":202,"outputTokens":6,"totalTokens":9808,
            "cacheReadTokens":9600,"reasoningTokens":0},
  "stream": [ {"type":"chunk","time":...,"chunk":{"type":"block-start","index":0,"blockType":"text"}},
              {"type":"text-chunks","time":...,"index":0,"dt":[16,1,0,0],
               "texts":["DS","H","_PRO","BE","_OK"]},
              {"type":"chunk","time":...,"chunk":{"type":"block-end","index":0,
               "block":{"type":"text","text":"DSH_PROBE_OK"}}},
              {"type":"chunk","time":...,"chunk":{"type":"usage",...}},
              {"type":"chunk","time":...,"chunk":{"type":"finish","reason":{"kind":"stop"}}} ] }

// tool/call
{ "turn": 1, "step": 1,
  "callId": "call_00_oQC7oJ07kThwS1yzbxnK0439",
  "name": "pwsh",
  "arguments": "{\"command\":\"...\",\"description\":\"...\"}" }   // ← JSON 字符串，需二次 parse

// tool/result
{ "turn": 1, "step": 1, "callId": "..." }
```

`assistant/message.data.message.content[]` 的块类型：`text`、`reasoning`、`tool-call`。
**一次 step 的 `assistant/message` 可能只含 `tool-call`**（模型决定调工具时），文本在后续 step 才出现 —— 映射时不能假设每个 `assistant/message` 都有文本。

---

## 四、⚠ 流式：`reply.delta` 无法真流式

**实测：一轮对话只发出 1 个 `assistant/message`，`assistant/attempt` 完全没出现。**

文本块是在**最终事件里一次性**带过来的（`stream[].texts` 是事后的时序记录，不是增量通知）：

```
[   0ms] prompt
[2293ms] step/start
[7132ms] assistant/message   ← 一次性到达
[9969ms] turn/end
```

**结论**：适配器拿不到 token 级增量，`runtime.reply.delta` 只能：

- **方案 A（忠实的）**：不发 delta，只在 `assistant/message` 发完整的 `reply.completed`；
- **方案 B（伪流式）**：收到 `assistant/message` 后，把 `content` 分块按短间隔依次作为 delta 发出，再发 `completed`。**视觉上与现在接近，但不是真流式**（内容其实早已全部拿到）。

**影响**：微信里的"逐字蹦出"会退化成"整条到达"或"事后快放"。功能不丢,体验降级。

**缓解**：`tool/call` / `tool/result` / `step/start` 是**实时**到达的 → 工具执行期间仍能有真实进度反馈（见下）。

---

## 五、工具调用是实时的（好消息）

```
[2293ms] step/start
[7132ms] assistant/message  → 含 tool-call 块
[7136ms] tool/call          → name="pwsh", callId=..., arguments={command,description}   ← 实时！
[8346ms] tool/result        ← 实时
[9963ms] assistant/message  → text
[9969ms] turn/end
```

`tool/call` 在**模型决定调用时**就到达（不等 tool/result）。所以 `runtime.tool.started` 可以真实时发。

---

## 六、审批缝（**已验证可介入**）

### 触发条件
模型把操作**升级重试**时触发 —— 例如沙箱拒绝后带 `sandbox_permissions: "danger-full-access"` 重试同一条命令。

### 事件序列（实测）
```
[tool/call #3]  arguments 含 {command, description, justification, sandbox_permissions:"danger-full-access"}
[approval/asked]   seq 21
[approval/decided] seq 22   ← 1ms 后！无 answerer → 立即 fail-closed
[tool/result]
```

### 载荷
```jsonc
// approval/asked
{ "id": "b40c3706-8b7c-4593-a58a-88bc117924bc",
  "toolName": "pwsh",
  "callId": "call_00_oQC7oJ07kThwS1yzbxnK0439",     // ← 关联到 tool/call
  "reason": "escalate sandbox to danger-full-access: The target path is outside the session workspace..." }

// approval/decided
{ "id": "b40c3706-...", "outcome": "unavailable" }   // ← 无 answerer 的默认，fail-closed
```
`outcome ∈ allowed-once | rejected | cancelled | unavailable`。**`allowed-once` 是唯一授权档位**（没有 allow-always）。

### 协作 session 裁决所需信息 —— 全部可得
用 `approval/asked.callId` 配对本轮此前的 `tool/call`，即得：
- `arguments.command` — **真实要执行的命令**
- `arguments.justification` — 模型自述的升级理由
- `arguments.sandbox_permissions` — **请求的权限档位**
- `approval/asked.reason` — 升级说明

### 兜底语义（已验证）
无 answerer 时**自动 `unavailable` → fail-closed**，实测文件未被创建。**这个安全默认不需要我们实现，是 DSH 内建的。**

### 注册 answerer 的 API 路径
- `ctx.approval: ApprovalService`（`dsh-user-approval` 对 cordis Context 的增强）
- 监听 `approval/request` 事件（**瀑布模式**）：返回 outcome 即认领，或调 `next()` 委托
- `@deepseek-ai/dsh-scope` 提供 `createScope` / `scopeTarget` 做 agent 级作用域过滤

---

## 七、复现方式

```powershell
# 基础往返 + 全量事件形状
node scripts/dsh-probe.js --timeout 150000 --dump "$env:TEMP\dsh-events.jsonl"

# 工具调用（验证 tool/call 实时性）
node scripts/dsh-probe.js --prompt "Run the shell command: echo X. Then reply with the output."

# 审批路径（会让模型请求 danger-full-access）
node scripts/dsh-probe.js --prompt "Use the pwsh tool to run: Set-Content -Path '<workspace 外的路径>' -Value X"
```

探针特性：净化重复环境变量键（本机有 `NO_PROXY/no_proxy` 等，否则 Windows 拒绝创建进程）、按类型全量/仅形状 dump、超时保护。

---

## 八、对适配器的直接约束（由实测推出）

1. `initialize` 超时 ≥ 90 秒（冷启 50s）。
2. 事件映射读 `event.data`，**不是** `event`。
3. `turn/end` 是唯一可靠的"本轮结束"信号。
4. `assistant/message` 可能无文本（纯 tool-call step），需跳过。
5. `tool/call.arguments` 是 JSON 字符串，需 try/parse。
6. 不发真 `reply.delta`（选方案 A 或 B）。
7. 握手必须校验 `serverInfo.name === "deepseek-harness-sdk-runtime"`。
8. `sessionId` 由客户端生成并持久化 → 天然支撑 `resumeThread`。
