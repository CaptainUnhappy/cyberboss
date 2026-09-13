const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ReplyObligationStore,
  buildReplyDeliveryIdempotencyKey,
} = require("../src/core/reply-obligation-store");
const { StreamDelivery } = require("../src/core/stream-delivery");

function fixture({ now, instanceId = "instance-a", noReplyTimeoutMs = 60_000 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-reply-obligation-"));
  const filePath = path.join(directory, "reply-obligations.json");
  const store = new ReplyObligationStore({
    filePath,
    now,
    instanceId,
    noReplyTimeoutMs,
  });
  return { directory, filePath, store };
}

function beginFixture(store) {
  return store.begin({
    sourceMessageIds: ["weflow:200", "weflow:201"],
    provider: "weflow-uia",
    talker: "Azzy",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    bindingKey: "binding-1",
    workspaceRoot: "D:/workspace",
  });
}

test("reply obligation persists a strict final-delivery receipt and deterministic identity", () => {
  let nowMs = Date.parse("2026-08-29T00:00:00.000Z");
  const { filePath, store } = fixture({ now: () => nowMs });
  const first = beginFixture(store);
  const duplicate = beginFixture(store);

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.entry.id, first.entry.id);
  assert.equal(store.snapshot().obligations.length, 1);

  nowMs += 1_000;
  store.markTurnAccepted(first.entry.id, { threadId: "thread-1", turnId: "turn-1" });
  const idempotencyKey = buildReplyDeliveryIdempotencyKey(first.entry.id, "final-1");
  nowMs += 1_000;
  store.markFinalDeliveryStarted(first.entry.id, {
    text: "最终回复",
    messageKind: "plain_reply",
    idempotencyKey,
  });
  nowMs += 1_000;
  store.markVerified(first.entry.id, { localId: "9001" });

  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(Object.keys(persisted).sort(), [
    "integrity",
    "obligations",
    "policy",
    "summary",
    "updatedAt",
    "version",
    "writerInstanceId",
  ]);
  assert.equal(persisted.version, 1);
  assert.equal(persisted.summary.openCount, 0);
  assert.equal(persisted.summary.verifiedCount, 1);
  assert.equal(persisted.obligations.length, 1);
  assert.equal(persisted.obligations[0].terminalOutcome, "verified");
  assert.equal(persisted.obligations[0].deliveryLocalId, "9001");
  assert.equal(persisted.obligations[0].deliveryIdempotencyKey, idempotencyKey);
  assert.match(persisted.obligations[0].finalContentHash, /^[a-f0-9]{64}$/);
  assert.equal(persisted.obligations[0].noReplyTimeoutMs, 60_000);
  assert.equal(persisted.obligations[0].contextToken, "ctx-1");
});

test("an interrupted pre-accept handoff becomes terminal and is never reopened", () => {
  const nowMs = Date.parse("2026-08-29T01:00:00.000Z");
  const { filePath, store } = fixture({ now: () => nowMs, instanceId: "instance-a" });
  const first = beginFixture(store);

  const restarted = new ReplyObligationStore({
    filePath,
    now: () => nowMs + 5_000,
    instanceId: "instance-b",
    noReplyTimeoutMs: 60_000,
  });
  const recovered = restarted.get(first.entry.id);
  assert.equal(recovered.terminal, true);
  assert.equal(recovered.terminalOutcome, "handoff_uncertain");
  assert.match(recovered.lastError, /prior process stopped/);

  const duplicate = beginFixture(restarted);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.entry.terminalOutcome, "handoff_uncertain");
  assert.equal(restarted.snapshot().obligations.length, 1);
});

test("an accepted handoff survives restart as one open obligation", () => {
  const nowMs = Date.parse("2026-08-29T02:00:00.000Z");
  const { filePath, store } = fixture({ now: () => nowMs, instanceId: "instance-a" });
  const first = beginFixture(store);
  store.markTurnAccepted(first.entry.id, { threadId: "thread-1", turnId: "turn-1" });

  const restarted = new ReplyObligationStore({
    filePath,
    now: () => nowMs + 5_000,
    instanceId: "instance-b",
    noReplyTimeoutMs: 60_000,
  });
  assert.equal(restarted.listOpen().length, 1);
  assert.equal(restarted.listOpen()[0].status, "awaiting_final");
  assert.equal(restarted.listOpen()[0].threadId, "thread-1");
  assert.equal(restarted.listOpen()[0].contextToken, "ctx-1");

  const duplicate = beginFixture(restarted);
  assert.equal(duplicate.created, false);
  assert.equal(restarted.snapshot().obligations.length, 1);
});

test("an accepted turn with no final reaches an explicit no-reply timeout", () => {
  let nowMs = Date.parse("2026-08-29T03:00:00.000Z");
  const { store } = fixture({ now: () => nowMs, noReplyTimeoutMs: 5_000 });
  const first = beginFixture(store);
  store.markTurnAccepted(first.entry.id, { threadId: "thread-1", turnId: "turn-1" });

  nowMs += 5_001;
  assert.equal(store.expireOverdue(), 1);
  const timedOut = store.get(first.entry.id);
  assert.equal(timedOut.status, "timed_out");
  assert.equal(timedOut.terminalOutcome, "no_reply_timeout");
  assert.equal(timedOut.noReplyTimedOutAt, new Date(nowMs).toISOString());
  assert.equal(store.snapshot().summary.openCount, 0);
  assert.equal(store.snapshot().summary.terminalFailureCount, 1);
  assert.equal(store.snapshot().summary.attentionRequiredCount, 1);
});

test("durable deferral remains visibly unverified for watchdog follow-up", () => {
  const { store } = fixture();
  const obligation = beginFixture(store).entry;
  store.markTurnAccepted(obligation.id, { threadId: "thread-1", turnId: "turn-1" });
  store.markFinalDeliveryStarted(obligation.id, {
    text: "等待补发",
    idempotencyKey: buildReplyDeliveryIdempotencyKey(obligation.id, "final-1"),
  });
  store.markDeferred(obligation.id, { error: new Error("certain pre-dispatch failure") });

  const deferred = store.get(obligation.id);
  assert.equal(deferred.terminalOutcome, "deferred_durable");
  assert.equal(deferred.deliveryVerifiedAt, "");
  assert.equal(deferred.deliveryCertainty, "certain_not_dispatched");
  assert.equal(store.snapshot().summary.deferredCount, 1);
  assert.equal(store.snapshot().summary.attentionRequiredCount, 1);
});

test("a late verified ledger echo reconciles the same terminal uncertain delivery", () => {
  let nowMs = Date.parse("2026-09-02T08:36:44.000Z");
  const { store } = fixture({ now: () => nowMs });
  const obligation = beginFixture(store).entry;
  nowMs += 1_000;
  store.markTurnAccepted(obligation.id, { threadId: "thread-1", turnId: "turn-1" });
  const idempotencyKey = buildReplyDeliveryIdempotencyKey(obligation.id, "final-1");
  nowMs += 1_000;
  store.markFinalDeliveryStarted(obligation.id, {
    text: "CURRENT IMAGE E2E TEST IMG-9895F2015C5A",
    messageKind: "plain_reply",
    idempotencyKey,
  });
  const started = store.get(obligation.id);
  nowMs += 1_000;
  store.markDeliveryFailure(obligation.id, {
    error: new Error("ledger retained an uncertain outbound dispatch"),
    deliveryUncertain: true,
  });
  nowMs += 2_000;
  store.markTurnCompleted(obligation.id, { hadFinalReply: true });

  const ledgerEntry = {
    idempotencyKey,
    talker: "Azzy",
    contentHash: started.finalContentHash,
    contentKind: "text",
    imageDigest: "",
    status: "verified",
    localId: "392",
    attemptCount: 1,
    uncertain: false,
    verifiedAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  };
  const reconciled = store.reconcileWithLedger({
    findEntry(query) {
      assert.deepEqual(query, { talker: "Azzy", idempotencyKey });
      return ledgerEntry;
    },
  });

  assert.equal(reconciled, 1);
  const verified = store.get(obligation.id);
  assert.equal(verified.terminal, true);
  assert.equal(verified.status, "verified");
  assert.equal(verified.terminalOutcome, "verified");
  assert.equal(verified.deliveryLocalId, "392");
  assert.equal(verified.deliveryCertainty, "certain");
  assert.equal(verified.deliveryVerifiedAt, ledgerEntry.verifiedAt);
  assert.equal(verified.lastError, "");
  assert.equal(store.snapshot().summary.verifiedCount, 1);
  assert.equal(store.snapshot().summary.terminalFailureCount, 0);
  assert.equal(store.snapshot().summary.attentionRequiredCount, 0);
});

test("late ledger reconciliation stays fail-closed for mismatched proof", () => {
  let nowMs = Date.parse("2026-09-02T08:36:44.000Z");
  const { store } = fixture({ now: () => nowMs });
  const obligation = beginFixture(store).entry;
  store.markTurnAccepted(obligation.id, { threadId: "thread-1", turnId: "turn-1" });
  const idempotencyKey = buildReplyDeliveryIdempotencyKey(obligation.id, "final-1");
  store.markFinalDeliveryStarted(obligation.id, {
    text: "expected final",
    idempotencyKey,
  });
  store.markDeliveryFailure(obligation.id, {
    error: new Error("uncertain"),
    deliveryUncertain: true,
  });
  nowMs += 5_000;

  const reconciled = store.reconcileWithLedger({
    findEntry() {
      return {
        idempotencyKey,
        talker: "Azzy",
        contentHash: "f".repeat(64),
        contentKind: "text",
        imageDigest: "",
        status: "verified",
        localId: "392",
        attemptCount: 1,
        uncertain: true,
        verifiedAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      };
    },
  });

  assert.equal(reconciled, 0);
  assert.equal(store.get(obligation.id).terminalOutcome, "delivery_uncertain");
  assert.equal(store.snapshot().summary.terminalFailureCount, 1);
});

test("commentary cannot discharge a durable reply obligation at turn completion", async () => {
  const { store } = fixture();
  const obligation = beginFixture(store).entry;
  store.markTurnAccepted(obligation.id, { threadId: "thread-1", turnId: "turn-1" });
  const streamDelivery = new StreamDelivery({
    channelAdapter: {
      async sendText() { return { verified: true, localId: "7001" }; },
      getKnownContextTokens() { return {}; },
    },
    sessionStore: { findBindingForThreadId() { return null; } },
    onReplyDeliveryStarted: (payload) => store.markFinalDeliveryStarted(payload.replyObligationId, payload),
    onReplyDeliveryVerified: (payload) => store.markVerified(payload.replyObligationId, payload),
    onReplyTurnCompleted: (payload) => store.markTurnCompleted(payload.replyObligationId, payload),
  });
  streamDelivery.bindReplyTargetForTurn({
    threadId: "thread-1",
    turnId: "turn-1",
    target: {
      userId: "user-1",
      contextToken: "ctx-1",
      provider: "weflow-uia",
      replyObligationId: obligation.id,
    },
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "progress-1",
      text: "正在处理",
      phase: "commentary",
    },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  const completed = store.get(obligation.id);
  assert.equal(completed.terminal, true);
  assert.equal(completed.terminalOutcome, "turn_completed_without_final");
  assert.equal(completed.deliveryAttemptCount, 0);
  assert.equal(completed.deliveryVerifiedAt, "");
});

// A turn that completes with no final reply is the shape a dead runtime takes
// (expired credentials, failed connection). The user's message would otherwise
// disappear right after the processing acknowledgement, so the app notifies once
// and these tests pin that the claim is one-shot and survives a restart.
test("a turn completed without a final reply can be claimed for notification exactly once", () => {
  let nowMs = Date.parse("2026-09-13T16:51:10.000Z");
  const { store } = fixture({ now: () => nowMs });
  const { entry: obligation } = beginFixture(store);
  store.markTurnAccepted(obligation.id, { threadId: "thread-1", turnId: "turn-1" });

  const completed = store.markTurnCompleted(obligation.id, { hadFinalReply: false });
  assert.equal(completed.terminalOutcome, "turn_completed_without_final",
    "the app keys the user notice off terminalOutcome, not a bare outcome field");
  assert.equal(completed.threadId, "thread-1");

  assert.equal(store.markFailureNotified(obligation.id), true, "first claim wins");
  assert.equal(store.markFailureNotified(obligation.id), false, "second claim is refused");
});

test("the no-reply notification claim survives a restart", () => {
  let nowMs = Date.parse("2026-09-13T16:51:10.000Z");
  const { filePath, store } = fixture({ now: () => nowMs });
  const { entry: obligation } = beginFixture(store);
  store.markTurnAccepted(obligation.id, { threadId: "thread-1", turnId: "turn-1" });
  store.markTurnCompleted(obligation.id, { hadFinalReply: false });
  assert.equal(store.markFailureNotified(obligation.id), true);

  // A fresh store over the same file must not re-notify the user.
  const reloaded = new ReplyObligationStore({ filePath, now: () => nowMs, instanceId: "instance-b" });
  assert.equal(reloaded.get(obligation.id).failureNotifiedAt !== "", true,
    "failureNotifiedAt must survive the load normalizer");
  assert.equal(reloaded.markFailureNotified(obligation.id), false);
});

test("a normal turn with a final reply is never treated as a missing reply", () => {
  let nowMs = Date.parse("2026-09-13T16:51:10.000Z");
  const { store } = fixture({ now: () => nowMs });
  const { entry: obligation } = beginFixture(store);
  store.markTurnAccepted(obligation.id, { threadId: "thread-1", turnId: "turn-1" });

  const completed = store.markTurnCompleted(obligation.id, { hadFinalReply: true });
  assert.notEqual(completed.terminalOutcome, "turn_completed_without_final");
});

test("claiming a notification for an unknown obligation is refused", () => {
  const { store } = fixture();
  assert.equal(store.markFailureNotified("reply-obligation:does-not-exist"), false);
  assert.equal(store.markFailureNotified(""), false);
});

