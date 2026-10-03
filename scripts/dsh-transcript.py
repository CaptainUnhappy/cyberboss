"""Read a DSH session transcript (.jsonl.zstd = concatenated zstd frames).

usage:
  python tmp/read-transcript.py <session-id> [--types t1,t2] [--json] [--tail N]

--json prints one JSON object per matching record: {"index", "type", "time", "text"}
where `text` is the concatenated text of the record's content blocks.
"""
import io
import json
import os
import sys
from pathlib import Path

import zstandard

SESSION = sys.argv[1]
DIR = Path(os.environ["USERPROFILE"]) / ".dsh" / "sessions" / "--D-Projects-cyberboss-user-cyberboss--" / SESSION
FILE = DIR / "session.v3.jsonl.zstd"

TYPES = None
if "--types" in sys.argv:
    TYPES = set(sys.argv[sys.argv.index("--types") + 1].split(","))
AS_JSON = "--json" in sys.argv
TAIL = 0
if "--tail" in sys.argv:
    TAIL = int(sys.argv[sys.argv.index("--tail") + 1])


def text_of(record: dict) -> str:
    data = record.get("data") or {}
    content = data.get("content")
    if content is None and isinstance(data.get("message"), dict):
        content = data["message"].get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict):
                parts.append(str(part.get("text") or ""))
            else:
                parts.append(str(part))
        return "\n".join(parts)
    return ""


def main() -> int:
    raw = FILE.read_bytes()
    text = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)).read().decode("utf-8", "replace")
    records = []
    for index, line in enumerate(text.split("\n")):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if TYPES and record.get("type") not in TYPES:
            continue
        records.append({
            "index": index,
            "type": record.get("type"),
            "time": record.get("time"),
            "text": text_of(record),
        })
    if TAIL:
        records = records[-TAIL:]
    if AS_JSON:
        for record in records:
            print(json.dumps(record, ensure_ascii=False))
    else:
        print(f"# {FILE.name}: {len(records)} matching record(s)", file=sys.stderr)
        for record in records:
            print(f"[{record['index']}] {record['type']}: {record['text'][:300]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
