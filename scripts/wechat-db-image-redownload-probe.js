#!/usr/bin/env node
/**
 * Experiment: can the desktop client RE-DOWNLOAD an image whose original is not
 * on disk, and does opening the conversation make it happen?
 *
 * Why this is the question that matters: the whole image-upgrade path assumes
 * that opening the chat makes WeChat fetch the original. That assumption has
 * never been observed from a state where the original is genuinely absent - the
 * 2026-10-03 measurements all had the original sitting on disk already, so the
 * "wait for it to land" branch was never exercised either.
 *
 * usage: node scripts/wechat-db-image-redownload-probe.js <talker> <md5> [--open] [--seconds 180]
 *        node scripts/wechat-db-image-redownload-probe.js --restore
 *
 * <talker> is the attach-folder key (a wxid, or `filehelper`). The conversation
 * is opened by DISPLAY NAME, which this script reads from the database itself
 * through the real reader - passing a display name on the command line survived
 * neither quoting nor non-ASCII argument handling.
 *
 * Phase A (default): move `<md5>.dat` and `<md5>_h.dat` out of the way (the
 *                    thumbnail stays), then watch whether the client re-fetches
 *                    anything on its own.
 * Phase B (--open):  the same, plus one Cua "open the conversation" 60s in.
 * --restore:         put the moved files back from tmp/redownload-backup.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FLAGS = process.argv.slice(2).filter((a) => a.startsWith("--"));
const TALKER = ARGS[0] || "";
const MD5 = ARGS[1] || "";
const flagNumber = (name, fallback) => {
  const index = FLAGS.indexOf(name);
  return index >= 0 && FLAGS[index + 1] ? Number(FLAGS[index + 1]) : fallback;
};
const ACCOUNT = process.env.CYBERBOSS_WECHAT_DB_ACCOUNT_DIR
  || path.join(process.env.CYBERBOSS_WECHAT_DB_DIR || "D:\\xwechat_files", "wxid_ty69l7hjiqt012_f2b4");
const BACKUP = path.join(ROOT, "tmp", "redownload-backup");
const MANIFEST = path.join(BACKUP, "manifest.json");

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (message) => console.log(`${stamp()}  ${message}`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const folderFor = (talker) => path.join(
  ACCOUNT, "msg", "attach", crypto.createHash("md5").update(talker).digest("hex"));

function findVariants(folder, md5) {
  const found = [];
  if (!fs.existsSync(folder)) return found;
  for (const month of fs.readdirSync(folder)) {
    const dir = path.join(folder, month, "Img");
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(md5)) {
        const full = path.join(dir, name);
        found.push({ path: full, name, size: fs.statSync(full).size });
      }
    }
  }
  return found;
}

/** The name the Cua writer opens a conversation by, straight from the reader. */
async function labelFor(talker) {
  const { readConfig } = require(path.join(ROOT, "src", "core", "config"));
  const { WechatDbWorker } = require(path.join(ROOT, "src", "integrations", "wechat-db", "worker"));
  const config = readConfig();
  const worker = new WechatDbWorker({
    pythonCommand: config.wechatDbPythonCommand,
    scriptPath: config.wechatDbReaderScript,
    env: {
      CYBERBOSS_WECHAT_DB_KEY: config.wechatDbKey,
      CYBERBOSS_WECHAT_DB_DIR: config.wechatDbDataDir,
      CYBERBOSS_WECHAT_DB_WXID: config.wechatDbWxid,
      CYBERBOSS_STATE_DIR: config.stateDir,
    },
  });
  try {
    const payload = await worker.snapshots({ chats: [talker], limit: 5 });
    return String((payload.chats || [])[0]?.displayName || talker);
  } finally {
    await worker.stop();
  }
}

function restore() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`nothing to restore (no ${MANIFEST})`);
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  for (const entry of manifest) {
    if (!fs.existsSync(entry.backup)) {
      log(`missing backup ${path.basename(entry.backup)} - skipped`);
      continue;
    }
    fs.mkdirSync(path.dirname(entry.original), { recursive: true });
    fs.renameSync(entry.backup, entry.original);
    log(`restored ${path.basename(entry.original)}`);
  }
  fs.rmSync(MANIFEST, { force: true });
  return 0;
}

(async () => {
  if (FLAGS.includes("--restore")) {
    process.exit(restore());
  }
  if (!TALKER || !MD5) {
    console.error("usage: node scripts/wechat-db-image-redownload-probe.js <talker> <md5> [--open] [--seconds N]");
    process.exit(1);
  }
  const folder = folderFor(TALKER);
  const label = await labelFor(TALKER);
  console.log(`talker=${TALKER} label=${label} md5=${MD5}`);
  console.log(`attach folder: ${folder}`);
  const before = findVariants(folder, MD5);
  if (!before.length) {
    console.error("no files for that md5; nothing to do");
    process.exit(1);
  }
  log(`variants now: ${before.map((f) => `${f.name} ${f.size}B`).join(" | ")}`);

  fs.mkdirSync(BACKUP, { recursive: true });
  const manifest = [];
  for (const file of before.filter((f) => !f.name.includes("_t.dat"))) {
    const dest = path.join(BACKUP, `${Date.now()}-${file.name}`);
    fs.renameSync(file.path, dest);
    manifest.push({ original: file.path, backup: dest });
    log(`moved away ${file.name} (${file.size}B)`);
  }
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(`variants now: ${findVariants(folder, MD5).map((f) => `${f.name} ${f.size}B`).join(" | ") || "(none)"}`);

  const deadline = Date.now() + flagNumber("--seconds", 180) * 1000;
  const openAt = FLAGS.includes("--open") ? Date.now() + 60_000 : 0;
  let opened = false;
  const seen = new Set(findVariants(folder, MD5).map((f) => `${f.name}:${f.size}`));

  while (Date.now() < deadline) {
    if (!opened && openAt && Date.now() >= openAt) {
      opened = true;
      const { CuaSession, findWeChatWindow, ensureConversation } = require(
        path.join(ROOT, "src", "integrations", "wechat-cua", "client"));
      const session = new CuaSession(`redownload-probe-${process.pid}`);
      const window = findWeChatWindow(session);
      const started = Date.now();
      try {
        ensureConversation(session, window, label, { settleMs: 1800 });
        log(`OPENED ${label} in ${Date.now() - started}ms -- phase B`);
      } catch (error) {
        log(`open failed: ${error.message}`);
      }
    }
    for (const file of findVariants(folder, MD5)) {
      const key = `${file.name}:${file.size}`;
      if (!seen.has(key)) {
        seen.add(key);
        log(`NEW FILE ${file.name} ${file.size}B`);
      }
    }
    sleep(1_000);
  }
  log(`final: ${findVariants(folder, MD5).map((f) => `${f.name} ${f.size}B`).join(" | ") || "(none)"}`);
  log("restore with: node scripts/wechat-db-image-redownload-probe.js --restore");
  process.exit(0);
})().catch((error) => {
  console.error("probe failed:", error.stack || error.message);
  process.exit(1);
});
