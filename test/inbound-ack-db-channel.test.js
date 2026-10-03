#!/usr/bin/env node
/**
 * Does the database channel earn the immediate "处理中" acknowledgement?
 *
 * The acknowledgement has already been lost once by a channel migration: the gate
 * named the WeFlow UIA bridge, the channel moved to Cua, and the ack silently
 * stopped being sent at all. The DB reader is the third reader for the same
 * desktop client, so the gate is asserted directly here rather than assumed.
 *
 * Run: node --test test/inbound-ack-db-channel.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldAcknowledgeInbound } = require("../src/core/app");

function prepared(overrides = {}) {
  return {
    provider: "wechat-cua",
    direction: "incoming",
    origin: "",
    senderId: "柳毓琳",
    chatId: "weflow:柳毓琳",
    messageId: "weflow:shared-standalone:shared:abc",
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("an incoming message on the db channel is acknowledged", () => {
  // What the app actually dispatches: the reply route is rewritten to the CUA
  // writer, because that is what can put text into the chat.
  assert.equal(shouldAcknowledgeInbound(prepared()), true);
});

test("the db channel's own provider name is treated as a desktop provider", () => {
  assert.equal(shouldAcknowledgeInbound(prepared({ provider: "wechat-db" })), true,
    "a provider the gate does not recognise is how the ack disappeared last time");
});

test("our own message still earns no acknowledgement", () => {
  assert.equal(shouldAcknowledgeInbound(prepared({ direction: "outgoing" })), false);
  assert.equal(shouldAcknowledgeInbound(prepared({ origin: "self_manual", direction: "outgoing" })), false);
});

test("the official channel keeps its old behaviour", () => {
  assert.equal(shouldAcknowledgeInbound(prepared({ provider: "weixin" })), false);
  assert.equal(shouldAcknowledgeInbound(prepared({ provider: "weixin", deliveryPolicy: "silent" })), true);
});

test("an explicit suppression flag still wins", () => {
  assert.equal(shouldAcknowledgeInbound(prepared({ suppressAcknowledgement: true })), false);
});
