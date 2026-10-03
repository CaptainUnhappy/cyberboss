#!/usr/bin/env node
/**
 * Live smoke: config -> worker -> reader -> inbox source, against the real account.
 *
 * Nothing is sent and nothing is answered; this only proves the chain reads the
 * account's real conversations and would hand them to the app.
 *
 * usage: node scripts/wechat-db-read-probe.js [db-key] [chats]
 */
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

process.env.CYBERBOSS_ENABLE_WECHAT_DB_INBOX = "true";
process.env.CYBERBOSS_WECHAT_DB_KEY = process.argv[2] || process.env.CYBERBOSS_WECHAT_DB_KEY || "";
process.env.CYBERBOSS_WECHAT_DB_DIR = process.env.CYBERBOSS_WECHAT_DB_DIR || "D:\\xwechat_files";
if (process.argv[3]) {
  process.env.CYBERBOSS_WECHAT_DB_INBOX_CHATS = process.argv[3];
}

const { readConfig } = require(path.join(ROOT, "src", "core", "config"));
const { WechatDbWorker } = require(path.join(ROOT, "src", "integrations", "wechat-db", "worker"));
const { WechatDbInboxSource } = require(path.join(ROOT, "src", "integrations", "wechat-db", "inbox"));

const config = readConfig();
console.log("enabled      :", config.wechatDbInboxEnabled);
console.log("chats        :", JSON.stringify(config.wechatDbInboxChats));
console.log("dataDir      :", config.wechatDbDataDir, "wxid:", config.wechatDbWxid);
console.log("key          :", config.wechatDbKey ? `${config.wechatDbKey.slice(0, 8)}… len=${config.wechatDbKey.length}` : "(missing)");

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

(async () => {
  const delivered = [];
  const source = new WechatDbInboxSource({
    config,
    worker,
    chats: config.wechatDbInboxChats,
    pollIntervalMs: config.wechatDbInboxPollMs,
    historyLimit: config.wechatDbInboxHistoryLimit,
    ledger: require(path.join(ROOT, "src", "integrations", "wechat-cua", "outbound")).sharedLedger,
    onMessage: async (message, snapshot) => { delivered.push({ message, snapshot }); return true; },
  });

  const t0 = Date.now();
  console.log("\n-- baseline poll --");
  console.log(JSON.stringify(await source.pollOnce()), `${Date.now() - t0}ms`);
  const t1 = Date.now();
  console.log("-- second poll --");
  console.log(JSON.stringify(await source.pollOnce()), `${Date.now() - t1}ms`);

  // What the reader actually sees, so "the bot would have answered X" is checkable.
  const raw = await worker.snapshots({ chats: config.wechatDbInboxChats, limit: 6 });
  for (const snapshot of raw.chats || []) {
    console.log(`\n${snapshot.displayName} (${snapshot.talker}) unread=${snapshot.unread}`);
    for (const message of snapshot.messages) {
      console.log(`  [${message.direction === "outgoing" ? "me" : "peer"}] ${JSON.stringify(message.text).slice(0, 90)}`);
    }
  }
  console.log("\ndelivered during smoke:", delivered.length);
  console.log("source:", JSON.stringify(source.describe()));
  await source.stop();
  console.log("worker stop:", JSON.stringify(await worker.stop()));
  fs.writeFileSync(path.join(ROOT, "tmp", "wxdb-live.json"), JSON.stringify({ delivered, raw }, null, 2), "utf8");
  process.exit(0);
})().catch(async (error) => {
  console.error("smoke failed:", error.stack || error.message);
  try { await worker.stop(); } catch { /* ignore */ }
  process.exit(1);
});
