#!/usr/bin/env python3
"""Persistent JSONL worker for low-latency local voice transcription."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--beam-size", type=int, default=1)
    parser.add_argument("--hotwords", default="")
    parser.add_argument("--cpu-threads", type=int, default=0)
    parser.add_argument("--local-files-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        from faster_whisper import WhisperModel
        kwargs = {
            "device": args.device,
            "compute_type": args.compute_type,
            "local_files_only": args.local_files_only,
        }
        if args.cpu_threads > 0:
            kwargs["cpu_threads"] = args.cpu_threads
        model = WhisperModel(args.model, **kwargs)
    except Exception as exc:
        emit({"type": "fatal", "error": str(exc)})
        return 1

    emit({"type": "ready", "model": args.model})
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        request_id = ""
        try:
            request = json.loads(raw_line)
            request_id = str(request.get("id", ""))
            audio_path = Path(str(request.get("path", ""))).resolve()
            if not audio_path.is_file():
                raise FileNotFoundError(f"audio file does not exist: {audio_path}")
            language = str(request.get("language") or args.language or "zh")
            segments, info = model.transcribe(
                str(audio_path),
                language=language,
                beam_size=max(1, args.beam_size),
                best_of=1,
                temperature=0,
                condition_on_previous_text=False,
                vad_filter=False,
                hotwords=args.hotwords or None,
            )
            text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
            emit({
                "id": request_id,
                "text": text,
                "language": getattr(info, "language", language),
                "duration": getattr(info, "duration", 0),
            })
        except Exception as exc:
            emit({"id": request_id, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
