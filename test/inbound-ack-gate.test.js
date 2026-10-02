#!/usr/bin/env node
/**
 * Who earns the immediate 处理中 acknowledgement.
 *
 * Two rules, both learned the hard way on 2026-10-02:
 *   - a desktop (personal-account) message from the peer does, because that channel can
 *     send into the conversation the message came from;
 *   - OUR OWN message never does. An outgoing row is this account's own bubble that the
 *     echo ledger did not attribute (the operator, or another signed-in device); the
 *     pipeline records it as `self_manual` and suppresses the reply, so acknowledging it
 *     only puts noise in the operator's own chat - measured live, a self-check message
 *     sent through the outbound path produced a 处理中 in the operator's chat.
 *
 * Run: node --test test/inbound-ack-gate.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { shouldAcknowledgeInbound } = require("../src/core/app");

test("a desktop message from the peer earns a 处理中", () => {
  assert.equal(shouldAcknowledgeInbound({ provider: "wechat-cua", direction: "incoming" }), true);
});

test("our own message never earns a 处理中", () => {
  assert.equal(shouldAcknowledgeInbound({ provider: "wechat-cua", direction: "outgoing" }), false);
  assert.equal(shouldAcknowledgeInbound({ provider: "wechat-cua", origin: "self_manual" }), false);
});

test("the official channel stays out of the acknowledgement mechanism", () => {
  assert.equal(shouldAcknowledgeInbound({ provider: "weixin", direction: "incoming" }), false);
});

test("an explicit suppression still wins", () => {
  assert.equal(shouldAcknowledgeInbound({ provider: "wechat-cua", direction: "incoming", suppressAcknowledgement: true }), false);
});
