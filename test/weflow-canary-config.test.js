const assert = require("node:assert/strict");
const test = require("node:test");

const { CyberbossApp } = require("../src/core/app");
const {
  assertWeFlowCanaryTalkerIsolation,
  readConfig,
} = require("../src/core/config");

test("config rejects a canary talker that aliases the primary WeFlow inbox", { concurrency: false }, () => {
  const previousArgv = process.argv;
  const names = [
    "CYBERBOSS_WEFLOW_INBOX_CHAT",
    "CYBERBOSS_WEFLOW_CANARY_CHAT",
    "CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME",
  ];
  const previousEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.argv = [process.execPath, "src/index.js", "start"];
  process.env.CYBERBOSS_WEFLOW_INBOX_CHAT = "wxid_same";
  process.env.CYBERBOSS_WEFLOW_CANARY_CHAT = "wxid_same";
  process.env.CYBERBOSS_WEFLOW_CANARY_DISPLAY_NAME = "Azzy";
  try {
    assert.throws(readConfig, (error) => {
      assert.equal(error.code, "CANARY_TALKER_CONFLICT");
      assert.equal(error.repairable, false);
      assert.match(error.message, /must differ/);
      return true;
    });
  } finally {
    process.argv = previousArgv;
    for (const name of names) {
      if (previousEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
  }
});

test("distinct primary and canary talkers satisfy the isolation invariant", () => {
  assert.equal(assertWeFlowCanaryTalkerIsolation({
    weflowInboxChat: "wxid_primary",
    weflowCanaryChat: "wxid_canary_self",
  }), true);
});

test("model E2E canary stays disabled unless its explicit feature flag is true", { concurrency: false }, () => {
  const previous = process.env.CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY;
  try {
    delete process.env.CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY;
    assert.equal(readConfig().weflowModelCanaryEnabled, false);
    process.env.CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY = "true";
    assert.equal(readConfig().weflowModelCanaryEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY;
    else process.env.CYBERBOSS_ENABLE_WEFLOW_MODEL_CANARY = previous;
  }
});

test("app fails before constructing a conflicting dedicated canary source", async () => {
  const appLike = {
    config: {
      startWithWeflowCanaryInbox: true,
      weflowInboxChat: "wxid_same",
      weflowCanaryChat: "wxid_same",
      weflowCanaryDisplayName: "Azzy",
    },
    weflowCanaryInboxSource: null,
  };

  await assert.rejects(
    CyberbossApp.prototype.ensureWeFlowCanaryInboxStarted.call(appLike),
    (error) => error?.code === "CANARY_TALKER_CONFLICT" && error?.repairable === false,
  );
  assert.equal(appLike.weflowCanaryInboxSource, null);
});
