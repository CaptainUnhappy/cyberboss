const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  WeFlowHeartbeatCanary,
  buildHeartbeatCanaryIdempotencyKey,
  buildHeartbeatCanaryMessageKind,
  buildHeartbeatCanaryReplyText,
  buildHeartbeatCanaryTriggerText,
} = require("../src/integrations/weflow-heartbeat-canary");
const { WeFlowMessageLedgerStore } = require("../src/integrations/weflow-message-ledger-store");
const { sendWeFlowUiaText } = require("../src/integrations/weflow-outbound");

const RUN_ID = "12345678-1234-4234-8234-123456789abc";
const NONCE = "0123456789abcdef01234567";
const TALKER = "wxid_fixture_self";
const CONTACT = "Azzy";

function createHarness(t, { expired = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-heartbeat-canary-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
  const runDir = path.join(stateDir, "e2e-probes", RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  const triggerText = buildHeartbeatCanaryTriggerText(RUN_ID, NONCE);
  const replyText = buildHeartbeatCanaryReplyText(RUN_ID);
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
    version: 1,
    runId: RUN_ID,
    nonce: NONCE,
    triggerText,
    replyText,
    talker: TALKER,
    contact: CONTACT,
    targetFingerprint: require("node:crypto").createHash("sha256")
      .update(`${CONTACT}\n${TALKER}`, "utf8")
      .digest("hex"),
    createdAt: new Date(nowMs - (expired ? 120_000 : 1_000)).toISOString(),
    expiresAt: new Date(nowMs - (expired ? 1 : -60_000)).toISOString(),
  }), "utf8");

  const sends = [];
  const ledgerEntries = new Map();
  const channelAdapter = {
    async sendText(payload) {
      sends.push(payload);
      const entry = {
        idempotencyKey: payload.idempotencyKey,
        status: "verified",
        localId: "202",
        createdAt: new Date(nowMs).toISOString(),
        sendingAt: new Date(nowMs + 5).toISOString(),
      };
      ledgerEntries.set(payload.idempotencyKey, entry);
      return { dispatched: true, verified: true, localId: 202 };
    },
  };
  const messageLedger = {
    findEntry({ idempotencyKey }) {
      return ledgerEntries.get(idempotencyKey) || null;
    },
  };
  const canary = new WeFlowHeartbeatCanary({
    config: {
      stateDir,
      weflowInboxChat: TALKER,
      weflowCanaryChat: TALKER,
      weflowCanaryDisplayName: CONTACT,
      weflowInboxReplyUserId: "fixture-user",
    },
    channelAdapter,
    messageLedger,
    now: () => nowMs,
    logger: { warn() {} },
  });
  return {
    canary,
    channelAdapter,
    ledgerEntries,
    messageLedger,
    nowMs,
    replyText,
    runDir,
    sends,
    stateDir,
    triggerText,
  };
}

test("valid same-account canary bypasses the model and dispatches exactly one idempotent reply", async (t) => {
  const fixture = createHarness(t);
  const observation = {
    message: {
      id: "trigger-server-101",
      localId: 101,
      direction: "outgoing",
      text: fixture.triggerText,
      receivedAt: new Date(fixture.nowMs - 100).toISOString(),
    },
    classification: { origin: "self_manual", matched: false },
    talker: TALKER,
  };

  const first = await fixture.canary.handleObservedMessage(observation);
  const replay = await fixture.canary.handleObservedMessage(observation);

  assert.equal(first.handled, true);
  assert.equal(first.accepted, true);
  assert.equal(first.status, "reply_dispatched");
  assert.equal(replay.status, "reply_already_dispatched");
  assert.equal(fixture.sends.length, 1);
  assert.deepEqual(fixture.sends[0], {
    userId: "fixture-user",
    text: fixture.replyText,
    preserveBlock: true,
    provider: "weflow-uia",
    messageKind: buildHeartbeatCanaryMessageKind("reply", RUN_ID),
    idempotencyKey: buildHeartbeatCanaryIdempotencyKey("reply", RUN_ID),
    weflowContact: CONTACT,
    weflowTalker: TALKER,
    weflowExactContact: true,
  });

  const ingested = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "ingested.json"), "utf8"));
  const dispatched = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "reply-dispatched.json"), "utf8"));
  assert.equal(ingested.version, 1);
  assert.equal(ingested.runId, RUN_ID);
  assert.equal(ingested.triggerLocalId, "101");
  assert.equal(dispatched.version, 1);
  assert.equal(dispatched.runId, RUN_ID);
  assert.equal(dispatched.replyLocalId, "202");
});

test("ledger-owned canary reply echo is recorded and consumed without a second reply", async (t) => {
  const fixture = createHarness(t);
  const result = await fixture.canary.handleObservedMessage({
    message: {
      id: "reply-server-202",
      localId: 202,
      direction: "outgoing",
      text: fixture.replyText,
      receivedAt: new Date(fixture.nowMs + 50).toISOString(),
    },
    classification: {
      origin: "cyberboss",
      matchedBy: "local_id",
      entry: {
        messageKind: buildHeartbeatCanaryMessageKind("reply", RUN_ID),
        localId: "202",
      },
    },
    talker: TALKER,
  });

  assert.equal(result.handled, true);
  assert.equal(result.accepted, true);
  assert.equal(result.status, "reply_observed");
  assert.equal(fixture.sends.length, 0);
  const observed = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "reply-observed.json"), "utf8"));
  assert.equal(observed.version, 1);
  assert.equal(observed.runId, RUN_ID);
  assert.equal(observed.replyLocalId, "202");
  assert.equal(observed.matchedBy, "local_id");
});

test("reserved markers with a missing, stale, or mismatched manifest are quarantined instead of routed", async (t) => {
  const missing = createHarness(t);
  fs.rmSync(path.join(missing.runDir, "manifest.json"));
  let result = await missing.canary.handleObservedMessage({
    message: { localId: 301, direction: "outgoing", text: missing.triggerText },
    classification: { origin: "self_manual" },
    talker: TALKER,
  });
  assert.equal(result.handled, true);
  assert.equal(result.status, "quarantined");
  assert.equal(result.reason, "manifest_missing");
  assert.equal(missing.sends.length, 0);

  const expired = createHarness(t, { expired: true });
  result = await expired.canary.handleObservedMessage({
    message: { localId: 302, direction: "outgoing", text: expired.triggerText },
    classification: { origin: "self_manual" },
    talker: TALKER,
  });
  assert.equal(result.handled, true);
  assert.equal(result.reason, "manifest_expired");
  assert.equal(expired.sends.length, 0);

  const wrongOrigin = createHarness(t);
  result = await wrongOrigin.canary.handleObservedMessage({
    message: { localId: 303, direction: "outgoing", text: wrongOrigin.triggerText },
    classification: { origin: "cyberboss", entry: { messageKind: "ordinary_reply" } },
    talker: TALKER,
  });
  assert.equal(result.handled, true);
  assert.equal(result.reason, "trigger_origin_invalid");
  assert.equal(wrongOrigin.sends.length, 0);

  const quarantine = fs.readdirSync(path.join(missing.stateDir, "e2e-probe-quarantine"));
  assert.equal(quarantine.length, 1);
});

test("ordinary messages remain outside the reserved canary route", async (t) => {
  const fixture = createHarness(t);
  const result = await fixture.canary.handleObservedMessage({
    message: { direction: "outgoing", text: "正常的同号人工消息" },
    classification: { origin: "self_manual" },
    talker: TALKER,
  });
  assert.deepEqual(result, { handled: false });
  assert.equal(fixture.sends.length, 0);
});

test("a malformed reserved prefix is consumed and quarantined", async (t) => {
  const fixture = createHarness(t);
  const result = await fixture.canary.handleObservedMessage({
    message: { localId: 350, direction: "outgoing", text: "[Cyberboss心跳探针 broken]" },
    classification: { origin: "self_manual" },
    talker: TALKER,
  });
  assert.equal(result.handled, true);
  assert.equal(result.status, "quarantined");
  assert.equal(result.reason, "marker_invalid");
  assert.equal(fixture.sends.length, 0);
});

test("a certain reply failure leaves the trigger retryable and the next attempt completes once", async (t) => {
  const fixture = createHarness(t);
  let attempt = 0;
  fixture.canary.channelAdapter.sendText = async (payload) => {
    attempt += 1;
    if (attempt === 1) {
      const error = new Error("fixture bridge rejected before dispatch");
      error.deliveryUncertain = false;
      throw error;
    }
    fixture.sends.push(payload);
    fixture.ledgerEntries.set(payload.idempotencyKey, {
      status: "verified",
      localId: "402",
      sendingAt: new Date(fixture.nowMs + 10).toISOString(),
    });
    return { dispatched: true, verified: true, localId: 402 };
  };
  const observation = {
    message: { id: "trigger-401", localId: 401, direction: "outgoing", text: fixture.triggerText },
    classification: { origin: "self_manual" },
    talker: TALKER,
  };

  const deferred = await fixture.canary.handleObservedMessage(observation);
  const completed = await fixture.canary.handleObservedMessage(observation);
  assert.equal(deferred.accepted, false);
  assert.equal(completed.accepted, true);
  assert.equal(attempt, 2);
  assert.equal(fixture.sends.length, 1);
  assert.equal(fs.existsSync(path.join(fixture.runDir, "reply-dispatched.json")), true);
});

test("an exact target mismatch is persisted once without repeated UI search", async (t) => {
  const fixture = createHarness(t);
  let attempts = 0;
  fixture.canary.channelAdapter.sendText = async () => {
    attempts += 1;
    const error = new Error("exact Azzy result missing");
    error.code = "TARGET_NOT_CONFIRMED";
    error.deliveryUncertain = false;
    throw error;
  };
  const observation = {
    message: { id: "trigger-451", localId: 451, direction: "outgoing", text: fixture.triggerText },
    classification: { origin: "self_manual" },
    talker: TALKER,
  };
  const first = await fixture.canary.handleObservedMessage(observation);
  const replay = await fixture.canary.handleObservedMessage(observation);
  assert.equal(first.accepted, true);
  assert.equal(first.status, "reply_target_not_confirmed");
  assert.equal(replay.status, "reply_target_not_confirmed");
  assert.equal(attempts, 1);
  const failure = JSON.parse(fs.readFileSync(path.join(fixture.runDir, "reply-failed.json"), "utf8"));
  assert.equal(failure.code, "TARGET_NOT_CONFIRMED");
  assert.equal(failure.repairable, false);
  assert.equal(failure.contact, CONTACT);
});

test("a crash after verified reply dispatch replays through the ledger without a second bridge send", async (t) => {
  const fixture = createHarness(t);
  const ledger = new WeFlowMessageLedgerStore({
    filePath: path.join(fixture.stateDir, "weflow-message-ledger.json"),
    now: () => fixture.nowMs,
  });
  let bridgeRequests = 0;
  let simulateCrash = true;
  const fetchImpl = async () => {
    bridgeRequests += 1;
    return {
      ok: true,
      status: 200,
      async json() { return { dispatched: true, verified: true, localId: 502 }; },
    };
  };
  const channelAdapter = {
    async sendText(payload) {
      const result = await sendWeFlowUiaText({
        weflowBridgeBaseUrl: "http://bridge.local:8766",
        weflowInboxDisplayName: "fixture-contact",
        weflowInboxChat: TALKER,
      }, {
        text: payload.text,
        messageKind: payload.messageKind,
        idempotencyKey: payload.idempotencyKey,
        messageLedger: ledger,
      }, fetchImpl);
      if (simulateCrash) {
        simulateCrash = false;
        throw new Error("fixture process stopped before milestone write");
      }
      return result;
    },
  };
  const canary = new WeFlowHeartbeatCanary({
    config: {
      stateDir: fixture.stateDir,
      weflowInboxChat: TALKER,
      weflowInboxDisplayName: "fixture-contact",
      weflowCanaryChat: TALKER,
      weflowCanaryDisplayName: CONTACT,
      weflowInboxReplyUserId: "fixture-user",
    },
    channelAdapter,
    messageLedger: ledger,
    now: () => fixture.nowMs,
    logger: { warn() {} },
  });
  const observation = {
    message: { id: "trigger-501", localId: 501, direction: "outgoing", text: fixture.triggerText },
    classification: { origin: "self_manual" },
    talker: TALKER,
  };

  const interrupted = await canary.handleObservedMessage(observation);
  const recovered = await canary.handleObservedMessage(observation);
  assert.equal(interrupted.accepted, false);
  assert.equal(recovered.accepted, true);
  assert.equal(recovered.reply.deduplicated, true);
  assert.equal(recovered.reply.replyLocalId, "502");
  assert.equal(bridgeRequests, 1);
});
