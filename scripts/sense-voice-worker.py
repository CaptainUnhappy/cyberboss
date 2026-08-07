#!/usr/bin/env python3
"""Persistent JSONL worker backed by sherpa-onnx SenseVoice INT8."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="SenseVoice model directory")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--beam-size", type=int, default=1)
    parser.add_argument("--hotwords", default="")
    parser.add_argument("--cpu-threads", type=int, default=0)
    parser.add_argument("--local-files-only", action="store_true")
    return parser.parse_args()


def result_text(value) -> str:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return str(parsed.get("text", "")).strip()
        except json.JSONDecodeError:
            return value.strip()
    text = getattr(value, "text", "")
    return str(text or "").strip()


def main() -> int:
    args = parse_args()
    model_dir = Path(args.model).resolve()
    model_file = model_dir / "model.int8.onnx"
    tokens_file = model_dir / "tokens.txt"
    try:
        import sherpa_onnx
        import soundfile as sf

        if not model_file.is_file() or not tokens_file.is_file():
            raise FileNotFoundError(f"SenseVoice model files are incomplete: {model_dir}")
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model_file),
            tokens=str(tokens_file),
            language=args.language or "zh",
            use_itn=True,
            num_threads=args.cpu_threads if args.cpu_threads > 0 else 4,
            provider="cpu",
            debug=False,
        )
    except Exception as exc:
        emit({"type": "fatal", "error": str(exc)})
        return 1

    emit({"type": "ready", "model": str(model_dir), "provider": "sensevoice"})
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
            started = time.perf_counter()
            audio, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=True)
            stream = recognizer.create_stream()
            stream.accept_waveform(sample_rate, audio[:, 0])
            recognizer.decode_stream(stream)
            elapsed = time.perf_counter() - started
            duration = float(len(audio)) / float(sample_rate) if sample_rate else 0
            emit({
                "id": request_id,
                "text": result_text(stream.result),
                "language": args.language or "zh",
                "duration": duration,
                "inferenceSeconds": elapsed,
            })
        except Exception as exc:
            emit({"id": request_id, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
