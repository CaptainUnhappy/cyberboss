#!/usr/bin/env node
/**
 * How many "处理中" does a merged burst earn? One per batch, or one per message?
 *
 * usage: node tmp/probe-ack-per-batch.js [chatLabel]
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOG = path.join(ROOT, "tmp", "shared-prod.log");
const LABEL = process.argv[2] || "文件传输助手";
const STAMP = `ACKCOUNT-${Date.now()}`;

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, elements, labelOf, sendMessage,
} = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const size = () => (fs.existsSync(LOG) ? fs.statSync(LOG).size : 0);
const readFrom = (offset) => {
  const fd = fs.openSync(LOG, "r");
  const buf = Buffer.alloc(size() - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  return buf.toString("utf8").split(/\r?\n/).filter(Boolean);
};

function composerOf(session, target) {
  return elements(session.snapshot(toTarget(target)))
    .find((el) => el.role === "Edit" && !/搜索/.test(labelOf(el)));
}

(async () => {
  const session = new CuaSession(`ackcount-${Date.now()}`);
  const win = findWeChatWindow(session);
  const target = toTarget(win);
  const start = size();
  console.log(`chat=${LABEL} burst=${STAMP}`);

  for (let index = 1; index <= 3; index += 1) {
    const composer = composerOf(session, target);
    if (composer?.element_token) {
      session.call("set_value", { ...toTarget(target), element_token: composer.element_token, value: "" });
    }
    const result = sendMessage(win, LABEL, `${STAMP}-${index} 请只回 ok`, { session, requireForegroundType: true });
    console.log(`  sent ${index} ok=${result.ok}`);
    if (index < 3) sleep(6000);
  }
  console.log("waiting 45s for the batch to flush...");
  sleep(45_000);

  const fresh = readFrom(start);
  const acks = fresh.filter((line) => /inbound acknowledged/.test(line));
  const turns = fresh.filter((line) => /resumed session/.test(line));
  console.log(`\nnew "inbound acknowledged" lines: ${acks.length}`);
  for (const line of acks) console.log("   ", line.replace("[cyberboss] ", "").slice(0, 120));
  console.log(`new "resumed session" lines: ${turns.length}`);
  console.log(acks.length === 1
    ? "=> one acknowledgement for the whole burst (per batch)"
    : `=> ${acks.length} acknowledgements for 3 messages`);
  process.exit(0);
})().catch((error) => {
  console.error("probe failed:", error.stack || error.message);
  process.exit(1);
});
