#!/usr/bin/env node
/**
 * Offline tests for "which window is WeChat?".
 *
 * Measured 2026-10-01 on the live desktop: WeChat showed its own "新版本" promo
 * dialog (690x564) while the chat window sat minimized (183x26). The old rule -
 * "the title-matching window with the largest area" - picked the promo, which has
 * no conversation list and no message box: the bot read an empty chat list (deaf)
 * and would have typed a reply into an advertisement. Identity is structural.
 *
 * Run: node test/wechat-cua-window.test.js
 */

const assert = require("assert");

const { findWeChatWindow } = require("../src/integrations/wechat-cua/client");

const PROMO = { pid: 1, window_id: 10, title: "微信", minimized: false, bounds: { x: 615, y: 229, width: 690, height: 564 } };
const MAIN = { pid: 1, window_id: 20, title: "微信", minimized: true, bounds: { x: -31992, y: -32000, width: 183, height: 26 } };

const row = (label) => ({ role: "ListItem", label, frame: { x: 485, y: 300, w: 300, h: 78 } });
const composer = { role: "Edit", label: "文件传输助手", value: "", frame: { x: 400, y: 700, w: 700, h: 60 } };
const promoElement = { role: "Button", label: "忽略本次更新", frame: { x: 700, y: 400, w: 120, h: 40 } };

function session({ windows, snapshots }) {
  return {
    call(tool, args) {
      if (tool === "list_windows") return { windows };
      if (tool === "get_window_state") return { elements: snapshots[args.window_id] || [] };
      throw new Error(`unexpected call ${tool}`);
    },
  };
}

test_a_promo_dialog_never_wins_over_the_chat_window();
test_without_a_structural_match_the_largest_window_is_used();
console.log("all window tests passed");

function test_a_promo_dialog_never_wins_over_the_chat_window() {
  const s = session({
    windows: [PROMO, MAIN],
    snapshots: { 10: [promoElement], 20: [row("文件传输助手\nhi\n13:00\n"), row("Azzy\nold\n13:01\n"), composer] },
  });
  const win = findWeChatWindow(s);
  assert.strictEqual(win.window_id, 20, "the chat window must win even though the promo is far larger");
  assert.strictEqual(win.matchedBy, "chat-structure");
  assert.strictEqual(win.candidates, 2, "both title-matching windows were considered");
  console.log("ok   a larger promo dialog does not shadow the chat window");
}

function test_without_a_structural_match_the_largest_window_is_used() {
  const s = session({ windows: [PROMO, MAIN], snapshots: { 10: [promoElement], 20: [promoElement] } });
  const win = findWeChatWindow(s);
  assert.strictEqual(win.window_id, 10, "with nothing looking like a chat client, size remains the fallback");
  assert.strictEqual(win.matchedBy, "largest-window", "and the caller can tell that this was a guess");
  console.log("ok   with no structural match it falls back to size, and says so");
}
