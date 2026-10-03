#!/usr/bin/env node
/**
 * End-to-end: send a REAL picture into a chat through the human route (clipboard
 * + Ctrl+V, the same path `wechat-db-image-selfcheck.js` uses), then watch what
 * the receiving client actually puts on disk and for how long it stays a preview.
 *
 * Why: the production image pipeline assumes (a) the original is not on disk at
 * first, and (b) opening the conversation makes the client fetch it. Neither has
 * been observed from a genuine "fresh picture" state; the 2026-10-03 numbers all
 * came from pictures that were already fully downloaded.
 *
 * usage: node scripts/wechat-db-image-arrival-probe.js <image-path> [--label <displayName>] [--open-after N]
 *
 * Timeline: send -> watch the attach folder every 2s. `--open-after N` opens the
 * conversation through Cua N seconds after the send (default: never) so the two
 * phases can be told apart.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FLAGS = process.argv.slice(2).filter((a) => a.startsWith("--"));
const IMAGE = ARGS[0] || "";
const flagNumber = (name, fallback) => {
  const index = FLAGS.indexOf(name);
  return index >= 0 && FLAGS[index + 1] ? Number(FLAGS[index + 1]) : fallback;
};
const ACCOUNT = process.env.CYBERBOSS_WECHAT_DB_ACCOUNT_DIR
  || path.join(process.env.CYBERBOSS_WECHAT_DB_DIR || "D:\\xwechat_files", "wxid_ty69l7hjiqt012_f2b4");
const WATCH_SECONDS = flagNumber("--seconds", 180);
const OPEN_AFTER = flagNumber("--open-after", 0);
const LABEL = "文件传输助手";
const TALKER = "filehelper";

const stamp = () => new Date().toISOString().slice(11, 23);
const t0 = Date.now();
const log = (message) => console.log(`${stamp()}  +${String(Date.now() - t0).padStart(6)}ms  ${message}`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const folder = path.join(ACCOUNT, "msg", "attach", crypto.createHash("md5").update(TALKER).digest("hex"));

/** md5 of the plaintext the sender put on the wire is NOT the file name; the row is the source of truth. */
function newestImageMd5() {
  const newest = { md5: "", file: "" };
  if (!fs.existsSync(folder)) return newest;
  for (const month of fs.readdirSync(folder)) {
    const dir = path.join(folder, month, "Img");
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const base = name.replace(/_t\.dat$|_h\.dat$|\.dat$/, "");
      if (!/^[0-9a-f]{32}$/.test(base)) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).mtimeMs > (newest.mtimeMs || 0)) {
        newest.md5 = base;
        newest.file = full;
        newest.mtimeMs = fs.statSync(full).mtimeMs;
      }
    }
  }
  return newest;
}

function listVariants(md5) {
  const found = [];
  if (!fs.existsSync(folder)) return found;
  for (const month of fs.readdirSync(folder)) {
    const dir = path.join(folder, month, "Img");
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (md5 && !name.startsWith(md5)) continue;
      found.push({ name, size: fs.statSync(path.join(dir, name)).size });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

(async () => {
  if (!IMAGE || !fs.existsSync(IMAGE)) {
    console.error("usage: node scripts/wechat-db-image-arrival-probe.js <image-path> [--open-after N] [--seconds N]");
    process.exit(1);
  }
  const {
    CuaSession, toTarget, findWeChatWindow, currentConversation,
  } = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

  const baseline = new Set(listVariants("").map((f) => f.name));
  log(`image ${path.basename(IMAGE)} (${fs.statSync(IMAGE).size}B); attach files before=${baseline.size}`);

  const session = new CuaSession(`image-arrival-${process.pid}`);
  const window = findWeChatWindow(session);
  const target = toTarget(window);
  log(`wechat pid=${window.pid} window=${window.window_id} conversation=${currentConversation(session, target).label}`);

  if (currentConversation(session, target).label.trim() !== LABEL) {
    const { ensureConversation } = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));
    const opened = ensureConversation(session, target, LABEL, { settleMs: 1800 });
    log(`switched to ${LABEL}: route=${opened.route} cost=${opened.cost}`);
  }

  const clip = session.call("clipboard_write", { image_path: path.resolve(IMAGE) });
  log(`clipboard_write: ${JSON.stringify(clip?.payload?.types || clip?.payload || {}).slice(0, 140)}`);
  const pasted = session.call("hotkey", { ...target, keys: ["ctrl", "v"], delivery_mode: "foreground" });
  log(`paste: refusal=${pasted?.payload?.refusal?.code || "ok"}`);
  sleep(1500);
  const sent = session.call("press_key", { ...target, key: "return", delivery_mode: "foreground" });
  const sentAt = Date.now();
  log(`send(return): refusal=${sent?.payload?.refusal?.code || "ok"}  <-- clock starts`);

  let md5 = "";
  let opened = false;
  const openAt = OPEN_AFTER ? sentAt + OPEN_AFTER * 1000 : 0;
  const deadline = sentAt + WATCH_SECONDS * 1000;

  while (Date.now() < deadline) {
    const fresh = listVariants("").filter((f) => !baseline.has(f.name));
    if (fresh.length) {
      const guessed = fresh[0].name.replace(/_t\.dat$|_h\.dat$|\.dat$/, "");
      if (!md5 && /^[0-9a-f]{32}$/.test(guessed)) md5 = guessed;
    }
    if (!md5) {
      const newest = newestImageMd5();
      if (newest.md5 && newest.mtimeMs > sentAt - 5000) md5 = newest.md5;
    }
    if (md5) {
      const variants = listVariants(md5);
      log(`md5=${md5} files: ${variants.map((v) => `${v.name.replace(md5, "")} ${v.size}B`).join(" | ")}`);
    }
    if (!opened && openAt && Date.now() >= openAt) {
      opened = true;
      const { ensureConversation } = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));
      const started = Date.now();
      try {
        ensureConversation(session, target, LABEL, { settleMs: 1800 });
        log(`OPENED ${LABEL} again in ${Date.now() - started}ms -- phase B starts`);
      } catch (error) {
        log(`open failed: ${error.message}`);
      }
    }
    sleep(2_000);
  }
  const final = listVariants(md5);
  log(`FINAL md5=${md5 || "(unknown)"}`);
  for (const variant of final) log(`  ${variant.name} ${variant.size}B`);
  process.exit(0);
})().catch((error) => {
  console.error("probe failed:", error.stack || error.message);
  process.exit(1);
});
