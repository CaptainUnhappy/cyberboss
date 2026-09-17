# Agent Note: dsh 对话会话改为「每窗口固定一个 + 复用不新建」

Status: proposed

## Problem

机器人的对话会话在 DSH 侧栏堆成一长串（`user\Unhappy` 工作区下 16 个），用户看到的是一排没有名字、只能靠时间辨认的记录。两个独立原因：

1. **每次运行时重生就换一个新会话 id**。适配器目前的选择是"新进程无法续接旧会话 → 直接用新 id 继续"（`src/adapters/runtime/dsh/index.js` 里那段 `isSessionAlreadyExistsError` 恢复：`dsh session ... is not resumable in a new runtime process; continuing on a fresh session`）。而 `@deepseek-ai/dsh-acp` **其实实现了 `session/resume`**（README 明写：恢复已持久化且非活跃的会话、校验规范工作区、恢复日志但不回放旧更新）——适配器没有用它。于是每次重启/`/stop`/取消，都会多出一个会话。
2. **所有窗口共用一个会话**。绑定键是 `workspaceId:accountId:senderId`，而 weflow 入站的 `senderId` 是官方 bot openid（`o9cq...@im.wechat`），与具体微信窗口无关 → Azzy、柳毓琳、美女的对话上下文全在同一段会话里，既不隔离，也无法"每个窗口一个固定会话"。

另外三件事和会话管理绑在一起：会话的 cwd 决定侧栏分组（只有被 `~/.dsh/storages/workspace.json` 收录的会话才归组，其余进"未分组"）；标题由 `session-title-first-prompt-llm` 用 LLM 从首条消息生成（实测补丁里的 `disabled: true` 关不掉它）；用户还要求留一个专用测试会话。

## Proposal

（用户已确认的方向）

1. **会话 id 确定化**（已落地）：不再随机 `dsh-<时间戳>-<随机>`，改为由"窗口身份"派生的稳定 id
   `cbw-<sha256(binding + 工作区 + 会话键)[:16]>`；窗口与 id 的映射写进 `dsh-sessions.json`，可读可查。
   同一次改造把会话查找按"窗口"分维度（`weflow:<talker>` 作为会话键），并让 `[test]` 的轮次走保留的
   `test-session`，工作区固定为 `D:\Projects\cyberboss\user\cyberboss`。
2. **重生时续接**（受阻，见下）：适配器的 rpc-client 已加 ACP `session/resume` 调用、适配器也按
   "先探测磁盘上是否已持久化，再尝试 resume，失败才回退新建"的顺序接线；但**本机装的 sdk profile
   不实现该方法**（实测报错 `unknown DeepSeek Harness SDK runtime method: session/resume`）；
   判定结果现在会缓存，只警告一次，不再每轮重试。
   因此"重启后复用同一段上下文"在当前 DSH build 上做不到，三个可选路线：
   - **A. 一个窗口一行（重启清空该行历史）**：新建会话前删掉该窗口的旧会话，侧栏永远只有一个窗口一行，
     代价是重启丢掉历史。改动最小。
   - **B. 换 ACP 面**：让 sdk profile 改挂 `@deepseek-ai/dsh-acp`（它真的有 resume/list），
     适配器的协议层（方法名、参数、事件映射）需要跟着重写。收益是既保留上下文、又能读会话标题。
   - **C. 维持现状**：保留确定化 id 与按窗口隔离，但每次重启多一行（上下文重置）。
3. **按窗口隔离**：会话查找键加上"窗口"这一维（weflow 用 `chatId`，形如 `weflow:<talker>`）。不改 `senderId`（bot 通道回复要用它当官方 openid），而是在 dsh 适配器的会话查找上引入会话作用域，避免动到回复路由与 canary 判定。
4. **固定工作区**：机器人所有对话的 cwd 改成 `D:\Projects\cyberboss\user\cyberboss`（用户选定），不再按联系人名建 `user\<昵称>` 目录。
5. **分组**：在 `~/.dsh/storages/workspace.json` 注册一个新 workspace，title `cyberboss 对话`、path 即上面的 cwd，并把机器人的会话 id 收进它的 `sessionIds`；仓库自己的 `cyberboss`（`D:\Projects\cyberboss`）分组不动。
6. **标题**：首条消息以名字开头（如 `收-Ally <-> 发-Azzy`），让它成为自动标题的素材；**并接受一次人工重命名**——用户在 GUI 里改一次即可"钉住"，之后固定会话不会再被自动改写（用户选了这条）。
7. **测试会话**：`test-session` 作为保留窗口，入站文本含 `[test]` 标记的那一轮路由到它，日常聊天进不到。

### 命名规则（用户确认）

- 大号 ↔ 小号：`大-<大号名> <-> 小-<小号名>`
- 小号 ↔ 小号：`收-<机器人账号> <-> 发-<对话对方>`，例：`收-Ally <-> 发-Azzy`

## Acceptance criteria

- 单测：会话 id 派生（同窗口同 id、不同窗口不同 id）、resume 分支（存在则 resume、不存在则新建、`already exists` 不再走"换新 id"回退）、`[test]` 标记路由到 `test-session`。
- 真机：连续重启两次，侧栏只出现"每窗口一个"的固定会话且不再新增；重启后旧会话被 resume（历史仍在，不出现 `context was reset` 日志）；三个窗口的会话名与命名规则一致。
- 分组：`~/.dsh/storages/workspace.json` 出现 `cyberboss 对话` 分组，机器人的固定会话被收进它的 `sessionIds`。
- 门禁：`npm run check`、笔记三闸门、既有 780 例 JS 套件与桥 67 例套件保持绿。

## Alternatives considered

- **保持随机 id，靠人工清理**：最强理由是零改动、零回归。否决原因：每次重启都新增一个会话，清理是持续性负担，且上下文随之丢失——用户的原话就是"不多开 session"。
- **把窗口塞进 `senderId` 从而让绑定键天然分窗口**：最强理由是最贴合现有抽象（会话查找键就是绑定键），改动点少。否决原因：`senderId` 同时是 bot 通道回复的 `userId`（官方 openid）与会话绑定身份；改成窗口值会让 `provider=weixin` 的原生回复发错人。
- **靠补丁关掉 LLM 标题生成器，让确定性回退（首条消息前 5 词/40 字节）直接产出想要的名字**：最强理由是零人工、名字精确且能自动重复。否决原因：实测 `- id: session-title-llm` + `disabled: true` 在 `--dump-config` 里没有生效（节点仍在、配置原样），而把配置改成无效值有让整个 profile 起不来的风险。用户因此选了"人工改名一次"。
- **直接改 DSH 会话日志写入 `session/title` 事件（多帧 zstd JSONL）**：最强理由是完全自动化、无需 GUI。否决原因：日志是多帧追加的 zstd（Node 的 `zstdDecompressSync` 只解出第一帧）、事件 schema 与投影缓存由 DSH 拥有，手写事件属于越界且易碎。
- **把机器人会话并进现有的 `cyberboss` 分组**：最强理由是侧栏只有一个 cyberboss。否决原因：那会把"编码对话"和"微信对话"混在一起，用户选了独立分组。

## Risks

- **`session/resume` 在本机 DSH build 上不存在**（已实测）：文档描述的 ACP 面属于 `dsh-acp`，
  而 sdk profile 挂的是 `dsh-sdk-app`，只服务 initialize/session/prompt/shutdown。因此"重生续接"
  要么换成 ACP 面（路线 B），要么接受"重启即新会话"（路线 A/C）。
- **会话作用域是新增的隐式状态**：id 由窗口派生、又写回 `dsh-sessions.json`，中间态（映射指向一个
  已存在的会话）必须由 resume/回退分支兜住；回退**不得覆盖窗口的固定 id**（第一版覆盖过，已修）。
- **硬杀进程会留下孤儿运行时**：`Stop-Process -Force` 杀掉 app 后，它的 dsh 子进程仍持有会话；
  这既让 resume 必然被拒，也会让下一次启动的探测失真。重启要走服务脚本的优雅停止。
- **迁移期侧栏仍乱**：旧会话要等用户逐条确认后清理；`workspace.json` 是 GUI 的持久化文件，
  写错会让分组异常（可回滚：备份后重写）。
- **人工改名一次**：标题由 LLM 从首条消息生成、补丁关不掉，用户需在每个窗口各改一次。
- **回滚条件**：若"确定化 id"出现上下文串台或会话找不到，回退到随机 id（改动集中在 dsh 适配器与
  session store 的会话作用域两个文件）。
