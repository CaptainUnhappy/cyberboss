#!/usr/bin/env python
"""Where does a wechat-db poll actually spend its time?

Reads the production reader against the production cache (read-only) and prints,
per chat and per picture, the resolve cost, the decision, and the reader's own
counters. Built 2026-10-03 after `slow poll costMs=8200` appeared with a warm
cache and the answer was not guessable from the log.

usage: python scripts/wechat-db-timing-probe.py [chat,chat,...]
"""
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHATS = (sys.argv[1] if len(sys.argv) > 1 else "").split(",")

env = {}
for line in (ROOT / ".env").read_text(encoding="utf-8-sig").splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()

spec = importlib.util.spec_from_file_location("ir", str(ROOT / "scripts" / "wechat-db-inbox-read.py"))
ir = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ir)

args = ir.parse_args([])
args.key = env.get("CYBERBOSS_WECHAT_DB_KEY", "")
args.data_dir = env.get("CYBERBOSS_WECHAT_DB_DIR", "")
args.wxid = env.get("CYBERBOSS_WECHAT_DB_WXID", "")
args.cache_dir = env.get("CYBERBOSS_WECHAT_DB_CACHE_DIR", "")
reader = ir.build_reader(args)
chats = CHATS if CHATS != [""] else [c for c in env.get("CYBERBOSS_WECHAT_DB_INBOX_CHATS", "").split(",") if c]

started = time.monotonic()
reader.open()
print(f"open: {(time.monotonic() - started) * 1000:.0f}ms")


def stats():
    return dict(reader.media.stats)


for chat in chats:
    for attempt in (1, 2):
        before = stats()
        t0 = time.monotonic()
        try:
            snapshot = reader.snapshot(chat, 50)
        except Exception as error:  # noqa: BLE001
            print(f"\n{chat}: FAILED {error}")
            break
        cost = (time.monotonic() - t0) * 1000
        after = stats()
        print(f"\n{chat} -> {snapshot['displayName'] or snapshot['talker']}  "
              + f"poll#{attempt} {cost:.0f}ms")
        for key in ("resolved", "missing", "ffmpeg", "thumbnailOnly", "blankFrames", "waitedMs",
                    "keyFailures"):
            delta = after.get(key, 0) - before.get(key, 0)
            if delta:
                print(f"   {key}: +{delta}")
        if attempt == 1:
            for message in snapshot["messages"]:
                if message["kind"] != "image":
                    continue
                print(f"   image localId={message['localId']} quality={message.get('imageQuality')} "
                      f"size={message.get('imageSize')} source={message.get('imageSource')}")

print(f"\nmedia stats: {json.dumps(reader.media.stats, ensure_ascii=False)}")
print(f"wait budget: {reader.media.image_wait_ms}ms")
