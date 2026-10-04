#!/usr/bin/env node
/**
 * Where do the ~2.1 seconds of a "处理中" write actually go?
 *
 * The acknowledgement is one `type_text` plus one Return, so the number that
 * matters is the sum of the driver calls in that path - not the whole send ladder
 * (which also opens the conversation, checks the box, and verifies the text).
 *
 * usage: node scripts/cua-send-steps.js [chatLabel] [--rounds N] [--no-send]
 *
 * Every call is timed individually. `--no-send` types without delivering the
 * Return, so the probe leaves nothing in the chat (it clears the box afterwards).
 */
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, elements, labelOf, isEdit,
} = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FLAGS = process.argv.slice(2).filter((a) => a.startsWith("--"));
const flagNumber = (name, fallback) => {
  const inline = FLAGS.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return Number(inline.slice(name.length + 1)) || fallback;
  const index = FLAGS.indexOf(name);
  return index >= 0 && FLAGS[index + 1] ? Number(FLAGS[index + 1]) || fallback : fallback;
};
const LABEL = ARGS[0] || "文件传输助手";
const ROUNDS = flagNumber("--rounds", 3);
const SEND = !FLAGS.includes("--no-send");

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const rows = [];
const record = (round, step, ms, extra = "") => {
  rows.push({ round, step, ms, extra });
  console.log(`  r${round} ${step.padEnd(22)} ${String(ms).padStart(6)}ms  ${extra}`);
};

(async () => {
  const session = new CuaSession(`cua-send-steps-${process.pid}`);
  const window = findWeChatWindow(session);
  const target = toTarget(window);
  console.log(`wechat pid=${window.pid} window=${window.window_id} chat=${LABEL} rounds=${ROUNDS} send=${SEND}`);

  for (let round = 1; round <= ROUNDS; round += 1) {
    let started = Date.now();
    const conv = currentConversation(session, target);
    record(round, "currentConversation", Date.now() - started, `label=${JSON.stringify(conv.label)}`);
    if (!new RegExp(`^\\s*${LABEL}`).test(conv.label)) {
      // Switch once, outside the measurement: the ladder is only interesting when
      // the conversation is already open (which is the steady state for a reply).
      const row = elements(session.snapshot(target)).find((el) => el.role === "ListItem"
        && new RegExp(`^\\s*${LABEL}`).test(labelOf(el)));
      if (!row) throw new Error(`no conversation row for ${LABEL}`);
      started = Date.now();
      session.call("click", { ...target, element_token: row.element_token, delivery_mode: "foreground" });
      record(round, "switch-conversation", Date.now() - started);
      sleep(1500);
    }

    const box = currentConversation(session, target).box;
    if (!box) throw new Error("no composer");
    const text = `steps-${Date.now()}`;

    started = Date.now();
    const typed = session.call("type_text", {
      ...target, element_token: box.element_token, text, delivery_mode: "background",
    });
    record(round, "type_text", Date.now() - started, `ok=${!typed.__failed} effect=${typed.effect || ""}`);

    started = Date.now();
    const after = currentConversation(session, target);
    record(round, "verify-read", Date.now() - started, `matches=${String(after.box?.value ?? "") === text}`);

    if (SEND) {
      started = Date.now();
      const sent = session.call("type_text", {
        ...target, element_token: after.box.element_token, text: "\n", delivery_mode: "foreground",
      });
      record(round, "newline(send)", Date.now() - started, `ok=${!sent.__failed}`);
    } else {
      started = Date.now();
      session.call("set_value", { ...target, element_token: after.box.element_token, value: "" });
      record(round, "clear-box", Date.now() - started);
    }
    sleep(400);
  }

  const byStep = new Map();
  for (const row of rows) {
    if (!byStep.has(row.step)) byStep.set(row.step, []);
    byStep.get(row.step).push(row.ms);
  }
  console.log("\n===== summary =====");
  for (const [step, values] of byStep) {
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`${step.padEnd(22)} n=${values.length} min=${Math.min(...values)} median=${median} max=${Math.max(...values)}`);
  }
  const ack = ["type_text", "newline(send)"].flatMap((step) => byStep.get(step) || []);
  if (ack.length === 2) {
    console.log(`\n处理中 write path (type + newline) this round: ${ack.reduce((a, b) => a + b, 0)}ms`);
  }
  process.exit(0);
})().catch((error) => {
  console.error("probe failed:", error.stack || error.message);
  process.exit(1);
});
