#!/usr/bin/env node
/**
 * Remove a specific outgoing text message from the currently open conversation.
 *
 *   node scripts/cua-wechat-delete-message.js "<exact text>" [--pid N] [--window-id N]
 *
 * Why this exists: a probe that pastes and presses Return without checking the
 * paste actually landed puts garbage into a real chat. Cleaning that up is a
 * legitimate operation, and it must be as careful as the send path:
 *
 *   - it refuses to run unless the exact text is found in the conversation
 *   - it re-reads after deleting and requires the text to be gone
 *   - it never touches any other message
 *
 * WeChat deletes an outgoing message through the bubble's context menu, so this
 * does need the foreground (see client.js: only foreground input is accepted by
 * this client). That is reported, not hidden.
 */

const { execFileSync } = require("node:child_process");
const { CuaSession, findWeChatWindow, toTarget, ensureConversation, currentConversation } = require("../src/integrations/wechat-cua/client");
const { readConversation } = require("../src/integrations/wechat-cua/inbound");

const DRIVER = process.env.CUA_DRIVER
  || "C:\\Users\\79388\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

function main() {
  const argv = process.argv.slice(2);
  const pidArg = argv.includes("--pid") ? Number(argv[argv.indexOf("--pid") + 1]) : 0;
  const widArg = argv.includes("--window-id") ? Number(argv[argv.indexOf("--window-id") + 1]) : 0;
  const text = argv.find((a) => !a.startsWith("--") && a !== String(pidArg) && a !== String(widArg));
  if (!text) {
    console.error('usage: cua-wechat-delete-message.js "<exact text>" [--pid N] [--window-id N]');
    process.exit(2);
  }

  const session = new CuaSession("cyberboss-delete");
  const target = pidArg && widArg
    ? { pid: pidArg, window_id: widArg }
    : findWeChatWindow(session);
  log(`open conversation: ${JSON.stringify(currentConversation(session, target).label)}`);

  const before = readConversation(session, target);
  const victim = before.filter((m) => m.text === text);
  log(`found ${victim.length} message(s) exactly equal to ${JSON.stringify(text)}`);
  if (victim.length !== 1) {
    log(victim.length ? "refusing: more than one candidate, be more specific" : "nothing to delete");
    process.exit(1);
  }

  // Right-click the bubble to open its context menu. The bubble carries a frame;
  // a click needs window-local screenshot pixels, so convert from the frame.
  const windowBounds = (() => {
    const res = session.call("list_windows", { on_screen_only: false });
    const all = res.windows || res._legacy_windows || [];
    const hit = all.find((w) => w.pid === target.pid && w.window_id === target.window_id);
    return hit?.bounds || null;
  })();
  if (!windowBounds) {
    log("could not read the window bounds; aborting rather than clicking blind");
    process.exit(1);
  }
  const snap = session.snapshot(target);
  const scaleX = snap.screenshot_width / windowBounds.width;
  const scaleY = snap.screenshot_height / windowBounds.height;
  const localX = Math.round((victim[0].yFrameX ?? 0) * 0) || 0; // placeholder replaced below

  // The element frames are in window coordinates; the screenshot may be scaled.
  const bubble = (() => {
    const all = snap.elements || [];
    return all.find((el) => el.role === "ListItem" && String(el.label || "").trim() === text) || null;
  })();
  if (!bubble) {
    log("the bubble is not in the current snapshot (it may have scrolled away)");
    process.exit(1);
  }
  const screenX = Math.round((windowBounds.x - (windowBounds.x - windowBounds.x)) + (bubble.frame.x + bubble.frame.w / 2) * 0);
  void scaleX; void scaleY; void localX; void screenX;

  const cx = Math.round((bubble.frame.x + bubble.frame.w / 2) * (snap.screenshot_width / windowBounds.width));
  const cy = Math.round((bubble.frame.y + bubble.frame.h / 2) * (snap.screenshot_height / windowBounds.height));
  log(`right-clicking bubble at window-local (${cx},${cy}) via foreground`);
  const clicked = session.call("click", { ...toTarget(target), x: cx, y: cy, dispatch: "foreground", button: "right" });
  log(`  ${JSON.stringify(clicked).slice(0, 200)}`);
  sleep(1500);

  // The context menu is a separate window; find it and pick the delete entry.
  const afterMenu = session.call("list_windows", { on_screen_only: true });
  const menuWindows = (afterMenu.windows || afterMenu._legacy_windows || [])
    .filter((w) => w.pid === target.pid && w.window_id !== target.window_id);
  log(`candidate menu window(s): ${JSON.stringify(menuWindows.map((w) => ({ id: w.window_id, title: w.title })))}`);
  if (!menuWindows.length) {
    log("no context menu appeared; nothing was deleted");
    process.exit(1);
  }
  const menu = menuWindows[menuWindows.length - 1];
  const entries = session.snapshot({ pid: menu.pid, window_id: menu.window_id });
  const items = (entries.elements || []).filter((el) => /删除|撤回|Delete/iu.test(String(el.label || "")));
  log(`menu entries matching delete: ${JSON.stringify(items.map((i) => i.label))}`);
  if (!items.length) {
    session.call("press_key", { ...toTarget(target), key: "escape" });
    log("no delete entry in the menu; pressed escape");
    process.exit(1);
  }
  const chosen = session.call("click", { pid: menu.pid, window_id: menu.window_id, element_token: items[0].element_token, delivery_mode: "foreground" });
  log(`  ${JSON.stringify(chosen).slice(0, 200)}`);
  sleep(1200);

  const after = readConversation(session, target);
  const remains = after.filter((m) => m.text === text).length;
  log(`after: ${remains} message(s) still equal to the text`);
  log(remains === 0 ? "VERDICT: message removed" : "VERDICT: still present - delete the confirmation dialog (press return) and re-run");
  process.exit(remains === 0 ? 0 : 1);
}

main();
