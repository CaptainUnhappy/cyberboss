---
name: ios-notify
description: 用 iCloud 日历（CalDAV）给 iPhone 发原生提醒。当用户在微信里说「提醒我…」「X 点提醒」「别让我忘了…」「设个通知」，或要求把某件事排进日程提醒时使用。零第三方 App，不依赖 Bark/Server酱。
---

# ios-notify —— 给 iPhone 发原生日历提醒

## 什么时候用

用户在微信里提出**提醒类**需求时（"提醒我明天 10 点交电费"、"30 分钟后叫我"、"提前一天提醒我续费"），
以及需要把一件事排进他的 iPhone 日程提醒时，**用这个 CLI**，不要只用文字承诺。

## 工具位置

```
C:\Users\79388\Documents\dsh-workspace\ios-notify\
├── notify.py            ← CLI 入口（零第三方依赖，Python 3.9+）
├── .env                 ← 凭据（Apple ID + App 专用密码 + Principal ID + 日历路径），不要打印/不要提交
└── logs\<年>\<月-日>\<前缀>-<YYYYMMDD>-<HHMMSS>-<毫秒>.log   ← 每次运行一个日志文件
```

调用方式（在该目录下运行，或写绝对路径）：

```powershell
cd C:\Users\79388\Documents\dsh-workspace\ios-notify
python notify.py <命令>
```

## 命令

| 目的 | 命令 |
|---|---|
| 指定时刻提醒 | `python notify.py send "标题" --at "2026-09-30 10:00"` |
| 相对时间提醒 | `python notify.py send "喝水" --in 30m` |
| 提前量（如提前一天） | `python notify.py send "明天到期" --at "2026-10-01 09:00" --lead 1440` |
| 连续多天提醒 | 每天一条：`--at "2026-09-28 10:00"`、`"2026-09-29 10:00"` … |
| 换日历（单次） | 加 `--calendar <日历UUID>`（默认用 `.env` 的「个人」日历） |
| 核实是否写入成功 | `python notify.py show <UID>`（200 = 在服务器上，404 = 没写进去） |
| 删除某条 | `python notify.py delete <UID>` |
| 列日历 / 体检 | `python notify.py calendars`、`python notify.py doctor [--save]` |
| 测试通道 | `python notify.py test [--delay 10m]` |

## 使用要点（踩过的坑）

1. **时间必须是未来**：写过去的时间会被 CLI 拒绝（提醒不会补弹）。
2. **默认提前量太小会"静默错过"**：`test` 默认 2 分钟；iCloud 同步慢时事件到手机时触发点已过。
   真实提醒建议比目标时刻**早 1–2 分钟**执行，或直接用 `--at` 指定明确时刻。
3. **成功判据是 `HTTP 201`**，而且要看日志/`show` 确认落在服务器上；只看到控制台"已写入"不够。
4. **日志**（排查用，PowerShell 读要带 `-Encoding UTF8`）：
   ```powershell
   Get-Content (Get-ChildItem C:\Users\79388\Documents\dsh-workspace\ios-notify\logs -Recurse -Filter *.log |
     Sort-Object LastWriteTime | Select-Object -Last 1).FullName -Encoding UTF8
   ```
5. **凭据安全**：`.env` 里的 App 专用密码只显示一次、可随时吊销；**永远不要**把它打印到聊天里。
6. 手机侧前提：iPhone 登录的是 `.env` 里那个 Apple ID，且 `设置 → Apple 账户 → iCloud → 日历` 已开启
   （两个账号/开关关了都会表现为"电脑写成功、手机看不到"）。

## 在微信里怎么回应用户

1. 先把提醒写进去（拿到 UID 与弹窗时刻）；
2. 回复时给出**弹窗时刻 + 标题**（必要时给 UID，便于之后 `delete`）；
3. 用户说"取消/改时间"时，用 `show` 找到 UID → `delete` 旧的 → 再 `send` 新的；
4. 如果 CLI 报错（401/403/412 等），如实说明并给出下一步（`doctor`、检查 App 专用密码）。
