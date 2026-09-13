const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  DshRpcClient,
  DshProtocolError,
  EXPECTED_SERVER_NAME,
  sanitizeEnvironment,
} = require("../src/adapters/runtime/dsh/rpc-client");

/** Minimal stand-in for a spawned `dsh --profile sdk` child process. */
class FakeChild extends EventEmitter {
  constructor({ onWrite } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.frames = [];
    this.onWrite = onWrite;
    this.stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        this.frames.push(frame);
        if (this.onWrite) this.onWrite(frame, this);
      }
    });
  }

  respond(id, result) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  respondError(id, code, message) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  }

  notify(method, params) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

/** Build a client whose child is a FakeChild instead of a real process. */
function makeClient({ onWrite, options = {} } = {}) {
  const client = new DshRpcClient({
    dshBin: "/fake/dsh/bin.js",
    cwd: "/fake/workspace",
    provider: "deepseek-official",
    model: "deepseek-flash",
    logger: { error() {}, log() {} },
    ...options,
  });
  const child = new FakeChild({ onWrite });
  client.start = function start() {
    this.child = child;
    this.closed = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.on("exit", (code, signal) => {
      this.child = null;
      this.rejectAllPending(new DshProtocolError(`dsh runtime exited (code=${code}, signal=${signal})`));
      this.emitExit({ code, signal });
    });
  };
  client.start();
  return { client, child };
}

test("sanitizeEnvironment collapses case-insensitive duplicate keys", () => {
  const out = sanitizeEnvironment({
    Path: "C:\\bin",
    PATH: "",
    no_proxy: "a",
    NO_PROXY: "b",
    KEEP: "yes",
  });
  const keys = Object.keys(out);
  assert.equal(keys.filter((key) => key.toUpperCase() === "PATH").length, 1);
  assert.equal(keys.filter((key) => key.toUpperCase() === "NO_PROXY").length, 1);
  assert.equal(out.KEEP, "yes");
});

test("initialize verifies the wire-stable server identity", async () => {
  const { client, child } = makeClient({
    onWrite(frame) {
      if (frame.method === "initialize") {
        child.respond(frame.id, { serverInfo: { name: EXPECTED_SERVER_NAME, version: "0.0.1" } });
      }
    },
  });
  const result = await client.initialize();
  assert.equal(result.serverInfo.name, EXPECTED_SERVER_NAME);
  assert.equal(client.isReady(), true);
  const sent = child.frames.find((frame) => frame.method === "initialize");
  assert.equal(sent.params.cwd, "/fake/workspace");
  assert.equal(sent.params.provider, "deepseek-official");
  assert.equal(sent.params.model, "deepseek-flash");
});

test("initialize refuses an unexpected server identity", async () => {
  const { client, child } = makeClient({
    onWrite(frame) {
      if (frame.method === "initialize") {
        child.respond(frame.id, { serverInfo: { name: "some-other-runtime", version: "9" } });
      }
    },
  });
  await assert.rejects(() => client.initialize(), /unexpected dsh server identity/);
  assert.equal(client.isReady(), false);
});

test("prompt rejects an empty sessionId or empty content before touching the wire", async () => {
  const { client, child } = makeClient();
  await assert.rejects(() => client.prompt("", [{ type: "text", text: "x" }]), /requires a sessionId/);
  await assert.rejects(() => client.prompt("s1", []), /at least one content block/);
  assert.equal(child.frames.length, 0);
});

test("prompt initializes first, then sends content blocks verbatim", async () => {
  const { client, child } = makeClient({
    onWrite(frame) {
      if (frame.method === "initialize") {
        child.respond(frame.id, { serverInfo: { name: EXPECTED_SERVER_NAME, version: "0.0.1" } });
      }
      if (frame.method === "session/prompt") {
        child.respond(frame.id, { messageId: "m-1" });
      }
    },
  });
  const result = await client.prompt("s1", [{ type: "text", text: "hello" }]);
  assert.equal(result.messageId, "m-1");
  const prompt = child.frames.find((frame) => frame.method === "session/prompt");
  assert.equal(prompt.params.sessionId, "s1");
  assert.deepEqual(prompt.params.contentBlocks, [{ type: "text", text: "hello" }]);
  // initialize must precede the prompt
  assert.equal(child.frames[0].method, "initialize");
});

test("notifications are dispatched to listeners with method and params", async () => {
  const { client, child } = makeClient();
  const seen = [];
  client.onNotification((method, params) => seen.push({ method, params }));
  child.notify("session.event", { sessionId: "s1", event: { type: "turn/start", data: { turn: 1 } } });
  child.notify("session.status", { sessionId: "s1", status: "running" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, "session.event");
  assert.equal(seen[1].params.status, "running");
});

test("a throwing notification listener does not break the client", async () => {
  const { client, child } = makeClient();
  const seen = [];
  client.onNotification(() => { throw new Error("listener boom"); });
  client.onNotification((method) => seen.push(method));
  child.notify("session.status", { sessionId: "s1", status: "idle" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["session.status"]);
});

test("an error response rejects with code and message preserved", async () => {
  const { client, child } = makeClient({
    onWrite(frame) {
      if (frame.method === "initialize") {
        child.respondError(frame.id, -32603, "no such model");
      }
    },
  });
  await assert.rejects(
    () => client.initialize(),
    (error) => error instanceof DshProtocolError
      && error.code === -32603
      && /no such model/.test(error.message),
  );
});

test("unparsable stdout lines are ignored, later frames still resolve", async () => {
  const { client, child } = makeClient({
    onWrite(frame) {
      if (frame.method === "initialize") {
        child.stdout.write("this is not json\n");
        child.respond(frame.id, { serverInfo: { name: EXPECTED_SERVER_NAME, version: "0.0.1" } });
      }
    },
  });
  const result = await client.initialize();
  assert.equal(result.serverInfo.name, EXPECTED_SERVER_NAME);
});

test("a frame split across chunks is reassembled", async () => {
  const { client, child } = makeClient();
  const frame = JSON.stringify({
    jsonrpc: "2.0",
    method: "session.status",
    params: { sessionId: "s1", status: "running" },
  });
  const seen = [];
  client.onNotification((method, params) => seen.push(params.status));
  child.stdout.write(frame.slice(0, 20));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 0, "must not dispatch a partial frame");
  child.stdout.write(`${frame.slice(20)}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["running"]);
});

test("process exit rejects in-flight requests and notifies exit listeners", async () => {
  const { client, child } = makeClient();
  const exits = [];
  client.onExit((payload) => exits.push(payload));
  const pending = client.request("session/prompt", { sessionId: "s1" });
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await assert.rejects(() => pending, /dsh runtime exited/);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 1);
  assert.equal(client.isRunning(), false);
});

test("request rejects when the runtime is not running", async () => {
  const { client } = makeClient();
  client.child = null;
  await assert.rejects(() => client.request("initialize", {}), /not running/);
});

test("a request timeout surfaces as a protocol error rather than hanging", async () => {
  const { client } = makeClient({ options: { requestTimeoutMs: 30 } });
  await assert.rejects(
    () => client.request("session/prompt", { sessionId: "s1" }),
    /timed out: session\/prompt/,
  );
});

test("shutdown is best-effort and always tears the child down", async () => {
  const { client, child } = makeClient({
    onWrite(frame) {
      if (frame.method === "initialize") {
        child.respond(frame.id, { serverInfo: { name: EXPECTED_SERVER_NAME, version: "0.0.1" } });
      }
      if (frame.method === "shutdown") {
        child.respond(frame.id, {});
        child.exitCode = 0;
        setImmediate(() => child.emit("exit", 0, null));
      }
    },
  });
  await client.initialize();
  await client.close();
  assert.equal(client.isRunning(), false);
  assert.equal(client.notificationListeners.size, 0);
});

test("shutdown survives a runtime that never answers", async () => {
  const { client } = makeClient({ options: { requestTimeoutMs: 30 } });
  await client.close();
  assert.equal(client.isRunning(), false);
});

test("start is idempotent while the runtime is running", () => {
  const { client, child } = makeClient();
  client.start();
  assert.equal(client.child, child, "start() must not spawn a second child");
});
