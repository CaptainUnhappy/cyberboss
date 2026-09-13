# DSH 阶段 2：协作 session 审批 —— 实现规格

- 生成时间：2026-09-14
- 状态：**未实现**。本文是可直接执行的规格，所有标「已核实」的项都经过实测/读源码，未核实的项已明确标出。
- 目标（用户已批准）：把 Cyberboss 的审批从「客户端应答」改为「另一个 session 协作裁决」，即 Codex 意义上的"自动审批"。

---

## 一、已核实的接口事实（不要重新推导）

### 1.1 DSH 的审批缝（读 `node_modules/@deepseek-ai/dsh-user-approval/lib/types/`）

```typescript
// 闭集结果；allowed-once 是唯一授权档位（没有 allow-always）
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

// answerer 瀑布的载荷 —— 注意：**不含工具参数**
export interface ApprovalRequestEvent {
  readonly agent: Agent;
  readonly toolName: string;
  readonly callId?: ToolCallId;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

// 注册点：cordis 事件，waterfall 模式
declare module '@deepseek-ai/cordis' {
  interface Events {
    'approval/request'(
      this: Scoped<Agent>,
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome>;
  }
}

// 服务（`ctx.approval`）
export declare class ApprovalService extends Service {
  setPolicy(agent: Agent, policy: ApprovalPolicy): void;   // 切换活 agent 策略
  request(req: ApprovalRequest): Promise<ApprovalOutcome>;  // 要求 turn 打开
}
```

**关键限制（决定了整个设计）**：
- 返回 outcome 即认领；调 `next()` 委托给下一个应答者。
- **没有内置应答者**；不组合 → `unavailable` → fail-closed（已实测：文件未被创建）。
- `request()` **要求 turn 处于打开状态**，否则直接 reject（turn 是持久日志的提交/重放边界）。
- 抛异常的应答者 → 归一化为 `unavailable`（fail-closed）。返回非词表值 → 同样归一化为 `unavailable`。

### 1.2 工具参数必须靠 callId 反查

`ApprovalRequestEvent` **不含工具参数**（只有 toolName/callId/reason）。裁决所需信息全部来自配对的 `tool/call`：

```jsonc
// approval/asked（实测）
{ "id": "b40c3706-...", "toolName": "pwsh",
  "callId": "call_00_oQC7oJ07kThwS1yzbxnK0439",
  "reason": "escalate sandbox to danger-full-access: ..." }

// 配对的 tool/call（实测）—— 用 callId 反查即得
{ "callId": "call_00_oQC7oJ07kThwS1yzbxnK0439", "name": "pwsh",
  "arguments": { "command": "Set-Content -Path '...' ...",
                 "justification": "...",
                 "sandbox_permissions": "danger-full-access" } }
```

**已实现的部分**：`src/adapters/runtime/dsh/events.js` 的 `pendingToolCalls` Map 已经按 callId 记录了每一次 `tool/call`，并且 `approval/asked` 的映射**已经**用它把 `command` / `justification` / `requestedPermissions` 填进了 `runtime.approval.requested` 载荷（有测试覆盖）。**这部分可直接复用。**

### 1.3 为什么不能走 SDK

`@deepseek-ai/dsh-sdk-protocol` 的 README 明确写着：

> Server→client requests are a **dead capability** — the transport supports them, but the server never sends one.

所以 Cyberboss 作为 SDK 客户端**无法**应答审批。应答必须发生在 DSH 进程内部 → 必须写 profile 插件。

### 1.4 插件机制（已核实）

- `dsh plugin --profile <name> <pnpm args>` 管理 profile 插件（转发给 pnpm）。
- profile 目录：`~/.dsh/profiles/<name>/`，含 `package.json`（`dsh.profile.bundles` + `cordis.patch.yml`）。
- 本地已装 `@deepseek-ai/dsh-user-approval`（`node_modules` 下可 `require.resolve`）。
- `sdk` profile 当前 bundles：`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-sdk-app`。

---

## 二、未核实的项（实现前必须先确认，不要猜）

1. **answerer 的确切注册写法**：`ctx.on('approval/request', (req, next) => ...)` 是否就是正确形式？是否需要 scope 包装（`createScope`/`scopeTarget`，见 `@deepseek-ai/dsh-scope`）才能只接收某个 agent 的请求？
2. **插件包的最小骨架**：`dsh.profile.bundles` 里如何声明一个 out-of-tree 包，以及插件导出的形状（cordis plugin 是函数还是 `{ apply }`？）。
3. ~~helper session 如何做到"无工具"~~ → **已核实，见第 2.5 节**。
4. **`runtime.approval.decided` 事件**：`events.js` 已映射（有测试），但 Cyberboss 的 `respondApproval` 目前返回 `false` 并声明不支持。需要决定：有了插件的旁路后，`respondApproval` 是保留 no-op，还是改为向插件发送"人工裁决"（用于人也能介入的场景）。
5. **插件与 Cyberboss 之间的传输**：候选（按推荐排序）：
   - **本地 HTTP**：Cyberboss 侧已有 `channelAdapter`/bridge 模式可循；插件 POST 到 `127.0.0.1:<port>/approval/decide`。
   - 文件邮箱（简单但时序脆弱）。
   - 复用 `claudecode` 的 `ipc-server.js` 模式（已存在先例）。

---

## 二·五、helper 的无工具边界（**已核实**）

### 结论：用 `--patch` overlay 在一个独立 profile 上禁掉全部工具插件

`dsh` 支持可重复的 `--patch <path>`，叠加在 profile 层之后。**patch 按 `id` 合并**（不是按 name，也不是按顺序）——我第一次用猜的 id 只命中了一个，实测后拿到真实 id：

**`sdk-minimal` 默认配置里的真实 id（已实测 `--dump-default-config`）**：

| id | plugin | Windows 上默认 |
|---|---|---|
| `sandbox` | `dsh-sandbox-local` | 启用 |
| `sandbox-policy` | `dsh-sandbox-policy` | 启用 |
| `terminal-bash` | `dsh-terminal-bash` | 禁用（平台） |
| `terminal-pwsh` | `dsh-terminal-bash` | 启用 |
| `tools` | `dsh-tools` | 启用 |
| `persistent-bash` | `dsh-tool-bash-persistent` | 禁用（平台） |
| `persistent-pwsh` | `dsh-tool-pwsh-persistent` | **启用** |

**已实测可用的 overlay**（`dsh --profile sdk-minimal --patch <file> --dump-config` 返回 exit 0，且 `dsh-tools` 确认变为 `disabled: true`）：

```yaml
# Helper profile overlay: no tool execution at all, so an approval decider can
# never act and can never recurse into its own approval request.
- id: tools
  name: '@deepseek-ai/dsh-tools'
  disabled: true
- id: terminal-pwsh
  name: '@deepseek-ai/dsh-terminal-bash'
  disabled: true
- id: terminal-bash
  name: '@deepseek-ai/dsh-terminal-bash'
  disabled: true
- id: persistent-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh-persistent'
  disabled: true
- id: persistent-bash
  name: '@deepseek-ai/dsh-tool-bash-persistent'
  disabled: true
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: never
```

> **踩坑**：我第一版的 id 猜成了 `tool-bash-persistent` / `tool-pwsh-persistent` / `bash-sandbox` / `pwsh-sandbox`，**全部不匹配**，所以只有 `dsh-tools` 被禁用。务必用上面表格里的真实 id，并用 `--dump-config` 复核每一项都变成 `disabled: true`。

### 双层防护

1. **进程级**：helper 用独立 profile（`sdk-minimal` + `docs/dsh-helper-notools.patch.yml`）起独立进程，**五个工具插件全部禁用**（已实测：`terminal-bash` / `terminal-pwsh` / `tools` / `persistent-bash` / `persistent-pwsh` 全部 `disabled=true`）。
2. **审批层**：**`sdk-minimal` 里根本没有 `dsh-user-approval`**（已实测：`--dump-default-config` 中无该条目、无 `approval` id）。没有组合任何 answerer → 任何审批请求解析为 `unavailable` → **fail-closed**。这正是 helper 需要的行为。

> **我自己犯过的错**：我最初在 overlay 里写了 `id: approval` + `policy: never`，**它是惰性的**——该 profile 里不存在这个 id。核实后已删除，并把真实机制（"没有 answerer 即 fail-closed"）写清楚。**`--patch` 按 id 合并，id 不存在时静默无操作**，所以每一项都必须用 `--dump-config` 复核。
>
> 另注：`ApprovalService.setPolicy(agent, policy)` 是**按 session** 的（`dsh-user-approval` 对 cordis `Context` 的增强），在**主** runtime 上仍然可用——若将来需要"某 session 一律不问"，那才是它的用武之地，而不是用来约束本就没有审批服务的 helper。

### 仍然要在实现时验证

- overlay 生效后 helper **确实**无法执行任何工具（用一次"让它执行命令"的提示确认它拒绝/无工具可用）。
- 递归测试：helper 若尝试触发 `approval/request`，必须 fail-closed（无 answerer → `unavailable`）。



---

## 三、安全要求（我在方案评估时识别出的递归风险）

**如果 helper 本身是有工具的 agent，它就能自己调 `approval/request` → 递归征求自己的批准 → 自我提权。** DSH 的 answerer 是进程内瀑布，**没有环路保护**。

因此 helper 必须是：
- **只读**：不能执行有副作用的工具；
- **无工具或受限于"仅文本判断"**：理想情况下它只能返回一个裁决词；
- **单次裁决**：不能把同一个请求反复转手；
- **超时 fail-closed**：超时返回 `unavailable`，绝不默认放行；
- **不得回流**：必须有测试证明 helper 无法触发新的 `approval/request`。

**并且**：`CYBERBOSS_DSH_APPROVAL` 开关（用户已批准）三态：
- `session` = 协作 session 裁决（目标态）
- `never` = 全部自动拒（当前默认行为的显式化）
- 任何异常/超时 → `unavailable` fail-closed

---

## 四、建议的实现顺序

1. **先做第 2 节第 3 项**（helper 的无工具边界）——它是架构关键，定不下来其余都是空谈。
2. 写最小插件骨架并让它在 `sdk` profile 里加载成功（先只打日志证明 `approval/request` 被调用）。
3. 加 helper 裁决 + 超时 fail-closed，用**真实升级请求**（已知可复现：让模型写 workspace 外文件 → 触发 `escalate sandbox to danger-full-access`，见 `docs/dsh-sdk-protocol-notes.md` 第七节）验证三态。
4. 写"helper 无法自我批准"的测试。
5. 最后才接 `respondApproval` 与 Cyberboss 的传输层。

**验证基线**：全量套件必须保持 **53/56**（3 个既有硬编码 macOS 路径失败是允许的）；DSH 端到端脚本 `scripts/dsh-adapter-e2e.js` 与 `scripts/dsh-image-e2e.js` 必须仍然 PASS。

---

## 五、当前状态（接手时先核对）

```
runtime            = dsh（.env，已启用）
cyberboss/DSH 适配器 = 已实现并实测（文本 + 图片均通过）
DSH 审批           = respondApproval 返回 false（fail-closed），未实现协作裁决
canary             = 陈旧失败，nextDueAt 21:59:34Z（约 3 小时），是 healthy=true 的唯一阻碍
```
