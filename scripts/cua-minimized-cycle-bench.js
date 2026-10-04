#!/usr/bin/env node
/**
 * One full cycle with the operator's real configuration: WeChat minimized.
 *
 * Answers "how long until 处理中, and until the reply" with the LOCAL clock, because
 * the app's own `latencyMs` starts from WeChat's message timestamp (measured 1.9-3.7s
 * AHEAD of this machine, so it reports negative numbers).
 *
 * usage: node scripts/cua-minimized-cycle-bench.js [chatLabel] [timeoutSec]
 *
 * Timeline it prints, all local:
 *   typed   -> the probe finished typing the message into WeChat
 *   seen    -> the inbox handed it to the app ("wechat-db inbox delivered")
 *   ack     -> "处理中" left the writer ("inbound acknowledged")
 *   reply   -> the chat-list preview changed to something that is not 处理中
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const LABEL = ARGS[0] || "文件传输助手";
const TIMEOUT_S = Number(ARGS[1] || 90);
const LOG = process.env.CYBERBOSS_PROD_LOG || path.join(ROOT, "tmp", "shared-prod.log");
const STAMP = Date.now();
const TEXT = `[mbench ${STAMP}] 回一句确认即可`;

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, elements, labelOf, sendMessage,
} = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const wanted = (label) => new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
const t0 = Date.now();
const mark = (what) => console.log(`+${String(Date.now() - t0).padStart(6)}ms  ${what}`);

let logSize = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
function pump() {
  const size = fs.existsSync(LOG) ? fs.statSync(LOG).size : logSize;
  if (size <= logSize) return [];
  const fd = fs.openSync(LOG, "r");
  const buffer = Buffer.alloc(size - logSize);
  fs.readSync(fd, buffer, 0, buffer.length, logSize);
  fs.closeSync(fd);
  logSize = size;
  return buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
}

(async () => {
  const session = new CuaSession(`cycle-bench-${process.pid}`);
  const window = findWeChatWindow(session);
  const target = toTarget(window);
  console.log(`wechat pid=${window.pid} pid-minimized=${window.minimized} chat=${LABEL}`);
  console.log(`text: ${TEXT}`);

  // The chat list is visible without switching conversations, so the preview is the
  // cheapest honest observer of "did a reply land".
  const previewOf = () => elements(session.snapshot(target))
    .filter((el) => el.role === "ListItem")
    .map(labelOf)
    .find((label) => wanted(LABEL).test(label)) || "";
  const before = previewOf();
  console.log(`preview before: ${JSON.stringify(before.slice(0, 80))}`);

  const sendStarted = Date.now();
  const result = sendMessage(target, LABEL, TEXT, { session, settleMs: 1800 });
  const typedAt = Date.now();
  mark(`typed (ok=${result.ok}, ${typedAt - sendStarted}ms)${result.ok ? "" : ` verify=${result.verify}`}`);
  if (!result.ok) {
    console.log("the probe could not type its message; nothing to measure");
    process.exit(1);
  }

  let seenAt = 0;
  let ackAt = 0;
  let replyAt = 0;
  let replyPreview = "";
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline && !replyAt) {
    for (const line of pump()) {
      if (!seenAt && /wechat-db inbox delivered/.test(line)) {
        seenAt = Date.now();
        mark(`seen    ${line.replace("[cyberboss] ", "").slice(0, 110)}`);
      }
      if (!ackAt && /inbound acknowledged/.test(line)) {
        ackAt = Date.now();
        mark(`ack     ${line.replace("[cyberboss] ", "").slice(0, 110)}`);
      }
    }
    if (!replyAt) {
      const now = previewOf();
      if (now && now !== before && !/处理中/.test(now) && !/mbench/.test(now)) {
        replyAt = Date.now();
        replyPreview = now;
      }
    }
    if (!replyAt) sleep(700);
  }

  console.log("\n===== 本机时钟 =====");
  const report = (name, at) => console.log(
    `${name.padEnd(28)} ${at ? `${at - typedAt}ms` : "(未观察到)"}`);
  report("输入完成 → inbox 看见", seenAt);
  report("输入完成 → 「处理中」发出", ackAt);
  report("输入完成 → 正式回复落地", replyAt);
  console.log(`应用自报: latencyMs=${/latencyMs=(-?\d+)/.exec("")?.[1] || "见日志"} sendMs=${/sendMs=(\d+)/.exec("")?.[1] || "见日志"}`);
  if (replyPreview) console.log(`回复预览: ${JSON.stringify(replyPreview.slice(0, 140))}`);
  process.exit(replyAt ? 0 : 1);
})().catch((error) => {
  console.error("bench failed:", error.stack || error.message);
  process.exit(1);
});
