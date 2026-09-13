const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDshRuntimeAdapter } = require("../src/adapters/runtime/dsh");

/**
 * Live integration coverage against a real `dsh --profile sdk` child process.
 *
 * Opt-in because a cold DSH boot auto-initializes its profile and can take ~50s,
 * which is far too slow for the default suite:
 *
 *   CYBERBOSS_DSH_INTEGRATION=1 node test/dsh-integration.test.js
 */
const ENABLED = process.env.CYBERBOSS_DSH_INTEGRATION === "1";
const TEST_TIMEOUT_MS = 240_000;

function makeTemporaryState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dsh-it-"));
  return {
    dir,
    sessionsFile: path.join(dir, "dsh-sessions.json"),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("dsh adapter drives a real turn end to end", { skip: !ENABLED, timeout: TEST_TIMEOUT_MS }, async (t) => {
  const state = makeTemporaryState();
  const workspaceRoot = process.cwd();
  const adapter = createDshRuntimeAdapter({
    workspaceRoot,
    sessionsFile: state.sessionsFile,
    dshSessionsFile: state.sessionsFile,
    dshModel: process.env.CYBERBOSS_DSH_MODEL || "deepseek-flash",
    workspaceRootForTests: workspaceRoot,
  });

  const events = [];
  adapter.onEvent((event) => events.push(event));

  t.after(async () => {
    await adapter.close();
    state.cleanup();
  });

  const ready = await adapter.initialize();
  assert.equal(ready.serverInfo.name, "deepseek-harness-sdk-runtime",
    "the runtime must identify itself as the DSH SDK server");

  const bindingKey = adapter.getSessionStore().buildBindingKey({
    workspaceId: "it-workspace",
    accountId: "it-account",
    senderId: "it-sender",
  });

  const turn = await adapter.sendTurn({
    bindingKey,
    workspaceRoot,
    text: "Reply with exactly: DSH_ADAPTER_OK",
    attachments: [],
  });

  assert.ok(turn.threadId, "sendTurn must return a threadId");
  assert.ok(turn.turnId, "sendTurn must return a turnId");

  // The session id must be persisted so a later turn resumes the same session.
  const stored = adapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
  assert.equal(stored, turn.threadId);

  // Wait for the terminal event rather than sleeping a fixed amount.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === "runtime.turn.completed"
      || event.type === "runtime.turn.failed")) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const failed = events.filter((event) => event.type === "runtime.turn.failed");
  assert.deepEqual(failed, [], `turn must not fail: ${JSON.stringify(failed)}`);

  const started = events.filter((event) => event.type === "runtime.turn.started");
  assert.ok(started.length >= 1, "expected runtime.turn.started");
  assert.equal(started[0].payload.threadId, turn.threadId);
  assert.equal(started[0].payload.turnId, turn.turnId,
    "turn ids must correlate between sendTurn and the emitted events");

  const completed = events.filter((event) => event.type === "runtime.turn.completed");
  assert.ok(completed.length >= 1, "expected runtime.turn.completed");
  assert.equal(completed[0].payload.threadId, turn.threadId);
  assert.equal(completed[0].payload.turnId, turn.turnId);

  const replies = events.filter((event) => event.type === "runtime.reply.completed");
  assert.ok(replies.length >= 1, "expected at least one assistant reply");
  const text = replies.map((event) => event.payload.text).join("\n");
  assert.match(text, /DSH_ADAPTER_OK/, `unexpected reply: ${text}`);
});

test("dsh adapter reports unsupported capabilities honestly", () => {
  const state = makeTemporaryState();
  const adapter = createDshRuntimeAdapter({
    workspaceRoot: process.cwd(),
    sessionsFile: state.sessionsFile,
    dshSessionsFile: state.sessionsFile,
  });
  const described = adapter.describe();
  assert.equal(described.id, "dsh");
  assert.equal(described.limitations.streamingReplyDelta, false);
  assert.equal(described.limitations.approvalRespond, false);
  assert.equal(described.limitations.compactThread, false);
  // The canary execution policy demands runtime isolation DSH cannot provide.
  assert.equal(adapter.supportsExecutionPolicy("model_canary_deny_side_effects"), false);
  assert.equal(adapter.supportsExecutionPolicy(""), true);
  state.cleanup();
});
