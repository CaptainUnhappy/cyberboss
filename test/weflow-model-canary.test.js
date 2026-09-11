const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { clonePreparedInboundMessage } = require("../src/core/inbound-turn");
const { PendingInboundStore } = require("../src/core/pending-inbound-store");
const { StreamDelivery } = require("../src/core/stream-delivery");
const { CyberbossApp } = require("../src/core/app");

const {
  MODEL_CANARY_DELIVERY_POLICY,
  MODEL_CANARY_EXECUTION_POLICY,
  MODEL_CANARY_PROMPT,
  WeFlowModelCanary,
  buildModelCanaryIdempotencyKey,
  buildModelCanaryMessageKind,
  buildModelCanaryReplyText,
  createModelCanaryDesktopInputLeaseReceipt,
  createModelCanaryManifest,
} = require("../src/integrations/weflow-model-canary");

const RUN_ID = "12345678-1234-4234-8234-123456789abc";
const NONCE = "0123456789abcdef01234567";
const TALKER = "wxid_fixture_self";
const CONTACT = "Azzy";
const NOW_MS = Date.parse("2026-08-29T06:00:00.000Z");

function createHarness(t, {
  enabled = true,
  onTrigger = async () => ({
    accepted: true,
    bindingKey: "binding-model",
    workspaceRoot: "D:/fixture-workspace",
    threadId: "thread-model",
    turnId: "turn-model",
  }),
  nowMs = NOW_MS,
  leaseReceiptWaitMs = 0,
} = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-model-canary-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const created = createModelCanaryManifest({
    stateDir,
    talker: TALKER,
    contact: CONTACT,
    demandKey: "explicit:user-demand:fixture",
    runId: RUN_ID,
    nonce: NONCE,
    nowMs: NOW_MS - 1_000,
  });
  const desktopInputLeaseReceipt = createModelCanaryDesktopInputLeaseReceipt(
    created.manifest,
    {
      version: 1,
      mode: "model_e2e",
      runId: created.manifest.runId,
      nonce: created.manifest.nonce,
      targetFingerprint: created.manifest.targetFingerprint,
      replyIdempotencyKey: created.manifest.replyIdempotencyKey,
      expiresAt: created.manifest.expiresAt,
      token: "a".repeat(64),
      lastInputTick: 77,
      issuedAt: created.manifest.createdAt,
    },
    { nowMs: Math.min(nowMs, Date.parse(created.manifest.expiresAt) - 1) },
  );
  fs.writeFileSync(
    path.join(created.runDir, "desktop-input-lease.json"),
    `${JSON.stringify(desktopInputLeaseReceipt, null, 2)}\n`,
    "utf8",
  );
  const calls = [];
  const canary = new WeFlowModelCanary({
    config: {
      stateDir,
      weflowModelCanaryEnabled: enabled,
      weflowCanaryChat: TALKER,
      weflowCanaryDisplayName: CONTACT,
      weflowInboxReplyUserId: "fixture-reply-user",
    },
    onTrigger: async (payload) => {
      calls.push(payload);
      return onTrigger(payload);
    },
    now: () => nowMs,
    logger: { warn() {} },
    leaseReceiptWaitMs,
  });
  return {
    ...created,
    calls,
    canary,
    desktopInputLeaseReceipt,
    stateDir,
    triggerObservation: {
      message: {
        id: "server-trigger-101",
        localId: 101,
        direction: "outgoing",
        text: created.manifest.triggerText,
        receivedAt: new Date(NOW_MS - 500).toISOString(),
      },
      classification: { origin: "self_manual", matched: false },
      talker: TALKER,
    },
  };
}

function buildReplyTarget(fixture) {
  return {
    userId: "fixture-reply-user",
    contextToken: "",
    provider: "weflow-uia",
    deliveryPolicy: MODEL_CANARY_DELIVERY_POLICY,
    modelCanaryExecutionPolicy: MODEL_CANARY_EXECUTION_POLICY,
    modelCanaryRunId: RUN_ID,
    modelCanaryNonce: NONCE,
    modelCanaryObligationFingerprint: fixture.manifest.obligationFingerprint,
    weflowContact: CONTACT,
    weflowTalker: TALKER,
    weflowExactContact: true,
    messageKind: buildModelCanaryMessageKind(RUN_ID),
    idempotencyKey: buildModelCanaryIdempotencyKey(RUN_ID),
    canonicalText: buildModelCanaryReplyText(RUN_ID),
    desktopInputLease: {
      version: 1,
      mode: "model_e2e",
      runId: RUN_ID,
      nonce: NONCE,
      targetFingerprint: fixture.manifest.targetFingerprint,
      replyIdempotencyKey: fixture.manifest.replyIdempotencyKey,
      expiresAt: fixture.manifest.expiresAt,
      token: fixture.desktopInputLeaseReceipt.leaseToken,
    },
  };
}

test("an enabled exact model marker durably claims one isolated runtime handoff", async (t) => {
  const fixture = createHarness(t);
  const first = await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const replay = await fixture.canary.handleObservedMessage(fixture.triggerObservation);

  assert.equal(first.status, "handoff_accepted");
  assert.equal(first.accepted, true);
  assert.equal(replay.status, "handoff_already_recorded");
  assert.equal(fixture.calls.length, 1);
  const prepared = fixture.calls[0].prepared;
  assert.equal(prepared.text, MODEL_CANARY_PROMPT);
  assert.equal(prepared.senderId, `cyberboss-model-canary:${RUN_ID}`);
  assert.equal(prepared.workspaceId, "cyberboss-model-canary");
  assert.equal(prepared.accountId, "cyberboss-model-canary");
  assert.equal(prepared.deliveryPolicy, MODEL_CANARY_DELIVERY_POLICY);
  assert.equal(prepared.suppressAcknowledgement, true);
  assert.equal(prepared.replyWeflowContact, CONTACT);
  assert.equal(prepared.replyWeflowTalker, TALKER);
  assert.equal(prepared.replyWeflowExactContact, true);
  assert.equal(prepared.replyCanonicalText, buildModelCanaryReplyText(RUN_ID));
  assert.equal(prepared.replyMessageKind, buildModelCanaryMessageKind(RUN_ID));
  assert.equal(prepared.replyIdempotencyKey, buildModelCanaryIdempotencyKey(RUN_ID));
  assert.equal(fs.existsSync(path.join(fixture.runDir, "handoff-claim", "claim.json")), true);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "handoff.json")), true);
  const handoff = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "handoff.json"), "utf8"));
  assert.equal(handoff.threadId, "thread-model");
  assert.equal(handoff.turnId, "turn-model");
});

test("a pending lease receipt retries its cursor while a tampered lease fails closed", async (t) => {
  const missing = createHarness(t);
  fs.unlinkSync(path.join(missing.runDir, "desktop-input-lease.json"));
  let result = await missing.canary.handleObservedMessage(missing.triggerObservation);
  assert.equal(result.status, "waiting_for_desktop_input_lease");
  assert.equal(result.accepted, false);
  assert.equal(missing.calls.length, 0);
  assert.equal(fs.existsSync(path.join(missing.runDir, "handoff-claim")), false);
  assert.equal(fs.existsSync(path.join(missing.runDir, "handoff-failed.json")), false);

  const tampered = createHarness(t);
  const receiptPath = path.join(tampered.runDir, "desktop-input-lease.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  fs.writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, leaseToken: "f".repeat(64) })}\n`);
  // Fingerprint fields still bind, so token substitution alone would be a valid
  // opaque token shape. Change the target binding as well to prove fail-closed.
  const changed = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  fs.writeFileSync(receiptPath, `${JSON.stringify({ ...changed, targetFingerprint: "0".repeat(64) })}\n`);
  result = await tampered.canary.handleObservedMessage(tampered.triggerObservation);
  assert.equal(result.status, "handoff_failed");
  assert.equal(tampered.calls.length, 0);
  assert.equal(fs.existsSync(path.join(tampered.runDir, "handoff-claim")), false);
});

test("a crash-shaped existing handoff claim is fail-closed and never starts another turn", async (t) => {
  const fixture = createHarness(t);
  fs.mkdirSync(path.join(fixture.runDir, "handoff-claim"));

  const result = await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  assert.equal(result.status, "handoff_unknown");
  assert.equal(result.accepted, true);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "handoff.json")), false);
});

test("a rejected handoff is terminal for that obligation and is not replayed", async (t) => {
  let attempts = 0;
  const fixture = createHarness(t, {
    onTrigger: async () => {
      attempts += 1;
      throw new Error("synthetic runtime unavailable");
    },
  });
  const first = await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const replay = await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  assert.equal(first.status, "handoff_failed");
  assert.equal(replay.status, "handoff_failed");
  assert.equal(attempts, 1);
  assert.match(
    fs.readFileSync(path.join(fixture.runDir, "handoff-failed.json"), "utf8"),
    /synthetic runtime unavailable/,
  );
});

test("the feature flag defaults closed and consumes the reserved marker without handoff", async (t) => {
  const fixture = createHarness(t, { enabled: false });
  const result = await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  assert.equal(result.status, "disabled");
  assert.equal(result.reason, "feature_disabled");
  assert.equal(fixture.calls.length, 0);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "handoff-claim")), false);
});

test("wrong origin, talker, nonce, and expired manifests are quarantined", async (t) => {
  const origin = createHarness(t);
  let result = await origin.canary.handleObservedMessage({
    ...origin.triggerObservation,
    classification: { origin: "cyberboss" },
  });
  assert.equal(result.reason, "trigger_origin_invalid");
  assert.equal(origin.calls.length, 0);

  const talker = createHarness(t);
  result = await talker.canary.handleObservedMessage({
    ...talker.triggerObservation,
    talker: "wxid_other",
  });
  assert.equal(result.reason, "manifest_identity_mismatch");
  assert.equal(talker.calls.length, 0);

  const nonce = createHarness(t);
  result = await nonce.canary.handleObservedMessage({
    ...nonce.triggerObservation,
    message: {
      ...nonce.triggerObservation.message,
      text: nonce.manifest.triggerText.replace(NONCE, "abcdefabcdefabcdefabcdef"),
    },
  });
  assert.equal(result.reason, "trigger_text_mismatch");
  assert.equal(nonce.calls.length, 0);

  const expired = createHarness(t, { nowMs: NOW_MS + 6 * 60_000 });
  result = await expired.canary.handleObservedMessage(expired.triggerObservation);
  assert.equal(result.reason, "manifest_expired");
  assert.equal(expired.calls.length, 0);
});

test("reply dispatch claim, receipt, and echo are strictly bound to one run and obligation", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const target = buildReplyTarget(fixture);

  const claim = await fixture.canary.handleDeliveryEvent({
    type: "claim_reply_dispatch",
    target,
    threadId: "thread-model",
    turnId: "turn-model",
  });
  const duplicateClaim = await fixture.canary.handleDeliveryEvent({
    type: "claim_reply_dispatch",
    target,
    threadId: "thread-model",
    turnId: "turn-model",
  });
  assert.equal(claim.claimed, true);
  assert.equal(duplicateClaim.claimed, false);

  const dispatched = await fixture.canary.handleDeliveryEvent({
    type: "reply_dispatched",
    target,
    threadId: "thread-model",
    turnId: "turn-model",
    sendResult: { verified: true, localId: 202 },
  });
  assert.equal(dispatched.accepted, true);

  const echo = await fixture.canary.handleObservedMessage({
    message: {
      id: "server-reply-202",
      localId: 202,
      direction: "outgoing",
      text: fixture.manifest.replyText,
      receivedAt: new Date(NOW_MS + 1_000).toISOString(),
    },
    classification: {
      origin: "cyberboss",
      matchedBy: "local_id",
      entry: {
        localId: "202",
        messageKind: fixture.manifest.replyMessageKind,
        idempotencyKey: fixture.manifest.replyIdempotencyKey,
      },
    },
    talker: TALKER,
  });
  assert.equal(echo.status, "reply_observed");
  const observed = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "reply-observed.json"), "utf8"));
  assert.equal(observed.runId, RUN_ID);
  assert.equal(observed.nonce, NONCE);
  assert.equal(observed.obligationFingerprint, fixture.manifest.obligationFingerprint);
  assert.equal(observed.replyLocalId, "202");

  const wrongObligation = await fixture.canary.handleDeliveryEvent({
    type: "claim_reply_dispatch",
    target: { ...target, modelCanaryObligationFingerprint: "0".repeat(64) },
  });
  assert.equal(wrongObligation.accepted, false);
  assert.equal(wrongObligation.reason, "delivery_target_mismatch");
});

test("an echo that wins the dispatch race takes non-empty runtime identity from the bound handoff", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const target = buildReplyTarget(fixture);
  const claim = await fixture.canary.handleDeliveryEvent({
    type: "claim_reply_dispatch",
    target,
    threadId: "thread-model",
    turnId: "turn-model",
  });
  assert.equal(claim.claimed, true);

  const echo = await fixture.canary.handleObservedMessage({
    message: {
      id: "server-reply-202",
      localId: 202,
      direction: "outgoing",
      text: fixture.manifest.replyText,
      receivedAt: new Date(NOW_MS + 1_000).toISOString(),
    },
    classification: {
      origin: "cyberboss",
      matchedBy: "content_hash_fifo",
      entry: {
        localId: "202",
        messageKind: fixture.manifest.replyMessageKind,
        idempotencyKey: fixture.manifest.replyIdempotencyKey,
      },
    },
    talker: TALKER,
  });
  assert.equal(echo.status, "reply_observed");
  const dispatched = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "reply-dispatched.json"), "utf8"));
  const observed = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "reply-observed.json"), "utf8"));
  assert.equal(dispatched.status, "reconciled_from_echo");
  assert.equal(dispatched.threadId, "thread-model");
  assert.equal(dispatched.turnId, "turn-model");
  assert.equal(observed.threadId, "thread-model");
  assert.equal(observed.turnId, "turn-model");

  const runtimeReceipt = await fixture.canary.handleDeliveryEvent({
    type: "reply_dispatched",
    target,
    threadId: "thread-model",
    turnId: "turn-model",
    sendResult: { verified: true, localId: 202 },
  });
  assert.equal(runtimeReceipt.accepted, true);
  assert.equal(runtimeReceipt.receipt.threadId, "thread-model");
  assert.equal(runtimeReceipt.receipt.turnId, "turn-model");
});

test("an echo with a handoff/dispatch-claim race mismatch fails closed", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const target = buildReplyTarget(fixture);
  await fixture.canary.handleDeliveryEvent({
    type: "claim_reply_dispatch",
    target,
    threadId: "thread-model",
    turnId: "turn-model",
  });
  const handoffPath = path.join(fixture.runDir, "handoff.json");
  const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
  fs.writeFileSync(handoffPath, `${JSON.stringify({ ...handoff, turnId: "turn-forged" }, null, 2)}\n`);

  const result = await fixture.canary.handleObservedMessage({
    message: {
      id: "server-reply-202",
      localId: 202,
      direction: "outgoing",
      text: fixture.manifest.replyText,
    },
    classification: {
      origin: "cyberboss",
      entry: {
        localId: "202",
        messageKind: fixture.manifest.replyMessageKind,
        idempotencyKey: fixture.manifest.replyIdempotencyKey,
      },
    },
    talker: TALKER,
  });
  assert.equal(result.status, "quarantined");
  assert.equal(result.reason, "reply_dispatch_claim_binding_invalid");
  assert.equal(fs.existsSync(path.join(fixture.runDir, "reply-dispatched.json")), false);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "reply-observed.json")), false);
});

for (const [eventType, receiptName, fields] of [
  ["model_completed", "model-completed.json", {
    assistantFinalSha256: "c".repeat(64),
    assistantFinalLength: 8,
    assistantFinalBytes: 12,
  }],
  ["reply_dispatched", "reply-dispatched.json", {
    sendResult: { verified: true, localId: 202 },
  }],
  ["turn_released", "turn-released.json", {}],
]) {
  test(`${eventType} fails closed when runtime thread/turn identity is missing`, async (t) => {
    const fixture = createHarness(t);
    await fixture.canary.handleObservedMessage(fixture.triggerObservation);
    const result = await fixture.canary.handleDeliveryEvent({
      type: eventType,
      target: buildReplyTarget(fixture),
      ...fields,
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "runtime_event_identity_missing");
    assert.equal(fs.existsSync(path.join(fixture.runDir, receiptName)), false);
  });
}

test("a forged model reply without the stable ledger identity is quarantined", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  fs.mkdirSync(path.join(fixture.runDir, "reply-send-claim"));
  const result = await fixture.canary.handleObservedMessage({
    message: { localId: 303, direction: "outgoing", text: fixture.manifest.replyText },
    classification: {
      origin: "cyberboss",
      entry: {
        messageKind: fixture.manifest.replyMessageKind,
        idempotencyKey: "ordinary-reply",
      },
    },
    talker: TALKER,
  });
  assert.equal(result.status, "quarantined");
  assert.equal(result.reason, "reply_authentication_failed");
  assert.equal(fs.existsSync(path.join(fixture.runDir, "reply-observed.json")), false);
});

test("model policy and exact route scalars survive clone and pending-store restart", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const prepared = clonePreparedInboundMessage(fixture.calls[0].prepared);
  const filePath = path.join(fixture.stateDir, "pending-model-canary.json");
  const first = new PendingInboundStore({ filePath });
  first.enqueue({
    bindingKey: "binding-model",
    workspaceRoot: "D:/fixture-workspace",
    message: prepared,
  });

  const restored = new PendingInboundStore({ filePath })
    .snapshotMap()
    .get("binding-model::D:/fixture-workspace")
    .messages[0];
  for (const key of [
    "deliveryPolicy",
    "modelCanaryExecutionPolicy",
    "modelCanaryRunId",
    "modelCanaryNonce",
    "modelCanaryObligationFingerprint",
    "replyUserId",
    "replyWeflowContact",
    "replyWeflowTalker",
    "replyMessageKind",
    "replyIdempotencyKey",
    "replyCanonicalText",
  ]) {
    assert.equal(restored[key], prepared[key], key);
  }
  assert.equal(restored.suppressAcknowledgement, true);
  assert.equal(restored.replyWeflowExactContact, true);
  assert.deepEqual(restored.replyDesktopInputLease, prepared.replyDesktopInputLease);
});

test("StreamDelivery suppresses commentary and raw model output, then sends one canonical exact-route reply", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const sends = [];
  const stream = new StreamDelivery({
    channelAdapter: {
      async sendText(payload) {
        sends.push(payload);
        return { dispatched: true, verified: true, localId: 404 };
      },
    },
    sessionStore: { findBindingForThreadId() { return null; } },
    onModelCanaryEvent: (event) => fixture.canary.handleDeliveryEvent(event),
  });
  stream.queueReplyTargetForThread("thread-model", buildReplyTarget(fixture));

  await stream.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-model", turnId: "turn-model" },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-model",
      turnId: "turn-model",
      itemId: "commentary",
      phase: "commentary",
      text: "raw progress that must stay internal",
    },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-model",
      turnId: "turn-model",
      itemId: "final",
      phase: "final_answer",
      text: "raw model final that must stay internal",
    },
  });
  assert.deepEqual(sends, []);

  await stream.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-model", turnId: "turn-model" },
  });
  assert.deepEqual(sends, [{
    userId: "fixture-reply-user",
    text: buildModelCanaryReplyText(RUN_ID),
    contextToken: "",
    preserveBlock: true,
    provider: "weflow-uia",
    messageKind: buildModelCanaryMessageKind(RUN_ID),
    idempotencyKey: buildModelCanaryIdempotencyKey(RUN_ID),
    weflowContact: CONTACT,
    weflowTalker: TALKER,
    weflowExactContact: true,
    desktopInputLease: buildReplyTarget(fixture).desktopInputLease,
  }]);
  const completed = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "model-completed.json"), "utf8"));
  assert.equal(completed.assistantFinalPresent, true);
  assert.equal(completed.assistantFinalLength, "raw model final that must stay internal".length);
  assert.equal(completed.assistantFinalBytes, Buffer.byteLength("raw model final that must stay internal"));
  assert.match(completed.assistantFinalSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(completed), /raw model final/);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "reply-dispatched.json")), true);
});

test("a turn without a non-empty assistant final records failure and sends no model canary message", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const sends = [];
  const stream = new StreamDelivery({
    channelAdapter: { async sendText(payload) { sends.push(payload); } },
    sessionStore: { findBindingForThreadId() { return null; } },
    onModelCanaryEvent: (event) => fixture.canary.handleDeliveryEvent(event),
  });
  stream.queueReplyTargetForThread("thread-empty", buildReplyTarget(fixture));
  await stream.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-empty", turnId: "turn-empty" },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-empty",
      turnId: "turn-empty",
      itemId: "commentary-only",
      phase: "commentary",
      text: "progress only",
    },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-empty", turnId: "turn-empty" },
  });
  assert.deepEqual(sends, []);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "turn-completed-without-final.json")), true);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "reply-send-claim")), false);
});

test("stale desktop-input lease records a certain predispatch failure without exposing raw model output", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const attempts = [];
  const stream = new StreamDelivery({
    channelAdapter: {
      async sendText(payload) {
        attempts.push(payload);
        const error = new Error("desktop input changed after trigger");
        error.code = "CANARY_DESKTOP_LEASE_STALE";
        error.deliveryUncertain = false;
        throw error;
      },
    },
    sessionStore: { findBindingForThreadId() { return null; } },
    onModelCanaryEvent: (event) => fixture.canary.handleDeliveryEvent(event),
  });
  stream.queueReplyTargetForThread("thread-model", buildReplyTarget(fixture));
  await stream.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-model", turnId: "turn-model" },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-model",
      turnId: "turn-model",
      itemId: "final",
      phase: "final_answer",
      text: "raw final remains internal",
    },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-model", turnId: "turn-model" },
  });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].requireDesktopIdleSeconds, undefined);
  assert.deepEqual(attempts[0].desktopInputLease, buildReplyTarget(fixture).desktopInputLease);
  assert.equal(attempts[0].text, buildModelCanaryReplyText(RUN_ID));
  const failure = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "reply-delivery-failed.json"), "utf8"));
  assert.equal(failure.code, "CANARY_DESKTOP_LEASE_STALE");
  assert.equal(failure.deliveryUncertain, false);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "model-completed.json")), true);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "reply-dispatched.json")), false);
  assert.doesNotMatch(JSON.stringify(failure), /raw final remains internal/);
});

test("an approval request makes the model probe terminal and blocks canonical dispatch", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const target = buildReplyTarget(fixture);
  await fixture.canary.handleDeliveryEvent({
    type: "approval_denied",
    target,
    threadId: "thread-approval",
    turnId: "turn-approval",
    requestId: "approval-1",
  });
  const sends = [];
  const stream = new StreamDelivery({
    channelAdapter: { async sendText(payload) { sends.push(payload); } },
    sessionStore: { findBindingForThreadId() { return null; } },
    onModelCanaryEvent: (event) => fixture.canary.handleDeliveryEvent(event),
  });
  stream.queueReplyTargetForThread("thread-approval", target);
  await stream.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-approval", turnId: "turn-approval" },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-approval",
      turnId: "turn-approval",
      itemId: "final",
      phase: "final_answer",
      text: "model output after denied tool request",
    },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-approval", turnId: "turn-approval" },
  });
  assert.deepEqual(sends, []);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "approval-denied.json")), true);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "reply-send-claim")), false);
});

test("the shared reserved inbox routes model markers before the transport canary", async () => {
  let heartbeatCalls = 0;
  const appLike = {
    config: { weflowCanaryChat: TALKER },
    weflowMessageLedger: {
      async classifyObservedOutgoing() { return { origin: "self_manual" }; },
    },
    weflowModelCanary: {
      async handleObservedMessage() {
        return { handled: true, accepted: true, status: "handoff_accepted" };
      },
    },
    weflowHeartbeatCanary: {
      async handleObservedMessage() {
        heartbeatCalls += 1;
        return { handled: true, accepted: true };
      },
    },
  };
  const accepted = await CyberbossApp.prototype.handleWeFlowCanaryInboxMessage.call(appLike, {
    id: "server-model",
    localId: "501",
    direction: "outgoing",
    text: `[Cyberboss心跳模型探针 trigger=${RUN_ID} nonce=${NONCE}]`,
  }, { chatUsername: TALKER });
  assert.equal(accepted, true);
  assert.equal(heartbeatCalls, 0);
});

test("the model trigger enters handlePreparedMessage only through the trusted internal flag", async () => {
  let dispatched = null;
  const appLike = {
    config: { weflowModelCanaryEnabled: true },
    runtimeAdapter: {
      supportsExecutionPolicy(policy) {
        return policy === MODEL_CANARY_EXECUTION_POLICY;
      },
      getSessionStore() {
        return {
          buildBindingKey({ workspaceId, accountId, senderId }) {
            return `${workspaceId}:${accountId}:${senderId}`;
          },
        };
      },
    },
    resolveWorkspaceRoot() { return "D:/fixture-workspace"; },
    async handlePreparedMessage(prepared, options) { dispatched = { prepared, options }; },
  };
  const prepared = {
    workspaceId: "cyberboss-model-canary",
    accountId: "cyberboss-model-canary",
    senderId: `cyberboss-model-canary:${RUN_ID}`,
    modelCanaryExecutionPolicy: MODEL_CANARY_EXECUTION_POLICY,
  };
  const result = await CyberbossApp.prototype.handleWeFlowModelCanaryTrigger.call(appLike, { prepared });
  assert.equal(result.accepted, true);
  assert.equal(result.workspaceRoot, "D:/fixture-workspace");
  assert.deepEqual(dispatched.options, { allowCommands: false, internalModelCanary: true });
  assert.equal(dispatched.prepared, prepared);
});

test("trusted model preparation installs the explicit Azzy reply target while untrusted input cannot select the policy", async () => {
  const targets = [];
  const routed = [];
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() { return "binding-model"; },
        };
      },
    },
    streamDelivery: { setReplyTarget(bindingKey, target) { targets.push({ bindingKey, target }); } },
    resolveWorkspaceRoot() { return "D:/fixture-workspace"; },
    async prepareIncomingMessageForRuntime(message) {
      return { ...message, originalText: message.text, attachments: [], attachmentFailures: [] };
    },
    async routePreparedInbound(payload) { routed.push(payload); },
  };
  const normalized = {
    provider: "weflow-uia",
    workspaceId: "cyberboss-model-canary",
    accountId: "cyberboss-model-canary",
    senderId: `cyberboss-model-canary:${RUN_ID}`,
    contextToken: "",
    text: MODEL_CANARY_PROMPT,
    deliveryPolicy: MODEL_CANARY_DELIVERY_POLICY,
    modelCanaryExecutionPolicy: MODEL_CANARY_EXECUTION_POLICY,
    replyUserId: "fixture-reply-user",
    modelCanaryRunId: RUN_ID,
    modelCanaryNonce: NONCE,
    modelCanaryObligationFingerprint: "a".repeat(64),
    replyWeflowContact: CONTACT,
    replyWeflowTalker: TALKER,
    replyWeflowExactContact: true,
    replyMessageKind: buildModelCanaryMessageKind(RUN_ID),
    replyIdempotencyKey: buildModelCanaryIdempotencyKey(RUN_ID),
    replyCanonicalText: buildModelCanaryReplyText(RUN_ID),
    replyDesktopInputLease: buildReplyTarget({
      manifest: {
        targetFingerprint: "b".repeat(64),
        replyIdempotencyKey: buildModelCanaryIdempotencyKey(RUN_ID),
        expiresAt: new Date(NOW_MS + 5 * 60_000).toISOString(),
      },
      desktopInputLeaseReceipt: { leaseToken: "a".repeat(64) },
    }).desktopInputLease,
  };
  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, normalized, {
    allowCommands: false,
    internalModelCanary: true,
  });
  assert.equal(targets[0].target.userId, "fixture-reply-user");
  assert.equal(targets[0].target.weflowContact, CONTACT);
  assert.equal(targets[0].target.weflowTalker, TALKER);
  assert.equal(targets[0].target.weflowExactContact, true);
  assert.equal(routed[0].prepared.deliveryPolicy, MODEL_CANARY_DELIVERY_POLICY);

  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, normalized, {
    allowCommands: false,
  });
  assert.equal(targets[1].target.userId, normalized.senderId);
  assert.equal(targets[1].target.deliveryPolicy, undefined);
  assert.equal(targets[1].target.weflowContact, undefined);
  assert.equal(routed[1].prepared.deliveryPolicy, undefined);
});

test("App forwards the persistent deny-side-effects policy into the runtime turn", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const prepared = fixture.calls[0].prepared;
  const runtimeCalls = [];
  const targets = [];
  const appLike = {
    channelAdapter: { async sendTyping() {} },
    turnGateStore: {
      begin() { return "binding-model::D:/fixture-workspace"; },
      attachThread() { return true; },
      releaseScope() {},
    },
    pipelineActivity: { refresh() {} },
    runtimeAdapter: {
      async sendTurn(payload) {
        runtimeCalls.push(payload);
        return { threadId: "thread-model", turnId: "turn-model" };
      },
      describe() { return { id: "codex" }; },
      getSessionStore() {
        return { getRuntimeParamsForWorkspace() { return { model: "" }; } };
      },
    },
    runtimeContextStore: { setActiveContext() {} },
    async buildRuntimeTurn() { return { text: MODEL_CANARY_PROMPT, attachments: [] }; },
    weflowModelCanary: fixture.canary,
    streamDelivery: {
      bindReplyTargetForTurn(payload) { targets.push(payload.target); },
      queueReplyTargetForThread() {},
    },
  };
  const dispatched = await CyberbossApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding-model",
    workspaceRoot: "D:/fixture-workspace",
    prepared,
  });
  assert.equal(dispatched, true);
  assert.equal(runtimeCalls[0].executionPolicy, MODEL_CANARY_EXECUTION_POLICY);
  assert.equal(runtimeCalls[0].metadata.modelCanaryDenySideEffects, true);
  assert.equal(runtimeCalls[0].text, MODEL_CANARY_PROMPT);
  assert.equal(targets[0].modelCanaryExecutionPolicy, MODEL_CANARY_EXECUTION_POLICY);
  assert.equal(targets[0].requireDesktopIdleSeconds, undefined);
  assert.match(targets[0].desktopInputLease.token, /^[a-f0-9]{64}$/u);
});

test("App silently declines a model-canary approval and records the failed probe", async () => {
  const target = {
    deliveryPolicy: MODEL_CANARY_DELIVERY_POLICY,
    modelCanaryRunId: RUN_ID,
  };
  const modelEvents = [];
  const approvalResponses = [];
  let cleared = 0;
  const sessionStore = {
    findBindingForThreadId() { return { bindingKey: "binding-model", workspaceRoot: "D:/fixture" }; },
    clearApprovalPrompt() { cleared += 1; },
  };
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun() { return target; },
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() { return sessionStore; },
      async respondApproval(payload) { approvalResponses.push(payload); },
    },
    threadStateStore: { resolveApproval() {} },
    weflowModelCanary: {
      async handleDeliveryEvent(event) { modelEvents.push(event); return { accepted: true }; },
    },
  };
  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-model",
      turnId: "turn-model",
      requestId: "approval-model",
      kind: "command_execution",
    },
  });
  assert.deepEqual(approvalResponses, [{ requestId: "approval-model", decision: "decline" }]);
  assert.equal(modelEvents.length, 1);
  assert.equal(modelEvents[0].type, "approval_denied");
  assert.equal(cleared, 1);
});

test("restart recovery leaves reserved model bindings dormant and never synthesizes an ordinary Weixin target", async () => {
  const targets = [];
  const resumed = [];
  const bindings = [
    {
      bindingKey: "binding-model",
      senderId: `cyberboss-model-canary:${RUN_ID}`,
    },
    {
      bindingKey: "binding-user",
      senderId: "ordinary-user",
    },
  ];
  const sessionStore = {
    listBindings() { return bindings; },
    getBinding(bindingKey) { return bindings.find((item) => item.bindingKey === bindingKey) || null; },
    listWorkspaceRoots() { return ["D:/fixture"]; },
    getThreadIdForWorkspace(bindingKey) { return `${bindingKey}-thread`; },
  };
  const appLike = {
    runtimeAdapter: {
      getSessionStore() { return sessionStore; },
      async resumeThread(payload) { resumed.push(payload); },
    },
    channelAdapter: {
      getKnownContextTokens() { return { "ordinary-user": "ctx-user" }; },
    },
    streamDelivery: { setReplyTarget(bindingKey, target) { targets.push({ bindingKey, target }); } },
    resolveReplyTargetForBinding: CyberbossApp.prototype.resolveReplyTargetForBinding,
  };

  await CyberbossApp.prototype.restoreBoundThreadSubscriptions.call(appLike);
  assert.deepEqual(targets, [{
    bindingKey: "binding-user",
    target: { userId: "ordinary-user", contextToken: "ctx-user", provider: "weixin" },
  }]);
  assert.deepEqual(resumed, [{ threadId: "binding-user-thread", workspaceRoot: "D:/fixture" }]);
  assert.equal(
    CyberbossApp.prototype.resolveReplyTargetForBinding.call(appLike, "binding-model"),
    null,
  );
});

test("StreamDelivery fails closed when a reserved binding is paired with an ordinary target", async () => {
  const sends = [];
  const stream = new StreamDelivery({
    channelAdapter: { async sendText(payload) { sends.push(payload); } },
    sessionStore: {
      findBindingForThreadId() {
        return {
          bindingKey: "binding-model",
          senderId: `cyberboss-model-canary:${RUN_ID}`,
        };
      },
    },
  });
  stream.setReplyTarget("binding-model", {
    userId: `cyberboss-model-canary:${RUN_ID}`,
    provider: "weixin",
  });
  await stream.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: { threadId: "thread-crash", turnId: "turn-crash", itemId: "final", text: "must stay hidden" },
  });
  await stream.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-crash", turnId: "turn-crash" },
  });
  assert.deepEqual(sends, []);
});

test("a model tool item is terminally recorded and the isolated turn is cancelled", async (t) => {
  const fixture = createHarness(t);
  await fixture.canary.handleObservedMessage(fixture.triggerObservation);
  const target = buildReplyTarget(fixture);
  const cancellations = [];
  const sessionStore = {
    findBindingForThreadId() {
      return {
        bindingKey: "binding-model",
        workspaceRoot: "D:/fixture-workspace",
        senderId: `cyberboss-model-canary:${RUN_ID}`,
      };
    },
  };
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun() { return target; },
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() { return sessionStore; },
      async cancelTurn(payload) { cancellations.push(payload); },
    },
    weflowModelCanary: fixture.canary,
  };
  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.tool.started",
    payload: {
      threadId: "thread-model",
      turnId: "turn-model",
      itemId: "tool-1",
      toolType: "commandExecution",
    },
  });
  assert.equal(fs.existsSync(path.join(fixture.runDir, "tool-attempted.json")), true);
  assert.deepEqual(cancellations, [{
    threadId: "thread-model",
    turnId: "turn-model",
    workspaceRoot: "D:/fixture-workspace",
  }]);
});

for (const releaseVerified of [true, false]) {
  test(`model turn release receipt reflects actual TurnGate proof=${releaseVerified}`, async (t) => {
    const fixture = createHarness(t);
    await fixture.canary.handleObservedMessage(fixture.triggerObservation);
    const target = buildReplyTarget(fixture);
    const scopeKey = "binding-model::D:/fixture-workspace";
    const sessionStore = {
      clearApprovalPrompt() {},
      findBindingForThreadId() {
        return {
          bindingKey: "binding-model",
          workspaceRoot: "D:/fixture-workspace",
          senderId: `cyberboss-model-canary:${RUN_ID}`,
        };
      },
    };
    const appLike = {
      streamDelivery: {
        resolveReplyTargetForRun() { return target; },
        async handleRuntimeEvent() {},
      },
      runtimeAdapter: { getSessionStore() { return sessionStore; } },
      threadStateStore: { clearApprovalPrompt() {} },
      pendingOperationByRunKey: new Map(),
      turnBoundaryScopeKeys: new Set(),
      turnGateStore: {
        releaseThread() {
          return releaseVerified
            ? { released: true, scopeKey }
            : { released: false, scopeKey: "" };
        },
        releaseScope() { return { released: false, scopeKey }; },
        isPending() { return !releaseVerified; },
      },
      weflowModelCanary: fixture.canary,
      async flushPendingInboundMessages() {},
      async flushPendingSystemMessages() {},
      async stopTypingForThread() {},
      hasPendingInboundMessage() { return false; },
    };
    await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
      type: "runtime.turn.completed",
      payload: { threadId: "thread-model", turnId: "turn-model" },
    });
    assert.equal(fs.existsSync(path.join(fixture.runDir, "turn-released.json")), releaseVerified);
    assert.equal(fs.existsSync(path.join(fixture.runDir, "turn-release-failed.json")), !releaseVerified);
  });
}
