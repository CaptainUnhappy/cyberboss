#!/usr/bin/env python3
"""Read a filtered, structured snapshot from a local wechat-cli checkout.

Only the fields needed by Cyberboss are emitted. Raw database rows, protocol
payloads, keys, and download credentials never leave this process.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET
from contextlib import closing
from datetime import datetime


def _bootstrap_wechat_cli_root() -> None:
    for index, value in enumerate(sys.argv[:-1]):
        if value == "--wechat-cli-root":
            root = os.path.abspath(sys.argv[index + 1])
            if root not in sys.path:
                sys.path.insert(0, root)
            return


_bootstrap_wechat_cli_root()

from wechat_cli.core.contacts import get_contact_names, get_self_username  # noqa: E402
from wechat_cli.core.context import AppContext  # noqa: E402
from wechat_cli.core.messages import (  # noqa: E402
    _format_message_text,
    _iter_table_contexts,
    _load_name2id_maps,
    _parse_xml_root,
    _query_messages,
    _resolve_media_path,
    _split_msg_type,
    decompress_content,
    resolve_chat_context,
)


KIND_BY_TYPE = {
    1: "text",
    3: "image",
    34: "voice",
    43: "video",
    48: "unknown",
    49: "link",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wechat-cli-root", required=True)
    parser.add_argument("--chat", required=True)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--config", default="")
    return parser.parse_args()


def clean_text(value: object, limit: int = 4000) -> str:
    text = " ".join(str(value or "").split()).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def xml_text(node: ET.Element | None, path: str) -> str:
    if node is None:
        return ""
    return clean_text(node.findtext(path) or "")


def int_value(value: object, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def kind_for_type(local_type: int, app_type: int = 0) -> str:
    base_type, _ = _split_msg_type(local_type)
    if base_type == 49:
        if app_type == 6:
            return "file"
        return "link"
    return KIND_BY_TYPE.get(base_type, "unknown")


def parse_app_message(content: str) -> dict:
    root = _parse_xml_root(content)
    appmsg = root.find(".//appmsg") if root is not None else None
    if appmsg is None:
        return {
            "app_type": 0,
            "title": "",
            "description": "",
            "url": "",
            "record_text": "",
        }
    app_type = int_value(xml_text(appmsg, "type"))
    record_text = parse_forwarded_record(appmsg.findtext("recorditem") or "")
    return {
        "app_type": app_type,
        "title": xml_text(appmsg, "title"),
        "description": xml_text(appmsg, "des"),
        "url": xml_text(appmsg, "url"),
        "record_text": record_text,
        "appmsg": appmsg,
    }


def parse_forwarded_record(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return clean_text(raw, 2000)

    lines = []
    for item in root.findall(".//dataitem")[:30]:
        source = xml_text(item, ".//sourcename")
        title = xml_text(item, ".//datatitle") or xml_text(item, ".//title")
        description = xml_text(item, ".//datadesc") or xml_text(item, ".//desc")
        content = xml_text(item, ".//datacontent") or xml_text(item, ".//content")
        body = title or description or content
        if not body:
            continue
        lines.append(f"{source}: {body}" if source else body)
    return clean_text("\n".join(lines), 6000)


def resolve_media(db_dir: str, content: str, local_type: int, create_time: int, chat_username: str) -> str:
    try:
        media_path, exists = _resolve_media_path(
            db_dir,
            content,
            local_type,
            create_time,
            chat_username,
        )
    except Exception:
        return ""
    if not media_path or not exists or not os.path.isfile(media_path):
        return ""
    return os.path.abspath(media_path)


def load_resource_index(app: AppContext, chat_username: str) -> dict:
    resource_path = app.cache.get(os.path.join("message", "message_resource.db"))
    if not resource_path:
        return {}
    index = {}
    try:
        with closing(sqlite3.connect(resource_path)) as conn:
            chat_row = conn.execute(
                "SELECT rowid FROM ChatName2Id WHERE user_name = ?",
                (chat_username,),
            ).fetchone()
            if not chat_row:
                return {}
            rows = conn.execute(
                """
                SELECT message_local_id, message_create_time, message_local_type,
                       message_svr_id, packed_info
                FROM MessageResourceInfo
                WHERE chat_id = ?
                """,
                (chat_row[0],),
            ).fetchall()
    except Exception:
        return {}
    for local_id, create_time, local_type, svr_id, packed_info in rows:
        blob = packed_info if isinstance(packed_info, bytes) else str(packed_info or "").encode()
        match = re.search(rb"[0-9a-fA-F]{32}", blob)
        if not match:
            continue
        md5_value = match.group(0).decode("ascii").lower()
        index[(int_value(local_id), int_value(create_time), int_value(local_type) & 0xFFFFFFFF)] = md5_value
        if int_value(svr_id):
            index[("svr", int_value(svr_id))] = md5_value
    return index


def resolve_indexed_image(db_dir: str, chat_username: str, create_time: int, md5_value: str) -> str:
    if not md5_value:
        return ""
    chat_hash = hashlib.md5(chat_username.encode("utf-8")).hexdigest()
    month = datetime.fromtimestamp(create_time).strftime("%Y-%m")
    image_dir = os.path.join(os.path.dirname(db_dir), "msg", "attach", chat_hash, month, "Img")
    for suffix in ("", "_h", "_t"):
        candidate = os.path.join(image_dir, f"{md5_value}{suffix}.dat")
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return ""


def build_quote_context(ref: ET.Element, message_id: str, db_dir: str, create_time: int, chat_username: str, resource_index: dict) -> tuple[dict, list[dict]]:
    ref_type = int_value(xml_text(ref, "type"))
    ref_content = ref.findtext("content") or ""
    ref_display_name = xml_text(ref, "displayname")
    ref_app = parse_app_message(ref_content) if (ref_type & 0xFFFFFFFF) == 49 else {}
    app_type = int_value(ref_app.get("app_type"))
    kind = kind_for_type(ref_type, app_type)
    title = clean_text(ref_app.get("title") or ref_display_name, 500)
    url = clean_text(ref_app.get("url"), 2000)
    text = ""

    if kind == "text":
        text = clean_text(ref_content)
    elif ref_app:
        text = clean_text(
            ref_app.get("record_text")
            or ref_app.get("description")
            or ref_app.get("title")
        )

    attachment_refs = []
    attachments = []
    if kind in {"image", "voice", "video", "file"}:
        ref_svr_id = int_value(xml_text(ref, "svrid"))
        indexed_md5 = resource_index.get(("svr", ref_svr_id), "") if ref_svr_id else ""
        media_path = resolve_indexed_image(db_dir, chat_username, create_time, indexed_md5) if kind == "image" else ""
        if not media_path:
            media_path = resolve_media(db_dir, ref_content, ref_type, create_time, chat_username)
        if media_path:
            attachment_ref = f"quoted-{message_id}-1"
            attachment_refs.append(attachment_ref)
            attachments.append({
                "kind": kind,
                "path": media_path,
                "fileName": os.path.basename(media_path),
                "origin": "quoted",
                "attachmentRef": attachment_ref,
            })

    return ({
        "kind": kind,
        "title": title,
        "text": text,
        "url": url,
        "attachmentRefs": attachment_refs,
    }, attachments)


def build_message_payload(row: tuple, table_ctx: dict, id_to_username: dict, app: AppContext, names: dict, resource_index: dict) -> dict:
    local_id, local_type, create_time, real_sender_id, content, content_type = row
    raw_content = decompress_content(content, content_type)
    if raw_content is None:
        raw_content = ""
    if not isinstance(raw_content, str):
        raw_content = str(raw_content)

    stable_source = "|".join([
        table_ctx["username"],
        os.path.basename(table_ctx["db_path"]),
        table_ctx["table_name"],
        str(local_id),
        str(local_type),
        str(create_time),
    ])
    message_id = hashlib.sha256(stable_source.encode("utf-8")).hexdigest()[:32]
    sender_username = id_to_username.get(real_sender_id, "")
    self_username = get_self_username(app.db_dir, app.cache, app.decrypted_dir)
    if table_ctx["is_group"]:
        direction = "outgoing" if sender_username == self_username else "incoming"
    else:
        direction = "incoming" if sender_username == table_ctx["username"] else "outgoing"

    base_type, sub_type = _split_msg_type(local_type)
    kind = kind_for_type(local_type, sub_type)
    text = ""
    url = ""
    title = ""
    quoted_contexts = []
    attachments = []

    if base_type == 1:
        text = clean_text(raw_content)
    elif base_type == 49:
        parsed = parse_app_message(raw_content)
        app_type = int_value(parsed.get("app_type"), sub_type)
        kind = kind_for_type(local_type, app_type)
        title = clean_text(parsed.get("title"), 500)
        url = clean_text(parsed.get("url"), 2000)
        appmsg = parsed.get("appmsg")
        if app_type == 57 and appmsg is not None:
            text = title
            ref = appmsg.find(".//refermsg")
            if ref is not None:
                quote, quote_attachments = build_quote_context(
                    ref,
                    message_id,
                    app.db_dir,
                    create_time,
                    table_ctx["username"],
                    resource_index,
                )
                quoted_contexts.append(quote)
                attachments.extend(quote_attachments)
        elif app_type == 19:
            text = "\n".join(filter(None, [
                f"[合并转发] {title}" if title else "[合并转发]",
                clean_text(parsed.get("description"), 2000),
                clean_text(parsed.get("record_text"), 6000),
            ])).strip()
        elif kind == "link":
            text = "\n".join(filter(None, [
                f"[链接] {title}" if title else "[链接]",
                url,
                clean_text(parsed.get("description"), 2000),
            ])).strip()
        elif kind == "file":
            text = "" if title else "[文件]"
        else:
            text = title or clean_text(parsed.get("description"), 2000)
    elif base_type not in {3, 34, 43}:
        _, formatted = _format_message_text(
            local_id,
            local_type,
            raw_content,
            table_ctx["is_group"],
            table_ctx["username"],
            table_ctx["display_name"],
            names,
            app.display_name_fn,
            db_dir=app.db_dir,
            create_time_ts=create_time,
            resolve_media=False,
        )
        text = clean_text(formatted)

    if kind in {"image", "voice", "video", "file"} and not attachments:
        indexed_md5 = resource_index.get((int_value(local_id), int_value(create_time), int_value(local_type) & 0xFFFFFFFF), "")
        media_path = resolve_indexed_image(
            app.db_dir,
            table_ctx["username"],
            create_time,
            indexed_md5,
        ) if kind == "image" else ""
        if not media_path:
            media_path = resolve_media(app.db_dir, raw_content, local_type, create_time, table_ctx["username"])
        if media_path:
            attachments.append({
                "kind": kind,
                "path": media_path,
                "fileName": title or os.path.basename(media_path),
                "origin": "direct",
                "attachmentRef": f"direct-{message_id}-1",
            })
        elif not text:
            labels = {"image": "图片", "voice": "语音", "video": "视频", "file": "文件"}
            text = f"[{labels.get(kind, '资料')}]（本地媒体文件未定位）"

    received_at = datetime.fromtimestamp(create_time).astimezone().isoformat()
    return {
        "id": message_id,
        "localId": int_value(local_id),
        "timestamp": int_value(create_time),
        "receivedAt": received_at,
        "direction": direction,
        "kind": kind,
        "title": title,
        "text": text,
        "url": url,
        "quotedContexts": quoted_contexts,
        "attachments": attachments,
    }


def main() -> int:
    args = parse_args()
    limit = max(1, min(500, int(args.limit)))
    app = AppContext(args.config or None)
    ctx = resolve_chat_context(args.chat, app.msg_db_keys, app.cache, app.decrypted_dir)
    if not ctx:
        raise RuntimeError(f"wechat-cli chat was not found: {args.chat}")
    names = get_contact_names(app.cache, app.decrypted_dir)
    resource_index = load_resource_index(app, ctx["username"])
    collected = []
    failures = []

    for table_ctx in _iter_table_contexts(ctx):
        try:
            with closing(sqlite3.connect(table_ctx["db_path"])) as conn:
                id_to_username = _load_name2id_maps(conn)
                rows = _query_messages(conn, table_ctx["table_name"], limit=limit)
                for row in rows:
                    try:
                        collected.append(build_message_payload(row, table_ctx, id_to_username, app, names, resource_index))
                    except Exception as error:
                        failures.append(f"local_id={row[0]}: {error}")
        except Exception as error:
            failures.append(str(error))

    collected.sort(key=lambda item: (item["timestamp"], item["localId"], item["id"]))
    collected = collected[-limit:]
    print(json.dumps({
        "chat": ctx["display_name"],
        "chatUsername": ctx["username"],
        "messages": collected,
        "failures": failures[:20],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
