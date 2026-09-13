#!/usr/bin/env python3
"""Read-only probe for the exact-search stabilization loop.

`select_exact_search_result_with_enter` refuses to press Enter until two
consecutive polls produce an identical "ordered search content identity".  When
that never happens the caller reports

    ordered search content identity had not repeated yet

which is what parked the transport canary on 2026-09-13.  The identity tuple
includes each row's screen bounding rectangle, so this probe records every poll
and reports exactly which component failed to repeat.

The probe only types into the session search box and clears it again: it never
presses Enter, never activates a search result, and never sends anything.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import uiautomation as automation  # noqa: E402

import importlib.util  # noqa: E402


def load_bridge():
    spec = importlib.util.spec_from_file_location(
        "weflow_uia_bridge",
        str(Path(__file__).resolve().parent / "weflow-uia-bridge.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def describe_identity(identity):
    return [
        {
            "automationId": row[0],
            "name": row[1],
            "className": row[2],
            "controlType": row[3],
            "bounds": list(row[4]) if row[4] is not None else None,
        }
        for row in identity
    ]


def diff_identities(previous, current):
    """Return a human-readable description of the first differing component."""
    if previous is None:
        return "no previous sample"
    if len(previous) != len(current):
        return f"row count changed: {len(previous)} -> {len(current)}"
    for index, (before, after) in enumerate(zip(previous, current)):
        if before == after:
            continue
        fields = ("automationId", "name", "className", "controlType", "bounds")
        changed = [
            f"{name}: {before[pos]!r} -> {after[pos]!r}"
            for pos, name in enumerate(fields)
            if before[pos] != after[pos]
        ]
        return f"row {index}: " + "; ".join(changed)
    return "identical"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contact", required=True)
    parser.add_argument("--samples", type=int, default=40)
    parser.add_argument("--interval", type=float, default=0.1)
    parser.add_argument(
        "--out",
        default="",
        help="write the JSON report here (avoids shell redirect encoding traps)",
    )
    args = parser.parse_args()

    bridge = load_bridge()
    window_handle = bridge.find_wechat_window_handle(require_chat_window=True)
    root = automation.ControlFromHandle(window_handle)
    if root is None:
        raise SystemExit("WeChat UI Automation root was unavailable")

    report = {
        "contact": args.contact,
        "windowHandle": window_handle,
        "samples": [],
        "repeatAt": None,
        "contentRepeatAt": None,
        "distinctFull": 0,
        "distinctContent": 0,
        "fullTransitions": [],
        "contentTransitions": [],
        "orderedFailures": [],
        "firstDifference": "",
    }
    previous = None
    previous_content = None
    seen_full = set()
    seen_content = set()
    try:
        # The real dispatch activates the window before searching, and every
        # downstream guard asserts WeChat still owns the foreground.
        bridge.activate_window(window_handle)
        time.sleep(0.25)
        bridge.replace_main_session_search_text(window_handle, root, args.contact)
        for index in range(max(1, args.samples)):
            sample = {"index": index}
            try:
                bridge.require_foreground_continuity(window_handle)
            except Exception as error:  # pragma: no cover - diagnostic path
                sample["reason"] = f"foreground: {error}"
                report["samples"].append(sample)
                time.sleep(args.interval)
                continue

            candidates = bridge.find_controls_by_automation_id(
                root, f"search_item_{args.contact}", max_depth=32
            )
            sample["candidateCount"] = len(candidates)
            if len(candidates) != 1:
                sample["reason"] = "candidate count was not exactly one"
                previous = None
                report["samples"].append(sample)
                time.sleep(args.interval)
                continue

            observed = candidates[0]
            shape_ok = bridge.exact_search_result_shape_matches(observed, args.contact)
            context_ok = bridge.strict_search_result_context_matches(root, observed)
            sample["shapeMatches"] = bool(shape_ok)
            sample["contextMatches"] = bool(context_ok)
            if not (shape_ok and context_ok):
                sample["reason"] = "shape or strict context did not match"
                previous = None
                report["samples"].append(sample)
                time.sleep(args.interval)
                continue

            try:
                rows, identity = bridge.ordered_strict_search_content_rows(root)
            except Exception as error:
                sample["reason"] = f"ordered rows failed: {error}"
                report["orderedFailures"].append({"index": index, "error": str(error)})
                previous = None
                previous_content = None
                report["samples"].append(sample)
                time.sleep(args.interval)
                continue
            targets = [
                position
                for position, row in enumerate(rows)
                if bridge.exact_search_result_shape_matches(row, args.contact)
            ]
            sample["targetPositions"] = targets
            sample["identity"] = describe_identity(identity)
            if len(targets) != 1 or not bridge.same_exact_control_identity(
                rows[targets[0]] if len(targets) == 1 else observed, observed
            ):
                sample["reason"] = "target was not the unique identity-matched row"
                previous = None
                report["samples"].append(sample)
                time.sleep(args.interval)
                continue

            # The production guard compares the full tuple, which includes each
            # row's screen rectangle. Track a content-only tuple alongside it so
            # the report shows whether geometry is what fails to repeat.
            content = tuple(row[:4] for row in identity)
            seen_full.add(identity)
            seen_content.add(content)
            if previous is not None and previous == identity and report["repeatAt"] is None:
                report["repeatAt"] = index
                sample["fullRepeated"] = True
            if (
                previous_content is not None
                and previous_content == content
                and report["contentRepeatAt"] is None
            ):
                report["contentRepeatAt"] = index
                sample["contentRepeated"] = True
            if previous is not None and previous != identity:
                report["fullTransitions"].append(diff_identities(previous, identity))
            if previous_content is not None and previous_content != content:
                report["contentTransitions"].append(
                    diff_identities(previous_content, content)
                )
            sample["reason"] = "identity had not repeated yet"
            sample["differenceFromPrevious"] = diff_identities(previous, identity)
            if not report["firstDifference"] and previous is not None:
                report["firstDifference"] = sample["differenceFromPrevious"]
            previous = identity
            previous_content = content
            report["samples"].append(sample)
            time.sleep(args.interval)
    finally:
        try:
            bridge.replace_main_session_search_text(window_handle, root, "")
        except Exception as error:  # pragma: no cover - diagnostic path
            report["cleanupError"] = str(error)

    report["sampleCount"] = len(report["samples"])
    report["distinctFull"] = len(seen_full)
    report["distinctContent"] = len(seen_content)
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(rendered, encoding="utf-8")
        print(
            json.dumps(
                {
                    "contact": report["contact"],
                    "sampleCount": report["sampleCount"],
                    "repeatAt": report["repeatAt"],
                    "contentRepeatAt": report["contentRepeatAt"],
                    "distinctFull": report["distinctFull"],
                    "distinctContent": report["distinctContent"],
                    "orderedFailures": len(report["orderedFailures"]),
                    "firstFailure": (
                        report["orderedFailures"][0]["error"]
                        if report["orderedFailures"]
                        else ""
                    ),
                    "firstDifference": report["firstDifference"],
                },
                ensure_ascii=False,
            )
        )
    else:
        print(rendered)
    return 0 if report["repeatAt"] is not None else 2


if __name__ == "__main__":
    raise SystemExit(main())
