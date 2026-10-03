#!/usr/bin/env node
/**
 * One picture, end to end: send a REAL image into a chat through the clipboard
 * (the human route), then follow the same md5 through the database row, the
 * reader's decision, the file on disk, and the production log.
 *
 * Why a script and not a paragraph: "did the bot get the ORIGINAL picture?" is
 * the question the operator asked on 2026-10-03 and every earlier answer was
 * assembled by hand from three different places. This prints the whole chain in
 * one timeline, with the pixels in it.
 *
 * usage: node scripts/wechat-db-image-e2e.js [imagePath] [chatLabel] [--seconds 60]
 *
 * The two parameters are POSITIONAL: PowerShell ate the value of `--image <path>`
 * (the script silently fell back to its default and sent a different picture than
 * the one under test, which is worse than an error). Same lesson as
 * `wechat-db-image-upgrade-poll-probe.js`.
 *
 * Steps: send -> read the row (real worker) -> report quality/size/source -> tail
 * the production log for the `inbox image` line that matches the same picture.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
require(path.join(ROOT, "node_modules", "dotenv")).config({ path: path.join(ROOT, ".env") });

const ARGS = [];
const FLAGS = [];
for (const arg of process.argv.slice(2)) {
  // `--seconds 40` and `--seconds=40` both work; Windows argument handling has
  // dropped the separated value of these flags more than once in this repo.
  const match = /^(--[a-z-]+)=(.*)$/.exec(arg);
  if (match) {
    FLAGS.push(match[1], match[2]);
  } else if (arg.startsWith("--")) {
    FLAGS.push(arg);
  } else {
    ARGS.push(arg);
  }
}
const flagValue = (name, fallback) => {
  const index = FLAGS.indexOf(name);
  const inline = FLAGS.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || fallback;
  return index >= 0 && FLAGS[index + 1] && !FLAGS[index + 1].startsWith("--")
    ? FLAGS[index + 1]
    : fallback;
};
const IMAGE = ARGS[0] || path.join(ROOT, "tmp", "probe-images", "arrival-1600x1000.png");
const LABEL = ARGS[1] || "文件传输助手";
const TALKER = flagValue("--talker", LABEL === "文件传输助手" ? "filehelper" : LABEL);
const SECONDS = Number(flagValue("--seconds", 60));
const LOG = process.env.CYBERBOSS_PROD_LOG || path.join(ROOT, "tmp", "shared-prod.log");
const ACCOUNT = process.env.CYBERBOSS_WECHAT_DB_ACCOUNT_DIR
  || path.join(process.env.CYBERBOSS_WECHAT_DB_DIR || "D:\\xwechat_files", "wxid_ty69l7hjiqt012_f2b4");

const t0 = Date.now();
const log = (message) => console.log(`+${String(Date.now() - t0).padStart(6)}ms  ${message}`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const attachFolder = path.join(ACCOUNT, "msg", "attach", crypto.createHash("md5").update(TALKER).digest("hex"));

function catalog() {
  const found = new Map();
  if (!fs.existsSync(attachFolder)) return found;
  for (const month of fs.readdirSync(attachFolder)) {
    const dir = path.join(attachFolder, month, "Img");
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const base = name.replace(/_t\.dat$|_h\.dat$|\.dat$/, "");
      if (!/^[0-9a-f]{32}$/.test(base)) continue;
      if (!found.has(base)) found.set(base, []);
      found.get(base).push({ name, size: fs.statSync(path.join(dir, name)).size });
    }
  }
  return found;
}

function logTail(fromBytes) {
  if (!fs.existsSync(LOG)) return { lines: [], size: fromBytes };
  const size = fs.statSync(LOG).size;
  if (size <= fromBytes) return { lines: [], size: fromBytes };
  const fd = fs.openSync(LOG, "r");
  const buffer = Buffer.alloc(size - fromBytes);
  fs.readSync(fd, buffer, 0, buffer.length, fromBytes);
  fs.closeSync(fd);
  return { lines: buffer.toString("utf8").split(/\r?\n/).filter(Boolean), size };
}

(async () => {
  if (!fs.existsSync(IMAGE)) {
    console.error(`no such image: ${IMAGE}`);
    process.exit(1);
  }
  const { readConfig } = require(path.join(ROOT, "src", "core", "config"));
  const { WechatDbWorker } = require(path.join(ROOT, "src", "integrations", "wechat-db", "worker"));
  const { CuaSession, toTarget, findWeChatWindow, currentConversation, ensureConversation } = require(
    path.join(ROOT, "src", "integrations", "wechat-cua", "client"));

  const before = catalog();
  log(`image ${path.basename(IMAGE)} (${fs.statSync(IMAGE).size}B); ${before.size} known picture(s) in ${TALKER}`);

  // ── 1. send it the way a human does ──────────────────────────────────────────
  const session = new CuaSession(`image-e2e-${process.pid}`);
  const window = findWeChatWindow(session);
  const target = toTarget(window);
  if (currentConversation(session, target).label.trim() !== LABEL) {
    const opened = ensureConversation(session, target, LABEL, { settleMs: 1800 });
    log(`switched to ${LABEL} (route=${opened.route})`);
  }
  const clip = session.call("clipboard_write", { image_path: path.resolve(IMAGE) });
  if (clip?.__failed || clip?.supported === false) {
    console.error(`clipboard refused the image: ${JSON.stringify(clip).slice(0, 200)}`);
    process.exit(1);
  }
  session.call("hotkey", { ...target, keys: ["ctrl", "v"], delivery_mode: "foreground" });
  sleep(1500);
  const sent = session.call("press_key", { ...target, key: "return", delivery_mode: "foreground" });
  const sentAt = Date.now();
  log(`sent (refusal=${sent?.payload?.refusal?.code || "ok"})`);

  // ── 2. which md5 is it? ──────────────────────────────────────────────────────
  let md5 = "";
  const deadline = sentAt + SECONDS * 1000;
  while (Date.now() < deadline && !md5) {
    const now = catalog();
    for (const [key, files] of now) {
      if (!before.has(key) && files.some((file) => file.name.endsWith("_t.dat"))) md5 = key;
    }
    if (!md5) sleep(1000);
  }
  if (!md5) {
    console.error("the new picture never showed up in the attach folder");
    process.exit(1);
  }
  log(`arrived as md5=${md5} (+${Date.now() - sentAt}ms)`);

  // ── 3. what the reader makes of it ───────────────────────────────────────────
  const config = readConfig();
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
  const payload = await worker.snapshots({ chats: [TALKER], limit: 50 });
  const messages = ((payload.chats || [])[0]?.messages || [])
    .filter((message) => message.kind === "image")
    .filter((message) => String(message.imageSource || "").includes(md5)
      || String(message.attachments?.[0]?.path || "").includes(md5));
  const mine = messages[messages.length - 1];
  if (!mine) {
    console.error("the reader did not report that picture in its last 50 rows");
  } else {
    log(`reader: localId=${mine.localId} quality=${mine.imageQuality} size=${mine.imageSize} `
      + `source=${mine.imageSource}`);
    log(`        attachment=${mine.attachments?.[0]?.path || "(none)"}`);
    if (mine.text) log(`        text=${mine.text.slice(0, 100)}`);
    const file = mine.attachments?.[0]?.path;
    if (file && fs.existsSync(file)) log(`        on disk: ${fs.statSync(file).size}B`);
  }
  const stats = await worker.request({ cmd: "stats" });
  log(`reader media stats: ${JSON.stringify(stats.media)}`);
  await worker.stop();

  // ── 4. did production see it too? ────────────────────────────────────────────
  // The production poll runs every 800ms and this script spends seconds on the
  // reader, so the line it is looking for is usually ALREADY in the log by the
  // time we get here. Look back first, then keep tailing for anything newer.
  const early = [];
  if (fs.existsSync(LOG)) {
    for (const line of fs.readFileSync(LOG, "utf8").split(/\r?\n/)) {
      if (line.includes(md5) || /wechat-db inbox image/.test(line)) early.push(line.replace("[cyberboss] ", ""));
    }
  }
  if (early.length) {
    log(`production already logged ${early.length} image line(s) while this script was reading:`);
    for (const line of early.slice(-4)) console.log(`             ${line.slice(0, 170)}`);
  }
  log(`watching ${path.relative(ROOT, LOG)} for more (${SECONDS}s)…`);
  let offset = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
  const seen = [];
  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until) {
    const { lines, size } = logTail(offset);
    offset = size;
    for (const line of lines) {
      if (/wechat-db inbox image|image upgrade|inbox delivered/.test(line)) {
        seen.push(line.replace("[cyberboss] ", ""));
        console.log(`             ${seen[seen.length - 1].slice(0, 170)}`);
      }
      if (line.includes(md5)) console.log(`   *MATCH*   ${line.slice(0, 170)}`);
    }
    if (!lines.length) sleep(1000);
  }
  const all = [...early, ...seen];
  const match = all.find((line) => line.includes(md5))
    || all.find((line) => /wechat-db inbox image .*quality=/.test(line));
  console.log("");
  log(match
    ? `CONCLUSION: production reported "${match.slice(0, 140)}"`
    : "CONCLUSION: production logged no image line for this picture in the window");
  process.exit(0);
})().catch((error) => {
  console.error("e2e failed:", error.stack || error.message);
  process.exit(1);
});
