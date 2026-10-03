#!/usr/bin/env node
/**
 * Live check: an IMAGE sent into this account's own WeChat must reach the turn.
 *
 * The operator's complaint on 2026-10-02 was "图没收到 我这边只有「图片」两个字" -
 * the bot was answering a placeholder. This script sends a real picture (via the
 * clipboard, the way a human does) into the self-chat and then watches the bot
 * log for the turn and the reply.
 *
 * usage: node scripts/wechat-db-image-selfcheck.js <image-path> [chatLabel]
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOG = process.env.CYBERBOSS_PROD_LOG || path.join(ROOT, "tmp", "shared-prod.log");
const IMAGE = process.argv[2];
const LABEL = process.argv[3] || "文件传输助手";
const STAMP = Date.now();

if (!IMAGE || !fs.existsSync(IMAGE)) {
  console.error(`usage: node scripts/wechat-db-image-selfcheck.js <existing-image-path> [chatLabel]`);
  process.exit(1);
}

const {
  CuaSession, toTarget, findWeChatWindow, currentConversation, elements, labelOf,
} = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const t0 = Date.now();
const stamp = (what) => console.log(`+${String(Date.now() - t0).padStart(6)}ms  ${what}`);
const wanted = (label) => new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");

function switchTo(session, target, label, { tries = 20 } = {}) {
  const match = wanted(label);
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const row = elements(session.snapshot(toTarget(target)))
      .find((el) => el.role === "ListItem" && match.test(labelOf(el)));
    if (row) {
      const res = session.call("click", { ...toTarget(target), element_token: row.element_token, delivery_mode: "foreground" });
      if ((res?.payload?.refusal?.code || "ok") === "ok" && match.test(currentConversation(session, target).label)) {
        return { switched: true, attempts: attempt };
      }
    }
    sleep(80);
  }
  return { switched: false, label: currentConversation(session, target).label };
}

function previewOf(session, target, label) {
  const match = wanted(label);
  return elements(session.snapshot(target)).filter((el) => el.role === "ListItem").map(labelOf).find((t) => match.test(t)) || "";
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
    for (const line of buf.toString("utf8").split(/\r?\n/).filter(Boolean)) logLines.push({ at: Date.now() - t0, line });
  }
}

(async () => {
  const session = new CuaSession(`wxdb-image-${STAMP}`);
  const win = findWeChatWindow(session);
  const target = toTarget(win);
  console.log(`wechat pid=${win.pid} window=${win.window_id}`);
  console.log(`image : ${IMAGE} (${fs.statSync(IMAGE).size} bytes)`);

  if (!wanted(LABEL).test(currentConversation(session, target).label)) {
    stamp(`switch -> ${LABEL}: ${JSON.stringify(switchTo(session, target, LABEL))}`);
  }
  const before = previewOf(session, target, LABEL);

  const clip = session.call("clipboard_write", { image_path: path.resolve(IMAGE) });
  stamp(`clipboard_write : ${JSON.stringify(clip?.payload?.types || clip?.payload || {}).slice(0, 120)}`);

  const paste = session.call("hotkey", { ...toTarget(target), keys: ["ctrl", "v"], delivery_mode: "foreground" });
  stamp(`paste           : refusal=${paste?.payload?.refusal?.code || "ok"}`);
  sleep(1500);

  const typed = session.call("press_key", { ...toTarget(target), key: "return", delivery_mode: "foreground" });
  stamp(`send (return)   : refusal=${typed?.payload?.refusal?.code || "ok"}`);

  // The chat list preview must now show an image marker for this chat.
  const waitPreview = Date.now() + 20_000;
  let preview = "";
  while (Date.now() < waitPreview && !preview) {
    const now = previewOf(session, target, LABEL);
    if (now && now !== before) preview = now;
    if (!preview) sleep(600);
  }
  stamp(`preview         : ${JSON.stringify(preview.slice(0, 70))}`);

  const readDeadline = Date.now() + 40_000;
  let read = null;
  while (Date.now() < readDeadline && !read) {
    pumpLog();
    read = logLines.find((entry) => /wechat-db inbox stats/.test(entry.line)) || null;
    if (!read) sleep(300);
  }
  stamp(read ? `reader          : ${read.line.replace("[cyberboss] ", "").slice(0, 120)}` : "reader          : no poll seen");

  const replyDeadline = Date.now() + 180_000;
  let reply = "";
  let turn = null;
  while (Date.now() < replyDeadline && !reply) {
    pumpLog();
    turn = turn || logLines.find((e) => /inbound acknowledged/.test(e.line)) || null;
    const now = previewOf(session, target, LABEL);
    if (now && now !== before && !/图片|\[图片\]/.test(now)) reply = now;
    if (!reply) sleep(800);
  }
  stamp(turn ? `turn            : ${turn.line.replace("[cyberboss] ", "").slice(0, 120)}` : "turn            : none");
  stamp(reply ? `reply           : ${JSON.stringify(reply.slice(0, 90))}` : "reply           : none within 180s");

  console.log("\n===== bot log (tail) =====");
  for (const entry of logLines.slice(-14)) console.log(`  +${entry.at}ms  ${entry.line.replace("[cyberboss] ", "").slice(0, 145)}`);
  process.exit(0);
})().catch((error) => {
  console.error("image selfcheck failed:", error.stack || error.message);
  process.exit(1);
});
