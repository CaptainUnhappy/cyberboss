const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseDecision,
  buildDecisionPrompt,
  decideApprovalWithHelper,
  OUTCOME_ALLOW,
  OUTCOME_DENY,
  OUTCOME_UNAVAILABLE,
  DEFAULT_HELPER_PROFILE,
  DEFAULT_HELPER_PATCH,
} = require("../src/core/approval-decider");

/**
 * The decider grants permission exactly once, so its parsing is a security
 * boundary: anything ambiguous must refuse. `DENY\nALLOW` returning a grant was
 * a real bug in an earlier revision, and it is pinned here as a regression case.
 */
test("a verdict grants only on an unambiguous ALLOW", () => {
  const cases = [
    ["ALLOW", OUTCOME_ALLOW],
    ["allow", OUTCOME_ALLOW],
    ["Some reasoning...\nALLOW", OUTCOME_ALLOW],
    ["DENY", OUTCOME_DENY],
    ["Some reasoning...\nDENY", OUTCOME_DENY],
    ["The answer is DENY because the path is outside the workspace", OUTCOME_DENY],
    // both words: always a refusal, regardless of order (fail-open regression)
    ["ALLOW\nDENY", OUTCOME_DENY],
    ["DENY\nALLOW", OUTCOME_DENY],
    ["DENY\nALLOW\nDENY", OUTCOME_DENY],
    ["ALLOW and DENY", OUTCOME_DENY],
    // no verdict at all
    ["", OUTCOME_UNAVAILABLE],
    ["maybe?", OUTCOME_UNAVAILABLE],
    ["I cannot decide", OUTCOME_UNAVAILABLE],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseDecision(input), expected, JSON.stringify(input));
  }
});

test("the decision prompt carries the evidence a decider needs", () => {
  const prompt = buildDecisionPrompt({
    toolName: "pwsh",
    command: "Set-Content -Path 'C:\\out.txt' -Value x",
    justification: "the target path is outside the session workspace",
    requestedPermissions: "danger-full-access",
  });
  assert.match(prompt, /Tool: pwsh/u);
  assert.match(prompt, /Requested permissions: danger-full-access/u);
  assert.match(prompt, /Set-Content/u);
  assert.match(prompt, /outside the session workspace/u);
  assert.match(prompt, /ALLOW.*DENY|"ALLOW" or "DENY"/u);
});

test("the prompt states the command is unavailable rather than implying safety", () => {
  const prompt = buildDecisionPrompt({ toolName: "pwsh" });
  assert.match(prompt, /Command: \(not available\)/u,
    "a missing command must be explicit, never silently omitted");
});

test("the helper runs the constrained profile with the no-tools overlay", async () => {
  let captured = null;
  const outcome = await decideApprovalWithHelper({
    toolName: "pwsh",
    createClient(config) {
      captured = config;
      return {
        onNotification() {},
        async initialize() { throw new Error("stop here"); },
        async prompt() {},
        async close() {},
      };
    },
    logger: { error() {} },
  });
  assert.equal(outcome, OUTCOME_UNAVAILABLE, "a failing helper fails closed");
  assert.equal(captured.profile, DEFAULT_HELPER_PROFILE);
  assert.deepEqual(captured.patchPaths, [DEFAULT_HELPER_PATCH],
    "the helper must load the overlay that disables every tool plugin");
});

test("decider failures and timeouts all resolve to unavailable", async () => {
  const makeClient = (behaviour) => () => ({
    onNotification() {},
    initialize: behaviour.initialize,
    prompt: behaviour.prompt,
    close: async () => {},
  });

  const throwing = await decideApprovalWithHelper({
    createClient: makeClient({ initialize: async () => { throw new Error("boom"); }, prompt: async () => {} }),
    logger: { error() {} },
  });
  assert.equal(throwing, OUTCOME_UNAVAILABLE);

  // A turn that never ends must not stall the caller.
  const hanging = await decideApprovalWithHelper({
    timeoutMs: 200,
    createClient: makeClient({ initialize: async () => {}, prompt: async () => {} }),
    logger: { error() {} },
  });
  assert.equal(hanging, OUTCOME_UNAVAILABLE);
});

test("a real verdict from the helper is honoured, including a denial", async () => {
  const respond = (text) => () => {
    const listeners = [];
    return {
      onNotification(listener) { listeners.push(listener); },
      async initialize() {},
      async prompt() {
        setImmediate(() => {
          for (const listener of listeners) {
            listener("session.event", {
              sessionId: "s",
              event: { type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } },
            });
            listener("session.event", { sessionId: "s", event: { type: "turn/end", data: {} } });
          }
        });
      },
      async close() {},
    };
  };

  assert.equal(
    await decideApprovalWithHelper({ createClient: respond("ALLOW"), logger: { error() {} } }),
    OUTCOME_ALLOW,
  );
  assert.equal(
    await decideApprovalWithHelper({ createClient: respond("DENY"), logger: { error() {} } }),
    OUTCOME_DENY,
  );
});
