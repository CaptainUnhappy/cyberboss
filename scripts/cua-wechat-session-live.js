#!/usr/bin/env node
/**
 * Live proof that a dead driver session heals itself.
 *
 * This is the real thing, not a stub: it talks to the running Cua Driver daemon,
 * kills the session on purpose with `end_session`, and checks that the *next*
 * call through `CuaSession` still returns an answer.
 *
 * Read-only: it lists windows and nothing else. Nothing is clicked, typed, or
 * focused, so it is safe to run against a live desktop.
 *
 * Run: node scripts/cua-wechat-session-live.js
 */

const { CuaSession, outcome } = require("../src/integrations/wechat-cua/client");

const LABEL = `cyberboss-session-live-${Date.now()}`;
const session = new CuaSession(LABEL);

console.log(`label: ${LABEL}`);

const first = session.call("list_windows", { on_screen_only: false });
const firstCount = (first.windows || []).length;
console.log(`1. list_windows on a live session: ${firstCount} window(s)`);
if (!firstCount) {
  console.error(`FAIL: no windows visible; outcome=${JSON.stringify(outcome(first))}`);
  process.exit(1);
}

// Kill it on purpose, through the raw seam so the recovery path is not involved.
const ended = session.raw("end_session", { session: LABEL });
console.log(`2. end_session -> ${JSON.stringify(ended)}`);
if (ended?.active !== false) {
  console.error("FAIL: the driver did not confirm the session ended");
  process.exit(1);
}

// The next call must be refused *and* healed. Ask through `raw` first so the
// refusal itself is observable evidence rather than an invisible retry.
const refused = session.raw("list_windows", { on_screen_only: false });
const refusedReport = outcome(refused);
console.log(`3. after end_session, raw call -> failed=${refusedReport.failed} reason=${refusedReport.reason} exit=${refusedReport.exit}`);
console.log(`   driver said: ${String(refusedReport.detail).slice(0, 120)}`);
if (!refusedReport.failed) {
  console.error("FAIL: a call on an ended session was not refused; this test proves nothing");
  process.exit(1);
}

const healed = session.call("list_windows", { on_screen_only: false });
const healedCount = (healed.windows || []).length;
console.log(`4. through CuaSession.call -> ${healedCount} window(s), revivals=${session.revivals}, revived=${session.revived}`);
if (healedCount !== firstCount || session.revivals !== 1) {
  console.error(`FAIL: expected the same ${firstCount} window(s) after one revival, got ${healedCount} with ${session.revivals} revival(s)`);
  process.exit(1);
}

// And the healed session is fully usable, not merely answerable.
const wechat = (healed.windows || []).find((w) => /微信|Weixin|WeChat/i.test(w.title || ""));
console.log(`5. WeChat visible after recovery: ${wechat ? `pid ${wechat.pid}, window ${wechat.window_id}` : "no"}`);
console.log("PASS: an ended driver session is detected, revived once, and the refused call is repeated");
