#!/usr/bin/env python3
"""Local HTTP bridge that sends WeChat text and PNG images through UIA.

The bridge is intentionally loopback-only. After dispatching a message it
polls WeFlow's local read API and reports either a verified outgoing row or an
uncertain dispatch when the read API does not catch up before the deadline.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import contextvars
import ctypes
from datetime import datetime, timezone
import hashlib
import hmac
import io
import json
import logging
import os
import re
import secrets
import stat
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
import win32clipboard
from PIL import Image, UnidentifiedImageError

logger = logging.getLogger("cyberboss.weflow_uia_bridge")

from weflow_window_selection import (
    is_wechat_main_window_identity,
    select_wechat_window_handle,
)

automation.Logger.SetLogFile("")

WECHAT_WINDOW_CLASSES = {"mmui::MainWindow", "Qt51514QWindowIcon"}
WECHAT_PROCESS_NAMES = {"wechat.exe", "weixin.exe"}
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SW_RESTORE = 9
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
DEFAULT_MAX_IMAGE_PIXELS = 100_000_000
MIN_CANARY_DESKTOP_IDLE_SECONDS = 300
CONTACT_CACHE_TTL_SECONDS = 30.0
MIN_SEARCH_SELECTION_CONFIRM_SECONDS = 2.0
# How long to wait for two consecutive identical ordered-search snapshots before
# deriving a Down count.  This only waits for Weixin's search popup to stop
# re-rendering; every fail-closed condition (foreground/focus loss, ambiguous or
# missing target rows, unexpected control types) still trips immediately, so a
# larger budget cannot make a wrong target acceptable.  It was 1.0s while the
# direct session-row route handled the common case, and the search route now runs
# for every send, so a cold popup needs a realistic window.
MAX_SEARCH_RESULT_STABILIZATION_SECONDS = 3.0
MAX_SEARCH_NAVIGATION_DOWNS = 10
CHAT_INPUT_VALUE_VERIFY_TIMEOUT_SECONDS = 1.0
GA_ROOT = 2
GW_OWNER = 4
WECHAT_SESSION_ROW_CLASS = "mmui::ChatSessionCell"
WECHAT_SEARCH_ROW_CLASS = "mmui::SearchContentCellView"
WECHAT_SEARCH_POPUP_CLASS = "mmui::SearchContentPopover"
WECHAT_SEARCH_LIST_CLASS = "mmui::XTableView"
WECHAT_CHAT_INPUT_NAME_SUFFIXES = (
    "输入文字，或按住Ctrl+Win使用语音输入",
)
SAFE_CLICK_RATIOS = (
    (0.5, 0.5),
    (0.5, 0.75),
    (0.25, 0.75),
    (0.75, 0.75),
    (0.25, 0.5),
    (0.75, 0.5),
    (0.5, 0.25),
    (0.25, 0.25),
    (0.75, 0.25),
)
MODEL_CANARY_LEASE_VERSION = 1
MODEL_CANARY_LEASE_DIRECTORY = "weflow-uia-desktop-input-leases"
MODEL_CANARY_MAX_LEASE_SECONDS = 10 * 60
MODEL_CANARY_RUN_ID_PATTERN = re.compile(
    r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
)
MODEL_CANARY_NONCE_PATTERN = re.compile(r"^[a-f0-9]{24}$")
MODEL_CANARY_FINGERPRINT_PATTERN = re.compile(r"^[a-f0-9]{64}$")
MODEL_CANARY_LEASE_TOKEN_PATTERN = re.compile(r"^[a-f0-9]{64}$")
MODEL_CANARY_TRIGGER_MARKER_PATTERN = re.compile(
    r"^\[Cyberboss心跳模型探针 trigger=[a-f0-9-]+ nonce=[a-f0-9]+\]$"
)
MODEL_CANARY_REPLY_MARKER_PATTERN = re.compile(
    r"^\[Cyberboss心跳模型正常 trigger=[a-f0-9-]+\]$"
)


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [
        ("length", wintypes.UINT),
        ("flags", wintypes.UINT),
        ("showCmd", wintypes.UINT),
        ("ptMinPosition", wintypes.POINT),
        ("ptMaxPosition", wintypes.POINT),
        ("rcNormalPosition", wintypes.RECT),
        ("rcDevice", wintypes.RECT),
    ]


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT),
        ("dwTime", wintypes.DWORD),
    ]


class DesktopActiveError(RuntimeError):
    def __init__(self, desktop_idle_seconds: int | None, required_seconds: int) -> None:
        self.desktop_idle_seconds = desktop_idle_seconds
        self.required_seconds = required_seconds
        observed = "unavailable" if desktop_idle_seconds is None else str(desktop_idle_seconds)
        super().__init__(
            f"desktop input is active or unavailable: idle={observed}s, required={required_seconds}s"
        )


class TargetNotConfirmedError(RuntimeError):
    """Raised before an editor write/Enter when the exact chat cannot be proven."""


class DesktopInputLeaseError(RuntimeError):
    """Raised before UI side effects when a model-canary input lease is invalid."""

    def __init__(self, code: str, message: str, *, dispatched: bool = False) -> None:
        self.code = normalize_text(code) or "CANARY_DESKTOP_LEASE_INVALID"
        self.dispatched = bool(dispatched)
        super().__init__(message)


@contextmanager
def uia_com_apartment():
    """Balance COM setup for UIA work executed by an HTTP worker thread."""
    initialized = False
    try:
        automation.InitializeUIAutomationInCurrentThread()
        initialized = True
        yield
    finally:
        if initialized:
            automation.UninitializeUIAutomationInCurrentThread()


def get_last_input_tick() -> int:
    user32 = ctypes.windll.user32
    user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
    user32.GetLastInputInfo.restype = wintypes.BOOL
    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not user32.GetLastInputInfo(ctypes.byref(info)):
        raise OSError("GetLastInputInfo failed")
    return int(info.dwTime)


def get_desktop_idle_seconds() -> int:
    """Return whole seconds since the most recent desktop keyboard/mouse input."""
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
    user32.GetLastInputInfo.restype = wintypes.BOOL
    kernel32.GetTickCount64.restype = ctypes.c_ulonglong
    last_input_tick = get_last_input_tick()
    current_low_tick = int(kernel32.GetTickCount64()) & 0xFFFFFFFF
    elapsed_ms = (current_low_tick - last_input_tick) & 0xFFFFFFFF
    return max(0, elapsed_ms // 1000)


def require_desktop_idle(required_seconds: int | None) -> None:
    if required_seconds is None:
        return
    required = max(MIN_CANARY_DESKTOP_IDLE_SECONDS, int(required_seconds))
    try:
        idle_seconds = get_desktop_idle_seconds()
    except Exception:
        raise DesktopActiveError(None, required) from None
    if idle_seconds < required:
        raise DesktopActiveError(idle_seconds, required)


def require_no_competing_desktop_input(reference_tick: int, required_seconds: int) -> None:
    """Fail closed if keyboard/mouse input changes after exact chat selection.

    The bridge's own search/click operations can update LASTINPUTINFO, so the
    five-minute idle requirement is checked before activation and this second
    guard uses a fresh post-selection tick to detect a competing user action in
    the final quiet gap immediately before paste/Enter.
    """
    try:
        time.sleep(0.12)
        current_tick = get_last_input_tick()
    except Exception:
        raise DesktopActiveError(None, required_seconds) from None
    if current_tick != int(reference_tick):
        raise DesktopActiveError(0, required_seconds)


def require_foreground_continuity(window_handle: int) -> None:
    """Allow a chained exact reply only while WeChat still owns foreground."""
    try:
        foreground = int(ctypes.windll.user32.GetForegroundWindow())
    except Exception:
        foreground = 0
    if not foreground or foreground != int(window_handle):
        raise DesktopActiveError(0, MIN_CANARY_DESKTOP_IDLE_SECONDS)


def require_focused_chat_input(contact: str) -> None:
    """Fail closed unless keyboard focus is still on the confirmed chat editor."""
    try:
        focused = automation.GetFocusedControl()
        focused_id = normalize_text(focused.AutomationId)
        focused_class = normalize_text(focused.ClassName)
        focused_type = normalize_text(focused.ControlTypeName)
        focused_name = first_name_line(focused.Name)
    except Exception:
        focused_id = ""
        focused_class = ""
        focused_type = ""
        focused_name = ""
    if (
        focused_id != "chat_input_field"
        or focused_class != "mmui::ChatInputField"
        or focused_type != "EditControl"
        or not chat_input_name_matches_contact(focused_name, contact)
    ):
        raise TargetNotConfirmedError(
            "confirmed chat input lost keyboard focus before dispatch"
        )


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
    native_matches: list[tuple[int, bool]] = []
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
        native_matches.append((int(handle), bool(user32.IsWindowVisible(handle))))
        return True

    user32.EnumWindows(visit_window, 0)
    matches: list[tuple[int, bool, bool]] = []
    for handle, visible in native_matches:
        is_main_window = False
        try:
            root = automation.ControlFromHandle(handle)
            is_main_window = bool(root) and is_wechat_main_window_identity(
                class_name=normalize_text(root.ClassName),
                control_type_name=normalize_text(root.ControlTypeName),
            )
        except Exception:
            is_main_window = False
        matches.append((handle, visible, is_main_window))
    return select_wechat_window_handle(matches, require_chat_window=require_chat_window)


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


def first_name_line(value: Any) -> str:
    return normalize_text(value).splitlines()[0].strip() if normalize_text(value) else ""


WECHAT_CONTACT_NAME_KEYS = ("displayName", "remark", "nickname", "alias")

# Names the chat editor (chat_input_field) may legitimately carry for the target
# of the request currently being dispatched.  Weixin names the session row after
# the contact's *display name* (the remark whenever one is set) but the editor
# after the *nickname*, so a remarked contact can never satisfy a single-string
# proof.  The dispatch fills this in per request; a ContextVar keeps it isolated
# per request thread (ThreadingHTTPServer) without threading a second name
# through every selector signature.
_TARGET_EDITOR_NAMES: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar(
    "weflow_uia_target_editor_names",
    default=(),
)


def chat_input_name_matches_contact(value: Any, contact: str) -> bool:
    """Match the exact chat identity encoded in Weixin's editor Name.

    Current Weixin builds append the fixed editor accessibility prompt directly
    to the contact name without a separator.  The editor may carry either the
    contact's display name or its nickname, so each accepted name is checked with
    the same exact-equality proof - a contact-prefix collision still cannot
    satisfy the target proof.  Keep this allowlist exact.
    """
    observed = first_name_line(value)
    if not observed:
        return False
    candidates: list[str] = []
    for candidate in (first_name_line(contact), *_TARGET_EDITOR_NAMES.get()):
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    return any(
        observed == candidate
        or any(
            observed == f"{candidate}{suffix}"
            for suffix in WECHAT_CHAT_INPUT_NAME_SUFFIXES
        )
        for candidate in candidates
    )


def resolve_contact_names(
    contact: str,
    talker: str,
    contacts: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Resolve the per-surface names Weixin uses for one target contact.

    Weixin's UIA exposes the session row and the search row as
    ``session_item_<displayName>`` / ``search_item_<displayName>`` while the chat
    editor carries ``<nickname>``, and ``displayName`` equals the remark whenever
    one is set.  Matching one caller-supplied string against both surfaces can
    therefore never succeed for a remarked contact.  Resolution is keyed on the
    stable ``talker`` (wxid); it returns ``None`` when the contact is unknown so
    every caller keeps its previous behaviour.
    """
    requested = first_name_line(contact)
    normalized_talker = normalize_text(talker)
    row: dict[str, Any] | None = None
    for item in contacts:
        if normalized_talker and normalize_text(item.get("username")) == normalized_talker:
            row = item
            break
    if row is None and requested:
        for item in contacts:
            names = {first_name_line(item.get(key)) for key in WECHAT_CONTACT_NAME_KEYS}
            if requested in names:
                row = item
                break
    if row is None:
        return None
    accepted: list[str] = []
    for key in WECHAT_CONTACT_NAME_KEYS:
        value = first_name_line(row.get(key))
        if value and value not in accepted:
            accepted.append(value)
    row_name = (
        first_name_line(row.get("displayName"))
        or requested
        or first_name_line(row.get("nickname"))
    )
    editor_name = first_name_line(row.get("nickname")) or row_name
    if not row_name or not accepted:
        return None
    return {
        "rowName": row_name,
        "editorName": editor_name,
        "accepted": accepted,
        "username": normalize_text(row.get("username")),
    }


def find_controls_by_automation_id(
    root: automation.Control,
    automation_id: str,
    *,
    max_depth: int = 32,
    allow_hierarchical_suffix: bool = False,
    expected_class_name: str = "",
    expected_control_type_name: str = "",
) -> list[automation.Control]:
    matches: list[automation.Control] = []
    for control, _depth in automation.WalkControl(root, includeTop=True, maxDepth=max_depth):
        try:
            observed_id = normalize_text(control.AutomationId)
            id_matches = observed_id == automation_id or (
                allow_hierarchical_suffix and observed_id.endswith(f".{automation_id}")
            )
            if not id_matches:
                continue
            if expected_class_name and normalize_text(control.ClassName) != expected_class_name:
                continue
            if (expected_control_type_name
                    and normalize_text(control.ControlTypeName) != expected_control_type_name):
                continue
            if bool(control.IsOffscreen) or not bool(control.IsEnabled):
                continue
            rectangle = control.BoundingRectangle
            if rectangle.width() <= 0 or rectangle.height() <= 0:
                continue
            matches.append(control)
        except Exception:
            continue
    return matches


def control_has_ancestor(
    control: automation.Control,
    *,
    automation_id: str = "",
    class_names: set[str] | None = None,
    max_hops: int = 16,
) -> bool:
    current = control
    for _hop in range(max(1, max_hops)):
        try:
            current = current.GetParentControl()
        except Exception:
            return False
        if current is None:
            return False
        try:
            if automation_id and normalize_text(current.AutomationId) == automation_id:
                return True
            if class_names and normalize_text(current.ClassName) in class_names:
                return True
        except Exception:
            continue
    return False


def visible_enabled_control(control: automation.Control) -> bool:
    try:
        if bool(control.IsOffscreen) or not bool(control.IsEnabled):
            return False
        rectangle = control.BoundingRectangle
        return rectangle.width() > 0 and rectangle.height() > 0
    except Exception:
        return False


def get_selection_item_pattern(control: automation.Control):
    try:
        return control.GetPattern(automation.PatternId.SelectionItemPattern)
    except Exception:
        return None


def find_main_session_controls(root: automation.Control) -> list[automation.Control]:
    controls: list[automation.Control] = []
    for control, _depth in automation.WalkControl(root, includeTop=True, maxDepth=32):
        try:
            if not normalize_text(control.AutomationId).startswith("session_item_"):
                continue
            if not visible_enabled_control(control):
                continue
            if not control_has_ancestor(control, automation_id="session_list"):
                continue
            controls.append(control)
        except Exception:
            continue
    return controls


def selected_main_session_controls(root: automation.Control) -> list[automation.Control]:
    selected: list[automation.Control] = []
    for control in find_main_session_controls(root):
        pattern = get_selection_item_pattern(control)
        try:
            if pattern is not None and bool(pattern.IsSelected):
                selected.append(control)
        except Exception:
            continue
    return selected


def exact_session_row_matches(control: automation.Control, contact: str) -> bool:
    try:
        return (
            normalize_text(control.AutomationId) == f"session_item_{contact}"
            and first_name_line(control.Name) == contact
            and normalize_text(control.ClassName) == WECHAT_SESSION_ROW_CLASS
            and normalize_text(control.ControlTypeName) == "ListItemControl"
            and visible_enabled_control(control)
        )
    except Exception:
        return False


def control_bounds(control: automation.Control) -> tuple[int, int, int, int] | None:
    try:
        rectangle = control.BoundingRectangle
        bounds = (
            int(rectangle.left),
            int(rectangle.top),
            int(rectangle.right),
            int(rectangle.bottom),
        )
        return bounds if bounds[2] > bounds[0] and bounds[3] > bounds[1] else None
    except Exception:
        return None


def control_ancestors(control: automation.Control, max_hops: int = 24) -> list[automation.Control]:
    ancestors: list[automation.Control] = []
    current = control
    for _hop in range(max(1, max_hops)):
        try:
            current = current.GetParentControl()
        except Exception:
            break
        if current is None:
            break
        ancestors.append(current)
    return ancestors


def exact_search_popup_matches(control: automation.Control) -> bool:
    try:
        return (
            normalize_text(control.AutomationId) == ""
            and normalize_text(control.Name) == "Weixin"
            and normalize_text(control.ClassName) == WECHAT_SEARCH_POPUP_CLASS
            and normalize_text(control.ControlTypeName) == "WindowControl"
            and visible_enabled_control(control)
        )
    except Exception:
        return False


def exact_search_list_matches(control: automation.Control) -> bool:
    try:
        return (
            normalize_text(control.AutomationId) == "search_list"
            and normalize_text(control.Name) == ""
            and normalize_text(control.ClassName) == WECHAT_SEARCH_LIST_CLASS
            and normalize_text(control.ControlTypeName) == "ListControl"
            and visible_enabled_control(control)
        )
    except Exception:
        return False


def exact_search_result_shape_matches(control: automation.Control, contact: str) -> bool:
    try:
        return (
            normalize_text(control.AutomationId) == f"search_item_{contact}"
            and first_name_line(control.Name) == contact
            and normalize_text(control.ClassName) == WECHAT_SEARCH_ROW_CLASS
            and normalize_text(control.ControlTypeName) == "ListItemControl"
            and visible_enabled_control(control)
        )
    except Exception:
        return False


def strict_search_result_context_matches(
    root: automation.Control,
    result: automation.Control,
) -> bool:
    """Require one ordered row→search_list→SearchContentPopover chain."""
    ancestors = control_ancestors(result)
    ancestor_lists = [
        (index, item) for index, item in enumerate(ancestors)
        if exact_search_list_matches(item)
    ]
    ancestor_popups = [
        (index, item) for index, item in enumerate(ancestors)
        if exact_search_popup_matches(item)
    ]
    if len(ancestor_lists) != 1 or len(ancestor_popups) != 1:
        return False
    list_index, ancestor_list = ancestor_lists[0]
    popup_index, ancestor_popup = ancestor_popups[0]
    if list_index >= popup_index:
        return False

    tree_popups: list[automation.Control] = []
    tree_lists: list[automation.Control] = []
    try:
        for control, _depth in automation.WalkControl(root, includeTop=True, maxDepth=32):
            if exact_search_popup_matches(control):
                tree_popups.append(control)
            if exact_search_list_matches(control):
                tree_lists.append(control)
    except Exception:
        return False
    return (
        len(tree_popups) == 1
        and len(tree_lists) == 1
        and control_bounds(tree_popups[0]) == control_bounds(ancestor_popup)
        and control_bounds(tree_lists[0]) == control_bounds(ancestor_list)
    )


def same_exact_control_identity(
    observed: automation.Control,
    expected: automation.Control,
) -> bool:
    """Compare fresh UIA elements without relying on COM wrapper identity."""
    try:
        expected_id = normalize_text(expected.AutomationId)
        return bool(expected_id) and (
            normalize_text(observed.AutomationId) == expected_id
            and first_name_line(observed.Name) == first_name_line(expected.Name)
            and normalize_text(observed.ClassName) == normalize_text(expected.ClassName)
            and normalize_text(observed.ControlTypeName)
            == normalize_text(expected.ControlTypeName)
            and control_bounds(observed) == control_bounds(expected)
        )
    except Exception:
        return False


def hit_control_belongs_to_exact_control(
    hit: automation.Control,
    expected: automation.Control,
    *,
    max_hops: int = 16,
) -> bool:
    current = hit
    for _hop in range(max(1, max_hops)):
        if current is None:
            return False
        if same_exact_control_identity(current, expected):
            return True
        try:
            current = current.GetParentControl()
        except Exception:
            return False
    return False


def find_unobscured_control_click_ratio(
    control: automation.Control,
) -> tuple[float, float] | None:
    """Return a point whose topmost UIA element is the row or its descendant."""
    bounds = control_bounds(control)
    if bounds is None:
        return None
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    for ratio_x, ratio_y in SAFE_CLICK_RATIOS:
        x = bounds[0] + int(width * ratio_x)
        y = bounds[1] + int(height * ratio_y)
        try:
            hit = automation.ControlFromPoint(x, y)
        except Exception:
            continue
        if hit_control_belongs_to_exact_control(hit, control):
            return ratio_x, ratio_y
    return None


def require_safe_session_row_click(
    window_handle: int,
    session: automation.Control,
) -> tuple[float, float]:
    """Prove the row center belongs to the strict main window before one click."""
    require_foreground_continuity(window_handle)
    try:
        rectangle = session.BoundingRectangle
        point = wintypes.POINT(
            int((rectangle.left + rectangle.right) // 2),
            int((rectangle.top + rectangle.bottom) // 2),
        )
        user32 = ctypes.windll.user32
        user32.WindowFromPoint.argtypes = [wintypes.POINT]
        user32.WindowFromPoint.restype = wintypes.HWND
        user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        user32.GetAncestor.restype = wintypes.HWND
        hit_window = int(user32.WindowFromPoint(point) or 0)
        hit_root = int(user32.GetAncestor(hit_window, GA_ROOT) or hit_window)
    except Exception:
        hit_root = 0
    if hit_root != int(window_handle):
        raise TargetNotConfirmedError(
            "exact session row click point was not owned by the strict WeChat main window"
        )
    click_ratio = find_unobscured_control_click_ratio(session)
    if click_ratio is None:
        raise TargetNotConfirmedError(
            "exact session row had no unobscured UIA-owned click point"
        )
    return click_ratio


def require_safe_search_result_target(
    window_handle: int,
    root: automation.Control,
    result: automation.Control,
) -> tuple[float, float]:
    """Bind a search row to its unique, main-owned native popup before any action."""
    require_foreground_continuity(window_handle)
    if not strict_search_result_context_matches(root, result):
        raise TargetNotConfirmedError("exact search result popup identity was not confirmed")
    try:
        rectangle = result.BoundingRectangle
        point = wintypes.POINT(
            int((rectangle.left + rectangle.right) // 2),
            int((rectangle.top + rectangle.bottom) // 2),
        )
        user32 = ctypes.windll.user32
        user32.WindowFromPoint.argtypes = [wintypes.POINT]
        user32.WindowFromPoint.restype = wintypes.HWND
        user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        user32.GetAncestor.restype = wintypes.HWND
        user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
        user32.GetWindow.restype = wintypes.HWND
        hit_window = int(user32.WindowFromPoint(point) or 0)
        popup_handle = int(user32.GetAncestor(hit_window, GA_ROOT) or hit_window)
        popup_owner = int(user32.GetWindow(popup_handle, GW_OWNER) or 0)
        popup_control = automation.ControlFromHandle(popup_handle) if popup_handle else None
        popup_is_exact = bool(popup_control) and exact_search_popup_matches(popup_control)
        ancestor_popup = next(
            item for item in control_ancestors(result) if exact_search_popup_matches(item)
        )
        popup_bounds_match = (
            popup_control is not None
            and control_bounds(popup_control) == control_bounds(ancestor_popup)
        )
    except Exception:
        popup_handle = 0
        popup_owner = 0
        popup_is_exact = False
        popup_bounds_match = False
    if (
        not popup_handle
        or popup_handle == int(window_handle)
        or popup_owner != int(window_handle)
        or not popup_is_exact
        or not popup_bounds_match
    ):
        raise TargetNotConfirmedError(
            "exact search result was not owned by the strict WeChat main window"
        )
    click_ratio = find_unobscured_control_click_ratio(result)
    if click_ratio is None:
        raise TargetNotConfirmedError(
            "exact search result had no unobscured UIA-owned click point"
        )
    return click_ratio


def confirm_fresh_session_state(
    root: automation.Control,
    contact: str,
    *,
    source: str,
) -> automation.Control:
    """Confirm the post-action target without weakening direct-main selection."""
    if source not in {"main", "search"}:
        raise TargetNotConfirmedError(f"unknown confirmation source: {source!r}")
    if not is_wechat_main_window_identity(
        class_name=normalize_text(root.ClassName),
        control_type_name=normalize_text(root.ControlTypeName),
    ):
        raise TargetNotConfirmedError("fresh UI Automation root was not the strict main window")

    target_id = f"session_item_{contact}"
    candidates = find_controls_by_automation_id(root, target_id, max_depth=32)
    if source == "main" and len(candidates) != 1:
        raise TargetNotConfirmedError(
            f"fresh exact main session was not unique: count={len(candidates)}"
        )
    if source == "search" and len(candidates) > 1:
        raise TargetNotConfirmedError(
            f"fresh exact search-selected main session was ambiguous: count={len(candidates)}"
        )
    if candidates and (
        not control_has_ancestor(candidates[0], automation_id="session_list")
        or not exact_session_row_matches(candidates[0], contact)
    ):
        raise TargetNotConfirmedError("fresh exact main session identity did not match")

    selected = selected_main_session_controls(root)
    selected_is_exact = (
        len(selected) == 1
        and normalize_text(selected[0].AutomationId) == target_id
    )
    if source == "main":
        selection = get_selection_item_pattern(candidates[0])
        try:
            target_is_selected = selection is not None and bool(selection.IsSelected)
        except Exception:
            target_is_selected = False
        if not target_is_selected or not selected_is_exact:
            names = [first_name_line(item.Name) for item in selected]
            raise TargetNotConfirmedError(
                f"fresh selected main session set was not exact: {names!r}"
            )
    elif selected and not selected_is_exact:
        names = [first_name_line(item.Name) for item in selected]
        raise TargetNotConfirmedError(
            f"fresh search-selected main session set conflicted: {names!r}"
        )
    elif not candidates and selected:
        # Defensive clarity for synthetic providers: a reported exact selected
        # row must also be discoverable as the unique strict session candidate.
        names = [first_name_line(item.Name) for item in selected]
        raise TargetNotConfirmedError(
            f"fresh search-selected main session row was missing while selection existed: {names!r}"
        )

    # Search-origin selection may not materialize a main-row provider object at
    # all. The same strict main root still has to expose exactly one matching
    # title and exactly one matching chat editor label. No editor is focused or
    # clicked here.
    return confirm_current_chat_target(root, contact)


def wait_for_fresh_session_confirmation(
    root: automation.Control,
    contact: str,
    timeout: float,
    *,
    source: str = "main",
) -> tuple[automation.Control | None, Exception | None]:
    """Re-enumerate after an action; never trust provider success or stale patterns."""
    deadline = time.monotonic() + max(0.1, timeout)
    last_error: Exception | None = None
    while True:
        try:
            return confirm_fresh_session_state(
                root,
                contact,
                source=source,
            ), None
        except Exception as error:
            last_error = error
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None, last_error
        time.sleep(min(0.1, remaining))


def select_session_item_and_confirm(
    window_handle: int,
    root: automation.Control,
    session: automation.Control,
    contact: str,
    *,
    timeout: float,
    source: str,
) -> automation.Control:
    def fresh_action_row() -> automation.Control:
        expected_id = (
            f"session_item_{contact}" if source == "main" else f"search_item_{contact}"
        )
        candidates = find_controls_by_automation_id(root, expected_id, max_depth=32)
        if len(candidates) != 1:
            raise TargetNotConfirmedError(
                f"exact {source} session row was not unique: count={len(candidates)}"
            )
        candidate = candidates[0]
        if source == "main":
            if (
                not exact_session_row_matches(candidate, contact)
                or not control_has_ancestor(candidate, automation_id="session_list")
            ):
                raise TargetNotConfirmedError("exact main session row identity did not match")
        else:
            if (
                not exact_search_result_shape_matches(candidate, contact)
                or not strict_search_result_context_matches(root, candidate)
            ):
                raise TargetNotConfirmedError("exact search result row identity did not match")
        return candidate

    if source not in {"main", "search"}:
        raise TargetNotConfirmedError(f"unknown exact session source: {source!r}")
    if source == "main" and not exact_session_row_matches(session, contact):
        raise TargetNotConfirmedError("exact session row identity did not match")
    if source == "search" and not exact_search_result_shape_matches(session, contact):
        raise TargetNotConfirmedError("exact search result row identity did not match")
    total_timeout = max(0.75, timeout)
    stage_timeout = max(0.25, total_timeout / 3)
    last_error: Exception | None = None
    attempted_actions: list[str] = []

    if source == "main":
        selection_row = fresh_action_row()
        selection = get_selection_item_pattern(selection_row)
        if selection is not None:
            try:
                selection.Select(waitTime=0.05)
                attempted_actions.append("SelectionItem.Select")
            except Exception as error:
                last_error = error
            confirmed, observed_error = wait_for_fresh_session_confirmation(
                root,
                contact,
                stage_timeout,
            )
            if confirmed is not None:
                return confirmed
            last_error = observed_error or last_error

        invoke_row = fresh_action_row()
        try:
            invoke = invoke_row.GetPattern(automation.PatternId.InvokePattern)
        except Exception:
            invoke = None
        if invoke is not None:
            try:
                invoke.Invoke(waitTime=0.05)
                attempted_actions.append("InvokePattern.Invoke")
            except Exception as error:
                last_error = error
            confirmed, observed_error = wait_for_fresh_session_confirmation(
                root,
                contact,
                stage_timeout,
            )
            if confirmed is not None:
                return confirmed
            last_error = observed_error or last_error

    if source == "search":
        # Physical coordinates reported for SearchContentCellView are not
        # trustworthy: live Weixin can report an exact ControlFromPoint hit yet
        # route the mouse click to a different conversation. Keep the unique
        # exact row/owner/hit-test as identity evidence, require the one strict
        # main search edit to retain focus, derive a bounded Down count from two
        # stable ordered snapshots, then use exactly one Enter. A no-op or wrong
        # target is cleaned up by the caller and fails.
        try:
            confirmed, observed_error = select_exact_search_result_with_enter(
                window_handle,
                root,
                contact,
                timeout=max(stage_timeout, MIN_SEARCH_SELECTION_CONFIRM_SECONDS),
            )
            attempted_actions.append("search_edit.Enter(after derived Downs)")
        except (DesktopActiveError, TargetNotConfirmedError) as error:
            last_error = error
        else:
            if confirmed is not None:
                return confirmed
            last_error = observed_error or last_error
        raise TargetNotConfirmedError(
            "exact session did not become the confirmed current chat "
            f"after actions={attempted_actions!r}: {last_error}"
        )

    # Direct main rows may expose provider patterns that return success without
    # changing chat. Use one hit-tested physical click as their last fallback.
    click_row = fresh_action_row()
    click_ratio = require_safe_session_row_click(window_handle, click_row)
    try:
        click_row.Click(
            ratioX=click_ratio[0],
            ratioY=click_ratio[1],
            simulateMove=False,
            waitTime=0.2,
        )
        attempted_actions.append("row.Click")
    except Exception as error:
        raise TargetNotConfirmedError(f"exact session row click failed: {error}") from error
    confirmed, observed_error = wait_for_fresh_session_confirmation(
        root,
        contact,
        stage_timeout,
        source="main",
    )
    if confirmed is not None:
        return confirmed
    last_error = observed_error or last_error
    raise TargetNotConfirmedError(
        "exact session did not become the confirmed current chat "
        f"after actions={attempted_actions!r}: {last_error}"
    )


def find_main_session_search_edits(root: automation.Control) -> list[automation.Control]:
    matches: list[automation.Control] = []
    for control, _depth in automation.WalkControl(root, includeTop=True, maxDepth=32):
        try:
            if normalize_text(control.ClassName) != "mmui::XValidatorTextEdit":
                continue
            if normalize_text(control.ControlTypeName) != "EditControl":
                continue
            if not visible_enabled_control(control):
                continue
            if not control_has_ancestor(
                control,
                class_names={"mmui::XSearchField", "XSearchField"},
                max_hops=3,
            ):
                continue
            matches.append(control)
        except Exception:
            continue
    return matches


def search_edit_identity_matches(
    expected: automation.Control,
    observed: automation.Control,
) -> bool:
    try:
        return (
            normalize_text(expected.AutomationId) == normalize_text(observed.AutomationId)
            and normalize_text(observed.ClassName) == "mmui::XValidatorTextEdit"
            and normalize_text(observed.ControlTypeName) == "EditControl"
            and control_bounds(expected) == control_bounds(observed)
            and control_bounds(observed) is not None
        )
    except Exception:
        return False


def require_search_edit_focus(window_handle: int, edit: automation.Control) -> None:
    require_foreground_continuity(window_handle)
    try:
        focused = automation.GetFocusedControl()
    except Exception as error:
        raise TargetNotConfirmedError(
            f"main session search focus could not be inspected: {error}"
        ) from error
    if not search_edit_identity_matches(edit, focused):
        raise TargetNotConfirmedError("main session search field focus was not confirmed")


def ordered_strict_search_content_rows(
    root: automation.Control,
) -> tuple[list[automation.Control], tuple[tuple[Any, ...], ...]]:
    """Return the complete visible session-result order from one strict popup.

    Category rows such as ``联系人`` are XTableCell objects.  Weixin keyboard
    navigation skips those headers and advances across SearchContentCellView
    rows, so only the latter define the derived Down count.
    """
    try:
        walked = [
            control for control, _depth in automation.WalkControl(
                root,
                includeTop=True,
                maxDepth=32,
            )
        ]
    except Exception as error:
        raise TargetNotConfirmedError(
            f"ordered search result tree could not be inspected: {error}"
        ) from error
    search_lists = [control for control in walked if exact_search_list_matches(control)]
    search_popups = [control for control in walked if exact_search_popup_matches(control)]
    if len(search_lists) != 1 or len(search_popups) != 1:
        raise TargetNotConfirmedError(
            "ordered search result popup/list was not unique: "
            f"popups={len(search_popups)}, lists={len(search_lists)}"
        )
    search_list_bounds = control_bounds(search_lists[0])
    search_popup_bounds = control_bounds(search_popups[0])
    rows: list[automation.Control] = []
    for control in walked:
        try:
            if normalize_text(control.ClassName) != WECHAT_SEARCH_ROW_CLASS:
                continue
            if normalize_text(control.ControlTypeName) != "ListItemControl":
                raise TargetNotConfirmedError(
                    "search content row had an unexpected control type"
                )
            if not visible_enabled_control(control):
                raise TargetNotConfirmedError(
                    "search content row was not visibly activatable"
                )
            name = first_name_line(control.Name)
            if not name or normalize_text(control.AutomationId) != f"search_item_{name}":
                raise TargetNotConfirmedError(
                    "search content row did not have an exact session identity"
                )
            ancestors = control_ancestors(control)
            ancestor_lists = [item for item in ancestors if exact_search_list_matches(item)]
            ancestor_popups = [item for item in ancestors if exact_search_popup_matches(item)]
            if (
                len(ancestor_lists) != 1
                or len(ancestor_popups) != 1
                or control_bounds(ancestor_lists[0]) != search_list_bounds
                or control_bounds(ancestor_popups[0]) != search_popup_bounds
            ):
                raise TargetNotConfirmedError(
                    "search content row did not belong to the unique strict popup/list"
                )
            rows.append(control)
        except TargetNotConfirmedError:
            raise
        except Exception as error:
            raise TargetNotConfirmedError(
                f"search content row identity could not be inspected: {error}"
            ) from error
    rows.sort(
        key=lambda control: (
            (control_bounds(control) or (2**31, 2**31, 2**31, 2**31))[1],
            (control_bounds(control) or (2**31, 2**31, 2**31, 2**31))[0],
        )
    )
    identities = tuple(
        (
            normalize_text(control.AutomationId),
            first_name_line(control.Name),
            normalize_text(control.ClassName),
            normalize_text(control.ControlTypeName),
            control_bounds(control),
        )
        for control in rows
    )
    automation_ids = [identity[0] for identity in identities]
    if not rows or len(set(automation_ids)) != len(automation_ids):
        raise TargetNotConfirmedError(
            "ordered search content identities were empty or ambiguous"
        )
    return rows, identities


def select_exact_search_result_with_enter(
    window_handle: int,
    root: automation.Control,
    contact: str,
    *,
    timeout: float,
) -> tuple[automation.Control | None, Exception | None]:
    """Derive bounded keyboard navigation, then use one guarded Enter."""
    require_foreground_continuity(window_handle)
    edits = find_main_session_search_edits(root)
    if len(edits) != 1:
        raise TargetNotConfirmedError(
            f"main session search field was not unique before Enter: count={len(edits)}"
        )
    edit = edits[0]
    # replace_main_session_search_text already established and verified this
    # exact focus before the popup was discovered. Calling SetFocus again here
    # rematerializes the native popup and invalidates the just-proven row.
    # Require continuity instead of mutating focus.
    require_search_edit_focus(window_handle, edit)

    # The native popup can rebuild its UIA descendants immediately after the
    # outer strict preflight. Require two consecutive complete ordered content
    # snapshots before deriving any key count. Foreground/focus loss and
    # multiple exact target rows remain immediate fail-closed conditions.
    stabilization_deadline = time.monotonic() + max(
        0.1,
        min(MAX_SEARCH_RESULT_STABILIZATION_SECONDS, timeout),
    )
    last_identity_error = "exact search result was not materialized"
    previous_identity: tuple[tuple[Any, ...], ...] | None = None
    stable_rows: list[automation.Control] | None = None
    stable_identity: tuple[tuple[Any, ...], ...] | None = None
    target_index = -1
    polls = 0
    while True:
        polls += 1
        require_foreground_continuity(window_handle)
        require_search_edit_focus(window_handle, edit)
        candidates = find_controls_by_automation_id(
            root,
            f"search_item_{contact}",
            max_depth=32,
        )
        if len(candidates) > 1:
            raise TargetNotConfirmedError(
                f"exact search result became ambiguous before Enter: count={len(candidates)}"
            )
        if len(candidates) == 1:
            observed = candidates[0]
            if (
                exact_search_result_shape_matches(observed, contact)
                and strict_search_result_context_matches(root, observed)
            ):
                try:
                    rows, identity = ordered_strict_search_content_rows(root)
                except TargetNotConfirmedError as error:
                    # Weixin publishes the popup one UIA tick before every row is
                    # visible/activatable and before the ordered identity is
                    # unambiguous, so the ordered walk legitimately fails on the
                    # first polls (measured on live Weixin: a transient failure in
                    # 6 of 10 runs, always settling within one or two polls).
                    # That is exactly the not-yet-materialized state this loop
                    # exists to wait out.  Letting it escape abandons the whole
                    # stabilization window and re-enters through the caller's
                    # shorter budget, which is how one transient popup rebuild
                    # became a hard canary failure.  Retrying here can only delay
                    # approval, never grant it: the loop still requires two
                    # consecutive complete identical ordered snapshots.
                    previous_identity = None
                    last_identity_error = error
                else:
                    target_positions = [
                        index for index, row in enumerate(rows)
                        if exact_search_result_shape_matches(row, contact)
                    ]
                    if len(target_positions) > 1:
                        raise TargetNotConfirmedError(
                            "exact target was ambiguous in the ordered search content list"
                        )
                    if len(target_positions) == 1 and same_exact_control_identity(
                        rows[target_positions[0]],
                        observed,
                    ):
                        if previous_identity == identity:
                            stable_rows = rows
                            stable_identity = identity
                            target_index = target_positions[0]
                            break
                        previous_identity = identity
                        last_identity_error = (
                            "ordered search content identity had not repeated yet"
                        )
                    else:
                        previous_identity = None
                        last_identity_error = (
                            "exact target was missing from the ordered search content list"
                        )
            else:
                previous_identity = None
                last_identity_error = "exact search result identity was not fully materialized"
        else:
            previous_identity = None
            last_identity_error = "exact search result was not materialized"
        remaining = stabilization_deadline - time.monotonic()
        if remaining <= 0:
            raise TargetNotConfirmedError(
                "exact search result was not stably confirmed before Enter: "
                f"{last_identity_error} "
                f"(polls={polls}, window={min(MAX_SEARCH_RESULT_STABILIZATION_SECONDS, timeout):.1f}s)"
            )
        time.sleep(min(0.1, remaining))

    assert stable_rows is not None and stable_identity is not None and target_index >= 0
    # Live Weixin proves that a plain Enter activates content index zero. Each
    # Down advances one SearchContentCellView, while category headers are
    # skipped. Thus the unique target's ordered content index is also the exact
    # Down count. Keep the navigation small and deterministic.
    down_count = target_index
    if down_count > MAX_SEARCH_NAVIGATION_DOWNS:
        raise TargetNotConfirmedError(
            "exact search result required too many navigation steps: "
            f"downs={down_count}, maximum={MAX_SEARCH_NAVIGATION_DOWNS}"
        )

    def require_unchanged_order_and_target() -> automation.Control:
        require_foreground_continuity(window_handle)
        require_search_edit_focus(window_handle, edit)
        rows, identity = ordered_strict_search_content_rows(root)
        if identity != stable_identity:
            raise TargetNotConfirmedError(
                "ordered search content identity changed during keyboard navigation"
            )
        target_rows = [
            row for row in rows if exact_search_result_shape_matches(row, contact)
        ]
        if len(target_rows) != 1:
            raise TargetNotConfirmedError(
                f"exact target changed during keyboard navigation: count={len(target_rows)}"
            )
        require_safe_search_result_target(window_handle, root, target_rows[0])
        require_foreground_continuity(window_handle)
        require_search_edit_focus(window_handle, edit)
        return target_rows[0]

    require_unchanged_order_and_target()
    for _index in range(down_count):
        require_unchanged_order_and_target()
        try:
            automation.SendKeys("{Down}", waitTime=0.05)
        except Exception as error:
            raise TargetNotConfirmedError(
                f"guarded search Down could not be issued: {error}"
            ) from error
        time.sleep(0.12)
        require_unchanged_order_and_target()

    require_unchanged_order_and_target()
    try:
        automation.SendKeys("{Enter}", waitTime=0.05)
    except Exception as error:
        raise TargetNotConfirmedError(
            f"guarded search Enter could not be issued: {error}"
        ) from error
    require_foreground_continuity(window_handle)
    return wait_for_fresh_session_confirmation(
        root,
        contact,
        max(MIN_SEARCH_SELECTION_CONFIRM_SECONDS, timeout),
        source="search",
    )


def replace_main_session_search_text(
    window_handle: int,
    root: automation.Control,
    text: str,
    *,
    verify_timeout: float = 0.75,
) -> None:
    """Replace search text with literal Unicode input and verify the UIA value."""
    edits = find_main_session_search_edits(root)
    if len(edits) != 1:
        raise TargetNotConfirmedError(
            f"main session search field was not unique: count={len(edits)}"
        )
    edit = edits[0]
    try:
        value_pattern = edit.GetPattern(automation.PatternId.ValuePattern)
    except Exception:
        value_pattern = None
    if value_pattern is None:
        raise TargetNotConfirmedError("main session search field does not support ValuePattern")
    try:
        edit.SetFocus()
        require_search_edit_focus(window_handle, edit)
    except DesktopActiveError:
        raise
    except Exception as error:
        raise TargetNotConfirmedError(f"main session search field could not be focused: {error}") from error
    try:
        automation.SendKeys("{Ctrl}a", waitTime=0.02)
        automation.SendKeys("{Delete}", waitTime=0.02)
        require_search_edit_focus(window_handle, edit)
        for character in text:
            require_search_edit_focus(window_handle, edit)
            # Providers return None/1/2 inconsistently even when SendInput
            # succeeds; the exact ValuePattern check below is authoritative.
            automation.SendUnicodeChar(character)
        require_search_edit_focus(window_handle, edit)
    except (DesktopActiveError, TargetNotConfirmedError):
        raise
    except Exception as error:
        raise TargetNotConfirmedError(f"literal search input failed: {error}") from error

    deadline = time.monotonic() + max(0.1, verify_timeout)
    observed = ""
    while True:
        try:
            observed = str(value_pattern.Value or "")
        except Exception:
            observed = ""
        if observed == text:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TargetNotConfirmedError(
                f"main session search value was not confirmed: expected={text!r}, observed={observed!r}"
            )
        time.sleep(min(0.05, remaining))

    if text:
        return
    # Empty search can show a "frequent" popup. Close it with Esc only while the
    # exact search editor still owns focus; Enter is never used for navigation.
    try:
        popups = [
            item for item, _depth in automation.WalkControl(
                root,
                includeTop=True,
                maxDepth=32,
            )
            if exact_search_popup_matches(item)
        ]
    except Exception as error:
        raise TargetNotConfirmedError(
            f"main session search popup cleanup could not be inspected: {error}"
        ) from error
    if popups:
        require_search_edit_focus(window_handle, edit)
        automation.SendKeys("{Esc}", waitTime=0.05)

    # A lingering result could cover the chat editor selected by the caller.
    popup_deadline = time.monotonic() + max(0.1, verify_timeout)
    while True:
        popups: list[automation.Control] = []
        try:
            popups = [
                item for item, _depth in automation.WalkControl(
                    root,
                    includeTop=True,
                    maxDepth=32,
                )
                if exact_search_popup_matches(item)
            ]
        except Exception as error:
            raise TargetNotConfirmedError(
                f"main session search popup cleanup could not be inspected: {error}"
            ) from error
        if not popups:
            return
        remaining = popup_deadline - time.monotonic()
        if remaining <= 0:
            raise TargetNotConfirmedError("main session search popup did not close after clearing")
        time.sleep(min(0.05, remaining))


def named_search_list_items(
    root: automation.Control,
    contact: str,
) -> list[automation.Control]:
    matches: list[automation.Control] = []
    try:
        for control, _depth in automation.WalkControl(root, includeTop=True, maxDepth=32):
            if (
                first_name_line(control.Name) == contact
                and normalize_text(control.ControlTypeName) == "ListItemControl"
                and visible_enabled_control(control)
                and control_has_ancestor(control, automation_id="search_list")
            ):
                matches.append(control)
    except Exception:
        return []
    return matches


def confirm_current_chat_target(
    root: automation.Control,
    contact: str,
) -> automation.Control:
    headers = find_controls_by_automation_id(
        root,
        "current_chat_name_label",
        max_depth=32,
        allow_hierarchical_suffix=True,
        expected_class_name="mmui::XTextView",
        expected_control_type_name="TextControl",
    )
    inputs = find_controls_by_automation_id(
        root,
        "chat_input_field",
        max_depth=32,
        expected_class_name="mmui::ChatInputField",
        expected_control_type_name="EditControl",
    )
    if len(headers) != 1 or first_name_line(headers[0].Name) != contact:
        observed = [first_name_line(item.Name) for item in headers]
        raise TargetNotConfirmedError(
            f"exact current chat title was not confirmed: expected={contact!r}, observed={observed!r}"
        )
    if len(inputs) != 1 or not chat_input_name_matches_contact(inputs[0].Name, contact):
        observed = [first_name_line(item.Name) for item in inputs]
        raise TargetNotConfirmedError(
            f"exact chat input target was not confirmed: expected={contact!r}, observed={observed!r}"
        )
    return inputs[0]


def get_chat_input_value_pattern(
    input_control: automation.Control,
) -> Any:
    """Return the chat editor's writable ValuePattern or fail before Enter.

    Text dispatch deliberately does not fall back to the Windows clipboard.
    A provider/version that cannot expose a writable, exactly readable editor is
    therefore treated as an unsupported pre-dispatch state.
    """
    try:
        value_pattern = input_control.GetPattern(automation.PatternId.ValuePattern)
    except Exception as error:
        raise TargetNotConfirmedError(
            f"confirmed chat input ValuePattern could not be acquired: {error}"
        ) from error
    if value_pattern is None:
        raise TargetNotConfirmedError(
            "confirmed chat input does not expose a writable ValuePattern"
        )
    return value_pattern


def read_chat_input_value(value_pattern: Any) -> str:
    try:
        value = value_pattern.Value
    except Exception as error:
        raise TargetNotConfirmedError(
            f"confirmed chat input value could not be read: {error}"
        ) from error
    return "" if value is None else str(value)


def write_chat_input_without_clipboard(
    input_control: automation.Control,
    text: str,
    *,
    verify_timeout: float = CHAT_INPUT_VALUE_VERIFY_TIMEOUT_SECONDS,
) -> Any:
    """Write an empty chat editor through UIA and prove the exact value.

    Refusing to overwrite a non-empty editor protects a user's unsent draft and
    prevents stale text left by another operation from being submitted.  The
    returned pattern is retained so a caller can best-effort clear an unsent
    exact payload if a later foreground/focus gate fails.
    """
    value_pattern = get_chat_input_value_pattern(input_control)
    existing = read_chat_input_value(value_pattern)
    if existing:
        raise TargetNotConfirmedError(
            "confirmed chat input was not empty before dispatch"
        )
    try:
        value_pattern.SetValue(text)
    except Exception as error:
        clear_unsent_chat_input_value(value_pattern, text)
        raise TargetNotConfirmedError(
            f"confirmed chat input could not be written through ValuePattern: {error}"
        ) from error

    deadline = time.monotonic() + max(0.1, float(verify_timeout))
    try:
        while True:
            current_value = read_chat_input_value(value_pattern)
            if current_value == text:
                return value_pattern
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.03, remaining))
    except Exception:
        clear_unsent_chat_input_value(value_pattern, text)
        raise

    # The provider may have accepted a partial/stale value.  Do not clear that
    # value: it may already include concurrent user input.  Cleanup is safe only
    # when the editor still contains the exact payload written by this dispatch.
    clear_unsent_chat_input_value(value_pattern, text)
    raise TargetNotConfirmedError(
        "confirmed chat input did not expose the exact requested text after ValuePattern write"
    )


def clear_unsent_chat_input_value(value_pattern: Any, expected_text: str) -> None:
    """Best-effort cleanup without erasing text changed by a user/provider."""
    try:
        if read_chat_input_value(value_pattern) == expected_text:
            value_pattern.SetValue("")
    except Exception:
        pass


def select_exact_contact_session(
    window_handle: int,
    contact: str,
    *,
    timeout: float = 2.5,
) -> tuple[automation.Control, automation.Control]:
    root = automation.ControlFromHandle(window_handle)
    if root is None:
        raise TargetNotConfirmedError("WeChat UI Automation root was unavailable")
    if not is_wechat_main_window_identity(
        class_name=normalize_text(root.ClassName),
        control_type_name=normalize_text(root.ControlTypeName),
    ):
        raise TargetNotConfirmedError("WeChat UI Automation root was not the strict main window")
    expected_session_id = f"session_item_{contact}"
    direct_candidates = find_controls_by_automation_id(root, expected_session_id, max_depth=32)
    if len(direct_candidates) > 1:
        names = [first_name_line(item.Name) for item in direct_candidates]
        raise TargetNotConfirmedError(
            f"exact main session was ambiguous: id={expected_session_id!r}, names={names!r}"
        )
    if direct_candidates and (
        not exact_session_row_matches(direct_candidates[0], contact)
        or not control_has_ancestor(direct_candidates[0], automation_id="session_list")
    ):
        names = [first_name_line(item.Name) for item in direct_candidates]
        raise TargetNotConfirmedError(
            f"main session identity mismatch: expected={contact!r}, observed={names!r}"
        )
    if len(direct_candidates) == 1:
        select_session_item_and_confirm(
            window_handle,
            root,
            direct_candidates[0],
            contact,
            timeout=timeout,
            source="main",
        )
        # Re-apply the full direct-main proof so this route never inherits the
        # search-only allowance for a not-yet-materialized row.
        return root, confirm_fresh_session_state(root, contact, source="main")

    selected = False
    selection_error: Exception | None = None
    cleanup_error: Exception | None = None
    try:
        replace_main_session_search_text(window_handle, root, contact)
        deadline = time.monotonic() + max(0.25, timeout)
        last_count = 0
        last_names: list[str] = []
        last_identity_error: Exception | None = None
        while time.monotonic() < deadline:
            expected_search_id = f"search_item_{contact}"
            candidates = find_controls_by_automation_id(root, expected_search_id, max_depth=32)
            last_count = len(candidates)
            last_names = [first_name_line(item.Name) for item in candidates]
            if len(candidates) > 1:
                raise TargetNotConfirmedError(
                    f"main search returned multiple exact results: names={last_names!r}"
                )
            if len(candidates) == 1 and (
                not exact_search_result_shape_matches(candidates[0], contact)
                or not strict_search_result_context_matches(root, candidates[0])
            ):
                # Weixin may publish the row one UIA tick before its ordered
                # search_list/popup ancestors. Poll read-only until the same
                # bounded deadline; no provider action is attempted yet.
                last_identity_error = TargetNotConfirmedError(
                    f"main search result identity mismatch: expected={contact!r}, observed={last_names!r}"
                )
                time.sleep(0.1)
                continue
            if len(candidates) == 1:
                # Keyboard-only route.  The mid-loop hit-test/owner/bounds
                # re-verification that used to run here existed to certify a
                # physical click point, and the physical click is gone.  The
                # downstream selector is itself strict: it re-derives the exact
                # ordered search content rows, requires one unique exact row,
                # proves search-edit focus and foreground continuity around every
                # Down, and issues exactly one Enter.  Gate only on the row's
                # identity shape (automation id + name + class + type + enabled),
                # which was just verified above.
                #
                # The selector's own guards can still fail on a transient state
                # that settles by itself: the search popup is published one UIA
                # tick before its native HWND owner is set, so an owner check can
                # legitimately report "not owned" on the first poll.  That is a
                # not-yet-materialized condition, not a wrong target, so retry
                # read-only within the existing deadline instead of failing the
                # whole selection.  DesktopActiveError stays fatal because it
                # means the user took over the desktop.
                try:
                    select_exact_search_result_with_enter(
                        window_handle,
                        root,
                        contact,
                        timeout=max(
                            MIN_SEARCH_SELECTION_CONFIRM_SECONDS,
                            deadline - time.monotonic(),
                        ),
                    )
                except DesktopActiveError:
                    raise
                except TargetNotConfirmedError as error:
                    last_identity_error = error
                    time.sleep(0.1)
                    continue
                selected = True
                break
            collisions = named_search_list_items(root, contact)
            # An exact result whose outer `search_item_<contact>` wrapper has not
            # materialized yet is indistinguishable from a collision through the
            # name/ancestry walk alone: live Weixin publishes the inner
            # SearchContentCellView one UIA tick before the wrapper that
            # find_controls_by_automation_id keys on, so the wrapper is absent
            # from `candidates` while this walk already sees the row.  Treat that
            # single, expected automation id as not-yet-materialized and keep
            # polling read-only within the existing deadline rather than failing
            # the whole selection.  Any other colliding row is still fatal.
            expected_search_id = f"search_item_{contact}"
            collisions = [
                item for item in collisions
                if normalize_text(item.AutomationId) != expected_search_id
            ]
            if collisions:
                shapes = [
                    (
                        normalize_text(item.AutomationId),
                        normalize_text(item.ClassName),
                        normalize_text(item.ControlTypeName),
                    )
                    for item in collisions
                ]
                raise TargetNotConfirmedError(
                    f"main search returned a non-session identity collision: {shapes!r}"
                )
            time.sleep(0.1)
        if not selected:
            if last_identity_error is not None:
                raise TargetNotConfirmedError(
                    f"exact main search identity was not confirmed before deadline: {last_identity_error}"
                ) from last_identity_error
            raise TargetNotConfirmedError(
                f"exact main search result was not found: count={last_count}, names={last_names!r}"
            )
    except Exception as error:
        selection_error = error
    finally:
        try:
            replace_main_session_search_text(window_handle, root, "")
        except Exception as error:
            cleanup_error = error
    if selection_error is not None and cleanup_error is not None:
        raise TargetNotConfirmedError(
            f"selection failed: {selection_error}; search cleanup also failed: {cleanup_error}"
        ) from selection_error
    if cleanup_error is not None:
        raise TargetNotConfirmedError(
            f"main session search cleanup was not confirmed: {cleanup_error}"
        ) from cleanup_error
    if selection_error is not None:
        raise selection_error
    # Clearing the search popover can change selection/focus. Re-read both
    # exact current-chat labels from the same strict main root only after the
    # popover has closed, with foreground continuity on both sides of the read.
    require_foreground_continuity(window_handle)
    confirmed_input = confirm_fresh_session_state(root, contact, source="search")
    require_foreground_continuity(window_handle)
    return root, confirmed_input


class BridgeState:
    def __init__(self, args: argparse.Namespace) -> None:
        self.weflow_base_url = args.weflow_base_url.rstrip("/")
        self.weflow_token = args.weflow_token
        self._contacts_cache: tuple[float, list[dict[str, Any]]] | None = None
        self.state_file = Path(args.state_file)
        self.desktop_input_lease_dir = (
            self.state_file.parent / MODEL_CANARY_LEASE_DIRECTORY
        )
        self.image_root = Path(args.image_root).expanduser().resolve(strict=False)
        self.max_image_bytes = max(1, int(args.max_image_bytes))
        self.send_lock = threading.Lock()
        self.source_lock = threading.Lock()
        self.send_source = self._load_source()

    @staticmethod
    def _model_canary_target_fingerprint(contact: str, talker: str) -> str:
        return hashlib.sha256(f"{contact}\n{talker}".encode("utf-8")).hexdigest()

    @staticmethod
    def _parse_lease_expiry(value: Any) -> tuple[str, float]:
        text = normalize_text(value)
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_INVALID",
                "model canary desktop input lease expiry is invalid",
            ) from None
        if parsed.tzinfo is None:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_INVALID",
                "model canary desktop input lease expiry must include a timezone",
            )
        return text, parsed.timestamp()

    def _desktop_input_lease_path(self, run_id: str) -> Path:
        normalized = normalize_text(run_id).lower()
        if not MODEL_CANARY_RUN_ID_PATTERN.fullmatch(normalized):
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_INVALID",
                "model canary desktop input lease run identity is invalid",
            )
        return self.desktop_input_lease_dir / f"{normalized}.json"

    def _desktop_input_lease_claim_path(self, run_id: str) -> Path:
        lease_path = self._desktop_input_lease_path(run_id)
        return lease_path.with_name(f"{lease_path.name}.claim")

    @staticmethod
    def _atomic_write_private_json(file_path: Path, payload: dict[str, Any]) -> None:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = file_path.with_name(
            f".{file_path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        try:
            descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                output.write(encoded)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, file_path)
            try:
                os.chmod(file_path, 0o600)
            except OSError:
                pass
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _atomic_create_private_json(file_path: Path, payload: dict[str, Any]) -> None:
        """Create a private JSON record without replacing an existing owner."""
        file_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = file_path.with_name(
            f".{file_path.name}.{os.getpid()}.{threading.get_ident()}.{secrets.token_hex(4)}.tmp"
        )
        encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as output:
                descriptor = -1
                output.write(encoded)
                output.flush()
                os.fsync(output.fileno())
            # Publishing a hard link is atomic and fails if another process has
            # already created the destination. Readers therefore never observe
            # a partially written issue or claim record.
            os.link(temporary, file_path)
            try:
                os.chmod(file_path, 0o600)
            except OSError:
                pass
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def validate_desktop_input_lease_request(
        self,
        request: Any,
        *,
        contact: str,
        talker: str,
        text: str,
    ) -> dict[str, Any]:
        if not isinstance(request, dict) or set(request) != {
            "version",
            "mode",
            "runId",
            "nonce",
            "targetFingerprint",
            "replyIdempotencyKey",
            "expiresAt",
        }:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_INVALID",
                "model canary desktop input lease request shape is invalid",
            )
        run_id = normalize_text(request.get("runId")).lower()
        nonce = normalize_text(request.get("nonce")).lower()
        target_fingerprint = normalize_text(request.get("targetFingerprint")).lower()
        reply_idempotency_key = normalize_text(request.get("replyIdempotencyKey"))
        expected_target_fingerprint = self._model_canary_target_fingerprint(contact, talker)
        expected_trigger = f"[Cyberboss心跳模型探针 trigger={run_id} nonce={nonce}]"
        expected_idempotency_key = f"model-canary-reply:{run_id}"
        expires_at, expires_at_epoch = self._parse_lease_expiry(request.get("expiresAt"))
        now_epoch = time.time()
        if (
            request.get("version") != MODEL_CANARY_LEASE_VERSION
            or normalize_text(request.get("mode")) != "model_e2e"
            or not MODEL_CANARY_RUN_ID_PATTERN.fullmatch(run_id)
            or not MODEL_CANARY_NONCE_PATTERN.fullmatch(nonce)
            or not MODEL_CANARY_FINGERPRINT_PATTERN.fullmatch(target_fingerprint)
            or target_fingerprint != expected_target_fingerprint
            or reply_idempotency_key != expected_idempotency_key
            or text != expected_trigger
            or expires_at_epoch <= now_epoch
            or expires_at_epoch > now_epoch + MODEL_CANARY_MAX_LEASE_SECONDS
        ):
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_INVALID",
                "model canary desktop input lease request binding is invalid",
            )
        return {
            "version": MODEL_CANARY_LEASE_VERSION,
            "mode": "model_e2e",
            "runId": run_id,
            "nonce": nonce,
            "targetFingerprint": target_fingerprint,
            "replyIdempotencyKey": reply_idempotency_key,
            "expiresAt": expires_at,
        }

    def issue_desktop_input_lease(
        self,
        request: dict[str, Any],
        *,
        contact: str,
        talker: str,
        text: str,
        last_input_tick: int,
    ) -> dict[str, Any]:
        checked = self.validate_desktop_input_lease_request(
            request,
            contact=contact,
            talker=talker,
            text=text,
        )
        lease_path = self._desktop_input_lease_path(checked["runId"])
        if lease_path.exists():
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_ALREADY_ISSUED",
                "model canary desktop input lease was already issued",
            )
        token = secrets.token_hex(32)
        issued_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        record = {
            **checked,
            "status": "issued",
            "contact": contact,
            "talker": talker,
            "triggerTextSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "replyTextSha256": hashlib.sha256(
                f"[Cyberboss心跳模型正常 trigger={checked['runId']}]".encode("utf-8")
            ).hexdigest(),
            # The runner receipt also stores this opaque token. Keeping the same
            # value in the bridge's private record closes the Enter-to-HTTP-
            # response crash gap: a restarted runner can reconstruct the
            # manifest-bound receipt without issuing or sending anything again.
            "token": token,
            "tokenSha256": hashlib.sha256(token.encode("ascii")).hexdigest(),
            "lastInputTick": int(last_input_tick) & 0xFFFFFFFF,
            "issuedAt": issued_at,
        }
        try:
            self._atomic_create_private_json(lease_path, record)
        except FileExistsError:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_ALREADY_ISSUED",
                "model canary desktop input lease was already issued",
            ) from None
        return {
            **checked,
            "token": token,
            "lastInputTick": record["lastInputTick"],
            "issuedAt": issued_at,
        }

    def claim_desktop_input_lease(
        self,
        lease: Any,
        *,
        contact: str,
        talker: str,
        text: str,
    ) -> dict[str, Any]:
        if not isinstance(lease, dict) or set(lease) != {
            "version",
            "mode",
            "runId",
            "nonce",
            "targetFingerprint",
            "replyIdempotencyKey",
            "expiresAt",
            "token",
        }:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_INVALID",
                "model canary desktop input lease shape is invalid",
            )
        run_id = normalize_text(lease.get("runId")).lower()
        token = normalize_text(lease.get("token")).lower()
        lease_path = self._desktop_input_lease_path(run_id)
        try:
            record = json.loads(lease_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_UNKNOWN",
                "model canary desktop input lease record is missing or unreadable",
            ) from None
        if not isinstance(record, dict):
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_UNKNOWN",
                "model canary desktop input lease record is malformed",
            )
        expected_target_fingerprint = self._model_canary_target_fingerprint(contact, talker)
        expected_reply = f"[Cyberboss心跳模型正常 trigger={run_id}]"
        expected_idempotency_key = f"model-canary-reply:{run_id}"
        expires_at, expires_at_epoch = self._parse_lease_expiry(lease.get("expiresAt"))
        record_token_hash = normalize_text(record.get("tokenSha256")).lower()
        record_token = normalize_text(record.get("token")).lower()
        supplied_token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
        try:
            record_version = int(record.get("version", 0))
        except (TypeError, ValueError):
            record_version = 0
        if (
            lease.get("version") != MODEL_CANARY_LEASE_VERSION
            or normalize_text(lease.get("mode")) != "model_e2e"
            or not MODEL_CANARY_RUN_ID_PATTERN.fullmatch(run_id)
            or not MODEL_CANARY_NONCE_PATTERN.fullmatch(normalize_text(lease.get("nonce")).lower())
            or not MODEL_CANARY_FINGERPRINT_PATTERN.fullmatch(
                normalize_text(lease.get("targetFingerprint")).lower()
            )
            or not MODEL_CANARY_LEASE_TOKEN_PATTERN.fullmatch(token)
            or normalize_text(record.get("status")) != "issued"
            or record_version != MODEL_CANARY_LEASE_VERSION
            or normalize_text(record.get("mode")) != "model_e2e"
            or normalize_text(record.get("runId")).lower() != run_id
            or normalize_text(record.get("nonce")).lower()
                != normalize_text(lease.get("nonce")).lower()
            or normalize_text(record.get("targetFingerprint")).lower()
                != normalize_text(lease.get("targetFingerprint")).lower()
            or normalize_text(record.get("targetFingerprint")).lower() != expected_target_fingerprint
            or normalize_text(record.get("replyIdempotencyKey"))
                != normalize_text(lease.get("replyIdempotencyKey"))
            or normalize_text(record.get("replyIdempotencyKey")) != expected_idempotency_key
            or normalize_text(record.get("expiresAt")) != expires_at
            or normalize_text(record.get("contact")) != contact
            or normalize_text(record.get("talker")) != talker
            or normalize_text(record.get("replyTextSha256")).lower()
                != hashlib.sha256(expected_reply.encode("utf-8")).hexdigest()
            or text != expected_reply
            or not MODEL_CANARY_LEASE_TOKEN_PATTERN.fullmatch(record_token)
            or not hmac.compare_digest(record_token, token)
            or not MODEL_CANARY_FINGERPRINT_PATTERN.fullmatch(record_token_hash)
            or not hmac.compare_digest(record_token_hash, supplied_token_hash)
            or expires_at_epoch <= time.time()
        ):
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_INVALID",
                "model canary desktop input lease binding is invalid",
            )
        try:
            current_tick = get_last_input_tick()
            expected_tick = int(record.get("lastInputTick")) & 0xFFFFFFFF
        except (OSError, TypeError, ValueError):
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_UNKNOWN",
                "model canary desktop input lease continuity is unavailable",
            ) from None
        if current_tick != expected_tick:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_STALE",
                "desktop input changed after the model canary trigger",
            )
        claimed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        try:
            self._atomic_create_private_json(
                self._desktop_input_lease_claim_path(run_id),
                {
                    "version": MODEL_CANARY_LEASE_VERSION,
                    "mode": "model_e2e",
                    "runId": run_id,
                    "tokenSha256": record_token_hash,
                    "claimedAt": claimed_at,
                },
            )
        except FileExistsError:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_ALREADY_CLAIMED",
                "model canary desktop input lease already has a durable consumer claim",
            ) from None
        claimed = {
            **record,
            "status": "claimed",
            "claimedAt": claimed_at,
        }
        self._atomic_write_private_json(lease_path, claimed)
        return {**claimed, "leasePath": str(lease_path)}

    def consume_desktop_input_lease(self, claimed: dict[str, Any]) -> None:
        run_id = normalize_text(claimed.get("runId")).lower()
        lease_path = Path(normalize_text(claimed.get("leasePath")))
        expected_path = self._desktop_input_lease_path(run_id)
        if lease_path != expected_path:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_INVALID",
                "model canary desktop input lease path is invalid",
            )
        consumed = {
            key: value for key, value in claimed.items() if key not in {"leasePath", "token"}
        }
        consumed.update({
            "status": "consumed",
            "consumedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        })
        self._atomic_write_private_json(lease_path, consumed)

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

    def fetch_contacts(
        self,
        request_timeout: float = 3.0,
    ) -> list[dict[str, Any]]:
        """Read the contact table (cached briefly - remarks change rarely)."""
        cached = self._contacts_cache
        if cached is not None and (time.monotonic() - cached[0]) < CONTACT_CACHE_TTL_SECONDS:
            return cached[1]
        request = urllib.request.Request(
            f"{self.weflow_base_url}/api/v1/contacts",
            headers={"Authorization": f"Bearer {self.weflow_token}"},
        )
        with urllib.request.urlopen(request, timeout=max(0.5, request_timeout)) as response:
            payload = json.load(response)
        if isinstance(payload, dict):
            raw = payload.get("contacts")
        elif isinstance(payload, list):
            raw = payload
        else:
            raw = None
        if not isinstance(raw, list):
            raise ValueError("weflow contacts payload did not contain a contact list")
        contacts = [item for item in raw if isinstance(item, dict)]
        self._contacts_cache = (time.monotonic(), contacts)
        return contacts

    def resolve_target_names(
        self,
        contact: str,
        talker: str,
        request_timeout: float = 3.0,
    ) -> dict[str, Any] | None:
        """Resolve the talker's row/editor names, or None when unresolvable.

        Any failure (network, payload shape, unknown contact) returns None so the
        caller keeps its previous single-name behaviour instead of degrading.
        """
        try:
            contacts = self.fetch_contacts(request_timeout=request_timeout)
        except (OSError, ValueError, urllib.error.URLError, TimeoutError) as error:
            logger.warning("contact resolution skipped: %s", error)
            return None
        resolved = resolve_contact_names(contact, talker, contacts)
        if resolved is None:
            logger.warning(
                "contact resolution found no row: requested=%r talker=%r",
                contact,
                talker,
            )
            return None
        if resolved["rowName"] != first_name_line(contact) or resolved["editorName"] != first_name_line(contact):
            logger.info(
                "contact names resolved: requested=%r talker=%r row=%r editor=%r accepted=%r",
                contact,
                talker,
                resolved["rowName"],
                resolved["editorName"],
                resolved["accepted"],
            )
        return resolved

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
    def message_matches(
        message: dict[str, Any],
        text: str,
        expected_talker: str = "",
    ) -> bool:
        is_sent = message.get("isSend", message.get("is_send", False))
        if is_sent not in (True, 1, "1"):
            return False
        if expected_talker:
            sender = normalize_text(
                message.get("senderUsername", message.get("sender_username", ""))
            )
            if sender != expected_talker:
                return False
        content = message.get("content", message.get("text", ""))
        return str(content or "") == text

    @staticmethod
    def message_matches_image(message: dict[str, Any]) -> bool:
        is_sent = message.get("isSend", message.get("is_send", False))
        if is_sent not in (True, 1, "1"):
            return False

        for key in ("localType", "local_type", "messageType", "message_type", "msgType", "msg_type"):
            value = message.get(key)
            try:
                if value is not None and int(value) == 3:
                    return True
            except (TypeError, ValueError):
                continue

        media_type = normalize_text(
            message.get("mediaType", message.get("media_type", message.get("kind", "")))
        ).lower()
        if media_type in {"image", "photo", "picture"}:
            return True

        for key in ("content", "parsedContent", "parsed_content", "text"):
            content = normalize_text(message.get(key)).lower()
            if content in {"[图片]", "[image]", "[photo]", "[picture]"}:
                return True
        return False

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

    def dispatch_and_verify(
        self,
        contact: str,
        talker: str,
        text: str,
        timeout: float,
        require_desktop_idle_seconds: int | None = None,
        exact_contact: bool = False,
        expected_contact: str = "",
        expected_talker: str = "",
        desktop_input_lease_request: dict[str, Any] | None = None,
        desktop_input_lease: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self.send_lock:
            if exact_contact:
                if normalize_text(expected_contact) != contact:
                    raise TargetNotConfirmedError("exact contact identity did not match the requested contact")
                if normalize_text(expected_talker) != talker:
                    raise TargetNotConfirmedError("exact talker identity did not match the verification talker")
            baseline_available = True
            try:
                before = {
                    self.message_id(message)
                    for message in self.fetch_messages(
                        talker,
                        request_timeout=min(3.0, max(0.75, timeout / 3)),
                    )
                    if self.message_matches(message, text, expected_talker if exact_contact else "")
                }
            except (OSError, ValueError, urllib.error.URLError, TimeoutError):
                # Dispatch still proceeds when the read API is briefly slow. A
                # timestamp fence below prevents an older identical row from
                # being mistaken for the new delivery.
                baseline_available = False
                before = set()
            dispatched_after = int(time.time()) - 2
            with uia_com_apartment():
                if desktop_input_lease_request is not None or desktop_input_lease is not None:
                    target = self._dispatch_text(
                        contact,
                        text,
                        require_desktop_idle_seconds=require_desktop_idle_seconds,
                        exact_contact=exact_contact,
                        talker=talker,
                        desktop_input_lease_request=desktop_input_lease_request,
                        desktop_input_lease=desktop_input_lease,
                    )
                else:
                    target = self._dispatch_text(
                        contact,
                        text,
                        require_desktop_idle_seconds=require_desktop_idle_seconds,
                        exact_contact=exact_contact,
                    )
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
                        if self.message_matches(
                            message,
                            text,
                            expected_talker if exact_contact else "",
                        ) and is_new:
                            result = {
                                "dispatched": True,
                                "verified": True,
                                "localId": message_id,
                            }
                            if exact_contact:
                                result.update({
                                    "targetVerified": True,
                                    "selectedContact": contact,
                                    "verifiedTalker": talker,
                                    "target": target,
                                })
                            if isinstance(target.get("desktopInputLease"), dict):
                                result["desktopInputLease"] = target["desktopInputLease"]
                            return result
                except (OSError, ValueError, urllib.error.URLError) as error:
                    last_error = str(error)
                time.sleep(0.35)
            detail = f" ({last_error})" if last_error else ""
            result = {
                "dispatched": True,
                "verified": False,
                "uncertain": True,
                "verificationError": f"outgoing message was not observed in WeFlow before timeout{detail}",
            }
            if exact_contact:
                result.update({
                    "targetVerified": True,
                    "selectedContact": contact,
                    "verifiedTalker": talker,
                    "target": target,
                })
            if isinstance(target.get("desktopInputLease"), dict):
                result["desktopInputLease"] = target["desktopInputLease"]
            return result

    def load_validated_png(self, file_path: str, expected_sha256: str) -> tuple[Path, bytes, str]:
        normalized_path = normalize_text(file_path)
        normalized_digest = normalize_text(expected_sha256).lower()
        if not normalized_path:
            raise ValueError("filePath is required")
        if len(normalized_digest) != 64 or any(character not in "0123456789abcdef" for character in normalized_digest):
            raise ValueError("sha256 must be a 64-character hexadecimal digest")

        requested_path = Path(normalized_path).expanduser()
        if not requested_path.is_absolute():
            raise ValueError("filePath must be absolute")
        try:
            resolved_path = requested_path.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ValueError(f"image file could not be resolved: {error}") from error
        try:
            resolved_path.relative_to(self.image_root)
        except ValueError as error:
            raise ValueError("image file is outside the managed image root") from error

        try:
            file_stat = resolved_path.stat()
        except OSError as error:
            raise ValueError(f"image file could not be inspected: {error}") from error
        if not stat.S_ISREG(file_stat.st_mode):
            raise ValueError("image path must reference a regular file")
        if file_stat.st_size <= len(PNG_SIGNATURE):
            raise ValueError("image file is empty or truncated")
        if file_stat.st_size > self.max_image_bytes:
            raise ValueError(f"image exceeds the {self.max_image_bytes}-byte limit")

        try:
            image_bytes = resolved_path.read_bytes()
        except OSError as error:
            raise ValueError(f"image file could not be read: {error}") from error
        if len(image_bytes) != file_stat.st_size:
            raise ValueError("image file changed while it was being read")
        if not image_bytes.startswith(PNG_SIGNATURE):
            raise ValueError("image file does not have a PNG signature")
        actual_digest = hashlib.sha256(image_bytes).hexdigest()
        if not hmac.compare_digest(actual_digest, normalized_digest):
            raise ValueError("image sha256 does not match the file")

        try:
            with Image.open(io.BytesIO(image_bytes)) as image:
                if image.format != "PNG":
                    raise ValueError("image payload is not a PNG")
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > DEFAULT_MAX_IMAGE_PIXELS:
                    raise ValueError("image dimensions are invalid or too large")
                image.verify()
        except (OSError, SyntaxError, UnidentifiedImageError) as error:
            raise ValueError(f"PNG image validation failed: {error}") from error
        return resolved_path, image_bytes, actual_digest

    def dispatch_image_and_verify(
        self,
        contact: str,
        talker: str,
        file_path: str,
        expected_sha256: str,
        timeout: float,
    ) -> dict[str, Any]:
        # Text and image dispatches intentionally share this lock. WeChat search,
        # editor/clipboard mutation, Enter, and verification form one operation.
        with self.send_lock:
            resolved_path, image_bytes, actual_digest = self.load_validated_png(
                file_path,
                expected_sha256,
            )
            baseline_available = True
            try:
                before = {
                    message_id
                    for message in self.fetch_messages(
                        talker,
                        request_timeout=min(3.0, max(0.75, timeout / 3)),
                    )
                    if self.message_matches_image(message)
                    if (message_id := self.message_id(message))
                }
            except (OSError, ValueError, urllib.error.URLError, TimeoutError):
                baseline_available = False
                before = set()

            dispatched_after = int(time.time()) - 2
            with uia_com_apartment():
                self._dispatch_image(contact, image_bytes)
            deadline = time.monotonic() + max(1.0, timeout)
            last_error = ""
            while time.monotonic() < deadline:
                try:
                    remaining = max(0.5, deadline - time.monotonic())
                    for message in self.fetch_messages(talker, request_timeout=min(3.0, remaining)):
                        if not self.message_matches_image(message):
                            continue
                        message_id = self.message_id(message)
                        message_time = self.message_epoch_seconds(message)
                        is_new = bool(message_id) and message_id not in before and (
                            baseline_available
                            or (message_time > 0 and message_time >= dispatched_after)
                        )
                        if is_new:
                            return {
                                "dispatched": True,
                                "verified": True,
                                "localId": message_id,
                                "filePath": str(resolved_path),
                                "sha256": actual_digest,
                            }
                except (OSError, ValueError, urllib.error.URLError) as error:
                    last_error = str(error)
                time.sleep(0.35)

            detail = f" ({last_error})" if last_error else ""
            return {
                "dispatched": True,
                "verified": False,
                "uncertain": True,
                "filePath": str(resolved_path),
                "sha256": actual_digest,
                "verificationError": f"outgoing image was not observed in WeFlow before timeout{detail}",
            }

    def _dispatch_text(
        self,
        contact: str,
        text: str,
        require_desktop_idle_seconds: int | None = None,
        exact_contact: bool = False,
        talker: str = "",
        desktop_input_lease_request: dict[str, Any] | None = None,
        desktop_input_lease: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        is_model_trigger = bool(MODEL_CANARY_TRIGGER_MARKER_PATTERN.fullmatch(text))
        is_model_reply = bool(MODEL_CANARY_REPLY_MARKER_PATTERN.fullmatch(text))
        if is_model_trigger and desktop_input_lease_request is None:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_MISSING",
                "reserved model canary trigger requires a desktop input lease request",
            )
        if is_model_reply and desktop_input_lease is None:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_MISSING",
                "reserved model canary reply requires its same-run desktop input lease",
            )
        if desktop_input_lease_request is not None and desktop_input_lease is not None:
            raise DesktopInputLeaseError(
                "CANARY_DESKTOP_LEASE_INVALID",
                "model canary lease issuance and use are mutually exclusive",
            )
        claimed_lease: dict[str, Any] | None = None
        if desktop_input_lease is not None:
            if not exact_contact or require_desktop_idle_seconds is not None or not talker:
                raise DesktopInputLeaseError(
                    "CANARY_DESKTOP_LEASE_INVALID",
                    "model canary desktop input lease use route is invalid",
                )
            # This check and durable one-shot claim happen inside send_lock and
            # before any activation, search, chat-editor write, or key.
            claimed_lease = self.claim_desktop_input_lease(
                desktop_input_lease,
                contact=contact,
                talker=talker,
                text=text,
            )
        if desktop_input_lease_request is not None:
            if (
                not exact_contact
                or not talker
                or require_desktop_idle_seconds is None
                or int(require_desktop_idle_seconds) < MIN_CANARY_DESKTOP_IDLE_SECONDS
            ):
                raise DesktopInputLeaseError(
                    "CANARY_DESKTOP_LEASE_INVALID",
                    "model canary desktop input lease issue route is invalid",
                )
            desktop_input_lease_request = self.validate_desktop_input_lease_request(
                desktop_input_lease_request,
                contact=contact,
                talker=talker,
                text=text,
            )
            if self._desktop_input_lease_path(
                str(desktop_input_lease_request["runId"])
            ).exists():
                raise DesktopInputLeaseError(
                    "CANARY_DESKTOP_LEASE_ALREADY_ISSUED",
                    "model canary desktop input lease was already issued",
                )
        window_handle = find_wechat_window_handle(require_chat_window=True)
        if not window_handle:
            raise RuntimeError("WeChat main window was not found")
        input_value_patterns: list[Any] = []
        enter_dispatched = False
        # Canary-only fail-closed check, immediately before the operation that
        # restores and foregrounds WeChat. Ordinary replies omit the field.
        if exact_contact and require_desktop_idle_seconds is None:
            # A canary reply follows the trigger in the same foreground WeChat
            # session. Requiring another five idle minutes here would count the
            # bridge's own injected search keystrokes and self-block. Never steal
            # focus for this chained route: user focus change makes it defer.
            require_foreground_continuity(window_handle)
        else:
            require_desktop_idle(require_desktop_idle_seconds)
        activate_window(window_handle)
        time.sleep(0.25)
        try:
            root, input_control = select_exact_contact_session(window_handle, contact)
            if exact_contact:
                # Reconfirm both exact labels after selection, then watch a
                # quiet gap for competing desktop input before writing.
                input_control = confirm_current_chat_target(root, contact)
                input_control.Click(waitTime=0.05)
                selected_tick = get_last_input_tick()
                require_no_competing_desktop_input(
                    selected_tick,
                    max(MIN_CANARY_DESKTOP_IDLE_SECONDS, int(require_desktop_idle_seconds or 0)),
                )
                input_control = confirm_current_chat_target(root, contact)
                require_foreground_continuity(window_handle)
                require_focused_chat_input(contact)
            else:
                input_control.Click(waitTime=0.05)
                require_foreground_continuity(window_handle)
                require_focused_chat_input(contact)
                selected_tick = get_last_input_tick()

            # UIA ValuePattern is the only supported text-write path.  It avoids
            # reading, replacing, or restoring the user's multi-format Windows
            # clipboard and proves the exact editor value before Enter.
            input_value_pattern = write_chat_input_without_clipboard(input_control, text)
            input_value_patterns.append(input_value_pattern)
            input_control = confirm_current_chat_target(root, contact)
            require_foreground_continuity(window_handle)
            require_focused_chat_input(contact)
            require_no_competing_desktop_input(
                selected_tick,
                max(MIN_CANARY_DESKTOP_IDLE_SECONDS, int(require_desktop_idle_seconds or 0))
                if exact_contact
                else 0,
            )
            # The chat editor can be recreated after SetValue (for example by a
            # late conversation render).  Reacquire ValuePattern from the fresh
            # exact-chat confirmation and prove that this active editor still
            # contains only our payload immediately before Enter.
            fresh_value_pattern = get_chat_input_value_pattern(input_control)
            input_value_patterns.append(fresh_value_pattern)
            if read_chat_input_value(fresh_value_pattern) != text:
                raise TargetNotConfirmedError(
                    "fresh confirmed chat input did not retain the exact requested text before Enter"
                )
            require_foreground_continuity(window_handle)
            require_focused_chat_input(contact)
            automation.SendKeys("{Enter}", waitTime=0.05)
            enter_dispatched = True
            result = {
                "exactContact": bool(exact_contact),
                "selectedContact": contact if exact_contact else "",
            }
            if desktop_input_lease_request is not None:
                # Capture the bridge's own final trigger Enter immediately;
                # later clipboard restoration does not affect LASTINPUTINFO.
                try:
                    trigger_input_tick = get_last_input_tick()
                except Exception:
                    raise DesktopInputLeaseError(
                        "CANARY_DESKTOP_LEASE_UNKNOWN",
                        "model canary trigger input tick could not be captured",
                        dispatched=True,
                    ) from None
                try:
                    result["desktopInputLease"] = self.issue_desktop_input_lease(
                        desktop_input_lease_request,
                        contact=contact,
                        talker=talker,
                        text=text,
                        last_input_tick=trigger_input_tick,
                    )
                except DesktopInputLeaseError as error:
                    error.dispatched = True
                    raise
                except Exception as error:
                    raise DesktopInputLeaseError(
                        "CANARY_DESKTOP_LEASE_UNKNOWN",
                        f"model canary desktop input lease could not be persisted: {error}",
                        dispatched=True,
                    ) from error
            if claimed_lease is not None:
                try:
                    self.consume_desktop_input_lease(claimed_lease)
                except DesktopInputLeaseError as error:
                    error.dispatched = True
                    raise
                except Exception as error:
                    raise DesktopInputLeaseError(
                        "CANARY_DESKTOP_LEASE_UNKNOWN",
                        f"model canary desktop input lease consumption could not be persisted: {error}",
                        dispatched=True,
                    ) from error
            return result
        finally:
            if not enter_dispatched:
                for value_pattern in input_value_patterns:
                    clear_unsent_chat_input_value(value_pattern, text)

    @staticmethod
    def _dispatch_image(contact: str, image_bytes: bytes) -> None:
        window_handle = find_wechat_window_handle(require_chat_window=True)
        if not window_handle:
            raise RuntimeError("WeChat main window was not found")
        previous_clipboard = ""
        clipboard_available = False
        activate_window(window_handle)
        time.sleep(0.25)
        try:
            root, input_control = select_exact_contact_session(window_handle, contact)
            input_control.Click(waitTime=0.05)
            confirm_current_chat_target(root, contact)
            require_foreground_continuity(window_handle)
            try:
                previous_clipboard = pyperclip.paste()
                clipboard_available = True
            except pyperclip.PyperclipException:
                pass
            automation.SendKeys("{Ctrl}a", waitTime=0.05)
            set_clipboard_dib(png_bytes_to_dib(image_bytes))
            automation.SendKeys("{Ctrl}v", waitTime=0.05)
            time.sleep(0.6)
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
        with uia_com_apartment():
            return bool(find_wechat_window_handle(require_chat_window=True))


def png_bytes_to_dib(image_bytes: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            source.load()
            if source.mode in {"RGBA", "LA"} or "transparency" in source.info:
                rgba = source.convert("RGBA")
                image = Image.new("RGB", rgba.size, "white")
                image.paste(rgba, mask=rgba.getchannel("A"))
            else:
                image = source.convert("RGB")
            output = io.BytesIO()
            image.save(output, format="BMP")
    except (OSError, SyntaxError, UnidentifiedImageError) as error:
        raise ValueError(f"PNG could not be converted for the clipboard: {error}") from error
    bitmap = output.getvalue()
    if len(bitmap) <= 14 or bitmap[:2] != b"BM":
        raise ValueError("Pillow returned an invalid BMP clipboard payload")
    return bitmap[14:]


def set_clipboard_dib(dib_bytes: bytes) -> None:
    last_error: Exception | None = None
    for _attempt in range(10):
        opened = False
        try:
            win32clipboard.OpenClipboard()
            opened = True
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32clipboard.CF_DIB, dib_bytes)
            return
        except Exception as error:  # pywin32 exposes platform-specific exception classes.
            last_error = error
        finally:
            if opened:
                win32clipboard.CloseClipboard()
        time.sleep(0.05)
    raise RuntimeError(f"Windows clipboard could not be opened: {last_error}")


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
                exact_contact = payload.get("exactContact", False)
                if not isinstance(exact_contact, bool):
                    raise ValueError("exactContact must be a boolean")
                expected_contact = normalize_text(payload.get("expectedContact"))
                expected_talker = normalize_text(payload.get("expectedTalker"))
                if exact_contact and (not expected_contact or not expected_talker):
                    raise ValueError("expectedContact and expectedTalker are required for exact contact dispatch")
                desktop_idle_requirement = payload.get("requireDesktopIdleSeconds")
                if desktop_idle_requirement is not None:
                    if isinstance(desktop_idle_requirement, bool):
                        raise ValueError("requireDesktopIdleSeconds must be a number")
                    desktop_idle_requirement = max(
                        MIN_CANARY_DESKTOP_IDLE_SECONDS,
                        int(float(desktop_idle_requirement)),
                    )
                desktop_input_lease_request = payload.get("desktopInputLeaseRequest")
                desktop_input_lease = payload.get("desktopInputLease")
                if desktop_input_lease_request is not None and not isinstance(
                    desktop_input_lease_request, dict
                ):
                    raise ValueError("desktopInputLeaseRequest must be an object")
                if desktop_input_lease is not None and not isinstance(desktop_input_lease, dict):
                    raise ValueError("desktopInputLease must be an object")
                if desktop_input_lease_request is not None and desktop_input_lease is not None:
                    raise ValueError("desktop input lease request and use are mutually exclusive")
                if desktop_input_lease_request is not None and (
                    not exact_contact or desktop_idle_requirement is None
                ):
                    raise ValueError(
                        "desktopInputLeaseRequest requires an exact contact and desktop idle gate"
                    )
                if desktop_input_lease is not None and (
                    not exact_contact or desktop_idle_requirement is not None
                ):
                    raise ValueError(
                        "desktopInputLease requires an exact contact without a second idle gate"
                    )
                if not contact or not talker or not text.strip():
                    raise ValueError("contact, talker, and text are required")
                resolved = self.state.resolve_target_names(contact, talker)
                editor_names: tuple[str, ...] = ()
                if resolved is not None:
                    accepted = resolved["accepted"]
                    if exact_contact:
                        # The caller asserts who it believes it is messaging.  With a
                        # remark set, that assertion may be written in either the
                        # remark or the nickname, so accept any name the contact
                        # table lists for this exact talker - and nothing else.
                        for requested_name, label in (
                            (contact, "contact"),
                            (expected_contact, "expectedContact"),
                        ):
                            if requested_name not in accepted:
                                raise TargetNotConfirmedError(
                                    f"{label} {requested_name!r} is not a name of talker "
                                    f"{talker!r}: {accepted!r}"
                                )
                    # Weixin's session row/search row use the display name (the
                    # remark when set) while the chat editor carries the nickname.
                    contact = resolved["rowName"]
                    expected_contact = resolved["rowName"]
                    editor_names = tuple(
                        name
                        for name in (resolved["editorName"],)
                        if name and name != contact
                    )
                dispatch_kwargs: dict[str, Any] = {
                    "require_desktop_idle_seconds": desktop_idle_requirement,
                    "exact_contact": exact_contact,
                    "expected_contact": expected_contact,
                    "expected_talker": expected_talker,
                }
                if desktop_input_lease_request is not None:
                    dispatch_kwargs["desktop_input_lease_request"] = desktop_input_lease_request
                if desktop_input_lease is not None:
                    dispatch_kwargs["desktop_input_lease"] = desktop_input_lease
                editor_token = _TARGET_EDITOR_NAMES.set(editor_names)
                try:
                    self.send_json(200, self.state.dispatch_and_verify(
                        contact,
                        talker,
                        text,
                        timeout,
                        **dispatch_kwargs,
                    ))
                finally:
                    _TARGET_EDITOR_NAMES.reset(editor_token)
                return
            if path == "/api/send-image":
                contact = normalize_text(payload.get("contact"))
                talker = normalize_text(payload.get("talker"))
                file_path = normalize_text(payload.get("filePath"))
                expected_sha256 = normalize_text(payload.get("sha256")).lower()
                timeout = float(payload.get("timeout", 30))
                if not contact or not talker or not file_path or not expected_sha256:
                    raise ValueError("contact, talker, filePath, and sha256 are required")
                resolved = self.state.resolve_target_names(contact, talker)
                editor_names: tuple[str, ...] = ()
                if resolved is not None:
                    contact = resolved["rowName"]
                    editor_names = tuple(
                        name
                        for name in (resolved["editorName"],)
                        if name and name != contact
                    )
                editor_token = _TARGET_EDITOR_NAMES.set(editor_names)
                try:
                    self.send_json(200, self.state.dispatch_image_and_verify(
                        contact,
                        talker,
                        file_path,
                        expected_sha256,
                        timeout,
                    ))
                finally:
                    _TARGET_EDITOR_NAMES.reset(editor_token)
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
        except DesktopActiveError as error:
            self.send_json(409, {
                "dispatched": False,
                "code": "CANARY_DESKTOP_ACTIVE",
                "error": str(error),
                "desktopIdleSeconds": error.desktop_idle_seconds,
                "requiredDesktopIdleSeconds": error.required_seconds,
            })
        except DesktopInputLeaseError as error:
            self.send_json(409, {
                "dispatched": error.dispatched,
                "verified": False,
                "code": error.code,
                "error": str(error),
                "certainPredispatch": not error.dispatched,
                "uncertain": error.dispatched,
            })
        except TargetNotConfirmedError as error:
            print(f"[weflow-uia] target not confirmed: {error}", flush=True)
            self.send_json(409, {
                "dispatched": False,
                "verified": False,
                "targetVerified": False,
                "code": "TARGET_NOT_CONFIRMED",
                "error": str(error),
            })
        except (ValueError, json.JSONDecodeError) as error:
            response = {"error": str(error)}
            if path in {"/api/send", "/api/send-image"}:
                response["dispatched"] = False
            self.send_json(400, response)
        except Exception as error:  # Keep the local bridge alive after UI/API failures.
            print(f"[weflow-uia] request failed: {error}", flush=True)
            response = {"error": str(error)}
            if path in {"/api/send", "/api/send-image"}:
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
    parser.add_argument(
        "--image-root",
        default=os.environ.get(
            "CYBERBOSS_WEFLOW_UIA_IMAGE_ROOT",
            str(state_dir / "generated-images-outbound"),
        ),
    )
    parser.add_argument(
        "--max-image-bytes",
        type=int,
        default=int(os.environ.get("CYBERBOSS_WEFLOW_UIA_MAX_IMAGE_BYTES", DEFAULT_MAX_IMAGE_BYTES)),
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
