const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const { createDshRuntimeAdapter } = require("../src/adapters/runtime/dsh");
const { DshRpcClient } = require("../src/adapters/runtime/dsh/rpc-client");

/**
 * The process model is security-critical, not a performance preference: DSH
 * derives its sandbox workspace root from `process.cwd()`, so a runtime started
 * with the wrong cwd silently widens the sandbox. These tests pin the invariants
 * that keep one workspace's runtime from serving another.
 */

function makeState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-dsh-iso-"));
  return {
    dir,
    sessionsFile: path.join(dir, "sessions.json"),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Capture the cwd each runtime is spawned with, without starting a real process. */
function captureSpawns() {
  const spawns = [];
  const originalStart = DshRpcClient.prototype.start;
  DshRpcClient.prototype.start = function patchedStart() {
    spawns.push({ cwd: this.cwd, profile: this.profile, model: this.model });
    // Install a fake child so the adapter believes the runtime is up.
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    this.child = child;
    this.closed = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.kill = () => {
      child.exitCode = 0;
      this.child = null;
      child.emit("exit", 0, null);
    };
  };
  return {
    spawns,
    restore() {
      DshRpcClient.prototype.start = originalStart;
    },
  };
}

test("each workspace gets its own runtime spawned with that workspace as cwd", async () => {
  const state = makeState();
  const workspaceA = path.join(state.dir, "workspace-a");
  const workspaceB = path.join(state.dir, "workspace-b");
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);
  const capture = captureSpawns();

  try {
    const adapter = createDshRuntimeAdapter({
      workspaceRoot: workspaceA,
      sessionsFile: state.sessionsFile,
      dshSessionsFile: state.sessionsFile,
    });

    const clientA = adapter.createClient();
    await new Promise((resolve) => setImmediate(resolve));
    const runtimeForA = clientA;
    assert.equal(capture.spawns.length, 1);
    assert.equal(capture.spawns[0].cwd, workspaceA,
      "a runtime must never be started with a cwd other than its workspace");

    // A second workspace must not reuse the first runtime.
    const adapterB = createDshRuntimeAdapter({
      workspaceRoot: workspaceB,
      sessionsFile: state.sessionsFile,
      dshSessionsFile: state.sessionsFile,
    });
    adapterB.createClient();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capture.spawns.length, 2);
    assert.equal(capture.spawns[1].cwd, workspaceB);

    // Requesting the same workspace again reuses rather than respawns.
    adapter.createClient();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capture.spawns.length, 2, "the same workspace must reuse its runtime");
    assert.equal(runtimeForA, adapter.createClient());

    await adapter.close();
    await adapterB.close();
  } finally {
    capture.restore();
    state.cleanup();
  }
});

test("two workspaces are tracked independently and do not share sessions", async () => {
  const state = makeState();
  const workspaceA = path.join(state.dir, "wa");
  const capture = captureSpawns();
  const workspaceB = path.join(state.dir, "wb");
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);

  try {
    const adapter = createDshRuntimeAdapter({
      workspaceRoot: workspaceA,
      sessionsFile: state.sessionsFile,
      dshSessionsFile: state.sessionsFile,
    });
    const store = adapter.getSessionStore();
    const bindingKey = store.buildBindingKey({
      workspaceId: "w", accountId: "a", senderId: "s",
    });

    store.setThreadIdForWorkspace(bindingKey, workspaceA, "session-a", {});
    store.setThreadIdForWorkspace(bindingKey, workspaceB, "session-b", {});

    assert.equal(store.getThreadIdForWorkspace(bindingKey, workspaceA), "session-a");
    assert.equal(store.getThreadIdForWorkspace(bindingKey, workspaceB), "session-b");

    await adapter.close();
  } finally {
    capture.restore();
    state.cleanup();
  }
});

test("cancelTurn ends the runtime that owns the thread, and only that one", async () => {
  const state = makeState();
  const workspaceA = path.join(state.dir, "w-cancel-a");
  const workspaceB = path.join(state.dir, "w-cancel-b");
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);
  const capture = captureSpawns();

  try {
    const adapterA = createDshRuntimeAdapter({
      workspaceRoot: workspaceA,
      sessionsFile: state.sessionsFile,
      dshSessionsFile: state.sessionsFile,
    });
    const adapterB = createDshRuntimeAdapter({
      workspaceRoot: workspaceB,
      sessionsFile: state.sessionsFile,
      dshSessionsFile: state.sessionsFile,
    });
    const clientA = adapterA.createClient();
    const clientB = adapterB.createClient();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capture.spawns.length, 2);

    // An unknown thread must not tear down an unrelated workspace's runtime.
    await adapterA.cancelTurn({ threadId: "thread-owned-by-nobody" });
    assert.equal(clientA.isRunning(), true,
      "cancel must not abandon a runtime that does not own the thread");

    // No thread hint means "cancel whatever is running here".
    await adapterA.cancelTurn({});
    const nextA = adapterA.createClient();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capture.spawns.length, 3,
      "cancel must end the owning runtime, so the next use spawns a fresh one");
    assert.notEqual(nextA, clientA);

    // The other workspace is untouched: no respawn, same client.
    assert.equal(adapterB.createClient(), clientB);
    assert.equal(capture.spawns.length, 3, "an unrelated workspace must not respawn");

    await adapterA.close();
    await adapterB.close();
  } finally {
    capture.restore();
    state.cleanup();
  }
});

test("a dead runtime is replaced instead of serving a stale child", async () => {
  const state = makeState();
  const workspace = path.join(state.dir, "w-restart");
  fs.mkdirSync(workspace);
  const capture = captureSpawns();

  try {
    const adapter = createDshRuntimeAdapter({
      workspaceRoot: workspace,
      sessionsFile: state.sessionsFile,
      dshSessionsFile: state.sessionsFile,
    });
    const first = adapter.createClient();
    await new Promise((resolve) => setImmediate(resolve));
    first.kill();
    await new Promise((resolve) => setImmediate(resolve));

    const second = adapter.createClient();
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(first, second, "a killed runtime must not be handed out again");
    assert.equal(capture.spawns.length, 2);

    await adapter.close();
  } finally {
    capture.restore();
    state.cleanup();
  }
});

test("respondApproval reports that it cannot answer rather than faking success", async () => {
  const state = makeState();
  const adapter = createDshRuntimeAdapter({
    workspaceRoot: process.cwd(),
    sessionsFile: state.sessionsFile,
    dshSessionsFile: state.sessionsFile,
  });
  // DSH answers approvals inside its own profile; the SDK wire has no
  // server-to-client request, so a client-side answer is impossible.
  assert.equal(await adapter.respondApproval({}), false);
  state.cleanup();
});

test("close is idempotent and clears listeners", async () => {
  const state = makeState();
  const adapter = createDshRuntimeAdapter({
    workspaceRoot: process.cwd(),
    sessionsFile: state.sessionsFile,
    dshSessionsFile: state.sessionsFile,
  });
  let calls = 0;
  adapter.onEvent(() => { calls += 1; });
  await adapter.close();
  await adapter.close();
  assert.equal(calls, 0);
  state.cleanup();
});

/**
 * Cyberboss's persona is not a DSH system prompt: the Codex and Claude Code
 * adapters both fold it into the *opening user message*
 * (`buildOpeningTurnText`). The DSH adapter originally skipped that, so a fresh
 * DSH session ran on DSH's own generic coding-agent prompt and the WeChat
 * persona never applied. These tests capture the outbound prompt payload.
 */
function capturePrompts() {
  const prompts = [];
  const originalStart = DshRpcClient.prototype.start;
  const originalInitialize = DshRpcClient.prototype.initialize;
  const originalPrompt = DshRpcClient.prototype.prompt;
  DshRpcClient.prototype.start = function patchedStart() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    this.child = child;
    this.closed = false;
    child.stdout.setEncoding("utf8");
    child.kill = () => { child.exitCode = 0; this.child = null; child.emit("exit", 0, null); };
  };
  DshRpcClient.prototype.initialize = async function patchedInitialize() {
    this.initializeResult = { serverInfo: { name: "fake" } };
    return this.initializeResult;
  };
  DshRpcClient.prototype.prompt = async function patchedPrompt(sessionId, blocks) {
    prompts.push({ sessionId, blocks });
    // Abort before the turn-start rendezvous: this test is about what leaves the
    // adapter, not about the turn lifecycle, and waiting would need a real DSH.
    throw new Error("STOP_AFTER_PROMPT");
  };
  return {
    prompts,
    restore() {
      DshRpcClient.prototype.start = originalStart;
      DshRpcClient.prototype.initialize = originalInitialize;
      DshRpcClient.prototype.prompt = originalPrompt;
    },
  };
}

function promptText(blocks) {
  return (blocks || [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

test("a fresh DSH session carries the Cyberboss persona in its opening turn", async () => {
  const state = makeState();
  const workspace = path.join(state.dir, "w-persona");
  fs.mkdirSync(workspace);
  const instructionsFile = path.join(state.dir, "weixin-instructions.md");
  fs.writeFileSync(instructionsFile, "PERSONA_MARKER: you are the cyber boss.\n");
  const capture = capturePrompts();

  try {
    const adapter = createDshRuntimeAdapter({
      workspaceRoot: workspace,
      sessionsFile: state.sessionsFile,
      dshSessionsFile: state.sessionsFile,
      weixinInstructionsFile: instructionsFile,
    });
    const store = adapter.getSessionStore();
    const bindingKey = store.buildBindingKey({
      workspaceId: "w", accountId: "a", senderId: "s",
    });

    await assert.rejects(
      adapter.sendTurn({ bindingKey, workspaceRoot: workspace, text: "你好" }),
      /STOP_AFTER_PROMPT/u,
    );
    assert.equal(capture.prompts.length, 1);
    const opening = promptText(capture.prompts[0].blocks);
    assert.match(opening, /PERSONA_MARKER/u,
      "the opening turn must carry the configured persona");
    assert.match(opening, /WECHAT SESSION INSTRUCTIONS/u);
    assert.match(opening, /你好/u, "the user's own text must survive the wrapping");

    // A reply on the same session must not re-send the whole persona.
    await assert.rejects(
      adapter.sendTurn({ bindingKey, workspaceRoot: workspace, text: "再说一次" }),
      /STOP_AFTER_PROMPT/u,
    );
    assert.equal(capture.prompts.length, 2);
    const followUp = promptText(capture.prompts[1].blocks);
    assert.doesNotMatch(followUp, /PERSONA_MARKER/u,
      "the persona belongs to the opening turn only");
    assert.equal(followUp, "再说一次");
    assert.equal(
      capture.prompts[1].sessionId,
      capture.prompts[0].sessionId,
      "the follow-up must resume the session the opening turn created",
    );

    await adapter.close();
  } finally {
    capture.restore();
    state.cleanup();
  }
});

test("the opening turn still opens a session when no persona file is configured", async () => {
  const state = makeState();
  const workspace = path.join(state.dir, "w-nopersona");
  fs.mkdirSync(workspace);
  const capture = capturePrompts();

  try {
    const adapter = createDshRuntimeAdapter({
      workspaceRoot: workspace,
      sessionsFile: state.sessionsFile,
      dshSessionsFile: state.sessionsFile,
      weixinInstructionsFile: path.join(state.dir, "does-not-exist.md"),
    });
    const store = adapter.getSessionStore();
    const bindingKey = store.buildBindingKey({
      workspaceId: "w", accountId: "a", senderId: "s",
    });
    await assert.rejects(
      adapter.sendTurn({ bindingKey, workspaceRoot: workspace, text: "hello" }),
      /STOP_AFTER_PROMPT/u,
    );
    assert.equal(promptText(capture.prompts[0].blocks), "hello",
      "a missing persona file must not inject an empty instruction wrapper");
    await adapter.close();
  } finally {
    capture.restore();
    state.cleanup();
  }
});
