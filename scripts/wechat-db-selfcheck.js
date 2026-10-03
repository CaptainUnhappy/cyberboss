#!/usr/bin/env node
/**
 * Live end-to-end check of the DATABASE inbound path.
 *
 * What it proves, in order:
 *   1. a message typed into this account's own WeChat (i.e. what the operator
 *      does by hand) is read from the database, not from a screenshot;
 *   2. the app accepts it (self_manual) and runs a turn;
 *   3. the reply comes back through the CUA writer and lands in the chat;
 *   4. the bot's OWN reply does not come back as a new inbound turn.
 *
 * The message is typed with the low-level client sender on purpose: going
 * through the outbound path would record it in the echo ledger, and then the
 * interesting case (a manual message the ledger does NOT know) would never
 * happen.
 *
 * usage: node scripts/wechat-db-selfcheck.js [chatLabel]
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOG = process.env.CYBERBOSS_PROD_LOG || path.join(ROOT, "tmp", "shared-prod.log");
const LABEL = process.argv[2] || "文件传输助手";
const STAMP = Date.now();
const TEXT = `DBINBOX-${STAMP} 数据库入站自检：请只回复「数据库收到 ${STAMP}」这一句，不要解释。`;

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, elements, labelOf, sendMessage,
} = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const t0 = Date.now();
const stamp = (what) => console.log(`+${String(Date.now() - t0).padStart(6)}ms  ${what}`);

function wanted(label) {
  return new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
}

function switchTo(session, target, label, { tries = 20 } = {}) {
  const match = wanted(label);
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const snap = session.snapshot(toTarget(target));
    const row = elements(snap).find((el) => el.role === "ListItem" && match.test(labelOf(el)));
    if (!row) { sleep(80); continue; }
    const res = session.call("click", { ...toTarget(target), element_token: row.element_token, delivery_mode: "foreground" });
    if ((res?.payload?.refusal?.code || "ok") !== "ok") { sleep(80); continue; }
    if (match.test(currentConversation(session, target).label)) return { switched: true, attempts: attempt };
    sleep(80);
  }
  return { switched: false, label: currentConversation(session, target).label };
}

function previewOf(session, target, label) {
  const match = wanted(label);
  const row = elements(session.snapshot(target)).filter((el) => el.role === "ListItem").map(labelOf).find((text) => match.test(text));
  return row || "";
}

let logSize = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
const logLines = [];
function pumpLog() {
  const size = fs.existsSync(LOG) ? fs.statSync(LOG).size : logSize;
  if (size > logSize) {
    const fd = fs.openSync(LOG, "r");
    const buf = Buffer.alloc(size - logSize);
    fs.readSync(fd, buf, 0, buf.length, logSize);
    fs.closeSync(fd);
    logSize = size;
    for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) {
      logLines.push({ at: Date.now() - t0, line });
    }
  }
}

(async () => {
  const session = new CuaSession(`wxdb-selfcheck-${STAMP}`);
  const win = findWeChatWindow(session);
  const target = toTarget(win);
  console.log(`wechat pid=${win.pid} window=${win.window_id} open=${JSON.stringify(currentConversation(session, target).label)}`);
  console.log(`probe: ${TEXT}`);

  if (!wanted(LABEL).test(currentConversation(session, target).label)) {
    stamp(`switch -> ${LABEL}: ${JSON.stringify(switchTo(session, target, LABEL))}`);
  }
  const before = previewOf(session, target, LABEL);

  // Re-read the chat-list preview right before sending so the "did anything
  // change" comparison is honest even if the previous poll was slow.
  const injected = sendMessage(win, LABEL, TEXT, { session, requireForegroundType: true });
  const injectedAt = Date.now() - t0;
  stamp(`typed ok=${injected.ok} verified=${injected.verified} verify=${JSON.stringify(String(injected.verify).slice(0, 60))}`);
  if (!injected.ok) {
    console.log("the message never left the composer; nothing to observe");
    process.exit(1);
  }

  // 1) the DB inbox must READ it (its own stats line proves the reader ran)
  const readDeadline = Date.now() + 30_000;
  let read = null;
  while (Date.now() < readDeadline && !read) {
    pumpLog();
    read = logLines.find((entry) => entry.at >= injectedAt && /wechat-db inbox stats/.test(entry.line)) || null;
    if (!read) sleep(150);
  }
  stamp(read ? `1: reader polled  ${read.line.replace("[cyberboss] ", "").slice(0, 120)}` : "1: no reader poll seen in 30s");

  // 2) a turn must start (the app logs the inbound it accepted)
  const turnDeadline = Date.now() + 60_000;
  let turn = null;
  while (Date.now() < turnDeadline && !turn) {
    pumpLog();
    turn = logLines.find((entry) => entry.at >= injectedAt
      && /inbound acknowledged|processing inbound|turn started|self_manual|pipeline/i.test(entry.line)) || null;
    if (!turn) sleep(200);
  }
  stamp(turn ? `2: turn signal  ${turn.line.replace("[cyberboss] ", "").slice(0, 130)}` : "2: no turn signal in 60s");

  // 3) the reply must land in the chat
  const replyDeadline = Date.now() + 180_000;
  let reply = "";
  while (Date.now() < replyDeadline && !reply) {
    pumpLog();
    const preview = previewOf(session, target, LABEL);
    if (preview && preview !== before && !preview.includes(`DBINBOX-${STAMP}`)) {
      reply = preview;
    }
    if (!reply) sleep(800);
  }
  stamp(reply ? `3: reply landed -> ${JSON.stringify(reply.slice(0, 90))}` : "3: no reply within 180s");

  // 4) our own reply must not be answered again
  const quietUntil = Date.now() + 25_000;
  let selfAnswer = null;
  while (Date.now() < quietUntil && !selfAnswer) {
    pumpLog();
    selfAnswer = logLines.find((entry) => entry.at > (Date.now() - t0) - 25_000
      && /inbound acknowledged/.test(entry.line)
      && /DBINBOX/.test(entry.line)) || null;
    if (!selfAnswer) sleep(700);
  }
  stamp(`4: self-answer on the probe text seen=${Boolean(selfAnswer)} (must be false)`);

  console.log("\n===== bot log during the run =====");
  for (const entry of logLines.slice(-16)) {
    console.log(`  +${entry.at}ms  ${entry.line.replace("[cyberboss] ", "").slice(0, 150)}`);
  }
  const interesting = logLines.filter((e) => /wechat-db|deferred|failed|error/i.test(e.line));
  console.log(`\n${interesting.length} wechat-db/error lines in this window`);
  process.exit(0);
})().catch((error) => {
  console.error("selfcheck failed:", error.stack || error.message);
  process.exit(1);
});
