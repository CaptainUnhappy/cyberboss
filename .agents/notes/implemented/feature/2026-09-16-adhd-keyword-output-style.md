# Agent Note: 微信回合支持用关键词点名 ADHD 输出风格

Status: implemented

## Problem

微信侧的 agent（跑在 `user\Unhappy` 工作区里的那个"你"）已经有一份行为契约：`templates/weixin-instructions.md` 里明确写了"她是 ADHD，而且不是靠'懂道理'就能解决的那种……别给她大计划，先给最小下一步。别一次说太多层。"

但那条约束是**语气与认知负担**层面的，不是**输出结构**层面的。它没说：结论/动作要不要放在第一行、多步任务要不要编号、能不能用"希望有帮助"收尾、一次能列几条、时间估计要不要具体。于是当她引用一段视频、一篇文章，配上"adhd"这样的点名时，回复长什么样完全取决于模型当回合的自觉——同一句话今天结构化，明天又散回散文。而"能不能一眼看见下一步"正是她最在意的那件事。

现状还有两个具体事实需要照顾：微信侧工作区由 `CYBERBOSS_WORKSPACE_ROOT` 指定，当前是 `D:\Projects\cyberboss\user\Unhappy`，**不是本仓库根**；persona 模板经 `{{USER_NAME}}` 与代词渲染后写入 state 目录，是所有微信回合共用的唯一拼装来源（`src/core/inbound-turn.js` 的 `assembleRuntimeTurnText()` 是逐回合 prompt 的唯一组装点）。

失败条件很明确：如果这条规则只写进 persona 散文，它就会像所有散文约定一样在该遵守的时候被漏掉。本仓库刚落地的元规矩就是"agent 遵守被强制的门，远胜于遵守散文式约定"——所以触发必须是机械的、可测的、可回归的。

## Decision

当前消息的原文（`prepared.originalText`）里出现独立词 `adhd` 时，**该回合**的 prompt 多一节输出风格；不出现就没有这一节。没有会话级状态：不做"模式"，关不掉也不需要关。

具体落点：

1. **触发**：`ADHD_STYLE_REQUEST_PATTERN = /(^|[^a-z0-9])adhd([^a-z0-9]|$)/i`，即 ASCII 独立词、大小写不敏感。`ADHD`、`用 adhd`、`adhd 模式`、`adhd：` 命中；`xadhd`、`adhdsum`、`noadhd`、`ad hd` 不命中。
2. **只认当前消息**：判定输入是 `prepared.originalText`，绝不扫 `quotedContexts`——转发来的文章标题里出现该词不会误开风格。
3. **注入点**：`src/core/inbound-turn.js` 的 `assembleRuntimeTurnText()`，位置在"引用/附件边界"之后、`Relevant durable memory` 之前，插在引用材料之后、回合其余部分之前。
4. **规则来源**：`templates/adhd-output-style.md`（微信版精简规则，18 行）。规则文件按模块级缓存懒读一次，读不到就**静默不加这一节**，绝不因此打断回合——与 `src/index.js` 里 persona 模板的降级约定一致。
5. **优先级写在注入节里**：persona 的人格、亲密度与微信语感高于本节；本节只管结构，不管温度。因此 `templates/weixin-instructions.md` **不动**——改动面越小，越不容易和人格文本互相干扰。
6. **`.agents/skills/i-have-adhd/SKILL.md` 保持上游原样**，作为在本仓库干活的 coding agent 的详版；它不参与运行时注入（它位于仓库根 `.agents/` 下、不在微信工作区内，运行时读取受沙箱约束）。两份文件各自注明关系。

## 相关笔记与当场审计

写这篇之前检索了 `.agents/notes/` 的 proposed + implemented + rejected：[write-notes-like-deepseek 安装笔记](../process/2026-09-16-write-notes-like-deepseek-install.md)（部分重叠——那篇讲把决策笔记纪律装进本仓库，本篇讲把 i-have-adhd 的输出风格接到微信回合；共同点是引入外部技能，不冲突、不取代，已双向互链）。另有并发会话写的 [联系人备注名导致选不中会话](../bug-fix/2026-09-16-contact-remark-display-name.md)，主题无关。

## Verification

落地当轮实测：

- 新增 `test/inbound-turn-adhd-style.test.js`，4 条断言全过（沙箱内用 `node test/inbound-turn-adhd-style.test.js` 单文件直跑；`node --test` 会 spawn 子进程而被沙箱拦，实测 EPERM，在用户终端正常）。
- **无关键词时逐字节等价**：断言整段 prompt 等于加关键词版本再做两处替换（她实际发的文本 + 插入的风格节）的结果，其余行一律不得移动。
- 词边界与"只认当前消息"两条各有独立断言覆盖，含反例（`xadhd`／`adhdsum`／`noadhd`／`ad hd`；关键词只出现在引用内容里）。
- 相邻回归套件全绿：`system-inbound` 22、`pending-inbound-store` 36、`turn-gate-store` 28、`command-registry-coverage` 4，fail 均为 0。
- `npm run check` 退出 0（`inbound-turn.js` 原本就在 check 列表里）；`npm run verify-notes` 三线绿。

## Alternatives considered

- **只改 persona 模板，零代码** — 最强理由：与仓库现状完全一致（persona 就是微信侧唯一的行为契约），改动面最小，不碰 `src/`、不用写测试，而且模型本来就能读懂"她用关键词点名了格式"这件事。不选的理由是它违反本仓库刚刚落地的元规矩：散文式约定在该遵守的时候会被漏掉，触发不可测、不可回归，换模型或换运行时时行为会漂移——而这恰恰是这套纪律存在的理由。
- **把上游 `.agents/skills/i-have-adhd/SKILL.md` 全文注入触发回合** — 最强理由：单一来源，上游更新即生效，不必维护两份规则；而且完整规则自带"何时破例"6 条（要解释就展开、破坏性操作先确认、调试打转就停下问），能避免规则死板地压扁回答。不选的理由是成本与错配：7.2KB／142 行，正文例子全是 `npm test -- auth.spec.ts`、`src/auth.ts:42` 这类面向 coding agent 的内容，对微信回合是噪音和 token 开销；且它位于仓库根 `.agents/` 下、不在微信工作区内，注入必须由 cyberboss 读文件再拼 prompt——既然都要走这一步，读一份为微信场景写的短规则更合适。
- **会话级"ADHD 模式"（说 `adhd` 开启，直到 `stop adhd mode`）** — 最强理由：忠于上游语义（它的 SKILL.md 就是"开启后持续生效直到关闭"），一次开启长期受益，不必每条消息都打关键词。不选（本轮）的理由是她给的场景是"总结这条引用的视频/文章"这类一次性任务；引入会话状态要多一个 store 字段、一套复位规则（换话题算不算？隔天算不算？进程重启算不算？）和一批边界测试，而收益只是省几个字符。留作后续提案，若她实际用起来觉得每条都打关键词很烦，再补。
- **在微信工作区 `user\Unhappy\.agents\skills\` 也装一份技能，让运行时自行发现** — 最强理由：零代码，且未来运行时若支持模型自调用技能就自动生效。不选的理由是 `user/` 在 `.gitignore` 里（纯本机数据），安装产物不可复现、换机即失效；而且 i-have-adhd 的 frontmatter 明确写着 `disable-model-invocation: true`，模型不会自行加载它，等于装了不用。

## Consequences

- **收益**：她点名一次，这一条回复的结构就是确定的——结论先行、编号、不寒暄、≤5 条、具体时间估计；总结引用材料时有固定骨架（一句话结论 → 编号要点 → 最小下一步）。触发与规则都可测、可回归，不依赖模型当回合的自觉。
- **代价**：多一个模板文件与一条 prompt 节；`assembleRuntimeTurnText()` 是所有微信回复的唯一拼装点，这条 `if` 增加了它的分支数（用"无关键词逐字节等价"的断言把风险钉住）。规则文件缺失时静默降级为"不加这一节"，也就是说模板被删掉不会报错，只会悄悄不生效——这是刻意选的降级方式（宁可少一节，不可打断回合），代价是排障时没有显式信号。
- **生效时机**：`inbound-turn.js` 在进程启动时加载，风格模板在首次用到时缓存一次——改代码或改 `templates/adhd-output-style.md` 之后都要重启 cyberboss 才生效（`Cyberboss-Restart.bat`）。
- **误触发**：她正常聊天里打出 "adhd"（"我今天 adhd 又犯了"）也会命中。缓解是本节只约束结构、不约束语气，且显式声明 persona 优先级更高，最坏结果是这条回复更结构化，不会变冷。
- **规则冲突**：persona 说"像微信，不像说明书"，本节说"多步任务编号"。缓解是把优先级与适用面写进注入节本身（信息/总结类走结构，亲密闲聊走 persona），而不是留给模型自由裁量。
- **覆盖不全**：她若换说法（"按 adhd 来""用那种格式"）——前者命中，后者不命中。不额外扩同义词表，避免过度设计；实际用起来漏了再补一条。
