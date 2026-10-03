#!/usr/bin/env python
"""Dump the raw reader JSON for image rows in one chat (diagnosis helper).

usage: python tmp/probe-image-json.py [chat] [limit]
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHAT = sys.argv[1] if len(sys.argv) > 1 else "filehelper"
LIMIT = sys.argv[2] if len(sys.argv) > 2 else "5"

env = {}
for line in (ROOT / ".env").read_text(encoding="utf-8-sig").splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()

result = subprocess.run(
    [sys.executable, str(ROOT / "scripts" / "wechat-db-inbox-read.py"),
     "--chat", CHAT, "--limit", LIMIT],
    capture_output=True, cwd=str(ROOT), env={**env, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
)
if result.returncode != 0:
    print(result.stderr.decode("utf-8", "replace")[-2000:])
    raise SystemExit(1)

snapshot = json.loads(result.stdout.decode("utf-8"))
print(f"chat={snapshot['chat']} talker={snapshot['talker']} messages={len(snapshot['messages'])}")
for message in snapshot["messages"]:
    if message["kind"] != "image":
        continue
    print(f"\nlocalId={message['localId']} quality={message.get('imageQuality')!r} "
          f"size={message.get('imageSize')!r} source={message.get('imageSource')!r}")
    print(f"  text: {message['text'][:140]!r}")
    print(f"  attachments: {json.dumps(message['attachments'], ensure_ascii=False)[:300]}")
