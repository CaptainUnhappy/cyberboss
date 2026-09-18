---
name: cli-anything
description: Use when the user wants to make a program, GUI app, or web service callable by an agent through a real CLI — "把 X 变成 CLI / 给 X 做个 CLI / 让 agent 能调用 X / build a CLI harness / refine or validate an existing harness". Runs the CLI-Anything 7-phase pipeline (analyze → design → implement → test plan → tests → docs → publish) and produces an installable Python Click CLI with REPL, --json output, undo/redo, and tests that call the real backend.
---

# CLI-Anything（本项目内安装）

Use this skill when the user wants an agent-native CLI harness for some software: build
one from scratch, refine coverage of an existing one, test it, validate it, or list what
exists. Upstream: [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything) — Apache-2.0,
vendored at commit `810c18b0d1ab9b234bc996c9fd999318523a3ef0` (2026-08-21).

## Read the Full Methodology First

1. Read `references/HARNESS.md` (the single source of truth for the 7 phases).
2. Read the matching mode spec under `references/commands/`.
3. Read files under `references/guides/` only when they apply to the target.
4. Only if those resources are unavailable, fall back to the condensed rules below.

## Resource Map

| Path | Purpose |
|------|---------|
| `references/HARNESS.md` | Complete methodology and quality rules |
| `references/commands/cli-anything.md` | Build-mode specification |
| `references/commands/refine.md` | Refine-mode specification |
| `references/commands/test.md` | Test-mode specification |
| `references/commands/validate.md` | Validation checklist |
| `references/commands/list.md` | Installed/generated harness discovery |
| `references/guides/` | On-demand implementation guidance |
| `references/docs/PREVIEW_PROTOCOL.md` | Shared preview bundle protocol |
| `scripts/repl_skin.py` | Copy into generated harnesses as `utils/repl_skin.py` |
| `scripts/preview_bundle.py` | Copy into preview-capable harnesses as `utils/preview_bundle.py` |
| `scripts/skill_generator.py` | Generate canonical and packaged CLI skills |
| `scripts/templates/SKILL.md.template` | Template used by `skill_generator.py` |
| `LICENSE` | Upstream Apache-2.0 license text (kept for attribution) |

## Project Adaptations (read before building)

This copy is installed **project-locally** in the cyberboss repo. Four upstream defaults
are deliberately changed here; honour these over the vendored documents when they differ.

1. **No CLI-Hub.** The upstream Hub (`pip install cli-anything-hub`, `cli-hub install <name>`)
   is *not* installed. Do not reach for it. Upstream `references/commands/list.md` discovers
   tools via the Hub — in this project, discover generated harnesses on disk instead.
2. **Generated harnesses land in the project, not on the global PATH.** Upstream phase 7 runs
   `pip install -e .` into the active interpreter (here: the global miniconda base, since the
   repo has no venv). Prefer one of:
   - create a dedicated project venv (`.venv-<name>/`) and install the harness there, then call
     it as `.venv-<name>\Scripts\cli-anything-<software>.exe`;
   - or keep the harness uninstalled and call it as `python -m cli_anything.<software>` from the
     harness directory (`__main__.py` exists for this reason).
   Never silently install into the global base environment — say which of the two you chose.
3. **Source is required; closed-source targets degrade.** The pipeline analyzes source code
   (phase 1). For a target that only ships a compiled binary (for example the Quark cloud-drive
   desktop client), the honest product is a **shell wrapper around an already-working drive
   surface** — parsed URLs, a documented backend, or files the app itself writes — not a
   reimplementation of the app's internals. Label the harness accordingly in `<SOFTWARE>.md`
   and keep the "verify real output" rule from HARNESS.md.
4. **Execution environment is Windows + PowerShell, offline-tolerant.** `python` is
   `D:\Tools\miniconda3\python.exe` (3.11). There is no `bash`/`cygpath` here, so translate any
   `bash` snippet in the vendored docs into PowerShell. `pip install` needs network; if it is
   unavailable, use the uninstalled `python -m` form from adaptation 2.

## Inputs

Accept either a local source path (`D:\Tools\<software>` or `./<software>`) or a GitHub URL
(`https://github.com/<org>/<repo>`). Derive the software name from the local directory name
after cloning if needed.

## Modes

- **Build** — read `references/commands/cli-anything.md`; run all 7 phases.
- **Refine** — read `references/commands/refine.md`; gap analysis, incremental and non-destructive.
- **Test** — read `references/commands/test.md`; update `TEST.md` only with passing results.
- **Validate** — read `references/commands/validate.md`; full directory/implementation/test/
  documentation/packaging/quality checklist.
- **List** — read `references/commands/list.md`; on-disk discovery, human or JSON output.

## Condensed Fallback Rules

Use these only when the full methodology cannot be retrieved.

### Harness Structure

```text
<software>/
└── agent-harness/
    ├── <SOFTWARE>.md
    ├── setup.py
    └── cli_anything/
        └── <software>/
            ├── README.md
            ├── __init__.py
            ├── __main__.py
            ├── <software>_cli.py
            ├── core/
            ├── utils/
            └── tests/
```

### Required Behavior

- Prefer the real software backend over reimplementation.
- Provide one-shot Click subcommands and default REPL mode.
- Support `--json` machine-readable output.
- Add session state with undo/redo where the target supports it.
- Auto-save one-shot session mutations and support `--dry-run`.
- Use locked session-file writes to avoid concurrent JSON corruption.
- Copy and use the unified `ReplSkin` (`scripts/repl_skin.py`).
- Add truthful preview commands for software with meaningful visual or inspection state.
- Generate both canonical and packaged CLI-specific `SKILL.md` files.

### Testing

- Write `TEST.md` before test code.
- Keep `test_core.py` for unit coverage.
- Keep `test_full_e2e.py` for real-file workflows and real backend validation.
- Verify rendered/exported output programmatically, not only process exit codes.
- Test the installed `cli-anything-<software>` command via `_resolve_cli()`.
- Run release validation with `CLI_ANYTHING_FORCE_INSTALLED=1`.

### Packaging

- Use `find_namespace_packages(include=["cli_anything.*"])`.
- Keep `cli_anything/` as a namespace package without a top-level `__init__.py`.
- Expose `cli-anything-<software>` through `console_scripts`.
- Include the packaged CLI-specific `skills/SKILL.md`.

## Output Expectations

When reporting progress or results, include: target software and source path; files added or
changed; validation commands run; open risks or backend limitations — plus which install form
from adaptation 2 was used.
