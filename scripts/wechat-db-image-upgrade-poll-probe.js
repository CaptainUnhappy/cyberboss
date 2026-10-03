#!/usr/bin/env node
/**
 * End-to-end upgrade probe: the REAL poll loop, against the REAL client and the
 * REAL reader, with one picture reported as a preview.
 *
 * What the earlier `wechat-db-image-upgrade-live.js` could not show: that probe
 * calls `upgradeThumbnailImages` with a doctored snapshot, so it never exercises
 * delivery, the quality counters, or the envelope the turn will actually carry.
 * This one goes through `pollOnce()` and prints the delivered attachment.
 *
 * usage:
 *   node scripts/wechat-db-image-upgrade-poll-probe.js <talker> [localId] [--hide-original]
 *
 * The "preview" condition comes from the reader's documented test hook
 * (`--force-thumbnail-md5`), because the genuine state - a peer's picture whose
 * original WeChat has not downloaded - cannot be produced from this machine.
 * `--hide-original` additionally moves the source files away, which is the only
 * way to exercise the "even opening the chat did not produce an original" branch.
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
const ACCOUNT = process.env.CYBERBOSS_WECHAT_DB_ACCOUNT_DIR
  || path.join(process.env.CYBERBOSS_WECHAT_DB_DIR || "D:\\xwechat_files", "wxid_ty69l7hjiqt012_f2b4");
const BACKUP = path.join(ROOT, "tmp", "upgrade-poll-backup");
const CACHE = path.join(ROOT, "tmp", "upgrade-poll-cache");

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (message) => console.log(`${stamp()}  ${message}`);
const attachFolder = path.join(ACCOUNT, "msg", "attach", crypto.createHash("md5").update(TALKER).digest("hex"));

function variantFiles(md5) {
  const found = [];
  if (!fs.existsSync(attachFolder)) return found;
  for (const month of fs.readdirSync(attachFolder)) {
    const dir = path.join(attachFolder, month, "Img");
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(md5)) found.push(path.join(dir, name));
    }
  }
  return found;
}

(async () => {
  if (!TALKER) {
    console.error("usage: node scripts/wechat-db-image-upgrade-poll-probe.js <talker> [localId] [--hide-original]");
    process.exit(1);
  }
  const { readConfig } = require(path.join(ROOT, "src", "core", "config"));
  const { WechatDbWorker } = require(path.join(ROOT, "src", "integrations", "wechat-db", "worker"));
  const { WechatDbInboxSource } = require(path.join(ROOT, "src", "integrations", "wechat-db", "inbox"));
  const { CuaSession, findWeChatWindow, ensureConversation } = require(
    path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

  const config = readConfig();
  const workerEnv = (extra = {}) => ({
    CYBERBOSS_WECHAT_DB_KEY: config.wechatDbKey,
    CYBERBOSS_WECHAT_DB_DIR: config.wechatDbDataDir,
    CYBERBOSS_WECHAT_DB_WXID: config.wechatDbWxid,
    // An explicit cache dir matters more than it looks: the reader writes the
    // decrypted picture there, and a cached winner outlives the source file it
    // came from (which is exactly what hid a preview behind an "original").
    CYBERBOSS_WECHAT_DB_CACHE_DIR: CACHE,
    CYBERBOSS_STATE_DIR: path.join(ROOT, "tmp", "upgrade-poll-state"),
    ...extra,
  });
  const makeWorker = (extra) => new WechatDbWorker({
    pythonCommand: config.wechatDbPythonCommand,
    scriptPath: config.wechatDbReaderScript,
    env: workerEnv(extra),
  });

  // ── phase 1: which picture is the interesting one, and what is it now? ──
  const reader = makeWorker({ CYBERBOSS_WECHAT_DB_HISTORY_LIMIT: "200" });
  const first = await reader.snapshots({ chats: [TALKER], limit: 200 });
  const snapshot = (first.chats || [])[0];
  if (!snapshot) throw new Error(`no snapshot for ${TALKER}`);
  const images = (snapshot.messages || []).filter((message) => message.kind === "image");
  if (!images.length) throw new Error(`no image row in ${TALKER}`);
  const wantedLocalId = Number(ARGS[1] || 0);
  const target = wantedLocalId
    ? images.find((message) => message.localId === wantedLocalId)
    : images[images.length - 1];
  if (!target) throw new Error(`no image row with localId=${wantedLocalId} in ${TALKER}`);
  const md5 = String(target.imageSource || "").match(/[0-9a-f]{32}/)?.[0]
    || path.basename(target.attachments?.[0]?.path || "").match(/[0-9a-f]{32}/)?.[0] || "";
  if (!md5) throw new Error("could not determine the picture's md5");
  log(`chat=${snapshot.displayName} target localId=${target.localId} md5=${md5} `);
  log(`  as the reader sees it now: quality=${target.imageQuality} size=${target.imageSize} `
    + `source=${target.imageSource}`);
  await reader.stop();

  // ── phase 2: hide the source files, if the caller wants the "still a preview after
  //    opening the chat" branch ──
  const hidden = [];
  const restore = () => {
    for (const entry of hidden.splice(0)) {
      fs.mkdirSync(path.dirname(entry.original), { recursive: true });
      fs.renameSync(entry.backup, entry.original);
      log(`restored ${path.basename(entry.original)} (the client "downloaded" it)`);
    }
  };
  if (FLAGS.includes("--hide-original")) {
    fs.mkdirSync(BACKUP, { recursive: true });
    for (const file of variantFiles(md5)) {
      if (file.endsWith("_t.dat")) continue;
      const dest = path.join(BACKUP, `${Date.now()}-${path.basename(file)}`);
      fs.renameSync(file, dest);
      hidden.push({ original: file, backup: dest });
      log(`hid ${path.basename(file)}`);
    }
    log(`hidden ${hidden.length} variant(s); only the preview is left on disk`);
  }

  // ── phase 3: the production poll, with the picture reported as a preview ──
  const worker = makeWorker({
    CYBERBOSS_WECHAT_DB_FORCE_THUMBNAIL_MD5: md5,
    CYBERBOSS_WECHAT_DB_HISTORY_LIMIT: "200",
  });
  const session = new CuaSession(`upgrade-poll-${process.pid}`);
  const window = findWeChatWindow(session);
  const opener = (peer) => {
    const started = Date.now();
    try {
      ensureConversation(session, window, peer, { settleMs: 1800 });
    } catch (error) {
      if (!/minimized/i.test(String(error?.message || ""))) throw error;
      log(`restored minimized window: ${JSON.stringify(session.restoreMinimized(window.pid))}`);
      ensureConversation(session, window, peer, { settleMs: 1800 });
    }
    log(`opened ${peer} in ${Date.now() - started}ms`);
    return true;
  };

  const delivered = [];
  const source = new WechatDbInboxSource({
    config: { wechatDbInboxCursorFile: path.join(ROOT, "tmp", `upgrade-poll-cursor-${Date.now()}.json`) },
    worker,
    chats: [TALKER],
    // A fresh cursor's first poll is a baseline and delivers nothing; replay is
    // the production way out of that.
    replayOnStart: true,
    replayLimit: 40,
    imageUpgrade: opener,
    imageUpgradeWaitMs: config.wechatDbImageUpgradeWaitMs,
    imageUpgradeCooldownMs: 0,
    onMessage: async (message) => {
      delivered.push({
        localId: message.localId,
        kind: message.kind,
        quality: message.imageQuality,
        size: message.imageSize,
        source: message.imageSource,
        text: String(message.text || "").slice(0, 90),
        attachment: message.attachments?.[0]?.path || "",
      });
      return true;
    },
    logger: console,
  });

  const started = Date.now();
  const result = await source.pollOnce();
  log(`pollOnce -> ${JSON.stringify(result)} in ${Date.now() - started}ms`);

  const mine = delivered.filter((message) => String(message.localId) === String(target.localId));
  const imageMessages = delivered.filter((message) => message.kind === "image");
  log(`delivered ${delivered.length} message(s), ${imageMessages.length} of them pictures`);
  for (const message of imageMessages) {
    const hit = String(message.localId) === String(target.localId) ? " <<< the one under test" : "";
    log(`  image localId=${message.localId} quality=${message.quality} size=${message.size}${hit}`);
    if (message.text) log(`    text: ${message.text}`);
    if (message.attachment) log(`    file: ${message.attachment}`);
  }
  if (!mine.length) {
    log(`(localId=${target.localId} was not delivered in this poll; `
      + `${delivered.length} other message(s) were - narrow historyLimit or pick a newer picture)`);
  }
  log(`stats: imageUpgrades=${source.stats.imageUpgrades} imageUpgraded=${source.stats.imageUpgraded} `
    + `original=${source.stats.imageOriginal} fallback=${source.stats.imageFallback} `
    + `thumbnail=${source.stats.imageThumbnail} missing=${source.stats.imageMissing}`);
  restore();
  await worker.stop();
  process.exit(0);
})().catch((error) => {
  console.error("probe failed:", error.stack || error.message);
  process.exit(1);
});
