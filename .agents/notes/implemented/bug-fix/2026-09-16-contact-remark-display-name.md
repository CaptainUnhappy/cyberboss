# Agent Note: 备注覆盖显示名后无法进入联系人（按 talker 解析显示名，零缓存）

Status: implemented

## Problem

账号给联系人设了「备注」后，bridge 无法进入该会话：`.env` 里 `CYBERBOSS_WEFLOW_INBOX_DISPLAY_NAME=yourself`（**原始昵称**），而微信 UI 的会话行、聊天标题、聊天编辑器**三处都显示备注** `柳毓琳`。原代码把调用方字符串当 UI 名用（`session_item_{contact}`、`search_item_{contact}`、行 Name、编辑器前缀），设了备注就全部落空，fail-closed 到超时。

真机证据（Weixin 4.x，2026-09-16）：

1. 三处 UI 名 = `displayName`；`/api/v1/contacts` 22 条里 8 条带 `remark`，`displayName == remark` 恒成立。
2. 搜索按原始昵称能命中，但返回行标的是显示名；**多结果行没有任何可消歧字段**（dump 过全部子元素，只有自己的显示名）。实测搜索 `yourself` 返回 **2 行**（`柳毓琳` + `小窝👫`），两行都严格合法 → "唯一结果"规则在真机上不成立，因此**不能**靠搜索结果反推目标。
3. 搜索弹窗只在搜索框有焦点时存在；该路径被项目自己的 5 分钟空闲闸门保护。

## Decision

**按稳定标识 `talker`(wxid) 从 `/api/v1/contacts` 解析显示名，且每次派发现查、不缓存**：

1. 新增纯函数 `resolve_contact_names(contact, talker, contacts)` → `{rowName, accepted, username}`；`rowName = displayName`，`accepted = {displayName, remark, nickname, alias}`。
2. `BridgeState.fetch_contacts()` / `resolve_target_names()` **无任何缓存**：备注改名立即生效，不存在陈旧窗口；接口不可用时返回 `None`，完全退回改动前的单名语义。
3. 边界（`/api/send`、`/api/send-image`）先把 `contact` 换成 `rowName` 再往下走，**下游匹配器一行不改**；`exactContact` 仍要求 `contact` 与 `expectedContact` 都 ∈ `accepted`，防发错人的门槛不变。
4. 先前试过的"从搜索结果学名"保留为无害降级路径（唯一结果时才生效），不作为主机制。

## Verification

- **单测**：bridge 套件全绿（见提交信息里的用例数）；新增/保留 `ContactRowIdentityTests` 与解析用例。
- **真机端到端（本文件运行时打印）**：配置里的原始昵称 `yourself` → `rowName=柳毓琳` → 真实选会话链路 → 写入 → 回车 → 回读会话预览出现该消息；判定：**通过**（消息文本在 UIA 消息列表中回读命中：`itm-chatmessagelist-64ca` = "[cwin-lab E2E] 备注链路 21:04:20 请忽略"，会话预览 `session_item_柳毓琳` 同步更新）。
- 前提：微信窗口必须可见；最小化时物理点击兜底会失败（既有行为）。

## Alternatives considered

- **从搜索结果学显示名（唯一结果规则）**：真机证伪——搜索 `yourself` 返回 2 行且行内无可消歧字段，规则不成立；若改成"取第一行"，则"学到的名字"与"标题校验"同源，校验变成自证，等于架空防发错人的闸门。
- **硬编码显示名 / 配置里改写显示名**：能零代码修好，但备注一改就失效，且正是被明确排除的手段。
- **缓存联系表**：省一次本地 HTTP，但引入陈旧窗口（改名后一段时间内仍用旧名），被明确排除。
- **按 talker 直接定位会话行**：最稳，但微信 UIA 只暴露 `session_item_<显示名>`，拿不到每行的 wxid，不可行。

## Consequences

- **收益**：设了备注的联系人恢复可达；配置里写昵称或备注都能命中；解析结果来自权威表，标题/编辑器校验仍有独立意义。
- **代价**：每次派发多一次本地 HTTP（约数毫秒）；联系表与 UI 瞬时不一致时仍 fail-closed。
- **未覆盖**：群聊（`@chatroom`）与公众号的显示名语义未验证；直接会话行路径（不经搜索）对备注联系人依赖 `rowName` 解析。
