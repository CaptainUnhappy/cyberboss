"""Honest machine bindings for the isolated-session recipes.

Why this module exists: every one of these scripts hardcoded
`D:\\Projects\\cyberboss` and `C:\\ProgramData\\cwin-probe`. On a second machine
the checkout path is different, and a wrong queue directory is indistinguishable
from an idle worker -- the recipe "succeeds" while nothing happens. So the values
are resolved once, here, from the environment with the historical defaults kept
as fallbacks.

Nothing in this module writes anything: importing it has no side effects beyond
reading environment variables.
"""

from __future__ import annotations

import os
from pathlib import Path

# `scripts/isolated-session/machine_paths.py` -> the checkout root.
REPO_ROOT = Path(__file__).resolve().parents[2]

QUEUE_ROOT = Path(os.environ.get("CYBERBOSS_QUEUE_ROOT") or r"C:\ProgramData\cwin-probe")

# The bridge drives one WeChat account; its state lives next to the queue rather
# than in the user profile because two accounts must keep two ledgers.
STATE_ROOT = Path(os.environ.get("CYBERBOSS_ISOLATED_STATE_DIR") or (QUEUE_ROOT / "state4"))

LOG_DIR = Path(os.environ.get("CYBERBOSS_ISOLATED_LOG_DIR") or (QUEUE_ROOT / "logs"))

HOLD_FILE = QUEUE_ROOT / "rdp-client-hold.txt"
SUSPEND_FILE = QUEUE_ROOT / "rdp-client-suspend.txt"

# Queue directories keep their historical names: they are shared with a worker
# that another workload also feeds, and renaming them is a coordination change,
# not a portability one.
QUEUE_IN = QUEUE_ROOT / "s4" / "in"
QUEUE_OUT = QUEUE_ROOT / "s4" / "out"
QUEUE_DONE = QUEUE_ROOT / "s4" / "done"

# Where the remote-control log scanner looks. Overridable because the remote
# tool's install path is a per-machine fact, not a project one.
REMOTE_LOG_DIRS = [
    Path(p) for p in (
        os.environ.get("CYBERBOSS_TODESK_LOG_DIR") or r"D:\Program Files\ToDesk\Logs",
        os.environ.get("CYBERBOSS_GAMEVIEWER_LOG_DIR") or r"C:\Program Files\GameViewer\Logs",
    )
]


def log_file(name: str) -> Path:
    """A log path that works before the directory exists."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    return LOG_DIR / name
