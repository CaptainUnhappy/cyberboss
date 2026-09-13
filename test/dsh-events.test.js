const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapDshSessionEvent,
  extractAssistantText,
  listAssistantToolCalls,
  describeToolCall,
  parseToolArguments,
  approvalOutcomeToDecision,
  buildCommandTokens,
} = require("../src/adapters/runtime/dsh/events");

// Payload shapes below are copied from a live `dsh --profile sdk` capture.
// See docs/dsh-sdk-protocol-notes.md.

function sessionEvent(sessionId, event) {
  return { sessionId, event };
}

test("turn/start maps to runtime.turn.started", () => {
  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "turn/start",
    seq: 4,
    time: 1,
    data: { turn: 1 },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "runtime.turn.started");
  assert.equal(events[0].payload.threadId, "s1");
  assert.equal(events[0].payload.turnId, "1");
});

test("turn/end completed maps to runtime.turn.completed", () => {
  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "turn/end",
    seq: 12,
    data: { turn: 1, reason: { kind: "completed" } },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "runtime.turn.completed");
  assert.equal(events[0].payload.turnId, "1");
});

test("turn/end failure kinds map to runtime.turn.failed with the reason", () => {
  for (const kind of ["error", "max-tokens", "blocked"]) {
    const events = mapDshSessionEvent(sessionEvent("s1", {
      type: "turn/end",
      data: { turn: 2, reason: { kind } },
    }));
    assert.equal(events.length, 1, kind);
    assert.equal(events[0].type, "runtime.turn.failed", kind);
    assert.match(events[0].payload.text, new RegExp(kind));
    assert.equal(events[0].payload.turnId, "2");
  }
});

test("interrupted turn reports interruption rather than a generic failure", () => {
  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "turn/end",
    data: { turn: 3, reason: { kind: "aborted" } },
  }));
  assert.equal(events[0].type, "runtime.turn.failed");
  assert.match(events[0].payload.text, /interrupted/);
});

test("assistant/message with text maps to runtime.reply.completed", () => {
  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "DSH_PROBE_OK" }],
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" },
        id: "e63cfd68-c701-40c0-a574-90f5e83840ed",
      },
      usage: { inputTokens: 202, outputTokens: 6 },
    },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "runtime.reply.completed");
  assert.equal(events[0].payload.text, "DSH_PROBE_OK");
  assert.equal(events[0].payload.itemId, "e63cfd68-c701-40c0-a574-90f5e83840ed");
});

test("assistant/message carrying only a tool-call emits tool.started and no reply", () => {
  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [{
          type: "tool-call",
          id: "call_00_vTT2Mrj6D5yMJTp1ntWZ3161",
          name: "pwsh",
          arguments: JSON.stringify({
            command: "echo DSH_TOOL_PROBE",
            description: "Run the probe command",
          }),
        }],
        id: "msg-1",
      },
    },
  }));
  assert.equal(events.length, 1, "a tool-only step must not fabricate an assistant reply");
  assert.equal(events[0].type, "runtime.tool.started");
  assert.equal(events[0].payload.itemId, "call_00_vTT2Mrj6D5yMJTp1ntWZ3161");
  assert.equal(events[0].payload.toolType, "pwsh");
  assert.match(events[0].payload.command, /echo DSH_TOOL_PROBE/);
});

test("a step with both reasoning and a tool-call still emits no reply text", () => {
  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 2,
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "considering" },
          { type: "tool-call", id: "c1", name: "pwsh", arguments: "{\"command\":\"ls\"}" },
        ],
        id: "msg-2",
      },
    },
  }));
  assert.deepEqual(events.map((event) => event.type), ["runtime.tool.started"]);
});

test("assistant/message joins multiple text blocks", () => {
  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "assistant/message",
    data: {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }],
        id: "m",
      },
    },
  }));
  assert.equal(events[0].payload.text, "part one part two");
});

test("tool/call records the callId so a later approval can resolve its command", () => {
  const context = { pendingToolCalls: new Map() };
  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "tool/call",
    data: {
      turn: 1,
      step: 2,
      callId: "call_00_oQC7oJ07kThwS1yzbxnK0439",
      name: "pwsh",
      arguments: JSON.stringify({
        command: "Set-Content -Path 'C:\\tmp\\x.txt' -Value y",
        description: "Retry probe write with full access",
        justification: "The target path is outside the session workspace",
        sandbox_permissions: "danger-full-access",
      }),
    },
  }), context);
  assert.equal(events[0].type, "runtime.tool.started");
  assert.equal(context.pendingToolCalls.size, 1);
  assert.ok(context.pendingToolCalls.has("call_00_oQC7oJ07kThwS1yzbxnK0439"));
});

test("approval/asked resolves its tool-call via callId into a decidable approval event", () => {
  const context = { pendingToolCalls: new Map() };
  // Pre-record the paired tool/call, exactly as the live stream delivers it.
  context.pendingToolCalls.set("call_00_oQC7oJ07kThwS1yzbxnK0439", {
    id: "call_00_oQC7oJ07kThwS1yzbxnK0439",
    name: "pwsh",
    arguments: JSON.stringify({
      command: "Set-Content -Path 'C:\\Users\\x\\Temp\\p.txt' -Value DSH_APPROVAL_PROBE",
      description: "Retry probe write with full access",
      justification: "The target path is outside the session workspace, so the workspace-write sandbox denied it",
      sandbox_permissions: "danger-full-access",
    }),
  });

  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "approval/asked",
    seq: 21,
    data: {
      id: "b40c3706-8b7c-4593-a58a-88bc117924bc",
      toolName: "pwsh",
      callId: "call_00_oQC7oJ07kThwS1yzbxnK0439",
      reason: "escalate sandbox to danger-full-access: The target path is outside the session workspace",
    },
  }), context);

  assert.equal(events.length, 1);
  const payload = events[0].payload;
  assert.equal(events[0].type, "runtime.approval.requested");
  assert.equal(payload.requestId, "b40c3706-8b7c-4593-a58a-88bc117924bc");
  assert.equal(payload.callId, "call_00_oQC7oJ07kThwS1yzbxnK0439");
  assert.equal(payload.toolName, "pwsh");
  // The decider needs the real command, the justification, and the requested level.
  assert.match(payload.command, /Set-Content/);
  assert.match(payload.justification, /outside the session workspace/);
  assert.equal(payload.requestedPermissions, "danger-full-access");
  assert.match(payload.reason, /escalate sandbox to danger-full-access/);
  assert.ok(payload.commandTokens.includes("pwsh"));
});

test("approval/asked without a recorded callId still produces a decidable event", () => {
  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "approval/asked",
    data: { id: "req-1", toolName: "pwsh", reason: "escalate" },
  }), { pendingToolCalls: new Map() });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.command, "");
  assert.equal(events[0].payload.requestedPermissions, "");
  assert.equal(events[0].payload.toolName, "pwsh");
});

test("approval/decided maps the closed outcome vocabulary", () => {
  const cases = [
    ["allowed-once", "approved"],
    ["rejected", "denied"],
    ["cancelled", "cancelled"],
    ["unavailable", "unavailable"],
  ];
  for (const [outcome, decision] of cases) {
    const events = mapDshSessionEvent(sessionEvent("s1", {
      type: "approval/decided",
      data: { id: "req-1", outcome },
    }));
    assert.equal(events[0].type, "runtime.approval.decided", outcome);
    assert.equal(events[0].payload.decision, decision, outcome);
  }
});

test("session/title maps to a context update", () => {
  const events = mapDshSessionEvent(sessionEvent("s1", {
    type: "session/title",
    data: { title: "Reply with exactly: DSH_PROBE_OK", messageSeqs: [8], source: { kind: "fallback" } },
  }));
  assert.equal(events[0].type, "runtime.context.updated");
  assert.equal(events[0].payload.title, "Reply with exactly: DSH_PROBE_OK");
});

test("unknown and shape-only event types are ignored rather than guessed at", () => {
  for (const type of ["step/start", "step/end", "agent/inbox/spliced", "request/context",
    "permission/preset", "sandbox/mode", "approval/policy", "user/message", "system/message"]) {
    const events = mapDshSessionEvent(sessionEvent("s1", { type, data: {} }));
    assert.deepEqual(events, [], type);
  }
});

test("a malformed envelope yields no events instead of throwing", () => {
  assert.deepEqual(mapDshSessionEvent(null), []);
  assert.deepEqual(mapDshSessionEvent({}), []);
  assert.deepEqual(mapDshSessionEvent({ sessionId: "s", event: {} }), []);
});

test("turnId from context wins over the event's own turn number", () => {
  const events = mapDshSessionEvent(
    sessionEvent("s1", { type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } }),
    { turnId: "cyberboss-turn-1" },
  );
  assert.equal(events[0].payload.turnId, "cyberboss-turn-1");
});

test("parseToolArguments tolerates objects, JSON strings, and garbage", () => {
  assert.deepEqual(parseToolArguments({ command: "x" }), { command: "x" });
  assert.deepEqual(parseToolArguments("{\"command\":\"x\"}"), { command: "x" });
  assert.equal(parseToolArguments("not json"), null);
  assert.equal(parseToolArguments(""), null);
  assert.equal(parseToolArguments(null), null);
  assert.equal(parseToolArguments("[1,2]"), null, "arrays are not an arguments object");
});

test("approvalOutcomeToDecision fails closed for unrecognized outcomes", () => {
  assert.equal(approvalOutcomeToDecision("allowed-once"), "approved");
  assert.equal(approvalOutcomeToDecision("rejected"), "denied");
  assert.equal(approvalOutcomeToDecision(""), "unknown");
  assert.equal(approvalOutcomeToDecision("something-new"), "something-new");
});

test("helpers expose the pieces the adapter and approval decider rely on", () => {
  const message = {
    content: [
      { type: "text", text: "hello" },
      { type: "tool-call", id: "c1", name: "pwsh", arguments: "{\"command\":\"ls\"}" },
    ],
  };
  assert.equal(extractAssistantText(message), "hello");
  assert.equal(listAssistantToolCalls(message).length, 1);
  assert.equal(describeToolCall({ name: "pwsh", arguments: "{\"command\":\"ls -la\"}" }), "pwsh: ls -la");
  assert.deepEqual(buildCommandTokens({ toolName: "pwsh", command: "ls -la" }), ["pwsh", "ls", "-la"]);
});
