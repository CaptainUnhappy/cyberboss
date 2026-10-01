#!/usr/bin/env node
/**
 * Live closed-loop probe.
 *
 *   node scripts/cua-wechat-loop-live.js [--chat "文件传输助手"] [--dry]
 *
 * What it proves, in order, against the real WeChat client:
 *
 *   1. READ    — the conversation rows are read through Cua (background, no focus).
 *   2. BASELINE— the source primes itself; the existing list is not replayed.
 *   3. SEND    — the loop answers one event and the reply is verified from the
 *                conversation's preview row, with the message box empty again.
 *   4. INBOUND — a row change is then observed by the source and turned into an
 *                inbound event, which is what a real incoming message would do.
 *
 * Step 3 uses an injected event (nobody has to message the machine while this
 * runs); step 4 exercises the real reader on the row our own send produced, so
 * the reader path is live even though the trigger is controlled.
 *
 * The target defaults to 文件传输助手 (the self-chat): this probe never messages
 * a real person.
 */

const { CuaSession, findWeChatWindow, currentConversation } = require("../src/integrations/wechat-cua/client");
const { PreviewInboundSource, readRows } = require("../src/integrations/wechat-cua/inbound");
const { runOnce } = require("../src/integrations/wechat-cua/loop");

function stamp() {
  return new Date().toISOString().slice(11, 19);
}
function log(line) {
  console.log(`[${stamp()}] ${line}`);
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const chat = argv.includes("--chat") ? argv[argv.indexOf("--chat") + 1] : "文件传输助手";

  const session = new CuaSession("cyberboss-live-loop");
  const target = findWeChatWindow(session);
  log(`window : pid=${target.pid} id=${target.window_id} minimized=${target.minimized}`);

  // --- 1) read ---------------------------------------------------------------
  const rows = readRows(session, target);
  log(`read   : ${rows.length} conversation row(s) via Cua`);
  const sample = rows.find((r) => r.peer === chat) || rows[0];
  if (sample) log(`         e.g. ${JSON.stringify({ peer: sample.peer, preview: sample.preview.slice(0, 40), time: sample.time })}`);

  // --- 2) baseline -----------------------------------------------------------
  const source = new PreviewInboundSource(target, { session });
  const primed = source.poll();
  log(`baseline: primed with ${source.seen.size} peer(s); events emitted = ${primed.length} (must be 0)`);

  // --- 3) answer one injected event -----------------------------------------
  const marker = `CUA-LOOP-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  const synthetic = {
    direction: "incoming",
    peer: chat,
    text: `${marker}-IN`,
    time: "now",
    unread: 1,
    replyTarget: chat,
    confidence: "injected",
    source: "probe",
  };
  log(`decide : injected inbound from ${JSON.stringify(chat)} -> reply ${JSON.stringify(`${marker}-OUT`)}`);
  const report = runOnce({
    session,
    target,
    inbound: [synthetic],
    decide: () => ({ reply: `${marker}-OUT`, reason: "probe" }),
    dryRun: dry,
  });
  const first = report.events[0];
  log(`send   : action=${first.action} verify=${first.verify || "(dry run)"}`);
  for (const step of first.steps || []) {
    log(`         ${JSON.stringify(step)}`);
  }
  log(`result : sent=${report.sent} failed=${report.failed}`);

  // --- 4) the reader sees the row change ------------------------------------
  const after = source.poll({ isOwnEcho: (row) => row.preview.includes(marker) });
  log(`inbound: reader observed ${after.length} event(s) after our send (own echo suppressed)`);
  const stillChanged = source.poll();
  log(`inbound: next poll -> ${stillChanged.length} event(s) (a stable row must not repeat)`);

  const open = currentConversation(session, target);
  log(`state  : open conversation = ${JSON.stringify(open.label)}`);

  const ok = report.sent === 1 && primed.length === 0 && stillChanged.length === 0;
  log(ok ? "VERDICT: closed loop OK (read -> decide -> send -> verify)" : "VERDICT: loop incomplete");
  process.exit(ok ? 0 : 1);
}

main();
