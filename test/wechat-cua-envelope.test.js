#!/usr/bin/env node
/**
 * Regression test: the CUA inbox envelope must survive the REAL pending-inbound
 * store.
 *
 * Background: `PendingInboundStore.normalizeMessage` drops any inbound without a
 * pendingId/messageId, a senderId, a provider, or with un-clonable array fields -
 * and its caller only logs a warning and continues. So an incomplete envelope
 * means real messages are lost silently.
 *
 * That is exactly what happened: the first version of WeChatCuaInboxSource handed
 * over `{id, localId, talker, text, direction, ...}` with no `senderId`, and
 * feeding that shape to the real store answered `invalid pending inbound message`.
 *
 * This test does not re-implement the validation - it calls the production class,
 * because a hand-written checker would drift from the thing it is checking.
 *
 * Run: node test/wechat-cua-envelope.test.js
 */

const assert = require("assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { WeChatCuaInboxSource } = require("../src/integrations/wechat-cua/inbox");
const { CuaSession } = require("../src/integrations/wechat-cua/client");
const { PendingInboundStore } = require("../src/core/pending-inbound-store");

const TARGET = { pid: 1, window_id: 2 };
const CHAT = "文件传输助手";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-envelope-"));
  return new PendingInboundStore({ filePath: path.join(dir, "pending-inbound.json") });
}

/** Capture exactly what the source would hand to the pipeline. */
async function captureEnvelope() {
  const session = new CuaSession("test");
  let call = 0;
  session.snapshot = () => {
    call += 1;
    const label = call === 1 ? `${CHAT}\nhi\n13:00\n` : `${CHAT}\n在吗\n13:01\n`;
    return { elements: [{ role: "ListItem", label, element_token: "r", element_index: 1, frame: { y: 90, w: 300, h: 78 } }] };
  };
  let captured = null;
  const source = new WeChatCuaInboxSource({
    config: { wechatCuaAllowPeers: CHAT },
    session,
    target: TARGET,
    onMessage: (message) => {
      captured = message;
      return true;
    },
    logger: { log() {}, warn() {} },
  });
  await source.start();
  source.stop();
  await source.pollOnce();
  return captured;
}

async function main() {
  const envelope = await captureEnvelope();
  assert.ok(envelope, "the source must produce a message for a changed row");

  // The identifiers the store's own whitelist demands.
  for (const key of ["messageId", "pendingId", "senderId", "provider"]) {
    assert.ok(envelope[key], `the envelope must carry ${key} (the store drops the message without it)`);
  }
  assert.strictEqual(envelope.provider, "wechat-cua");
  assert.strictEqual(envelope.chatId, `weflow:${CHAT}`, "the outbound route resolves chatId");
  assert.ok(Array.isArray(envelope.quotedContexts));
  assert.ok(Array.isArray(envelope.attachments));
  assert.ok(Array.isArray(envelope.attachmentFailures));

  // The decisive check: the production store accepts it.
  const store = tmpStore();
  const queued = store.enqueue({ bindingKey: "default:acct:wxid_x", workspaceRoot: "C:/tmp/ws", message: envelope });
  console.log("ok   the CUA inbox envelope is accepted by the real pending-inbound store");

  // Accepted is not enough: the record must still answer "did the user send this?"
  // after it has been through the queue, or the direction was computed for nothing.
  assert.strictEqual(queued.message.direction, envelope.direction, "direction must survive the queue");
  assert.strictEqual(
    queued.message.directionVerified, envelope.directionVerified,
    "so must whether the direction was actually read off the screen"
  );
  assert.ok(
    ["incoming", "outgoing"].includes(queued.message.direction),
    `the record must say who sent it, got ${JSON.stringify(queued.message.direction)}`
  );
  console.log("ok   the queued record still says who sent the message, and how sure we are");

  // And the old, incomplete shape is still rejected - so this test would catch a
  // regression rather than pass for the wrong reason.
  const legacy = { id: "x", localId: "", talker: CHAT, text: "hi", direction: "incoming", contentKind: "text", kind: "text", timestamp: 1, receivedAt: new Date().toISOString() };
  assert.throws(
    () => tmpStore().enqueue({ bindingKey: "default:acct:wxid_x", workspaceRoot: "C:/tmp/ws", message: legacy }),
    /invalid pending inbound message/,
    "the pre-fix shape must still be rejected, otherwise this test proves nothing",
  );
  console.log("ok   the pre-fix shape is still rejected (the test can actually fail)");
  console.log("all envelope tests passed");
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
