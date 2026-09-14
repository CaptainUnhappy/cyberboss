const assert = require("node:assert/strict");
const test = require("node:test");

const { ApprovalEndpoint, DECIDE_PATH, tokenMatches } = require("../src/core/approval-endpoint");

/**
 * The endpoint is the only way a live tool escalation can become a grant, so
 * every failure path has to answer `unavailable` rather than let the caller
 * guess. These tests pin the boundary: authentication, method/route, body shape,
 * and the vocabulary check on whatever the decider returns.
 */
async function withEndpoint(t, decide, { logger } = {}) {
  const endpoint = new ApprovalEndpoint({ decide, logger: logger ?? silentLogger() });
  await endpoint.start();
  t.after(() => endpoint.close());
  return endpoint;
}

function silentLogger() {
  return { warn() {}, error() {}, log() {} };
}

async function post(endpoint, body, { token = endpoint.token, method = "POST", path = DECIDE_PATH } = {}) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

test("the endpoint binds loopback on an ephemeral port and exposes one route", async (t) => {
  const endpoint = await withEndpoint(t, async () => "rejected");
  assert.match(endpoint.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/approval\/decide$/u);
  assert.notEqual(endpoint.port, 0);
  assert.equal(endpoint.token.length, 64, "the token is 32 random bytes as hex");
});

test("an authenticated request returns the decider's outcome", async (t) => {
  const seen = [];
  const endpoint = await withEndpoint(t, async (request) => {
    seen.push(request);
    return "allowed-once";
  });
  const result = await post(endpoint, {
    toolName: "pwsh",
    callId: "call_00_abc",
    reason: "escalate sandbox to danger-full-access",
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.outcome, "allowed-once");
  assert.deepEqual(seen, [{
    toolName: "pwsh",
    callId: "call_00_abc",
    reason: "escalate sandbox to danger-full-access",
  }]);
});

test("a decider that throws fails closed instead of granting", async (t) => {
  const endpoint = await withEndpoint(t, async () => {
    throw new Error("helper runtime is gone");
  });
  const result = await post(endpoint, { toolName: "pwsh", callId: "c1", reason: "" });
  assert.equal(result.status, 200);
  assert.equal(result.payload.outcome, "unavailable");
});

test("an outcome outside the vocabulary is normalized to unavailable", async (t) => {
  // A decider returning e.g. "allow" or "allowed" must never be read as a grant.
  for (const value of ["allow", "allowed", "ALLOWED-ONCE", "yes", "", null, 42, { outcome: "allowed-once" }]) {
    const endpoint = await withEndpoint(t, async () => value);
    const result = await post(endpoint, { toolName: "pwsh", callId: "c1", reason: "" });
    assert.equal(
      result.payload.outcome,
      "unavailable",
      `outcome ${JSON.stringify(value)} must not be echoed as a grant`,
    );
  }
});

test("a missing or wrong bearer token is refused", async (t) => {
  let calls = 0;
  const endpoint = await withEndpoint(t, async () => {
    calls += 1;
    return "allowed-once";
  });
  const noToken = await post(endpoint, { toolName: "pwsh" }, { token: null });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.payload.outcome, "unavailable");

  const wrongToken = await post(endpoint, { toolName: "pwsh" }, { token: "0".repeat(64) });
  assert.equal(wrongToken.status, 401);
  assert.equal(wrongToken.payload.outcome, "unavailable");

  const shortToken = await post(endpoint, { toolName: "pwsh" }, { token: "abc" });
  assert.equal(shortToken.status, 401);

  assert.equal(calls, 0, "an unauthenticated request must never reach the decider");
});

test("only POST on the decide route is served", async (t) => {
  const endpoint = await withEndpoint(t, async () => "allowed-once");
  assert.equal((await post(endpoint, {}, { method: "GET" })).status, 404);
  assert.equal((await post(endpoint, {}, { path: "/" })).status, 404);
  assert.equal((await post(endpoint, {}, { path: "/approval/decide/extra" })).status, 404);
});

test("a malformed or empty body is refused", async (t) => {
  let calls = 0;
  const endpoint = await withEndpoint(t, async () => {
    calls += 1;
    return "allowed-once";
  });
  for (const body of ["", "   ", "not json", "[1,2,3]", '"a string"', "null"]) {
    const result = await post(endpoint, body);
    assert.equal(result.status, 400, `body ${JSON.stringify(body)} must be refused`);
    assert.equal(result.payload.outcome, "unavailable");
  }
  assert.equal(calls, 0);
});

test("an oversized body is refused rather than buffered", async (t) => {
  const endpoint = await withEndpoint(t, async () => "allowed-once");
  const result = await post(endpoint, JSON.stringify({ reason: "x".repeat(64 * 1024) }));
  assert.equal(result.status, 400);
  assert.equal(result.payload.outcome, "unavailable");
});

test("missing fields reach the decider as empty strings, never as undefined", async (t) => {
  let seen = null;
  const endpoint = await withEndpoint(t, async (request) => {
    seen = request;
    return "rejected";
  });
  await post(endpoint, {});
  assert.deepEqual(seen, { toolName: "", callId: "", reason: "" });
});

test("token comparison rejects a same-prefix token and an empty expectation", () => {
  const token = "a".repeat(64);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, `${"a".repeat(63)}b`), false);
  assert.equal(tokenMatches(token, `${token}extra`), false);
  assert.equal(tokenMatches("", ""), false, "an empty expectation must never authenticate");
  assert.equal(tokenMatches(token, ""), false);
  assert.equal(tokenMatches(token, undefined), false);
});

test("closing the endpoint releases the port", async () => {
  const endpoint = new ApprovalEndpoint({
    decide: async () => "rejected",
    logger: { warn() {}, error() {} },
  });
  await endpoint.start();
  const port = endpoint.port;
  await endpoint.close();
  assert.equal(endpoint.port, 0);
  assert.equal(endpoint.endpoint, "");
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}${DECIDE_PATH}`, { method: "POST" }),
    "the port must stop accepting connections",
  );
});
