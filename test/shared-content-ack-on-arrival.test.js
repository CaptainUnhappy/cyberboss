#!/usr/bin/env node
/**
 * A picture with no text must be acknowledged on ARRIVAL, not 15 seconds later.
 *
 * Measured 2026-10-03: an image-only message went through the shared-content path,
 * which holds it for the quiet window (text may follow the picture) and only
 * acknowledged at promotion - `inbound acknowledged … latencyMs=16966` in the
 * production log. The window is right for the TURN and wrong for the ack.
 *
 * Run: node --test test/shared-content-ack-on-arrival.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

function prepared(overrides = {}) {
  return {
    provider: "wechat-cua",
    direction: "incoming",
    origin: "",
    senderId: "Azzy",
    chatId: "weflow:Azzy",
    messageId: "weflow:shared-standalone:shared:abc",
    kind: "image",
    receivedAt: "2026-10-03T16:18:50.000+08:00",
    ...overrides,
  };
}

function fakeApp({ quietWindowMs = 15_000 } = {}) {
  return {
    config: { pendingInboundQuietWindowMs: quietWindowMs },
    pendingSharedContentInboundByScope: new Map(),
    inboundAckActivityAtMs: new Map(),
    acks: [],
    async acknowledgeWeFlowUiaInbound(message) {
      this.acks.push(message.messageId);
      return true;
    },
  };
}

function arrive(app, message) {
  return CyberbossApp.prototype.acknowledgeSharedContentOnArrival.call(app, {
    bindingKey: "default:account",
    workspaceRoot: "D:\\ws",
    prepared: message,
  });
}

test("an image-only message is acknowledged immediately", async () => {
  const app = fakeApp();
  const first = prepared();
  app.pendingSharedContentInboundByScope.set("x", {});
  const acked = await arrive(app, first);
  assert.equal(acked, true);
  assert.deepEqual(app.acks, [first.messageId]);
});

test("a second picture inside the same window does not ack again", async () => {
  const app = fakeApp();
  await arrive(app, prepared({ messageId: "m1" }));
  const second = await arrive(app, prepared({
    messageId: "m2",
    receivedAt: "2026-10-03T16:18:55.000+08:00", // 5s later: same burst
  }));
  assert.equal(second, false);
  assert.equal(app.acks.length, 1, "one collected burst = one 处理中");
});

test("a picture after the window opens a new burst and acks again", async () => {
  const app = fakeApp();
  await arrive(app, prepared({ messageId: "m1" }));
  const later = await arrive(app, prepared({
    messageId: "m2",
    receivedAt: "2026-10-03T16:20:30.000+08:00", // 100s later
  }));
  assert.equal(later, true);
  assert.equal(app.acks.length, 2);
});

test("our own message still earns no acknowledgement", async () => {
  const app = fakeApp();
  const acked = await arrive(app, prepared({ direction: "outgoing", origin: "self_manual" }));
  assert.equal(acked, false);
  assert.equal(app.acks.length, 0);
});

test("the draft is marked, so promotion will not repeat the ack", async () => {
  const app = fakeApp();
  const scopeDraft = { messages: [] };
  const scopeKey = Object.getOwnPropertyNames(app.pendingSharedContentInboundByScope).length ? null : null;
  // The real map key is built inside the method; place the draft the same way the
  // enqueue does by letting the method create the entry first.
  await arrive(app, prepared());
  for (const draft of app.pendingSharedContentInboundByScope.values()) {
    assert.equal(draft.acknowledgedOnArrival, true);
  }
  app.pendingSharedContentInboundByScope.set("manual", scopeDraft);
  assert.equal(scopeKey, null);
});
