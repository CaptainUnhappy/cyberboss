#!/usr/bin/env node
/**
 * Offline tests for the identity a locally-read WeChat message travels under.
 *
 * These exist because of a real, measured failure: the CUA reply target was built
 * with an empty `userId`, that flowed into the envelope's `senderId`, and
 * `PendingInboundStore.normalizeMessage` drops any message without a senderId. The
 * only trace was one `warn` line - "invalid pending inbound message" - while the
 * user's message was never answered.
 *
 * So the rule under test is: an inbox envelope either has a real identity, or the
 * construction fails loudly here. "Empty senderId" is not a value, it is a bug.
 *
 * Run: node test/local-inbox-identity.test.js
 */

const assert = require("assert");

const { resolveLocalInboxIdentity, resolveReplyProvider } = require("../src/core/inbound-turn");

test_the_cua_path_uses_the_chat_display_name_as_identity();
test_the_official_channel_uses_the_reply_user_id();
test_a_missing_identity_is_an_error_not_an_empty_string();
test_the_envelope_it_builds_is_accepted_by_the_real_pending_store();
test_a_reply_is_answered_on_the_channel_the_message_came_from();

function test_a_reply_is_answered_on_the_channel_the_message_came_from() {
  // Measured 2026-10-01: the generic reply resolver answered EVERY binding with
  // "weixin", so a turn whose message arrived from this machine's own WeChat client
  // sent its reply to the iLink API with a display name as the recipient:
  // `sendMessage ret=-3 errmsg=invalid arguments`. The message was processed and
  // the answer was lost.
  assert.strictEqual(
    resolveReplyProvider({ senderId: "o9cq803f7eEyaiOaPX094zYZyws0@im.wechat", cuaEnabled: true }),
    "weixin",
    "an official channel id must still be answered by the official channel"
  );
  assert.strictEqual(
    resolveReplyProvider({ senderId: "文件传输助手", cuaEnabled: true }),
    "wechat-cua",
    "a display name came from a UIA reader, so the reply goes back the same way"
  );
  assert.strictEqual(
    resolveReplyProvider({ senderId: "wxid_ubo0cy5xh4px22", cuaEnabled: false }),
    "weflow-uia",
    "without CUA the local desktop path is still the bridge"
  );
  assert.strictEqual(resolveReplyProvider({ senderId: "", cuaEnabled: true }), "");
  console.log("ok   a reply is routed back over the channel its message arrived on");
}

function test_the_cua_path_uses_the_chat_display_name_as_identity() {
  // A UIA reader sees display names, never wxids. If this returns "" the message
  // is dropped three layers later with no useful trace.
  const identity = resolveLocalInboxIdentity({
    provider: "wechat-cua",
    chatUsername: "文件传输助手",
    replyUserId: "",
    messageId: "cua-abc123",
  });
  assert.strictEqual(identity.senderId, "文件传输助手");
  assert.strictEqual(identity.chatId, "weflow:文件传输助手");
  assert.strictEqual(identity.messageId, "weflow:cua-abc123");
  assert.strictEqual(identity.provider, "wechat-cua");
  console.log("ok   the CUA path identifies a chat by its display name");
}

function test_the_official_channel_uses_the_reply_user_id() {
  const identity = resolveLocalInboxIdentity({
    provider: "weixin",
    chatUsername: "wxid_ubo0cy5xh4px22",
    replyUserId: "o9cq803f7eEyaiOaPX094zYZyws0@im.wechat",
    messageId: "msg-1",
  });
  assert.strictEqual(identity.senderId, "o9cq803f7eEyaiOaPX094zYZyws0@im.wechat");
  console.log("ok   the official channel keeps addressing by user id");
}

function test_a_missing_identity_is_an_error_not_an_empty_string() {
  assert.throws(
    () => resolveLocalInboxIdentity({ provider: "wechat-cua", chatUsername: "", replyUserId: "" }),
    /no sender identity/,
    "an identity-less local message must fail where the reason is still visible"
  );
  assert.throws(
    () => resolveLocalInboxIdentity({ provider: "weixin", chatUsername: "x", replyUserId: "" }),
    /no sender identity/,
  );
  assert.throws(
    () => resolveLocalInboxIdentity({ chatUsername: "x", replyUserId: "y" }),
    /needs a provider/,
  );
  console.log("ok   a missing identity fails loudly instead of producing an empty senderId");
}

function test_the_envelope_it_builds_is_accepted_by_the_real_pending_store() {
  // The point is not this test's own assertions: it is that the REAL store is the
  // judge, so a future change to the required fields cannot pass unnoticed here.
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");
  const { PendingInboundStore } = require("../src/core/pending-inbound-store");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-identity-"));
  const store = new PendingInboundStore({ filePath: path.join(dir, "pending.json") });
  const identity = resolveLocalInboxIdentity({
    provider: "wechat-cua",
    chatUsername: "文件传输助手",
    replyUserId: "",
    messageId: "cua-e2e-1",
  });
  const result = store.enqueue({
    bindingKey: `binding:${identity.senderId}`,
    workspaceRoot: dir,
    message: {
      ...identity,
      pendingId: identity.messageId,
      text: "CUA-E2E-TEST",
      receivedAt: new Date().toISOString(),
      quotedContexts: [],
      attachments: [],
      attachmentFailures: [],
    },
  });
  assert.strictEqual(result.added, true, "the real store must accept the envelope this module builds");
  assert.strictEqual(result.message.senderId, "文件传输助手");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("ok   the envelope is accepted by the real pending-inbound store");
}
