#!/usr/bin/env node
/**
 * Offline tests for the media paste gate.
 *
 * Two problems this file exists to prevent, both observed for real:
 *
 *  1. On 2026-10-01 a probe pasted with `hotkey ["ctrl","v"]` in the background,
 *     the modifier was lost, a literal `v` was typed, and Return published it
 *     into a real conversation. The background route is therefore never used for
 *     a paste, and an unconfirmed paste never gets a Return.
 *  2. A file send was reported as a failure because verification counted
 *     messages: the conversation list scrolls, so its length went DOWN when the
 *     new file bubble arrived. Verification is by content now.
 *
 * Run: node test/wechat-cua-media.test.js
 */

const assert = require("assert");

const { sendMedia } = require("../src/integrations/wechat-cua/media");
const { CuaSession } = require("../src/integrations/wechat-cua/client");

const TARGET = { pid: 7, window_id: 8 };
const CHAT = "文件传输助手";
const FILE = "C:/tmp/cua-probe.txt";

/**
 * A scripted client that models what the real one returns: chat-list rows
 * (narrow) and the open conversation's bubbles (wide, ordered by y), plus the
 * composer's UIA value.
 */
function makeClient({ case: scenario }) {
  const state = {
    bubbles: ["an older message", "another older message"],
    box: "",
    clipboardSupported: scenario !== "clipboard-refused",
  };
  const calls = [];
  const session = new CuaSession("test");
  session.snapshot = () => {
    const elements = [
      { role: "ListItem", label: `${CHAT}\nan older message\n13:00\n`, element_token: "row", element_index: 1, frame: { y: 90, w: 300, h: 78 } },
      ...state.bubbles.map((text, i) => ({ role: "ListItem", label: text, element_token: `b${i}`, frame: { y: 200 + i * 60, w: 722, h: 68 } })),
      { role: "Edit", label: CHAT, value: state.box, element_token: "box" },
    ];
    return { elements, screenshot_width: 1102, screenshot_height: 800, window_title: "微信" };
  };
  session.call = (tool, args) => {
    calls.push({ tool, args });
    if (tool === "clipboard_write") {
      if (!state.clipboardSupported) {
        return { __failed: true, payload: { error_code: "clipboard_unavailable", supported: false, status: "unavailable" } };
      }
      return { supported: true, written_type: "file_url", types: ["CF_HDROP"] };
    }
    if (tool === "hotkey") {
      if (scenario === "paste-lost-modifier") {
        // The measured failure: the modifier is lost and a literal letter lands.
        state.box = "v";
        return { route: "synthetic_events", delivery: { mode: "background" }, summary: "Pressed ctrl+v via PostMessage" };
      }
      if (scenario === "paste-silent") {
        // The driver claims success and the composer stays empty.
        return { route: "global_input", delivery: { mode: "foreground" }, summary: "Pressed ctrl+v via SendInput" };
      }
      state.box = "\uFFFC"; // a pasted attachment shows up as an object
      return { route: "global_input", delivery: { mode: "foreground" }, summary: "Pressed ctrl+v via SendInput" };
    }
    if (tool === "press_key") {
      // Sending the object turns it into a file bubble; the list also scrolls,
      // which is exactly what made counting-based verification lie.
      state.box = "";
      state.bubbles = [...state.bubbles.slice(1), "文件\ncua-probe.txt\n29B"];
      return { route: "synthetic_events", summary: "Sent return" };
    }
    if (tool === "set_value") {
      state.box = "";
      return { route: "accessibility", summary: "Set AXValue" };
    }
    if (tool === "click") return { route: "accessibility", summary: "invoked" };
    if (tool === "list_windows") return { windows: [] };
    return { ok: true };
  };
  session.__calls = calls;
  session.__state = state;
  return session;
}

function main() {
  the_background_paste_is_never_used();
  a_lost_modifier_never_becomes_a_send();
  a_silent_paste_never_becomes_a_send();
  a_refused_clipboard_is_reported_not_retried();
  a_file_send_is_verified_by_content_even_when_the_list_shrinks();
  console.log("all media tests passed");
}

function the_background_paste_is_never_used() {
  const session = makeClient({ case: "ok" });
  sendMedia(TARGET, CHAT, { filePath: FILE, session });
  const paste = session.__calls.find((c) => c.tool === "hotkey");
  assert.ok(paste, "a paste must be attempted");
  assert.strictEqual(paste.args.delivery_mode, "foreground", "a background Ctrl+V types the letter v on this client");
  assert.deepStrictEqual(paste.args.keys, ["ctrl", "v"]);
  console.log("ok   the paste is always foreground");
}

function a_lost_modifier_never_becomes_a_send() {
  const session = makeClient({ case: "paste-lost-modifier" });
  const result = sendMedia(TARGET, CHAT, { filePath: FILE, session });
  assert.strictEqual(result.sent, false, "a literal v in the composer is not a pasted file");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(session.__calls.some((c) => c.tool === "press_key"), false, "return must never be pressed");
  assert.strictEqual(session.__calls.some((c) => c.tool === "set_value"), true, "the junk must be cleared");
  assert.strictEqual(session.__state.box, "");
  console.log("ok   a lost modifier is cleared and never sent");
}

function a_silent_paste_never_becomes_a_send() {
  const session = makeClient({ case: "paste-silent" });
  const result = sendMedia(TARGET, CHAT, { filePath: FILE, session });
  assert.strictEqual(result.sent, false, "an empty composer means nothing was pasted");
  assert.match(result.verify, /paste not confirmed/);
  assert.strictEqual(session.__calls.some((c) => c.tool === "press_key"), false);
  console.log("ok   a silent paste is detected and never sent");
}

function a_refused_clipboard_is_reported_not_retried() {
  const session = makeClient({ case: "clipboard-refused" });
  const result = sendMedia(TARGET, CHAT, { imagePath: "C:/tmp/x.png", session });
  assert.strictEqual(result.ok, false);
  assert.match(result.verify, /clipboard_unavailable|images are not supported/);
  assert.strictEqual(session.__calls.some((c) => c.tool === "hotkey"), false, "no paste without a payload");
  console.log("ok   a refused image clipboard is reported, and no paste is attempted");
}

function a_file_send_is_verified_by_content_even_when_the_list_shrinks() {
  const session = makeClient({ case: "ok" });
  const before = session.__state.bubbles.length;
  const result = sendMedia(TARGET, CHAT, { filePath: FILE, session });
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.ok, true, `content verification must not depend on list length: ${result.verify}`);
  assert.match(result.verify, /cua-probe\.txt/);
  assert.strictEqual(session.__state.bubbles.length, before, "the fixture deliberately keeps the length equal to prove counting is not used");
  assert.ok(result.focusCosts.includes("paste:foreground"));
  console.log("ok   a file send is verified by content, not by counting messages");
}

main();
