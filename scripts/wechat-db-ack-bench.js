#!/usr/bin/env node
/**
 * End-to-end "处理中" timing, repeated, against the LIVE bot.
 *
 * The production log already carries both halves of the answer, so the bench only
 * has to create traffic and read them:
 *
 *   [cyberboss] wechat-db inbox delivered talker=文件传输助手 direction=… lagMs=…
 *   [cyberboss] inbound acknowledged message=… latencyMs=… sendMs=…
 *
 * `latencyMs` is what the operator feels: from the message's own timestamp to the
 * moment the acknowledgement left. `sendMs` is how much of that the write path
 * cost. The bench types one stamped message per round and never writes anything
 * itself, so the numbers are not polluted by a competing writer.
 *
 * usage: node scripts/wechat-db-ack-bench.js [rounds] [chatLabel] [gapMs]
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOG = process.env.CYBERBOSS_PROD_LOG || path.join(ROOT, "tmp", "shared-prod.log");
const ROUNDS = Number(process.argv[2] || 5);
const LABEL = process.argv[3] || "文件传输助手";
const GAP = Number(process.argv[4] || 12_000);

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, elements, labelOf, sendMessage,
} = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const wanted = (label) => new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
const summary = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    max: sorted[sorted.length - 1],
  };
};
const line = (name, stats) => (stats
  ? `${name.padEnd(28)} min=${String(stats.min).padStart(5)} median=${String(stats.median).padStart(5)} mean=${String(stats.mean).padStart(5)} max=${String(stats.max).padStart(5)} ms  n=${stats.n}`
  : `${name.padEnd(28)} (no samples)`);

let logSize = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
function drainLog() {
  const size = fs.existsSync(LOG) ? fs.statSync(LOG).size : logSize;
  if (size <= logSize) return [];
  const fd = fs.openSync(LOG, "r");
  const buf = Buffer.alloc(size - logSize);
  fs.readSync(fd, buf, 0, buf.length, logSize);
  fs.closeSync(fd);
  logSize = size;
  return buf.toString("utf8").split(/\r?\n/).filter(Boolean);
}

function switchTo(session, target, label, { tries = 20 } = {}) {
  const match = wanted(label);
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const row = elements(session.snapshot(toTarget(target)))
      .find((el) => el.role === "ListItem" && match.test(labelOf(el)));
    if (row) {
      const res = session.call("click", { ...toTarget(target), element_token: row.element_token, delivery_mode: "foreground" });
      if ((res?.payload?.refusal?.code || "ok") === "ok" && match.test(currentConversation(session, target).label)) return true;
    }
    sleep(80);
  }
  return false;
}

(async () => {
  const session = new CuaSession(`wxdb-ackbench-${Date.now()}`);
  const win = findWeChatWindow(session);
  const target = toTarget(win);
  if (!wanted(LABEL).test(currentConversation(session, target).label)) {
    switchTo(session, target, LABEL);
  }
  const pollMs = Number(process.env.CYBERBOSS_WECHAT_DB_POLL_MS || 0) || "(from .env)";
  console.log(`chat=${LABEL} rounds=${ROUNDS} gap=${GAP}ms pollMs=${pollMs}`);
  console.log("");

  const rows = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const stamp = `ACKBENCH-${Date.now()}-R${round}`;
    const started = Date.now();
    const result = sendMessage(win, LABEL, `${stamp} 请只回复 ok`, { session, requireForegroundType: true });
    const storedAt = Date.now();
    if (!result.ok) {
      console.log(`round ${round}: the message never left the composer, skipping`);
      continue;
    }
    const typeMs = storedAt - started;

    let noticeMs = null;
    let acknowledgeLatencyMs = null;
    let acknowledgeSendMs = null;
    // The number the operator actually feels: from pressing Enter to the moment
    // the bot's write path has confirmed the bubble (the app logs the
    // acknowledgement only after the writer verified it).
    let acknowledgeVisibleMs = null;
    let expectedLocalId = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && (noticeMs === null || acknowledgeVisibleMs === null)) {
      for (const logLine of drainLog()) {
        const delivered = /wechat-db inbox delivered talker=(\S+) localId=(\d+)/.exec(logLine);
        if (delivered) {
          const talker = delivered[1];
          const localId = Number(delivered[2]);
          const isOurChat = talker === "filehelper" || talker === LABEL;
          if (expectedLocalId === null) expectedLocalId = localId;
          if (noticeMs === null && isOurChat && localId >= expectedLocalId) {
            noticeMs = Date.now() - storedAt;
          }
        }
        const acked = /inbound acknowledged .*latencyMs=(\d+) sendMs=(\d+)/.exec(logLine);
        if (acked) {
          if (acknowledgeLatencyMs === null) {
            acknowledgeLatencyMs = Number(acked[1]);
            acknowledgeSendMs = Number(acked[2]);
          }
          if (acknowledgeVisibleMs === null && noticeMs !== null) {
            acknowledgeVisibleMs = Date.now() - storedAt;
          }
        }
      }
      if (noticeMs === null || acknowledgeVisibleMs === null) sleep(100);
    }
    if (acknowledgeVisibleMs === null && acknowledgeLatencyMs !== null) {
      acknowledgeVisibleMs = null;
    }
    rows.push({ round, typeMs, noticeMs, acknowledgeVisibleMs, acknowledgeLatencyMs, acknowledgeSendMs });
    console.log(
      `round ${round}: typed in ${typeMs}ms  noticed after ${noticeMs ?? "?"}ms  `
      + `"处理中" visible after ${acknowledgeVisibleMs ?? "?"}ms  `
      + `(app: latencyMs=${acknowledgeLatencyMs ?? "?"} sendMs=${acknowledgeSendMs ?? "?"})`
    );
    const until = Date.now() + GAP;
    while (Date.now() < until) { drainLog(); sleep(200); }
  }

  console.log("\n===== summary =====");
  console.log(line("notice (stored -> seen)", summary(rows.map((row) => row.noticeMs).filter((value) => value !== null))));
  console.log(line("处理中 visible (Enter -> ack)", summary(rows.map((row) => row.acknowledgeVisibleMs).filter((value) => value != null))));
  console.log(line("app latencyMs (row -> ack sent)", summary(rows.map((row) => row.acknowledgeLatencyMs).filter((value) => value != null))));
  console.log(line("app sendMs (write cost)", summary(rows.map((row) => row.acknowledgeSendMs).filter((value) => value != null))));
  const out = path.join(ROOT, "tmp", "ack-bench.json");
  fs.writeFileSync(out, JSON.stringify({ pollMs, rows }, null, 2));
  console.log(`\nwrote ${out}`);
  process.exit(0);
})().catch((error) => {
  console.error("bench failed:", error.stack || error.message);
  process.exit(1);
});
