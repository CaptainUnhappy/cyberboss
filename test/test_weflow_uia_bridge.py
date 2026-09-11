from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

from PIL import Image


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
SPEC = importlib.util.spec_from_file_location(
    "cyberboss_weflow_uia_bridge",
    SCRIPTS_DIR / "weflow-uia-bridge.py",
)
assert SPEC and SPEC.loader
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class SearchFallbackFixture:
    """Synthetic UIA tree matching the observed Weixin search popup shape."""

    class ValuePattern:
        def __init__(self, fixture: "SearchFallbackFixture") -> None:
            self.fixture = fixture

        @property
        def Value(self) -> str:
            return self.fixture.search_value

    class SelectionPattern:
        def __init__(self, fixture: "SearchFallbackFixture", control) -> None:
            self.fixture = fixture
            self.control = control

        @property
        def IsSelected(self) -> bool:
            return bool(self.control.selected)

        def Select(self, **_kwargs: object) -> bool:
            self.fixture.actions.append("select")
            self.fixture.popup_open = False
            return True  # Observed provider false-success for search rows.

    class InvokePattern:
        def __init__(self, fixture: "SearchFallbackFixture") -> None:
            self.fixture = fixture

        def Invoke(self, **_kwargs: object) -> bool:
            self.fixture.actions.append("invoke")
            self.fixture.popup_open = False
            return True  # Observed provider false-success for search rows.

    class Control:
        def __init__(
            self,
            fixture: "SearchFallbackFixture",
            automation_id: str,
            name: str,
            class_name: str,
            control_type_name: str,
            *,
            parent=None,
            bounds: tuple[int, int, int, int] = (10, 10, 200, 60),
            selected: bool = False,
        ) -> None:
            self.fixture = fixture
            self.AutomationId = automation_id
            self.Name = name
            self.ClassName = class_name
            self.ControlTypeName = control_type_name
            self.parent = parent
            self.BoundingRectangle = BRIDGE.automation.Rect(*bounds)
            self.IsOffscreen = False
            self.IsEnabled = True
            self.selected = selected

        def GetParentControl(self):
            return self.parent

        def GetPattern(self, pattern_id: int):
            fixture = self.fixture
            if pattern_id == BRIDGE.automation.PatternId.ValuePattern and self is fixture.search_edit:
                return SearchFallbackFixture.ValuePattern(fixture)
            if pattern_id == BRIDGE.automation.PatternId.SelectionItemPattern and self in (
                fixture.search_result,
                fixture.main_target,
                fixture.old_main,
            ):
                return SearchFallbackFixture.SelectionPattern(fixture, self)
            if pattern_id == BRIDGE.automation.PatternId.InvokePattern and self is fixture.search_result:
                return SearchFallbackFixture.InvokePattern(fixture)
            return None

        def SetFocus(self) -> None:
            self.fixture.focused = self

        def Click(self, **kwargs: object) -> None:
            fixture = self.fixture
            if self is fixture.search_result:
                fixture.actions.append("click")
                fixture.click_kwargs = kwargs
                fixture.main_target.selected = True
                fixture.old_main.selected = False
                fixture.header.Name = fixture.contact
                fixture.chat_input.Name = fixture.contact
            elif self is fixture.chat_input:
                fixture.chat_input_clicks += 1

    def __init__(
        self,
        *,
        contact: str = "yourself",
        popup_owner: int = 984206,
        owner_sequence: list[int] | None = None,
        popup_handle: int = 2362186,
        duplicate_exact: bool = False,
        wrong_row_class: bool = False,
        wrong_ancestry: bool = False,
        wrong_popup_class: bool = False,
        wrong_list_class: bool = False,
        materialization_walks: int = 0,
    ) -> None:
        self.contact = contact
        self.main_handle = 984206
        self.popup_handle = popup_handle
        self.popup_owner = popup_owner
        self.owner_sequence = list(owner_sequence or [])
        self.owner_returns: list[int] = []
        self.materialization_walks = max(0, materialization_walks)
        self.search_value = ""
        self.popup_open = False
        self.focused = None
        self.actions: list[str] = []
        self.search_keys: list[str] = []
        self.unicode_chars: list[str] = []
        self.click_kwargs: dict[str, object] = {}
        self.chat_input_clicks = 0

        self.root = self.Control(
            self,
            "",
            "微信",
            "mmui::MainWindow",
            "WindowControl",
            bounds=(190, 70, 1308, 879),
        )
        self.search_field = self.Control(
            self,
            "main_search_field",
            "",
            "mmui::XSearchField",
            "GroupControl",
            parent=self.root,
            bounds=(200, 80, 600, 130),
        )
        self.search_edit = self.Control(
            self,
            "",
            "搜索",
            "mmui::XValidatorTextEdit",
            "EditControl",
            parent=self.search_field,
            bounds=(220, 90, 580, 125),
        )
        self.popup = self.Control(
            self,
            "",
            "Weixin",
            "mmui::WrongPopover" if wrong_popup_class else "mmui::SearchContentPopover",
            "WindowControl",
            parent=self.root,
            bounds=(280, 180, 700, 500),
        )
        self.search_list = self.Control(
            self,
            "search_list",
            "",
            "mmui::WrongList" if wrong_list_class else "mmui::XTableView",
            "ListControl",
            parent=self.popup,
            bounds=(285, 190, 695, 490),
        )
        self.search_result = self.Control(
            self,
            f"search_item_{contact}",
            contact,
            "mmui::SearchRecordCellView" if wrong_row_class else "mmui::SearchContentCellView",
            "ListItemControl",
            parent=self.popup if wrong_ancestry else self.search_list,
            bounds=(288, 198, 688, 278),
        )
        self.duplicate = self.Control(
            self,
            f"search_item_{contact}",
            contact,
            "mmui::SearchContentCellView",
            "ListItemControl",
            parent=self.search_list,
            bounds=(288, 280, 688, 360),
        ) if duplicate_exact else None
        self.session_list = self.Control(
            self,
            "session_list",
            "会话",
            "mmui::XTableView",
            "ListControl",
            parent=self.root,
            bounds=(190, 140, 590, 850),
        )
        self.old_main = self.Control(
            self,
            "session_item_Azzy",
            "Azzy",
            "mmui::ChatSessionCell",
            "ListItemControl",
            parent=self.session_list,
            bounds=(200, 150, 580, 230),
            selected=True,
        )
        self.main_target = self.Control(
            self,
            f"session_item_{contact}",
            contact,
            "mmui::ChatSessionCell",
            "ListItemControl",
            parent=self.session_list,
            bounds=(200, 240, 580, 320),
        )
        self.header = self.Control(
            self,
            "Window.Main.Chat.current_chat_name_label",
            "Azzy",
            "mmui::XTextView",
            "TextControl",
            parent=self.root,
            bounds=(600, 80, 900, 120),
        )
        self.chat_input = self.Control(
            self,
            "chat_input_field",
            "Azzy",
            "mmui::ChatInputField",
            "EditControl",
            parent=self.root,
            bounds=(600, 650, 1200, 850),
        )

    def walk(self, *_args: object, **_kwargs: object):
        controls = [
            self.root,
            self.search_field,
            self.search_edit,
            self.session_list,
            self.old_main,
            self.header,
            self.chat_input,
        ]
        if self.main_target.selected:
            controls.append(self.main_target)
        if self.popup_open:
            if self.materialization_walks > 0:
                self.materialization_walks -= 1
                controls.append(self.search_result)
            else:
                controls.extend([self.popup, self.search_list, self.search_result])
            if self.duplicate is not None:
                controls.append(self.duplicate)
        return iter((item, 10) for item in controls)

    def control_from_handle(self, handle: int):
        if int(handle) == self.main_handle:
            return self.root
        if int(handle) == self.popup_handle:
            return self.popup
        return None

    def control_from_point(self, _x: int, _y: int):
        return self.search_result

    def send_keys(self, keys: str, **_kwargs: object) -> None:
        self.search_keys.append(keys)
        if self.focused is self.search_edit and keys == "{Delete}":
            self.search_value = ""
        if self.focused is self.search_edit and keys == "{Esc}":
            self.popup_open = False
        if self.focused is self.search_edit and keys == "{Enter}":
            self.actions.append("enter")
            self.main_target.selected = True
            self.old_main.selected = False
            self.header.Name = self.contact
            self.chat_input.Name = self.contact
            self.popup_open = False

    def send_unicode_char(self, character: str) -> int:
        self.unicode_chars.append(character)
        if self.focused is not self.search_edit:
            return 0
        self.search_value += character
        self.popup_open = True
        return 1  # Live uiautomation returns 1 even though ValuePattern updates.

    def get_popup_owner(self, _handle: int, _command: int) -> int:
        if self.owner_sequence:
            owner = self.owner_sequence.pop(0)
        else:
            owner = self.popup_owner
        self.owner_returns.append(owner)
        return owner

    @contextmanager
    def patched(self):
        user32 = BRIDGE.ctypes.windll.user32
        with mock.patch.object(BRIDGE.automation, "ControlFromHandle", side_effect=self.control_from_handle), \
                mock.patch.object(BRIDGE.automation, "ControlFromPoint", side_effect=self.control_from_point), \
                mock.patch.object(BRIDGE.automation, "WalkControl", side_effect=self.walk), \
                mock.patch.object(BRIDGE.automation, "GetFocusedControl", side_effect=lambda: self.focused), \
                mock.patch.object(BRIDGE.automation, "SendKeys", side_effect=self.send_keys), \
                mock.patch.object(BRIDGE.automation, "SendUnicodeChar", side_effect=self.send_unicode_char), \
                mock.patch.object(user32, "GetForegroundWindow", return_value=self.main_handle), \
                mock.patch.object(user32, "WindowFromPoint", return_value=777), \
                mock.patch.object(user32, "GetAncestor", return_value=self.popup_handle), \
                mock.patch.object(user32, "GetWindow", side_effect=self.get_popup_owner):
            yield


class WeFlowUiaImageBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "generated-images-outbound"
        self.root.mkdir(parents=True)
        args = argparse.Namespace(
            weflow_base_url="http://127.0.0.1:5031",
            weflow_token="fixture-token",
            state_file=str(Path(self.temporary.name) / "send-source.json"),
            image_root=str(self.root),
            max_image_bytes=1024 * 1024,
        )
        self.state = BRIDGE.BridgeState(args)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def make_png(self, name: str = "fixture.png") -> tuple[Path, bytes, str]:
        target = self.root / name
        buffer = io.BytesIO()
        Image.new("RGBA", (3, 2), (20, 40, 60, 128)).save(buffer, format="PNG")
        payload = buffer.getvalue()
        target.write_bytes(payload)
        return target, payload, hashlib.sha256(payload).hexdigest()

    def make_model_lease_request(
        self,
        run_id: str = "12345678-1234-4234-8234-123456789abc",
        nonce: str = "0123456789abcdef01234567",
        contact: str = "Azzy",
        talker: str = "wxid_canary_self",
    ) -> dict[str, object]:
        return {
            "version": 1,
            "mode": "model_e2e",
            "runId": run_id,
            "nonce": nonce,
            "targetFingerprint": hashlib.sha256(
                f"{contact}\n{talker}".encode("utf-8")
            ).hexdigest(),
            "replyIdempotencyKey": f"model-canary-reply:{run_id}",
            "expiresAt": "2026-08-30T07:05:00.000Z",
        }

    @staticmethod
    def make_model_lease_use(request: dict[str, object], token: str) -> dict[str, object]:
        return {
            "version": request["version"],
            "mode": request["mode"],
            "runId": request["runId"],
            "nonce": request["nonce"],
            "targetFingerprint": request["targetFingerprint"],
            "replyIdempotencyKey": request["replyIdempotencyKey"],
            "expiresAt": request["expiresAt"],
            "token": token,
        }

    def test_managed_png_validation_checks_root_signature_and_digest(self) -> None:
        target, payload, digest = self.make_png()
        resolved, validated, actual_digest = self.state.load_validated_png(str(target), digest)
        self.assertEqual(resolved, target.resolve())
        self.assertEqual(validated, payload)
        self.assertEqual(actual_digest, digest)

        with tempfile.TemporaryDirectory() as outside_dir:
            outside = Path(outside_dir) / "outside.png"
            outside.write_bytes(payload)
            with self.assertRaisesRegex(ValueError, "outside the managed image root"):
                self.state.load_validated_png(str(outside), digest)

        with self.assertRaisesRegex(ValueError, "sha256 does not match"):
            self.state.load_validated_png(str(target), "0" * 64)

        invalid = self.root / "invalid.png"
        invalid.write_bytes(b"not a png payload")
        invalid_digest = hashlib.sha256(invalid.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "PNG signature"):
            self.state.load_validated_png(str(invalid), invalid_digest)

    def test_png_conversion_produces_cf_dib_payload_without_bmp_file_header(self) -> None:
        _target, payload, _digest = self.make_png()
        dib = BRIDGE.png_bytes_to_dib(payload)
        self.assertNotEqual(dib[:2], b"BM")
        self.assertEqual(int.from_bytes(dib[:4], "little"), 40)

    def test_image_verification_accepts_only_new_outgoing_image_stable_id(self) -> None:
        target, payload, digest = self.make_png()
        old = {"localId": 41, "isSend": 1, "localType": 3, "content": "[图片]"}
        new = {"localId": 42, "isSend": 1, "localType": 3, "content": "[图片]"}
        self.state.fetch_messages = mock.Mock(side_effect=[[old], [old, new]])
        self.state._dispatch_image = mock.Mock()

        result = self.state.dispatch_image_and_verify(
            "fixture-contact",
            "fixture-talker",
            str(target),
            digest,
            1,
        )

        self.assertEqual(result["dispatched"], True)
        self.assertEqual(result["verified"], True)
        self.assertEqual(result["localId"], "42")
        self.assertEqual(result["sha256"], digest)
        self.state._dispatch_image.assert_called_once_with("fixture-contact", payload)

    def test_image_verification_timeout_is_uncertain_and_dispatches_once(self) -> None:
        target, payload, digest = self.make_png()
        old = {"localId": 51, "isSend": 1, "mediaType": "image", "content": "[图片]"}
        self.state.fetch_messages = mock.Mock(side_effect=[[old], [old]])
        self.state._dispatch_image = mock.Mock()

        with mock.patch.object(BRIDGE.time, "monotonic", side_effect=[0.0, 0.1, 0.2, 1.1]), \
                mock.patch.object(BRIDGE.time, "sleep", return_value=None):
            result = self.state.dispatch_image_and_verify(
                "fixture-contact",
                "fixture-talker",
                str(target),
                digest,
                1,
            )

        self.assertEqual(result["dispatched"], True)
        self.assertEqual(result["verified"], False)
        self.assertEqual(result["uncertain"], True)
        self.assertRegex(result["verificationError"], "not observed")
        self.state._dispatch_image.assert_called_once_with("fixture-contact", payload)

    def test_text_messages_api_500_after_uia_dispatch_is_uncertain_and_dispatches_once(self) -> None:
        self.state.fetch_messages = mock.Mock(
            side_effect=OSError("WeFlow messages HTTP 500 (code -105)")
        )
        self.state._dispatch_text = mock.Mock(return_value={
            "exactContact": True,
            "selectedContact": "Main Account",
        })

        with mock.patch.object(BRIDGE.time, "monotonic", side_effect=[0.0, 0.1, 0.2, 1.1]), \
                mock.patch.object(BRIDGE.time, "sleep", return_value=None):
            result = self.state.dispatch_and_verify(
                "Main Account",
                "wxid_primary_account",
                "fixture restart notification",
                1,
                exact_contact=True,
                expected_contact="Main Account",
                expected_talker="wxid_primary_account",
            )

        self.assertEqual(result["dispatched"], True)
        self.assertEqual(result["verified"], False)
        self.assertEqual(result["uncertain"], True)
        self.assertNotIn("localId", result)
        self.assertRegex(result["verificationError"], r"HTTP 500.*-105")
        self.assertEqual(result["targetVerified"], True)
        self.assertEqual(result["selectedContact"], "Main Account")
        self.assertEqual(result["verifiedTalker"], "wxid_primary_account")
        self.assertEqual(self.state.fetch_messages.call_count, 2)
        self.state._dispatch_text.assert_called_once_with(
            "Main Account",
            "fixture restart notification",
            require_desktop_idle_seconds=None,
            exact_contact=True,
        )

    def test_canary_desktop_recheck_blocks_activation_when_input_became_active_or_unavailable(self) -> None:
        self.state.fetch_messages = mock.Mock(return_value=[])
        with mock.patch.object(BRIDGE, "find_wechat_window_handle", return_value=123), \
                mock.patch.object(BRIDGE, "activate_window") as activate, \
                mock.patch.object(BRIDGE, "get_desktop_idle_seconds", return_value=2):
            with self.assertRaises(BRIDGE.DesktopActiveError) as active_error:
                self.state.dispatch_and_verify(
                    "fixture-contact",
                    "fixture-talker",
                    "fixture-text",
                    1,
                    require_desktop_idle_seconds=60,
                )
        self.assertEqual(active_error.exception.desktop_idle_seconds, 2)
        self.assertEqual(active_error.exception.required_seconds, 300)
        activate.assert_not_called()

        with mock.patch.object(BRIDGE, "find_wechat_window_handle", return_value=123), \
                mock.patch.object(BRIDGE, "activate_window") as activate, \
                mock.patch.object(BRIDGE, "get_desktop_idle_seconds", side_effect=OSError("fixture")):
            with self.assertRaises(BRIDGE.DesktopActiveError) as unavailable_error:
                self.state.dispatch_and_verify(
                    "fixture-contact",
                    "fixture-talker",
                    "fixture-text",
                    1,
                    require_desktop_idle_seconds=300,
                )
        self.assertIsNone(unavailable_error.exception.desktop_idle_seconds)
        activate.assert_not_called()

    def test_canary_desktop_race_returns_http_409_without_dispatch(self) -> None:
        handler = object.__new__(BRIDGE.BridgeHandler)
        handler.path = "/api/send"
        handler.server = SimpleNamespace(bridge_state=self.state)
        handler.read_json = mock.Mock(return_value={
            "contact": "fixture-contact",
            "talker": "fixture-talker",
            "text": "fixture-canary",
            "timeout": 1,
            "requireDesktopIdleSeconds": 60,
        })
        handler.send_json = mock.Mock()
        self.state.dispatch_and_verify = mock.Mock(
            side_effect=BRIDGE.DesktopActiveError(1, 300),
        )

        handler.do_POST()

        self.state.dispatch_and_verify.assert_called_once_with(
            "fixture-contact",
            "fixture-talker",
            "fixture-canary",
            1.0,
            require_desktop_idle_seconds=300,
            exact_contact=False,
            expected_contact="",
            expected_talker="",
        )
        status, response = handler.send_json.call_args.args
        self.assertEqual(status, 409)
        self.assertEqual(response["dispatched"], False)
        self.assertEqual(response["code"], "CANARY_DESKTOP_ACTIVE")
        self.assertEqual(response["desktopIdleSeconds"], 1)

    def test_model_canary_desktop_input_lease_is_manifest_bound_and_restart_durable(self) -> None:
        request = self.make_model_lease_request()
        run_id = str(request["runId"])
        trigger = (
            f"[Cyberboss心跳模型探针 trigger={run_id} nonce={request['nonce']}]"
        )
        reply = f"[Cyberboss心跳模型正常 trigger={run_id}]"
        with mock.patch.object(BRIDGE.time, "time", return_value=1_788_073_200.0):
            issued = self.state.issue_desktop_input_lease(
                request,
                contact="Azzy",
                talker="wxid_canary_self",
                text=trigger,
                last_input_tick=77,
            )
        lease_path = self.state.desktop_input_lease_dir / f"{run_id}.json"
        persisted = json.loads(lease_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["token"], issued["token"])
        self.assertEqual(
            persisted["tokenSha256"],
            hashlib.sha256(issued["token"].encode("ascii")).hexdigest(),
        )
        self.assertEqual(persisted["lastInputTick"], 77)

        restarted = BRIDGE.BridgeState(SimpleNamespace(
            weflow_base_url="http://127.0.0.1:5031",
            weflow_token="fixture-token",
            state_file=str(self.state.state_file),
            image_root=str(self.root),
            max_image_bytes=1024 * 1024,
        ))
        lease = self.make_model_lease_use(request, issued["token"])
        with mock.patch.object(BRIDGE.time, "time", return_value=1_788_073_201.0), \
                mock.patch.object(BRIDGE, "get_last_input_tick", return_value=77):
            claimed = restarted.claim_desktop_input_lease(
                lease,
                contact="Azzy",
                talker="wxid_canary_self",
                text=reply,
            )
        self.assertEqual(claimed["status"], "claimed")
        restarted.consume_desktop_input_lease(claimed)
        consumed = json.loads(lease_path.read_text(encoding="utf-8"))
        self.assertEqual(consumed["status"], "consumed")
        self.assertNotIn("token", consumed)
        self.assertTrue(
            restarted._desktop_input_lease_claim_path(run_id).is_file()
        )
        with mock.patch.object(BRIDGE.time, "time", return_value=1_788_073_202.0), \
                mock.patch.object(BRIDGE, "get_last_input_tick", return_value=77):
            with self.assertRaises(BRIDGE.DesktopInputLeaseError):
                restarted.claim_desktop_input_lease(
                    lease,
                    contact="Azzy",
                    talker="wxid_canary_self",
                    text=reply,
                )

    def test_model_canary_desktop_input_lease_cross_process_claim_is_fail_closed(self) -> None:
        request = self.make_model_lease_request()
        run_id = str(request["runId"])
        trigger = f"[Cyberboss心跳模型探针 trigger={run_id} nonce={request['nonce']}]"
        reply = f"[Cyberboss心跳模型正常 trigger={run_id}]"
        with mock.patch.object(BRIDGE.time, "time", return_value=1_788_073_200.0):
            issued = self.state.issue_desktop_input_lease(
                request,
                contact="Azzy",
                talker="wxid_canary_self",
                text=trigger,
                last_input_tick=77,
            )
        claim_path = self.state._desktop_input_lease_claim_path(run_id)
        self.state._atomic_create_private_json(claim_path, {
            "version": 1,
            "mode": "model_e2e",
            "runId": run_id,
            "tokenSha256": hashlib.sha256(issued["token"].encode("ascii")).hexdigest(),
            "claimedAt": "2026-08-30T07:00:01.000Z",
        })
        lease = self.make_model_lease_use(request, issued["token"])
        with mock.patch.object(BRIDGE.time, "time", return_value=1_788_073_201.0), \
                mock.patch.object(BRIDGE, "get_last_input_tick", return_value=77):
            with self.assertRaises(BRIDGE.DesktopInputLeaseError) as raised:
                self.state.claim_desktop_input_lease(
                    lease,
                    contact="Azzy",
                    talker="wxid_canary_self",
                    text=reply,
                )
        self.assertEqual(raised.exception.code, "CANARY_DESKTOP_LEASE_ALREADY_CLAIMED")
        lease_path = self.state.desktop_input_lease_dir / f"{run_id}.json"
        self.assertEqual(json.loads(lease_path.read_text(encoding="utf-8"))["status"], "issued")

    def test_model_reply_lease_rejects_later_input_before_any_ui_action(self) -> None:
        request = self.make_model_lease_request()
        run_id = str(request["runId"])
        trigger = f"[Cyberboss心跳模型探针 trigger={run_id} nonce={request['nonce']}]"
        reply = f"[Cyberboss心跳模型正常 trigger={run_id}]"
        with mock.patch.object(BRIDGE.time, "time", return_value=1_788_073_200.0):
            issued = self.state.issue_desktop_input_lease(
                request,
                contact="Azzy",
                talker="wxid_canary_self",
                text=trigger,
                last_input_tick=77,
            )
        lease = self.make_model_lease_use(request, issued["token"])
        with mock.patch.object(BRIDGE.time, "time", return_value=1_788_073_201.0), \
                mock.patch.object(BRIDGE, "get_last_input_tick", return_value=78), \
                mock.patch.object(BRIDGE, "find_wechat_window_handle") as find_window, \
                mock.patch.object(BRIDGE, "activate_window") as activate, \
                mock.patch.object(BRIDGE.pyperclip, "paste") as clipboard_read, \
                mock.patch.object(BRIDGE.automation, "SendKeys") as send_keys:
            with self.assertRaises(BRIDGE.DesktopInputLeaseError) as stale:
                self.state._dispatch_text(
                    "Azzy",
                    reply,
                    exact_contact=True,
                    talker="wxid_canary_self",
                    desktop_input_lease=lease,
                )
        self.assertEqual(stale.exception.code, "CANARY_DESKTOP_LEASE_STALE")
        self.assertFalse(stale.exception.dispatched)
        find_window.assert_not_called()
        activate.assert_not_called()
        clipboard_read.assert_not_called()
        send_keys.assert_not_called()

    def test_reserved_model_reply_cannot_use_the_ordinary_exact_route_without_a_lease(self) -> None:
        run_id = "12345678-1234-4234-8234-123456789abc"
        reply = f"[Cyberboss心跳模型正常 trigger={run_id}]"
        with mock.patch.object(BRIDGE, "find_wechat_window_handle") as find_window, \
                mock.patch.object(BRIDGE, "activate_window") as activate, \
                mock.patch.object(BRIDGE.automation, "SendKeys") as send_keys:
            with self.assertRaises(BRIDGE.DesktopInputLeaseError) as missing:
                self.state._dispatch_text(
                    "Azzy",
                    reply,
                    exact_contact=True,
                )
        self.assertEqual(missing.exception.code, "CANARY_DESKTOP_LEASE_MISSING")
        find_window.assert_not_called()
        activate.assert_not_called()
        send_keys.assert_not_called()

    def test_trigger_lease_captures_the_bridges_final_enter_tick(self) -> None:
        class FakeValuePattern:
            def __init__(self) -> None:
                self.Value = ""

            def SetValue(self, value: str) -> None:
                self.Value = value

        class FakeInput:
            def __init__(self) -> None:
                self.value_pattern = FakeValuePattern()

            def Click(self, **_kwargs: object) -> None:
                return None

            def GetPattern(self, pattern_id: int):
                if pattern_id == BRIDGE.automation.PatternId.ValuePattern:
                    return self.value_pattern
                return None

        request = self.make_model_lease_request()
        run_id = str(request["runId"])
        trigger = f"[Cyberboss心跳模型探针 trigger={run_id} nonce={request['nonce']}]"
        sent_keys: list[str] = []

        def send_keys(value: str, **_kwargs: object) -> None:
            sent_keys.append(value)

        def read_tick() -> int:
            return 77 if sent_keys and sent_keys[-1] == "{Enter}" else 66

        root = SimpleNamespace(Name="微信")
        chat_input = FakeInput()
        with mock.patch.object(BRIDGE.time, "time", return_value=1_788_073_200.0), \
                mock.patch.object(BRIDGE.time, "sleep", return_value=None), \
                mock.patch.object(BRIDGE, "require_desktop_idle"), \
                mock.patch.object(BRIDGE, "find_wechat_window_handle", return_value=123), \
                mock.patch.object(BRIDGE, "activate_window"), \
                mock.patch.object(
                    BRIDGE,
                    "select_exact_contact_session",
                    return_value=(root, chat_input),
                ), mock.patch.object(
                    BRIDGE,
                    "confirm_current_chat_target",
                    return_value=chat_input,
                ), mock.patch.object(BRIDGE, "get_last_input_tick", side_effect=read_tick), \
                mock.patch.object(BRIDGE, "require_no_competing_desktop_input"), \
                mock.patch.object(BRIDGE, "require_foreground_continuity"), \
                mock.patch.object(BRIDGE, "require_focused_chat_input"), \
                mock.patch.object(BRIDGE.pyperclip, "paste") as clipboard_read, \
                mock.patch.object(BRIDGE.pyperclip, "copy") as clipboard_write, \
                mock.patch.object(BRIDGE.automation, "SendKeys", side_effect=send_keys):
            result = self.state._dispatch_text(
                "Azzy",
                trigger,
                require_desktop_idle_seconds=300,
                exact_contact=True,
                talker="wxid_canary_self",
                desktop_input_lease_request=request,
            )

        self.assertEqual(sent_keys[-1], "{Enter}")
        self.assertEqual(sent_keys, ["{Enter}"])
        clipboard_read.assert_not_called()
        clipboard_write.assert_not_called()
        self.assertEqual(result["desktopInputLease"]["lastInputTick"], 77)
        persisted = json.loads(
            (self.state.desktop_input_lease_dir / f"{run_id}.json").read_text(encoding="utf-8")
        )
        self.assertEqual(persisted["lastInputTick"], 77)

    def test_window_discovery_uses_strict_uia_main_identity_and_rejects_ambiguity(self) -> None:
        handles = [656260, 984206, 460972]
        roots = {
            656260: SimpleNamespace(
                AutomationId="GlobalSearchMsgWindow",
                Name="搜索聊天记录",
                ClassName="mmui::SearchMsgWindow",
                ControlTypeName="WindowControl",
            ),
            984206: SimpleNamespace(
                AutomationId="",
                Name="微信",
                ClassName="mmui::MainWindow",
                ControlTypeName="WindowControl",
            ),
            460972: SimpleNamespace(
                AutomationId="",
                Name="Weixin",
                ClassName="Qt51514QWindowIcon",
                ControlTypeName="WindowControl",
            ),
        }

        def enum_windows(callback, lparam: int) -> int:
            for handle in handles:
                callback(handle, lparam)
            return 1

        def get_class_name(_handle: int, buffer, _length: int) -> int:
            buffer.value = "Qt51514QWindowIcon"
            return 1

        def get_process_id(_handle: int, process_id) -> int:
            process_id._obj.value = 19348
            return 1

        user32 = BRIDGE.ctypes.windll.user32
        with mock.patch.object(user32, "EnumWindows", side_effect=enum_windows), \
                mock.patch.object(user32, "GetClassNameW", side_effect=get_class_name), \
                mock.patch.object(user32, "GetWindowThreadProcessId", side_effect=get_process_id), \
                mock.patch.object(user32, "IsWindowVisible", side_effect=lambda handle: handle != 460972), \
                mock.patch.object(BRIDGE, "process_image_name", return_value="weixin.exe"), \
                mock.patch.object(BRIDGE.automation, "ControlFromHandle", side_effect=lambda handle: roots[handle]):
            self.assertEqual(BRIDGE.find_wechat_window_handle(require_chat_window=True), 984206)
            roots[656260] = SimpleNamespace(
                AutomationId="",
                Name="another account",
                ClassName="mmui::MainWindow",
                ControlTypeName="WindowControl",
            )
            self.assertEqual(BRIDGE.find_wechat_window_handle(require_chat_window=True), 0)

    def test_exact_contact_selector_requires_one_Azzy_session_and_matching_chat_labels(self) -> None:
        class FakeSelectionPattern:
            def __init__(self, control: "FakeControl") -> None:
                self.control = control

            @property
            def IsSelected(self) -> bool:
                return self.control.selected

            def Select(self, **_kwargs: object) -> None:
                self.control.selected = True
                self.control.selections += 1

        class FakeControl:
            def __init__(
                self,
                automation_id: str,
                name: str,
                class_name: str = "fixture",
                control_type_name: str = "CustomControl",
                parent: "FakeControl | None" = None,
                selected: bool = False,
            ) -> None:
                self.AutomationId = automation_id
                self.Name = name
                self.ClassName = class_name
                self.ControlTypeName = control_type_name
                self.parent = parent
                self.selected = selected
                self.IsOffscreen = False
                self.IsEnabled = True
                self.BoundingRectangle = BRIDGE.automation.Rect(10, 10, 200, 60)
                self.clicks = 0
                self.selections = 0

            def Click(self, **_kwargs: object) -> None:
                self.clicks += 1

            def GetParentControl(self):
                return self.parent

            def GetPattern(self, pattern_id: int):
                if (pattern_id == BRIDGE.automation.PatternId.SelectionItemPattern
                        and self.AutomationId.startswith("session_item_")):
                    return FakeSelectionPattern(self)
                return None

        root = FakeControl(
            "root",
            "WeChat",
            "mmui::MainWindow",
            "WindowControl",
        )
        session_list = FakeControl("session_list", "会话")
        session = FakeControl(
            "session_item_Azzy",
            "Azzy\n微信号",
            "mmui::ChatSessionCell",
            "ListItemControl",
            parent=session_list,
        )
        header = FakeControl(
            "Window.Main.Chat.current_chat_name_label",
            "Azzy",
            "mmui::XTextView",
            "TextControl",
        )
        chat_input = FakeControl(
            "chat_input_field",
            "Azzy",
            "mmui::ChatInputField",
            "EditControl",
        )
        controls = [(item, 22) for item in (session_list, session, header, chat_input)]

        def walk_at_live_depth(*_args: object, **kwargs: object):
            self.assertGreaterEqual(int(kwargs.get("maxDepth", 0)), 22)
            return iter(controls)

        with mock.patch.object(BRIDGE.automation, "ControlFromHandle", return_value=root), \
                mock.patch.object(BRIDGE.automation, "WalkControl", side_effect=walk_at_live_depth):
            selected_root, selected_input = BRIDGE.select_exact_contact_session(123, "Azzy")
        self.assertIs(selected_root, root)
        self.assertIs(selected_input, chat_input)
        self.assertEqual(session.selections, 1)
        self.assertEqual(session.clicks, 0)

        duplicate = FakeControl(
            "session_item_Azzy",
            "Azzy",
            "mmui::ChatSessionCell",
            "ListItemControl",
            parent=session_list,
        )
        duplicate_controls = [(item, 1) for item in (session_list, session, duplicate, header, chat_input)]
        with mock.patch.object(BRIDGE.automation, "ControlFromHandle", return_value=root), \
                mock.patch.object(BRIDGE.automation, "WalkControl", side_effect=lambda *_args, **_kwargs: iter(duplicate_controls)):
            with self.assertRaisesRegex(BRIDGE.TargetNotConfirmedError, "ambiguous"):
                BRIDGE.select_exact_contact_session(123, "Azzy")

        wrong_header = FakeControl(
            "current_chat_name_label",
            "Azzy (2)",
            "mmui::XTextView",
            "TextControl",
        )
        with mock.patch.object(
            BRIDGE.automation,
            "WalkControl",
            side_effect=lambda *_args, **_kwargs: iter([(wrong_header, 1), (chat_input, 1)]),
        ):
            with self.assertRaisesRegex(BRIDGE.TargetNotConfirmedError, "title"):
                BRIDGE.confirm_current_chat_target(root, "Azzy")

    def test_exact_session_falls_back_select_then_invoke_then_one_hit_tested_click(self) -> None:
        actions: list[str] = []

        class SelectionPattern:
            def Select(self, **_kwargs: object) -> bool:
                actions.append("select")
                return True

        class InvokePattern:
            def Invoke(self, **_kwargs: object) -> bool:
                actions.append("invoke")
                return True

        class SessionRow:
            AutomationId = "session_item_Azzy"
            Name = "Azzy\n微信号"
            ClassName = "mmui::ChatSessionCell"
            ControlTypeName = "ListItemControl"
            IsOffscreen = False
            IsEnabled = True
            BoundingRectangle = BRIDGE.automation.Rect(100, 200, 300, 280)

            def GetPattern(self, pattern_id: int):
                if pattern_id == BRIDGE.automation.PatternId.SelectionItemPattern:
                    return SelectionPattern()
                if pattern_id == BRIDGE.automation.PatternId.InvokePattern:
                    return InvokePattern()
                return None

            def Click(self, **kwargs: object) -> None:
                actions.append("click")
                self.click_kwargs = kwargs

        row = SessionRow()
        confirmed_input = SimpleNamespace(Name="Azzy")
        provider_noop = BRIDGE.TargetNotConfirmedError("fixture provider false success")

        def safe_click(_handle: int, _row: object) -> tuple[float, float]:
            actions.append("hit-test")
            return (0.5, 0.5)

        with mock.patch.object(BRIDGE, "find_controls_by_automation_id", return_value=[row]), \
                mock.patch.object(BRIDGE, "control_has_ancestor", return_value=True), \
                mock.patch.object(
                    BRIDGE,
                    "wait_for_fresh_session_confirmation",
                    side_effect=[
                        (None, provider_noop),
                        (None, provider_noop),
                        (confirmed_input, None),
                    ],
                ), mock.patch.object(
                    BRIDGE,
                    "require_safe_session_row_click",
                    side_effect=safe_click,
                ):
            selected = BRIDGE.select_session_item_and_confirm(
                984206,
                object(),
                row,
                "Azzy",
                timeout=0.75,
                source="main",
            )

        self.assertIs(selected, confirmed_input)
        self.assertEqual(actions, ["select", "invoke", "hit-test", "click"])
        self.assertEqual(row.click_kwargs, {
            "ratioX": 0.5,
            "ratioY": 0.5,
            "simulateMove": False,
            "waitTime": 0.2,
        })

        user32 = BRIDGE.ctypes.windll.user32
        with mock.patch.object(BRIDGE, "require_foreground_continuity") as foreground, \
                mock.patch.object(user32, "WindowFromPoint", return_value=777), \
                mock.patch.object(user32, "GetAncestor", return_value=984206), \
                mock.patch.object(BRIDGE.automation, "ControlFromPoint", return_value=row):
            self.assertEqual(
                BRIDGE.require_safe_session_row_click(984206, row),
                (0.5, 0.5),
            )
        foreground.assert_called_once_with(984206)

        with mock.patch.object(BRIDGE, "require_foreground_continuity"), \
                mock.patch.object(user32, "WindowFromPoint", return_value=777), \
                mock.patch.object(user32, "GetAncestor", return_value=656260):
            with self.assertRaisesRegex(BRIDGE.TargetNotConfirmedError, "not owned"):
                BRIDGE.require_safe_session_row_click(984206, row)

    def test_chat_input_accessibility_prompt_suffix_keeps_exact_contact_binding(self) -> None:
        root = SimpleNamespace(Name="微信")
        header = SimpleNamespace(Name="yourself")
        chat_input = SimpleNamespace(
            Name="yourself输入文字，或按住Ctrl+Win使用语音输入"
        )

        def find_controls(_root, automation_id: str, **_kwargs):
            if automation_id == "current_chat_name_label":
                return [header]
            if automation_id == "chat_input_field":
                return [chat_input]
            return []

        with mock.patch.object(
            BRIDGE,
            "find_controls_by_automation_id",
            side_effect=find_controls,
        ):
            self.assertIs(
                BRIDGE.confirm_current_chat_target(root, "yourself"),
                chat_input,
            )
            header.Name = "your"
            with self.assertRaisesRegex(BRIDGE.TargetNotConfirmedError, "chat input target"):
                BRIDGE.confirm_current_chat_target(root, "your")

    def test_search_confirmation_accepts_exact_labels_when_main_row_is_missing(self) -> None:
        root = SimpleNamespace(
            ClassName="mmui::MainWindow",
            ControlTypeName="WindowControl",
        )
        confirmed_input = SimpleNamespace(Name="Azzy")
        with mock.patch.object(
            BRIDGE,
            "find_controls_by_automation_id",
            return_value=[],
        ), mock.patch.object(
            BRIDGE,
            "selected_main_session_controls",
            return_value=[],
        ), mock.patch.object(
            BRIDGE,
            "confirm_current_chat_target",
            return_value=confirmed_input,
        ) as confirm_target:
            confirmed, error = BRIDGE.wait_for_fresh_session_confirmation(
                root,
                "Azzy",
                0.1,
                source="search",
            )

        self.assertIs(confirmed, confirmed_input)
        self.assertIsNone(error)
        confirm_target.assert_called_once()

    def test_search_confirmation_rejects_conflicting_selection_when_main_row_is_missing(self) -> None:
        root = SimpleNamespace(
            ClassName="mmui::MainWindow",
            ControlTypeName="WindowControl",
        )
        other = SimpleNamespace(AutomationId="session_item_other", Name="other")
        with mock.patch.object(
            BRIDGE,
            "find_controls_by_automation_id",
            return_value=[],
        ), mock.patch.object(
            BRIDGE,
            "selected_main_session_controls",
            return_value=[other],
        ), mock.patch.object(
            BRIDGE,
            "confirm_current_chat_target",
        ) as confirm_target, mock.patch.object(
            BRIDGE.time,
            "monotonic",
            side_effect=[0.0, 0.1],
        ):
            confirmed, error = BRIDGE.wait_for_fresh_session_confirmation(
                root,
                "Azzy",
                0.1,
                source="search",
            )

        self.assertIsNone(confirmed)
        self.assertRegex(str(error), "search-selected main session set conflicted")
        confirm_target.assert_not_called()

    def test_search_confirmation_rejects_old_title_or_input_label(self) -> None:
        root = SimpleNamespace(
            ClassName="mmui::MainWindow",
            ControlTypeName="WindowControl",
        )
        cases = [
            ("old title", "old", "Azzy", "current chat title"),
            ("old input", "Azzy", "old", "chat input target"),
        ]
        for label, header_name, input_name, expected_error in cases:
            with self.subTest(label=label):
                def find_controls(_root, automation_id: str, **_kwargs):
                    if automation_id == "session_item_Azzy":
                        return []
                    if automation_id == "current_chat_name_label":
                        return [SimpleNamespace(Name=header_name)]
                    if automation_id == "chat_input_field":
                        return [SimpleNamespace(Name=input_name)]
                    return []

                with mock.patch.object(
                    BRIDGE,
                    "find_controls_by_automation_id",
                    side_effect=find_controls,
                ), mock.patch.object(
                    BRIDGE,
                    "selected_main_session_controls",
                    return_value=[],
                ):
                    with self.assertRaisesRegex(
                        BRIDGE.TargetNotConfirmedError,
                        expected_error,
                    ):
                        BRIDGE.confirm_fresh_session_state(
                            root,
                            "Azzy",
                            source="search",
                        )

    def test_main_confirmation_still_requires_one_selected_main_row(self) -> None:
        root = SimpleNamespace(
            ClassName="mmui::MainWindow",
            ControlTypeName="WindowControl",
        )
        with mock.patch.object(
            BRIDGE,
            "find_controls_by_automation_id",
            return_value=[],
        ), self.assertRaisesRegex(
            BRIDGE.TargetNotConfirmedError,
            "main session was not unique",
        ):
            BRIDGE.confirm_fresh_session_state(root, "Azzy", source="main")

    def test_target_not_confirmed_returns_409_before_dispatch(self) -> None:
        handler = object.__new__(BRIDGE.BridgeHandler)
        handler.path = "/api/send"
        handler.server = SimpleNamespace(bridge_state=self.state)
        handler.read_json = mock.Mock(return_value={
            "contact": "Azzy",
            "talker": "wxid_canary_self",
            "text": "fixture-canary",
            "timeout": 1,
            "exactContact": True,
            "expectedContact": "Azzy",
            "expectedTalker": "wxid_canary_self",
            "requireDesktopIdleSeconds": 300,
        })
        handler.send_json = mock.Mock()
        self.state.dispatch_and_verify = mock.Mock(
            side_effect=BRIDGE.TargetNotConfirmedError("exact result missing"),
        )
        handler.do_POST()
        status, response = handler.send_json.call_args.args
        self.assertEqual(status, 409)
        self.assertEqual(response["dispatched"], False)
        self.assertEqual(response["code"], "TARGET_NOT_CONFIRMED")
        self.assertEqual(response["targetVerified"], False)

    def test_search_fallback_matches_live_shape_and_uses_one_guarded_enter(self) -> None:
        fixture = SearchFallbackFixture()
        with fixture.patched():
            selected_root, selected_input = BRIDGE.select_exact_contact_session(
                fixture.main_handle,
                fixture.contact,
                timeout=0.3,
            )

        self.assertIs(selected_root, fixture.root)
        self.assertIs(selected_input, fixture.chat_input)
        self.assertEqual(fixture.actions, ["enter"])
        self.assertTrue(fixture.main_target.selected)
        self.assertFalse(fixture.old_main.selected)
        self.assertEqual(fixture.header.Name, "yourself")
        self.assertEqual(fixture.chat_input.Name, "yourself")
        self.assertEqual("".join(fixture.unicode_chars), "yourself")
        self.assertEqual(fixture.search_value, "")
        self.assertEqual(
            fixture.search_keys,
            ["{Ctrl}a", "{Delete}", "{Enter}", "{Ctrl}a", "{Delete}"],
        )
        self.assertEqual(fixture.search_keys.count("{Enter}"), 1)
        self.assertNotIn("{Down}", fixture.search_keys)
        self.assertNotIn("{Ctrl}v", fixture.search_keys)
        self.assertEqual(fixture.chat_input_clicks, 0)
        self.assertEqual(fixture.click_kwargs, {})

    def test_search_enter_keeps_an_independent_fresh_confirmation_budget(self) -> None:
        fixture = SearchFallbackFixture()
        fixture.popup_open = True
        fixture.focused = fixture.search_edit
        with fixture.patched(), mock.patch.object(
            BRIDGE,
            "wait_for_fresh_session_confirmation",
            return_value=(fixture.chat_input, None),
        ) as wait_for_confirmation:
            selected = BRIDGE.select_session_item_and_confirm(
                fixture.main_handle,
                fixture.root,
                fixture.search_result,
                fixture.contact,
                timeout=0.01,
                source="search",
            )

        self.assertIs(selected, fixture.chat_input)
        self.assertEqual(fixture.actions, ["enter"])
        self.assertGreaterEqual(
            wait_for_confirmation.call_args.args[2],
            BRIDGE.MIN_SEARCH_SELECTION_CONFIRM_SECONDS,
        )

    def test_search_enter_waits_for_fresh_exact_row_to_rematerialize(self) -> None:
        fixture = SearchFallbackFixture()
        fixture.popup_open = True
        fixture.focused = fixture.search_edit
        original_find = BRIDGE.find_controls_by_automation_id
        search_reads = {"count": 0}

        def transient_find(root, automation_id: str, **kwargs):
            if automation_id == f"search_item_{fixture.contact}":
                search_reads["count"] += 1
                if search_reads["count"] <= 2:
                    return []
            return original_find(root, automation_id, **kwargs)

        with fixture.patched(), mock.patch.object(
            BRIDGE,
            "find_controls_by_automation_id",
            side_effect=transient_find,
        ):
            confirmed, error = BRIDGE.select_exact_search_result_with_enter(
                fixture.main_handle,
                fixture.root,
                fixture.contact,
                timeout=0.3,
            )

        self.assertIs(confirmed, fixture.chat_input)
        self.assertIsNone(error)
        self.assertGreaterEqual(search_reads["count"], 3)
        self.assertEqual(fixture.actions, ["enter"])
        self.assertEqual(fixture.search_keys.count("{Enter}"), 1)
        self.assertNotIn("{Down}", fixture.search_keys)
        self.assertEqual(fixture.click_kwargs, {})

    def test_search_enter_rejects_fresh_duplicate_rows_without_action(self) -> None:
        fixture = SearchFallbackFixture(duplicate_exact=True)
        fixture.popup_open = True
        fixture.focused = fixture.search_edit

        with fixture.patched(), self.assertRaisesRegex(
            BRIDGE.TargetNotConfirmedError,
            "became ambiguous before Enter",
        ):
            BRIDGE.select_exact_search_result_with_enter(
                fixture.main_handle,
                fixture.root,
                fixture.contact,
                timeout=0.3,
            )

        self.assertEqual(fixture.actions, [])
        self.assertNotIn("{Enter}", fixture.search_keys)
        self.assertEqual(fixture.click_kwargs, {})

    def test_search_navigation_derives_one_down_from_stable_content_order(self) -> None:
        fixture = SearchFallbackFixture()
        fixture.popup_open = True
        fixture.focused = fixture.search_edit
        predecessor = fixture.Control(
            fixture,
            "search_item_first",
            "first",
            "mmui::SearchContentCellView",
            "ListItemControl",
            parent=fixture.search_list,
            bounds=(288, 198, 688, 278),
        )
        fixture.search_result.BoundingRectangle = BRIDGE.automation.Rect(
            288, 318, 688, 398,
        )
        original_walk = fixture.walk

        def walk_with_predecessor(*args: object, **kwargs: object):
            controls = list(original_walk(*args, **kwargs))
            if fixture.popup_open:
                controls.append((predecessor, 10))
            return iter(controls)

        fixture.walk = walk_with_predecessor
        with fixture.patched():
            confirmed, error = BRIDGE.select_exact_search_result_with_enter(
                fixture.main_handle,
                fixture.root,
                fixture.contact,
                timeout=0.3,
            )

        self.assertIs(confirmed, fixture.chat_input)
        self.assertIsNone(error)
        self.assertEqual(fixture.search_keys, ["{Down}", "{Enter}"])
        self.assertEqual(fixture.actions, ["enter"])
        self.assertEqual(fixture.click_kwargs, {})

    def test_search_navigation_rejects_order_change_after_down_before_enter(self) -> None:
        fixture = SearchFallbackFixture()
        fixture.popup_open = True
        fixture.focused = fixture.search_edit
        predecessor = fixture.Control(
            fixture,
            "search_item_first",
            "first",
            "mmui::SearchContentCellView",
            "ListItemControl",
            parent=fixture.search_list,
            bounds=(288, 198, 688, 278),
        )
        fixture.search_result.BoundingRectangle = BRIDGE.automation.Rect(
            288, 318, 688, 398,
        )
        original_walk = fixture.walk

        def walk_with_predecessor(*args: object, **kwargs: object):
            controls = list(original_walk(*args, **kwargs))
            if fixture.popup_open:
                controls.append((predecessor, 10))
            return iter(controls)

        fixture.walk = walk_with_predecessor
        original_send_keys = fixture.send_keys

        def mutate_after_down(keys: str, **kwargs: object) -> None:
            original_send_keys(keys, **kwargs)
            if keys == "{Down}":
                predecessor.AutomationId = "search_item_changed"
                predecessor.Name = "changed"

        fixture.send_keys = mutate_after_down
        with fixture.patched(), self.assertRaisesRegex(
            BRIDGE.TargetNotConfirmedError,
            "identity changed during keyboard navigation",
        ):
            BRIDGE.select_exact_search_result_with_enter(
                fixture.main_handle,
                fixture.root,
                fixture.contact,
                timeout=0.3,
            )

        self.assertEqual(fixture.search_keys, ["{Down}"])
        self.assertNotIn("{Enter}", fixture.search_keys)
        self.assertEqual(fixture.actions, [])

    def test_search_navigation_rejects_target_beyond_bounded_down_limit(self) -> None:
        fixture = SearchFallbackFixture()
        fixture.popup_open = True
        fixture.focused = fixture.search_edit
        predecessors = [
            fixture.Control(
                fixture,
                f"search_item_first_{index}",
                f"first_{index}",
                "mmui::SearchContentCellView",
                "ListItemControl",
                parent=fixture.search_list,
                bounds=(288, 198 + index * 8, 688, 205 + index * 8),
            )
            for index in range(BRIDGE.MAX_SEARCH_NAVIGATION_DOWNS + 1)
        ]
        fixture.search_result.BoundingRectangle = BRIDGE.automation.Rect(
            288, 400, 688, 480,
        )
        original_walk = fixture.walk

        def walk_with_many_predecessors(*args: object, **kwargs: object):
            controls = list(original_walk(*args, **kwargs))
            if fixture.popup_open:
                controls.extend((item, 10) for item in predecessors)
            return iter(controls)

        fixture.walk = walk_with_many_predecessors
        with fixture.patched(), self.assertRaisesRegex(
            BRIDGE.TargetNotConfirmedError,
            "required too many navigation steps",
        ):
            BRIDGE.select_exact_search_result_with_enter(
                fixture.main_handle,
                fixture.root,
                fixture.contact,
                timeout=0.3,
            )

        self.assertEqual(fixture.search_keys, [])
        self.assertEqual(fixture.actions, [])

    def test_search_navigation_rejects_focus_loss_after_down_before_enter(self) -> None:
        fixture = SearchFallbackFixture()
        fixture.popup_open = True
        fixture.focused = fixture.search_edit
        predecessor = fixture.Control(
            fixture,
            "search_item_first",
            "first",
            "mmui::SearchContentCellView",
            "ListItemControl",
            parent=fixture.search_list,
            bounds=(288, 198, 688, 278),
        )
        fixture.search_result.BoundingRectangle = BRIDGE.automation.Rect(
            288, 318, 688, 398,
        )
        original_walk = fixture.walk

        def walk_with_predecessor(*args: object, **kwargs: object):
            controls = list(original_walk(*args, **kwargs))
            if fixture.popup_open:
                controls.append((predecessor, 10))
            return iter(controls)

        fixture.walk = walk_with_predecessor
        original_send_keys = fixture.send_keys

        def lose_focus_after_down(keys: str, **kwargs: object) -> None:
            original_send_keys(keys, **kwargs)
            if keys == "{Down}":
                fixture.focused = predecessor

        fixture.send_keys = lose_focus_after_down
        with fixture.patched(), self.assertRaisesRegex(
            BRIDGE.TargetNotConfirmedError,
            "search field focus was not confirmed",
        ):
            BRIDGE.select_exact_search_result_with_enter(
                fixture.main_handle,
                fixture.root,
                fixture.contact,
                timeout=0.3,
            )

        self.assertEqual(fixture.search_keys, ["{Down}"])
        self.assertNotIn("{Enter}", fixture.search_keys)
        self.assertEqual(fixture.actions, [])

    def test_search_enter_still_requires_an_unobscured_exact_row_point(self) -> None:
        fixture = SearchFallbackFixture()
        original_control_from_point = fixture.control_from_point

        def center_is_obscured(x: int, y: int):
            bounds = BRIDGE.control_bounds(fixture.search_result)
            assert bounds is not None
            center_y = bounds[1] + int((bounds[3] - bounds[1]) * 0.5)
            if y == center_y:
                return fixture.search_edit
            return original_control_from_point(x, y)

        fixture.control_from_point = center_is_obscured
        with fixture.patched():
            BRIDGE.select_exact_contact_session(
                fixture.main_handle,
                fixture.contact,
                timeout=0.3,
            )

        self.assertEqual(fixture.actions, ["enter"])
        self.assertEqual(fixture.click_kwargs, {})

    def test_search_enter_noop_fails_without_click_down_or_second_enter(self) -> None:
        fixture = SearchFallbackFixture()
        original_send_keys = fixture.send_keys

        def enter_is_noop(keys: str, **kwargs: object) -> None:
            if keys == "{Enter}":
                fixture.search_keys.append(keys)
                fixture.actions.append("enter")
                return
            original_send_keys(keys, **kwargs)

        fixture.send_keys = enter_is_noop
        enter_noop_error = BRIDGE.TargetNotConfirmedError("fixture Enter no-op")
        with fixture.patched(), mock.patch.object(
            BRIDGE,
            "wait_for_fresh_session_confirmation",
            return_value=(None, enter_noop_error),
        ):
            with self.assertRaisesRegex(
                BRIDGE.TargetNotConfirmedError,
                "search_edit.Enter",
            ):
                BRIDGE.select_exact_contact_session(
                    fixture.main_handle,
                    fixture.contact,
                    timeout=0.3,
                )

        self.assertEqual(fixture.actions, ["enter"])
        self.assertEqual(fixture.search_keys.count("{Enter}"), 1)
        self.assertNotIn("{Down}", fixture.search_keys)
        self.assertNotIn("{Ctrl}v", fixture.search_keys)
        self.assertEqual(fixture.chat_input_clicks, 0)

    def test_search_enter_is_rejected_when_the_exact_row_is_fully_obscured(self) -> None:
        fixture = SearchFallbackFixture()
        fixture.popup_open = True
        fixture.focused = fixture.search_edit
        fixture.control_from_point = lambda _x, _y: fixture.search_edit
        with fixture.patched(), self.assertRaisesRegex(
            BRIDGE.TargetNotConfirmedError,
            "no unobscured UIA-owned click point",
        ):
            BRIDGE.select_session_item_and_confirm(
                fixture.main_handle,
                fixture.root,
                fixture.search_result,
                fixture.contact,
                timeout=0.01,
                source="search",
            )
        self.assertEqual(fixture.actions, [])

    def test_search_fallback_rejects_wrong_shape_owner_popup_and_duplicates_before_action(self) -> None:
        cases = [
            ("chat-record row", {"wrong_row_class": True}),
            ("chat-record ancestry", {"wrong_ancestry": True}),
            ("wrong popup UIA", {"wrong_popup_class": True}),
            ("wrong search list UIA", {"wrong_list_class": True}),
            ("popup without owner", {"popup_owner": 0}),
            ("popup owned by another window", {"popup_owner": 456}),
            ("popup root equals main", {"popup_handle": 984206}),
            ("two exact rows", {"duplicate_exact": True}),
        ]
        for label, kwargs in cases:
            with self.subTest(label=label):
                fixture = SearchFallbackFixture(**kwargs)
                with fixture.patched(), self.assertRaises(BRIDGE.TargetNotConfirmedError):
                    BRIDGE.select_exact_contact_session(
                        fixture.main_handle,
                        fixture.contact,
                        timeout=0.2,
                    )
                self.assertEqual(fixture.actions, [])
                self.assertEqual(fixture.chat_input_clicks, 0)
                self.assertNotIn("{Enter}", fixture.search_keys)
                self.assertNotIn("{Ctrl}v", fixture.search_keys)
                self.assertEqual(fixture.search_value, "")

        old_shape = SearchFallbackFixture()
        old_shape.search_result.AutomationId = "session_item_yourself"
        old_shape.search_result.ClassName = "mmui::ChatSessionCell"
        with old_shape.patched(), self.assertRaises(BRIDGE.TargetNotConfirmedError):
            BRIDGE.select_exact_contact_session(
                old_shape.main_handle,
                old_shape.contact,
                timeout=0.2,
            )
        self.assertEqual(old_shape.actions, [])
        self.assertEqual(old_shape.chat_input_clicks, 0)

    def test_search_popup_owner_is_revalidated_immediately_before_single_click(self) -> None:
        fixture = SearchFallbackFixture(owner_sequence=[984206, 456])
        with fixture.patched(), self.assertRaises(BRIDGE.TargetNotConfirmedError):
            BRIDGE.select_exact_contact_session(
                fixture.main_handle,
                fixture.contact,
                timeout=0.2,
            )
        self.assertEqual(fixture.actions, [])
        self.assertEqual(fixture.chat_input_clicks, 0)
        self.assertNotIn("{Enter}", fixture.search_keys)
        self.assertEqual(fixture.search_value, "")

    def test_search_candidate_waits_for_popup_tree_materialization_before_action(self) -> None:
        fixture = SearchFallbackFixture(materialization_walks=2)
        with fixture.patched():
            BRIDGE.select_exact_contact_session(
                fixture.main_handle,
                fixture.contact,
                timeout=0.5,
            )
        self.assertEqual(fixture.materialization_walks, 0)
        self.assertEqual(fixture.actions, ["enter"])
        self.assertTrue(fixture.main_target.selected)
        self.assertEqual(fixture.search_value, "")

    def test_search_candidate_waits_for_native_popup_owner_before_action(self) -> None:
        fixture = SearchFallbackFixture(
            owner_sequence=[0, 984206, 984206, 984206, 984206],
        )
        with fixture.patched():
            BRIDGE.select_exact_contact_session(
                fixture.main_handle,
                fixture.contact,
                timeout=0.5,
            )
        self.assertEqual(fixture.owner_returns[0], 0)
        self.assertEqual(fixture.actions, ["enter"])
        self.assertTrue(fixture.main_target.selected)
        self.assertEqual(fixture.search_value, "")

    def test_search_cleanup_has_independent_wait_for_delayed_value_and_popup_close(self) -> None:
        fixture = SearchFallbackFixture()
        fixture.search_value = "old"
        fixture.popup_open = True
        value_reads = {"remaining": 5}
        popup_walks = {"remaining": 4, "esc_seen": False}

        class DelayedValuePattern:
            @property
            def Value(self) -> str:
                if value_reads["remaining"] > 0:
                    value_reads["remaining"] -= 1
                    return "old"
                return fixture.search_value

        original_get_pattern = fixture.search_edit.GetPattern
        fixture.search_edit.GetPattern = lambda pattern_id: (
            DelayedValuePattern()
            if pattern_id == BRIDGE.automation.PatternId.ValuePattern
            else original_get_pattern(pattern_id)
        )
        original_send_keys = fixture.send_keys

        def delayed_send_keys(keys: str, **kwargs: object) -> None:
            original_send_keys(keys, **kwargs)
            if keys == "{Esc}":
                popup_walks["esc_seen"] = True
                fixture.popup_open = True

        fixture.send_keys = delayed_send_keys
        original_walk = fixture.walk

        def delayed_walk(*args: object, **kwargs: object):
            if popup_walks["esc_seen"] and popup_walks["remaining"] > 0:
                popup_walks["remaining"] -= 1
                if popup_walks["remaining"] == 0:
                    fixture.popup_open = False
            return original_walk(*args, **kwargs)

        fixture.walk = delayed_walk
        with fixture.patched():
            BRIDGE.replace_main_session_search_text(
                fixture.main_handle,
                fixture.root,
                "",
                verify_timeout=0.3,
            )

        self.assertEqual(fixture.search_value, "")
        self.assertFalse(fixture.popup_open)
        self.assertIn("{Esc}", fixture.search_keys)
        self.assertEqual(value_reads["remaining"], 0)
        self.assertEqual(popup_walks["remaining"], 0)

    def test_search_cleanup_error_preserves_the_original_selection_error(self) -> None:
        root = SimpleNamespace(
            AutomationId="",
            Name="微信",
            ClassName="mmui::MainWindow",
            ControlTypeName="WindowControl",
        )
        with mock.patch.object(BRIDGE.automation, "ControlFromHandle", return_value=root), \
                mock.patch.object(BRIDGE, "find_controls_by_automation_id", return_value=[]), \
                mock.patch.object(
                    BRIDGE,
                    "replace_main_session_search_text",
                    side_effect=[
                        BRIDGE.TargetNotConfirmedError("selection fixture"),
                        BRIDGE.TargetNotConfirmedError("cleanup fixture"),
                    ],
                ):
            with self.assertRaises(BRIDGE.TargetNotConfirmedError) as raised:
                BRIDGE.select_exact_contact_session(984206, "yourself")
        self.assertIn("selection fixture", str(raised.exception))
        self.assertIn("cleanup fixture", str(raised.exception))

    def test_search_target_failure_precedes_chat_input_clipboard_and_enter(self) -> None:
        fixture = SearchFallbackFixture(popup_owner=0)
        with fixture.patched(), \
                mock.patch.object(
                    BRIDGE,
                    "find_wechat_window_handle",
                    return_value=fixture.main_handle,
                ), mock.patch.object(BRIDGE, "activate_window"), \
                mock.patch.object(BRIDGE.pyperclip, "paste") as clipboard_read, \
                mock.patch.object(BRIDGE.pyperclip, "copy") as clipboard_write:
            with self.assertRaises(BRIDGE.TargetNotConfirmedError):
                self.state._dispatch_text(
                    fixture.contact,
                    "fixture-reply",
                    exact_contact=False,
                )
        clipboard_read.assert_not_called()
        clipboard_write.assert_not_called()
        self.assertEqual(fixture.chat_input_clicks, 0)
        self.assertNotIn("{Enter}", fixture.search_keys)
        self.assertNotIn("{Ctrl}v", fixture.search_keys)

    def test_exact_reply_without_idle_field_requires_foreground_continuity(self) -> None:
        handler = object.__new__(BRIDGE.BridgeHandler)
        handler.path = "/api/send"
        handler.server = SimpleNamespace(bridge_state=self.state)
        handler.read_json = mock.Mock(return_value={
            "contact": "Azzy",
            "talker": "wxid_canary_self",
            "text": "fixture-canary-reply",
            "timeout": 1,
            "exactContact": True,
            "expectedContact": "Azzy",
            "expectedTalker": "wxid_canary_self",
        })
        handler.send_json = mock.Mock()
        self.state.dispatch_and_verify = mock.Mock(
            side_effect=BRIDGE.DesktopActiveError(2, 300),
        )
        handler.do_POST()
        self.state.dispatch_and_verify.assert_called_once_with(
            "Azzy",
            "wxid_canary_self",
            "fixture-canary-reply",
            1.0,
            require_desktop_idle_seconds=None,
            exact_contact=True,
            expected_contact="Azzy",
            expected_talker="wxid_canary_self",
        )
        status, response = handler.send_json.call_args.args
        self.assertEqual(status, 409)
        self.assertEqual(response["code"], "CANARY_DESKTOP_ACTIVE")
        self.assertEqual(response["dispatched"], False)

        with mock.patch.object(BRIDGE, "find_wechat_window_handle", return_value=123), \
                mock.patch.object(BRIDGE, "activate_window") as activate, \
                mock.patch.object(BRIDGE.ctypes.windll.user32, "GetForegroundWindow", return_value=456):
            with self.assertRaises(BRIDGE.DesktopActiveError):
                self.state._dispatch_text(
                    "Azzy",
                    "fixture-canary-reply",
                    require_desktop_idle_seconds=None,
                    exact_contact=True,
                )
        activate.assert_not_called()

    def test_final_foreground_and_focus_gates_precede_any_clipboard_or_keystroke(self) -> None:
        class FakeInput:
            AutomationId = "chat_input_field"
            Name = "Azzy"
            ClassName = "mmui::ChatInputField"
            ControlTypeName = "EditControl"

            def Click(self, **_kwargs: object) -> None:
                return None

        root = SimpleNamespace(Name="微信")
        chat_input = FakeInput()

        common_patches = (
            mock.patch.object(BRIDGE, "find_wechat_window_handle", return_value=123),
            mock.patch.object(BRIDGE, "activate_window"),
            mock.patch.object(
                BRIDGE,
                "select_exact_contact_session",
                return_value=(root, chat_input),
            ),
            mock.patch.object(BRIDGE, "confirm_current_chat_target", return_value=chat_input),
            mock.patch.object(BRIDGE, "get_last_input_tick", return_value=77),
            mock.patch.object(BRIDGE, "require_no_competing_desktop_input"),
            mock.patch.object(BRIDGE.time, "sleep", return_value=None),
            mock.patch.object(BRIDGE.pyperclip, "paste"),
            mock.patch.object(BRIDGE.pyperclip, "copy"),
            mock.patch.object(BRIDGE.automation, "SendKeys"),
        )

        with common_patches[0] as _find, common_patches[1] as _activate, \
                common_patches[2] as _select, common_patches[3] as _confirm, \
                common_patches[4] as _tick, common_patches[5] as _quiet, \
                common_patches[6] as _sleep, common_patches[7] as clipboard_read, \
                common_patches[8] as clipboard_write, common_patches[9] as send_keys, \
                mock.patch.object(
                    BRIDGE.ctypes.windll.user32,
                    "GetForegroundWindow",
                    side_effect=[123, 456],
                ), mock.patch.object(BRIDGE.automation, "GetFocusedControl") as focused:
            with self.assertRaises(BRIDGE.DesktopActiveError):
                self.state._dispatch_text(
                    "Azzy",
                    "fixture-canary-reply",
                    exact_contact=True,
                )
        clipboard_read.assert_not_called()
        clipboard_write.assert_not_called()
        send_keys.assert_not_called()
        focused.assert_not_called()

        with mock.patch.object(BRIDGE, "find_wechat_window_handle", return_value=123), \
                mock.patch.object(BRIDGE, "activate_window"), \
                mock.patch.object(
                    BRIDGE,
                    "select_exact_contact_session",
                    return_value=(root, chat_input),
                ), mock.patch.object(
                    BRIDGE,
                    "confirm_current_chat_target",
                    return_value=chat_input,
                ), mock.patch.object(BRIDGE, "get_last_input_tick", return_value=77), \
                mock.patch.object(BRIDGE, "require_no_competing_desktop_input"), \
                mock.patch.object(BRIDGE.time, "sleep", return_value=None), \
                mock.patch.object(BRIDGE.pyperclip, "paste") as clipboard_read, \
                mock.patch.object(BRIDGE.pyperclip, "copy") as clipboard_write, \
                mock.patch.object(BRIDGE.automation, "SendKeys") as send_keys, \
                mock.patch.object(
                    BRIDGE.ctypes.windll.user32,
                    "GetForegroundWindow",
                    return_value=123,
                ), mock.patch.object(
                    BRIDGE.automation,
                    "GetFocusedControl",
                    return_value=SimpleNamespace(
                        AutomationId="another_editor",
                        Name="Azzy",
                        ClassName="mmui::ChatInputField",
                        ControlTypeName="EditControl",
                    ),
                ):
            with self.assertRaises(BRIDGE.TargetNotConfirmedError):
                self.state._dispatch_text(
                    "Azzy",
                    "fixture-canary-reply",
                    exact_contact=True,
                )
        clipboard_read.assert_not_called()
        clipboard_write.assert_not_called()
        send_keys.assert_not_called()

    def test_text_dispatch_uses_exact_value_pattern_and_never_the_clipboard(self) -> None:
        class FakeValuePattern:
            def __init__(self) -> None:
                self.Value = ""

            def SetValue(self, value: str) -> None:
                self.Value = value

        class FakeInput:
            def __init__(self) -> None:
                self.value_pattern = FakeValuePattern()

            def Click(self, **_kwargs: object) -> None:
                return None

            def GetPattern(self, pattern_id: int):
                if pattern_id == BRIDGE.automation.PatternId.ValuePattern:
                    return self.value_pattern
                return None

        root = SimpleNamespace(Name="微信")
        chat_input = FakeInput()
        payload = "中文、emoji 🧪\nsecond line"
        with mock.patch.object(BRIDGE, "find_wechat_window_handle", return_value=123), \
                mock.patch.object(BRIDGE, "activate_window"), \
                mock.patch.object(
                    BRIDGE,
                    "select_exact_contact_session",
                    return_value=(root, chat_input),
                ), mock.patch.object(
                    BRIDGE,
                    "confirm_current_chat_target",
                    return_value=chat_input,
                ), mock.patch.object(BRIDGE, "require_foreground_continuity"), \
                mock.patch.object(BRIDGE, "require_focused_chat_input"), \
                mock.patch.object(BRIDGE, "get_last_input_tick", return_value=77), \
                mock.patch.object(BRIDGE, "require_no_competing_desktop_input"), \
                mock.patch.object(BRIDGE.pyperclip, "paste") as clipboard_read, \
                mock.patch.object(BRIDGE.pyperclip, "copy") as clipboard_write, \
                mock.patch.object(BRIDGE.automation, "SendKeys") as send_keys:
            result = self.state._dispatch_text("yourself", payload)

        self.assertEqual(result["exactContact"], False)
        self.assertEqual(chat_input.value_pattern.Value, payload)
        send_keys.assert_called_once_with("{Enter}", waitTime=0.05)
        clipboard_read.assert_not_called()
        clipboard_write.assert_not_called()

    def test_chat_input_value_write_fails_closed_for_missing_nonempty_or_inexact_value(self) -> None:
        class FakeInput:
            def __init__(self, pattern) -> None:
                self.pattern = pattern

            def GetPattern(self, pattern_id: int):
                if pattern_id == BRIDGE.automation.PatternId.ValuePattern:
                    return self.pattern
                return None

        class Pattern:
            def __init__(self, value: str = "", *, corrupt: bool = False) -> None:
                self.Value = value
                self.corrupt = corrupt

            def SetValue(self, value: str) -> None:
                self.Value = f"{value}-wrong" if self.corrupt and value else value

        cases = (
            ("missing", FakeInput(None), "does not expose"),
            ("nonempty", FakeInput(Pattern("user draft")), "was not empty"),
        )
        for label, control, expected in cases:
            with self.subTest(label=label), self.assertRaisesRegex(
                BRIDGE.TargetNotConfirmedError,
                expected,
            ):
                BRIDGE.write_chat_input_without_clipboard(control, "fixture", verify_timeout=0.01)

        corrupt = Pattern(corrupt=True)
        with self.assertRaisesRegex(
            BRIDGE.TargetNotConfirmedError,
            "did not expose the exact requested text",
        ):
            BRIDGE.write_chat_input_without_clipboard(
                FakeInput(corrupt),
                "fixture",
                verify_timeout=0.01,
            )
        # A mismatching readback is not proven to be bridge-owned: it can
        # include text typed concurrently by the user, so leave it untouched.
        self.assertEqual(corrupt.Value, "fixture-wrong")

        class ReadFailsOnceAfterWrite:
            def __init__(self) -> None:
                self.stored = ""
                self.fail_next_read = False

            @property
            def Value(self) -> str:
                if self.fail_next_read:
                    self.fail_next_read = False
                    raise RuntimeError("transient read failure")
                return self.stored

            def SetValue(self, value: str) -> None:
                self.stored = value
                self.fail_next_read = bool(value)

        transient_read = ReadFailsOnceAfterWrite()
        with self.assertRaisesRegex(
            BRIDGE.TargetNotConfirmedError,
            "value could not be read",
        ):
            BRIDGE.write_chat_input_without_clipboard(
                FakeInput(transient_read),
                "fixture",
                verify_timeout=0.01,
            )
        self.assertEqual(transient_read.Value, "")

        class SetRaisesAfterWrite:
            def __init__(self) -> None:
                self.Value = ""

            def SetValue(self, value: str) -> None:
                self.Value = value
                if value:
                    raise RuntimeError("write acknowledgement failure")

        failed_write = SetRaisesAfterWrite()
        with self.assertRaisesRegex(
            BRIDGE.TargetNotConfirmedError,
            "could not be written",
        ):
            BRIDGE.write_chat_input_without_clipboard(
                FakeInput(failed_write),
                "fixture",
                verify_timeout=0.01,
            )
        self.assertEqual(failed_write.Value, "")

    def test_text_dispatch_rejects_recreated_editor_without_sending_or_erasing_user_text(self) -> None:
        class FakeValuePattern:
            def __init__(self, value: str = "") -> None:
                self.Value = value

            def SetValue(self, value: str) -> None:
                self.Value = value

        class FakeInput:
            def __init__(self, value: str = "") -> None:
                self.value_pattern = FakeValuePattern(value)

            def Click(self, **_kwargs: object) -> None:
                return None

            def GetPattern(self, pattern_id: int):
                if pattern_id == BRIDGE.automation.PatternId.ValuePattern:
                    return self.value_pattern
                return None

        root = SimpleNamespace(Name="微信")
        original_input = FakeInput()
        recreated_input = FakeInput("concurrent user draft")
        payload = "fixture-payload"

        with mock.patch.object(BRIDGE, "find_wechat_window_handle", return_value=123), \
                mock.patch.object(BRIDGE, "activate_window"), \
                mock.patch.object(
                    BRIDGE,
                    "select_exact_contact_session",
                    return_value=(root, original_input),
                ), mock.patch.object(
                    BRIDGE,
                    "confirm_current_chat_target",
                    return_value=recreated_input,
                ), mock.patch.object(BRIDGE, "require_foreground_continuity"), \
                mock.patch.object(BRIDGE, "require_focused_chat_input"), \
                mock.patch.object(BRIDGE, "get_last_input_tick", return_value=77), \
                mock.patch.object(BRIDGE, "require_no_competing_desktop_input"), \
                mock.patch.object(BRIDGE.time, "sleep", return_value=None), \
                mock.patch.object(BRIDGE.automation, "SendKeys") as send_keys:
            with self.assertRaisesRegex(
                BRIDGE.TargetNotConfirmedError,
                "fresh confirmed chat input did not retain",
            ):
                self.state._dispatch_text("yourself", payload)

        send_keys.assert_not_called()
        self.assertEqual(original_input.value_pattern.Value, "")
        self.assertEqual(recreated_input.value_pattern.Value, "concurrent user draft")

    def test_ordinary_text_and_image_recheck_foreground_before_clipboard_or_keys(self) -> None:
        class FakeInput:
            def Click(self, **_kwargs: object) -> None:
                return None

        root = SimpleNamespace(Name="微信")
        chat_input = FakeInput()
        for operation in (
            lambda: self.state._dispatch_text("fixture-contact", "fixture-text"),
            lambda: self.state._dispatch_image("fixture-contact", b"fixture-image"),
        ):
            with self.subTest(operation=operation), \
                    mock.patch.object(BRIDGE, "find_wechat_window_handle", return_value=123), \
                    mock.patch.object(BRIDGE, "activate_window"), \
                    mock.patch.object(
                        BRIDGE,
                        "select_exact_contact_session",
                        return_value=(root, chat_input),
                    ), mock.patch.object(
                        BRIDGE,
                        "confirm_current_chat_target",
                        return_value=chat_input,
                    ), mock.patch.object(BRIDGE.time, "sleep", return_value=None), \
                    mock.patch.object(BRIDGE.pyperclip, "paste") as clipboard_read, \
                    mock.patch.object(BRIDGE.pyperclip, "copy") as clipboard_write, \
                    mock.patch.object(BRIDGE, "set_clipboard_dib") as set_image_clipboard, \
                    mock.patch.object(BRIDGE.automation, "SendKeys") as send_keys, \
                    mock.patch.object(
                        BRIDGE.ctypes.windll.user32,
                        "GetForegroundWindow",
                        return_value=456,
                    ):
                with self.assertRaises(BRIDGE.DesktopActiveError):
                    operation()
            clipboard_read.assert_not_called()
            clipboard_write.assert_not_called()
            set_image_clipboard.assert_not_called()
            send_keys.assert_not_called()

    def test_exact_verification_requires_self_chat_sender_to_equal_expected_talker(self) -> None:
        wrong = {
            "localId": 71,
            "isSend": 1,
            "content": "fixture-canary",
            "senderUsername": "wxid_wrong",
            "createTime": int(BRIDGE.time.time()),
        }
        right = {
            **wrong,
            "localId": 72,
            "senderUsername": "wxid_canary_self",
        }
        self.state._dispatch_text = mock.Mock(return_value={
            "exactContact": True,
            "selectedContact": "Azzy",
        })
        self.state.fetch_messages = mock.Mock(side_effect=[[], [wrong, right]])
        result = self.state.dispatch_and_verify(
            "Azzy",
            "wxid_canary_self",
            "fixture-canary",
            1,
            exact_contact=True,
            expected_contact="Azzy",
            expected_talker="wxid_canary_self",
        )
        self.assertEqual(result["verified"], True)
        self.assertEqual(result["localId"], "72")
        self.assertEqual(result["targetVerified"], True)
        self.assertEqual(result["selectedContact"], "Azzy")
        self.assertEqual(result["verifiedTalker"], "wxid_canary_self")
        self.assertFalse(self.state.message_matches(wrong, "fixture-canary", "wxid_canary_self"))

    def test_exact_send_initializes_and_uninitializes_com_inside_a_new_worker_thread(self) -> None:
        active_threads: set[int] = set()
        lifecycle: list[tuple[str, int]] = []
        result: dict[str, object] = {}
        failures: list[BaseException] = []

        def initialize() -> None:
            thread_id = threading.get_ident()
            active_threads.add(thread_id)
            lifecycle.append(("initialize", thread_id))

        def uninitialize() -> None:
            thread_id = threading.get_ident()
            self.assertIn(thread_id, active_threads)
            active_threads.remove(thread_id)
            lifecycle.append(("uninitialize", thread_id))

        def dispatch_text(*_args: object, **_kwargs: object) -> dict[str, object]:
            if threading.get_ident() not in active_threads:
                raise OSError(-2147221008, "CoInitialize was not called")
            return {"exactContact": True, "selectedContact": "Azzy"}

        row = {
            "localId": 81,
            "isSend": 1,
            "content": "fixture-thread-canary",
            "senderUsername": "wxid_canary_self",
            "createTime": int(BRIDGE.time.time()),
        }
        self.state.fetch_messages = mock.Mock(side_effect=[[], [row]])
        self.state._dispatch_text = dispatch_text

        def run_exact_send() -> None:
            try:
                result.update(self.state.dispatch_and_verify(
                    "Azzy",
                    "wxid_canary_self",
                    "fixture-thread-canary",
                    1,
                    exact_contact=True,
                    expected_contact="Azzy",
                    expected_talker="wxid_canary_self",
                ))
            except BaseException as error:  # Preserve worker failures for the main test thread.
                failures.append(error)

        with mock.patch.object(
            BRIDGE.automation,
            "InitializeUIAutomationInCurrentThread",
            side_effect=initialize,
        ), mock.patch.object(
            BRIDGE.automation,
            "UninitializeUIAutomationInCurrentThread",
            side_effect=uninitialize,
        ):
            worker = threading.Thread(target=run_exact_send, name="fixture-http-worker")
            worker.start()
            worker.join(timeout=3)

        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(result["verified"], True)
        self.assertEqual(result["targetVerified"], True)
        self.assertEqual([item[0] for item in lifecycle], ["initialize", "uninitialize"])
        self.assertEqual(lifecycle[0][1], lifecycle[1][1])
        self.assertNotEqual(lifecycle[0][1], threading.get_ident())
        self.assertEqual(active_threads, set())

    def test_normal_text_image_and_ready_check_balance_their_com_scope(self) -> None:
        apartment = threading.local()
        lifecycle: list[str] = []

        def initialize() -> None:
            apartment.ready = True
            lifecycle.append("initialize")

        def uninitialize() -> None:
            self.assertTrue(getattr(apartment, "ready", False))
            apartment.ready = False
            lifecycle.append("uninitialize")

        def assert_com_ready() -> None:
            if not getattr(apartment, "ready", False):
                raise OSError(-2147221008, "CoInitialize was not called")

        self.state.fetch_messages = mock.Mock(side_effect=[
            [],
            [{"localId": 91, "isSend": 1, "content": "ordinary text"}],
        ])
        self.state._dispatch_text = lambda *_args, **_kwargs: (
            assert_com_ready() or {"exactContact": False, "selectedContact": ""}
        )
        target, image_bytes, digest = self.make_png("com-scope.png")

        def dispatch_image(*_args: object, **_kwargs: object) -> None:
            assert_com_ready()

        with mock.patch.object(
            BRIDGE.automation,
            "InitializeUIAutomationInCurrentThread",
            side_effect=initialize,
        ), mock.patch.object(
            BRIDGE.automation,
            "UninitializeUIAutomationInCurrentThread",
            side_effect=uninitialize,
        ), mock.patch.object(BRIDGE, "find_wechat_window_handle", side_effect=lambda **_kwargs: (
            assert_com_ready() or 123
        )):
            text_result = self.state.dispatch_and_verify(
                "fixture-contact",
                "fixture-talker",
                "ordinary text",
                1,
            )
            self.assertEqual(text_result["verified"], True)

            self.state.fetch_messages = mock.Mock(side_effect=[
                [],
                [{"localId": 92, "isSend": 1, "localType": 3, "content": "[图片]"}],
            ])
            self.state._dispatch_image = dispatch_image
            image_result = self.state.dispatch_image_and_verify(
                "fixture-contact",
                "fixture-talker",
                str(target),
                digest,
                1,
            )
            self.assertEqual(image_result["verified"], True)
            self.assertEqual(image_result["sha256"], hashlib.sha256(image_bytes).hexdigest())
            self.assertEqual(self.state.is_wechat_ready(), True)

        self.assertEqual(lifecycle, [
            "initialize", "uninitialize",
            "initialize", "uninitialize",
            "initialize", "uninitialize",
        ])
        self.assertFalse(getattr(apartment, "ready", False))

    def test_com_scope_uninitializes_when_uia_dispatch_raises(self) -> None:
        lifecycle: list[str] = []
        self.state.fetch_messages = mock.Mock(return_value=[])
        self.state._dispatch_text = mock.Mock(side_effect=RuntimeError("fixture UIA failure"))

        with mock.patch.object(
            BRIDGE.automation,
            "InitializeUIAutomationInCurrentThread",
            side_effect=lambda: lifecycle.append("initialize"),
        ), mock.patch.object(
            BRIDGE.automation,
            "UninitializeUIAutomationInCurrentThread",
            side_effect=lambda: lifecycle.append("uninitialize"),
        ):
            with self.assertRaisesRegex(RuntimeError, "fixture UIA failure"):
                self.state.dispatch_and_verify(
                    "fixture-contact",
                    "fixture-talker",
                    "fixture-text",
                    1,
                )

        self.assertEqual(lifecycle, ["initialize", "uninitialize"])


if __name__ == "__main__":
    unittest.main()
