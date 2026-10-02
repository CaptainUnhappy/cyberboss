#!/usr/bin/env node
/**
 * Can a conversation be switched WITHOUT taking the foreground?
 *
 * The measured ladder today (client.js) ends in a foreground click, because the
 * accessibility rung on a chat row is accepted and then ignored by this client.
 * That click is the only remaining focus theft in the whole path, so it is worth
 * measuring the two candidates that could replace it:
 *
 *   A. the SEARCH BOX: write the peer's name into it in the background (UIA
 *      ValuePattern - no focus change), let the client filter, then post Return
 *      TO THE SEARCH BOX ELEMENT and see whether the conversation opens;
 *   B. a posted pixel click (measured separately - it needs the driver's px rung).
 *
 * Safety rules baked in here, because a stray Return in this client *sends*:
 *   - keys are posted to the SEARCH BOX element token, never to the composer;
 *   - the composer is asserted empty before anything is posted;
 *   - the search box is cleared afterwards through the accessibility route.
 *
 * Reliability: the running bot polls the same window every 3s, and ANY later
 * snapshot invalidates earlier element tokens (measured 2026-10-01). So every
 * action takes a fresh snapshot immediately before it and retries once on
 * `stale_element_token` - otherwise the measurement refuses to run and proves
 * nothing.
 *
 * Run: node scripts/cua-wechat-bg-switch-live.js "<peer display name>"
 */

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, ensureConversation,
  elements, labelOf, outcome, isStaleToken,
} = require("../src/integrations/wechat-cua/client");

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const peer = process.argv[2] || "Azzy";
const session = new CuaSession(`bg-switch-${Date.now()}`);
const win = findWeChatWindow(session);
const target = toTarget(win);
console.log(`window: pid ${win.pid}, window_id ${win.window_id}; trying to open ${JSON.stringify(peer)} without the foreground`);

/** Fresh find + action, retried once if the token was invalidated under us. */
function act(find, run, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const el = find();
    if (!el) return { missing: true, attempt };
    const res = run(el);
    if (!isStaleToken(res)) return { res, attempt, token: el.element_token };
  }
  return { exhausted: true };
}

const composer = () => elements(session.snapshot(target)).find((el) => el.role === "Edit" && !/搜索/.test(labelOf(el)));
const searchBox = () => elements(session.snapshot(target)).find((el) => el.role === "Edit" && /搜索/.test(labelOf(el)));
const rowNames = () => elements(session.snapshot(target))
  .filter((el) => el.role === "ListItem" && (el.frame?.w || 0) < 400)
  .map((el) => String(el.label || "").split("\n")[0]);

// Start from a different conversation, so "did it switch" means something. This
// setup step uses the foreground rung we already have; it is not what we measure.
console.log("setup:", JSON.stringify(ensureConversation(session, target, "文件传输助手")));
const before = currentConversation(session, win);
console.log("open before:", JSON.stringify(before.label), "| composer:", JSON.stringify(String(before.box?.value ?? "")));
if (String(before.box?.value ?? "")) {
  console.log("ABORT: the composer is not empty; refusing to post any key");
  process.exit(2);
}

// --- A1: background write into the search box ---------------------------------
const wrote = act(searchBox, (el) => session.call("set_value", { ...target, element_token: el.element_token, value: peer }));
console.log("A1 search set_value:", JSON.stringify(wrote.res ? outcome(wrote.res) : wrote));
sleep(1200);
const readBack = searchBox();
console.log("A1 search value:", JSON.stringify(String(readBack?.value ?? "")), "| rows:", rowNames().slice(0, 4).join(" / "));

// --- A2: post Return to the SEARCH BOX element ---------------------------------
const posted = act(searchBox, (el) => session.call("press_key", { ...target, element_token: el.element_token, key: "return" }));
console.log("A2 search return:", JSON.stringify(posted.res ? outcome(posted.res) : posted));
sleep(1800);
const after = currentConversation(session, win);
console.log("A2 open after:", JSON.stringify(after.label));
console.log(after.label.startsWith(peer)
  ? "RESULT: background switch WORKS through the search box"
  : "RESULT: the search-box path did not switch the conversation");

// --- cleanup: clear the search box (accessibility route, no focus change) ------
const leftover = searchBox();
if (leftover && String(leftover.value || "")) {
  session.call("set_value", { ...target, element_token: leftover.element_token, value: "" });
  console.log("cleanup: search box cleared");
}
