#!/usr/bin/env python3
"""Local HTTP bridge that sends WeChat text through Windows UI Automation.

The bridge is intentionally loopback-only. After dispatching a message it
polls WeFlow's local read API and reports either a verified outgoing row or an
uncertain dispatch when the read API does not catch up before the deadline.
"""

from __future__ import annotations

import argparse
import ctypes
from datetime import datetime, timezone
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from ctypes import wintypes

import pyperclip
import uiautomation as automation

automation.Logger.SetLogFile("")

WECHAT_WINDOW_CLASSES = {"mmui::MainWindow", "Qt51514QWindowIcon"}
WECHAT_PROCESS_NAMES = {"wechat.exe", "weixin.exe"}
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SW_RESTORE = 9


def process_image_name(process_id: int) -> str:
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, process_id)
    if not process:
        return ""
    try:
        size = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(size)):
            return ""
        return os.path.basename(buffer.value).lower()
    finally:
        kernel32.CloseHandle(process)


def find_wechat_window_handle(*, require_chat_window: bool = False) -> int:
    user32 = ctypes.windll.user32
    matches: list[tuple[int, bool, bool]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def visit_window(handle: int, _lparam: int) -> bool:
        class_buffer = ctypes.create_unicode_buffer(256)
        if not user32.GetClassNameW(handle, class_buffer, len(class_buffer)):
            return True
        if class_buffer.value not in WECHAT_WINDOW_CLASSES:
            return True
        process_id = wintypes.DWORD()
        user32.GetWindowThreadProcessId(handle, ctypes.byref(process_id))
        if process_image_name(process_id.value) not in WECHAT_PROCESS_NAMES:
            return True
        rectangle = wintypes.RECT()
        user32.GetWindowRect(handle, ctypes.byref(rectangle))
        width = max(0, rectangle.right - rectangle.left)
        height = max(0, rectangle.bottom - rectangle.top)
        is_chat_window = class_buffer.value == "mmui::MainWindow" or (width >= 600 and height >= 500)
        matches.append((int(handle), bool(user32.IsWindowVisible(handle)), is_chat_window))
        return True

    user32.EnumWindows(visit_window, 0)
    for handle, visible, is_chat_window in matches:
        if visible and (not require_chat_window or is_chat_window):
            return handle
    if require_chat_window:
        return 0
    return matches[0][0] if matches else 0


def activate_window(handle: int) -> None:
    user32 = ctypes.windll.user32
    foreground = user32.GetForegroundWindow()
    foreground_thread = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
    current_thread = ctypes.windll.kernel32.GetCurrentThreadId()
    attached = bool(foreground_thread and foreground_thread != current_thread)
    if attached:
        user32.AttachThreadInput(current_thread, foreground_thread, True)
    try:
        user32.ShowWindow(handle, SW_RESTORE)
        user32.BringWindowToTop(handle)
        if not user32.SetForegroundWindow(handle) or user32.GetForegroundWindow() != handle:
            raise RuntimeError("WeChat main window could not be activated")
    finally:
        if attached:
            user32.AttachThreadInput(current_thread, foreground_thread, False)


def normalize_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def env_truthy(name: str, default: bool = False) -> bool:
    value = normalize_text(os.environ.get(name, ""))
    if not value:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


class BridgeState:
    def __init__(self, args: argparse.Namespace) -> None:
        self.weflow_base_url = args.weflow_base_url.rstrip("/")
        self.weflow_token = args.weflow_token
        self.state_file = Path(args.state_file)
        self.send_lock = threading.Lock()
        self.source_lock = threading.Lock()
        self.send_source = self._load_source()

    def _load_source(self) -> str:
        try:
            payload = json.loads(self.state_file.read_text(encoding="utf-8"))
            source = normalize_text(payload.get("send_source")).lower()
            if source in {"bot", "azzy"}:
                return source
        except (OSError, ValueError, TypeError):
            pass
        configured = normalize_text(os.environ.get("CYBERBOSS_WEFLOW_DEFAULT_SEND_SOURCE", "azzy")).lower()
        return configured if configured in {"bot", "azzy"} else "azzy"

    def set_source(self, source: str) -> None:
        with self.source_lock:
            self.send_source = source
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.state_file.with_suffix(self.state_file.suffix + ".tmp")
            temporary.write_text(
                json.dumps({"send_source": source}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            temporary.replace(self.state_file)

    def fetch_messages(
        self,
        talker: str,
        limit: int = 30,
        request_timeout: float = 3.0,
    ) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode({"talker": talker, "limit": limit})
        request = urllib.request.Request(
            f"{self.weflow_base_url}/api/v1/messages?{query}",
            headers={"Authorization": f"Bearer {self.weflow_token}"},
        )
        with urllib.request.urlopen(request, timeout=max(0.5, request_timeout)) as response:
            payload = json.load(response)
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        for key in ("messages", "data", "items"):
            items = payload.get(key) if isinstance(payload, dict) else None
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]
            if isinstance(items, dict):
                nested = items.get("messages") or items.get("items") or items.get("list")
                if isinstance(nested, list):
                    return [item for item in nested if isinstance(item, dict)]
        return []

    @staticmethod
    def message_id(message: dict[str, Any]) -> str:
        for key in ("localId", "local_id", "id", "msgId", "msg_id"):
            value = message.get(key)
            if value is None or isinstance(value, bool):
                continue
            text = str(value).strip()
            try:
                if text and int(text) > 0:
                    return str(int(text))
            except (TypeError, ValueError):
                continue
        return ""

    @staticmethod
    def message_matches(message: dict[str, Any], text: str) -> bool:
        is_sent = message.get("isSend", message.get("is_send", False))
        if is_sent not in (True, 1, "1"):
            return False
        content = message.get("content", message.get("text", ""))
        return str(content or "") == text

    @staticmethod
    def message_epoch_seconds(message: dict[str, Any]) -> int:
        value = message.get("createTime", message.get("timestamp", 0))
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            text = normalize_text(value)
            if not text:
                return 0
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return max(0, int(parsed.timestamp()))
            except ValueError:
                return 0
        if numeric <= 0:
            return 0
        # WeFlow installations may expose Unix seconds or milliseconds.
        while numeric >= 100_000_000_000:
            numeric /= 1_000
        return int(numeric)

    def dispatch_and_verify(self, contact: str, talker: str, text: str, timeout: float) -> dict[str, Any]:
        with self.send_lock:
            baseline_available = True
            try:
                before = {
                    self.message_id(message)
                    for message in self.fetch_messages(
                        talker,
                        request_timeout=min(3.0, max(0.75, timeout / 3)),
                    )
                    if self.message_matches(message, text)
                }
            except (OSError, ValueError, urllib.error.URLError, TimeoutError):
                # Dispatch still proceeds when the read API is briefly slow. A
                # timestamp fence below prevents an older identical row from
                # being mistaken for the new delivery.
                baseline_available = False
                before = set()
            dispatched_after = int(time.time()) - 2
            self._dispatch_text(contact, text)
            deadline = time.monotonic() + max(1.0, timeout)
            last_error = ""
            while time.monotonic() < deadline:
                try:
                    remaining = max(0.5, deadline - time.monotonic())
                    for message in self.fetch_messages(talker, request_timeout=min(3.0, remaining)):
                        message_id = self.message_id(message)
                        message_time = self.message_epoch_seconds(message)
                        # Verification must return a stable ID for the outbound
                        # ledger. When the baseline read failed, a valid recent
                        # timestamp is also required so an older identical row
                        # cannot be accepted as this delivery.
                        is_new = bool(message_id) and message_id not in before and (
                            baseline_available
                            or (message_time > 0 and message_time >= dispatched_after)
                        )
                        if self.message_matches(message, text) and is_new:
                            return {
                                "dispatched": True,
                                "verified": True,
                                "localId": message_id,
                            }
                except (OSError, ValueError, urllib.error.URLError) as error:
                    last_error = str(error)
                time.sleep(0.35)
            detail = f" ({last_error})" if last_error else ""
            return {
                "dispatched": True,
                "verified": False,
                "uncertain": True,
                "verificationError": f"outgoing message was not observed in WeFlow before timeout{detail}",
            }

    @staticmethod
    def _dispatch_text(contact: str, text: str) -> None:
        window_handle = find_wechat_window_handle(require_chat_window=True)
        if not window_handle:
            raise RuntimeError("WeChat main window was not found")
        previous_clipboard = ""
        clipboard_available = False
        activate_window(window_handle)
        time.sleep(0.25)
        try:
            previous_clipboard = pyperclip.paste()
            clipboard_available = True
        except pyperclip.PyperclipException:
            pass
        try:
            automation.SendKeys("{Ctrl}f", waitTime=0.05)
            time.sleep(0.25)
            automation.SendKeys("{Ctrl}a", waitTime=0.05)
            pyperclip.copy(contact)
            automation.SendKeys("{Ctrl}v", waitTime=0.05)
            time.sleep(0.7)
            automation.SendKeys("{Enter}", waitTime=0.05)
            time.sleep(0.5)
            automation.SendKeys("{Ctrl}a", waitTime=0.05)
            pyperclip.copy(text)
            automation.SendKeys("{Ctrl}v", waitTime=0.05)
            time.sleep(0.15)
            automation.SendKeys("{Enter}", waitTime=0.05)
        finally:
            if clipboard_available:
                try:
                    time.sleep(0.1)
                    pyperclip.copy(previous_clipboard)
                except pyperclip.PyperclipException:
                    pass

    @staticmethod
    def is_wechat_ready() -> bool:
        return bool(find_wechat_window_handle(require_chat_window=True))


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "CyberbossWeFlowUIA/1.0"

    @property
    def state(self) -> BridgeState:
        return self.server.bridge_state  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[weflow-uia] {self.address_string()} {fmt % args}", flush=True)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            print("[weflow-uia] client disconnected before the response was written", flush=True)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 1_000_000:
            return {}
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        return payload if isinstance(payload, dict) else {}

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path == "/healthz":
            self.send_json(200, {"ok": True})
            return
        if path == "/readyz":
            ready = self.state.is_wechat_ready()
            self.send_json(200 if ready else 503, {"ok": ready, "wechatWindow": ready})
            return
        if path == "/api/send-source":
            self.send_json(200, {"ok": True, "send_source": self.state.send_source})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        try:
            payload = self.read_json()
            if path == "/api/send":
                contact = normalize_text(payload.get("contact"))
                talker = normalize_text(payload.get("talker"))
                text = payload.get("text") if isinstance(payload.get("text"), str) else ""
                timeout = float(payload.get("timeout", 30))
                if not contact or not talker or not text.strip():
                    raise ValueError("contact, talker, and text are required")
                self.send_json(200, self.state.dispatch_and_verify(contact, talker, text, timeout))
                return
            if path == "/api/command":
                command = normalize_text(payload.get("command")).lower()
                if command == "/bot":
                    self.state.set_source("bot")
                elif command == "/azzy":
                    self.state.set_source("azzy")
                elif command not in {"/mode", "/状态"}:
                    raise ValueError("unsupported command")
                source = self.state.send_source
                self.send_json(200, {
                    "ok": True,
                    "send_source": source,
                    "label": "大号 ClawBot" if source == "bot" else "小号 UIA",
                })
                return
            self.send_json(404, {"error": "not found"})
        except (ValueError, json.JSONDecodeError) as error:
            response = {"error": str(error)}
            if path == "/api/send":
                response["dispatched"] = False
            self.send_json(400, response)
        except Exception as error:  # Keep the local bridge alive after UI/API failures.
            print(f"[weflow-uia] request failed: {error}", flush=True)
            response = {"error": str(error)}
            if path == "/api/send":
                response["dispatched"] = False
            self.send_json(502, response)


def parse_args() -> argparse.Namespace:
    state_dir = Path(os.environ.get("CYBERBOSS_STATE_DIR", Path.home() / ".cyberboss"))
    parser = argparse.ArgumentParser(description="Cyberboss WeFlow UIA outbound bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument(
        "--weflow-base-url",
        default=os.environ.get("CYBERBOSS_WEFLOW_BASE_URL", "http://127.0.0.1:5031"),
    )
    parser.add_argument("--weflow-token", default=os.environ.get("CYBERBOSS_WEFLOW_TOKEN", ""))
    parser.add_argument(
        "--state-file",
        default=str(state_dir / "weflow-send-source.json"),
    )
    args = parser.parse_args()
    if not normalize_text(args.weflow_token):
        parser.error("CYBERBOSS_WEFLOW_TOKEN is required")
    return args


def main() -> None:
    args = parse_args()
    if args.host not in {"127.0.0.1", "localhost", "::1"} and not env_truthy("CYBERBOSS_WEFLOW_UIA_ALLOW_REMOTE"):
        raise SystemExit("remote bind requires CYBERBOSS_WEFLOW_UIA_ALLOW_REMOTE=true")
    state = BridgeState(args)
    server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    server.bridge_state = state  # type: ignore[attr-defined]
    print(
        f"[weflow-uia] listening http://{args.host}:{args.port} source={state.send_source}",
        flush=True,
    )
    server.serve_forever(poll_interval=0.25)


if __name__ == "__main__":
    main()
