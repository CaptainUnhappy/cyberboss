# Agent Note: 微信发文件（CF_HDROP 剪贴板粘贴通道）

Status: implemented

## Problem

用户反复要求"把视频发到微信"，而官方 bot 通道（iLink）**协议上发不出去**：每条出站 `sendmessage` 必须携带由入站用户消息产生的 `context_token`，而 agent 无法自行产生它（详见 [iLink Bot API 实测契约](../architecture/2026-09-30-ilink-bot-api-observed-contract.md)）。

但用户指出"之前成功发出过"。核对 WeFlow 账本后确认：2026-09-29 那轮对话里，同一诉求最终是以**文本消息发公网链接**应付过去的（原文："微信里我发不了文件，视频给你传到公网了：https://files.catbox.moe/…"）—— 也就是说**文件本体从未真正发出去**，此前只有图片走过桥（桥的 `/api/send-image` 是严格 PNG-only）。

所以缺口是真实的：**桥只能发文本与 PNG，不能发任意文件**。

## Decision

给隔离会话里的 UIA 桥新增一个"文件剪贴板"派发通道，复刻 Explorer 复制文件的行为：

1. `set_clipboard_hdrop(file_path)`（`scripts/weflow-uia-bridge.py`）：把文件写成 **`CF_HDROP`**（Windows shell 文件列表）放上剪贴板，**格式为 `DROPFILES` 结构 + UTF-16LE 双零结尾路径**，同时附一份 `CF_UNICODETEXT`。这是资源管理器"复制"文件时用的同一机制，因此微信的粘贴处理会把它当成**附件**，而不是一段路径文本。
2. `BridgeState._dispatch_file(contact, file_path)`：与 `_dispatch_image` 同构 —— 同样的目标确认（`confirm_current_chat_target`）、同样的前台连续性闸门（`require_foreground_continuity`）、同样的 `{Ctrl}a` 清空编辑器，但把 `set_clipboard_dib` 换成 `set_clipboard_hdrop`。粘贴后等 **1.2 秒**（图片是 0.6 秒）再回车，附件渲染比图片慢。
3. `POST /api/send-file`：与 `/api/send-image` 同构的白名单与校验，但**不要求文件位于 `image_root` 内**（那个根目录是用来管束 bot 生成图片的），只要求是**可读的普通文件** —— 因为粘贴携带的是**路径**而不是字节，路径不可读就等于什么都没附加。

4. **文件消息的核验**（同日第二轮补上，见 [bot 工具层接入微信任意文件发送](2026-09-30-channel-send-file-any-tool.md)）：第一版发完就返回 `verified:false`，导致账本永远停在 `failed_uncertain`、去重失效。现在 `dispatch_file_and_verify` 按 **`rawContent` 里的 `<title>` 等于附件名**匹配（`localType` 是 64 位复合值，刻意不比对），命中即返回 `localId`。`/api/send-file` 接受 `timeout` 参数控制这个核验窗口。

**边界（刻意如此）**：`/api/send-file` 本身不要求文件位于 `image_root` 内（那个根目录是用来管束 bot 生成图片的），只要求是**可读的普通文件** —— 因为粘贴携带的是**路径**而不是字节，路径不可读就等于什么都没附加。但请注意桥以 `cwinprobe` 身份运行，**跨账户可读性由调用方负责**；bot 侧的落地方式见 [bot 工具层接入微信任意文件发送](2026-09-30-channel-send-file-any-tool.md)。

**明确的副作用**：`CF_HDROP` 通道**无法保留并恢复原剪贴板**（图片路径只能以文本方式备份/还原，而 pywin32 读不回文件列表）。发送会把用户当时剪贴板里的内容覆盖掉。这是知情取舍，不是疏漏。

## Verification

真机三轮（2026-09-30 13:01–13:04），目标 `柳毓琳`（`wxid_ubo0cy5xh4px22`），桥身份 Azzy：

| 时间 | 账本条目 | 证据 |
|---|---|---|
| 13:01:15 | `localType=43` | `[视频] length=4395110 md5=7c255432…`，与本地 `xiaohongshu-6a90368b-wechat.mp4` 的 size+md5 **逐位一致** |
| 13:03:08 | `localType=25769803825` | `title=cyberboss-file-send-test.txt ext=txt totallen=182` —— 文件名/扩展名/字节数全对，证明**任意文件**可发 |
| 13:03:38 | `localType=43` | `len=4395110 md5=7c255432bc09d62f4b177fbc7baed113` |
| 13:03:49 | `localType=43` | `len=9069723 md5=d5df9789a4db1f03ca0bafc9e8da42a3`＝本地 `shushu-curry-beef-rice-wechat.mp4` |

先冒烟后全量：第一次真实发送暴露出 `EditControl` 没有 `value_pattern` 属性（正确写法是 `get_chat_input_value_pattern(input_control)`）。**该异常发生在 `{Enter}` 之后，所以文件已经发出**，只是清理代码崩了 —— 这一点值得记住：媒体派发的异常要在"是否已回车"这个位置上证伪，不能只看有没有抛错。

## Alternatives considered

- **改官方 bot 通道（iLink）**：最强理由是它是原生通道、不碰桌面、不依赖隔离会话。否决原因是**协议上不可能**：`context_token` 只能来自入站消息，而 agent 无法自行产生（端点已全枚举，见实测契约）。这不是难度问题，是不存在这条路。
- **用文件对话框走"工具栏 → 附件"**：最强理由是它最贴近用户在 UI 上的直觉（用户原话提到"微信工具栏"）。否决原因是它依赖对对话框窗口的控制，而仓库里已有明确记录（`tools/quark-cli/README.md`）：保存对话框"能弹出、能转储子控件，但点确认按钮无效"。剪贴板粘贴不依赖任何对话框按钮，可靠性高得多。
- **把视频伪装成 PNG 走既有 `/api/send-image`**：最强理由是零代码改动。否决原因是严格校验（PNG 签名 + Pillow 解码 + 像素上限）会直接拒绝，且这条路本质上是绕过通道设计而不是使用它。
- **让桥接受任意路径 / 取消 `image_root` 约束**：最强理由是调用方不必先拷文件。否决原因是不该为了新通道去削弱既有图片通道的安全边界；新端点单独定规则更安全。
- **保留并恢复剪贴板**：最强理由是不打扰用户。否决原因是技术上做不到（读不回文件列表），且失败模式是**静默丢数据**，不如在文档里讲明。
- **不做，继续发公网链接**：最强理由是本轮之前一直这么做、零风险。否决原因是它把内容交给了第三方公开托管（当轮原话都写了"链接是公开的，别到处传"），而且用户在手机上要额外点开、另存，与"发给我"的诉求不符。

## Consequences

- **收益**：任意文件（视频/文档/压缩包）现在都能真正送达微信，且是**原文件字节**而非链接。走的是 Windows 官方 shell 机制（Explorer 复制即此格式），比模拟 UI 点击稳定。`/api/send-file` 与 `/api/send-image` 同构，白名单/目标确认/前台闸门全部复用，没有另起一套安全模型。
- **代价**：
  - **覆盖用户剪贴板**，且无法还原。
  - 核验依赖**附件名**这个约定：桥按 `<title>` 匹配，所以同名文件在核验窗口内连续发送两次时，第二次可能命中第一行。内容寻址的暂存命名（bot 侧）让这种情况在实践中不出现，但桥本身没有这层保护。
  - 新增了桥的代码面。改动**只新增、未触碰** `/api/send`、`/api/send-image`、`_dispatch_image`，所以既有通道的回归面为零。
  - 依赖隔离会话：桥必须由 `scripts/isolated-session/bridge-restart.ps1` 在会话内重启才能加载新端点。
- **遗留**：`BridgeState.dispatch_file`（无核验版）在 HTTP 层已无调用方，仅作保留。文件消息的读侧匹配器已由 `message_matches_file` 补上（见 Decision 第 4 条），所以"核验只能靠账本字段"这一限制已不成立。

## Testing

无自动化测试。真机验证是唯一手段，因为整条路径是 GUI 自动化 + 真实微信客户端。复现方式：把文件放进 `C:\ProgramData\cwin-probe\outbound-images`（两个账户都可读写），然后

```sh
curl -X POST http://127.0.0.1:8776/api/send-file \
  -H 'Content-Type: application/json' \
  -d '{"contact":"柳毓琳","talker":"wxid_ubo0cy5xh4px22","filePath":"<绝对路径>"}'
```

再用 `/api/v1/messages?talker=…` 核对 `localType` / `length` / `md5`。
