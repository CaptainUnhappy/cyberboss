const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

/**
 * `/compact` must not report success when the runtime refused to compact.
 *
 * A runtime that cannot compact answers with a structured refusal instead of
 * throwing (`{compacted: false, reason}` — DSH does exactly this, because its SDK
 * has no compaction request). The handler used to ignore that field and always
 * reply "Compact request sent", which is a false success the user has no way to
 * detect: nothing was compacted and no turn was ever started.
 */
function makeHarness({ compactResult }) {
  const sent = [];
  const app = Object.create(CyberbossApp.prototype);
  app.config = { stateDir: "/tmp" };
  app.pendingOperationByRunKey = new Map();
  app.resolveWorkspaceRoot = () => "/workspace";
  app.channelAdapter = {
    async sendText(payload) { sent.push(payload.text); return { verified: true }; },
  };
  app.streamDelivery = { queueReplyTargetForThread() {} };
  app.runtimeAdapter = {
    getSessionStore() {
      return {
        buildBindingKey: () => "binding-1",
        getThreadIdForWorkspace: () => "dsh-123",
        getRuntimeParamsForWorkspace: () => ({ model: "deepseek-flash" }),
      };
    },
    async compactThread() { return compactResult; },
  };
  return { app, sent };
}

const normalized = {
  workspaceId: "w",
  accountId: "a",
  senderId: "s",
  contextToken: "ctx",
  text: "/compact",
};

test("a runtime that refuses to compact is reported honestly, not as success", async () => {
  const { app, sent } = makeHarness({
    compactResult: { compacted: false, reason: "unsupported_by_dsh_sdk" },
  });
  await app.handleCompactCommand(normalized);

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /Compact request sent/u,
    "claiming the request was sent would be a false success");
  assert.match(sent[0], /未做任何改动/u);
  assert.match(sent[0], /unsupported_by_dsh_sdk/u,
    "the runtime's own reason must reach the user");
  assert.equal(app.pendingOperationByRunKey.size, 0,
    "a refused compact must not register a pending operation");
});

test("a runtime that accepts compaction still reports the request", async () => {
  const { app, sent } = makeHarness({
    compactResult: { threadId: "dsh-123", turnId: "turn-9" },
  });
  await app.handleCompactCommand(normalized);

  assert.equal(sent.length, 1);
  assert.match(sent[0], /Compact request sent/u);
  assert.equal(app.pendingOperationByRunKey.size, 1,
    "an accepted compact must be tracked so its result can be routed back");
});

test("a runtime that says nothing about compacting keeps the previous behaviour", async () => {
  // Codex returns the server's own payload, which carries no `compacted` field.
  // Absence of the flag must not be read as a refusal.
  const { app, sent } = makeHarness({ compactResult: { turnId: "turn-1" } });
  await app.handleCompactCommand(normalized);
  assert.match(sent[0], /Compact request sent/u);
  assert.equal(app.pendingOperationByRunKey.size, 1);
});

test("a throwing runtime still reports a failure rather than success", async () => {
  const { app, sent } = makeHarness({ compactResult: null });
  app.runtimeAdapter.compactThread = async () => { throw new Error("runtime is gone"); };
  await app.handleCompactCommand(normalized);
  assert.match(sent[0], /Compact failed/u);
  assert.match(sent[0], /runtime is gone/u);
});
