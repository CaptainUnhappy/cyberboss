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
