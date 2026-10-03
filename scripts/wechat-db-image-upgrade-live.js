#!/usr/bin/env node
/**
 * Live check of the image-upgrade loop against the real client and the real reader.
 *
 * The genuine trigger - a peer sends a picture whose original WeChat has not
 * downloaded - cannot be produced from this machine (only the peer's device can),
 * so this probe forces the CONDITION (one message is declared a preview) and then
 * runs the real code path: open the conversation through Cua, wait, read the
 * database again, and report what quality came back.
 *
 * usage: node scripts/wechat-db-image-upgrade-live.js [talker] [index]
 */
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

const { readConfig } = require(path.join(ROOT, "src", "core", "config"));
const { WechatDbWorker } = require(path.join(ROOT, "src", "integrations", "wechat-db", "worker"));
const { WechatDbInboxSource } = require(path.join(ROOT, "src", "integrations", "wechat-db", "inbox"));
const { CuaSession, findWeChatWindow, ensureConversation } = require(path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

const TALKER = process.argv[2] || "wxid_ubo0cy5xh4px22";

(async () => {
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
  const payload = await worker.snapshots({ chats: [TALKER], limit: 50 });
  const snapshot = (payload.chats || [])[0];
  if (!snapshot) {
    throw new Error(`no snapshot for ${TALKER}`);
  }
  const images = (snapshot.messages || []).filter((message) => message.kind === "image");
  if (!images.length) {
    throw new Error(`no image message in ${TALKER}`);
  }
  const target = images[images.length - 1];
  console.log(`talker=${TALKER} chat=${snapshot.displayName} images=${images.length}`);
  console.log(`target message localId=${target.localId} quality=${target.imageQuality} `
    + `attachment=${target.attachments?.[0]?.path || "(none)"}`);

  const session = new CuaSession(`wxdb-upgrade-live-${process.pid}`);
  const window = findWeChatWindow(session);
  const opener = (peer) => {
    const started = Date.now();
    try {
      ensureConversation(session, window, peer);
    } catch (error) {
      // Same recovery as the production opener: a minimized client refuses the
      // click, and SW_SHOWNOACTIVATE restores it without stealing the foreground.
      if (!/minimized/i.test(String(error?.message || ""))) {
        throw error;
      }
      const restored = session.restoreMinimized(window.pid);
      console.log(`restored minimized window: ${JSON.stringify(restored)}`);
      ensureConversation(session, window, peer);
    }
    console.log(`opened ${peer} in ${Date.now() - started}ms`);
    return true;
  };

  const source = new WechatDbInboxSource({
    config,
    worker,
    chats: [TALKER],
    imageUpgrade: opener,
    imageUpgradeWaitMs: config.wechatDbImageUpgradeWaitMs,
    imageUpgradeCooldownMs: 0,
    onMessage: async () => true,
    logger: console,
  });

  // Force the condition: pretend this message arrived as a preview.
  const doctored = {
    ...snapshot,
    messages: snapshot.messages.map((message) => (
      message.id === target.id ? { ...message, imageQuality: "thumbnail" } : message
    )),
  };

  const started = Date.now();
  const [result] = await source.upgradeThumbnailImages([doctored]);
  const after = (result.messages || []).find((message) => message.id === target.id);
  console.log(`\nupgrade pass took ${Date.now() - started}ms`);
  console.log(`quality after : ${after.imageQuality}`);
  console.log(`attachment    : ${after.attachments?.[0]?.path || "(none)"}`);
  console.log(`stats         : upgrades=${source.stats.imageUpgrades} upgraded=${source.stats.imageUpgraded}`);
  console.log(after.imageQuality === "original"
    ? "RESULT: the loop fetched/returned the ORIGINAL"
    : "RESULT: still a preview (the client had nothing better)");
  await worker.stop();
  process.exit(0);
})().catch(async (error) => {
  console.error("probe failed:", error.stack || error.message);
  process.exit(1);
});
