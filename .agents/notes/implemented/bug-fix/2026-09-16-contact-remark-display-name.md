# Agent Note: 联系人被设了备注后无法进入会话（把匹配名从调用方字符串改成微信自己返回的名字）

Status: implemented

## Problem

账号里给联系人设了「备注」（remark）之后，bridge 无法选中该联系人的会话——`select_exact_contact_session` 一路 fail-closed 到超时。典型现场：`.env` 里 `CYBERBOSS_WEFLOW_INBOX_DISPLAY_NAME=yourself`（**原始昵称**），而 UI 上那个会话的行叫 `session_item_柳毓琳`（**备注**）。

真机实测（Weixin 4.x，2026-09-16）：

1. **微信所有界面都用「显示名」**：会话行 `session_item_柳毓琳`、聊天标题 `current_chat_name_label=柳毓琳`、编辑器 `chat_input_field` 名前缀也是 `柳毓琳`。另一个联系人 `美女`（`nickname="."`、`remark="美女"`）同样三处都显示 `美女`。
2. **搜索按原始用户名命中，但返回行标的是显示名**：搜索框输入 `yourself` → 返回 `search_item_柳毓琳 / Name=柳毓琳`。这是本修复所依赖的关键机制。
3. **多结果行没有任何可用于消歧的字段**：搜索 `a` 返回 5 行（`search_item_Azzy` / `Ally` / `美女` / …），每行**只有自己的显示名**，没有微信号、别名或原始昵称子元素（探针 dump 过全部子元素）。
4. `/api/v1/contacts` 里 22 条有 8 条带 `remark`，`displayName == remark` 恒成立。

原代码用**调用方给的字符串**同时充当"UI 上的名字"：`session_item_{contact}`、`search_item_{contact}`、行 `Name == contact`、编辑器名前缀 `== contact`。设了备注时这些全都不成立，于是永远确认不了目标。

## Decision

**不引入任何外部名字表、不缓存、不硬编码**，改成"先从微信自己的搜索结果里学出显示名，再走原有的严格匹配"：

1. 新增 `resolve_display_name_from_search(root, requested, timeout)`，在**搜索路径**上、在原有的 `search_item_{contact}` 循环之前调用：
   - 若结果里已有一行名字**就是** `requested` → 原样返回（未设备注时的行为 100% 不变）；
   - 否则若**恰好一行**满足"严格形状 + 自洽"（`id == search_item_ + 自己的 Name`、`mmui::SearchContentCellView`、ListItem、可见可用、位于严格 popup/list 上下文）→ 返回该行的显示名；
   - 0 行或 ≥2 行 → 返回 `requested`，即完全退回原行为并交给既有闸门 fail-closed。
2. `learned name` 直接覆盖局部变量 `contact`，**下游所有匹配器一行不改**（会话行/搜索行/标题/编辑器仍做字面相等比较）。这就是为什么既有 52 个用例的契约全部保持不变。
3. 新增两个纯谓词 `session_row_identity_is_self_consistent` / `search_row_identity_is_self_consistent` 供第 1 步识别"自洽行"，不参与最终的发送判定。
4. **删除了先前那版被否掉的实现**：`/api/v1/contacts` 解析、`CONTACT_CACHE_TTL_SECONDS` 缓存、ContextVar 编辑器别名、`BridgeState.resolve_target_names`。

## Verification

- **单测**：`ContactRowIdentityTests` 3 例（两个自洽谓词的正反例；编辑器匹配器仍要求精确显示名）。bridge 套件 **52 → 55 全绿**（`Ran 55 tests ... OK`）。
- **真机（部分通过，学名尚未生效）**：`Azzy` → 返回 `Azzy`（老行为不变，通过）；`a`（5 行歧义）→ 返回 `a`，不猜（通过）；**`yourself` → 仍然返回 `yourself`，没有学到 `柳毓琳`（未通过）**。
  原因：`resolve_display_name_from_search` 里额外要求了 `strict_search_result_context_matches`（搜索弹窗 + `search_list` 祖先链），该判据在这条调用路径上不成立，候选集为空 → 退回 `requested`。裸探针（只查 class/type/enabled + 自洽）在同一时刻能看到 `search_item_柳毓琳`，说明是这道额外判据把候选滤掉了。
  待办：把这道判据从"学名"步骤里去掉或放宽（它是给最终选中行用的严格证明，不该参与候选枚举），或改为先枚举、再对唯一候选复核上下文；改完必须重跑本项真机检查。
- 更早一轮已用 bridge 真实链路验证过：`select_exact_contact_session(hwnd, '柳毓琳')` 成功（`selection OK; editor Name='柳毓琳'`，标题 `['Azzy']` → `['柳毓琳']`）。
- 前提：微信窗口必须可见；最小化时选会话的物理点击兜底会失败（既有行为）。

## Alternatives considered

- **用 `/api/v1/contacts` 解析显示名（先前的实现，已删除）**：能修好，且能处理多结果歧义（按 talker 精确取名字集合）。否掉是因为它引入第二个事实来源与 30s 缓存：备注改名后缓存窗口内会错，接口不可用（测试环境实测 401）时整条链路依赖降级，而调用方本来就知道"原始用户名"这个稳定输入。违背"不用外部查表/缓存"的约束。
- **按 talker(wxid) 精确定位会话行**：语义最稳，但 Weixin 的 UIA 只暴露 `session_item_<显示名>`，拿不到每行的 wxid，物理上不可行。
- **搜索多结果时取第一行**：能绕过歧义，但等于把"发错人"的概率交给微信的排序，与整个 bridge 的 fail-closed 取向相反；且实测多结果时行内没有任何可交叉验证的字段（Problem 第 3 条）。
- **把匹配器放宽成"行自洽即可"（不要求等于调用方名字）**：试过，`test_search_navigation_*` 4 个用例立刻变红——它们正是覆盖多结果导航与顺序变化的契约。放宽会静默改变这些安全语义，故回退匹配器、只保留"先学名"。

## Consequences

- **收益**：设了备注的联系人恢复可达；改动只在搜索路径上多一步"学名"，匹配器与既有闸门零改动，回归面小（55/55 全绿）。
- **代价**：多一次 UIA 遍历（≤ timeout，通常一两轮 100ms 轮询）；如果搜索恰好只返回一行、而那一行不是用户想找的人，新逻辑会采纳它的名字——由后续的标题/编辑器字面校验与 talker 锚定兜底。
- **未覆盖 / 已知未完成**：**学名步骤在真机上尚未生效**（见 Verification 第 3 条），因此"备注联系人经搜索路径可达"这条端到端能力目前**只在以显示名（`柳毓琳`）直接调用时验证过**，用配置里的原始昵称（`yourself`）走搜索路径仍然失败；群聊（`@chatroom`）与公众号的显示名语义未验证；"给有备注的联系人真机发送一条消息"的完整派发未跑；直接会话行路径（不经搜索）对备注联系人仍不可用。
