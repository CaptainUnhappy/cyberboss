#!/usr/bin/env python3
"""Find the local WeChat V2 image key and persist it without printing it."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone


def bootstrap_root() -> None:
    for index, value in enumerate(sys.argv[:-1]):
        if value == "--wechat-cli-root":
            sys.path.insert(0, os.path.abspath(sys.argv[index + 1]))
            return


bootstrap_root()

from Crypto.Cipher import AES  # noqa: E402
from wechat_cli.keys.scanner_windows import (  # noqa: E402
    _enum_regions,
    _read_mem,
    kernel32,
)


IMAGE_MAGICS = (
    b"\xff\xd8\xff",
    b"\x89PNG",
    b"GIF",
    b"RIFF",
    b"wxgf",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wechat-cli-root", required=True)
    parser.add_argument("--dat", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def list_weixin_pids() -> list[int]:
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq Weixin.exe", "/FO", "CSV", "/NH"],
        capture_output=True,
        text=True,
        check=False,
    )
    pids = []
    for line in result.stdout.strip().splitlines():
        parts = line.strip('"').split('","')
        if len(parts) >= 2 and parts[0].lower() == "weixin.exe":
            try:
                pids.append(int(parts[1]))
            except ValueError:
                continue
    if not pids:
        try:
            import psutil
            pids.extend(
                process.pid
                for process in psutil.process_iter(["name"])
                if str(process.info.get("name") or "").lower() == "weixin.exe"
            )
        except Exception:
            pass
    return pids


def load_template(dat_path: str) -> tuple[bytes, bytes]:
    with open(dat_path, "rb") as handle:
        data = handle.read()
    if not data.startswith(bytes.fromhex("070856320807")) or len(data) < 31:
        raise RuntimeError("sample is not a WeChat V2 image")
    return data[15:31], data


def decrypts_to_image(ciphertext: bytes, key: bytes) -> bool:
    if len(key) != 16:
        return False
    try:
        plain = AES.new(key, AES.MODE_ECB).decrypt(ciphertext)
    except Exception:
        return False
    if plain.startswith(b"RIFF"):
        return len(plain) >= 12 and plain[8:12] == b"WEBP"
    return any(plain.startswith(magic) for magic in IMAGE_MAGICS if magic != b"RIFF")


def candidate_keys(value: bytes):
    if len(value) == 16:
        yield value
        return
    if len(value) >= 32:
        yield value[:16]
        yield value[-16:]
    for index in range(0, max(0, len(value) - 15)):
        yield value[index:index + 16]


def scan_process_for_key(pid: int, ciphertext: bytes) -> bytes | None:
    handle = kernel32.OpenProcess(0x0010 | 0x0400, False, pid)
    if not handle:
        return None
    seen = set()
    pattern = re.compile(rb"[A-Za-z0-9]{16,64}")
    try:
        for base, size in _enum_regions(handle):
            data = _read_mem(handle, base, size)
            if not data:
                continue
            for match in pattern.finditer(data):
                for key in candidate_keys(match.group(0)):
                    if key in seen:
                        continue
                    seen.add(key)
                    if decrypts_to_image(ciphertext, key):
                        return key
    finally:
        kernel32.CloseHandle(handle)
    return None


def infer_xor_key(data: bytes) -> int:
    signatures = (
        b"\xff\xd9",
        bytes.fromhex("49454e44ae426082"),
        b"\x3b",
    )
    for signature in signatures:
        if len(data) < len(signature):
            continue
        encrypted = data[-len(signature):]
        key = encrypted[0] ^ signature[0]
        if all((byte ^ key) == expected for byte, expected in zip(encrypted, signature)):
            return key
    return 0x88


def write_atomic(file_path: str, value: dict) -> None:
    directory = os.path.dirname(os.path.abspath(file_path))
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".wechat-image-key-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp_path, file_path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def main() -> int:
    args = parse_args()
    ciphertext, data = load_template(os.path.abspath(args.dat))
    key = None
    for pid in list_weixin_pids():
        key = scan_process_for_key(pid, ciphertext)
        if key:
            break
    if not key:
        raise RuntimeError("WeChat V2 image key was not found in the running Weixin.exe process")
    write_atomic(os.path.abspath(args.output), {
        "version": 1,
        "aesKey": key.decode("ascii"),
        "xorKey": infer_xor_key(data),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    })
    print("image key cached")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
