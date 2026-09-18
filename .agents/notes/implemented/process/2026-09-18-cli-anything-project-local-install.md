# Agent Note: 项目内安装 CLI-Anything（方法论文档 + DSH 技能）

Status: implemented

## Problem

本轮需要给"让 agent 直接调用某个软件"这类需求一条稳定路径。前面试过三条都不成立：GUI 自动化（截图 + 坐标点击）脆弱且依赖会话状态；点对点包装（为单个软件写死驱动）每换一个目标就要重写一遍；客户端私有能力（如夸克网盘的下载）要么没有开放接口，要么被会员权益拦在最后一步（见 [隔离会话内夸克网盘验证结论](../testing/2026-09-18-quark-share-download-in-isolated-session.md)）。

[CLI-Anything](https://github.com/HKUDS/CLI-Anything)（HKUDS，Apache-2.0）提供的是方法论而不是运行时：一套 7 阶段流水线（分析 → 设计 → 实现 → 测试计划 → 实现测试 → 文档 → 发布），把"有代码库的软件"变成有状态、带 REPL、带 `--json` 的可安装 CLI。它的完整形态包含三层：**方法论**（`cli-anything-plugin/`：`HARNESS.md` + commands/guides/templates + 生成器脚本）、**Hub**（`cli-hub/`，`pip install cli-anything-hub` 的包管理器 + registry）、**已生成 harness**（仓库里 70 个目录）。

上游只提供"装进 agent 平台"的途径：Claude Code 插件市场、Cursor 插件、Codex skill（`CODEX_HOME`）、OpenCode/OpenClaw 的 commands 目录——**没有一条是"只装进当前项目"**。而本仓库的约束相反：它是 Node/CommonJS 的单人项目，`AGENTS.md` 要求非平凡改动留笔记，且不允许为了一个工具顺手改动全局环境。

## Decision

采用**项目内、只装方法论层**的形态，落点为以下事实：

1. **技能落点 `.agents/skills/cli-anything/`**，被 DSH 以 `project-agents` 源自动发现——实测**新增即生效、无需重启会话**（文件写完后本轮会话的技能目录里就出现了 `cli-anything`）。这与 [write-notes-like-deepseek 的安装方式](2026-09-16-write-notes-like-deepseek-install.md) 同一套路，是"项目内安装"在本仓库的既有含义。
2. **自包含布局**：`SKILL.md` + `references/`（`HARNESS.md`、`commands/` 5 份模式规范、`guides/` 8 份、`docs/PREVIEW_PROTOCOL.md`）+ `scripts/`（`repl_skin.py`、`preview_bundle.py`、`skill_generator.py`、`templates/SKILL.md.template`）+ 上游 `LICENSE`。**共 21 个文件、约 187 KB**，不含 70 个已生成 harness、不含 `assets/` 图片。
3. **来源 pin 在 commit `810c18b0d1ab9b234bc996c9fd999318523a3ef0`（2026-08-21）**，写进 `SKILL.md` 头部；升级方式是从 GitHub 重新取该目录树覆盖，而不是让技能包自己去联网。
4. **`SKILL.md` 里显式登记四处与上游默认行为的偏离**（本项目按这四条执行，优先级高于 vendored 文档）：
   - **不装 CLI-Hub**：`references/commands/list.md` 的发现流程依赖 Hub，本项目改为在磁盘上发现生成的 harness。
   - **产物不装全局**：上游第 7 阶段 `pip install -e .` 会落进当前解释器（本机是 miniconda base）。本项目改为二选一——专用项目 venv（`.venv-<name>/`）安装，或保持未安装、用 `python -m cli_anything.<software>` 调用；**禁止静默污染全局 conda**。
   - **闭源目标要降级预期**：流水线第 1 阶段依赖源码；只有编译产物的目标（如夸克网盘客户端）只能产出"包一层已有驱动面"的 harness，必须在 `<SOFTWARE>.md` 里标明。
   - **Windows/PowerShell 环境**：本机没有 `bash`/`cygpath`，vendored 文档里的 `bash` 片段要翻成 PowerShell。
5. **资源重映射表**：上游文档按插件布局写相对路径（`guides/...`、`cli-anything-plugin/repl_skin.py`、`templates/...`、`docs/PREVIEW_PROTOCOL.md`），在技能布局下解析位置不同。`SKILL.md` 保留了这张映射表，并在验证里逐条确认可解析（见下）。

## Verification

- **可发现**：写入后本轮会话的可用技能目录即出现 `cli-anything`（热加载，无需重启）。
- **资源自洽**：`HARNESS.md` 中引用的 10 个相对路径按重映射表全部 `OK`（8 份 guides + `cli-anything-plugin/repl_skin.py` + `templates/SKILL.md.template`；`docs/PREVIEW_PROTOCOL.md` 另测通过）。
- **脚本可用**：`python -m py_compile` 三个 vendored 脚本全部通过；`import repl_skin` 成功且导出 `ReplSkin`；`click 8.2.1` 在本机 miniconda base 里已存在（生成的 harness 不需要额外装 click）。
- **落盘占用**：21 个文件 / 约 187 KB，远低于"只留必需"的预算。

## Alternatives considered

- **按 Codex 官方路径安装（`CODEX_HOME` 指向项目）**：最强理由是它用的是上游自带、带回归测试的安装器（`codex-skill/scripts/install.ps1`），且会把权威 `HARNESS.md`、命令、guides、模板一起 vendor 进来，和本项目要的形态几乎一致。否决原因：它把技能装成 **Codex 的技能**，DSH 不读 `CODEX_HOME`；而且它 `Refusing to overwrite existing skill`，无法幂等重装。这里改为按 DSH 的技能布局手工落盘，只借用它的资源清单。
- **同时装项目内 venv 的 CLI-Hub（`pip install cli-anything-hub`）**：最强理由是它是上游推荐的入口，能一条命令浏览/安装社区 harness，将来要复用别人的成果最省事。否决原因：它与"本项目里要用的目标"无关（本仓库需要的是给自有软件生成 harness 的能力），却要新增一个 venv（conda 环境下上百 MB）与一个需要联网刷新 registry 的包管理器；而且 Hub 的 `install` 默认写全局 site-packages，与"只装到当前项目"的意图相反。需要时再单独装。
- **完整 pin 的源码副本（整个仓库 ~60 MB 放 `tools/`）**：最强理由是离线可复现、`PUBLISHING.md` 与 70 个既有 harness 都能当参考实现读。否决原因：用户明确选择轻量占用；而且已生成 harness 与本项目无关，真需要时可以按 pin 的 commit 从 GitHub 取。
- **做一个 DSH 插件来提供 `/cli-anything` 斜杠命令**（仿 `dsh-plugins/cyberboss-approval`）：最强理由是交互上最贴近上游体验（Claude Code/Cursor 都是斜杠命令）。否决原因：需要先摸清 DSH 插件 API 并长期维护一个 `main.patch.yml`，而技能已经能被模型按描述自动触发；收益不抵维护面，留作将来真需要命令面板时再做。

## Consequences

- **收益**：本仓库从此有了"把任意软件变成 agent 可调用 CLI"的方法论入口，且是**项目内、可随仓库分发**的；不新增任何运行时依赖（生成物才需要 Python，而本机已有 3.11 + click）；不污染全局环境。
- **代价**：多了一份需要跟上游同步的 vendored 文档——上游演进（尤其 `HARNESS.md` 与 commands 的措辞）不会自动进来，长期会有"本地约定 vs 上游新写法"的漂移；四处偏离集中写在 `SKILL.md` 的 Project Adaptations 一节，升级时按它复核。技能名 `cli-anything` 与上游同名，将来若改用插件形态需处理命名冲突。
- **未覆盖**：**没有跑过一次完整的 7 阶段生成**，所以"流水线在本机真的产出可用的 harness"仍未被证明；CLI-Hub 未装，`list` 模式只有磁盘发现这一条路；`preview_bundle.py` / `skill_generator.py` 只做了语法与导入验证，没有在真实 harness 上跑过。
- **与本仓库其他约定的关系**：生成的 harness 若进入 `src/` 会影响 `npm run check` 的检查面（它逐文件 `node --check`），因此 harness 应放在独立目录（如 `tools/`）而不是 `src/`；这条尚未写进 `AGENTS.md`，下次真正生成 harness 时一并补。
