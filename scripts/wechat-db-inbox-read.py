#!/usr/bin/env python3
"""Read a filtered snapshot of local WeChat 4.x conversations, without the DLL.

Why this exists
---------------
The WeFlow bridge is dead (its cloud licence server stopped answering), and the
`wx-cli` reader cannot load a key on Windows. What is left is the database
itself: WeChat 4.x stores standard SQLCipher 4 files, so `db_crypto` +
`db_reader` (vendored under `scripts/wechat_db_reader/`, MIT, from the
wx-assist fork) can decrypt and query them with nothing but pycryptodome and
zstandard.

This script emits the SAME JSON contract as `wechat-cli-inbox-read.py`, so the
existing inbox source can consume it unchanged, plus a few honest extras a real
database row provides and a screenshot cannot: the peer's wxid, the sender's
wxid, the server id, and a direction that is read rather than guessed.

Two modes
---------
one shot:  --chat <wxid|display name> --limit N     -> one snapshot on stdout
serve:     --serve                                  -> JSON-lines request/response
           request  {"id":1,"cmd":"snapshot","chat":"...","limit":50}
           response {"id":1,"ok":true,"snapshot":{...}}
           also:   {"cmd":"sessions"} / {"cmd":"ping"} / {"cmd":"stop"}

Serve mode exists because a fresh process re-decrypts every page it touches;
keeping one process alive keeps the plaintext snapshot cache warm, so a poll
costs milliseconds instead of a full decrypt.

Secrets never leave this process: the key is used here and never echoed back.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Windows consoles default to a legacy code page, and one emoji in a display
# name (a real one: 「小窝👫」) then kills an otherwise healthy read with
# UnicodeEncodeError. Force UTF-8 on both streams before anything is printed.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from wechat_db_reader.content_codec import decompress_content  # noqa: E402
from wechat_db_reader.db_reader import WeChatDbReader  # noqa: E402

MAX_TEXT = 8000
MAX_TITLE = 500
MAX_URL = 2000

#: local_type -> kind, for the types Cyberboss actually renders.
KIND_BY_TYPE = {
    1: "text",
    3: "image",
    34: "voice",
    43: "video",
    47: "emoji",
    48: "unknown",
    49: "link",
    50: "call",
    10000: "system",
}

PLACEHOLDER = {
    "image": "[图片]",
    "voice": "[语音]",
    "video": "[视频]",
    "file": "[文件]",
    "emoji": "[表情]",
    "call": "[通话]",
    "link": "[链接]",
    "system": "",
    "unknown": "",
}


def log(message: str) -> None:
    print(f"[wechat-db] {message}", file=sys.stderr, flush=True)


def clean(value: object, limit: int = MAX_TEXT, *, keep_newlines: bool = False) -> str:
    text = str(value if value is not None else "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not keep_newlines:
        text = " ".join(text.split())
    else:
        text = "\n".join(line.rstrip() for line in text.split("\n")).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def int_value(value: object, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def base_type_of(local_type: int) -> int:
    return int_value(local_type) & 0xFFFFFFFF


def xml_root(content: str):
    text = str(content or "").strip()
    if not text:
        return None
    try:
        return ET.fromstring(text)
    except ET.ParseError:
        return None


def xml_text(node, path: str) -> str:
    if node is None:
        return ""
    return clean(node.findtext(path) or "", MAX_TEXT, keep_newlines=True)


def parse_app_message(content: str) -> dict:
    """Parse an appmsg payload (links, files, quotes, merged forwards)."""
    root = xml_root(content)
    appmsg = root.find(".//appmsg") if root is not None else None
    if appmsg is None:
        return {"app_type": 0, "title": "", "description": "", "url": "", "appmsg": None}
    return {
        "app_type": int_value(xml_text(appmsg, "type")),
        "title": clean(xml_text(appmsg, "title"), MAX_TITLE),
        "description": clean(xml_text(appmsg, "des"), MAX_TEXT, keep_newlines=True),
        "url": clean(xml_text(appmsg, "url"), MAX_URL),
        "appmsg": appmsg,
    }


def parse_refermsg(appmsg) -> list[dict]:
    """The quoted message inside a type-57 appmsg, in Cyberboss's shape."""
    if appmsg is None:
        return []
    ref = appmsg.find(".//refermsg")
    if ref is None:
        return []
    ref_type = int_value(xml_text(ref, "type"))
    ref_content = ref.findtext("content") or ""
    display_name = clean(xml_text(ref, "displayname"), MAX_TITLE)
    kind = KIND_BY_TYPE.get(base_type_of(ref_type), "unknown")
    text = ""
    title = ""
    url = ""
    if base_type_of(ref_type) == 1:
        text = clean(decompress_content(ref_content))
    elif base_type_of(ref_type) == 49:
        parsed = parse_app_message(ref_content)
        kind = "file" if int_value(parsed.get("app_type")) == 6 else "link"
        title = parsed.get("title") or display_name
        text = parsed.get("description") or parsed.get("title") or ""
        url = parsed.get("url") or ""
    elif kind in {"image", "voice", "video", "file"}:
        title = display_name or PLACEHOLDER.get(kind, "")
    else:
        text = clean(decompress_content(ref_content))
    return [{
        "kind": kind,
        "title": title,
        "text": clean(text),
        "url": url,
        "attachmentRefs": [],
    }]


def strip_group_prefix(content: str) -> str:
    """Group rows are stored as `wxid:\\n文本`; the real sender is already known."""
    return re.sub(r"^[A-Za-z0-9_@.\-]+:\n?", "", content, count=1)


def summarize_message(row: dict, my_wxid: str, talker: str) -> dict:
    """One database row -> the snapshot message Cyberboss consumes."""
    local_id = int_value(row.get("local_id"))
    local_type = int_value(row.get("local_type"))
    create_time = int_value(row.get("create_time"))
    server_id = row.get("server_id")
    raw = decompress_content(str(row.get("content") or ""))
    base_type = base_type_of(local_type)
    kind = KIND_BY_TYPE.get(base_type, "unknown")
    text = ""
    title = ""
    url = ""
    quoted = []

    if base_type == 1:
        text = clean(strip_group_prefix(raw), MAX_TEXT, keep_newlines=True)
    elif base_type == 49:
        parsed = parse_app_message(raw)
        app_type = int_value(parsed.get("app_type"))
        kind = "file" if app_type == 6 else "link"
        title = parsed.get("title") or ""
        url = parsed.get("url") or ""
        appmsg = parsed.get("appmsg")
        if app_type == 57:
            quoted = parse_refermsg(appmsg)
            text = title or clean(parsed.get("description"))
        elif app_type == 19:
            text = "\n".join(filter(None, [
                f"[合并转发] {title}" if title else "[合并转发]",
                parsed.get("description") or "",
            ])).strip()
        elif kind == "file":
            text = "" if title else "[文件]"
        else:
            text = "\n".join(filter(None, [
                f"[链接] {title}" if title else "[链接]",
                url,
                parsed.get("description") or "",
            ])).strip()
    elif base_type == 10000:
        text = clean(raw, MAX_TEXT, keep_newlines=True)
    elif base_type in {3, 34, 43, 47, 50}:
        # No media resolution yet: the row names the kind, and the placeholder
        # keeps the turn honest instead of silently empty.
        text = PLACEHOLDER.get(kind, "")
    else:
        text = clean(raw, MAX_TEXT, keep_newlines=True) or PLACEHOLDER.get(kind, "")

    sender = str(row.get("sender_username") or "")
    is_group = talker.endswith("@chatroom")
    outgoing = bool(my_wxid and sender == my_wxid)
    if not is_group and not outgoing:
        # A one-to-one row whose sender is not us is the peer by construction.
        outgoing = False

    stable = "|".join([
        talker,
        str(local_id),
        str(local_type),
        str(create_time),
        str(server_id or ""),
    ])
    return {
        "id": hashlib.sha256(stable.encode("utf-8")).hexdigest()[:32],
        "localId": local_id,
        "serverId": str(server_id or ""),
        "timestamp": create_time,
        "receivedAt": datetime.fromtimestamp(create_time).astimezone().isoformat()
        if create_time else datetime.now().astimezone().isoformat(),
        "direction": "outgoing" if outgoing else "incoming",
        "kind": kind,
        "title": title,
        "text": text,
        "url": url,
        "quotedContexts": quoted,
        "attachments": [],
        # Extra fields the CLI contract never had; a database row knows them.
        "talker": talker,
        "senderId": sender,
        "isGroup": is_group,
        "localType": local_type,
    }


class SnapshotReader:
    """One decrypted account, queried on demand. Safe to keep alive."""

    def __init__(self, account_dir: str, key: str, cache_dir: str = "", my_wxid: str = ""):
        self.account_dir = Path(account_dir)
        self.key = key
        self.cache_dir = cache_dir
        self._wxid = my_wxid
        self._reader: WeChatDbReader | None = None
        self._sessions: list[dict] = []
        self._sessions_at = 0.0
        self._failed = ""

    # ── lifecycle ───────────────────────────────────────────────────

    def open(self) -> None:
        if self._reader is not None:
            return
        cache_dir = self.cache_dir or str(Path(tempfile_root()) / "cyberboss-wechat-db")
        self._reader = WeChatDbReader(self.account_dir, self.key, cache_dir=cache_dir)
        self._reader.set_my_wxid(self._my_wxid())
        log(f"opened {self.account_dir} (cache {cache_dir})")

    def _my_wxid(self) -> str:
        if self._wxid:
            return self._wxid
        name = self.account_dir.name
        # Account directories are `wxid_xxx_abcd`; the wxid is everything before
        # the per-install suffix. Same rule the WeChat 4.x tooling uses.
        self._wxid = name.rsplit("_", 1)[0] if name.count("_") > 1 else name
        return self._wxid

    def close(self) -> None:
        if self._reader is not None:
            try:
                self._reader.close()
            except Exception:  # noqa: BLE001
                pass
            self._reader = None

    # ── queries ─────────────────────────────────────────────────────

    def sessions(self, *, max_age: float = 2.0) -> list[dict]:
        now = time.monotonic()
        if self._sessions and (now - self._sessions_at) < max_age:
            return self._sessions
        self.open()
        self._sessions = self._reader.get_sessions(limit=1000)
        self._sessions_at = now
        return self._sessions

    def resolve_chat(self, want: str) -> dict:
        """Accept a wxid or a display name and return the session row."""
        target = str(want or "").strip()
        if not target:
            raise ValueError("chat is required")
        sessions = self.sessions()
        for row in sessions:
            if row.get("username") == target:
                return row
        lowered = target.lower()
        for row in sessions:
            names = [
                row.get("display_name"), row.get("displayName"),
                row.get("nickname"), row.get("displayname"),
            ]
            if any(str(name or "").strip().lower() == lowered for name in names):
                return row
        for row in sessions:
            if str(row.get("summary") or "").strip() == target:
                return row
        raise ValueError(f"chat not found in this account: {target}")

    def snapshot(self, chat: str, limit: int) -> dict:
        self.open()
        session = self.resolve_chat(chat)
        talker = str(session.get("username") or "")
        rows = self._reader.get_messages(talker, limit=limit)
        messages = [summarize_message(row, self._my_wxid(), talker) for row in rows]
        messages.sort(key=lambda item: (item["timestamp"], item["localId"], item["id"]))
        display = str(session.get("display_name") or session.get("displayName") or "")
        return {
            "chat": display or talker,
            "chatUsername": talker,
            "talker": talker,
            "displayName": display,
            "unread": int_value(session.get("unread_count")),
            "messages": messages,
            "failures": [],
        }

    def snapshots(self, chats: list[str], limit: int) -> dict:
        out = []
        failures = []
        for chat in chats:
            try:
                out.append(self.snapshot(chat, limit))
            except Exception as error:  # noqa: BLE001
                failures.append(f"{chat}: {error}")
        return {"chats": out, "failures": failures}


def tempfile_root() -> str:
    base = os.environ.get("CYBERBOSS_STATE_DIR") or os.path.join(
        os.path.expanduser("~"), ".cyberboss"
    )
    return os.path.join(base, "wechat-db-cache")


def account_dirs(base_dir: str) -> list[Path]:
    """Every `wxid_xxx_abcd` directory under the given (or default) data root."""
    roots: list[Path] = []
    if base_dir:
        roots.append(Path(base_dir))
    else:
        home = Path(os.path.expanduser("~"))
        roots.extend([
            home / "Documents" / "xwechat_files",
            home / "Documents" / "WeChat Files",
            Path("D:/xwechat_files"),
        ])
    found: list[Path] = []
    for root in roots:
        if not root.is_dir():
            continue
        if (root / "db_storage" / "session" / "session.db").exists():
            found.append(root)
        for entry in sorted(root.iterdir()):
            if entry.is_dir() and entry.name.startswith("wxid_"):
                if (entry / "db_storage" / "session" / "session.db").exists():
                    found.append(entry)
    return found


def locate_account(base_dir: str, wxid: str, key: str = "") -> Path:
    """Find the account directory whose databases THIS key opens.

    A machine can hold several WeChat accounts (this one has two). Picking the
    first `wxid_*` directory therefore hands back an account the key does not
    belong to, and every read fails with a mismatch that looks like a bad key.
    So: honour an explicit wxid, otherwise let the key decide.
    """
    dirs = account_dirs(base_dir)
    if not dirs:
        raise FileNotFoundError(
            f"no WeChat account directory found under {base_dir or 'the default locations'}"
        )
    if wxid:
        for entry in dirs:
            if entry.name == wxid or entry.name.startswith(wxid):
                return entry
        raise FileNotFoundError(f"account {wxid} not found among {[d.name for d in dirs]}")
    if key:
        from wechat_db_reader import db_crypto  # local import: only needed here

        try:
            material = db_crypto.parse_key(key)
        except Exception as error:  # noqa: BLE001
            raise RuntimeError(f"CYBERBOSS_WECHAT_DB_KEY is not a usable key: {error}") from error
        for entry in dirs:
            session_db = entry / "db_storage" / "session" / "session.db"
            try:
                if db_crypto.verify_key(material, session_db):
                    return entry
            except Exception:  # noqa: BLE001
                continue
        raise RuntimeError(
            "CYBERBOSS_WECHAT_DB_KEY does not open any account on this machine "
            f"(tried {[d.name for d in dirs]}); re-extract the key from the running WeChat"
        )
    return dirs[0]


def build_reader(args) -> SnapshotReader:
    key = (args.key or os.environ.get("CYBERBOSS_WECHAT_DB_KEY") or "").strip()
    if not key:
        raise RuntimeError(
            "CYBERBOSS_WECHAT_DB_KEY is required (64 hex chars, extracted from a "
            "running WeChat; see docs/wechat-db-inbox.md)"
        )
    base_dir = (args.data_dir or os.environ.get("CYBERBOSS_WECHAT_DB_DIR")
                or os.environ.get("WECHAT_DATA_DIR") or "").strip()
    wxid = (args.wxid or os.environ.get("CYBERBOSS_WECHAT_DB_WXID")
            or os.environ.get("WXID") or "").strip()
    account_dir = args.account_dir or os.environ.get("CYBERBOSS_WECHAT_DB_ACCOUNT_DIR") or ""
    account = Path(account_dir) if account_dir else locate_account(base_dir, wxid, key)
    cache_dir = (args.cache_dir or os.environ.get("CYBERBOSS_WECHAT_DB_CACHE_DIR") or "").strip()
    return SnapshotReader(str(account), key, cache_dir=cache_dir, my_wxid=args.self_wxid or "")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chat", default="")
    parser.add_argument("--chats", default="")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--key", default="")
    parser.add_argument("--data-dir", default="")
    parser.add_argument("--wxid", default="")
    parser.add_argument("--account-dir", default="")
    parser.add_argument("--cache-dir", default="")
    parser.add_argument("--self-wxid", default="")
    return parser.parse_args(argv)


def serve(reader: SnapshotReader) -> int:
    """JSON-lines loop; one request per line, one response per line."""
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            request = json.loads(raw)
        except json.JSONDecodeError as error:
            print(json.dumps({"ok": False, "error": f"bad request json: {error}"}), flush=True)
            continue
        request_id = request.get("id")
        command = str(request.get("cmd") or "snapshot")
        try:
            if command == "ping":
                payload = {"ok": True, "pong": True, "pid": os.getpid()}
            elif command == "sessions":
                payload = {"ok": True, "sessions": [
                    {
                        "username": row.get("username"),
                        "displayName": row.get("display_name") or row.get("displayName"),
                        "unread": int_value(row.get("unread_count")),
                        "lastTimestamp": int_value(row.get("last_timestamp")),
                    }
                    for row in reader.sessions(max_age=0)
                ]}
            elif command == "snapshot":
                limit = max(1, min(500, int_value(request.get("limit"), 50)))
                payload = {"ok": True, "snapshot": reader.snapshot(str(request.get("chat") or ""), limit)}
            elif command == "snapshots":
                chats = request.get("chats") if isinstance(request.get("chats"), list) else []
                limit = max(1, min(500, int_value(request.get("limit"), 50)))
                payload = {"ok": True, **reader.snapshots([str(c) for c in chats], limit)}
            elif command == "stop":
                print(json.dumps({"id": request_id, "ok": True}), flush=True)
                return 0
            else:
                payload = {"ok": False, "error": f"unknown command: {command}"}
        except Exception as error:  # noqa: BLE001
            payload = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        payload["id"] = request_id
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    return 0


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    reader = build_reader(args)
    if args.serve:
        return serve(reader)
    chats = [item for item in (args.chats or args.chat).split(",") if item.strip()]
    if not chats:
        raise SystemExit("--chat or --chats is required (or use --serve)")
    limit = max(1, min(500, int_value(args.limit, 50)))
    if len(chats) == 1:
        snapshot = reader.snapshot(chats[0], limit)
        print(json.dumps(snapshot, ensure_ascii=False))
        return 0
    print(json.dumps(reader.snapshots(chats, limit), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        print(f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
