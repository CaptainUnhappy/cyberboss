const test = require("node:test");
const assert = require("node:assert/strict");

const {
  executeWeFlowControlCommand,
  formatWeFlowControlConfirmation,
  isWeFlowControlConfirmation,
  isWeFlowControlCommand,
  resolveWeFlowSendSource,
  sendWeFlowUiaText,
} = require("../src/integrations/weflow-outbound");

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
