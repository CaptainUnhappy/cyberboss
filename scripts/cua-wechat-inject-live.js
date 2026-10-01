#!/usr/bin/env node
/**
 * Put a message into a WeChat conversation the way a *phone* would look from this
 * machine's point of view: the text appears in the conversation and in its chat
 * row, and nothing in this process tells the bot it was us.
 *
 * This is the acceptance injector for the inbound half of the closed loop. It
 * deliberately does NOT use the bot's outbound module: `sendWeChatCuaText` records
 * what it sent in the echo ledger, and a message the bot knows it sent is exactly
 * the message the bot is supposed to ignore. The point is to produce a row change
 * the bot has no record of - the same situation the reader faces when the message
 * really did arrive over the network.
 *
 * Usage:
 *   node scripts/cua-wechat-inject-live.js "<chat label>" "<text>" [--clear]
 *
 * `--clear` empties the message box first (a leftover from a failed probe would
 * otherwise be glued to the front of the injected text).
 *
 * Run: node scripts/cua-wechat-inject-live.js 文件传输助手 "CUA-E2E-150000"
 */

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, sendMessage,
} = require("../src/integrations/wechat-cua/client");

const chatLabel = process.argv[2] || "文件传输助手";
const text = process.argv[3] || "";
const clearFirst = process.argv.includes("--clear");

if (!text) {
  console.error('usage: node scripts/cua-wechat-inject-live.js "<chat label>" "<text>" [--clear]');
  process.exit(2);
}

const session = new CuaSession(`cyberboss-inject-${Date.now()}`);
const win = findWeChatWindow(session);
console.log(`window: pid ${win.pid}, window_id ${win.window_id} (${win.title})`);

/**
 * Empty the composer through the accessibility route: no focus change, and it is
 * the same mechanism `type_text` uses. Needed between attempts, because a refused
 * `press_key` can strand the previous attempt's text in the box.
 */
function clearBox() {
  const conv = currentConversation(session, win);
  if (!conv.box || !String(conv.box.value || "")) {
    return "";
  }
  const was = String(conv.box.value);
  session.call("set_value", { ...toTarget(win), element_token: conv.box.element_token, value: "" });
  return was;
}

// The bot is polling this same window every few seconds, and ANY read invalidates
// the tokens of the previous read (measured: `cua-wechat-token-live.js`). So an
// injection is a race against the bot's own reader, and the honest way to win it is
// to retry the whole attempt until the row really carries the text - each attempt
// takes its own fresh snapshots.
const MAX_ATTEMPTS = 10;
let result = null;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  const cleared = clearFirst ? clearBox() : "";
  result = sendMessage(win, chatLabel, text, { session, requireForegroundType: true });
  console.log(`attempt ${attempt}${cleared ? ` (cleared ${JSON.stringify(cleared.slice(0, 30))})` : ""}: ok=${result.ok} ${result.verify}`);
  if (result.ok) {
    break;
  }
  if (attempt < MAX_ATTEMPTS) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  }
}

for (const step of result.steps) {
  const cost = step.cost ? ` cost=${step.cost}` : "";
  const landed = step.landed === undefined ? "" : ` landed=${step.landed}`;
  const retry = step.firstAttempt ? ` retriedFrom=${step.firstAttempt.reason}` : "";
  const skip = step.skippedRepress ? " skippedRepress" : "";
  console.log(`  ${step.step}: ${JSON.stringify(step.outcome)}${cost}${landed}${retry}${skip}`);
}
if (!result.ok) {
  console.error("FAIL: the injected text never showed up in the chat row, so the bot will not see it either");
  process.exit(1);
}
console.log(`PASS: ${JSON.stringify(text)} is now visible in ${JSON.stringify(chatLabel)} as an unexplained row change`);
