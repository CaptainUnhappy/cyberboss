const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createDshAcpRuntimeAdapter,
  buildAcpContentBlocks,
  resolveAcpPermissionMode,
} = require("../src/adapters/runtime/dsh-acp");

function makeState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acp-adapter-"));
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  return { dir, workspace, sessionsFile: path.join(dir, "dsh-sessions.json") };
}

/**
 * Scripted stand-in for the ACP client. It records every protocol call so a test
 * can assert the adapter's decisions (resume vs create, persona, cancel) without
 * spawning a runtime.
 */
function makeFakeClient({ resumeFails = false, newSessionIds = ["srv-1", "srv-2", "srv-3"] } = {}) {
  const calls = [];
  const listeners = new Set();
  const requestHandlers = new Map();
  let created = 0;
  const client = {
    isRunning: () => true,
    initialize: async () => {
      calls.push({ method: "initialize" });
      return { agentInfo: { name: "deepseek-harness-acp" }, agentCapabilities: {} };
    },
    newSession: async ({ cwd }) => {
      const id = newSessionIds[created] || `srv-extra-${created}`;
      created += 1;
      calls.push({ method: "session/new", cwd, id });
      return id;
    },
    resumeSession: async (sessionId, { cwd }) => {
      calls.push({ method: "session/resume", sessionId, cwd });
      if (resumeFails) {
        throw new Error("session not found");
      }
      return {};
    },
    prompt: async (sessionId, blocks) => {
      calls.push({ method: "session/prompt", sessionId, blocks });
      return { stopReason: "end_turn" };
    },
    notify: (method, params) => {
      calls.push({ method: `notify:${method}`, params });
      return true;
    },
    onNotification: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onRequest: (method, handler) => {
      requestHandlers.set(method, handler);
      return () => requestHandlers.delete(method);
    },
    onExit: () => () => {},
    close: async () => {},
    kill: () => {},
    // Test affordances.
    emitUpdate: (sessionId, update) => {
      for (const listener of listeners) {
        listener("session/update", { sessionId, update });
      }
    },
    askPermission: (params) => requestHandlers.get("session/request_permission")?.(params),
  };
  return { client, calls, requestHandlers };
}

function makeAdapter(state, fake, config = {}) {
  return createDshAcpRuntimeAdapter(
    {
      workspaceRoot: state.workspace,
      sessionsFile: state.sessionsFile,
      dshSessionsFile: state.sessionsFile,
      ...config,
    },
    { createClient: () => fake.client },
  );
}

function bindingKeyOf(adapter) {
  return adapter.getSessionStore().buildBindingKey({ workspaceId: "w", accountId: "a", senderId: "s" });
}

function collect(adapter) {
  const events = [];
  adapter.onEvent((event) => events.push(event));
  return events;
}

test("the first turn of a window creates a session and remembers it for that window", async () => {
  const state = makeState();
  const fake = makeFakeClient();
  const adapter = makeAdapter(state, fake);
  const events = collect(adapter);
  const bindingKey = bindingKeyOf(adapter);

  const turn = await adapter.sendTurn({
    bindingKey,
    workspaceRoot: state.workspace,
    text: "你好",
    metadata: { conversationKey: "weflow:azzy", sessionName: "收-Ally <-> 发-Azzy" },
  });

  assert.equal(turn.threadId, "srv-1");
  assert.equal(turn.resumed, false);
  assert.deepEqual(fake.calls.map((call) => call.method), ["initialize", "session/new", "session/prompt"]);
  assert.equal(
    adapter.getSessionStore().getThreadIdForConversation(bindingKey, state.workspace, "weflow:azzy"),
    "srv-1",
  );
  assert.equal(
    adapter.getSessionStore().getThreadIdForConversation(bindingKey, state.workspace, "weflow:liu"),
    "",
    "one window's session must not leak into another window",
  );

  // The window's own name opens the persona message, so the session is
  // recognizable in the client's list.
  const prompt = fake.calls.find((call) => call.method === "session/prompt");
  assert.match(prompt.blocks[0].text, /^收-Ally <-> 发-Azzy\n\n/u);
  assert.equal(prompt.blocks.at(-1).type, "text");
  assert.match(prompt.blocks.map((block) => block.text).join(""), /你好/u);

  assert.deepEqual(events.map((event) => event.type), ["runtime.turn.started", "runtime.turn.completed"]);
  assert.equal(events[0].payload.threadId, "srv-1");
});

test("a second turn in the same window reuses the live session and drops the persona", async () => {
  const state = makeState();
  const fake = makeFakeClient();
  const adapter = makeAdapter(state, fake);
  const bindingKey = bindingKeyOf(adapter);
  const metadata = { conversationKey: "weflow:azzy", sessionName: "收-Ally <-> 发-Azzy" };

  await adapter.sendTurn({ bindingKey, workspaceRoot: state.workspace, text: "第一句", metadata });
  const second = await adapter.sendTurn({ bindingKey, workspaceRoot: state.workspace, text: "第二句", metadata });

  assert.equal(second.threadId, "srv-1");
  assert.equal(second.resumed, false);
  assert.equal(fake.calls.filter((call) => call.method === "session/new").length, 1);
  assert.equal(fake.calls.filter((call) => call.method === "session/resume").length, 0);
  const prompts = fake.calls.filter((call) => call.method === "session/prompt");
  assert.equal(prompts[1].blocks[0].text, "第二句", "a follow-up must not resend the persona");
});

test("a new runtime process resumes the window's session instead of opening another", async () => {
  const state = makeState();
  const first = makeFakeClient();
  const firstAdapter = makeAdapter(state, first);
  const bindingKey = bindingKeyOf(firstAdapter);
  const metadata = { conversationKey: "weflow:azzy", sessionName: "收-Ally <-> 发-Azzy" };
  await firstAdapter.sendTurn({ bindingKey, workspaceRoot: state.workspace, text: "第一句", metadata });
  await firstAdapter.close();

  // A second adapter over the same state file stands in for a restarted service.
  const second = makeFakeClient();
  const secondAdapter = makeAdapter(state, second);
  const turn = await secondAdapter.sendTurn({
    bindingKey,
    workspaceRoot: state.workspace,
    text: "第二句",
    metadata,
  });

  assert.equal(turn.threadId, "srv-1", "the window keeps its session id across processes");
  assert.equal(turn.resumed, true);
  assert.deepEqual(
    second.calls.map((call) => call.method),
    ["initialize", "session/resume", "session/prompt"],
    "a restart must resume, not create",
  );
  assert.equal(second.calls.find((call) => call.method === "session/prompt").blocks[0].text, "第二句");
});

test("a resume that fails opens a session for the window rather than dying", async () => {
  const state = makeState();
  const first = makeFakeClient();
  const firstAdapter = makeAdapter(state, first);
  const bindingKey = bindingKeyOf(firstAdapter);
  const metadata = { conversationKey: "weflow:azzy" };
  await firstAdapter.sendTurn({ bindingKey, workspaceRoot: state.workspace, text: "第一句", metadata });
  await firstAdapter.close();

  const second = makeFakeClient({ resumeFails: true, newSessionIds: ["srv-new"] });
  const secondAdapter = makeAdapter(state, second);
  const turn = await secondAdapter.sendTurn({ bindingKey, workspaceRoot: state.workspace, text: "第二句", metadata });

  assert.equal(turn.threadId, "srv-new");
  assert.equal(turn.resumed, false);
  assert.deepEqual(second.calls.map((call) => call.method), ["initialize", "session/resume", "session/new", "session/prompt"]);
  assert.equal(
    secondAdapter.getSessionStore().getThreadIdForConversation(bindingKey, state.workspace, "weflow:azzy"),
    "srv-new",
    "the window's stored id must follow the session that actually serves it",
  );
});

test("two windows keep two independent sessions", async () => {
  const state = makeState();
  const fake = makeFakeClient();
  const adapter = makeAdapter(state, fake);
  const bindingKey = bindingKeyOf(adapter);

  const azzy = await adapter.sendTurn({
    bindingKey,
    workspaceRoot: state.workspace,
    text: "hi",
    metadata: { conversationKey: "weflow:azzy" },
  });
  const liu = await adapter.sendTurn({
    bindingKey,
    workspaceRoot: state.workspace,
    text: "hi",
    metadata: { conversationKey: "weflow:liu" },
  });

  assert.notEqual(azzy.threadId, liu.threadId);
  assert.equal(fake.calls.filter((call) => call.method === "session/new").length, 2);
});

test("session updates are mapped onto runtime events with the turn's id", async () => {
  const state = makeState();
  const fake = makeFakeClient();
  const adapter = makeAdapter(state, fake);
  const events = collect(adapter);
  const bindingKey = bindingKeyOf(adapter);

  const sent = [];
  fake.client.prompt = async (sessionId, blocks) => {
    sent.push({ sessionId, blocks });
    fake.client.emitUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "在的" },
    });
    fake.client.emitUpdate(sessionId, { sessionUpdate: "usage_update", used: 1, size: 10 });
    fake.client.emitUpdate(sessionId, { sessionUpdate: "session_info_update", title: "收-Ally <-> 发-Azzy" });
    return { stopReason: "end_turn" };
  };

  const turn = await adapter.sendTurn({
    bindingKey,
    workspaceRoot: state.workspace,
    text: "在吗",
    metadata: { conversationKey: "weflow:azzy" },
  });

  assert.deepEqual(events.map((event) => event.type), [
    "runtime.turn.started",
    "runtime.context.updated",
    "runtime.reply.completed",
    "runtime.turn.completed",
  ]);
  assert.equal(events[1].payload.title, "收-Ally <-> 发-Azzy");
  assert.equal(events[2].payload.text, "在的");
  assert.equal(events[2].payload.turnId, turn.turnId);
  assert.equal(events[2].payload.phase, "final_answer");
});

test("a failed prompt reports the turn as failed and still throws", async () => {
  const state = makeState();
  const fake = makeFakeClient();
  const adapter = makeAdapter(state, fake);
  const events = collect(adapter);
  fake.client.prompt = async () => {
    throw new Error("model refused");
  };

  await assert.rejects(
    () => adapter.sendTurn({
      bindingKey: bindingKeyOf(adapter),
      workspaceRoot: state.workspace,
      text: "hi",
      metadata: { conversationKey: "weflow:azzy" },
    }),
    /model refused/u,
  );
  assert.equal(events.at(-1).type, "runtime.turn.failed");
  assert.match(events.at(-1).payload.text, /model refused/u);
});

test("an approval request reaches the operator and the answer goes back to the agent", async () => {
  const state = makeState();
  const fake = makeFakeClient();
  const adapter = makeAdapter(state, fake);
  const events = collect(adapter);

  // The runtime (and with it the request handler) exists once a turn has run.
  await adapter.sendTurn({
    bindingKey: bindingKeyOf(adapter),
    workspaceRoot: state.workspace,
    text: "hi",
    metadata: { conversationKey: "weflow:azzy" },
  });
  events.length = 0;

  const pending = fake.client.askPermission({
    sessionId: "srv-1",
    toolCall: { toolCallId: "call-1", title: "run bash", rawInput: { command: "rm -rf build" } },
    options: [
      { optionId: "reject", kind: "reject_once" },
      { optionId: "allow", kind: "allow_once" },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "runtime.approval.requested");
  assert.equal(events[0].payload.command, "rm -rf build");
  assert.equal(events[0].payload.toolName, "run bash");

  const accepted = await adapter.respondApproval({ requestId: events[0].payload.requestId, decision: "allow" });
  assert.equal(accepted, true);
  assert.deepEqual(await pending, { outcome: { outcome: "selected", optionId: "allow" } });
  assert.equal(events.at(-1).type, "runtime.approval.decided");
  assert.equal(events.at(-1).payload.decision, "allow");
});

test("an unknown approval request is reported as unanswered", async () => {
  const state = makeState();
  const fake = makeFakeClient();
  const adapter = makeAdapter(state, fake);
  assert.equal(await adapter.respondApproval({ requestId: "nope", decision: "allow" }), false);
});

test("cancelTurn cancels the session instead of killing the runtime", async () => {
  const state = makeState();
  const fake = makeFakeClient();
  const adapter = makeAdapter(state, fake);
  const bindingKey = bindingKeyOf(adapter);
  const turn = await adapter.sendTurn({
    bindingKey,
    workspaceRoot: state.workspace,
    text: "hi",
    metadata: { conversationKey: "weflow:azzy" },
  });

  await adapter.cancelTurn({ threadId: turn.threadId });
  const cancel = fake.calls.find((call) => call.method === "notify:session/cancel");
  assert.deepEqual(cancel.params, { sessionId: "srv-1" });
});

test("startFreshThreadDraft forgets the window's session so the next turn creates one", async () => {  const state = makeState();
  const fake = makeFakeClient();
  const adapter = makeAdapter(state, fake);
  const bindingKey = bindingKeyOf(adapter);
  const metadata = { conversationKey: "weflow:azzy" };
  await adapter.sendTurn({ bindingKey, workspaceRoot: state.workspace, text: "第一句", metadata });

  await adapter.startFreshThreadDraft({
    bindingKey,
    workspaceRoot: state.workspace,
    conversationKey: "weflow:azzy",
  });
  assert.equal(
    adapter.getSessionStore().getThreadIdForConversation(bindingKey, state.workspace, "weflow:azzy"),
    "",
  );

  const turn = await adapter.sendTurn({ bindingKey, workspaceRoot: state.workspace, text: "新话题", metadata });
  assert.equal(fake.calls.filter((call) => call.method === "session/new").length, 2);
  assert.notEqual(turn.threadId, "srv-1");
});

test("prompt blocks carry text and only inline images", () => {
  assert.deepEqual(buildAcpContentBlocks({ text: "你好" }), [{ type: "text", text: "你好" }]);
  assert.deepEqual(buildAcpContentBlocks({ text: "   " }), []);
  assert.deepEqual(
    buildAcpContentBlocks({
      text: "看图",
      attachments: [
        { base64: "AAAA", mimeType: "image/png" },
        { data: "BBBB", mimeType: "application/pdf" },
        { mimeType: "image/jpeg" },
      ],
    }),
    [
      { type: "text", text: "看图" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
  );
});

test("an image on disk is inlined and anything else keeps its path visible", () => {
  const state = makeState();
  const pngPath = path.join(state.dir, "shot.png");
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const pdfPath = path.join(state.dir, "report.pdf");
  fs.writeFileSync(pdfPath, "pdf");

  assert.deepEqual(
    buildAcpContentBlocks({
      text: "看这张",
      attachments: [{ absolutePath: pngPath }, { absolutePath: pdfPath }],
    }),
    [
      { type: "text", text: "看这张" },
      { type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), mimeType: "image/png" },
      { type: "text", text: `[attachment] ${pdfPath}` },
    ],
  );
});

test("the approval policy follows the configured access mode", () => {
  assert.equal(resolveAcpPermissionMode({ codexAccessMode: "full-access" }), "danger-full-access");
  assert.equal(resolveAcpPermissionMode({ codexAccessMode: "workspace-write" }), "workspace-write");
  assert.equal(resolveAcpPermissionMode({}), "workspace-write");
});

test("a second turn for the same session waits instead of racing the server", async () => {
  const state = makeState();
  const fake = makeFakeClient();
  const adapter = makeAdapter(state, fake);
  const bindingKey = bindingKeyOf(adapter);
  const metadata = { conversationKey: "weflow:azzy" };

  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  fake.client.prompt = async (sessionId, blocks) => {
    order.push(`start:${blocks[0].text}`);
    if (order.length === 1) {
      await firstGate;
    }
    order.push(`end:${blocks[0].text}`);
    return { stopReason: "end_turn" };
  };

  const first = adapter.sendTurn({ bindingKey, workspaceRoot: state.workspace, text: "第一条", metadata });
  await new Promise((resolve) => setImmediate(resolve));
  const second = adapter.sendTurn({ bindingKey, workspaceRoot: state.workspace, text: "第二条", metadata });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["start:第一条"], "ACP refuses a concurrent prompt, so the second must wait");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["start:第一条", "end:第一条", "start:第二条", "end:第二条"]);
});

test("describe() reports the ACP surface honestly", () => {
  const state = makeState();
  const adapter = makeAdapter(state, makeFakeClient());
  const described = adapter.describe();
  assert.equal(described.id, "dsh-acp");
  assert.equal(described.protocol, "acp");
  assert.equal(described.limitations.approvalRespond, true);
  assert.equal(described.limitations.cancelTurn, "session-cancel");
  assert.equal(adapter.supportsExecutionPolicy(""), true);
  assert.equal(adapter.supportsExecutionPolicy("model_canary_deny_side_effects"), false);
  assert.deepEqual(adapter.getTurnCapabilities(), { nativeImageInput: true, toolImageRead: false });
});
