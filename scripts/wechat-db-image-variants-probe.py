#!/usr/bin/env python
"""Inspect the on-disk image variants for one md5 (sizes + decoded pixels).

usage: python tmp/probe-image-variants.py <talker> [md5 ...]

Reads only: it never writes to the account directory.
"""
import hashlib
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

spec = importlib.util.spec_from_file_location(
    "inbox_read", str(ROOT / "scripts" / "wechat-db-inbox-read.py")
)
inbox_read = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inbox_read)

ACCOUNT = Path(
    os.environ.get("CYBERBOSS_WECHAT_DB_ACCOUNT_DIR")
    or r"D:\xwechat_files\wxid_ty69l7hjiqt012_f2b4"
)
CACHE = ROOT / "tmp" / "probe-image-cache"


def variants(md5: str, talker: str):
    folder = ACCOUNT / "msg" / "attach" / hashlib.md5(talker.encode("utf-8")).hexdigest()
    if not folder.is_dir():
        print(f"  no attach folder for {talker}")
        return
    media = inbox_read.MediaResolver(ACCOUNT, CACHE)
    for month in sorted([p.name for p in folder.iterdir() if p.is_dir()], reverse=True)[:4]:
        for suffix in ("", "_h", "_t"):
            path = folder / month / "Img" / f"{md5}{suffix}.dat"
            if not path.is_file():
                continue
            decoded, extension = media.decode_dat(path.read_bytes())
            if not decoded:
                print(f"  {month}/Img/{path.name:<40} {path.stat().st_size:>9}B  UNDECODABLE")
                continue
            if extension == ".hevc":
                # The container needs ffmpeg; measuring the HEVC payload itself
                # says nothing (it is not an image format).
                converted = media._convert_wxgf(decoded, md5, suffix)
                if not converted:
                    print(f"  {month}/Img/{path.name:<40} {path.stat().st_size:>9}B  HEVC (ffmpeg failed)")
                    continue
                payload = Path(converted).read_bytes()
                shown = f"{extension} -> {Path(converted).suffix} via ffmpeg"
            else:
                payload = decoded
                shown = extension or "?"
            size = inbox_read._image_size(payload)
            print(
                f"  {month}/Img/{path.name:<40} {path.stat().st_size:>9}B  "
                f"{size[0]}x{size[1]} {shown} "
                f"({len(payload)}B) mtime={path.stat().st_mtime:.0f}"
            )


def main(argv):
    talker = argv[0] if argv else "filehelper"
    md5s = argv[1:]
    if not md5s:
        print("usage: probe-image-variants.py <talker> <md5> [md5 ...]")
        return 1
    print(f"talker={talker} account={ACCOUNT}")
    for md5 in md5s:
        print(f"md5={md5}")
        variants(md5, talker)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
