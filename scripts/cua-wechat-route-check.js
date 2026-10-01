#!/usr/bin/env node
/**
 * Answer one question with evidence: which conversation did a send actually land in?
 *
 *   node scripts/cua-wechat-route-check.js "<chat label>"
 *
 * The dangerous failure for this whole design is a send that silently goes to the
 * wrong conversation - a message meant for one person arriving with someone else.
 * The preview row is the only post-hoc proof a UIA client has, so this probe:
 *
 *   1. reads every conversation row (peer -> preview) as the "before" picture
 *   2. sends one marked message to the requested chat through the module
 *   3. re-reads every row and reports which peer's preview carries the marker
 *
 * A pass is "the marker appears under the requested peer and nowhere else".
 */

const { CuaSession, findWeChatWindow, ensureConversation, currentConversation, sendMessage } = require("../src/integrations/wechat-cua/client");
const { readRows } = require("../src/integrations/wechat-cua/inbound");

const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

function previews(session, target) {
  const map = new Map();
  for (const row of readRows(session, target)) {
    map.set(row.peer, row.preview);
  }
  return map;
}

function main() {
  const chat = process.argv[2] || "文件传输助手";
  const session = new CuaSession("cyberboss-route");
  const target = findWeChatWindow(session);

  const before = previews(session, target);
  log(`before : ${before.size} row(s); open conversation = ${JSON.stringify(currentConversation(session, target).label)}`);
  log(`target : ${JSON.stringify(chat)}`);

  const marker = `ROUTE-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  const result = sendMessage(target, chat, marker, { session });
  log(`send   : ok=${result.ok} verify=${result.verify}`);
  for (const step of result.steps) {
    log(`         ${JSON.stringify({ step: step.step, ...(step.outcome || {}), ...(step.landed !== undefined ? { landed: step.landed } : {}), ...(step.cost ? { cost: step.cost } : {}) })}`);
  }

  const after = previews(session, target);
  const carriers = [...after.entries()].filter(([, preview]) => String(preview).includes(marker)).map(([peer]) => peer);
  log(`after  : open conversation = ${JSON.stringify(currentConversation(session, target).label)}`);
  log(`marker found under: ${JSON.stringify(carriers)}`);

  const changed = [...after.entries()].filter(([peer, preview]) => before.get(peer) !== preview).map(([peer]) => peer);
  log(`rows changed      : ${JSON.stringify(changed)}`);

  const ok = carriers.length === 1 && carriers[0] === chat;
  log(ok ? `VERDICT: the send landed in ${JSON.stringify(chat)} and nowhere else`
    : `VERDICT: ROUTING PROBLEM - wanted ${JSON.stringify(chat)}, marker found under ${JSON.stringify(carriers)}`);
  process.exit(ok ? 0 : 1);
}

main();
