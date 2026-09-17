# i-have-adhd — 本地安装说明

本体来源：[ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)
上游提交：`0a84de401019a3a822248df586d88a2b56f8c6af`（`main`）
安装日期：2026-09-16
安装位置：`.agents/skills/i-have-adhd/`（项目级技能根 `.agents/skills/`，DSH 的 `project-agents` 源会自动发现）
许可证：MIT

## 这个技能是"手动开关"型的，装进去不等于生效

上游刻意设成**不入即用**：`SKILL.md` 的 frontmatter 写着 `disable-model-invocation: true`，Codex 适配器 `agents/openai.yaml` 里写着 `allow_implicit_invocation: false`。含义是——

- **模型不会自动加载它**，也不会在技能目录里被模型看见；DSH 的 skill provider 把 `disable-model-invocation: true` 解释为"排除在模型可见目录与加载器之外"，只保留人类可调用的入口。
- 它靠**你显式点名**开启，开启后持续生效，直到你说 "stop adhd mode" / "normal mode"。

所以：本目录的存在只是把权威文本放在仓库里（给会读文件的 agent 用，比如本仓库里干活的 coding agent），**不会**自动改变任何人的回复风格。

## 目录内容

| 路径 | 说明 |
|---|---|
| `SKILL.md` | 上游原文，未改动。10 条规则 + 5 条底层事实 + 6 条"何时破例" + 发送前自检。 |
| `agents/openai.yaml` | 上游原文。Codex 适配器（显示名、默认提示、`allow_implicit_invocation: false`）。 |
| `agents/gemini.toml` | 上游原文。Gemini 适配器。 |

未纳入：`hooks/`（Claude Code / Codex 的 SessionStart 钩子，靠 `~/.claude/.i-have-adhd-always` 标志文件实现"always-on"；DSH 不消费 `hooks/hooks.json`）、`.claude-plugin/`、`.codex-plugin/`、`.cursor/` 镜像、各运行时清单与 `evals/`、`tests/`、`scripts/`（上游自身的评估与发布工具链）。

## 微信侧的关键词触发（另一个东西，别混淆）

`cyberboss` 的微信回合里用关键词点名输出风格这件事**不由本技能目录实现**，而是走 `templates/adhd-output-style.md` + `src/core/inbound-turn.js` 的注入（见 `.agents/notes/implemented/feature/2026-09-16-adhd-keyword-output-style.md`）。本目录里的 `SKILL.md` 在那条链路里是**详版参照**，不是运行时读的规则源——因为它位于仓库根 `.agents/` 下、不在微信工作区（`CYBERBOSS_WORKSPACE_ROOT`）内，运行时读取受沙箱约束。

## 想真正常驻（always-on）时怎么办

上游为 Claude Code / Codex 提供了钩子方案：`hooks/hooks.json` 在 SessionStart 时调用 `hooks/always-on.mjs`，只要标志文件 `~/.claude/.i-have-adhd-always` 存在，就把去 frontmatter 的规则全文注入每个会话。它是**用户级**的（写 `~/.claude/`），不是项目级，且 DSH 不认这套钩子。在 DSH 里等效的做法是把规则写进 `AGENTS.md`（工作区指令每个会话自动注入）——本仓库目前**没有**这样做，是刻意的：保持手动开关语义。

## 更新方法

重新下载整包，替换 `SKILL.md` 与 `agents/`，保留本文件。
