# The database inbound channel (`wechat-db`)

Read a personal WeChat account's own conversations **from its database**, without
WeFlow, without a UIA bridge, and without looking at the screen.

- reader: `scripts/wechat-db-inbox-read.py` (pure Python; vendored crypto in
  `scripts/wechat_db_reader/`)
- transport: `src/integrations/wechat-db/worker.js` (one long-lived child, JSON
  lines over stdio)
- source: `src/integrations/wechat-db/inbox.js` (poll, dedup, baseline, hand to
  the app)
- sending is unchanged: replies still go out through the CUA writer
  (`wechat-cua`), so this channel only replaces the *reader*.

## Why it exists

| reader | sees | costs |
| --- | --- | --- |
| WeFlow bridge | full rows, ids, direction | dead: its licence server stopped answering (`wcdb_init -1000`) |
| CUA screenshots | conversation rows only: one line per chat, truncated, direction inferred from pixels | ~150ms per driver call, and a foreground click to open a chat (`--deep-read`) |
| **this channel** | every message row: sender wxid, server id, full body, real direction, unread counts, chats nobody opened | ~1.3s cold, 5-50ms warm; zero foreground |

The CUA reader is kept for the case where the key cannot be extracted; the two
must not run at once (every message would arrive twice under two different ids
and be answered twice), so enabling this one skips the CUA inbox with a log line
saying why.

## Configuration

```ini
CYBERBOSS_ENABLE_WECHAT_DB_INBOX=true
CYBERBOSS_WECHAT_DB_KEY=<64 hex chars>
CYBERBOSS_WECHAT_DB_DIR=D:\xwechat_files        # parent of the wxid_* folders
CYBERBOSS_WECHAT_DB_WXID=wxid_ty69l7hjiqt012   # optional; the key decides if unset
CYBERBOSS_WECHAT_DB_INBOX_CHATS=wxid_...,filehelper,wxid_...
CYBERBOSS_WECHAT_DB_POLL_MS=2000               # optional
CYBERBOSS_WECHAT_DB_HISTORY_LIMIT=50           # optional
CYBERBOSS_WECHAT_DB_PYTHON=python              # optional
```

| variable | meaning |
| --- | --- |
| `CYBERBOSS_WECHAT_DB_INBOX_CHATS` | which conversations to read. Display names or wxids. Falls back to `CYBERBOSS_WEFLOW_INBOX_CHATS`/`_CHAT`; **empty means nobody**, never "everybody" |
| `CYBERBOSS_WECHAT_DB_KEY` | the account's database key. Required: without it the channel logs an error and stays off |
| `CYBERBOSS_WECHAT_DB_DIR` | the folder holding `wxid_*` account directories (`WECHAT_DATA_DIR`/`WXID` are also honoured) |
| `CYBERBOSS_WECHAT_DB_ACCOUNT_DIR` | pin the exact `wxid_xxx_abcd` directory |
| `CYBERBOSS_WECHAT_DB_REPLAY_ON_START` | default false: the first poll only establishes a baseline. Set true to answer the newest `CYBERBOSS_WECHAT_DB_REPLAY_LIMIT` incoming messages (default 20) after a boot |
| `CYBERBOSS_WECHAT_DB_CACHE_DIR` | where decrypted snapshots are written (default `$CYBERBOSS_STATE_DIR/wechat-db-cache`) |

Running more than one Cyberboss against the same account? Give each a different
`CYBERBOSS_WECHAT_DB_CACHE_DIR`: two processes writing the same snapshot files on
Windows collide (`WinError 5`).

### Where the key comes from

The key is derived from key material that lives in the **running** WeChat
process's memory; it is not in any file, and it changes when the account is
re-logged-in. Two ways to get it:

1. `wx-assist` (the fork, run from source): onboarding step 1 extracts it and
   writes `WCDB_KEY` into its `.env`. Copy that value.
2. Any memory-scan tool with the same routine. Cyberboss itself does **not**
   scan memory.

When the key no longer opens the database the channel says so explicitly
(`KeyMismatchError: 密钥与数据库不匹配`) instead of going quiet - see
"Failure modes" below.

## Operating it

```sh
# one snapshot, exactly what the app would read (no sending, no turn)
python scripts/wechat-db-inbox-read.py --chat 柳毓琳 --limit 5

# the whole chain as the app builds it (config -> worker -> reader -> source)
node scripts/wechat-db-read-probe.js
```

Startup lines to look for:

```
[cyberboss] wechat-db inbox enabled chats=[...] pollMs=2000 limit=50 replayOnStart=false
[cyberboss] wechat-db reader: [wechat-db] opened D:\xwechat_files\wxid_..._f2b4 (cache ...)
[cyberboss] wechat-db inbox stats polls=30 delivered=1 suppressed=2 deferred=0 errors=0 lastPollMs=37
[cyberboss] cua inbox skipped: the wechat-db inbox reads the same conversations with more detail
```

`suppressed` counts outgoing rows this bot sent (they are in the CUA echo
ledger). An outgoing row the ledger does **not** know is the operator typing in
the same account: it is delivered as `self_manual` and answered.

## Images

Images are delivered as real files, not as `[图片]`. The chain, all measured on
this machine on 2026-10-03:

1. the row's `packed_info_data` carries the image md5;
2. the file lives at `<account>/msg/attach/<md5(talker)>/<YYYY-MM>/Img/<md5><suffix>.dat`;
3. the `.dat` is WeChat's V2 container:
   `[07 08 'V2' 08 07][aes_size][xor_size][pad][AES-128-ECB][raw][XOR tail]`;
4. the AES key is **derived, not scanned**:
   `aes_key = md5(f"{uin}{wxid_base}")[:16]`, `xor_key = uin & 0xFF`, with `uin`
   read from the filenames in `%APPDATA%\Tencent\xwechat\net\kvcomm`;
5. the decoded file is written under `<cache>/media/` and handed to the app as an
   attachment, which persists it into `<state>/inbox/<date>/` and attaches it to
   the turn.

Suffix handling is the part that bites. `_t` is the **thumbnail** (measured
180x102 for a 720x240 original) and the bare name is sometimes a `wxgf` container
(WeChat's HEVC wrapper) whose first frame can be a **blank canvas**. So every
suffix is decoded, a directly-readable image always beats a container, `_h` is
preferred over the bare name, and a converted frame that is nearly uniform
(<0.01 bytes per pixel) is rejected. `wxgf` payloads are decoded with ffmpeg
(`-f hevc`, after cutting to the first NAL start code); without ffmpeg such a
message falls back to whichever suffix holds a plain image.

| setting | meaning |
| --- | --- |
| `CYBERBOSS_WECHAT_DB_IMAGE_KEY` | pin the AES key instead of deriving it (`CYBERBOSS_WECHAT_CLI_IMAGE_AES_KEY` is also honoured) |
| `CYBERBOSS_WECHAT_DB_IMAGE_XOR_KEY` | pin the XOR byte (`CYBERBOSS_WECHAT_CLI_IMAGE_XOR_KEY` is also honoured) |
| `CYBERBOSS_WECHAT_DB_FFMPEG` | ffmpeg path; default is whatever `ffmpeg` resolves to on `PATH` |

Voice, video and file attachments are **not** resolved yet: they arrive as their
placeholders (`[语音]`, `[视频]`, `[文件]`).

## Failure modes

| symptom | cause | what happens |
| --- | --- | --- |
| `CYBERBOSS_WECHAT_DB_KEY is empty` | not configured | the channel is off; the bot stays up on whatever else is enabled |
| `KeyMismatchError: 密钥与数据库不匹配` | account re-logged-in, key rotated | every poll logs the error; re-extract the key |
| `does not open any account on this machine` | the key belongs to the *other* WeChat account on this machine | set `CYBERBOSS_WECHAT_DB_WXID`, or use the right key |
| `reader exited (code=1 ...)` | Python missing a module (`pycryptodome`, `zstandard`) or a crash | polls fail loudly, the worker restarts after a 5s cooldown |
| `reader did not answer within 20000ms` | a stuck decrypt | the child is killed so the next poll starts clean |
| quiet chat, `stats` still ticking | genuinely nothing new | `delivered`/`suppressed` stay flat, `lastPollMs` moves |

## Tests

```sh
node --test test/wechat-db-inbox.test.js    # baseline, dedup, echo, deferral
node --test test/wechat-db-worker.test.js   # framing, correlation, restart, stop
node scripts/wechat-db-selfcheck.js 文件传输助手   # live: type -> read -> turn -> reply
```
