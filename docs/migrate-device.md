# 换机迁移手册（cyberboss → 另一台设备）

这份文档回答一件事：**把正在跑的机器人搬到另一台机器上，需要动哪些东西；哪些能脚本化，哪些必须由人做。**

状态分类的决策与理由在 [可迁移安装与双渠道一等契约](../.agents/notes/proposed/architecture/2026-09-30-portable-install-and-dual-channel-contract.md)；Cua/驱动面的取舍在 [Cua 作为驱动面](../.agents/notes/proposed/architecture/2026-09-30-cua-as-drive-surface.md)。本篇只讲操作。

## 0. 先搞清楚要搬的三类东西

| 类 | 内容 | 怎么搬 |
|---|---|---|
| **可再生的**（别搬） | `node_modules/`（397 MB）、`~/.cyberboss/models/`（2.19 GB）、`inbox/` `outbox/` `weflow-media-cache/` `douyin-profile/` `logs/`、`analysis/`、`tmp/`、`.venv*/` | 目标机重新 `npm ci` / 重下 |
| **不可再生的状态**（必须搬） | `~/.cyberboss/` 里的账本、游标、回复义务、待处理入站、线程绑定、`accounts/`、`timeline/`、`checkin-config.json`、`memory.json`、`weixin-instructions.md`；以及仓库里的 `user/` 工作区 | `scripts/migrate.js`（见 §2） |
| **凭据与外部运行时**（要人） | `.env`（含 `CYBERBOSS_WEFLOW_TOKEN`）、`~/.dsh` `~/.codex` `~/.claude` 的 profile 与登录态、微信登录、WeFlow 安装与其 WCDB 库、隔离会话配方 | 见 §3、§4 |

一条判据：**如果一个文件能在目标机上重新生成，就不要搬它**；如果它是"过去发生过什么"的记录（账本、义务、游标、时间轴），就必须搬。

## 1. 目标机的前置

```powershell
node -v            # 需要 >= 22（本机 24.14.1）
git --version
python -V          # 隔离会话配方与语音转写要用；本机是 D:\Tools\miniconda3
npm -v
```

个人号通道还需要（**只能人工装**）：微信桌面版、WeFlow（读侧 5051）、以及隔离会话那一套（RDPWrap + 第二个 Windows 账号 `cwinprobe` + 计划任务）。官方 iLink 通道**不需要**这些，纯 HTTPS。

## 2. 搬状态：`scripts/migrate.js`

旧机（**先做，因为它是快照**）：

```powershell
npm run migrate:list                             # 看清哪些要搬、哪些被跳过、体积多少
npm run migrate:export -- --to E:\cb-migrate     # 只搬不可再生状态；默认不含凭据
```

- 默认**不含** `accounts/*context-tokens.json`（它是官方通道的 bearer 等价物）。确实需要连着 token 一起搬时加 `--with-credentials`，产物会打上敏感标记 —— 走加密介质，目标机验收后删掉。
- 导出会记录**源机的绝对路径前缀**，并打印"到本机 checkout 会变成什么"。默认不写 `.env`（任何情况下都不写）。

新机：

```powershell
git clone <repo> && cd <repo>
npm ci
npm run migrate:verify -- E:\cb-migrate      # 先校验（sha256），再决定要不要导
npm run migrate:import -- --from E:\cb-migrate
```

- `import` 会自动把旧前缀映射到新机（`<repo>/user/<联系人>` 的**子目录名保留**，不会把所有联系人揉成一个工作区）。
- 推断不出来的前缀（例如工作区在仓库之外）会**拒绝导入**并要你显式给 `--map 旧=新`。这是故意的：静默保留旧路径会变成一个与迁移无关的故障。
- 若 bundle 超过 30 分钟，`verify` 会警告：那是快照，不是冻结件，请安排停机窗口。

## 3. 必须人工的两件事

1. **`.env`**：从旧机复制，**逐项核对三个本机路径**——`CYBERBOSS_WORKSPACE_ROOT`、`CYBERBOSS_CHECKIN_WORKSPACE`、`CYBERBOSS_GENERATED_IMAGE_OUTBOUND_DIR`；两个端口约定 `CYBERBOSS_WEFLOW_BASE_URL` / `CYBERBOSS_WEFLOW_BRIDGE_BASE_URL` 一般不变；`CYBERBOSS_WEFLOW_TOKEN` 必须与目标机 WeFlow 侧一致。
2. **凭据与登录**：`~/.dsh`（profile）、`~/.codex`、`~/.claude` 按需复制；官方通道用 `npm run login` 重新扫码配对；个人号通道的微信登录态**不能靠复制**，需要在隔离会话里扫码（`Start-ScheduledTask -TaskName cwin-s1-rdp-show` → 扫码 → `-hide`）。

## 4. 隔离会话那一层的现状（读之前先看这条）

仓库里的配方（`scripts/isolated-session/**`）**源码已经不再写死 `D:\Projects\cyberboss`**：仓根、队列根、解释器改由环境变量或脚本自身位置推导（`CYBERBOSS_REPO_ROOT` / `CYBERBOSS_QUEUE_ROOT` / `CYBERBOSS_PYTHON`）。默认值与本机现状一致，所以**本机行为没有变化**。

但要注意两件事：

- **已经注册的计划任务仍指向旧的字面路径**（任务动作里存的是绝对路径）。换机后必须**重新注册**，任务才会指向新 checkout：`cwin-s1-rdp-keepalive`、`cwin-s1-rdp-reconnect`、`cwin-s1-rdp-remote-guard`、`cwin-s1-rdp-show/-hide`、`cwin-weflow-guard`、`Cyberboss Heartbeat Watchdog` 等。
- 有三个任务的动作指向 **`C:\ProgramData\cwin-probe\` 下从未入库的脚本**（`bot-direct.cmd`、`s1-restack.ps1`、`s1-mstsc-offscreen2.ps1`）。在把它们入库之前，"从仓库重建"这句话对新机器不成立 —— 这是当前最大的一处迁移缺口。
- `.ps1` 里**含非 ASCII 的必须带 UTF-8 BOM**，否则 PowerShell 5.1 按 GBK 解析、整个脚本报废（本仓库已经踩过两次）。新增/改写脚本后跑 `node scripts/verify-portable.js` 之外，最好再做一次 BOM + 解析扫描。

## 5. 验收：`doctor` 的逐通道结论 + 两条闸门

```powershell
npm run doctor             # 配置快照 + 每条通道的只读就绪结论（退出码 0 = 全部 enabled 通道就绪）
npm run test:doctor        # 探测逻辑的离线测试（不发消息、不动光标）
npm run verify-portable    # 静态闸门：代码树里不得出现新的机器绑定（基线在 scripts/portable-baseline.json）
npm run test:migrate       # 迁移工具的离线往返测试（路径改写 / 凭据 opt-in / 篡改拦截）
```

`doctor` 现在是**逐通道探测**，不是单纯的配置快照。它输出的结论形如：

```
"channels": [
  { "channel": "ilink",      "enabled": true, "ready": true,  "reason": "", "detail": "getconfig ok (read-only session check)" },
  { "channel": "weflow-uia", "enabled": true, "ready": true,  "reason": "", "detail": "reader=ok writer=ready foreground=1639902 desktopIdleSeconds=362" }
],
"channelsSummary": { "enabled": ["ilink","weflow-uia"], "ready": ["ilink","weflow-uia"], "notReady": [], "ok": true }
```

四条使用要点：

- **退出码有含义了**：0 当且仅当所有 `enabled` 通道 `ready=true`。脚本化验收直接看退出码，不用读日志。未配置的通道（`enabled=false`）不会让验收失败。
- **它不发任何消息**：`ilink` 只做一次只读的 `ilink/bot/getconfig`（**不碰 `sendmessage`**，因为那要消耗 `context_token`）；`weflow-uia` 走读侧 `/api/v1/health` + 一次真实 `/api/v1/messages` 查询、写侧 `/readyz` + **只读形式**的 `/api/probe`（不带 `?move=1`，绝不 `SetCursorPos`）。
- **`ilink` 的结论是软判据**：机器人正在长轮询时，并发探测可能让它偏悲；`ready=true` 也只证明账号与会话还在，**不代表现在能发**（官方通道每条出站都要消耗入站带来的 `context_token`）。
- 排查时可用 `CYBERBOSS_ENABLED_CHANNELS=ilink`（或 `weflow-uia`）只探测一条；**不设置时两条都探测**，所以这个键不需要长期留在 `.env` 里。

## 6. 顺序（别把顺序搞反）

1. 旧机 `migrate export`（此时机器人仍在跑）。
2. 新机装前置 → clone → `npm ci` → `migrate import` → 恢复 `.env`。
3. 新机装微信/WeFlow/隔离会话 → 扫码登录 → `npm run doctor` 全绿。
4. **两条通道都验证过之后**，才停旧机。
5. 旧机停机后，把新机的 `accounts/` 与游标状态再 `export` 一次对比，确认迁移窗口内没有丢失（个人号通道的游标不可回放；官方 `getupdates` 错过即永久丢失）。
