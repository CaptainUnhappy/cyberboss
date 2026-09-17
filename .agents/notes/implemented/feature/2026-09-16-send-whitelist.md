# Agent Note: 发送白名单（只允许指定 talker 收发）

Status: implemented

## Problem

四个账号需要互相收发消息，而 bridge 的 `/api/send` 与 `/api/send-image` **接受任意 `talker`**：只校验 `exactContact`（名字与 talker 是否自洽），没有任何"只准发给谁"的限制。真机实测（2026-09-16）确认这四个身份与配置的关系：

| 角色 | wxid（主键） | UI 显示名 | 原始昵称 | 微信号 alias |
|---|---|---|---|---|
| 大号① 发方 | `wxid_ubo0cy5xh4px22` | 柳毓琳 | yourself | — |
| 大号② 发方 | `wxid_6r2qv9w2hgth22` | 美女 | . | — |
| 小号① 互发 | `wxid_s3178hwvzsl922` | Azzy | Azzy | Azsy20020407 |
| 小号② 互发 | `wxid_ty69l7hjiqt012` | Ally | Ally | Alyl20020101 |

关键事实：**微信号（alias）与备注都只存在于联系人表里，微信 UIA 上永远是显示名**，所以白名单必须以 `wxid` 为主键；而 `resolve_contact_names()` 产出的 `accepted = {displayName, remark, nickname, alias}` 正好让白名单条目可以用任意写法书写后再归一到 talker。

## Decision

1. 新增 `parse_allowed_talkers(value)`（逗号/分号/空白分隔，去空去重）与 `talker_is_allowed(allowed, talker)`（**空名单 = 不限制**，保持向后兼容；非空则精确匹配）。
2. 新增 CLI 参数 `--allowed-talkers`，默认取环境变量 `CYBERBOSS_WEFLOW_ALLOWED_TALKERS`；`BridgeState.allowed_talkers` 在启动时解析一次。
3. 在两个发送边界的入口处校验（在 contact/talker 必填校验之后、任何 GUI 动作之前）：不在名单内直接返回 **HTTP 403 `TALKER_NOT_ALLOWED`**，绝不进入派发流程。
4. `.env` 写入这四个 wxid，使白名单在运行时生效。

## Verification

- 单测 `SendWhitelistTests`：解析分隔符/去重去空/非字符串输入、空名单放行、非空名单精确匹配（含空串与前缀干扰）。
- 真机（服务重启后，见提交信息）：名单外 talker → **403 TALKER_NOT_ALLOWED**；名单内 talker → 通过白名单进入下一道门（测试时为 409 `CANARY_DESKTOP_ACTIVE`，说明白名单已放行而非被它拦下）。
- bridge 套件全绿 + 笔记三道闸门全绿。

## Alternatives considered

- **把白名单写在代码里**：最省事，但改一次名单就要改代码并发版，且与"配置驱动"的既有风格冲突。
- **按显示名/微信号做白名单**：写起来直观（`Azzy`/`柳毓琳`/微信号），但显示名会被备注覆盖、微信号在 UIA 上根本不存在，匹配只能在联系人表里做，一旦表不可用就会误判。以 wxid 为主键最稳。
- **空名单 = 全部拒绝**：更安全，但会让所有既有部署在升级瞬间停摆（它们没有这个环境变量）。选择"空 = 不限制"以保证升级零影响，由 `.env` 显式开启限制。
- **在 dispatch 内部（GUI 之后）校验**：位置太靠后，会在已经动过窗口之后才拒绝，浪费一次前台抢占。

## Consequences

- **收益**：名单外的 talker 在任何 GUI 动作之前就被拒绝；四个账号的收发边界变成显式配置，可审计。
- **代价**：多一个必须维护的环境变量；`.env` 通常不进版本库，新机器部署时要记得补。
- **未覆盖**：入站侧仍是单目标（`CYBERBOSS_WEFLOW_INBOX_CHAT` 只配了 `wxid_ubo0cy5xh4px22`），"四个账号互相收发"还需要把入站轮询扩成多目标；白名单只管出站。
