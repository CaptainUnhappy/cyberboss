# Agent Note: 媒体收发不再跨用户传文件路径（入站走 HTTP、出站用共享目录）

Status: implemented

## Problem

用户报"图片先发、消息后发，为什么没有结合为同一条消息作为输入"。复现与定位（2026-09-30）显示根因不在聚合逻辑，
而在**两个 Windows 账户之间传文件路径**：

| 方向 | 写文件的人 | 读文件的人 | 症状 |
|---|---|---|---|
| 入站媒体 | WeFlow（`cwinprobe`，隔离会话）导出到 `C:\Users\cwinprobe\AppData\Roaming\weflow\cache\api-media\…` | bot（`79388`） | `fs.statSync` 被 ACL 拒绝 → `hasUsableMedia=false` → 事件空等 300 秒 → `media_export_deadline_exceeded` 死信 → 图片**永远进不了运行时** |
| 出站图片 | bot（`79388`）写到 `%USERPROFILE%\.cyberboss\generated-images-outbound\…` | UIA 桥（`cwinprobe`） | 桥报 `image file is outside the managed image root` / `WinError 5` → **bot 发不出图片** |

实测证据（沙箱外、以 `79388` 身份）：

```
Test-Path C:\Users\cwinprobe\…\api-media\…\6b8a773ce6f1f8de9df910063b61cf3f.png → Access is denied
同一文件 http://127.0.0.1:5051/api/v1/media/… → 200，340 626 字节
```

`chooseMediaPath()` 对候选路径做 `fs.statSync(...).isFile()`，**读不到就当没有媒体**，于是"导出成功但读不到"
与"没导出"在代码里是同一件事——用户看到的"没结合/没看到图"就是这么来的（bot 原话："这条消息里没带图片"）。

## Decision

两条路都改成**不再依赖另一个账户的 profile**：

1. **入站：读不到本地导出路径时，改从 reader 的 HTTP 媒体接口取回**（`src/integrations/weflow-inbox.js`）。
   - 新增 `materializeMediaLocally(rows, push)`：在 `resolvePushMessage` 拿到 `fetchMessageDetails` 结果后立刻跑一遍，
     对"`hasUsableMedia` 为假且带 `mediaUrl`"的行（上限 12 行）调用 `cacheMediaOverHttp`，成功后**就地改写
     `row.mediaLocalPath`**，因此配对、附件构造、媒体截止时间检查全部沿用原逻辑，无需第二套路径。
   - `cacheMediaOverHttp`：只接受与 `config.weflowBaseUrl` **同源**的 URL（不接受行里写的任意主机）；
     缓存键是文件名（reader 按摘要命名）→ 已存在即复用，天然幂等；`content-length` 与实体都受 64 MB 上限约束；
     20 秒超时；写盘用 `.tmp` + rename 原子落盘；失败/成功都打日志（`media downloaded over HTTP … bytes=… file=…`），
     这就是"导出慢"与"读不到"以后能被区分开的地方。
2. **出站：两侧指向同一个共享目录**。
   - bot 侧新增 `CYBERBOSS_GENERATED_IMAGE_OUTBOUND_DIR`（`src/core/config.js`，缺省仍是 `stateDir/generated-images-outbound`）。
   - 桥侧 `scripts/isolated-session/bridge-restart.ps1` 显式设置 `CYBERBOSS_WEFLOW_UIA_IMAGE_ROOT`
     （值取自 .env 的同一个键），并在启动前 `New-Item -Force` 建目录——会话 worker 不继承项目环境，
     这与既有 `CYBERBOSS_WEFLOW_SEND_VERIFY_SECONDS` 透传是同一套路。
   - 本部署取值 `C:\ProgramData\cwin-probe\outbound-images`（该目录继承 `BUILTIN\Users=Modify`，两个账户都可读写）。

## Alternatives considered

- **只改 ACL，给两个账户互加读权限**：最强理由是零代码、立刻生效。否决原因（作为终局）：要放开的是对方 profile 里
  整棵缓存目录，WeFlow 升级/重建缓存可能重置 ACL 或换路径；而且它把"两账户共享目录"变成隐式契约。
  作为止血手段仍然有效，只是不解决"下一次换机器/换账号就复发"。
- **让 bot 与 WeFlow 跑同一账户**：根除跨用户问题，但违反隔离会话部署契约
  （[RDPWrap 隔离会话](../../implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md)：输入自动化必须待在独立会话，
  否则抢操作员的前台与焦点）。
- **让 WeFlow 直接写共享目录**：最干净，但那是第三方服务端行为，本仓库不可配（探查过它的 state/媒体根都不暴露该开关）。
- **只在 UI 层兜底（检测到图片事件超时后提示用户重发）**：把系统缺陷转嫁给用户，且出站方向依旧发不出图。
- **入站改读 `weflowMediaRoot` 常量**：config 里确实有 `weflowMediaRoot`（缺省 `%APPDATA%\weflow\cache\api-media`），
  但那是**本账户**的 APPDATA，指向的正是读不到的那棵树，等于没修。

## Consequences

收益：入站图片/语音/视频/文件第一次真正可用（`hasUsableMedia` 不再因 ACL 恒假）；出站图片两个账户都能读。
对真实数据的集成验证（对 live reader 跑 `materializeMediaLocally`）：

```
before: mediaLocalPath = C:\Users\cwinprobe\…\f27b37ea….jpg   readableBefore = false
after : mediaLocalPath = C:\Users\79388\.cyberboss\weflow-media-cache\wxid_ubo0cy5xh4px22\image\f27b37ea….jpg
        readable = true  bytes = 340626
bridge: image root = C:\ProgramData\cwin-probe\outbound-images（重启后 readyz=200，/api/send-image 接受该目录内的文件）
```

代价与边界：

- **多一次落盘**：媒体在 bot 的 state dir 下多存一份（`weflow-media-cache/`），需要随既有的临时文件清扫策略一起清理；
  目前按文件名幂等复用，不重复下载。
- **只对同源 URL 生效**：reader 若将来返回别的 host，会跳过并打 warn（安全取舍，不是遗漏）。
- 首次事件处理会多花一次下载时间（本机 loopback，340 KB 量级可忽略；大视频受 64 MB 上限约束会拒绝并记日志）。
- **出站目录是部署契约**：`.env` 的 `CYBERBOSS_GENERATED_IMAGE_OUTBOUND_DIR` 与桥的 `--image-root` 必须一致，
  由 `bridge-restart.ps1` 从 .env 透传保证；换机器时两处一起改。
- 仍存的旧账：死信（dead letter）不重放——修复前被隔离的那些媒体事件不会自动补回，需要用户重发一次。
- 测试：`test/weflow-inbox.test.js` 新增一例（本地路径不可读 → 走 HTTP 落缓存 → 附件指向缓存文件 → 第二次观察不再下载），
  该文件 96/96 通过；`npm run check` 通过。

## 追加（同日，13:47）：入站「文件」不是读不到，而是阅读器根本不导出

图片/视频/语音修好之后，**文件**（appmsg `type 6`）依旧消失。对 live reader 逐项探测后确认这不是跨用户问题，而是能力缺口：

```
查询 media=1&image=1&voice=1&video=1&emoji=1（以及加 &file=1 / &attach=1）
  → 该行没有任何 media* 字段；rawContent 里只有 <attachid>/<md5>/<totallen>/<aeskey>
GET /api/v1/media/<talker>/files/<name> → 404 Media not found
GET /api/v1/files、/api/v1/media、/openapi.json → 404
```

即 reader **没有文件导出的任何入口**，HTTP 兜底也就无 URL 可取；旧行为是等满 60 秒导出窗 →
`media_export_deadline_exceeded` 死信 → 用户既收不到回复，也收不到"我收不到文件"的说明
（历史死信里 2026-09-12 两条、2026-09-30 四条同因）。视频/图片的 HTTP 兜底在同一时段是好的（4.4 MB、9 MB 的 mp4 都取回成功）。

改动两处：

1. **`src/integrations/weflow-inbox.js`**：新增 `resolveUnexportableMediaReason()`——kind 为 `file`、且行内**完全没有定位信息**
   （无 `mediaUrl`、无任何 `*LocalPath`）时不再等待，立即按**入站失败**投递（`code: media_export_unavailable`，
   带文件名与 `totallen` 换算的大小）。一旦定位字段出现（未来 reader 支持导出、或换成带 `mediaUrl` 的部署）就自动走原逻辑，
   因此这是"按能力降级"的分支，不是写死的例外。
2. **`src/core/app.js`**：在 WeFlow 入站**到达处**（`handleWeFlowInboxMessage`，失败刚被知道的位置）给操作员发一条
   `⚠️ 附件读取失败 …` 通知并**不开启回合**。两个坑都是实测踩出来的：
   - 放在 `prepareIncomingMessageForRuntime` 里不生效——那里 `persistedAttachments` 的早退分支先返回，而生产入站**总是**带那两个数组；
   - 通知必须走 WeFlow 路由（`provider: "weflow-uia"` + `weflow:<talker>`），否则落到官方 bot API：
     `sendMessage ret=-2 errmsg=prepare failed`。
   另外组装 inbound 记录时把消息上的 `attachmentFailures` 并入 `persistedAttachmentFailures`，
   失败信息才进得了回合文本（不想发通知的部署可删掉通知分支、退回"由模型解释"）。

真机验证：`POST /api/send-file` 发 140 B 的 txt → 日志 `WeFlow media export unavailable; delivering the event with an intake failure …`
→ 聊天出现 `⚠️ 附件读取失败 / - file-fix-test7.txt: …（140 B）/ 可以改用截图，或把内容直接贴成文字发我。`；
不再有 60 秒等待、不再死信、不再出现"只有处理中、没有下文"的空轮次。

测试：`test/weflow-inbox.test.js` 97/97（新增 appmsg 文件立即投递一例）；`test/system-inbound.test.js` 22/23
（新增入站失败通知一例；唯一失败 `quoted attachments retain their origin…` 在**未改动的 HEAD 版 `app.js` 上同样失败**，
属既有问题，与本次无关）。

仍未做：要把文件**内容**读进来，需要 reader 侧提供文件导出（或换能导出文件的读侧实现）；本仓库这条链路只能做到
"不静默失败 + 明确告知"，这一点写在这里以免下次误判为已修好。
