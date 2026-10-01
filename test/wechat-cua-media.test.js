#!/usr/bin/env node
/**
 * Offline tests for the media paste gate.
 *
 * The bug this prevents is not hypothetical: on 2026-10-01 a probe pasted an
 * image with `hotkey ["ctrl","v"]`, the modifier did not take effect, the literal
 * character `v` was typed, and Return published it into a real conversation.
 * The gate's job is to make that impossible: no Return without a confirmed paste,
 * and a failed paste must leave the box clean.
 *
 * The fake client models what the real one returns: the chat-list rows (narrow,
 * multi-line) and the OPEN conversation's bubbles (wide, ordered by y). Getting
 * that wrong once already produced a false pass in an earlier version of this
 * file, so both views are explicit here.
 *
 * Run: node test/wechat-cua-media.test.js
 */

const assert = require("assert");

const { sendMedia } = require("../src/integrations/wechat-cua/media");
const { CuaSession } = require("../src/integrations/wechat-cua/client");

const TARGET = { pid: 7, window_id: 8 };
const CHAT = "文件传输助手";

function makeClient({ pasteLands }) {
  const state = {
    bubbles: ["earlier message"], // the open conversation, already has content
    box: "",
    pasted: false,
  };
  const calls = [];
  const session = new CuaSession("test");
  session.snapshot = () => {
    const elements = [
      // chat list row (narrow = row, not a bubble)
      { role: "ListItem", label: `${CHAT}\nearlier message\n13:00\n`, element_token: "row", element_index: 1, frame: { y: 100, w: 300, h: 78 } },
      // the open conversation's bubbles (wide)
      ...state.bubbles.map((text, i) => ({ role: "ListItem", label: text, element_token: `b${i}`, frame: { y: 200 + i * 60, w: 722, h: 68 } })),
      // the message box, labelled with the peer
      { role: "Edit", label: CHAT, value: state.box, element_token: "box" },
    ];
    return { elements, screenshot_width: 1102, screenshot_height: 800, window_title: "微信" };
  };
  session.call = (tool, args) => {
    calls.push({ tool, args });
    if (tool === "clipboard_write") return { ok: true, types: ["image/png"] };
    if (tool === "hotkey") {
      state.pasted = true;
      if (pasteLands) {
        state.bubbles = [...state.bubbles, "[图片]"];
        return { route: "global_input", delivery: { mode: "foreground" }, summary: "Pressed ctrl+v via SendInput" };
      }
      // The measured failure: the modifier is lost and a literal character lands.
      state.box = "v";
      return { route: "synthetic_events", delivery: { mode: "background" }, summary: "Pressed ctrl+v via PostMessage" };
    }
    if (tool === "press_key") return { route: "synthetic_events", summary: "Sent return" };
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
  refuses_to_send_when_the_paste_was_not_confirmed();
  sends_when_the_paste_produced_a_media_bubble();
  does_not_press_return_in_dry_mode();
  console.log("all media tests passed");
}

/** The exact regression: modifier lost, a literal character typed. */
function refuses_to_send_when_the_paste_was_not_confirmed() {
  const session = makeClient({ pasteLands: false });
  const result = sendMedia(TARGET, CHAT, { imagePath: "C:/tmp/x.png", session });
  assert.strictEqual(result.ok, false, "an unconfirmed paste must not report success");
  assert.strictEqual(result.sent, false, "an unconfirmed paste must not send");
  assert.match(result.verify, /paste not confirmed/);
  assert.strictEqual(
    session.__calls.some((c) => c.tool === "press_key"),
    false,
    "return must never be pressed on an unconfirmed paste - that is the bug that put a stray 'v' in a real chat"
  );
  assert.strictEqual(
    session.__calls.some((c) => c.tool === "set_value"),
    true,
    "what the keys actually produced must be cleared, not left in the box"
  );
  assert.strictEqual(session.__state.box, "", "the box must be left clean after a failed paste");
  console.log("ok   an unconfirmed paste is cleared and never sent");
}

function sends_when_the_paste_produced_a_media_bubble() {
  const session = makeClient({ pasteLands: true });
  const result = sendMedia(TARGET, CHAT, { imagePath: "C:/tmp/x.png", session });
  assert.strictEqual(result.sent, true, `expected a send, verify=${result.verify}`);
  assert.strictEqual(result.ok, true, `expected ok, verify=${result.verify}`);
  assert.ok(result.focusCosts.includes("paste:foreground"), "a foreground paste must be reported as a focus cost");
  assert.strictEqual(session.__calls.some((c) => c.tool === "press_key"), true);
  console.log("ok   a confirmed paste is sent, and the focus cost is reported");
}

function does_not_press_return_in_dry_mode() {
  const session = makeClient({ pasteLands: true });
  const result = sendMedia(TARGET, CHAT, { imagePath: "C:/tmp/x.png", session, send: false });
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.ok, true, "a confirmed paste in dry mode is still a success");
  assert.match(result.verify, /not sent/);
  assert.strictEqual(session.__calls.some((c) => c.tool === "press_key"), false);
  console.log("ok   --no-send pastes and stops without pressing return");
}

main();
