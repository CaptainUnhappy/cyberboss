#!/usr/bin/env node
/**
 * Why do element tokens go stale when nothing else is reading the window?
 *
 * `sendMessage` escalates a refused background write to a foreground one, and the
 * live injector kept seeing the *retry* refused too. This probe isolates the two
 * variables that could explain it, with the bot frozen so its polling cannot be the
 * cause:
 *
 *   A. snapshot -> background write, immediately
 *   B. snapshot -> foreground write, immediately
 *   C. snapshot -> background write, after a 2s pause
 *
 * The write is `type_text` with an empty string into the message box: it exercises
 * the token check without putting anything into the conversation.
 *
 * Run: node scripts/cua-wechat-token-modes-live.js
 */

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, outcome,
} = require("../src/integrations/wechat-cua/client");

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const session = new CuaSession(`mode-probe-${Date.now()}`);
const win = findWeChatWindow(session);
const target = toTarget(win);
console.log(`window: pid ${win.pid}, window_id ${win.window_id}`);

function attempt(label, { mode = "background", pauseMs = 0 } = {}) {
  const started = Date.now();
  const conv = currentConversation(session, win);
  if (!conv.box) {
    console.log(`${label}: no message box in this snapshot`);
    return;
  }
  const token = conv.box.element_token;
  if (pauseMs) sleep(pauseMs);
  const res = session.call("type_text", { ...target, element_token: token, text: "", delivery_mode: mode });
  const report = outcome(res);
  const ms = Date.now() - started;
  const verdict = report.failed ? `REFUSED ${report.reason}` : `accepted (${report.route || report.mode || "ok"})`;
  console.log(`${label}: ${verdict} [${ms} ms${pauseMs ? ` incl. ${pauseMs} ms pause` : ""}]`);
  return !report.failed;
}

const tally = { background: [0, 0], foreground: [0, 0], paused: [0, 0] };
const record = (bucket, ok) => { tally[bucket][ok ? 0 : 1] += 1; };

for (let i = 1; i <= 6; i += 1) {
  record("background", attempt(`A${i} background/immediate`));
}
for (let i = 1; i <= 6; i += 1) {
  record("foreground", attempt(`B${i} foreground/immediate`, { mode: "foreground" }));
}
for (let i = 1; i <= 4; i += 1) {
  record("paused", attempt(`C${i} background/+2s`, { pauseMs: 2000 }));
}

console.log("");
for (const [name, [ok, bad]] of Object.entries(tally)) {
  console.log(`  ${name.padEnd(11)} accepted=${ok} refused=${bad}`);
}
