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
import shutil
import subprocess
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


# ── images ──────────────────────────────────────────────────────────────
#
# WeChat 4.x keeps chat images as `<md5>.dat` under
# `msg/attach/<md5(talker)>/<YYYY-MM>/Img/`, encrypted with the same V2 scheme
# the cache files use:
#
#   [6B 07 08 'V2' 08 07] [4B aes_size LE] [4B xor_size LE] [1B pad]
#   [PKCS7-aligned AES-128-ECB block] [raw] [xor_size bytes XORed with uin & 0xFF]
#
# and the AES key is DERIVED, not scanned:
#
#   aes_key = md5(f"{uin}{wxid_base}")[:16]      uin from the filenames in
#   xor_key = uin & 0xFF                         %APPDATA%\Tencent\xwechat\net\kvcomm
#
# Verified on this machine 2026-10-03: a real message's `_t` file decrypts to a
# 1280x1355 JPEG. The full-size file can be a `wxgf` container (WeChat's HEVC
# wrapper) instead, which only ffmpeg can turn into a picture, so the suffixes
# are tried in order and the first one a model can actually read wins.

V2_MAGIC = b"\x07\x08V2\x08\x07"
V1_MAGIC = b"\x07\x08V1\x08\x07"
V1_AES_KEY = "cfcd208495d565ef"  # md5("0")[:16], the fixed V1 key

IMAGE_MAGIC = (
    (b"\xff\xd8\xff", ".jpg"),
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"GIF8", ".gif"),
    (b"RIFF", ".webp"),
    (b"BM", ".bmp"),
    (b"wxgf", ".hevc"),
)

IMAGE_TAIL = {
    ".jpg": b"\xff\xd9",
    ".png": b"IEND\xaeB\x60\x82",
    ".gif": b"\x3b",
}


def _image_extension(header: bytes) -> str:
    for magic, extension in IMAGE_MAGIC:
        if header.startswith(magic):
            return extension
    return ""


def _infer_xor_key(tail: bytes, extension: str):
    """Recover the XOR byte from the file's own end marker."""
    marker = IMAGE_TAIL.get(extension)
    if not marker or len(tail) < len(marker):
        return None
    chunk = tail[-len(marker):]
    key = chunk[0] ^ marker[0]
    if all((chunk[index] ^ key) == marker[index] for index in range(len(marker))):
        return key
    return None


def _looks_complete(decoded: bytes, extension: str) -> bool:
    """Soft check: is the format's end marker somewhere in the last stretch?"""
    marker = IMAGE_TAIL.get(extension)
    if not marker:
        return True
    return marker in decoded[-64:]


def _is_blank_png(path: Path, min_bytes_per_pixel: float = 0.01) -> bool:
    """Is this PNG an (almost) uniform canvas?

    Measured 2026-10-03: a wxgf original decoded to a 1280x1356 PNG of 4526
    bytes - 0.0026 bytes per pixel, i.e. an empty frame. Real pictures of any
    content land far above 1%.
    """
    try:
        data = path.read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            return False
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        pixels = width * height
        if pixels <= 0:
            return False
        return (len(data) / pixels) < min_bytes_per_pixel
    except OSError:
        return False


def derive_image_keys(account_name: str) -> list:
    """Candidate (aes_key, xor_key) pairs for this account."""
    wxid_base = account_name.rsplit("_", 1)[0] if account_name.count("_") > 1 else account_name
    uins = []
    kvcomm = Path(os.environ.get("APPDATA", "")) / "Tencent" / "xwechat" / "net" / "kvcomm"
    if kvcomm.is_dir():
        for entry in kvcomm.iterdir():
            for pattern in (r"key_0_(\d{9,11})_", r"key_(\d{9,11})_\d+_", r"monitordata_(\d{9,11})_"):
                match = re.search(pattern, entry.name)
                if match:
                    uins.append(int(match.group(1)))
    return [
        (hashlib.md5(f"{uin}{wxid_base}".encode("utf-8")).hexdigest()[:16], uin & 0xFF)
        for uin in dict.fromkeys(uins)
    ]


class MediaResolver:
    """Turn an image row's md5 into a file a model can actually look at."""

    def __init__(self, account_dir: Path, cache_dir: Path, aes_key: str = "", xor_key: int = -1,
                 ffmpeg: str = ""):
        self.account_dir = Path(account_dir)
        self.cache_dir = Path(cache_dir) / "media"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.extra_key = (aes_key.strip(), xor_key) if aes_key.strip() else None
        self.ffmpeg = ffmpeg or os.environ.get("CYBERBOSS_WECHAT_DB_FFMPEG", "") or shutil.which("ffmpeg") or ""
        self._keys = None
        self.stats = {"resolved": 0, "missing": 0, "keyFailures": 0, "ffmpeg": 0, "lastReason": ""}

    def keys(self):
        if self._keys is None:
            candidates = []
            if self.extra_key:
                candidates.append(self.extra_key)
            candidates.extend(derive_image_keys(self.account_dir.name))
            self._keys = candidates
        return self._keys

    def decode_dat(self, data: bytes):
        """Decrypt a `.dat` payload -> (bytes, extension), or (b"", "") when it cannot."""
        if data[:6] == V1_MAGIC:
            keys = [(V1_AES_KEY, -1)]
        elif data[:6] == V2_MAGIC:
            keys = self.keys()
        else:
            extension = _image_extension(data)
            return (data, extension) if extension else (b"", "")
        if not keys:
            return b"", ""

        aes_size = int.from_bytes(data[6:10], "little")
        xor_size = int.from_bytes(data[10:14], "little")
        # PKCS7 always pads, even a block-aligned payload, so the AES section is
        # aes_size rounded up plus one full block; `aes_size` itself is the real
        # plaintext length.
        aligned = aes_size + (16 - aes_size % 16 if aes_size % 16 else 16)
        aes_start = 15
        body_start = aes_start + aligned
        tail_start = len(data) - xor_size
        if aes_size <= 0 or xor_size < 0 or tail_start < body_start:
            return b"", ""

        ciphertext = data[aes_start:body_start]
        raw = data[body_start:tail_start]      # unencrypted middle section
        tail = data[tail_start:]               # XOR-encrypted end
        for aes_key, xor_key in keys:
            try:
                from Crypto.Cipher import AES

                plain = AES.new(aes_key.encode("ascii"), AES.MODE_ECB).decrypt(ciphertext)
            except Exception as error:  # noqa: BLE001
                log(f"image key {aes_key} unusable: {error}")
                continue
            plain = plain[:aes_size]
            extension = _image_extension(plain)
            if not extension:
                continue
            attempts = []
            if xor_key >= 0:
                attempts.append(xor_key)
            inferred = _infer_xor_key(tail, extension)
            if inferred is not None and inferred not in attempts:
                attempts.append(inferred)
            attempts.append(0x88)  # the long-standing default
            fallback = b""
            for key in attempts:
                decoded = plain + raw + bytes(byte ^ key for byte in tail)
                if not fallback:
                    fallback = decoded
                if _looks_complete(decoded, extension):
                    return decoded, extension
            # The AES header proves the key; WeChat sometimes ends a payload
            # without the format's final marker, so a missing one is not a
            # reason to throw away a picture that decodes fine.
            return fallback, extension
        return b"", ""

    def resolve_image(self, md5: str, talker: str, create_time: int):
        """Locate, decrypt and cache one image -> (path, failure reason).

        Suffix order matters and is NOT the order it looks like: `_t` is the
        thumbnail (measured 2026-10-03: 180x102 for a 720x240 original), so the
        full-size file is tried first and the thumbnail is the last resort. The
        full-size file is sometimes a `wxgf` container instead of a picture,
        which is what ffmpeg is for.
        """
        if not md5 or len(md5) != 32:
            self.stats["missing"] += 1
            self.stats["lastReason"] = "the row carries no image id"
            return "", self.stats["lastReason"]
        folder = self.account_dir / "msg" / "attach" / hashlib.md5(talker.encode("utf-8")).hexdigest()
        if not folder.is_dir():
            self.stats["missing"] += 1
            self.stats["lastReason"] = "no media folder for this chat"
            return "", self.stats["lastReason"]
        months = []
        if create_time:
            months.append(datetime.fromtimestamp(create_time).strftime("%Y-%m"))
        months.extend(entry.name for entry in folder.iterdir() if entry.is_dir() and entry.name not in months)
        # `_h` first, then the bare name, then the thumbnail. Measured 2026-10-03:
        # for one message `_h` was the 690KB full picture while the bare name was
        # a wxgf container whose HEVC frame decodes to a blank 1280x1356 canvas;
        # for another the bare name was the good one. So every suffix is decoded,
        # a real image always beats a container, and a blank frame is rejected.
        decoded_by_suffix = {}
        saw_wxgf = False
        for suffix in ("_h", "", "_t"):
            for month in months:
                candidate = folder / month / "Img" / f"{md5}{suffix}.dat"
                if not candidate.is_file():
                    continue
                # Reuse an earlier decode of this exact file, so a two-second
                # poll does not re-decrypt (and re-run ffmpeg on) every picture
                # in the window over and over.
                for extension in (".png", ".jpg", ".gif", ".webp", ".bmp"):
                    cached = self.cache_dir / f"{md5}{suffix}{extension}"
                    if cached.is_file() and cached.stat().st_mtime >= candidate.stat().st_mtime:
                        return str(cached), ""
                try:
                    data = candidate.read_bytes()
                except OSError as error:
                    log(f"image {candidate.name} unreadable: {error}")
                    continue
                decoded, extension = self.decode_dat(data)
                if not decoded:
                    self.stats["keyFailures"] += 1
                    self.stats["lastReason"] = "no image key decrypted this file"
                    continue
                decoded_by_suffix[suffix] = (decoded, extension)
                saw_wxgf = saw_wxgf or extension == ".hevc"
                break

        for suffix in ("_h", "", "_t"):
            entry = decoded_by_suffix.get(suffix)
            if not entry or entry[1] == ".hevc":
                continue
            decoded, extension = entry
            out = self.cache_dir / f"{md5}{suffix}{extension}"
            out.write_bytes(decoded)
            self.stats["resolved"] += 1
            self.stats["lastReason"] = ""
            return str(out), ""

        for suffix in ("_h", "", "_t"):
            entry = decoded_by_suffix.get(suffix)
            if not entry or entry[1] != ".hevc":
                continue
            converted = self._convert_wxgf(entry[0], md5, suffix)
            if converted:
                self.stats["resolved"] += 1
                self.stats["ffmpeg"] += 1
                self.stats["lastReason"] = ""
                return converted, ""

        self.stats["missing"] += 1
        if saw_wxgf:
            self.stats["lastReason"] = "the image is a wxgf (HEVC) container and ffmpeg could not decode it"
        else:
            self.stats["lastReason"] = self.stats["lastReason"] or "no readable image file on disk"
        return "", self.stats["lastReason"]

    def _convert_wxgf(self, payload: bytes, md5: str, suffix: str) -> str:
        """Decode a wxgf (HEVC) payload with ffmpeg.

        The payload is not a file ffmpeg recognises: it is a WeChat header plus a
        raw HEVC stream (the first NAL start code sits ~33 bytes in). Feeding the
        `.dat` itself to ffmpeg fails with "could not find codec parameters" -
        measured 2026-10-03.
        """
        if not self.ffmpeg:
            return ""
        body = payload
        for marker in (b"\x00\x00\x00\x01", b"\x00\x00\x01"):
            index = body.find(marker)
            if index > 0:
                body = body[index:]
                break
        source = self.cache_dir / f"{md5}{suffix}.hevc"
        out = self.cache_dir / f"{md5}{suffix}.png"
        try:
            source.write_bytes(body)
            result = subprocess.run(
                [self.ffmpeg, "-y", "-loglevel", "error", "-f", "hevc", "-i", str(source),
                 "-frames:v", "1", str(out)],
                capture_output=True,
                timeout=60,
            )
            if result.returncode == 0 and out.is_file() and out.stat().st_size > 0:
                if _is_blank_png(out):
                    # A HEVC stream whose first frame is an empty canvas: worse
                    # than the thumbnail, so let the caller try the next suffix.
                    log(f"ffmpeg decoded {source.name} to a blank frame; trying another suffix")
                    out.unlink(missing_ok=True)
                    return ""
                return str(out)
            log(f"ffmpeg could not decode {source.name}: "
                + result.stderr.decode("utf-8", "replace")[:160])
        except Exception as error:  # noqa: BLE001
            log(f"ffmpeg failed for {source.name}: {error}")
        return ""


def summarize_message(row: dict, my_wxid: str, talker: str, media: "MediaResolver | None" = None) -> dict:
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
        # The row names the kind. For an image we then try to put a real file on
        # disk, because "[图片]" is exactly the answer the operator complained
        # about: measured 2026-10-02, the bot told the user it "only got the two
        # characters 图片" while the picture sat decryptable on the same machine.
        text = PLACEHOLDER.get(kind, "")
    else:
        text = clean(raw, MAX_TEXT, keep_newlines=True) or PLACEHOLDER.get(kind, "")

    attachments = []
    if kind == "image" and media is not None:
        packed_hex = str(row.get("packed_info_data") or "")
        packed = bytes.fromhex(packed_hex) if packed_hex else b""
        match = re.search(rb"[0-9a-fA-F]{32}", packed)
        md5 = match.group(0).decode("ascii").lower() if match else ""
        path, reason = media.resolve_image(md5, talker, create_time)
        if path:
            attachments.append({
                "kind": "image",
                "path": path,
                "fileName": os.path.basename(path),
                "origin": "direct",
                "attachmentRef": f"direct-{local_id}-1",
            })
            text = ""
        else:
            # Say WHY, in the message itself: an operator who sees only "[图片]"
            # cannot tell "the peer sent nothing" from "we lost it".
            text = f"{PLACEHOLDER.get(kind, '[图片]')}（本地文件未取到：{reason}）"

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
        "attachments": attachments,
        # Extra fields the CLI contract never had; a database row knows them.
        "talker": talker,
        "senderId": sender,
        "isGroup": is_group,
        "localType": local_type,
    }


class SnapshotReader:
    """One decrypted account, queried on demand. Safe to keep alive."""

    def __init__(self, account_dir: str, key: str, cache_dir: str = "", my_wxid: str = "",
                 image_key: str = "", image_xor_key: int = -1, ffmpeg: str = "",
                 chat_cache_sec: float = 600.0):
        self.account_dir = Path(account_dir)
        self.key = key
        self.cache_dir = cache_dir
        self._wxid = my_wxid
        self._reader: WeChatDbReader | None = None
        self._sessions: list[dict] = []
        self._sessions_at = 0.0
        self._failed = ""
        # Resolving a chat (wxid + display name) needs session.db AND contact.db,
        # and each of those is re-decrypted whenever WeChat touches it - which it
        # does on every message, because the unread badge and the row summary
        # change. Measured 2026-10-03: a poll that re-decrypted all three files
        # cost 3-5s, which is what made "处理中" arrive seconds late. A chat's
        # identity does not change between polls, so it is cached and the steady
        # state only touches the message shard.
        self._chat_cache: dict[str, tuple] = {}
        self._chat_cache_sec = chat_cache_sec
        self._timing = os.environ.get("CYBERBOSS_WECHAT_DB_TIMING") == "1"
        self.media = MediaResolver(
            self.account_dir,
            Path(cache_dir) if cache_dir else Path(tempfile_root()) / "cyberboss-wechat-db",
            aes_key=image_key,
            xor_key=image_xor_key,
            ffmpeg=ffmpeg,
        )

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
        """Accept a wxid or a display name and return `{username, display_name}`.

        The answer is cached for `chat_cache_sec`: it costs session.db and
        contact.db, both of which WeChat invalidates on every incoming message,
        and neither of which changes the identity of a conversation.
        """
        target = str(want or "").strip()
        if not target:
            raise ValueError("chat is required")
        cached = self._chat_cache.get(target)
        if cached and (time.monotonic() - cached[0]) < self._chat_cache_sec:
            return cached[1]
        sessions = self.sessions()
        found = None
        for row in sessions:
            if row.get("username") == target:
                found = row
                break
        if found is None:
            lowered = target.lower()
            for row in sessions:
                names = [
                    row.get("display_name"), row.get("displayName"),
                    row.get("nickname"), row.get("displayname"),
                ]
                if any(str(name or "").strip().lower() == lowered for name in names):
                    found = row
                    break
        if found is None:
            for row in sessions:
                # A "chat" the user typed as a display name that is also someone
                # else's last message: only accept it if nothing better matched.
                if str(row.get("summary") or "").strip() == target:
                    found = row
                    break
        if found is None:
            raise ValueError(f"chat not found in this account: {target}")
        resolved = {
            "username": str(found.get("username") or ""),
            "display_name": str(found.get("display_name") or found.get("displayName") or ""),
            "unread_count": int_value(found.get("unread_count")),
        }
        self._chat_cache[target] = (time.monotonic(), resolved)
        self._chat_cache[resolved["username"]] = (time.monotonic(), resolved)
        return resolved

    def snapshot(self, chat: str, limit: int) -> dict:
        started = time.monotonic()
        self.open()
        session = self.resolve_chat(chat)
        talker = str(session.get("username") or "")
        resolved_at = time.monotonic()
        rows = self._reader.get_messages(talker, limit=limit)
        read_at = time.monotonic()
        messages = [summarize_message(row, self._my_wxid(), talker, self.media) for row in rows]
        display = str(session.get("display_name") or "")
        if self._timing:
            log(f"snapshot {talker}: resolve={(resolved_at - started) * 1000:.0f}ms "
                + f"read={(read_at - resolved_at) * 1000:.0f}ms "
                + f"summarize={(time.monotonic() - read_at) * 1000:.0f}ms rows={len(rows)}")
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
    # The image key is derived from the account's uin by default; an explicit key
    # wins so an operator can pin a value that a future WeChat release changes.
    image_key = (args.image_key or os.environ.get("CYBERBOSS_WECHAT_DB_IMAGE_KEY")
                 or os.environ.get("CYBERBOSS_WECHAT_CLI_IMAGE_AES_KEY") or "").strip()
    image_xor = args.image_xor_key
    if image_xor is None:
        raw_xor = os.environ.get("CYBERBOSS_WECHAT_DB_IMAGE_XOR_KEY") or os.environ.get("CYBERBOSS_WECHAT_CLI_IMAGE_XOR_KEY") or ""
        try:
            image_xor = int(str(raw_xor), 0) if str(raw_xor).strip() else -1
        except ValueError:
            image_xor = -1
    return SnapshotReader(
        str(account), key,
        cache_dir=cache_dir,
        my_wxid=args.self_wxid or "",
        image_key=image_key,
        image_xor_key=image_xor,
        ffmpeg=args.ffmpeg or "",
    )


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
    parser.add_argument("--image-key", default="")
    parser.add_argument("--image-xor-key", type=int, default=None)
    parser.add_argument("--ffmpeg", default="")
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
