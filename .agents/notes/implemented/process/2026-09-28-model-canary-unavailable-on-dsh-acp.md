# Agent Note: 模型 E2E 金丝雀在 dsh-acp 上结构性不可用（已关）

Status: implemented

## Problem

心跳从 09-15 起长期红在模型金丝雀上：

```
model E2E pipeline blocked after 2 consecutive routine failures;
code=MODEL_CANARY_HANDOFF_FAILED; nextDue=2026-09-15T16:15:42Z; repair=false
```

状态文件 `cyberboss-watchdog-model-canary.json` 里最后一次尝试是 2026-09-14T16:15:47Z，错误
`model canary side-effect containment policy is unavailable`，此后 `nextDueAt` 冻在
09-15（`attempts` 只有 1 条）——即它早就不再尝试，只是每轮心跳都把这个陈旧结论当"当前故障"报出来。

根因在运行时适配器，不在金丝雀：`src/core/app.js:1136` 要求
`runtimeAdapter.supportsExecutionPolicy("model_canary_deny_side_effects") === true`，而

- `src/adapters/runtime/dsh-acp/index.js:308`：**明确拒绝**该策略（"ACP has no such isolation
  mode, so the adapter refuses rather than pretend to enforce it"）；
- `src/adapters/runtime/dsh/index.js:564`：同样拒绝；
- 只有 `src/adapters/runtime/codex/index.js:120` 返回 true。

本机 `CYBERBOSS_RUNTIME=dsh-acp`，所以这条检查**设计上就跑不了**：它要求一个"运行时无法影响"的
隔离档位（独立 app-server / 独立鉴权档），ACP 没有等价物。历史上最后一次 `verified` 是
2026-09-12（切到 dsh-acp 之前），之后 09-13 超时、09-14 handoff 失败，再没成功过。

## Decision

`CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY=false`。理由：它不是"坏了"，是"在这个运行时上不成立"；
继续开着只会让心跳永久红，而永久红会掩盖真故障（今天已经因为同类"永久 deferred / 永久红"浪费了
大量排查时间）。

保留的自检不变：普通心跳金丝雀（当前 `healthy/verified`，trigger=5、reply=6）仍然端到端验证
"发送 → 入站 → 运行时回复 → 账本核验"。差别只在于：模型金丝雀额外要求那一轮**没有副作用能力**
（隔离档位），普通金丝雀跑的是常规回合。

## Alternatives considered

- **给 dsh-acp 加一个隔离档位**（例如另起一个受限 profile 或独立鉴权档）：这是真正的解法，但属于
  运行时能力扩展（要 DSH 侧支持"这一轮不允许写/不允许外呼"），不是配置能解决的；留作将来选项。
- **把运行时切回 codex**：能让模型金丝雀恢复，但整个收发栈是按 dsh-acp 搭的（`--profile acp`、
  patch、repair session 都在用），为一个自检换运行时代价过大。
- **保留开启但把它的失败降级为告警**：等于在心跳里塞一个永远为真的例外，下次真出问题时没人会看。
- **什么都不做**：心跳永久红——今天已经证明这种状态会让人（和自动化）去追错的线索。

## Consequences

收益：心跳恢复 `heartbeat healthy`（`action=none`，退出码 0），红/绿重新只反映真实故障。

代价与边界：

- 失去"模型回合 + 回复"的**副作用隔离**版本端到端验证；普通金丝雀不保证那一轮无副作用。
- `CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY` 只写在本机 `.env`（该文件不入库），所以**这条决定只靠
  本笔记留痕**：换机器或重新初始化时，若运行时是 codex，可以把它开回来。
- 若将来 dsh-acp 支持隔离档位，应同时改回开关并删掉本笔记的"不可用"结论。