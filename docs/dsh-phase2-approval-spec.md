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

## 二、本轮实测结论（2026-09-14，替换了原先的「未核实」清单）

原先第 2 节列的 5 个未知项，第 1、2、5 项已实测落地，并推翻了本文件早先的两个说法。

### 2.1 answerer 注册写法 —— **已实测生效**

`ctx.on('approval/request', (req, next) => this.answer(req, next))` **确实**会在真实升级请求上触发。

证据是**行为差分**，不是日志（插件的 `ctx.logger` 在 SDK profile 下不产出 stderr，光看日志无法区分「没被调用」和「被调用但没日志」）：

| 配置 | `approval/decided.outcome` |
|---|---|
| 不加载插件（profile 默认，无 answerer） | `unavailable` |
| 加载插件，`mode: never` | **`rejected`** |
| 加载插件，`mode: session` + `endpoint: ''` | `unavailable` |

`mode: never` 让插件在**不询问任何人**的情况下直接返回 `rejected`。outcome 随之从 `unavailable` 变成 `rejected`，只有当插件真的认领了这次瀑布才可能发生。所以：**注册签名正确，answerer 生效，且 `session` 无 endpoint 时确实 fail-closed。**

复现升级请求的提示词（已验证可复现）：让模型用 pwsh 在 workspace 之外创建文件；它先被拒，然后用 `sandbox_permissions: danger-full-access` + `justification` 重试，触发 `approval/asked` → `approval/decided`。载荷实测：

```jsonc
// approval/asked
{ "id": "5474d092-...", "toolName": "pwsh",
  "callId": "call_00_ZdoDYRG0LtxdeWkg1F1y9620",
  "reason": "escalate sandbox to danger-full-access: The target path ... lies outside the session workspace ..." }
// approval/decided
{ "id": "5474d092-...", "outcome": "rejected" }
```

### 2.2 插件包骨架 —— **已实测，但解析基准与本文件早先的假设不同**

insert 语法（对照 `@deepseek-ai/dsh-sdk-app/cordis.patch.yml` 实读）：

```yaml
- insert:
    - id: cyberboss-approval
      name: '<插件入口的绝对路径>'
      config: { mode: session, endpoint: '' }
```

**关键坑（我踩了）**：`name` 里的裸包名**不能**解析。cordis 是**相对 profile 目录**（`~/.dsh/profiles/<profile>/`）解析 loader entry 的，**不是**相对 workspace，也不是相对进程 cwd：

```
Error: Cannot find package 'cyberboss-approval' imported from C:\Users\79388\.dsh\profiles\sdk\
```

而且**这个失败是致命的**：DSH 直接 `exit 5`，整个 runtime 不可用（不是降级）。所以在启用前必须先用 `--dump-config` 做只读校验，再真跑。

两个可用的解法（都已实测）：

1. **绝对路径**（当前采用，见 `dsh-plugins/cyberboss-approval/main.patch.yml`）：`name: 'D:/Projects/cyberboss/dsh-plugins/cyberboss-approval/src/index.js'`。profile **完全不用改**。
2. 把插件装进 profile 的 `node_modules`（junction 或 `dsh plugin --profile sdk add`），然后就能用裸包名。

**已实测不可用**：`name: !!js "process.env.X"` → `TypeError: name.startsWith is not a function`。patch 里的 `!!js` 不能用来生成 `name`。

因为路径写错就是 exit 5，`test/dsh-approval-patch.test.js` 把这个路径钉住了：断言它存在、与 `package.json` 的入口一致、且 overlay 只 insert 不 disable 别的东西。

### 2.3 修正：`sdk` profile **有** approval 服务

本文件第 2.5 节末尾曾说「`sdk-minimal` 里根本没有 `dsh-user-approval`」——那句对 `sdk-minimal`（helper）成立，但**不要误推到 `sdk`（主 runtime）**：`dsh --profile sdk --dump-config` 里**有** `- id: approval / name: '@deepseek-ai/dsh-user-approval'`。

主 runtime 的问题是**没有 answerer**（不是没有服务），所以每次升级都解析成 `unavailable`。这正是本插件要补的那一格。

### 2.4 仍然未核实

1. **`respondApproval` 的最终语义**：有了插件旁路后，是保留 no-op，还是让 Cyberboss 把「人工裁决」也送进同一个决定通道。未决。
2. **插件 → Cyberboss 的传输**：未实现。候选仍是本地 HTTP（见第 2 节第 5 项原文）。当前 `decide()` 是 stub，恒返回 `unavailable`。
3. **`patchPaths` 还没从 adapter 接到 client**：`src/adapters/runtime/dsh/rpc-client.js` 支持 `--patch`，但 `index.js` 的 `ensureRuntime()` 还没把配置传下去。启用开关（`CYBERBOSS_DSH_APPROVAL`）也还没接。


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
DSH 审批           = 插件已写好并通过 live 差分验证会认领瀑布；
                     但 decide() 仍是 stub，传输/启用开关/patchPaths 接线都还没做，
                     所以线上仍是 fail-closed（= 安全的一侧）
用户 profile        = 未被修改（验证用的 node_modules junction 已删除）
canary             = budget_daily 推迟；下一次真正可跑约 2026-09-14T04:01:33Z，
                     是 healthy=true 的唯一阻碍
```

### 下一步（按顺序）

1. 把 `patchPaths` 从 config 接到 `ensureRuntime()` → `DshRpcClient`，由 `CYBERBOSS_DSH_APPROVAL` 三态控制是否加载 `main.patch.yml`。
2. 实现 `decide()` 的本地 HTTP 传输 + Cyberboss 侧 `POST /approval/decide`（内部调用已有的 `src/core/approval-decider.js`）。
3. 三态端到端复验：`never` → `rejected`；`session` + 无 endpoint → `unavailable`；`session` + 有 endpoint → 按 helper 裁决返回。
4. 补「helper 无法自我批准」的测试（第 4 节第 4 步，仍未做）。

