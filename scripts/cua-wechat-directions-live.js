#!/usr/bin/env node
/**
 * Read real conversations and say who sent each message.
 *
 * The point is to check the direction classifier against the actual client rather
 * than against a fixture: open a chat where both sides have spoken and print the
 * screenshot-derived direction next to the text.
 *
 * Expects the client's own messages to come back "outgoing" and the peer's
 * "incoming". One foreground click per chat (opening it is the only way to read it).
 *
 * Run: node scripts/cua-wechat-directions-live.js "柳毓琳" ["Azzy"]
 */

const {
  CuaSession, toTarget, findWeChatWindow, ensureConversation, currentConversation,
} = require("../src/integrations/wechat-cua/client");
const { readConversation } = require("../src/integrations/wechat-cua/inbound");

const chats = process.argv.slice(2).filter((arg) => arg && !arg.startsWith("--"));
if (!chats.length) {
  console.error('usage: node scripts/cua-wechat-directions-live.js "<chat label>" ["<another>"]');
  process.exit(2);
}

const session = new CuaSession(`directions-${Date.now()}`);
const win = findWeChatWindow(session);
const target = toTarget(win);
console.log(`window: pid ${win.pid}, window_id ${win.window_id}`);

let disagreements = 0;
for (const chat of chats) {
  console.log("");
  console.log(`=== ${JSON.stringify(chat)} ===`);
  try {
    const opened = ensureConversation(session, target, chat);
    console.log(`opened: route=${opened.route} cost=${opened.cost} label=${JSON.stringify(opened.label)}`);
  } catch (error) {
    console.log(`could not open: ${error.message}`);
    continue;
  }
  const messages = readConversation(session, target);
  console.log(`messages: ${messages.length} (open conversation: ${JSON.stringify(currentConversation(session, win).label)})`);
  for (const message of messages) {
    const tag = message.direction === "outgoing" ? "OUT (us)" : message.direction === "incoming" ? "IN  (peer)" : "??  (unknown)";
    const share = message.greenShare === null ? "n/a" : message.greenShare;
    console.log(`  ${tag} green=${String(share).padEnd(5)} ${JSON.stringify(message.text.slice(0, 46))}`);
    if (message.direction === "unknown") disagreements += 1;
  }
}

console.log("");
if (disagreements) {
  console.log(`VERDICT: ${disagreements} message(s) could not be classified - the screenshot or the frame was missing`);
  process.exit(1);
}
console.log("VERDICT: every message carried a readable direction from the screenshot");
