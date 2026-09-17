const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  AcpRpcClient,
  EXPECTED_AGENT_NAME,
} = require("../src/adapters/runtime/dsh-acp/rpc-client");
const { DshProtocolError } = require("../src/adapters/runtime/dsh/rpc-client");

const AGENT_INFO = { name: EXPECTED_AGENT_NAME, version: "0.0.1" };
const SESSION_CAPABILITIES = { close: {}, list: {}, resume: {} };

/** Minimal stand-in for a spawned `dsh --profile acp` child process. */
class FakeChild extends EventEmitter {
  constructor({ onWrite } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.frames = [];
    this.stdinEnded = false;
    this.onWrite = onWrite;
    this.stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        this.frames.push(frame);
        if (this.onWrite) this.onWrite(frame, this);
      }
    });
    this.stdin.on("end", () => {
      this.stdinEnded = true;
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

  requestFromAgent(id, method, params) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  kill() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

function makeClient({ onWrite, options = {} } = {}) {
  const client = new AcpRpcClient({
    dshBin: "/fake/dsh/bin.js",
    cwd: "/fake/workspace",
    logger: { error() {}, log() {}, warn() {} },
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
      this.rejectAllPending(new DshProtocolError(`dsh runtime exited (${code}${signal ? `/${signal}` : ""})`));
    });
    return child;
  };
  return { client, child };
}

function answerInitialize(child) {
  return (frame, target) => {
    if (frame.method === "initialize") {
      target.respond(frame.id, { protocolVersion: 1, agentInfo: AGENT_INFO, agentCapabilities: { sessionCapabilities: SESSION_CAPABILITIES } });
    }
  };
}

test("ACP initialize sends the protocol version and client capabilities", async () => {
  const { client, child } = makeClient({ onWrite: answerInitialize() });
  const result = await client.initialize();

  const frame = child.frames[0];
  assert.equal(frame.method, "initialize");
  assert.equal(frame.params.protocolVersion, 1);
  assert.equal(frame.params.clientCapabilities.terminal, false);
  assert.equal(frame.params.clientCapabilities.fs.readTextFile, false);
  assert.equal(frame.params.clientInfo.name, "cyberboss");
  assert.equal(result.agentInfo.name, EXPECTED_AGENT_NAME);
  assert.equal(client.sessionCapability("resume"), true);
  assert.equal(client.sessionCapability("delete"), false);
});

test("ACP initialize refuses a runtime that is not the ACP agent", async () => {
  const { client } = makeClient({
    onWrite: (frame, child) => {
      if (frame.method === "initialize") {
        child.respond(frame.id, { protocolVersion: 1, agentInfo: { name: "deepseek-harness-sdk-runtime" } });
      }
    },
  });
  await assert.rejects(() => client.initialize(), /unexpected ACP agent identity/u);
});

test("ACP newSession takes the id the server assigns", async () => {
  const { client, child } = makeClient({
    onWrite: (frame, target) => {
      answerInitialize()(frame, target);
      if (frame.method === "session/new") {
        assert.equal(frame.params.cwd, "/fake/workspace");
        assert.deepEqual(frame.params.mcpServers, []);
        target.respond(frame.id, { sessionId: "srv-assigned-1" });
      }
    },
  });
  assert.equal(await client.newSession(), "srv-assigned-1");
  assert.equal(child.frames[1].method, "session/new");
});

test("ACP newSession rejects a response without an id", async () => {
  const { client } = makeClient({
    onWrite: (frame, target) => {
      answerInitialize()(frame, target);
      if (frame.method === "session/new") {
        target.respond(frame.id, {});
      }
    },
  });
  await assert.rejects(() => client.newSession(), /session\/new returned no sessionId/u);
});

test("ACP prompt sends the prompt block list under the documented key", async () => {
  const { client, child } = makeClient({
    onWrite: (frame, target) => {
      answerInitialize()(frame, target);
      if (frame.method === "session/prompt") {
        target.respond(frame.id, { stopReason: "end_turn" });
      }
    },
  });
  const blocks = [{ type: "text", text: "你好" }];
  await client.prompt("session-1", blocks);
  const frame = child.frames.find((item) => item.method === "session/prompt");
  assert.equal(frame.params.sessionId, "session-1");
  assert.deepEqual(frame.params.prompt, blocks);
});

test("ACP resume re-attaches with the session id and working directory", async () => {
  const { client, child } = makeClient({
    onWrite: (frame, target) => {
      answerInitialize()(frame, target);
      if (frame.method === "session/resume") {
        target.respond(frame.id, {});
      }
    },
  });
  await client.resumeSession("session-9", { cwd: "D:/ws" });
  const frame = child.frames.find((item) => item.method === "session/resume");
  assert.equal(frame.params.sessionId, "session-9");
  assert.equal(frame.params.cwd, "D:/ws");
});

test("ACP listSessions reduces the page to the fields a caller uses", async () => {
  const { client, child } = makeClient({
    onWrite: (frame, target) => {
      answerInitialize()(frame, target);
      if (frame.method === "session/list") {
        target.respond(frame.id, {
          sessions: [
            { sessionId: "s1", cwd: "D:/ws", title: "收-Ally <-> 发-Azzy", updatedAt: "2026-09-17T02:00:00Z", extra: "ignored" },
            { sessionId: "", title: "" },
          ],
          nextCursor: "cursor-2",
        });
      }
    },
  });
  const page = await client.listSessions({ cwd: "D:/ws" });
  assert.equal(child.frames.find((item) => item.method === "session/list").params.cwd, "D:/ws");
  assert.equal(page.sessions.length, 2);
  assert.deepEqual(page.sessions[0], {
    sessionId: "s1",
    cwd: "D:/ws",
    title: "收-Ally <-> 发-Azzy",
    updatedAt: "2026-09-17T02:00:00Z",
  });
  assert.equal(page.nextCursor, "cursor-2");
});

test("an agent request reaches its handler and is answered on the wire", async () => {
  const answered = [];
  const { client, child } = makeClient({
    onWrite: (frame, target) => {
      answerInitialize()(frame, target);
      if (frame.method === "session/prompt") {
        target.respond(frame.id, { stopReason: "end_turn" });
        target.requestFromAgent(77, "session/request_permission", {
          sessionId: "session-1",
          toolCall: { toolCallId: "call-1", title: "run bash" },
          options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
        });
      }
    },
  });
  client.onRequest("session/request_permission", (params) => {
    answered.push(params.sessionId);
    return { outcome: { outcome: "selected", optionId: params.options[0].optionId } };
  });

  await client.prompt("session-1", [{ type: "text", text: "go" }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(answered, ["session-1"]);
  const reply = child.frames.find((frame) => frame.id === 77);
  assert.equal(reply.result.outcome.optionId, "allow-once");
});

test("an unanswered agent request is refused instead of stalling the agent", async () => {
  const { client, child } = makeClient({
    onWrite: (frame, target) => {
      answerInitialize()(frame, target);
      if (frame.method === "session/prompt") {
        target.respond(frame.id, { stopReason: "end_turn" });
        target.requestFromAgent(88, "fs/read_text_file", { path: "D:/secret" });
      }
    },
  });
  await client.prompt("session-1", [{ type: "text", text: "go" }]);
  await new Promise((resolve) => setImmediate(resolve));
  const reply = child.frames.find((frame) => frame.id === 88);
  assert.equal(reply.error.code, -32601);
  assert.match(reply.error.message, /fs\/read_text_file/u);
});

test("a failing request handler answers with an error rather than silence", async () => {
  const { client, child } = makeClient({
    onWrite: (frame, target) => {
      answerInitialize()(frame, target);
      if (frame.method === "session/prompt") {
        target.respond(frame.id, { stopReason: "end_turn" });
        target.requestFromAgent(99, "session/request_permission", {});
      }
    },
  });
  client.onRequest("session/request_permission", () => {
    throw new Error("decider offline");
  });
  await client.prompt("session-1", [{ type: "text", text: "go" }]);
  await new Promise((resolve) => setImmediate(resolve));
  const reply = child.frames.find((frame) => frame.id === 99);
  assert.equal(reply.error.code, -32603);
  assert.match(reply.error.message, /decider offline/u);
});

test("ACP shutdown closes the input stream instead of sending a shutdown request", async () => {
  const { client, child } = makeClient({ onWrite: answerInitialize() });
  await client.initialize();
  await client.shutdown();
  assert.equal(child.stdinEnded, true);
  assert.equal(child.frames.some((frame) => frame.method === "shutdown"), false);
});
