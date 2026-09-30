# Agent Note: 可迁移安装与双渠道一等契约（换机不靠人肉记忆）

Status: proposed

## Problem

「把这个项目迁到另一台设备」现在不是一个可执行的动作，而是一次考古。今天的事实是：

1. **机器绑定散落在三层，且没有一层是声明式的。**
   - **脚本层**：`scripts/isolated-session/*.ps1|py` 里写着 `D:\Projects\cyberboss`（`bridge-restart.ps1:20-21`、`weflow-restart.ps1:20/50/80/110`、`weflow-guard.ps1:18/20`、`weflow-anchor-rebuild.ps1:83`、`register-guard-task.py:26-27`）、解释器绝对路径 `D:\Tools\miniconda3\pythonw.exe`（计划任务动作 + `register-guard-task.py`）、以及 `rdp-autologin.py:65-70` 的 `tmp\session0-probe\connect-cwinprobe.rdp` / `tmp\cwin-lab\*.log`。这些路径在换机那一刻**全部失效**，而失效方式各不相同（有的静默跳过、有的抛错、有的把日志写到不存在的目录）。
   - **任务层**：11 个计划任务的动作里带绝对仓库路径（`cwin-s1-rdp-keepalive`、`cwin-weflow-guard`、`Cyberboss Heartbeat Watchdog` …），另有 3 个指向 `C:\ProgramData\cwin-probe\` 下**从未入库**的脚本（`bot-direct.cmd`、`s1-restack.ps1`、`s1-mstsc-offscreen2.ps1`）。新机器上没人能凭仓库重建这套任务，因为其中一部分的正文根本不在仓库里。
   - **状态层**：`~/.cyberboss/dsh-sessions.json` 把**绝对工作区路径当作数据**存了两处（`activeWorkspaceRoot`、`threadIdByWorkspaceRootByRuntime` 的键），实测值为 `D:\Projects\cyberboss\user\cyberboss` 与 `…\user\Unhappy`。**纯拷贝这份 JSON 到新机器，线程绑定会指向不存在的目录**——这是"状态文件里藏着机器身份"的典型，且不会报错。
2. **运行状态目录里有 2.2 GB 的缓存混在 4 MB 的关键状态里**（`~/.cyberboss/`：`models/` 2.24 GB、`inbox/` 118 MB、`outbox/` 125 MB、`weflow-media-cache/` 106 MB、`douyin-profile/` 385 MB，而 `accounts/`、`weflow-message-ledger.json`、`reply-obligations.json`、`pending-inbound.json`、`timeline/`、`checkin-config.json`、`weixin-instructions.md` 合计约 4.6 MB）。没有清单，就只能整目录拷贝，于是每换一次机器就搬 2 GB 可再生的字节，并且把"到底什么是不可再生的"这个问题永久悬空。
3. **双渠道是隐式的。** 代码里两条通道早就并存：官方 iLink 走 HTTPS（`CYBERBOSS_WEIXIN_BASE_URL` + `account.baseUrl` + `context_token`），个人号走本地 UI 自动化（`provider === "weflow-uia"` → `sendWeFlowUiaText` → `scripts/weflow-uia-bridge.py`）。但"哪条通道在跑、哪条能跑"由 `provider` 字符串在 20 多处分支里决定（`app.js`、`stream-delivery.js`、`system-message-dispatcher.js`、`reply-obligation-store.js`、`weixin/index.js:97/271`），没有任何一处声明"本机启用了哪些通道、各自依赖什么"。新机器装完 bot 后，唯一的验证方式是发一条消息看它回不回。
4. **`.env` 是唯一真源，而它不入库。** 41 个键里有 3 个是本机路径（`CYBERBOSS_WORKSPACE_ROOT`、`CYBERBOSS_CHECKIN_WORKSPACE`、`CYBERBOSS_GENERATED_IMAGE_OUTBOUND_DIR`）、2 个是本机端口约定（`CYBERBOSS_WEFLOW_BASE_URL`、`CYBERBOSS_WEFLOW_BRIDGE_BASE_URL`）、1 个是密钥（`CYBERBOSS_WEFLOW_TOKEN`）。三者的迁移策略完全不同（改写 / 不变 / 手工），但今天没有任何东西把它们区分开。

结论：迁移失败的代价不是"多花半小时"，而是**静默的错误行为**——账本错位、回复发给错的人、通道"看起来在跑但发不出去"。所以它需要一份可执行的清单，而不是一篇说明文。

## Proposal

### A. 状态分三类，并且由代码来分类

在 `src/core/` 下立一个**单一权威清单** `state-manifest.js`，导出 `PORTABLE_STATE`（不可再生，必须迁移）、`SECRET_STATE`（必须手工迁移，永不入库）、`REGENERABLE_STATE`（迁移时丢弃，新机器重新生成）：

| 类 | 内容 | 迁移动作 |
|---|---|---|
| portable | `accounts/*.json`（账号 + `context-token`）、`weflow-message-ledger.json`、`reply-obligations.json`、`pending-inbound.json`、`deferred-system-replies.json`、`system-message-queue.json`、`thread-state` / `dsh-sessions.json`、`timeline/`（facts + state + taxonomy；`site/`、`shots/` 可再生）、`checkin-config.json`、`memory.json`、`weixin-instructions.md` | `migrate export` 复制，并按规则改写路径 |
| secret | `.env`（含 `CYBERBOSS_WEFLOW_TOKEN`）、`~/.dsh/`（profile + 凭据）、`~/.codex/`、`~/.claude/`、微信登录态、WeFlow 的 WCDB 库 | **要人**：走加密介质，逐条核对；仓库里只留 `*.env.example` |
| regenerable | `models/`、`inbox/`、`outbox/`、`weflow-media-cache/`、`douyin-profile/`、`logs/`、`*.bak*`、`tmp/`、`node_modules/`、`.venv*/` | 明确丢弃，新机器重装/重下 |

**路径改写必须发生在导出时，而不是导入时。** 导出清单里记录源机的 `workspaceRoot` 与状态目录，导入时把 JSON 内出现的每一个旧绝对路径前缀替换为新机路径（今天已知的落点：`dsh-sessions.json` 的 `activeWorkspaceRoot` 与 `threadIdByWorkspaceRootByRuntime` 键、`sessions.json` 的 binding）。理由：JSON 里的路径是**数据**，只有导出方知道它指的是什么；留给导入方猜，就是把一个已知问题变成一个待排查问题。

### B. 双渠道升格为契约：`cyberboss doctor` 报告能力，而不是让运行时自己发现

1. **`.env` 声明启用哪些通道**：现有键已经够用，但需要一个显式的开关语义 —— 官方通道由 `CYBERBOSS_WEIXIN_BASE_URL` + `accounts/` 是否已配对决定，个人号通道由 `CYBERBOSS_ENABLE_WEFLOW_INBOX` + `CYBERBOSS_WEFLOW_TOKEN` + 桥可达决定。**`CYBERBOSS_ENABLED_CHANNELS`**（如 `ilink,weflow-uia`）为可选显式覆盖；未设置时按上面的可用性推导，并把推导结果打印出来。
2. **`npm run doctor`（已存在 `bin/cyberboss.js doctor`）成为迁移的验收工具**，对每条通道做**只读**能力探测并给出四态结论：
   - `ilink`：`accounts/` 里有没有已配对账号 + `context_token` 是否存在 + `notifystart` 是否 `ret:0`（**不发消息**）；
   - `weflow-uia`：读侧 `/api/v1/health` + 一条 `/api/v1/messages` 查询是否 200（功能身份，不是端口占用），写侧 `/readyz` 与 `/api/probe` 的 `foreground != 0`（沿用 [RDPWrap 隔离会话部署契约](../../implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md) 里已经验证过的判据，不新造）；
   - 输出 `channel=ilink enabled=true ready=true` / `channel=weflow-uia enabled=true ready=false reason=…` 这种**逐通道**结论，让"哪条通道没通"是一个可读的字符串，而不是一条发不出去的消息。
3. **路由保持显式**：出站 provider 继续由路由字段决定（不引入隐式回落）。现在 `resolveCheckinReplyRoute` 在 `CYBERBOSS_CHECKIN_CHAT` 非 `weflow:` 前缀时**启动即报错**，这个"宁可起不来也不静默走错通道"的姿态要推广到所有系统触发源。

### C. 脚本去机器化（与 A/B 同批做，否则清单只是文档）

1. `scripts/isolated-session/**` 一律**从脚本自身位置推导仓库根**（`$PSScriptRoot` / `Path(__file__).resolve().parents[2]`），解释器从 `CYBERBOSS_PYTHON`（缺省 `python`）取，`C:\ProgramData\cwin-probe\` 这类队列目录改由 `CYBERBOSS_QUEUE_ROOT` 提供。
2. 把 `C:\ProgramData\cwin-probe\` 下**尚未入库**的三个脚本（`bot-direct.cmd`、`s1-restack.ps1`、`s1-mstsc-offscreen2.ps1`）拉进 `scripts/`，否则"从仓库重建"这句话不成立。
3. `dsh-plugins/cyberboss-approval/main.patch.yml` 的 `name: 'D:/Projects/cyberboss/…'` 改为安装脚本生成（写 profile 时用当前仓库绝对路径），仓库里只留模板。
4. 新增 `scripts/migrate.js`（`export` / `import` / `verify` 三个子命令），只做清单内的读写与路径改写，不碰运行时。

### D. 手工步骤写成清单，能跑的每一步都脚本化

`docs/migrate-device.md`：新机器上的顺序是「装 Node ≥22 → clone → `npm ci` → 恢复 `.env` → `migrate import` → 装 WeFlow / 微信 / 隔离会话配方（若是 Windows 路线）→ 扫码登录 → `npm run doctor` → 注册计划任务 → 发一条自测消息」。**要人的那几步单独成节并标注**（扫码、`.env` 密钥、`gh auth login`、Windows 账号与计划任务授权），其余的必须是一条命令。

## Acceptance criteria

1. `npm run verify-portable`（新增，纯静态、离线）对 `scripts/`、`src/`、`dsh-plugins/` 检查：除白名单（`*.env.example`、模板、测试夹具）外**没有** `D:\` / `C:\Users\` / 绝对解释器路径；红则非零退出。当前代码在加入这条检查时必须是红的，改完转绿。
2. `node scripts/migrate.js export --to <空目录>` 在**不启动 bot**的前提下产出一份清单（`manifest.json` + 状态文件），体积 < 20 MB；`node scripts/migrate.js verify <目录>` 能独立校验清单完整性（含每个文件的 sha256），不需要源机在场。
3. 离线往返测试：在 `test/` 下用假状态目录跑 `export → import`（模拟新机路径），断言 `dsh-sessions.json` 里的旧工作区路径**已全部替换**、`accounts/*.json` 与 `context-token` 字节一致、`models/` 与 `inbox/` 未被复制。
4. `bin/cyberboss.js doctor` 在**两条通道都不通**的机器上输出两条 `ready=false` 且带 `reason=`，退出码非零；在两条都通的机器上输出两条 `ready=true`，退出码为 0。**判定不需要发消息。**
5. `docs/migrate-device.md` 的手工节里每一条都能被一个"人只做这一步"的动作完成（扫码 / 填值 / 授权），且每条后面跟一条**验证命令**。

## Risks

- **`.env` 与账号态是最高价值资产，也是最容易泄漏的。** `migrate export` 默认**不包含** `.env` 与任何 `*.bak*`；清单 schema 里显式声明 `secretsExcluded: true`，避免"顺手打包"变成一次泄漏。上游仓库是公开的（`origin` = `github.com/WenXiaoWendy/cyberboss`，本地领先 171 个提交未推），迁移工具本身不得把 `.env` 路径写进日志。
- **迁移窗口内丢消息。** 个人号通道是"轮询游标 + 长轮询"模型（游标文件一旦推进就不可回放），官方 `getupdates` 更是"错过即永久丢失"（见 [iLink 实测契约](../../implemented/architecture/2026-09-30-ilink-bot-api-observed-contract.md)）。因此在 `docs/migrate-device.md` 里 **旧机停机必须晚于新机 doctor 全绿**，而不是先停后装。
- **状态目录是活的。** `migrate export` 读的是正在被 bot 写的文件（`reply-obligations.json` 186 KB、`weflow-inbox-cursor.json` 65 KB 都在按分钟推进）。清单必须记录每份文件的 sha256 与 mtime，并在 `import` 时报告"导出于 X 分钟前"，让操作者知道自己拿的是快照而不是冻结件。
- **路径改写是文本替换，天然会误伤。** 只对清单内的 JSON 白名单文件做替换，且只替换"导出清单里记录过的旧前缀"，不做通用正则。
- **手工步骤占比不可压到零。** 微信扫码、WeFlow 首次配对、Windows 隔离会话的账号与计划任务授权，这四件今天都必须由人在新机器上做。方案的目标是**把手工步骤数清楚并逐条给出验证**，不是假装能全自动。
- **双渠道契约会碰到已有硬编码。** `CONTROL_CONFIRMATIONS` 里的中文文案（`✅ 当前发信源：大号 ClawBot` / `小号 UIA`）与 `send_source` 的 `bot`/`azzy` 取值是**桥的协议**，改它要连桥一起改；本轮不动，只把它记进通道契约的"通道身份"一节。

## Alternatives considered

- **直接把 `~/.cyberboss/` 整个目录拷到新机器，不做分类。** 最强理由是零开发量、绝对不会漏任何一个文件，而"遗漏状态"恰好是迁移最贵的故障。否决原因是它把 2.2 GB 可再生缓存和 4 MB 关键状态混在一起搬，且**不解决路径问题**——`dsh-sessions.json` 里那两个绝对工作区路径照样错，错法还是静默的（会话绑到一个不存在的目录，运行时报的错与迁移无关）。分类清单的收益主要不是省字节，而是**让"什么不可再生"成为一个被写下来的事实**。
- **把状态目录放进云盘 / 符号链接，两台机器共享同一份状态。** 最强理由是"零迁移"，且对"我随手换机器用"这种真实场景最省心；同时它还顺带解决了"想在新机器上接着历史线程"这个需求。否决原因是同一份账本与游标被两个进程读写会直接违反既有约束——账本是回声归因的唯一权威（见 [self-echo 归因](../../implemented/bug-fix/2026-09-18-weflow-self-echo-attribution.md)），游标是单向推进的轮询位置；两个读者会让机器人**重复回复**并把人工发送误判成自己发的。要共享就得先做多写者协调，那是另一个量级的工作。
- **用 git 管理状态（提交状态目录到私有仓库）。** 最强理由是版本化 + 天然可迁移 + 有历史可回溯，"哪一步开始错"可查。否决原因是状态里含 `context_token` 与 `accounts/*.json`（凭据等价物），入库即违背密钥纪律；且每 2 秒轮询都会改游标文件（`weflowOutgoingPollIntervalMs` 默认 2000），版本历史会被噪声淹没。
- **让 `migrate import` 自己在目标机推导新路径，不要求操作者给 mapping。** 最强理由是少一个必填参数、少一个填错的机会，而绝大多数场景就是"仓库在新机器上的绝对路径变了"。否决原因是推导只对"仓库路径"这一种前缀成立，而 `CYBERBOSS_CHECKIN_WORKSPACE`、`CYBERBOSS_GENERATED_IMAGE_OUTBOUND_DIR`、隔离会话队列目录都可以在仓库之外；推导不出来时它会**悄悄保留旧值**，把一个显式问题变成一个隐性故障。宁可要求 `--map old=new`（可重复），并在缺 mapping 且检测到旧前缀时**拒绝导入**。
- **先做迁移工具，Cua 那条线等以后再说。** 最强理由是两件事耦合度看起来不高，先交付一个小的、可验证的东西；而 Cua 的调研结论尚未落地，混在一起会让这篇笔记同时承担"决策"和"未知"两种性质。否决原因是"驱动面怎么托管"直接决定迁移清单的形状——如果驱动面从"本机隔离会话"变成"另一台机器/VM 上的 Cua"，那么 `scripts/isolated-session/**` 整层不再是新机器的安装项，`weflow` 读侧是否还留在本机也要重新回答。先定这个边界，清单才不会白写。**因此本提案只固定"状态分类 + 双渠道契约 + 脚本去机器化"这三件与驱动面无关的部分**，Cua 的取舍单独成篇（见 [Cua 作为驱动面](../../proposed/architecture/2026-09-30-cua-as-drive-surface.md)），两者共享同一份 `migrate` 清单格式。
- **用 Docker 把整个栈打包，迁移 = `docker compose up`。** 最强理由是一步到位、环境完全一致，理论上是最干净的"可迁移"。否决原因是个人号通道的两端都在 Windows GUI 上：微信桌面客户端 + WeFlow（读微信 WCDB 库的本地应用）+ UIA 驱动（需要真实交互桌面）。这三样没有一样能进 Linux 容器；Windows 容器又做不到"驱动桌面"。所以容器化只能覆盖"机器人本体"这一层，而那一层本来就不难迁（Node + `npm ci`）。
