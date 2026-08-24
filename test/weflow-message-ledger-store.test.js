const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  WeFlowMessageLedgerStore,
  hashWeFlowMessageContent,
  normalizeWeFlowMessageContent,
} = require("../src/integrations/weflow-message-ledger-store");

function fixture(t, startMs = Date.parse("2026-08-24T00:00:00.000Z"), options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-weflow-ledger-"));
  const filePath = path.join(dir, "outbound-ledger.json");
  const clock = { value: startMs };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const createStore = (extra = {}) => new WeFlowMessageLedgerStore({
    filePath,
    now: () => clock.value,
    ...options,
    ...extra,
  });
  return { clock, createStore, dir, filePath };
}

test("outbound ledger persists its lifecycle without storing message text", (t) => {
  const { clock, createStore, filePath } = fixture(t);
  const store = createStore();
  const planned = store.planOutbound({
    talker: "wxid_control",
    text: "private fixture reply",
    messageKind: "final_reply",
    idempotencyKey: "turn-1:final",
  });

  assert.equal(planned.status, "planned");
  assert.equal(planned.expectedDirection, "outgoing");
  assert.equal(planned.contentHash, hashWeFlowMessageContent("private fixture reply"));
  assert.equal("text" in planned, false);
  assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /private fixture reply/);

  clock.value += 1_000;
  const sending = store.markSending(planned.id);
  assert.equal(sending.status, "sending");
  assert.equal(sending.attemptCount, 1);

  clock.value += 1_000;
  const verified = store.markVerified(planned.id, { localId: 71 });
  assert.equal(verified.status, "verified");
  assert.equal(verified.localId, "71");

  const restarted = createStore();
  const observed = restarted.classifyObservedOutgoing({
    talker: "wxid_control",
    localId: 71,
    text: "private fixture reply",
  });
  assert.equal(observed.origin, "cyberboss");
  assert.equal(observed.classification, "cyberboss");
  assert.equal(observed.matchedBy, "local_id");
  assert.equal(observed.entry.id, planned.id);

  const duplicatePlan = restarted.planOutbound({
    talker: "wxid_control",
    text: "private fixture reply",
    idempotencyKey: "turn-1:final",
  });
  assert.equal(duplicatePlan.id, planned.id);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).entries.length, 1);
});

test("content fallback normalizes text and consumes equal messages in FIFO order", (t) => {
  const { clock, createStore } = fixture(t);
  const store = createStore();
  const first = store.planOutbound({ talker: "chat-1", text: "Ａ\r\n  B   C" });
  clock.value += 500;
  const failed = store.markFailed(first.id, { error: new Error("verification timed out") });
  assert.equal(failed.status, "failed_uncertain");
  assert.equal(failed.uncertain, true);

  clock.value += 500;
  const second = store.planOutbound({ talker: "chat-1", text: "A B C" });
  store.markSending(second.id);

  clock.value += 1_000;
  const firstObservation = store.classifyObservedOutgoing({
    talker: "chat-1",
    text: "  A\nB\tC  ",
    observedAt: clock.value,
  });
  assert.equal(firstObservation.origin, "cyberboss");
  assert.equal(firstObservation.matchedBy, "content_hash_fifo");
  assert.equal(firstObservation.entry.id, first.id);

  clock.value += 10;
  const secondObservation = store.classifyObservedOutgoing({
    talker: "chat-1",
    text: "A B C",
    observedAt: clock.value,
  });
  assert.equal(secondObservation.entry.id, second.id);

  const noThirdPlannedSend = store.classifyObservedOutgoing({
    talker: "chat-1",
    text: "A B C",
    observedAt: clock.value,
  });
  assert.equal(noThirdPlannedSend.origin, "self_manual");
  assert.equal(noThirdPlannedSend.matched, false);
  assert.equal(noThirdPlannedSend.entry, null);
  assert.equal(normalizeWeFlowMessageContent("Ａ\r\n  B   C"), "A B C");
});

test("an observed local id can complete an uncertain ledger row and is exact thereafter", (t) => {
  const { clock, createStore } = fixture(t);
  const store = createStore();
  const planned = store.planOutbound({ talkerId: "chat-2", text: "处理中" });
  store.markSending(planned);
  clock.value += 5_000;
  store.markFailed(planned, { uncertain: true });

  const recovered = store.classifyObservedOutgoing({
    talker: "chat-2",
    localId: "902",
    text: "处理中",
    observedAt: clock.value,
  });
  assert.equal(recovered.origin, "cyberboss");
  assert.equal(recovered.matchedBy, "content_hash_fifo");
  assert.equal(recovered.entry.localId, "902");
  assert.equal(recovered.entry.status, "verified");

  const exact = store.classifyObservedOutgoing({
    talker: "chat-2",
    localId: 902,
    text: "处理中",
    observedAt: clock.value + 1,
  });
  assert.equal(exact.origin, "cyberboss");
  assert.equal(exact.matchedBy, "local_id");

  const recycledId = store.classifyObservedOutgoing({
    talker: "chat-2",
    localId: 902,
    text: "different manual message",
    observedAt: clock.value + 2,
  });
  assert.equal(recycledId.origin, "self_manual");
});

test("uncertain delivery matches the original send timestamp after verification times out", (t) => {
  const { clock, createStore } = fixture(t);
  const store = createStore();
  const planned = store.planOutbound({ talker: "chat-timeout", text: "late observation" });
  store.markSending(planned);
  const sentAt = clock.value;

  clock.value += 30_000;
  store.markFailed(planned, { uncertain: true, error: "verification timeout" });

  const observed = store.classifyObservedOutgoing({
    talker: "chat-timeout",
    localId: 903,
    text: "late observation",
    observedAt: sentAt,
  });
  assert.equal(observed.origin, "cyberboss");
  assert.equal(observed.entry.localId, "903");
});

test("zero local ids are missing values and fall through to a positive message id", (t) => {
  const { createStore } = fixture(t);
  const store = createStore();
  const planned = store.planOutbound({ talker: "chat-zero", text: "verified delivery" });
  store.markSending(planned);
  const verified = store.markVerified(planned, { localId: 0, messageId: 904 });
  assert.equal(verified.localId, "904");

  const exact = store.classifyObservedOutgoing({
    talker: "chat-zero",
    localId: 0,
    messageId: "0904",
    text: "verified delivery",
  });
  assert.equal(exact.origin, "cyberboss");
  assert.equal(exact.matchedBy, "local_id");

  const manual = store.classifyObservedOutgoing({
    talker: "chat-zero",
    localId: 0,
    text: "an unrelated manual message",
  });
  assert.equal(manual.origin, "self_manual");
});

test("certain failures and uncertain entries outside their bounded recovery window stay self manual", (t) => {
  const { clock, createStore } = fixture(t);
  const store = createStore();
  store.planOutbound({ talker: "chat-3", text: "planned only" });
  let classified = store.classifyObservedOutgoing({ talker: "chat-3", text: "planned only" });
  assert.equal(classified.origin, "self_manual");

  const certainFailure = store.planOutbound({ talker: "chat-3", text: "same" });
  store.markFailed(certainFailure, { uncertain: false, errorCode: "NOT_DISPATCHED" });

  classified = store.classifyObservedOutgoing({ talker: "chat-3", text: "same" });
  assert.equal(classified.origin, "self_manual");

  const stale = store.planOutbound({ talker: "chat-3", text: "stale" });
  store.markFailed(stale); // The default is intentionally uncertain.
  clock.value += 15 * 60_000 + 1;
  classified = store.classifyObservedOutgoing({
    talker: "chat-3",
    text: "stale",
    observedAt: clock.value,
  });
  assert.equal(classified.origin, "self_manual");

  classified = store.classifyObservedOutgoing({
    talker: "another-chat",
    text: "stale",
    observedAt: clock.value,
  });
  assert.equal(classified.origin, "self_manual");
});

test("a corrupt ledger is preserved and replaced with a usable empty document", (t) => {
  const { createStore, dir, filePath } = fixture(t);
  fs.writeFileSync(filePath, "{broken", "utf8");

  const recovered = createStore();
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), {
    version: 2,
    entries: [],
  });
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("outbound-ledger.json.corrupt-")), true);

  const planned = recovered.planOutbound({ talker: "chat-4", text: "after recovery" });
  recovered.markSending(planned);
  const restarted = createStore();
  const matched = restarted.classifyObservedOutgoing({ talker: "chat-4", text: "after recovery" });
  assert.equal(matched.entry.id, planned.id);
});

test("expected direction prevents identical opposite-direction messages from consuming ledger rows", (t) => {
  const { clock, createStore } = fixture(t);
  const store = createStore();
  const uia = store.planOutbound({
    talker: "chat-direction",
    text: "same text",
    expectedDirection: "outgoing",
  });
  store.markSending(uia);

  let classified = store.classifyObservedOutgoing({
    talker: "chat-direction",
    text: "same text",
    direction: "incoming",
    observedAt: clock.value,
  });
  assert.equal(classified.origin, "self_manual");

  classified = store.classifyObservedOutgoing({
    talker: "chat-direction",
    text: "same text",
    direction: "outgoing",
    observedAt: clock.value,
  });
  assert.equal(classified.origin, "cyberboss");
  assert.equal(classified.entry.id, uia.id);

  const native = store.planOutbound({
    talker: "chat-direction",
    text: "native same text",
    messageKind: "native_final",
    expectedDirection: "incoming",
  });
  store.markSending(native);

  classified = store.classifyObservedOutgoing({
    talker: "chat-direction",
    text: "native same text",
    direction: "outgoing",
    observedAt: clock.value,
  });
  assert.equal(classified.origin, "self_manual");

  classified = store.classifyObservedOutgoing({
    talker: "chat-direction",
    text: "native same text",
    direction: "incoming",
    observedAt: clock.value,
  });
  assert.equal(classified.origin, "cyberboss");
  assert.equal(classified.entry.id, native.id);
});

test("native and failed-uncertain rows survive a five minute offline backfill without an unbounded outgoing match", (t) => {
  const { clock, createStore } = fixture(t);
  const store = createStore();
  const native = store.planOutbound({
    talker: "chat-backfill",
    text: "native delayed",
    messageKind: "native_reply",
    expectedDirection: "incoming",
  });
  store.markSending(native);
  const uncertain = store.planOutbound({
    talker: "chat-backfill",
    text: "uia delayed",
    expectedDirection: "outgoing",
  });
  store.markSending(uncertain);
  store.markFailed(uncertain, { uncertain: true, error: "offline" });

  clock.value += 5 * 60_000;
  const nativeBackfill = store.classifyObservedOutgoing({
    talker: "chat-backfill",
    localId: 1001,
    text: "native delayed",
    direction: "incoming",
    observedAt: clock.value,
  });
  assert.equal(nativeBackfill.origin, "cyberboss");
  assert.equal(nativeBackfill.entry.id, native.id);

  const uncertainBackfill = store.classifyObservedOutgoing({
    talker: "chat-backfill",
    localId: 1002,
    text: "uia delayed",
    direction: "outgoing",
    observedAt: clock.value,
  });
  assert.equal(uncertainBackfill.origin, "cyberboss");
  assert.equal(uncertainBackfill.entry.id, uncertain.id);

  const anotherUncertain = store.planOutbound({
    talker: "chat-backfill",
    text: "bounded duplicate",
    expectedDirection: "outgoing",
  });
  store.markSending(anotherUncertain);
  store.markFailed(anotherUncertain, { uncertain: true });
  clock.value += 15 * 60_000 + 1;
  const laterManual = store.classifyObservedOutgoing({
    talker: "chat-backfill",
    localId: 1003,
    text: "bounded duplicate",
    direction: "outgoing",
    observedAt: clock.value,
  });
  assert.equal(laterManual.origin, "self_manual");
});

test("version one ledgers infer native incoming and UIA outgoing directions during migration", (t) => {
  const { createStore, filePath } = fixture(t);
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    entries: [
      {
        id: "legacy-native",
        talker: "legacy-chat",
        contentHash: hashWeFlowMessageContent("native"),
        messageKind: "native_reply",
        status: "sending",
        createdAt: "2026-08-24T00:00:00.000Z",
      },
      {
        id: "legacy-uia",
        talker: "legacy-chat",
        contentHash: hashWeFlowMessageContent("uia"),
        messageKind: "final_reply",
        status: "sending",
        createdAt: "2026-08-24T00:00:00.000Z",
      },
    ],
  }), "utf8");

  createStore();
  const migrated = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.entries.find((entry) => entry.id === "legacy-native").expectedDirection, "incoming");
  assert.equal(migrated.entries.find((entry) => entry.id === "legacy-uia").expectedDirection, "outgoing");
});

test("a migration write failure preserves the valid primary ledger", (t) => {
  const { createStore, dir, filePath } = fixture(t);
  const originalDocument = {
    version: 0,
    entries: [{
      id: "valid-entry",
      idempotencyKey: "valid-entry",
      talker: "chat-io",
      contentHash: hashWeFlowMessageContent("preserve me"),
      status: "verified",
      localId: "905",
      createdAt: "2026-08-24T00:00:00.000Z",
    }],
  };
  fs.writeFileSync(filePath, `${JSON.stringify(originalDocument)}\n`, "utf8");
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.resolve(destination) === path.resolve(filePath)) {
      const error = new Error("simulated disk write failure");
      error.code = "ENOSPC";
      throw error;
    }
    return originalRenameSync(source, destination);
  };
  try {
    assert.throws(() => createStore(), /simulated disk write failure/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), originalDocument);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".corrupt-")), false);
});

test("load atomically persists the seven day and 4000 row retention limits", (t) => {
  const nowMs = Date.parse("2026-08-24T00:00:00.000Z");
  const { createStore, dir, filePath } = fixture(t, nowMs);
  const recentStart = nowMs - 60 * 60 * 1_000;
  const entries = [{
    id: "too-old",
    idempotencyKey: "too-old",
    talker: "chat-retention",
    contentHash: hashWeFlowMessageContent("old"),
    status: "verified",
    createdAt: new Date(nowMs - (8 * 24 * 60 * 60 * 1_000)).toISOString(),
  }];
  for (let index = 0; index < 4_001; index += 1) {
    entries.push({
      id: `recent-${String(index).padStart(4, "0")}`,
      idempotencyKey: `recent-${index}`,
      talker: "chat-retention",
      contentHash: hashWeFlowMessageContent(`message-${index}`),
      status: "verified",
      createdAt: new Date(recentStart + index).toISOString(),
    });
  }
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, entries }), "utf8");

  createStore();
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.entries.length, 4_000);
  assert.equal(persisted.entries.some((entry) => entry.id === "too-old"), false);
  assert.equal(persisted.entries.some((entry) => entry.id === "recent-0000"), false);
  assert.equal(persisted.entries.at(-1).id, "recent-4000");
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
});
