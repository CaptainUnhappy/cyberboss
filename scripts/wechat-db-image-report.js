#!/usr/bin/env node
/**
 * Reader-level image report: for every image row in a chat, what did the reader
 * put on disk, how many pixels, and from which variant?
 *
 * This is the "did the bot actually get the ORIGINAL?" answer, without reading
 * the filesystem by hand and without a live turn.
 *
 * usage: node scripts/wechat-db-image-report.js [talker1,talker2,...]
 */
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

const { readConfig } = require(path.join(ROOT, "src", "core", "config"));
const { WechatDbWorker } = require(path.join(ROOT, "src", "integrations", "wechat-db", "worker"));

const CHATS = (process.argv[2] || "").split(",").filter(Boolean);

(async () => {
  const config = readConfig();
  const chats = CHATS.length ? CHATS : (config.wechatDbInboxChats || []);
  const worker = new WechatDbWorker({
    pythonCommand: config.wechatDbPythonCommand,
    scriptPath: config.wechatDbReaderScript,
    env: {
      CYBERBOSS_WECHAT_DB_KEY: config.wechatDbKey,
      CYBERBOSS_WECHAT_DB_DIR: config.wechatDbDataDir,
      CYBERBOSS_WECHAT_DB_WXID: config.wechatDbWxid,
      CYBERBOSS_WECHAT_DB_CACHE_DIR: config.wechatDbCacheDir,
      CYBERBOSS_STATE_DIR: config.stateDir,
    },
  });
  const started = Date.now();
  const payload = await worker.snapshots({ chats, limit: config.wechatDbInboxHistoryLimit || 50 });
  console.log(`read ${chats.length} chat(s) in ${Date.now() - started}ms`);
  const tally = { original: 0, fallback: 0, thumbnail: 0, missing: 0 };
  for (const snapshot of payload.chats || []) {
    const images = (snapshot.messages || []).filter((message) => message.kind === "image");
    console.log(`\n== ${snapshot.displayName || snapshot.talker} (${snapshot.talker}) images=${images.length}`);
    for (const message of images.slice(-8)) {
      const quality = message.imageQuality || "missing";
      tally[quality] = (tally[quality] || 0) + 1;
      const file = message.attachments?.[0]?.path || "(no file)";
      console.log(`   localId=${String(message.localId).padEnd(6)} ${String(quality).padEnd(9)} `
        + `${String(message.imageSize || "-").padEnd(11)} ${message.imageSource || "-"}`);
      if (message.text) console.log(`      text: ${message.text.slice(0, 100)}`);
      if (quality !== "original") console.log(`      file: ${file}`);
    }
  }
  for (const failure of payload.failures || []) console.log(`FAILURE ${failure}`);
  try {
    const stats = await worker.request({ cmd: "stats" });
    console.log(`\nreader media stats: ${JSON.stringify(stats.media)} waitMs=${stats.imageWaitMs}`);
  } catch (error) {
    console.log(`\n(no reader stats: ${error.message})`);
  }
  console.log(`\ntally: ${JSON.stringify(tally)}`);
  await worker.stop();
  process.exit(0);
})().catch((error) => {
  console.error("report failed:", error.stack || error.message);
  process.exit(1);
});
