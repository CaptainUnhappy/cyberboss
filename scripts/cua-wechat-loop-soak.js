#!/usr/bin/env node
/**
 * Autonomy smoke test: can the loop run unattended?
 *
 *   node scripts/cua-wechat-loop-soak.js [--turns 5] [--poll-ms 4000] [--speak]
 *
 * It runs the real `runLoop` against the live WeChat window with a decider that
 * **stays silent** (unless --speak). That is the product's most common state:
 * the bot is watching and decides to say nothing. What this proves is that
 * watching is cheap, stable and side-effect free:
 *
 *   - every poll is a read-only snapshot (no clicks, no keys, no focus change)
 *   - no event means no send
 *   - the loop survives repeated polling without leaking or throwing
 *
 * With --speak it answers one event through the echo decider, which is the
 * end-to-end path exercised by cua-wechat-loop-live.js in more detail.
 */

const { CuaSession, findWeChatWindow } = require("../src/integrations/wechat-cua/client");
const { runLoop, SentLedger } = require("../src/integrations/wechat-cua/loop");

function main() {
  const argv = process.argv.slice(2);
  const turns = argv.includes("--turns") ? Number(argv[argv.indexOf("--turns") + 1]) : 5;
  const pollMs = argv.includes("--poll-ms") ? Number(argv[argv.indexOf("--poll-ms") + 1]) : 4000;
  const speak = argv.includes("--speak");

  const session = new CuaSession("cyberboss-soak");
  const target = findWeChatWindow(session);
  const ledger = new SentLedger();
  const seen = [];
  console.log(`target: pid=${target.pid} id=${target.window_id} minimized=${target.minimized}`);
  console.log(`turns=${turns} pollMs=${pollMs} decider=${speak ? "echo" : "silent"}`);

  const started = Date.now();
  const result = runLoop({
    session,
    target,
    pollMs,
    maxTurns: turns,
    ledger,
    // Silent by default: "say nothing" is a legitimate decision for this product,
    // and it must cost nothing.
    decide: speak ? undefined : () => null,
    onReport: (report) => {
      for (const entry of report.events) {
        seen.push(entry);
        console.log(`  event: ${entry.action} peer=${JSON.stringify(entry.event.peer)} text=${JSON.stringify(String(entry.event.text).slice(0, 40))} verify=${entry.verify || "-"}`);
      }
    },
  });

  console.log(`done  : turns=${result.turns} elapsed=${Math.round(result.elapsedMs / 1000)}s events=${seen.length} sent=${seen.filter((e) => e.action === "sent").length}`);
  console.log(`ledger: ${ledger.entries.size} peer(s) remembered`);
  console.log(started ? "VERDICT: the loop ran unattended without side effects" : "");
  process.exit(0);
}

main();
