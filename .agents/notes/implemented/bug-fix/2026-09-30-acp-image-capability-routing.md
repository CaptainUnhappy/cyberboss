# Agent Note: ACP 适配器不再谎报图片能力（图片轮不再整轮失败）

Status: implemented

## Problem

把入站图片真正送进运行时之后（见 [跨用户媒体路径](2026-09-30-cross-user-media-paths.md)），图片轮整轮失败：

```
❌ Request failed
Invalid params: inline image prompts were not advertised by this connection
```

`@deepseek-ai/dsh-acp` 的 `admitAcpPrompt` 在 `initialize` 时把
`agentCapabilities.promptCapabilities.image` 设为 `supportsAcpImagePrompts(...)` 的结果——
即"当前 provider/model 的 `inputModalities` 是否含 image"。本部署的模型是纯文本的，所以它诚实地广播 `image: false`；
而 `src/adapters/runtime/dsh-acp/index.js` 的 `getTurnCapabilities()` **无条件返回 `nativeImageInput: true`**：

```js
getTurnCapabilities() {
  return { nativeImageInput: true, toolImageRead: false };   // ← 谎报
},
```

`app.js` 的 `resolveVisionContext` 正是拿这个能力决定图片走哪条路（native / tool / caption）。
谎报的后果：图片被塞成 inline image block → ACP 服务端按协议拒绝 → 整轮以错误消息结束，用户看到的是错误而不是回复。

## Decision

三处改动合起来才算"能收图"：

1. `src/adapters/runtime/dsh-acp/rpc-client.js`：新增 `promptCapability(name)`，读
   `agentCapabilities.promptCapabilities[name] === true`（与既有 `sessionCapability()` 同形）。
2. `src/adapters/runtime/dsh-acp/index.js`：`getTurnCapabilities()` 返回
   `{ nativeImageInput: record.client.promptCapability("image"), toolImageRead: false }`；
   record 按 `config.workspaceRoot` 取，取不到再退到唯一那个运行实例；**没有任何实例时返回 false**
   （进程还没 initialize 就不该声称能收图）。
3. **模型也要真的是能看图的那个**（这一步才是根）：ACP profile 出厂把 `@deepseek-ai/dsh-acp` 配成
   `model: deepseek-v4-flash`，而模型目录里这一条**没有 image 模态**（`inputModalities` 缺省 `["text"]`），
   所以 `supportsAcpImagePrompts()` 一开始就返回 false。目录里同一 provider 下能看图的是
   **id `deepseek-flash`（显示名 "DeepSeek-V41-Flash"，`inputModalities: [text, image]`）**。
   - 新增 overlay `src/adapters/runtime/dsh/acp-model.patch.yml`（`- id: acp` → provider/model 钉到
     `deepseek-official` / `deepseek-flash`），由 `resolveAcpModelPatchPath()` 提供，
     与既有的 attachment-limits overlay 一起进 `patchPaths`；`--patch` 按 id 合并，写错 id 是**静默 no-op**，
     所以 `test/dsh-acp-model-patch.test.js` 断言**组合后的配置**，不只断言 overlay 文本。
4. **ACP 的模型是"每会话"存储的**：老会话（在我们钉新模型之前创建的）在 `session/resume` 后仍带着
   `deepseek-v4-flash`，于是即便连接已广播 `image: true`，那一轮依旧报
   `model "deepseek-v4-flash" does not declare image input`。所以：
   - `rpc-client` 记住 `session/new`、`session/resume`、`session/set_config_option` 返回的 config options
     （ACP 没有"读取选项"的独立请求），新增 `getSessionConfigOptions()` / `setSessionConfigOption()`；
   - `alignSessionModel()` 在每轮 `resolveSessionId()` 之后把会话的 `model` 选项对齐到配置值
     （值形态是 ACP 广播的 JSON 数组 `["<provider>","<model>"]`），**尽力而为**：没有该选项/没列出该值/调用失败
     都只打日志、不阻断回合。这样**不用丢弃会话历史**就能换模型。

## Verification

`tmp/image-then-text-e2e.js`（图先发、9 秒后发"图里的 IMG_TOKEN 是多少？原样念给我"）在真机跑通：

| 步骤 | 证据 |
|---|---|
| 图片进入运行时 | 事件不再进死信，附件路径落在 `~/.cyberboss/weflow-media-cache/…`（340 626 字节） |
| 图 + 文算一条输入 | 只有一条"处理中"，一轮回复 |
| 连接广播能力 | `tmp/probe-acp-capabilities.js` → `promptCapabilities.image: true`（钉模型前是 false） |
| 老会话被对齐 | 日志 `dsh-acp session 52851026-… model aligned to deepseek-official/deepseek-flash` |
| **模型真的读了图** | 聊天 id=320：`IMG-9895F2015C5A`（图里唯一的红字 token） |

## Alternatives considered

- **保持 `nativeImageInput: true`，改为在适配器里把图片降级成 `[attachment] <path>` 文本块**：最强理由是"反正模型看不见图，
  给路径就好"。否决原因：那会**绕过** `resolveVisionContext` 已有的 caption 能力——配了视觉服务时也就永远描述不出来；
  而且把"能不能看图"这个判断复制到适配器里，与 app 的能力协商重复。
- **只改 `getTurnCapabilities()`（能力照实转述），不动模型**：那样图片轮不再整轮失败，但模型**永远看不见图**
  （纯文本 v4-flash + 未配视觉服务），用户的诉求（"让它看图"）没解决。实测 v4-flash 那条路只会回"我无法查看图片内容"。
- **换 provider/model 时直接丢会话**（清掉窗口的 session id，下一轮 `session/new` 拿新模型）：最强理由是实现最简单、
  一步到位。否决原因：会丢掉该窗口的全部上下文记忆；而 ACP 已经提供 `session/set_config_option`，
  对齐模型可以**保留历史**完成，没有理由用破坏性的办法。
- **在 ACP 服务端忽略 `image: false`**（改上游 dsh-acp）：把"模型不支持图片"变成运行时的静默失败，
  最终错误会以更难懂的形式出现（provider 报错），否决。
- **图片轮直接不分发**（检测到无视觉能力就不建轮）：用户会连一句"我看不到图"都收不到，比现在的行为更差。

## Consequences

收益：图片轮不再整轮失败；能力协商变成"ACP 说什么就是什么"，模型/配置变了会自动跟着变；
**当前部署下模型（DeepSeek-V41-Flash）能直接读图**，不需要额外视觉服务；模型变更不再需要丢弃会话历史。

代价与边界：

- 模型是**部署事实**：`acp-model.patch.yml` 把 profile 钉在 `deepseek-flash`；若某个部署要用别的 provider
  （目录里还有 `zai-coding-cn` 的 glm 系列），改这一个 overlay 即可，但必须同步确认那条模型声明了 image 模态。
- `alignSessionModel()` 每轮都会看一眼会话选项（无网络调用，取的是缓存），值为空或选项缺失时静默跳过；
  真正的切换只在第一次发生。
- `getTurnCapabilities()` 的取值依赖 ACP `initialize` 已完成（app 启动时就会 `initialize()`）；在这一刻之前一律返回 false，
  属于保守方向。
- 若某天把模型换成不支持图片的，行为会退回"诚实告知看不到图"，不会再整轮失败。
- 测试：`test/dsh-acp-adapter.test.js` 19/19（能力转述 + 会话模型对齐 + 已对齐不重设 + 无 model 选项时无害）、
  `test/dsh-acp-model-patch.test.js` 2/2（overlay 存在 + 组合配置钉到 deepseek-flash）。
