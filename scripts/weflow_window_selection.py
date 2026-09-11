"""Pure window-selection policy for the WeFlow UIA bridge."""

from __future__ import annotations

from collections.abc import Iterable


WindowMatch = tuple[int, bool, bool]


def is_wechat_main_window_identity(
    *,
    class_name: str,
    control_type_name: str,
) -> bool:
    """Accept only the logged-in main chat root, never a generic/search window."""

    return class_name == "mmui::MainWindow" and control_type_name == "WindowControl"


def is_wechat_chat_window_geometry(
    class_name: str,
    width: int,
    height: int,
    *,
    is_iconic: bool = False,
    normal_width: int = 0,
    normal_height: int = 0,
) -> bool:
    """Classify a chat window using its restored size when it is minimized.

    Windows may report a small icon/off-screen rectangle from GetWindowRect for
    an iconic window.  WINDOWPLACEMENT.rcNormalPosition retains the actual
    restored dimensions and keeps a minimized chat window distinct from the
    small login/account-selection card.
    """

    if class_name == "mmui::MainWindow":
        return True
    candidate_width = normal_width if is_iconic and normal_width > 0 else width
    candidate_height = normal_height if is_iconic and normal_height > 0 else height
    return candidate_width >= 600 and candidate_height >= 500


def select_wechat_window_handle(
    matches: Iterable[WindowMatch],
    *,
    require_chat_window: bool = False,
) -> int:
    """Select a Weixin window without confusing a login card for a chat window.

    A logged-in main window remains a valid dispatch target after the user closes
    it to the system tray.  The caller restores that hidden window before sending.
    Small login/account-selection windows are never accepted when a chat window is
    required.
    """

    candidates = list(matches)
    if require_chat_window:
        main_windows = [item for item in candidates if item[2]]
        # Multiple strict main roots are ambiguous: picking the first could send
        # into another logged-in instance/account. Keep dispatch fail-closed.
        return main_windows[0][0] if len(main_windows) == 1 else 0

    for handle, visible, _is_chat_window in candidates:
        if visible:
            return handle
    return candidates[0][0] if candidates else 0
