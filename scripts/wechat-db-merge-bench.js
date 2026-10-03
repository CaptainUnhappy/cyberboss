#!/usr/bin/env node
/**
 * Is the 15s aggregation window still there? End-to-end, with the bot's own
 * transcript as the evidence.
 *
 * The window lives in `pendingInboundQuietWindowMs` (default 15000): messages that
 * arrive inside one quiet window are collected into a SINGLE turn. That is a
 * behavioural claim, so it is tested as one:
 *
 *   round A (inside the window):  3 messages 6s apart  -> 1 turn, whose input
 *                                 contains all three stamps
 *   round B (outside the window): 2 messages 20s apart   -> 2 turns, one stamp each
 *
 * The evidence is the DSH session transcript (`.jsonl.zstd`, one `user/message`
 * record per turn), not a log line that could mean anything.
 *
 * usage: node scripts/wechat-db-merge-bench.js [chatLabel]
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LABEL = process.argv[2] || "文件传输助手";
const SESSION = process.env.CYBERBOSS_DSH_SESSION || "3e46ce89-3727-4f45-a3ca-2ff728091901";
const READER = path.join(ROOT, "scripts", "dsh-transcript.py");

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, elements, labelOf, sendMessage,
} = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const wanted = (label) => new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");

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

/** Every `user/message` record in the window's transcript, oldest first. */
function userMessages() {
  const out = execFileSync("python", [READER, SESSION, "--types", "user/message", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  return out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function stampsIn(text, stamps) {
  return stamps.filter((stamp) => String(text).includes(stamp));
}

async function waitForTurns({ sinceIndex, expected, stamps, timeoutMs = 90_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const fresh = userMessages().filter((record) => record.index > sinceIndex);
    const matched = fresh.filter((record) => stampsIn(record.text, stamps).length > 0);
    if (matched.length >= expected && Date.now() > deadline - timeoutMs + 5_000) {
      return matched;
    }
    if (Date.now() > deadline) {
      return matched;
    }
    sleep(1_000);
  }
}

/** The composer element (never the search box). Its `label` is the chat name,
 *  not its content, so it cannot be used to test emptiness - only the driver's
 *  own refusal tells us the box is dirty. */
function composerOf(session, target) {
  return elements(session.snapshot(toTarget(target)))
    .find((el) => el.role === "Edit" && !/搜索/.test(labelOf(el)));
}

/**
 * Empty the message box.
 *
 * Two writers share this composer: the bench types into it, and the bot types its
 * own "处理中" into it as soon as it notices a message. When they overlap the next
 * send refuses with `the message box already holds unsent text` and the round
 * produces nothing (measured 2026-10-03, the first three runs of this bench).
 *
 * Clearing has to go through the composer's own `set_value` action: WeChat's
 * input is a custom control, so ctrl+a + delete leaves fragments behind (the
 * observed leftover was the two characters `"y1"`), while set_value("") empties it.
 */
function forceClear(session, target) {
  const composer = composerOf(session, target);
  if (!composer?.element_token) {
    return;
  }
  session.call("set_value", { ...toTarget(target), element_token: composer.element_token, value: "" });
  sleep(400);
}

/** One stamped message; a dirty box (the bot's ack landed mid-type) is cleared and
 *  the send retried once. */
function sendStamped(win, session, target, text) {
  let result = sendMessage(win, LABEL, text, { session, requireForegroundType: true });
  if (!result.ok && /already holds unsent text/i.test(String(result.verify || ""))) {
    forceClear(session, target);
    result = sendMessage(win, LABEL, text, { session, requireForegroundType: true });
  }
  if (!result.ok) {
    console.log(`    send refused: ${String(result.verify || "").slice(0, 140)}`);
  }
  return result;
}

(async () => {
  const session = new CuaSession(`wxdb-merge-${Date.now()}`);
  const win = findWeChatWindow(session);
  const target = toTarget(win);
  if (!wanted(LABEL).test(currentConversation(session, target).label)) {
    switchTo(session, target, LABEL);
  }

  const before = userMessages();
  const lastIndex = before.length ? before[before.length - 1].index : -1;
  console.log(`chat=${LABEL} session=${SESSION} baseline user/message records=${before.length}`);

  // ---------------------------------------------------------------- round A
  const runA = `MERGEA-${Date.now()}`;
  const stampsA = [`${runA}-1`, `${runA}-2`, `${runA}-3`];
  console.log(`\n[A] inside the window: 3 messages 6s apart (${stampsA.join(", ")})`);
  for (const [index, stamp] of stampsA.entries()) {
    const result = sendStamped(win, session, target, `${stamp} 这条和同一批的消息请一起看，只回一句 ok`);
    console.log(`    sent ${stamp} ok=${result.ok}`);
    if (index < stampsA.length - 1) sleep(6000);
  }
  const turnsA = await waitForTurns({ sinceIndex: lastIndex, expected: 1, stamps: stampsA });
  console.log(`[A] turns that carry these stamps: ${turnsA.length}`);
  for (const turn of turnsA) {
    const found = stampsIn(turn.text, stampsA);
    console.log(`    turn record #${turn.index}: ${found.length}/3 stamps -> ${JSON.stringify(found)}`);
  }

  // ---------------------------------------------------------------- round B
  const runB = `MERGEB-${Date.now()}`;
  const stampsB = [`${runB}-1`, `${runB}-2`];
  console.log(`\n[B] outside the window: 2 messages 20s apart (${stampsB.join(", ")})`);
  for (const [index, stamp] of stampsB.entries()) {
    const result = sendStamped(win, session, target, `${stamp} 请只回一句 ok`);
    console.log(`    sent ${stamp} ok=${result.ok}`);
    if (index < stampsB.length - 1) sleep(20_000);
  }
  const turnsB = await waitForTurns({ sinceIndex: lastIndex, expected: 2, stamps: stampsB, timeoutMs: 120_000 });
  console.log(`[B] turns that carry these stamps: ${turnsB.length}`);
  for (const turn of turnsB) {
    const found = stampsIn(turn.text, stampsB);
    console.log(`    turn record #${turn.index}: ${JSON.stringify(found)}`);
  }

  // ---------------------------------------------------------------- verdict
  const mergedA = turnsA.length === 1 && stampsIn(turnsA[0].text, stampsA).length === 3;
  const splitB = turnsB.length === 2
    && stampsIn(turnsB[0].text, stampsB).length === 1
    && stampsIn(turnsB[1].text, stampsB).length === 1;
  console.log("\n===== verdict =====");
  console.log(`window aggregates a burst into one turn: ${mergedA ? "YES" : "NO"} (${turnsA.length} turn(s))`);
  console.log(`a burst outside the window stays split:   ${splitB ? "YES" : "NO"} (${turnsB.length} turn(s))`);
  fs.writeFileSync(path.join(ROOT, "tmp", "merge-bench.json"), JSON.stringify({
    window: { stamps: stampsA, turns: turnsA.map((turn) => ({ index: turn.index, stamps: stampsIn(turn.text, stampsA) })) },
    split: { stamps: stampsB, turns: turnsB.map((turn) => ({ index: turn.index, stamps: stampsIn(turn.text, stampsB) })) },
  }, null, 2));
  process.exit(mergedA && splitB ? 0 : 1);
})().catch((error) => {
  console.error("merge bench failed:", error.stack || error.message);
  process.exit(1);
});
