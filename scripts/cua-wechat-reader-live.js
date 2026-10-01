#!/usr/bin/env node
/**
 * Live reader check: does the preview-level inbound source see a row change?
 *
 *   node scripts/cua-wechat-reader-live.js ["文件传输助手"]
 *
 * The closed-loop probe suppresses our own echo, so it cannot prove the reader
 * *notices* anything. This one does the opposite: it primes, sends one message
 * to the given conversation through Cua, and then polls with echo suppression
 * DISABLED. A correctly working reader must report exactly one event, whose text
 * is the message we just sent - i.e. the row change is genuinely observed.
 *
 * Target defaults to 文件传输助手 (the self-chat).
 */

const { CuaSession, findWeChatWindow } = require("../src/integrations/wechat-cua/client");
const { PreviewInboundSource } = require("../src/integrations/wechat-cua/inbound");
const { runOnce } = require("../src/integrations/wechat-cua/loop");

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line) => console.log(`[${stamp()}] ${line}`);

function main() {
  const chat = process.argv[2] || "文件传输助手";
  const session = new CuaSession("cyberboss-reader-live");
  const target = findWeChatWindow(session);
  log(`target : ${chat} (pid=${target.pid} id=${target.window_id})`);

  const source = new PreviewInboundSource(target, { session });
  const primed = source.poll();
  log(`primed : ${source.seen.size} peer(s), events=${primed.length}`);

  const marker = `READER-PROBE-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  const report = runOnce({
    session,
    target,
    inbound: [{ direction: "incoming", peer: chat, text: "trigger", replyTarget: chat, source: "probe" }],
    decide: () => ({ reply: marker, reason: "reader-probe" }),
  });
  log(`send   : ${report.events[0].action} verify=${report.events[0].verify}`);
  if (report.sent !== 1) {
    log("VERDICT: could not send the probe message; reader not exercised");
    process.exit(1);
  }

  // Echo suppression OFF on purpose: the point is to observe the row change.
  const observed = source.poll({ isOwnEcho: () => false });
  log(`observed: ${observed.length} event(s)`);
  for (const event of observed) {
    log(`          ${JSON.stringify({ peer: event.peer, text: event.text, time: event.time, confidence: event.confidence })}`);
  }
  const stable = source.poll({ isOwnEcho: () => false });
  log(`stable  : ${stable.length} event(s) on the next poll (must be 0)`);

  const ok = observed.length === 1 && observed[0].text.includes(marker) && stable.length === 0;
  log(ok
    ? "VERDICT: reader observes row changes exactly once"
    : "VERDICT: reader did not observe the change as expected");
  process.exit(ok ? 0 : 1);
}

main();
