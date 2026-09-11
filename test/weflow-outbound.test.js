const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  executeWeFlowControlCommand,
  formatWeFlowControlConfirmation,
  isWeFlowControlConfirmation,
  isWeFlowControlCommand,
  resolveWeFlowSendSource,
  sendWeFlowUiaImage,
  sendWeFlowUiaText,
} = require("../src/integrations/weflow-outbound");
const {
  WeFlowMessageLedgerStore,
} = require("../src/integrations/weflow-message-ledger-store");

function realLedgerFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-weflow-outbound-"));
  const filePath = path.join(dir, "message-ledger.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    filePath,
    ledger: new WeFlowMessageLedgerStore({ filePath }),
  };
}

test("WeFlow mode commands are reserved for the bridge", () => {
  assert.equal(isWeFlowControlCommand(" /bot "), true);
  assert.equal(isWeFlowControlCommand("/AZZY"), true);
  assert.equal(isWeFlowControlCommand("/mode"), true);
  assert.equal(isWeFlowControlCommand("hello"), false);
  assert.equal(isWeFlowControlConfirmation("✅ 当前发信源：大号 ClawBot"), true);
  assert.equal(isWeFlowControlConfirmation("普通消息"), false);
});

test("executeWeFlowControlCommand lets the native channel switch the shared bridge", async () => {
  const calls = [];
  const result = await executeWeFlowControlCommand({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
  }, {
    command: "/AZZY",
    contact: "yourself",
    notify: false,
  }, async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, send_source: "azzy", label: "小号 UIA" };
      },
    };
  });
  assert.equal(result.send_source, "azzy");
  assert.equal(formatWeFlowControlConfirmation(result), "✅ 当前发信源：小号 UIA");
  assert.equal(calls[0].url, "http://bridge.local:8766/api/command");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    command: "/azzy",
    contact: "yourself",
    notify: false,
  });
});

test("resolveWeFlowSendSource reads the bridge state", async () => {
  const calls = [];
  const source = await resolveWeFlowSendSource({ weflowBridgeBaseUrl: "http://bridge.local:8766" }, async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, async json() { return { send_source: "azzy" }; } };
  });
  assert.equal(source, "azzy");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://bridge.local:8766/api/send-source");
});

test("sendWeFlowUiaText uses only the verified UIA bridge endpoint", async () => {
  const calls = [];
  const result = await sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowBridgeTimeoutMs: 20_000,
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, { text: "fixture reply" }, async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() { return { dispatched: true, verified: true, localId: 7 }; },
    };
  });
  assert.equal(result.verified, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://bridge.local:8766/api/send");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    contact: "fixture-contact",
    talker: "fixture-talker",
    text: "fixture reply",
    timeout: 20,
  });
});

test("sendWeFlowUiaText supports a short verification window for processing acknowledgements", async () => {
  const calls = [];
  await sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowBridgeTimeoutMs: 20_000,
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, { text: "处理中", timeoutMs: 5_000 }, async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() { return { dispatched: true, verified: true, localId: 8 }; },
    };
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    contact: "fixture-contact",
    talker: "fixture-talker",
    text: "处理中",
    timeout: 5,
  });
});

test("sendWeFlowUiaText routes a canary reply to an explicit exact contact and talker", async () => {
  const calls = [];
  const result = await sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "yourself",
    weflowInboxChat: "wxid_primary",
  }, {
    text: "[Cyberboss心跳正常 trigger=fixture]",
    contact: "Azzy",
    talker: "wxid_canary_self",
    exactContact: true,
    requireDesktopIdleSeconds: 300,
  }, async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          dispatched: true,
          verified: true,
          localId: 9,
          targetVerified: true,
          selectedContact: "Azzy",
          verifiedTalker: "wxid_canary_self",
        };
      },
    };
  });
  assert.equal(result.verified, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    contact: "Azzy",
    talker: "wxid_canary_self",
    text: "[Cyberboss心跳正常 trigger=fixture]",
    timeout: 30,
    exactContact: true,
    expectedContact: "Azzy",
    expectedTalker: "wxid_canary_self",
    requireDesktopIdleSeconds: 300,
  });
});

test("sendWeFlowUiaText rejects an exact route that the bridge did not prove", async () => {
  await assert.rejects(sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "yourself",
    weflowInboxChat: "wxid_primary",
  }, {
    text: "probe",
    contact: "Azzy",
    talker: "wxid_canary_self",
    exactContact: true,
  }, async () => ({
    ok: true,
    status: 200,
    async json() {
      return { dispatched: false, verified: false, targetVerified: false };
    },
  })), (error) => error?.code === "TARGET_NOT_CONFIRMED" && error?.deliveryUncertain === false);
});

test("model canonical reply uses its opaque same-run input lease without a second idle gate", async () => {
  const runId = "12345678-1234-4234-8234-123456789abc";
  const contact = "Azzy";
  const talker = "wxid_canary_self";
  const lease = {
    version: 1,
    mode: "model_e2e",
    runId,
    nonce: "0123456789abcdef01234567",
    targetFingerprint: crypto.createHash("sha256").update(`${contact}\n${talker}`).digest("hex"),
    replyIdempotencyKey: `model-canary-reply:${runId}`,
    expiresAt: "2026-08-30T07:05:00.000Z",
    token: "a".repeat(64),
  };
  let requestBody = null;
  const result = await sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
  }, {
    text: `[Cyberboss心跳模型正常 trigger=${runId}]`,
    messageKind: `model_canary_reply:${runId}`,
    idempotencyKey: `model-canary-reply:${runId}`,
    contact,
    talker,
    exactContact: true,
    desktopInputLease: lease,
  }, async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          dispatched: true,
          verified: true,
          localId: 10,
          targetVerified: true,
          selectedContact: contact,
          verifiedTalker: talker,
        };
      },
    };
  });
  assert.equal(result.verified, true);
  assert.deepEqual(requestBody.desktopInputLease, lease);
  assert.equal("requireDesktopIdleSeconds" in requestBody, false);
});

test("ordinary text cannot attach or repurpose a model desktop-input lease", async () => {
  const runId = "12345678-1234-4234-8234-123456789abc";
  let fetchCalls = 0;
  await assert.rejects(sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
  }, {
    text: "ordinary reply",
    messageKind: "plain_reply",
    idempotencyKey: "ordinary-reply",
    contact: "Azzy",
    talker: "wxid_canary_self",
    exactContact: true,
    desktopInputLease: {
      version: 1,
      mode: "model_e2e",
      runId,
      nonce: "0123456789abcdef01234567",
      targetFingerprint: crypto.createHash("sha256")
        .update("Azzy\nwxid_canary_self")
        .digest("hex"),
      replyIdempotencyKey: `model-canary-reply:${runId}`,
      expiresAt: "2026-08-30T07:05:00.000Z",
      token: "a".repeat(64),
    },
  }, async () => {
    fetchCalls += 1;
    throw new Error("must not reach bridge");
  }), /not bound to an exact model canary reply/u);
  assert.equal(fetchCalls, 0);
});

test("sendWeFlowUiaText records planned, sending, and verified ledger states around the bridge request", async () => {
  const events = [];
  const operation = { operationId: "operation-1" };
  const ledger = {
    async planOutbound(payload) {
      events.push(["planned", payload]);
      return operation;
    },
    async markSending(entry) {
      events.push(["sending", entry]);
    },
    async markVerified(entry, payload) {
      events.push(["verified", entry, payload]);
    },
    async markFailed() {
      throw new Error("unexpected failure state");
    },
  };
  await sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, {
    text: "fixture reply",
    messageKind: "final",
    messageLedger: ledger,
  }, async () => {
    events.push(["request"]);
    return {
      ok: true,
      status: 200,
      async json() { return { dispatched: true, verified: true, localId: 77 }; },
    };
  });
  assert.deepEqual(events, [
    ["planned", {
      talker: "fixture-talker",
      text: "fixture reply",
      messageKind: "final",
      expectedDirection: "outgoing",
    }],
    ["sending", operation],
    ["request"],
    ["verified", operation, { localId: "77" }],
  ]);
});

test("sendWeFlowUiaText suppresses a replay with a stable text idempotency key", async () => {
  const operation = {
    id: "canary-reply",
    status: "planned",
    localId: "",
  };
  let requestCount = 0;
  const ledger = {
    async planOutbound(payload) {
      assert.equal(payload.idempotencyKey, "heartbeat-canary-reply:fixture");
      return operation;
    },
    async markSending() {
      operation.status = "sending";
    },
    async markVerified(_entry, { localId }) {
      operation.status = "verified";
      operation.localId = localId;
    },
    async markFailed() {
      throw new Error("unexpected failure state");
    },
  };
  const options = {
    text: "[Cyberboss心跳正常 trigger=fixture]",
    messageKind: "heartbeat_canary_reply:fixture",
    idempotencyKey: "heartbeat-canary-reply:fixture",
    messageLedger: ledger,
  };
  const fetchImpl = async () => {
    requestCount += 1;
    return {
      ok: true,
      status: 200,
      async json() { return { dispatched: true, verified: true, localId: 88 }; },
    };
  };

  const first = await sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, options, fetchImpl);
  const replay = await sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, options, fetchImpl);

  assert.equal(first.verified, true);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.localId, "88");
  assert.equal(requestCount, 1);
});

test("concurrent text sends with one idempotency key claim the real ledger only once", async (t) => {
  const { filePath, ledger } = realLedgerFixture(t);
  const config = {
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  };
  const options = {
    text: "concurrent fixture reply",
    messageKind: "final_reply",
    idempotencyKey: "concurrent-text:final",
    messageLedger: ledger,
  };
  let requestCount = 0;
  let releaseRequest;
  let notifyRequestStarted;
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  const requestStarted = new Promise((resolve) => { notifyRequestStarted = resolve; });
  const fetchImpl = async () => {
    requestCount += 1;
    notifyRequestStarted();
    await requestGate;
    return {
      ok: true,
      status: 200,
      async json() { return { dispatched: true, verified: true, localId: 2_001 }; },
    };
  };

  const first = sendWeFlowUiaText(config, options, fetchImpl);
  const second = sendWeFlowUiaText(config, options, fetchImpl);
  await requestStarted;
  releaseRequest();
  const results = await Promise.all([first, second]);

  assert.equal(requestCount, 1);
  assert.equal(results.filter((result) => result.deduplicated === true).length, 1);
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.entries.length, 1);
  assert.equal(persisted.entries[0].status, "verified");
  assert.equal(persisted.entries[0].attemptCount, 1);
  assert.equal(persisted.entries[0].localId, "2001");
});

test("sendWeFlowUiaText keeps delivery uncertain without retry when verification has no stable local id", async () => {
  const events = [];
  const operation = { operationId: "operation-missing-id" };
  const ledger = {
    async planOutbound() { return operation; },
    async markSending() { events.push("sending"); },
    async markVerified() { events.push("verified"); },
    async markFailed(entry, payload) { events.push(["failed", entry, payload]); },
  };
  const result = await sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, {
    text: "fixture reply",
    messageLedger: ledger,
  }, async () => ({
    ok: true,
    status: 200,
    async json() { return { dispatched: true, verified: true, localId: "" }; },
  }));
  assert.equal(result.dispatched, true);
  assert.equal(result.verified, false);
  assert.equal(result.uncertain, true);
  assert.equal(events[0], "sending");
  assert.equal(events.some((event) => event === "verified"), false);
  assert.equal(events[1][0], "failed");
  assert.equal(events[1][2].uncertain, true);
});

test("sendWeFlowUiaText does not retry a verified dispatch when the ledger update fails", async () => {
  const events = [];
  const operation = { operationId: "operation-ledger-io" };
  const ledger = {
    async planOutbound() { return operation; },
    async markSending() { events.push("sending"); },
    async markVerified() {
      events.push("verified");
      throw new Error("ledger disk full");
    },
    async markFailed(entry, payload) { events.push(["failed", entry, payload]); },
  };
  const result = await sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, {
    text: "fixture reply",
    messageLedger: ledger,
  }, async () => ({
    ok: true,
    status: 200,
    async json() { return { dispatched: true, verified: true, localId: 79 }; },
  }));
  assert.equal(result.dispatched, true);
  assert.equal(result.verified, true);
  assert.equal(result.ledgerUncertain, true);
  assert.equal(events[0], "sending");
  assert.equal(events[1], "verified");
  assert.equal(events[2][0], "failed");
  assert.equal(events[2][2].uncertain, true);
});

test("sendWeFlowUiaText accepts an uncertain dispatch without inviting a delivery retry", async () => {
  const events = [];
  const operation = { operationId: "operation-api-lag" };
  const ledger = {
    async planOutbound() { return operation; },
    async markSending(entry) { events.push(["sending", entry]); },
    async markVerified() { events.push(["verified"]); },
    async markFailed(entry, payload) { events.push(["failed", entry, payload]); },
  };
  const result = await sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, {
    text: "fixture reply",
    messageLedger: ledger,
  }, async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        dispatched: true,
        verified: false,
        uncertain: true,
        verificationError: "read API lagged",
      };
    },
  }));
  assert.deepEqual(result, {
    dispatched: true,
    verified: false,
    uncertain: true,
    verificationError: "read API lagged",
  });
  assert.deepEqual(events, [
    ["sending", operation],
    ["failed", operation, { uncertain: true, error: "read API lagged" }],
  ]);
});

test("sendWeFlowUiaText records a certain failure when the bridge rejects before dispatch", async () => {
  const events = [];
  const operation = { operationId: "operation-2" };
  const ledger = {
    async planOutbound() { return operation; },
    async markSending() { events.push("sending"); },
    async markVerified() { events.push("verified"); },
    async markFailed(entry, payload) { events.push(["failed", entry, payload]); },
  };
  await assert.rejects(sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, {
    text: "fixture reply",
    messageLedger: ledger,
  }, async () => ({
    ok: false,
    status: 502,
    async json() { return { error: "WeChat window missing", dispatched: false }; },
  })), /WeChat window missing/);
  assert.equal(events[0], "sending");
  assert.equal(events[1][0], "failed");
  assert.equal(events[1][1], operation);
  assert.equal(events[1][2].uncertain, false);
  assert.match(events[1][2].error, /WeChat window missing/);
});

test("sendWeFlowUiaText keeps transport interruption uncertain after a request starts", async () => {
  const events = [];
  const operation = { operationId: "operation-transport" };
  const ledger = {
    async planOutbound() { return operation; },
    async markSending() { events.push("sending"); },
    async markVerified() { events.push("verified"); },
    async markFailed(entry, payload) { events.push(["failed", entry, payload]); },
  };
  await assert.rejects(sendWeFlowUiaText({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, {
    text: "fixture reply",
    messageLedger: ledger,
  }, async () => {
    throw new Error("socket reset after request write");
  }), /socket reset/);
  assert.equal(events[0], "sending");
  assert.equal(events[1][0], "failed");
  assert.equal(events[1][2].uncertain, true);
});

test("sendWeFlowUiaImage posts a managed PNG and records a verified media ledger operation", async () => {
  const calls = [];
  const events = [];
  const digest = "a".repeat(64);
  const operation = { id: "image-operation", status: "planned" };
  const ledger = {
    async planOutbound(payload) {
      events.push(["planned", payload]);
      return operation;
    },
    async markSending(entry) { events.push(["sending", entry]); },
    async markVerified(entry, payload) { events.push(["verified", entry, payload]); },
    async markFailed() { throw new Error("unexpected image failure state"); },
  };

  const result = await sendWeFlowUiaImage({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowBridgeTimeoutMs: 20_000,
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, {
    filePath: "D:\\fixture-state\\generated-images-outbound\\turn-item.png",
    imageDigest: digest,
    timeoutMs: 5_000,
    messageKind: "image",
    contentKind: "image",
    idempotencyKey: "thread:turn:item",
    messageLedger: ledger,
  }, async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { dispatched: true, verified: true, localId: 901, sha256: digest };
      },
    };
  });

  assert.equal(result.verified, true);
  assert.equal(result.localId, 901);
  assert.equal(result.imageDigest, digest);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://bridge.local:8766/api/send-image");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    contact: "fixture-contact",
    talker: "fixture-talker",
    filePath: "D:\\fixture-state\\generated-images-outbound\\turn-item.png",
    sha256: digest,
    timeout: 5,
  });
  assert.deepEqual(events, [
    ["planned", {
      talker: "fixture-talker",
      text: "[图片]",
      messageKind: "image",
      expectedDirection: "outgoing",
      idempotencyKey: "thread:turn:item",
      contentKind: "image",
      imageDigest: digest,
    }],
    ["sending", operation],
    ["verified", operation, { localId: "901" }],
  ]);
});

test("sendWeFlowUiaImage returns uncertain after dispatch without posting again", async () => {
  const digest = "b".repeat(64);
  const events = [];
  let requestCount = 0;
  const operation = { id: "uncertain-image", status: "planned" };
  const ledger = {
    async planOutbound() { return operation; },
    async markSending(entry) { events.push(["sending", entry]); },
    async markVerified() { events.push(["verified"]); },
    async markFailed(entry, payload) {
      events.push(["failed", entry, payload]);
      operation.status = payload.uncertain ? "failed_uncertain" : "failed";
    },
  };
  const config = {
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  };
  const options = {
    filePath: "D:\\fixture-state\\generated-images-outbound\\uncertain.png",
    sha256: digest,
    idempotencyKey: "thread:turn:uncertain",
    messageLedger: ledger,
  };
  const fetchImpl = async () => {
    requestCount += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          dispatched: true,
          verified: false,
          uncertain: true,
          verificationError: "WeFlow image row lagged",
        };
      },
    };
  };

  const first = await sendWeFlowUiaImage(config, options, fetchImpl);
  const replay = await sendWeFlowUiaImage(config, options, fetchImpl);

  assert.equal(first.dispatched, true);
  assert.equal(first.uncertain, true);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.uncertain, true);
  assert.equal(requestCount, 1);
  assert.deepEqual(events, [
    ["sending", operation],
    ["failed", operation, { uncertain: true, error: "WeFlow image row lagged" }],
  ]);
});

test("concurrent image sends with one idempotency key post once through a real ledger", async (t) => {
  const { filePath, ledger } = realLedgerFixture(t);
  const digest = "d".repeat(64);
  const config = {
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  };
  const options = {
    filePath: "D:\\fixture-state\\generated-images-outbound\\concurrent.png",
    imageDigest: digest,
    messageKind: "generated_image",
    idempotencyKey: "concurrent-image:item",
    messageLedger: ledger,
  };
  let requestCount = 0;
  let releaseRequest;
  let notifyRequestStarted;
  const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
  const requestStarted = new Promise((resolve) => { notifyRequestStarted = resolve; });
  const fetchImpl = async () => {
    requestCount += 1;
    notifyRequestStarted();
    await requestGate;
    return {
      ok: true,
      status: 200,
      async json() { return { dispatched: true, verified: true, localId: 2_002 }; },
    };
  };

  const first = sendWeFlowUiaImage(config, options, fetchImpl);
  const second = sendWeFlowUiaImage(config, options, fetchImpl);
  await requestStarted;
  releaseRequest();
  const results = await Promise.all([first, second]);

  assert.equal(requestCount, 1);
  assert.equal(results.filter((result) => result.deduplicated === true).length, 1);
  assert.ok(results.every((result) => result.imageDigest === digest));
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.entries.length, 1);
  assert.equal(persisted.entries[0].status, "verified");
  assert.equal(persisted.entries[0].attemptCount, 1);
  assert.equal(persisted.entries[0].imageDigest, digest);
  assert.equal(persisted.entries[0].localId, "2002");
});

test("sendWeFlowUiaImage records a certain failure when validation rejects before dispatch", async () => {
  const digest = "c".repeat(64);
  const events = [];
  const operation = { id: "invalid-image", status: "planned" };
  const ledger = {
    async planOutbound() { return operation; },
    async markSending(entry) { events.push(["sending", entry]); },
    async markVerified() { events.push(["verified"]); },
    async markFailed(entry, payload) { events.push(["failed", entry, payload]); },
  };

  await assert.rejects(sendWeFlowUiaImage({
    weflowBridgeBaseUrl: "http://bridge.local:8766",
    weflowInboxDisplayName: "fixture-contact",
    weflowInboxChat: "fixture-talker",
  }, {
    filePath: "D:\\outside-managed-root\\image.png",
    imageDigest: digest,
    idempotencyKey: "thread:turn:invalid",
    messageLedger: ledger,
  }, async () => ({
    ok: false,
    status: 400,
    async json() {
      return { error: "image file is outside the managed image root", dispatched: false };
    },
  })), /outside the managed image root/);

  assert.equal(events[0][0], "sending");
  assert.equal(events[1][0], "failed");
  assert.equal(events[1][2].uncertain, false);
  assert.match(events[1][2].error, /outside the managed image root/);
});
