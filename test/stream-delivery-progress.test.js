const test = require("node:test");
const assert = require("node:assert/strict");

const { StreamDelivery } = require("../src/core/stream-delivery");

/**
 * 【进度】 used to depend on the model volunteering an interim text block. Codex
 * did that; DSH's model goes straight from reasoning to a tool call, so nothing
 * was ever rendered as progress. Tool events are the one genuinely live signal,
 * so progress is derived from them - throttled, because a multi-step turn raises
 * many.
 */
function createHarness(options = {}) {
  const sent = [];
  const streamDelivery = new StreamDelivery({
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
        return { verified: true, localId: String(sent.length) };
      },
      async sendFile(payload) {
        sent.push(payload);
        return { verified: true };
      },
      getKnownContextTokens() {
        return {};
      },
    },
    sessionStore: { findBindingForThreadId: () => null },
    ...options,
  });
  return { sent, streamDelivery };
}

function queueTarget(streamDelivery, threadId) {
  streamDelivery.queueReplyTargetForThread(threadId, {
    userId: "user-1",
    contextToken: "ctx-1",
    replyObligationId: `obligation-${threadId}`,
  });
}

async function startTurn(streamDelivery, threadId, turnId) {
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId, turnId },
  });
}

async function toolStarted(streamDelivery, { threadId, turnId, itemId, toolType, command }) {
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.tool.started",
    payload: { threadId, turnId, itemId, toolType, command },
  });
}

function progressMessages(sent) {
  return sent.filter((entry) => entry.messageKind === "progress");
}

test("a tool call reports progress even when the model wrote no interim text", async () => {
  const { sent, streamDelivery } = createHarness();
  queueTarget(streamDelivery, "thread-1");
  await startTurn(streamDelivery, "thread-1", "turn-1");

  await toolStarted(streamDelivery, {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "call-1",
    toolType: "pwsh",
    command: "Get-Date",
  });

  const progress = progressMessages(sent);
  assert.equal(progress.length, 1, "the first tool of a turn must report");
  assert.match(progress[0].text, /pwsh/u);
  assert.match(progress[0].text, /Get-Date/u);
});

test("further tools in the same turn are throttled", async () => {
  const { sent, streamDelivery } = createHarness();
  queueTarget(streamDelivery, "thread-2");
  await startTurn(streamDelivery, "thread-2", "turn-2");

  for (const index of [1, 2, 3, 4]) {
    await toolStarted(streamDelivery, {
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: `call-${index}`,
      toolType: "pwsh",
      command: `echo ${index}`,
    });
  }

  assert.equal(progressMessages(sent).length, 1,
    "a multi-step turn must not flood the chat with progress messages");
});

test("progress resumes once the throttle window has passed", async () => {
  const { sent, streamDelivery } = createHarness();
  queueTarget(streamDelivery, "thread-3");
  await startTurn(streamDelivery, "thread-3", "turn-3");

  await toolStarted(streamDelivery, {
    threadId: "thread-3", turnId: "turn-3", itemId: "call-a", toolType: "pwsh", command: "echo a",
  });
  assert.equal(progressMessages(sent).length, 1);

  for (const state of streamDelivery.stateByRunKey.values()) {
    state.toolProgressAtMs = Date.now() - 31_000;
  }
  await toolStarted(streamDelivery, {
    threadId: "thread-3", turnId: "turn-3", itemId: "call-b", toolType: "pwsh", command: "echo b",
  });
  assert.equal(progressMessages(sent).length, 2, "the window elapsing must re-enable progress");
});

test("progress never substitutes for the final reply", async () => {
  const { sent, streamDelivery } = createHarness();
  queueTarget(streamDelivery, "thread-4");
  await startTurn(streamDelivery, "thread-4", "turn-4");
  await toolStarted(streamDelivery, {
    threadId: "thread-4", turnId: "turn-4", itemId: "call-1", toolType: "pwsh", command: "echo hi",
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: { threadId: "thread-4", turnId: "turn-4", itemId: "answer", text: "done", phase: "final_answer" },
  });

  const progress = progressMessages(sent);
  const finals = sent.filter((entry) => entry.messageKind !== "progress");
  assert.equal(progress.length, 1);
  assert.equal(finals.length, 1, "the final answer must still be delivered in full");
  assert.equal(finals[0].text, "done");
});

test("a tool event with nothing to describe reports nothing", async () => {
  const { sent, streamDelivery } = createHarness();
  queueTarget(streamDelivery, "thread-5");
  await startTurn(streamDelivery, "thread-5", "turn-5");
  await toolStarted(streamDelivery, { threadId: "thread-5", turnId: "turn-5", itemId: "call-x" });
  assert.deepEqual(progressMessages(sent), []);
});

test("quick read-only inspection is not announced", async () => {
  // Every `read` used to produce a message, which turned one question into four
  // chat messages. These tools are steps, not progress worth reporting.
  for (const toolType of ["read", "grep", "glob", "Read"]) {
    const { sent, streamDelivery } = createHarness();
    queueTarget(streamDelivery, `thread-quiet-${toolType}`);
    const threadId = `thread-quiet-${toolType}`;
    await startTurn(streamDelivery, threadId, "turn-q");
    await toolStarted(streamDelivery, {
      threadId, turnId: "turn-q", itemId: "call-1", toolType, command: toolType,
    });
    assert.deepEqual(progressMessages(sent), [], `${toolType} must stay quiet`);
  }
});

test("a tool that describes itself by name is not repeated", async () => {
  const { sent, streamDelivery } = createHarness();
  queueTarget(streamDelivery, "thread-8");
  await startTurn(streamDelivery, "thread-8", "turn-8");
  await toolStarted(streamDelivery, {
    threadId: "thread-8", turnId: "turn-8", itemId: "call-1", toolType: "web_search", command: "web_search",
  });
  const progress = progressMessages(sent);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].text, "正在执行 web_search",
    "the status line must not repeat the tool name in parentheses");
});

test("a tool with a distinct command keeps it as context", async () => {
  const { sent, streamDelivery } = createHarness();
  queueTarget(streamDelivery, "thread-9");
  await startTurn(streamDelivery, "thread-9", "turn-9");
  await toolStarted(streamDelivery, {
    threadId: "thread-9", turnId: "turn-9", itemId: "call-1", toolType: "pwsh", command: "npm test",
  });
  assert.equal(progressMessages(sent)[0].text, "正在执行 pwsh（npm test）");
});

test("a silent delivery policy produces no progress at all", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-6", {
    userId: "user-1",
    contextToken: "ctx-1",
    deliveryPolicy: "silent",
  });
  await startTurn(streamDelivery, "thread-6", "turn-6");
  await toolStarted(streamDelivery, {
    threadId: "thread-6", turnId: "turn-6", itemId: "call-1", toolType: "pwsh", command: "echo hi",
  });
  assert.deepEqual(sent, [], "background turns must stay silent");
});

test("a long command is truncated rather than pasted whole", async () => {
  const { sent, streamDelivery } = createHarness();
  queueTarget(streamDelivery, "thread-7");
  await startTurn(streamDelivery, "thread-7", "turn-7");
  await toolStarted(streamDelivery, {
    threadId: "thread-7",
    turnId: "turn-7",
    itemId: "call-1",
    toolType: "pwsh",
    command: `Set-Content -LiteralPath 'C:\\very\\long\\path' -Value '${"x".repeat(400)}'`,
  });
  const progress = progressMessages(sent);
  assert.equal(progress.length, 1);
  assert.ok(progress[0].text.length < 200,
    `progress must stay a status line, got ${progress[0].text.length} chars`);
});
