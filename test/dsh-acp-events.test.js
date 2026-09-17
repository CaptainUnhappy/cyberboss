const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AcpTurnMapper,
  buildPermissionResponse,
  mapPermissionDecision,
  mapPermissionRequest,
  selectPermissionOption,
} = require("../src/adapters/runtime/dsh-acp/events");

function textChunk(text) {
  return { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } };
}

test("chunks accumulate into one final reply and are never emitted twice", () => {
  const mapper = new AcpTurnMapper({ threadId: "s1", turnId: "t1" });
  assert.deepEqual(mapper.mapUpdate(textChunk("你")), []);
  assert.deepEqual(mapper.mapUpdate(textChunk("好")), []);

  const events = mapper.finish();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "runtime.reply.completed");
  assert.equal(events[0].payload.text, "你好");
  assert.equal(events[0].payload.phase, "final_answer");
  assert.equal(events[0].payload.threadId, "s1");
  assert.equal(events[0].payload.turnId, "t1");
  assert.equal(events[1].type, "runtime.turn.completed");

  // A second finish must not repeat the reply.
  assert.deepEqual(mapper.finish().map((event) => event.type), ["runtime.turn.completed"]);
});

test("text written before a tool call is interim, not the answer", () => {
  const mapper = new AcpTurnMapper({ threadId: "s1", turnId: "t1" });
  mapper.mapUpdate(textChunk("我先查一下"));
  const events = mapper.mapUpdate({
    sessionId: "s1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "bash",
      kind: "execute",
      rawInput: { command: "git status" },
    },
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "runtime.reply.completed");
  assert.equal(events[0].payload.phase, "commentary");
  assert.equal(events[0].payload.text, "我先查一下");
  assert.equal(events[1].type, "runtime.tool.started");
  assert.equal(events[1].payload.itemId, "call-1");
  assert.equal(events[1].payload.toolType, "bash");
  assert.equal(events[1].payload.command, "git status");
  assert.equal(mapper.pendingToolCalls.get("call-1").name, "bash");

  const final = mapper.finish();
  assert.deepEqual(final.map((event) => event.type), ["runtime.turn.completed"]);
});

test("reply item ids are stable per turn and unique per flush", () => {
  const mapper = new AcpTurnMapper({ threadId: "s1", turnId: "t1" });
  mapper.mapUpdate(textChunk("第一段"));
  const commentary = mapper.mapUpdate({
    sessionId: "s1",
    update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "bash" },
  });
  mapper.mapUpdate(textChunk("第二段"));
  const final = mapper.finish();

  const ids = [commentary[0].payload.itemId, final[0].payload.itemId];
  assert.deepEqual(ids, ["t1:text:1", "t1:text:2"]);
});

test("thinking, token accounting and unknown updates are dropped", () => {
  const mapper = new AcpTurnMapper({ threadId: "s1", turnId: "t1" });
  const ignored = [
    { sessionId: "s1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } } },
    { sessionId: "s1", update: { sessionUpdate: "usage_update", used: 10, size: 100 } },
    { sessionId: "s1", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" } },
    { sessionId: "s1", update: {} },
    { sessionId: "s1" },
  ];
  for (const params of ignored) {
    assert.deepEqual(mapper.mapUpdate(params), []);
  }
  assert.equal(mapper.textBuffer, "");
});

test("a session title update becomes a context update", () => {
  const mapper = new AcpTurnMapper({ threadId: "s1", turnId: "t1" });
  const events = mapper.mapUpdate({
    sessionId: "s1",
    update: { sessionUpdate: "session_info_update", title: "收-Ally <-> 发-Azzy" },
  });
  assert.deepEqual(events, [{
    type: "runtime.context.updated",
    payload: { threadId: "s1", title: "收-Ally <-> 发-Azzy" },
  }]);
  assert.deepEqual(
    mapper.mapUpdate({ sessionId: "s1", update: { sessionUpdate: "session_info_update", title: "" } }),
    [],
  );
});

test("a failed turn reports the reason instead of completion", () => {
  const mapper = new AcpTurnMapper({ threadId: "s1", turnId: "t1" });
  mapper.mapUpdate(textChunk("半句"));
  const events = mapper.finish({ failed: true, reason: "model refused" });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "runtime.reply.completed");
  assert.equal(events[1].type, "runtime.turn.failed");
  assert.equal(events[1].payload.text, "model refused");
});

test("an empty turn completes without inventing a reply", () => {
  const mapper = new AcpTurnMapper({ threadId: "s1", turnId: "t1" });
  assert.deepEqual(mapper.finish().map((event) => event.type), ["runtime.turn.completed"]);
});

test("a permission request becomes the approval payload the flow already renders", () => {
  const pendingToolCalls = new Map([
    ["call-7", { id: "call-7", name: "bash", arguments: { command: "rm -rf build" } }],
  ]);
  const event = mapPermissionRequest({
    requestId: "req-7",
    sessionId: "s1",
    toolCall: { toolCallId: "call-7", title: "run bash" },
    options: [{ optionId: "a1", kind: "allow_once" }],
  }, { threadId: "s1", turnId: "t1", pendingToolCalls });

  assert.equal(event.type, "runtime.approval.requested");
  assert.equal(event.payload.kind, "command");
  assert.equal(event.payload.requestId, "req-7");
  assert.equal(event.payload.threadId, "s1");
  assert.equal(event.payload.turnId, "t1");
  assert.equal(event.payload.callId, "call-7");
  assert.equal(event.payload.toolName, "run bash");
  assert.equal(event.payload.command, "rm -rf build");
  assert.equal(event.payload.reason, "run bash");
  assert.deepEqual(event.payload.commandTokens, ["run bash", "rm", "-rf", "build"]);
});

test("a permission request without a pending call still yields a usable payload", () => {
  const event = mapPermissionRequest({
    requestId: "req-8",
    toolCall: { toolCallId: "call-8", title: "write file", rawInput: { path: "D:/x" } },
  }, { threadId: "s1", turnId: "t1" });
  assert.equal(event.payload.toolName, "write file");
  assert.equal(event.payload.command, "");
  assert.match(event.payload.commandTokens.join(" "), /write file/u);
});

test("the decision picks an option by kind, never by position", () => {
  const options = [
    { optionId: "always", kind: "allow_always" },
    { optionId: "once", kind: "allow_once" },
  ];
  assert.equal(selectPermissionOption(options, "allow"), "once");
  assert.equal(selectPermissionOption([...options].reverse(), "allow"), "once");
  assert.equal(selectPermissionOption([{ optionId: "no", kind: "reject_once" }], "allow"), "");
  assert.equal(selectPermissionOption([{ optionId: "no", kind: "reject_once" }], "deny"), "no");
  assert.equal(selectPermissionOption(null, "allow"), "");
});

test("a response without a usable option cancels rather than faking a decision", () => {
  assert.deepEqual(
    buildPermissionResponse({ optionId: "once", decision: "allow" }),
    { outcome: { outcome: "selected", optionId: "once" } },
  );
  assert.deepEqual(
    buildPermissionResponse({ decision: "allow" }),
    { outcome: { outcome: "cancelled" } },
  );
});

test("a decided approval is reported with its request id and outcome", () => {
  assert.deepEqual(
    mapPermissionDecision({ requestId: "req-7", optionId: "once", decision: "allow" }),
    {
      type: "runtime.approval.decided",
      payload: { requestId: "req-7", decision: "allow", outcome: "once" },
    },
  );
});
