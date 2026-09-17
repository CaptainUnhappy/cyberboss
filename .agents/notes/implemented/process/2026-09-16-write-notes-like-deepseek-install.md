# Agent Note: 用 write-notes-like-deepseek 决策笔记纪律约束本仓库的改动

Status: implemented

## Problem

本仓库的日常劳动力是 coding agent（Codex / Claude Code / DSH，多会话并行），而每个新会话都是一张白纸：它能读到 `src/` 里"系统现在怎么跑"，读不到"为什么必须这样跑、以及当初放弃了什么"。仓库里没有任何决定记录位置——根目录没有 `AGENTS.md`／`CLAUDE.md`，也没有 `docs/adr/` 之类（已核实：全仓不存在这些文件）。于是三件事必然发生：一段看起来别扭的代码被"顺手优化"掉；为赶一个局部需求打穿模块边界；三个月前证明过不行的方案被新会话兴致勃勃地重提。

约束有三条：**不引入新的运行时依赖**（本仓库只依赖少量 npm 包，供应链接触面刻意保持窄）；**必须离线可用**（本机 `npx` 写 npm cache 被沙箱拒绝，实测 `EPERM`，任何需要联网拉包的校验器都不可靠）；**不能打扰既有工程**（根 `package.json` 是 `"type": "commonjs"`，`scripts/` 下全是 `require`，任何"顺手统一模块制式"的做法都会打挂现有脚本）。

失败条件很具体：**规矩如果只是写在散文里的约定，agent 不会遵守**。DSH 团队验证过，agent 遵守"被强制的门"的可靠性远高于遵守散文式约定——所以这套纪律必须带机械牙齿（非零退出码），而不是又一份 README 倡议。

## Decision

本仓库采用 DSH 的决策笔记纪律，落点为以下六项事实：

1. **技能包**装在 `.agents/skills/write-notes-like-deepseek/`（`SKILL.md` + 8 份 `references/` + 3 份 `templates/` + 7 个脚本 + 看板模板 `assets/agent-notes-board.html`）。DSH 的 skill provider 从 `<projectRoot>/.agents/skills` 以 `project-agents` 源（rank 200）发现它，**新增即生效、不需要重启会话**——安装过程中本会话的 skill 目录已经出现过它。
2. **笔记树**固定为 `.agents/notes/{proposed,implemented,rejected,archived}/{feature,bug-fix,simplification,architecture,process,testing}/`，空的类目录用 `.gitkeep` 占位以便随仓库分发。路径即状态，不建 `INDEX.md`（多分支并行时总索引是最抢手的冲突源）。
3. **校验脚本用 `node` 直接执行技能包内的 `.ts`**，不用上游文档里的 `npx tsx`。这是可行的：脚本只用可擦除类型语法（无 `enum`／`namespace`／参数属性），Node 24 原生剥离类型即可运行，实测三条闸门全部可用。
4. **技能包自带一层 `package.json`（仅 `{"type":"module"}`）**。宿主根是 `type=commonjs`，而脚本是 ESM 语法且 import 时带 `.ts` 后缀；缺这层声明会被按 CJS 解析，直接报 `Cannot use import statement outside a module`（已复现）。它同时让技能包保持自包含：升级时整目录替换即可。
5. **根 `package.json` 新增 8 条 npm script**：`verify-agent-note-tree` / `verify-agent-note-format` / `verify-archived` / `verify-notes`（三线串跑）/ `archive-agent-note` / `check-anchors` / `init-board` / `bundle-board`。名字与 `SKILL.md` §6 一致，保证 agent 按技能文档敲的命令真实存在。
6. **`AGENTS.md` 是强制入口**，写死四条纪律（非平凡改动先立笔记 / 先检索再动笔 / 备选方案先写最强理由再否决 / 提交前跑 `npm run verify-notes`）。同时新增根 `.rgignore` 一行 `/.agents/notes/archived/`，让 ripgrep 默认不搜冻结快照——与 `SKILL.md` §3 的手写 `--glob '!.agents/notes/archived/**'` 等价，但不用靠人记得加。

上游文件除上述三处适配（脚本位置、运行器、本地 `package.json`）外未做任何改动；差异与更新方法记在技能包自己的 `README.md` 里。未纳入 `scripts/export-assets.sh`（上游仓库自身的配图流水线）与 `import-dsh-notes.ts`（从 sibling 的 deepseek-harness 检出导入，默认目标路径在本仓库必然指错）。

## Verification

安装当轮实测（`npm run verify-notes` 全绿，0 篇笔记时三条闸门均正常退出）：

- **闸门真的会咬**：把 `templates/proposed.md` 放进 `proposed/feature/` 后删掉 `## Alternatives considered` 一节 → `verify-agent-note-format` 报 `missing ## Alternatives considered / ## 备选方案` 并退出 1；把笔记放进自造的第七个类目录 `proposed/refactor/` → `verify-agent-note-tree` 报 `unknown class folder "refactor" (allowed: feature, bug-fix, simplification, architecture, process, testing)` 并退出 1。测试产物已删除。
- **看板可生成**：`npm run init-board` 产出 69KB 的 `board.html`，其模板路径 `../assets/agent-notes-board.html` 在技能包布局下解析正确。
- **已知环境降级**：在 DSH 沙箱里跑时，`verify-archived-agent-notes` 的 git 子进程（`execFileSync` 带 `stdio: pipe`）被拦（`EPERM`），脚本按设计降级为"跳过 append-only 检查"并告警，封印哈希仍照常核对磁盘；在用户自己的终端与 CI 里该检查正常执行。

## Alternatives considered

- **按上游 README 把 `scripts/` 复制到仓库根** — 这是上游明确推荐的做法，最大好处是文档路径完全一致：`npx tsx scripts/verify-agent-note-tree.ts` 照抄即可用，未来对齐上游升级也最省心。否掉它是因为类型制式冲突无解：根 `scripts/` 下全是 CommonJS 的 `require`，要在这层放 ESM 的 `.ts` 就得在 `scripts/` 里加 `"type":"module"`，而那会把同目录既有的 `.js` 脚本一起变成 ESM 解析并全部打挂；Node 也不支持按单个文件指定模块制式。脚本留在自包含的技能包里，既避开冲突，也让升级退化为"整目录替换"。
- **保持上游原样的 `npx tsx`** — 最"忠于原文"的选项，而且 tsx 能消化非可擦除语法，未来上游若引入 `enum` 之类也不必改调用方式。否掉它是因为它同时踩中两条约束：本机 `npx` 写 npm cache 被沙箱拒绝（实测 `EPERM`），且 tsx 需要联网拉包，离线环境直接失效。而这些脚本实测全部落在可擦除语法范围内，`node` 原生就能跑——零依赖、不联网、无缓存目录，赢得干净。
- **只装技能包，不建笔记树、不改 `package.json`、不建 `AGENTS.md`** — 侵入性最小的选项，且符合 `SKILL.md` §0"别一上来建全套目录"的告诫（空目录确实不必预建）。否掉它是因为这套方法的核心论点是"散文式约定不可靠"：没有 `AGENTS.md` 这道入口，新会话不会主动加载技能；没有 npm script，门禁不会被顺手跑到；只留一份 `SKILL.md` 等于把它降级成又一份 README 倡议。`.gitkeep` 占位是有意的例外，代价见下。
- **同时接上 GitHub Actions CI** — 团队仓库应该做（上游的 `verify-notes.yml` 会在每次 push 与 PR 上跑三线校验）。否掉它是因为本仓库目前是单人推送的个人项目，CI 的收益主要是给评审者看的；脚本调用方式本轮已经定死，将来要接只需补一个 workflow 文件，不必现在就把 CI 纳入维护面。

## Consequences

- **收益**：改动前有了必须先读的既有决策（"动手前先检索 proposed + implemented + rejected"），且纪律带非零退出码；被否掉的路会被写下来，不会每三个月被重新提出一遍；`archived/` 的 SHA-256 封印让"篡改老决定"当场报警。
- **代价**：多了一层需要维护的结构——24 个类目录与 `SKILL.md` 的六类分类法绑死，想加第七类必须改校验脚本（这是刻意的：目录不许自造）；`.gitkeep` 占位让空骨架随仓库分发，代价是 git 里多 24 个空文件；`board.html` 这类生成物不随仓库提交，需要时自己跑 `npm run init-board`。
- **升级面**：技能包与上游 `2aef219` 绑定，上游更新时需要整目录替换（保留包内 `README.md` 与 `package.json`）；因为本地只改了调用方式、没动脚本逻辑，升级风险集中在"上游是否引入非可擦除语法"这一点上——真出现时回退到 `npx tsx` 即可，npm script 换一个词的事。
- **第二篇技能**：输出风格技能 `i-have-adhd` 也装在 `.agents/skills/`（上游原文 + 本地说明，保持它"手动开关"的语义）；它在微信回合里的关键词接入见 [微信回合支持用关键词点名 ADHD 输出风格](../feature/2026-09-16-adhd-keyword-output-style.md)。
- **未覆盖**：CI 未接；`.rgignore` 让 ripgrep 默认不再搜 `archived/`，若将来需要全文检索冻结快照，要么临时 `--no-ignore`，要么把这一行删掉。
