#!/usr/bin/env node
/**
 * What actually invalidates an `element_token`?
 *
 * The bot polls the chat list every few seconds, and a send takes seconds, so the
 * question "does one snapshot invalidate another snapshot's tokens?" decides
 * whether the two halves of the closed loop can run at the same time at all.
 *
 * Measured here, in order, with a harmless action (`set_value` on the message box
 * with an empty string - it types nothing and return is what sends):
 *
 *   1. fresh token, used immediately                     -> must work
 *   2. fresh token, used after idle time, no other call  -> time-based expiry?
 *   3. fresh token, then a snapshot in ANOTHER session,
 *      then use the first token                          -> cross-session clash?
 *   4. fresh token, then another snapshot in the SAME
 *      session, then use the first token                 -> same-session clash?
 *
 * The action is deliberately non-destructive: the composer is set to "" (it is
 * left empty, which is also how this script cleans up after a failed inject).
 *
 * Run: node scripts/cua-wechat-token-live.js
 */

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, outcome,
} = require("../src/integrations/wechat-cua/client");

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const a = new CuaSession(`token-probe-a-${Date.now()}`);
const b = new CuaSession(`token-probe-b-${Date.now()}`);
const win = findWeChatWindow(a);
console.log(`window: pid ${win.pid}, window_id ${win.window_id} (${win.title})`);

/** Fresh snapshot in `session`, then use the composer token from it. */
function tokenOf(session) {
  const conv = currentConversation(session, win);
  if (!conv.box) throw new Error("no message box in this snapshot");
  return conv.box.element_token;
}

const use = (session, token, label) => {
  const res = session.call("set_value", { ...toTarget(win), element_token: token, value: "" });
  const report = outcome(res);
  const verdict = report.failed ? `REFUSED (${report.reason})` : `accepted (${report.route || report.effect || "ok"})`;
  console.log(`  ${label}: ${verdict}`);
  return !report.failed;
};

const results = {};

console.log("1. fresh token used immediately");
results.immediate = use(a, tokenOf(a), "immediate");

console.log("2. fresh token used after 8s of idle (no driver calls at all)");
const t2 = tokenOf(a);
sleep(8000);
results.afterIdle = use(a, t2, "after-idle");

console.log("3. fresh token in A, then a snapshot in session B, then the A token");
const t3 = tokenOf(a);
b.snapshot(toTarget(win));
results.crossSession = use(a, t3, "after-other-session-snapshot");

console.log("4. fresh token in A, then a second snapshot in A, then the first token");
const t4 = tokenOf(a);
a.snapshot(toTarget(win));
results.sameSession = use(a, t4, "after-own-second-snapshot");

console.log("");
console.log("=== verdict ===");
console.log(`  a token survives time        : ${results.afterIdle ? "YES" : "NO"}`);
console.log(`  a token survives another session's snapshot: ${results.crossSession ? "YES" : "NO"}`);
console.log(`  a token survives its own session's next snapshot: ${results.sameSession ? "YES" : "NO"}`);
const shared = !results.crossSession || !results.sameSession;
console.log(shared
  ? "  => snapshots share ONE current snapshot per window: a concurrent reader invalidates a writer's tokens."
  : "  => snapshots are independent: concurrency is not the problem.");
