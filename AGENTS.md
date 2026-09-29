# Agent 约定 — cyberboss

本文件是给在本仓库里干活的 coding agent 的强制契约。目前只收录一项：**决策笔记纪律**（装自 `.agents/skills/write-notes-like-deepseek/`，方法提炼自 DeepSeek Harness 的工程实践）。完整契约见 `.agents/skills/write-notes-like-deepseek/SKILL.md`。

## 重要改动必须留笔记

1. **非平凡改动前先立笔记。** 命中任一项即为非平凡：改了**行为**、**架构**、**跨文件契约**、**流程与工具链**、**测试策略**、**落盘 / 网络 / 配置格式**。动手前遵循 `.agents/skills/write-notes-like-deepseek/SKILL.md` 写或更新笔记；机械性小改（样式、格式化、打标、不改行为的依赖补丁、常规 CRUD）直接提交代码，别加戏。
2. **先检索再动笔。** 写之前按模块名 / 关键词搜 `.agents/notes/`（含 proposed + implemented + rejected，排除 `archived/`）里的同主题旧笔记：有归属的**就地更新**那篇；新想法先放 `proposed/`；落地时随同代码改动转 `implemented/`；新方案彻底取代旧决策时，**同批**归档旧篇并标明被谁取代。
3. **被放弃的方案，先写它最强的理由，再解释为什么不用。** `## Alternatives considered` 是必填节，只写真实考虑过的对手方案。`## Consequences` 收益和代价都要写。
4. **提交前跑 `npm run verify-notes`，红了先修再交。** 代码和笔记同一次提交，不让笔记掉队。

## 笔记树（路径即状态，没有总索引）

```
.agents/notes/
├── proposed/      # 动手前：方案稿
├── implemented/   # 已落地：现在时事实，随代码一起改
├── rejected/      # 被否决：写明原因防重犯
└── archived/      # 已封存：SHA-256 封印，只增不改，改了 verify 报警
```

每层下固定 6 个类别目录，**不许自造**（`npm run verify-agent-note-tree` 会拦）：`feature` / `bug-fix` / `simplification` / `architecture` / `process` / `testing`。文件名格式 `yyyy-mm-dd-topic.md`，日期是首次提出日。

`archived/` 是冻结的历史快照，不是当前事实来源：检索时默认排除（根 `.rgignore` 已为 ripgrep 配好这条）。

## 校验命令

```sh
npm run verify-notes     # 三线闸门：树与互链 / 头块与必备节 / 归档封印（CI 与提交前用这个）
npm run verify-agent-note-tree
npm run verify-agent-note-format
npm run verify-archived
npm run check-anchors    # 软报告，不阻断
```

脚本用 `node` 直接执行技能包内的 `.ts`（Node 24 原生剥离类型，零依赖、不联网）。

## 既有项目约定

- 运行时：`.js` CommonJS（`"type": "commonjs"`），入口 `src/index.js`，改动后跑 `npm run check`。
- 本文件与 `.agents/skills/` 之外的工程约定（分支、发布、评审）尚未在此登记——需要时按同一套纪律补一篇笔记，再回填到这里。

## 常驻规则：微信里的「提醒」走 ios-notify

用户在微信里要求「提醒 / 通知 / 别让我忘了 / 设个日程提醒」时，**必须**调用 ios-notify skill（.agents/skills/ios-notify/SKILL.md），把提醒真正写进他的 iPhone 日历，而不是只用文字答应。
