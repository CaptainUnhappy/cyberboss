#!/usr/bin/env node
/**
 * Round-trip proof: verify a send from the CONVERSATION, not the preview.
 *
 *   node scripts/cua-wechat-roundtrip.js ["文件传输助手"] [--foreground-type]
 *
 * Until now a send was verified from the chat-list preview row, which only shows
 * the last message and cannot tell a delivered message from a stale row. This
 * probe closes the loop the strict way:
 *
 *   1. open the conversation and read its message list (ordered, background)
 *   2. send a marked message
 *   3. re-read the conversation and require the marker to be the LAST message
 *   4. require the message box to be empty again (a send that did not commit
 *      leaves the text sitting there)
 *
 * Step 1 also warms the deep-read watermark, so step 3 doubles as a check that
 * the reader sees the new outgoing message exactly once.
 *
 * Target defaults to 文件传输助手 (the self-chat).
 */

const { CuaSession, findWeChatWindow, currentConversation, ensureConversation, sendMessage } = require("../src/integrations/wechat-cua/client");
const { readConversation } = require("../src/integrations/wechat-cua/inbound");

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line) => console.log(`[${stamp()}] ${line}`);

function main() {
  const argv = process.argv.slice(2);
  const chat = argv.find((a) => !a.startsWith("--")) || "文件传输助手";
  const session = new CuaSession("cyberboss-roundtrip");
  const target = findWeChatWindow(session);
  log(`target : ${JSON.stringify(chat)} (pid=${target.pid} id=${target.window_id})`);

  // 1) open + read the conversation as it stands
  const opened = ensureConversation(session, target, chat);
  log(`open   : route=${opened.route} cost=${opened.cost}`);
  const before = readConversation(session, target);
  log(`before : ${before.length} message(s) in the conversation; last = ${JSON.stringify(before.at(-1)?.text?.slice(0, 40) || "(none)")}`);

  // 2) send something unmistakable
  const marker = `ROUNDTRIP-${stamp().replace(/:/g, "")}`;
  const result = sendMessage(target, chat, marker, { session });
  log(`send   : ok=${result.ok} verify=${result.verify}`);
  for (const step of result.steps) {
    log(`         ${JSON.stringify({ step: step.step, ...(step.outcome || {}), ...(step.landed !== undefined ? { landed: step.landed } : {}), ...(step.cost ? { cost: step.cost } : {}) })}`);
  }

  // 3) re-read the conversation; the marker must be the newest message
  const after = readConversation(session, target);
  const last = after.at(-1)?.text || "";
  const appeared = after.filter((m) => m.text.includes(marker)).length;
  log(`after  : ${after.length} message(s); marker occurrences = ${appeared}; last = ${JSON.stringify(last.slice(0, 40))}`);

  // 4) the message box must be empty again
  const box = currentConversation(session, target).box;
  const boxEmpty = !String(box?.value ?? "").trim();
  log(`box    : ${boxEmpty ? "empty (the send committed)" : `still holds ${JSON.stringify(box?.value)}`}`);

  const ok = appeared === 1 && last.includes(marker) && boxEmpty && /^文件传输助手$/u.test(chat) === (currentConversation(session, target).label === chat);
  log(ok
    ? "VERDICT: round trip verified from the conversation itself"
    : "VERDICT: round trip NOT verified");
  process.exit(ok ? 0 : 1);
}

main();
