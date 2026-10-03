# Vendored: pure-Python WeChat 4.x database reader

These files are **not written here**. They are copied verbatim from the
`wx-assist` project's fork (`CaptainUnhappy/wx-assist-SafeFork`, branch `master`,
`src/wechat/`), which replaced the closed-source `lib/wcdb_api.dll` (WeFlow) with
a pure-Python SQLCipher 4 reader after that DLL's cloud licence service stopped
answering (`wcdb_init` returns `-1000`).

| file | what it does |
| --- | --- |
| `db_crypto.py` | key parsing, PBKDF2-HMAC-SHA512 key derivation, per-page AES-CBC decryption, WAL merge, plaintext snapshot cache |
| `db_reader.py` | the query layer: sessions, messages (across `message_N.db` shards), contacts, display names, media lookup |
| `content_codec.py` | zstd/hex message-body decoding |

Licence: MIT (`Copyright (c) 2025-2026 cancelGuMu`), compatible with this
repository. The upstream `LICENSE` file governs these three files.

Why vendored rather than installed: the upstream is a desktop application, not a
library, and the reader is the one part of it that has to be callable from a
Cyberboss script. Keeping the files byte-identical makes re-syncing with upstream
a `diff` instead of a merge.

Requirements: Python 3.9+ with `pycryptodome` and `zstandard`
(`python -m pip install pycryptodome zstandard`).

Used by `scripts/wechat-db-inbox-read.py`; see `docs/wechat-db-inbox.md`.
