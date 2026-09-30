<div align="center">

[中文](./README.zh-CN.md) · English

# The Overbearing Boss Fell for My ADHD
## Cyberboss: a WeChat bridge for Codex and Claude Code

> "Keep escaping into dopamine if you want. I'll still catch you at the next timestamp."

[![Node >=22](https://img.shields.io/badge/Node-22%2B-3C873A)](./package.json)
[![License: AGPLv3](https://img.shields.io/badge/License-AGPLv3-b31b1b)](./LICENSE)
[![Runtime-Codex%20%7C%20ClaudeCode](https://img.shields.io/badge/Runtime-Codex%20%7C%20ClaudeCode-111827)](#technical-stack)
[![Bridge-Weixin](https://img.shields.io/badge/Bridge-Weixin-07C160)](#technical-stack)
[![Timeline-Enabled](https://img.shields.io/badge/Timeline-Enabled-8b5cf6)](#core-features)

<p>
  <a href="#user-guide">User Guide</a> ·
  <a href="#agent-guide">Agent Guide</a> ·
  <a href="#data-dir">Local Data</a> ·
  <a href="#faq">FAQ</a>
</p>

</div>

<p align="center">
  <img src="./docs/images/IMG_0241.PNG" alt="Cyberboss English demo 1" width="31%" />
  <img src="./docs/images/IMG_0244.PNG" alt="Cyberboss English demo 2" width="31%" />
  <img src="./docs/images/IMG_0245.PNG" alt="Cyberboss English demo 3" width="31%" />
</p>

Cyberboss is not another polite productivity timer. It is not a to-do list with better branding either.

It is an agent bridge that plugs a local coding runtime directly into WeChat and turns it into a time-aware, context-persistent accountability companion. It supports Codex and Claude Code while keeping the same commands and day-to-day behavior. It does not wait for you to "start a session". It watches the flow of your day, notices when you disappear, and decides when to show up again.

## Why Cyberboss?

For people with ADHD, or anyone who needs strong external accountability, most productivity tools fail for the same reason: they assume you still have enough executive function to remember to use them.

Cyberboss starts from a transfer of control.

- No manual start button
  It lives inside the chat interface you actually open every day.
- Inescapable sense of time
  It sees when you replied, when you vanished, and how long a promise stayed unresolved.
- Real external feedback
  If self-discipline is unreliable, hand the supervision layer to an agent that stays online, keeps memory, and can act across time.

<a id="core-features"></a>
## Core Features: fully automated accountability

1. Omniscient Time
Every inbound WeChat message is stamped with local time before it reaches the runtime. The model is not just reading text. It is reading your day as it unfolds.

2. The Ledger of Life
Using those timestamps, Cyberboss reconstructs when events start, when they end, and how long they last, then turns fragmented chat into a structured personal timeline.

3. Stochastic Pulse
At random intervals, the system wakes the agent up and lets it decide what to do next: send a message, stay silent, write in the diary, update the timeline, or use tools.

4. Local Reminder Queue
Reminders are not primarily a user-facing alarm clock. They are how the model leaves instructions for its future self and wakes itself up later.

5. Zero-Token Diary
Daily traces can be written to local files without depending on a cloud note service or burning extra model context every time.

## Timeline also works on its own

If the most interesting part of Cyberboss is the "ledger of life" layer, you can use that separately:

- Project: [WenXiaoWendy/timeline-for-agent](https://github.com/WenXiaoWendy/timeline-for-agent)
- It is an independent project and does not require the WeChat bridge
- You can plug it into your own agent, bot, or automation stack even if you do not use Codex

Cyberboss builds on top of `timeline-for-agent`, then adds WeChat, reminders, diary writing, and random check-ins around it.

<a id="technical-stack"></a>
## Technical Stack

- **Core**
  A pluggable runtime layer for Codex and Claude Code, with the same WeChat command surface and shared-thread workflow.
- **Bridge**
  A WeChat HTTP bridge with long-poll synchronization for inbound messages, outbound replies, files, and status transitions.
- **Task System**
  Local queues for reminders, system triggers, and timeline screenshot jobs.
- **Capability Layer**
  Timeline, diary, random check-ins, file delivery, and related runtime actions.
- **Optional Tooling**
  MCP or other local hardware / software integrations can be added, but they are optional.

## Why It Exists

Cyberboss is built against the myth that productivity begins with self-control.

- Pomodoro assumes you can start on command.
- To-do apps assume you can keep returning.
- Reminder apps assume you will still respect them when they fire.

Cyberboss assumes none of that. It treats the user as someone who may drift, disappear, procrastinate, or lose momentum, then moves the regulatory layer outside the user and into an always-on local agent.

<a id="user-guide"></a>
## User Guide

### Requirements

**Core (always needed)**

- Node.js `>= 22`
- An agent runtime, chosen with `CYBERBOSS_RUNTIME`:
  - `codex` (default) — the `codex` CLI must be on your `PATH`
  - `claudecode` — the `claude` CLI must be on your `PATH`
  - `dsh` / `dsh-acp` — **nothing to install**: the DeepSeek Harness binary comes from this
    repository's own dependency (`@deepseek-ai/dsh`) and is resolved out of `node_modules`.
    Override with `CYBERBOSS_DSH_BIN`, pick a profile with `CYBERBOSS_DSH_PROFILE` (default `sdk`).
    Model access comes from that profile's provider configuration, not from this repo.
  - Its own model credentials/endpoint (Codex app-server, Claude CLI login, or the DSH profile) — this project does not ship any.
- Chrome / Chromium / Edge if you want screenshot features
- Python `>= 3.11` **only if** you enable the personal-account channel (see below)
- Windows **only if** you enable the personal-account channel; everything else runs cross-platform

**Message channels: pick one or both**

Cyberboss can talk to you through two independent channels. They have very different requirements, and neither is a prerequisite for the other.

| | `ilink` — official WeChat bot API | `weflow-uia` — personal WeChat account |
|---|---|---|
| How it works | HTTPS to `ilinkai.weixin.qq.com` | Local UI automation of the WeChat desktop client |
| Needs | A paired bot account (`npm run login`) | **Windows host only**: WeChat desktop client, [WeFlow](https://github.com/WenXiaoWendy) local reader API, Python with the automation deps below, and an input desktop the bridge may drive |
| Can start a conversation | No — every outbound reply consumes the `context_token` carried by an inbound message | Yes — there is no reply window, so the bot may send proactively |
| Login | QR pairing once | WeChat stays logged in on that machine |
| Extra setup | none | see [Personal-account channel](#personal-account-channel-weflow-uia) |

If you only run the official channel, a plain Linux/macOS box with Node is enough. The personal-account channel is the part that ties you to a Windows desktop.

### Get the source and install dependencies

This project is not published as an npm package. Clone your fork and install inside the project directory:

```bash
git clone https://github.com/<you>/cyberboss.git
cd cyberboss
npm install
```

### Configure environment variables before the first command

`Cyberboss` reads environment variables from:

- `.env` in the current project directory
- `${HOME}/.cyberboss/.env`
- the current shell environment

Before running the first command, set at least:

```dotenv
CYBERBOSS_USER_NAME=YourName
CYBERBOSS_USER_GENDER=female
CYBERBOSS_ALLOWED_USER_IDS=your_wechat_user_id
CYBERBOSS_WORKSPACE_ROOT=/absolute/path/to/your/project
```

Common optional variables:

```dotenv
CYBERBOSS_RUNTIME=codex
CYBERBOSS_CODEX_ENDPOINT=ws://127.0.0.1:8765
CYBERBOSS_CODEX_COMMAND=
CYBERBOSS_CODEX_MODEL=
CYBERBOSS_CODEX_MODEL_PROVIDER=
CYBERBOSS_CODEX_NATIVE_IMAGE_INPUT=
CYBERBOSS_CLAUDE_COMMAND=claude
CYBERBOSS_CLAUDE_MODEL=
CYBERBOSS_CLAUDE_CONTEXT_WINDOW=
CYBERBOSS_CLAUDE_PERMISSION_MODE=default
CYBERBOSS_CLAUDE_DISABLE_VERBOSE=false
CYBERBOSS_CLAUDE_EXTRA_ARGS=
CLAUDE_CODE_MAX_OUTPUT_TOKENS=
CYBERBOSS_VISION_MODE=auto
CYBERBOSS_VISION_PROVIDER=openai-compatible
CYBERBOSS_VISION_API_BASE_URL=
CYBERBOSS_VISION_API_KEY=
CYBERBOSS_VISION_MODEL=
CYBERBOSS_VISION_TIMEOUT_MS=30000
CYBERBOSS_ACCOUNT_ID=
CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS=20
CYBERBOSS_WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com
CYBERBOSS_WEIXIN_CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
CYBERBOSS_WEIXIN_QR_BOT_TYPE=3
CYBERBOSS_ENABLE_LOCATION_SERVER=false
CYBERBOSS_LOCATION_HOST=0.0.0.0
CYBERBOSS_LOCATION_PORT=4318
CYBERBOSS_LOCATION_TOKEN=
CYBERBOSS_LOCATION_HOME_CENTER=
CYBERBOSS_LOCATION_WORK_CENTER=
CYBERBOSS_LOCATION_KNOWN_PLACES=
CYBERBOSS_LOCATION_PLACE_RADIUS_METERS=150
CYBERBOSS_LOCATION_BATTERY_HISTORY_LIMIT=100
```

What these do:

- `CYBERBOSS_RUNTIME`
  Choose `codex` or `claudecode`. The command set stays the same.
- `CYBERBOSS_CODEX_ENDPOINT`
  Reuse an existing shared Codex app-server instead of spawning a private runtime.
- `CYBERBOSS_CODEX_COMMAND`
  Override the Codex launcher when `codex` is not directly on your `PATH`.
- `CYBERBOSS_CODEX_MODEL`
  Force Codex turns to use a specific model. Leave empty to use Codex's default model selection.
- `CYBERBOSS_CODEX_MODEL_PROVIDER`
  Force Codex turns to use a specific provider, such as `ollama` for local models. Leave empty for the default cloud provider.
- `CYBERBOSS_CODEX_NATIVE_IMAGE_INPUT`
  Optional override for direct image input through the Codex app-server path. Leave empty to infer from model metadata; set `true` to test a local multimodal model directly, or `false` to force caption fallback.
- `CYBERBOSS_CLAUDE_COMMAND`
  Override the Claude launcher. Default is `claude`.
- `CYBERBOSS_CLAUDE_MODEL`
  Set the default Claude model.
- `CYBERBOSS_CLAUDE_CONTEXT_WINDOW`
  Set Claude's effective context window so `/status` can show an approximate context usage line.
- `CYBERBOSS_CLAUDE_PERMISSION_MODE`
  Set Claude's permission mode before the bridge starts.
- `CYBERBOSS_CLAUDE_DISABLE_VERBOSE`
  Disable verbose Claude terminal output.
- `CYBERBOSS_CLAUDE_EXTRA_ARGS`
  Append extra Claude CLI arguments as a comma-separated list.
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
  Reserve output tokens for Claude replies. `/status` subtracts this reserve from the configured Claude context window.
- `CYBERBOSS_VISION_MODE`
  Choose how inbound images are handled: `auto`, `caption`, `native`, or `off`. `auto` uses native image input when a runtime supports it, otherwise falls back to captions.
- `CYBERBOSS_VISION_PROVIDER`, `CYBERBOSS_VISION_API_BASE_URL`, `CYBERBOSS_VISION_API_KEY`, `CYBERBOSS_VISION_MODEL`
  Configure the optional OpenAI-compatible vision caption API used for text-only models. For Qwen/DashScope, start from [templates/vision-openai-compatible.env](./templates/vision-openai-compatible.env).
- `CYBERBOSS_VISION_TIMEOUT_MS`
  Timeout for each image caption request.
- `CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS`
  Set the default minimum merge size for short WeChat reply chunks.
- `CYBERBOSS_WEIXIN_BASE_URL`, `CYBERBOSS_WEIXIN_CDN_BASE_URL`, `CYBERBOSS_WEIXIN_QR_BOT_TYPE`
  Override the WeChat bridge endpoints and QR bot type when your deployment needs it.
- `CYBERBOSS_ENABLE_LOCATION_SERVER`
  Enable the built-in whereabouts HTTP ingest server.
- `CYBERBOSS_LOCATION_HOST`
  Host for the built-in whereabouts HTTP server. Default is `0.0.0.0`.
- `CYBERBOSS_LOCATION_PORT`
  Port for the built-in whereabouts HTTP server. Default is `4318`.
- `CYBERBOSS_LOCATION_TOKEN`
  Bearer token used to upload location data.
- `CYBERBOSS_LOCATION_HOME_CENTER`, `CYBERBOSS_LOCATION_WORK_CENTER`
  Home and work center coordinates in `lat,lng` format.
- `CYBERBOSS_LOCATION_KNOWN_PLACES`
  Extra named places as a JSON array.
- `CYBERBOSS_LOCATION_PLACE_RADIUS_METERS`
  Radius for place-tag matching. Default is `150`.
- `CYBERBOSS_LOCATION_BATTERY_HISTORY_LIMIT`
  Number of battery observations to retain. Default is `100`.

#### Operational overrides (only if your machine differs)

Everything below already has a working default derived from the checkout location, so an ordinary
install never sets them. They exist so a second machine, another drive, or a different interpreter
does not require editing source. **The only hardcoded paths left in the repository are these
fallbacks**, and `npm run verify-portable` enforces that.

| Variable | Used by | Default |
|---|---|---|
| `CYBERBOSS_REPO_ROOT` | isolated-session recipes | two levels above the recipe |
| `CYBERBOSS_QUEUE_ROOT` | file-queue recipes, guards, probe root | `C:\ProgramData\cwin-probe` |
| `CYBERBOSS_PYTHON` / `CYBERBOSS_PYTHONW` | bridge + resident recipes | the interpreter running the recipe |
| `CYBERBOSS_NODE_EXE` | `bot-direct.cmd`, `s1-restack.ps1` | `node` from `PATH` |
| `CYBERBOSS_WECHAT_EXE` | WeChat restart recipes | `%ProgramFiles%\Tencent\Weixin\Weixin.exe` |
| `CYBERBOSS_ISOLATED_ACCOUNT_PASSWORD` | `rdp-autologin.py` | **none — the recipe refuses to run without it** |
| `CYBERBOSS_RDP_FILE` | `rdp-autologin.py` | `<queue root>\connect-cwinprobe.rdp` |
| `CYBERBOSS_LOG_DIR` | `rdp-autologin.py`, keepalive | `<queue root>\logs` |
| `CYBERBOSS_WEFLOW_UIA_TIMING_LOG` | `scripts/weflow-uia-bridge.py` | `<queue root>\bridge-timing.log` |
| `CYBERBOSS_TODESK_LOG_DIR` / `CYBERBOSS_GAMEVIEWER_LOG_DIR` | remote-control guard | `D:\Program Files\ToDesk\Logs`, `C:\Program Files\GameViewer\Logs` |
| `CYBERBOSS_QUARK_EXE` | `tools/quark-cli` | `D:\Tools\QuarkCloudDrive\quark_cloud_drive.exe` |

Rebuilding the Windows task set on a new machine:

```powershell
python scripts/isolated-session/register-tasks.py --show     # read back, change nothing
python scripts/isolated-session/register-tasks.py            # register/update all 11 tasks
python scripts/isolated-session/register-tasks.py --dry-run  # print the XML instead
```

It registers through `Schedule.Service` COM rather than `schtasks.exe`: this host hands console
creation to Windows Terminal, so a console child would flash a terminal window on the user's own
desktop. Registration needs no administrator rights (`InteractiveToken` + least privilege).

Why this matters:

- the first `cyberboss` command auto-generates `~/.cyberboss/weixin-instructions.md`
- if `CYBERBOSS_USER_NAME` and `CYBERBOSS_USER_GENDER` are missing, that generated persona file may start from the wrong assumptions

If you want the strongest "push" effect, do not immediately rewrite the persona template by hand. Let the agent develop its rhythm through real conversation first, then edit only the parts that are clearly wrong.

If you plan to use shared mode, set `CYBERBOSS_WORKSPACE_ROOT` before the first start so `shared:open` resolves the right thread for the right project.

If you use a local Codex provider such as Ollama, prefer a small wrapper script instead of putting provider flags directly into `CYBERBOSS_CODEX_COMMAND`. Copy [templates/codex-local-provider.sh](./templates/codex-local-provider.sh) to `${HOME}/.cyberboss/codex-local`, make it executable, and point Cyberboss at it:

```bash
cp ./templates/codex-local-provider.sh "${HOME}/.cyberboss/codex-local"
chmod +x "${HOME}/.cyberboss/codex-local"
```

```dotenv
CYBERBOSS_CODEX_COMMAND=/absolute/path/to/.cyberboss/codex-local
CYBERBOSS_CODEX_MODEL_PROVIDER=ollama
CYBERBOSS_CODEX_MODEL=gemma4:26b-32k
```

The template keeps cloud and local startup behavior in one command. When you switch back to the cloud provider, clear `CYBERBOSS_CODEX_MODEL_PROVIDER` and `CYBERBOSS_CODEX_MODEL`, then restart the shared bridge so the Codex app-server is launched with the new command environment.

Local Codex models also need model metadata. If `CYBERBOSS_CODEX_MODEL` points at a model that is not in Codex's built-in catalog, add a model catalog file in your Codex home and reference it from `~/.codex/config.toml`:

```toml
model_catalog_json = "/absolute/path/to/.codex/local-models.json"
```

Build that file from your existing Codex model catalog and add entries for your local model slugs, including the correct `context_window`, `max_context_window`, `input_modalities`, and truncation policy. Keep the cloud model entries in the catalog. Verify with `codex debug models`; Codex should list the local model and should not warn that it is using fallback metadata.

When `CYBERBOSS_RUNTIME=claudecode`, Cyberboss also upserts a workspace-local `.mcp.json` entry for `cyberboss_tools` before starting Claude, and launches Claude with that MCP config explicitly attached. That is how Claude discovers the Cyberboss project tools without any global registration.

### Personal-account channel (`weflow-uia`)

This channel sends by driving the WeChat desktop client through Windows UI Automation, and reads by querying a local WeFlow instance that indexes that client's message database. It is the only way to let the bot *start* a conversation, and it is also the most machine-bound part of the project — read this section before you enable it.

**What it needs**

1. **Windows host with an interactive desktop session.** The bridge activates the WeChat window and injects input, so it must run where a real input desktop exists. A service session (Session 0) cannot do it.
2. **A logged-in WeChat desktop client** on that machine, for the account the bot should speak as. Use a dedicated account, not your main one.
3. **A local WeFlow instance installed and answering on loopback**, exposing `/api/v1/health` and `/api/v1/messages` with a bearer token. The bot's read side is entirely this API. (WeFlow is a separate local app that indexes the WeChat desktop message database; it is not part of this repository.)
4. **Python 3.11+ with `pyperclip`, `uiautomation`, `pywin32` (`win32clipboard`), `Pillow`** — these are what `scripts/weflow-uia-bridge.py` imports. On this project's reference machine: `python -m pip install pyperclip uiautomation pywin32 pillow`.
5. **A writer bridge on `127.0.0.1`** (`CYBERBOSS_WEFLOW_BRIDGE_BASE_URL`). `npm run shared:start` starts `scripts/weflow-uia-bridge.py` for you when the channel is enabled and the interpreter is right; you can also run that file yourself.

**Why you may want to isolate it**

By default the bridge drives the desktop you are using, which means the bot can steal focus and the cursor while it sends. This project's reference deployment avoids that by running the WeChat client, WeFlow, and the bridge inside a *separate Windows interactive session* (a second Windows account plus a loopback RDP session), so the user's own desktop is never touched. That arrangement has its own hard constraints and is documented in [`docs/`](./docs) and `.agents/notes/implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md`; the helper recipes live in `scripts/isolated-session/`. **You do not need it to try the channel** — but if you dislike losing focus, plan for it.

**Enable it**

```dotenv
CYBERBOSS_ENABLE_WEFLOW_INBOX=true
CYBERBOSS_WEFLOW_TOKEN=<the same token your WeFlow instance requires>
CYBERBOSS_WEFLOW_BASE_URL=http://127.0.0.1:5051
CYBERBOSS_WEFLOW_BRIDGE_BASE_URL=http://127.0.0.1:8766
CYBERBOSS_WEFLOW_INBOX_CHATS=wxid_you,wxid_someone_else
CYBERBOSS_WEFLOW_INBOX_DISPLAY_NAME=you
# optional: interpreter for the bridge when `python` is not the right one
CYBERBOSS_WEFLOW_UIA_PYTHON=C:\path\to\python.exe
```

**Verify it without sending anything**

```bash
npm run doctor
```

`doctor` probes each channel read-only and exits non-zero if an enabled channel is not ready:

```json
{ "channel": "weflow-uia", "enabled": true, "ready": true, "reason": "", "detail": "reader=ok writer=ready foreground=1639902 desktopIdleSeconds=362" }
{ "channel": "ilink",      "enabled": true, "ready": true, "reason": "", "detail": "getconfig ok (read-only session check)" }
```

Common `reason` values and what they mean:

| `reason` | Meaning |
|---|---|
| `disabled` | the channel is not configured in this process (some `CYBERBOSS_WEFLOW_*` key is missing) |
| `reader-unreachable` / `reader-unhealthy` | WeFlow is not running, or not on `CYBERBOSS_WEFLOW_BASE_URL` |
| `reader-messages-failed` | WeFlow answers `/health` but its message query fails — the bot reads nothing. `-105` in the detail means the WCDB anchor state needs rebuilding, and a restart will not fix it |
| `writer-unreachable` / `writer-not-ready` | the bridge is down, or it cannot see a logged-in WeChat main window |
| `writer-desktop-unavailable` | the session lost its input desktop (typically a minimized/disconnected remote desktop client) |
| `no-paired-account` | the official channel has no saved account: run `npm run login` |
| `stale-token` | the official bot token looks stale; re-run `npm run login` |

Probing both channels is the default; `CYBERBOSS_ENABLED_CHANNELS=ilink` (or `weflow-uia`) narrows it when you are debugging one side. It is a debugging switch, not a required setting.

### Migrating an existing install to another machine

```bash
npm run migrate:list                       # what is unreproducible, what is just cache
npm run migrate:export -- --to E:\cb-migrate
# ... on the new machine, after clone + npm install:
npm run migrate:verify -- E:\cb-migrate    # sha256 check first
npm run migrate:import -- --from E:\cb-migrate
npm run doctor                             # exit code 0 == every enabled channel is ready
```

The exporter never includes `.env`; `accounts/*context-tokens.json` (a live bearer token for the official channel) is excluded unless you pass `--with-credentials`. Absolute workspace paths stored inside the runtime's thread bindings are rewritten on import. Full checklist, including what must be done by hand: [`docs/migrate-device.md`](./docs/migrate-device.md).

### Terminal commands for end users

- `npm run login`
  Log into WeChat and save the bot account locally
- `npm run accounts`
  List saved local accounts
- `npm run shared:start`
  Default startup path. Starts the shared runtime bridge and the shared WeChat bridge
- `npm run shared:open`
  Default attach path. Opens the bound shared thread in your terminal
- `npm run shared:status`
  Check the shared runtime process, shared bridge, and `readyz`
- `npm run doctor`
  Print the resolved config **and** a read-only readiness verdict for every enabled channel. Exit code 0 means every enabled channel can deliver; it never sends a message
- `npm run help`
  Show stable command entrypoints
- `npm run migrate:list` / `migrate:export` / `migrate:verify` / `migrate:import`
  Move the unreproducible state to another machine; see [Migrating an existing install](#migrating-an-existing-install-to-another-machine)
- `npm run verify-portable` / `npm run verify-portable:list`
  Static gate: the code trees must contain **no** machine-specific absolute paths. There is no
  allowlist — a literal is accepted only as the documented fallback of an environment lookup
  (`os.environ.get("CYBERBOSS_QUEUE_ROOT") or r"C:\ProgramData\cwin-probe"`), so a moved checkout
  and a new machine both keep working. Any other drive-rooted literal fails the gate.
- `npm run test:doctor` / `npm run test:migrate`
  Offline tests for the channel probes and the migration tool

Here, `checkin` means the random wake-up mechanism, not a fixed periodic reminder.

Switch the runtime with `CYBERBOSS_RUNTIME`. You do not need a different command set for Claude Code.

`npm run start` and `npm run start:checkin` are still useful for minimal local debugging, but they are not the recommended way to observe or debug the real shared bridge workflow.

### WeChat commands for end users

- `/bind /absolute/path`
  Bind the current chat to a project workspace
- `/status`
  Show current workspace, thread, model, and context state
- `/new`
  Move to a new thread draft
- `/reread`
  Reload the latest persona template and operations template into the current thread
- `/compact`
  Ask the current thread to compact its context. The bridge sends a start message and a completion message back to WeChat.
- `/switch <threadId>`
  Switch to a specific thread
- `/stop`
  Stop the current running turn
- `/checkin <min>-<max>`
  Update the proactive random check-in range for the current project
- `/chunk <number>`
  Adjust the minimum merge size for short WeChat reply chunks
- `/yes`
  Allow the current approval once
- `/always`
  Keep allowing the same kind of command inside the current project
- `/no`
  Reject the current approval
- `/model`
  Show current model
- `/model <id>`
  Switch model
- `/star`
  Show the GitHub star guide inside WeChat
- `/help`
  Show WeChat command help

Plain text messages go directly to the bound thread. If nothing is bound yet, bind a workspace first:

```text
/bind /absolute/path
```

### Observe the same thread from WeChat and terminal

If you want WeChat and your local terminal to stay attached to the same shared thread, use shared mode:

Terminal 1:

```bash
npm run shared:start
```

Keep it running in the foreground.

Terminal 2:

```bash
npm run shared:open
```

Useful diagnostics:

- `npm run shared:status`

Notes:

- Shared mode is the default mode in this README
- The same WeChat commands and day-to-day behavior apply under both Codex and Claude Code
- If `CYBERBOSS_RUNTIME=claudecode`, the local Claude window works best as a listener for the shared thread
- Do not let WeChat attach to a private spawned runtime if you expect terminal and WeChat to watch the same thread
- Do not keep multiple `cyberboss` bridge processes alive at the same time
- Do not put `npm run shared:start` in the background; it is the main shared bridge process

<a id="data-dir"></a>
## Local Data

The default state directory is:

```text
${HOME}/.cyberboss
```

Common contents:

- `accounts/`
  WeChat bot account data
- `sessions.json`
  workspace, thread, model, and approval state
- `weixin-config.json`
  WeChat reply chunk configuration
- `sync-buffers/`
  WeChat long-poll synchronization buffers
- `inbox/`
  saved incoming WeChat images and attachments
- `stickers/`
  sticker assets, including:
  - `assets/`
    saved sticker media, currently normalized to GIF
  - `index.json`
    sticker index mapping `stickerId -> { tags, desc }`
  - `tags.json`
    sticker tag catalog, editable by both the AI and the user
- `weixin-instructions.md`
  local persona file generated on first run
- `reminder-queue.json`
  reminder queue
- `system-message-queue.json`
  system / check-in queue
- `deferred-system-replies.json`
  replies waiting for the next usable WeChat context token
- `checkin-config.json`
  saved proactive check-in range
- `timeline-screenshot-queue.json`
  screenshot job queue
- `diary/`
  local diary files
- `timeline/`
  timeline data, site, and screenshots
- `logs/`
  shared bridge and shared runtime logs

This is the runtime state directory, not your project workspace. The WeChat thread and the terminal thread should still be opened against your actual project directory.

### Whereabouts Notes

- Cyberboss already bundles `whereabouts-mcp` and can ingest phone location, battery, and trigger context directly.
- To enable the built-in whereabouts server, configure at least:
  - `CYBERBOSS_ENABLE_LOCATION_SERVER=true`
  - `CYBERBOSS_LOCATION_TOKEN=<your_token>`
  - `CYBERBOSS_LOCATION_HOME_CENTER=lat,lng`
- Common optional variables:
  - `CYBERBOSS_LOCATION_HOST`
  - `CYBERBOSS_LOCATION_WORK_CENTER`
  - `CYBERBOSS_LOCATION_KNOWN_PLACES`
  - `CYBERBOSS_LOCATION_PLACE_RADIUS_METERS`
  - `CYBERBOSS_LOCATION_BATTERY_HISTORY_LIMIT`
- The built-in server listens on `http://0.0.0.0:4318` by default. The ingest endpoint is `POST /location/ingest`, and health checks use `GET /healthz`.
- Whereabouts data is stored in `${HOME}/.cyberboss/locations.json`, not in your project directory.

### Sticker Notes

- On the current WeChat bridge path, do not rely on animated playback for inbound or outbound stickers. A GIF may still show up as a static image in chat.
- Because of that, saved stickers are currently normalized to GIF at intake so the asset format is already aligned if WeChat later opens a fuller sticker capability.
- The tag catalog lives at `${HOME}/.cyberboss/stickers/tags.json`. The AI reads from it, and users can edit it directly.
- For now, sticker retrieval is tag-filtered only. There is no vector-database recall layer.

<a id="agent-guide"></a>
## Agent Guide

Agent-facing Cyberboss capabilities are project-native structured tools.

### Common project tools

- `cyberboss_reminder_create`
- `cyberboss_diary_append`
- `cyberboss_timeline_write`
- `cyberboss_timeline_build`
- `cyberboss_timeline_serve`
- `cyberboss_timeline_dev`
- `cyberboss_timeline_screenshot`
- `cyberboss_channel_send_file`
- `whereabouts_current_stay`
- `whereabouts_recent_stays`
- `whereabouts_recent_moves`
- `whereabouts_snapshot`
- `whereabouts_summary`
- `cyberboss_sticker_tags`
- `cyberboss_sticker_pick`
- `cyberboss_sticker_send`
- `cyberboss_sticker_delete`
- `cyberboss_sticker_save_from_inbox`
- `cyberboss_sticker_update`
- `cyberboss_system_send`

### Agent conventions

- Use Cyberboss project tools for diary, reminder, timeline, screenshot, and file-send operations
- Prefer documented lifecycle entrypoints from this README, `--help`, and [docs/commands.md](./docs/commands.md) for human terminal usage
- On first failure, report the concrete error before reading source code

## Docs

- [docs/commands.md](./docs/commands.md)

<a id="faq"></a>
## FAQ

### Why not `npm install cyberboss`?

Because the project is not published as an npm package yet. Clone the repo and run `npm install` inside it.

### What exactly is `checkin`?

`checkin` is the random wake-up mechanism. The system wakes the model at a random time and lets it decide whether to show up, stay silent, write data, or act.

### Why set user name and gender before the first run?

Because the first `cyberboss` command auto-generates `~/.cyberboss/weixin-instructions.md`. Setting `CYBERBOSS_USER_NAME` and `CYBERBOSS_USER_GENDER` first avoids obviously wrong persona assumptions in that file.

### Why not rewrite instructions aggressively from day one?

If you want the strongest "cyberboss" effect, let the agent grow its pacing through real interaction first. If you over-script it too early, it starts sounding like a workflow script instead of an active companion.

## License

This project is built for local-first personal deployment. It continuously processes private chat content, reminders, life traces, and other highly sensitive personal context. I do not want that workflow to be repackaged into a closed cloud service that hides both the code path and the data path from the user.

Because of that, this project is released under `AGPL-3.0-only`. If you modify it, extend it, and offer it to users over a network, you must provide the full corresponding source code under the AGPL terms.
