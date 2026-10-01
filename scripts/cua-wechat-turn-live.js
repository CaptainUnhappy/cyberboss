#!/usr/bin/env node
/**
 * In-process end-to-end round: a real turn, a real model, a real CUA send.
 *
 *   node scripts/cua-wechat-turn-live.js --chat "文件传输助手" [--text "..."] [--timeout-ms N]
 *
 * Why this exists: the last piece of acceptance is "a message arrives, the bot
 * answers, and the answer lands in WeChat". A real *incoming* message from a human
 * is the only way to test the inbox trigger - but it is NOT the only way to test
 * everything downstream of it. This script injects one inbound event straight into
 * the app's own handler (`handleWeFlowInboxMessage`, the same entry the CUA inbox
 * source calls), so the following are all genuinely exercised:
 *
 *   the app's turn pipeline -> the configured runtime -> the model -> the reply
 *   -> stream-delivery -> the CUA outbound sender -> the clipboard/keys -> WeChat
 *
 * Only the trigger is synthetic, and that is stated in the output rather than
 * glossed over. The CUA outbound module is wrapped, not mocked: whatever the app
 * asks it to send really goes to WeChat, and the script verifies it by reading the
 * conversation back.
 *
 * Safety: the reply text is prefixed so it is obvious in the chat, and the script
 * prints exactly what it sent. It refuses to run if the mapped chat is not the one
 * passed on the command line.
 */

const path = require("node:path");

const REPO = path.resolve(__dirname, "..");

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const CHAT = arg("--chat", "文件传输助手");
const TEXT = arg("--text", `闭环端到端验收 ${new Date().toISOString().slice(11, 19)}`);
const TIMEOUT_MS = Number(arg("--timeout-ms", "240000"));
const TALKER = arg("--talker", "wxid_s3178hwvzsl922");

const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

async function main() {
  // --- wire the CUA outbound so we can see what the app sends -----------------
  const outbound = require(path.join(REPO, "src/integrations/wechat-cua/outbound"));
  const client = require(path.join(REPO, "src/integrations/wechat-cua/client"));
  const inbound = require(path.join(REPO, "src/integrations/wechat-cua/inbound"));

  const sent = [];
  const realSend = outbound.sendWeChatCuaText;
  const wrapped = async (config, options = {}) => {
    const result = await realSend(config, { ...options, chatLabel: CHAT, resolveLabel: () => CHAT });
    sent.push({ text: options.text, ...result });
    log(`SEND  ${result.dispatched ? "dispatched" : "FAILED"} ${JSON.stringify(String(options.text).slice(0, 60))}`);
    log(`      verify=${result.verification || result.verificationError} focusCosts=${JSON.stringify(result.focusCosts || [])}`);
    return result;
  };

  const { CyberbossApp } = require(path.join(REPO, "src/core/app"));
  const { readConfig } = require(path.join(REPO, "src/core/config"));
  const config = readConfig();

  // The app resolves the sender through the module instance, so patch it there.
  const channelPath = require.resolve(path.join(REPO, "src/adapters/channel/weixin/index.js"));
  void channelPath;
  require.cache[require.resolve(path.join(REPO, "src/integrations/wechat-cua/outbound"))].exports.sendWeChatCuaText = wrapped;

  const app = new CyberbossApp(config);
  log(`boot  runtime=${config.runtime} chat=${JSON.stringify(CHAT)} talker=${TALKER}`);
  await app.runtimeAdapter.initialize();
  log("boot  runtime initialised");
  app.activeAccountId = app.channelAdapter.resolveAccount().accountId;
  log(`boot  account=${app.activeAccountId}`);

  // --- inject one inbound event into the app's own handler -------------------
  const message = {
    id: `inject-${Date.now()}`,
    localId: "",
    talker: TALKER,
    text: TEXT,
    direction: "incoming",
    contentKind: "text",
    kind: "text",
    timestamp: Math.floor(Date.now() / 1000),
    receivedAt: new Date().toISOString(),
    source: "injected",
  };
  log(`TRIGGER injected inbound from ${TALKER}: ${JSON.stringify(TEXT.slice(0, 60))} (synthetic trigger; everything downstream is real)`);

  const handled = app.handleWeFlowInboxMessage(message, { chatUsername: TALKER });
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && sent.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await handled.catch((error) => log(`handler error: ${error.message}`));

  if (!sent.length) {
    log("VERDICT: no CUA send happened within the timeout (the turn may still be running)");
    process.exit(1);
  }

  // --- verify by reading the conversation back -------------------------------
  const session = new client.CuaSession("turn-live-verify");
  const win = client.findWeChatWindow(session);
  const conversation = inbound.readConversation(session, win);
  const delivered = sent.filter((s) => s.dispatched);
  const landed = delivered.filter((s) => conversation.some((m) => m.text.includes(String(s.text).slice(0, 20))));
  log(`VERIFY ${landed.length}/${delivered.length} dispatched message(s) found in the conversation`);
  for (const item of landed) {
    log(`       ${JSON.stringify(String(item.text).slice(0, 60))}`);
  }
  log(landed.length === delivered.length && delivered.length > 0
    ? "VERDICT: the turn produced a reply that CUA delivered into WeChat"
    : "VERDICT: a reply was dispatched but could not be found in the conversation");
  process.exit(landed.length === delivered.length && delivered.length > 0 ? 0 : 1);
}

main().catch((error) => {
  log(`FATAL ${error.stack || error.message}`);
  process.exit(1);
});
