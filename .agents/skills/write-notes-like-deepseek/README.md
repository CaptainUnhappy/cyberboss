# write-notes-like-deepseek — 本地安装说明

本体来源：[czm15053/write-notes-like-deepseek](https://github.com/czm15053/write-notes-like-deepseek)
上游提交：`2aef219faf608285f987a85d3f5f1109d6699725`（`main`）
安装日期：2026-09-16
安装目标：本仓库（cyberboss），项目级技能根 `.agents/skills/`，DSH 的 `project-agents` 源会自动发现。

## 目录内容

| 路径 | 说明 |
|---|---|
| `SKILL.md` | 主契约（**上游原文，未改动**）。判定要不要写、路径即分类、正文骨架、检索与归档纪律。 |
| `references/*.md` | 8 份按需加载的细则：分类、格式、何时写、归档、行文自检、简化自检、写后质量闸、脚本说明。 |
| `templates/*.md` | 三份填空模板：`proposed` / `implemented` / `rejected`。 |
| `scripts/*.ts` | 7 个校验与运维脚本（上游原文，未改动）。 |
| `assets/agent-notes-board.html` | 看板模板，`build-board.ts` 生成 `board.html` 时读取。 |
| `package.json` | **本地新增**，只写 `"type": "module"`，见下。 |

## 与上游的差异（仅此三处）

1. **脚本位置**：上游把 `scripts/` 放在仓库根，并要求 `npx tsx scripts/xxx.ts`。这里把脚本留在技能包内（插件自包含、升级时整目录替换），改由根 `package.json` 的 npm script 调用。
2. **运行器**：不用 `npx tsx`，直接用 `node`。Node ≥ 22.6（默认开启需 ≥ 23.6，本机 v24.14.1）原生剥离类型即可执行这些脚本——**零依赖、不联网、离线可用**。若在 Node 22.x 上跑，需加 `--experimental-strip-types`。
3. **本地 `package.json`**：宿主仓库根是 `"type": "commonjs"`，而脚本是 ESM 语法、import 时带 `.ts` 后缀；没有这层声明会被按 CJS 解析并报 `Cannot use import statement outside a module`。

## 已知环境差异：DSH 沙箱里的 git 降级

在 DSH agent 的沙箱内跑校验时，`verify-archived-agent-notes.ts` 会告警 `not a git repository — append-only check skipped`。这不是仓库的问题：沙箱禁止子进程走管道 stdio，脚本里 `execFileSync("git", …, { stdio: ["pipe","pipe","pipe"] })` 直接拿到 `EPERM`，于是按设计降级为**跳过"与 git 基线比对"这一步**（封印哈希仍照常核对磁盘）。在你自己的终端里、以及 CI 里，这一步正常执行，`AGENT_NOTE_ARCHIVE_BASE_REF` 生效。判断依据：同一环境下 `node -e "require('child_process').execSync('git rev-parse --short HEAD')"` 报 `EPERM spawnSync … cmd.exe`。

## 未包含的上游文件

- `scripts/export-assets.sh`（bash，仅用于上游仓库自身导出配图）
- `scripts/import-dsh-notes.ts`（从 sibling 的 deepseek-harness 检出导入笔记，默认目标路径指向上游仓库自身，在本项目里必然指错）
- `README.md` / `assets/*.png` / `board.html`（宣传与演示材料）
- `.github/workflows/verify-notes.yml`（本轮未接 CI）

## 更新方法

上游更新后，重新下载整包并替换本目录（保留本文件与 `package.json`），然后跑 `npm run verify-notes` 确认没红。校验脚本对笔记内容只做结构判定，升级不会动 `.agents/notes/` 里的既有笔记。

## 常用命令（在仓库根执行）

```sh
npm run verify-notes          # 三线串跑：目录/分类/文件名/互链 + 头块与必备节 + 归档封印
npm run check-anchors         # 软报告：代码里的 // Note: 锚点是否指向存在的笔记
npm run init-board            # 生成 board.html 决策看板（本地直读 .agents/notes）
```

归档某篇被取代的笔记：

```sh
npm run archive-agent-note -- .agents/notes/implemented/<类别>/<文件名>.md --superseded-by .agents/notes/implemented/<类别>/<新笔记>.md
```

（上游文档写作 `npm run archive-agent-note <path>`；用 npm 传参需要 `--` 分隔。）
