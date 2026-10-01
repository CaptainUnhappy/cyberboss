#!/usr/bin/env node
"use strict";

/**
 * Post-repair verification: send a restart notice to 大号 through the reserved
 * `test-session` window and wait for the bot to answer with the unique marker.
 *
 * Why this shape:
 *  - The trigger is a `[test]`-marked message dropped into the target conversation
 *    through the UIA bridge, so it has no ledger entry and Cyberboss reads it as a
 *    same-account manual message. The marker routes the turn into the reserved
 *    `test-session` conversation (src/core/app.js TEST_SESSION_KEY), which keeps a
 *    drill out of the real window's context.
 *  - The bot's answer has to come back through the whole pipeline (inbound ->
 *    turn -> outbound -> WeChat), so a marker seen in the WeFlow reader proves the
 *    service works end to end, and 大号 sees the restart notice at the same time.
 *
 * Usage:
 *   node scripts/repair-verify.js [--text "..."] [--timeout-seconds 300]
 *
 * Exit code 0 only when the marker came back.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("node:os");

const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(PROJECT_ROOT, ".env") });

const STATE_DIR = process.env.CYBERBOSS_REPAIR_STATE_DIR || path.join(os.homedir(), ".cyberboss", "repair");
const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

function normalizeBaseUrl(value, label) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArgs(argv) {
  const args = { text: "", timeoutMs: DEFAULT_TIMEOUT_MS, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--text") args.text = argv[++index] || "";
    else if (argv[index] === "--timeout-seconds") args.timeoutMs = Math.max(30, Number(argv[++index]) || 300) * 1000;
    else if (argv[index] === "--force") args.force = true;
  }
  return args;
}

/**
 * Every run drops a user-visible notice into 大号's chat, so runs are throttled.
 *
 * Measured 2026-09-22: the repair worker re-ran this after each repair attempt while
 * the underlying fault persisted, and the user received a stream of restart
 * notices. One notice per cooldown proves delivery; `--force` is for a human who
 * explicitly wants another round trip.
 */
const VERIFY_COOLDOWN_MS = 30 * 60_000;

function newestVerifyReportMs() {
  try {
    const names = fs.readdirSync(STATE_DIR).filter((name) => name.startsWith("verify-") && name.endsWith(".json"));
    let newest = 0;
    for (const name of names) {
      const stamp = Date.parse(
        name.slice("verify-".length, -".json".length).replace(
          /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
          "$1T$2:$3:$4.$5Z",
        ),
      );
      if (Number.isFinite(stamp) && stamp > newest) newest = stamp;
    }
    return newest;
  } catch {
    return 0;
  }
}

async function postJson(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function getMessages(baseUrl, token, talker, timeoutMs) {
  const now = Math.floor(Date.now() / 1000);
  const url = `${baseUrl}/api/v1/messages?talker=${encodeURIComponent(talker)}&limit=50&start=${now - 900}&end=${now}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`messages HTTP ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload?.messages) ? payload.messages : [];
  } finally {
    clearTimeout(timer);
  }
}

function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (typeof message.text === "string") return message.text;
  return "";
}

// The reader answers with the raw WeChat row schema, where "this account sent
// it" is `isSend` (1) and there is no `direction` field at all. Accept the
// normalized `direction: "outgoing"` shape too, so this stays correct for either
// reader. Checking only `direction` made every successful round trip look like a
// timeout: the reply was in the chat, the poll simply skipped it.
function isOutgoingMessage(message) {
  if (!message) return false;
  const flag = message.isSend ?? message.is_send;
  if (flag === true || flag === 1 || flag === "1") return true;
  return String(message.direction || "").trim().toLowerCase() === "outgoing";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // Throttle before anything visible happens: this script's whole point is to put a
  // message in front of the user, and a repair loop must not turn that into spam.
  if (!args.force) {
    const previous = newestVerifyReportMs();
    if (previous && Date.now() - previous < VERIFY_COOLDOWN_MS) {
      const waitedMinutes = Math.round((Date.now() - previous) / 60_000);
      console.log(
        JSON.stringify({
          ok: false,
          skipped: true,
          reason: "verify_cooldown",
          detail: `last verification was ${waitedMinutes} minute(s) ago; pass --force to send another notice`,
        }),
      );
      return 2;
    }
  }
  const bridgeBaseUrl = normalizeBaseUrl(process.env.CYBERBOSS_WEFLOW_BRIDGE_BASE_URL, "CYBERBOSS_WEFLOW_BRIDGE_BASE_URL");
  const weflowBaseUrl = normalizeBaseUrl(process.env.CYBERBOSS_WEFLOW_BASE_URL, "CYBERBOSS_WEFLOW_BASE_URL");
  const token = requiredEnv("CYBERBOSS_WEFLOW_TOKEN");
  const talker = requiredEnv("CYBERBOSS_WEFLOW_INBOX_CHAT");
  const contact = requiredEnv("CYBERBOSS_WEFLOW_INBOX_DISPLAY_NAME");

  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${crypto.randomBytes(3).toString("hex")}`;
  const marker = `REPAIR_OK_${runId}`;
  const text = args.text
    || `[test] 服务已重启完成，这是一条验证消息 ${runId}。请简短回复，并原样包含标记：${marker}`;

  const result = { runId, marker, talker, contact, bridgeBaseUrl, weflowBaseUrl, dispatched: false, replySeen: false, ok: false };
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const send = await postJson(`${bridgeBaseUrl}/api/send`, { contact, talker, text, timeout: 120 }, 150_000);
  result.sendStatus = send.status;
  result.sendBody = send.body;
  if (send.status !== 200 || send.body?.dispatched !== true) {
    result.detail = `bridge refused the trigger (HTTP ${send.status})`;
    result.verify = send.body;
  } else {
    result.dispatched = true;
    // The trigger is itself an outgoing row from the same account, and its text
    // contains the marker (we ask the bot to echo it). So "an outgoing row that
    // contains the marker" also matches the trigger: a poll that accepts that
    // reports success before the bot has answered anything. The answer must be a
    // *later* row than the one we just sent, and never the trigger text itself.
    const triggerLocalId = Number.parseInt(String(send.body?.localId ?? ""), 10);
    const triggerText = text.trim();
    result.triggerLocalId = send.body?.localId ?? "";
    const isRepairReply = (message) => {
      if (!isOutgoingMessage(message)) return false;
      const body = messageText(message);
      if (!body.includes(marker) || body.trim() === triggerText) return false;
      const localId = Number.parseInt(String(message.localId ?? ""), 10);
      if (Number.isFinite(triggerLocalId) && Number.isFinite(localId)) {
        return localId > triggerLocalId;
      }
      return true;
    };
    const deadline = Date.now() + args.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      let messages = [];
      try {
        messages = await getMessages(weflowBaseUrl, token, talker, 15_000);
      } catch (error) {
        result.detail = `reader error: ${error.message}`;
        continue;
      }
      const hit = messages.find(isRepairReply);
      if (hit) {
        result.replySeen = true;
        result.ok = true;
        result.reply = messageText(hit).slice(0, 500);
        result.replyLocalId = hit.localId ?? "";
        result.replyAt = hit.timestamp || "";
        break;
      }
    }
    if (!result.ok) result.detail = result.detail || `no reply containing ${marker} within ${Math.round(args.timeoutMs / 1000)}s`;
  }

  const reportPath = path.join(STATE_DIR, `verify-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.appendFileSync(
    path.join(STATE_DIR, "verify.log"),
    `[${new Date().toISOString()}] ok=${result.ok} dispatched=${result.dispatched} detail=${result.detail || ""}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ ...result, report: reportPath }, null, 2));
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  },
);
