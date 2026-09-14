const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const projectRoot = path.join(__dirname, "..");
const pluginEntry = path.join(projectRoot, "dsh-plugins", "cyberboss-approval", "src", "index.js");

/**
 * The approval answerer must participate in DSH's real `approval/request`
 * waterfall, not merely exist as source. These tests load it against the real
 * cordis runtime that DSH uses, so a wrong registration shape fails here rather
 * than silently composing no answerer (which would look like fail-closed
 * behaviour and be very hard to notice).
 *
 * The plugin is ESM while this suite is CJS, hence the dynamic import.
 */
async function loadPlugin() {
  const cordis = await import("@deepseek-ai/cordis");
  const mod = await import(pathToFileURL(pluginEntry).href);
  return { Service: cordis.Service, Context: cordis.Context, Answerer: mod.default };
}

test("the answerer constructs against the real cordis Service base", async () => {
  const { Context, Answerer } = await loadPlugin();
  const ctx = new Context();
  const plugin = new Answerer(ctx, { mode: "session" });
  assert.equal(plugin.name, "cyberbossApproval",
    "the service must register under its own name");
  assert.equal(typeof plugin.answer, "function");
});

test("the answerer claims a real approval/request dispatched on the waterfall", async () => {
  const { Context, Answerer } = await loadPlugin();
  const ctx = new Context();
  // eslint-disable-next-line no-new -- the constructor registers the listener
  new Answerer(ctx, { mode: "session" });

  // Drive the exact dispatch DSH's ApprovalService performs.
  const outcome = await ctx.waterfall(
    "approval/request",
    { toolName: "pwsh", reason: "fixture escalation" },
    async () => "allowed-once",
  );

  assert.equal(outcome, "unavailable",
    "with no decider endpoint the stub must fail closed, and it must win over the "
    + "downstream answerer rather than delegating");
});

test("mode never rejects deterministically without consulting any decider", async () => {
  const { Context, Answerer } = await loadPlugin();
  const ctx = new Context();
  // eslint-disable-next-line no-new
  new Answerer(ctx, { mode: "never" });

  const outcome = await ctx.waterfall(
    "approval/request",
    { toolName: "pwsh" },
    async () => "allowed-once",
  );
  assert.equal(outcome, "rejected");
});

test("a value outside the outcome vocabulary is normalised to unavailable", async () => {
  const { Answerer } = await loadPlugin();
  const warnings = [];
  const ctx = {
    on() { return () => true; },
    logger: { warn: (message) => warnings.push(String(message)) },
  };
  const plugin = Object.create(Answerer.prototype);
  Object.assign(plugin, {
    config: { mode: "session", endpoint: "http://127.0.0.1:1/decide", timeoutMs: 500 },
    mode: "session",
    endpoint: "http://127.0.0.1:1/decide",
    timeoutMs: 500,
    ctx,
  });
  plugin.decide = async () => "definitely-allowed";

  const outcome = await Answerer.prototype.answer.call(plugin, { toolName: "pwsh" }, async () => "rejected");
  assert.equal(outcome, "unavailable",
    "an unknown verdict must fail closed, never become a grant");
  assert.equal(warnings.length >= 1, true, "the rejection must be logged");
});

test("a throwing or timing-out decider fails closed", async () => {
  const { Answerer } = await loadPlugin();
  const ctx = { on() { return () => true; }, logger: { warn() {} } };
  const base = {
    config: { mode: "session", endpoint: "http://127.0.0.1:1/decide", timeoutMs: 30 },
    mode: "session",
    endpoint: "http://127.0.0.1:1/decide",
    timeoutMs: 30,
    ctx,
  };

  const throwing = Object.assign(Object.create(Answerer.prototype), base, {
    decide: async () => { throw new Error("decider exploded"); },
  });
  assert.equal(
    await Answerer.prototype.answer.call(throwing, {}, async () => "allowed-once"),
    "unavailable",
  );

  const hanging = Object.assign(Object.create(Answerer.prototype), base, {
    decide: () => new Promise(() => {}),
  });
  assert.equal(
    await Answerer.prototype.answer.call(hanging, {}, async () => "unavailable"),
    "unavailable",
    "a decider that never answers must not stall the turn",
  );
});

/**
 * The transport is the half that cannot be proven by types: the plugin has to
 * reach the Cyberboss endpoint over a real socket, with the real header, and map
 * the real response. These tests run the plugin's own `decide()` against a real
 * ApprovalEndpoint rather than a stub.
 */
async function withRealEndpoint(t, decide) {
  const { ApprovalEndpoint } = require("../src/core/approval-endpoint");
  const endpoint = new ApprovalEndpoint({
    decide,
    logger: { warn() {}, error() {}, log() {} },
  });
  await endpoint.start();
  t.after(() => endpoint.close());
  return endpoint;
}

test("decide() posts the callId and maps the endpoint's outcome", async (t) => {
  const seen = [];
  const endpoint = await withRealEndpoint(t, async (request) => {
    seen.push(request);
    return "allowed-once";
  });
  const { Context, Answerer } = await loadPlugin();
  const ctx = new Context();
  const plugin = new Answerer(ctx, {
    mode: "session",
    endpoint: endpoint.endpoint,
    token: endpoint.token,
  });

  // Driven through decide() directly so the asserted shape is the wire payload.
  assert.equal(await plugin.decide({ toolName: "pwsh", callId: "call_00_x", reason: "why" }), "allowed-once");
  // The event carries no tool arguments, so nothing beyond these three may cross.
  assert.deepEqual(seen, [{ toolName: "pwsh", callId: "call_00_x", reason: "why" }]);
});

test("the answerer grants exactly when a real endpoint says allowed-once", async (t) => {
  const endpoint = await withRealEndpoint(t, async () => "allowed-once");
  const { Context, Answerer } = await loadPlugin();
  const ctx = new Context();
  // eslint-disable-next-line no-new -- the constructor registers the listener
  new Answerer(ctx, {
    mode: "session",
    endpoint: endpoint.endpoint,
    token: endpoint.token,
  });

  const outcome = await ctx.waterfall(
    "approval/request",
    { toolName: "pwsh", callId: "call_00_y", reason: "fixture escalation" },
    async () => "rejected",
  );
  assert.equal(outcome, "allowed-once",
    "a granted decision must reach the waterfall, not be swallowed by the plugin");
});

test("a real endpoint that rejects yields rejected, and a 401 yields unavailable", async (t) => {
  const { Context, Answerer } = await loadPlugin();

  const denying = await withRealEndpoint(t, async () => "rejected");
  const denyCtx = new Context();
  // eslint-disable-next-line no-new
  new Answerer(denyCtx, { mode: "session", endpoint: denying.endpoint, token: denying.token });
  assert.equal(
    await denyCtx.waterfall("approval/request", { toolName: "pwsh" }, async () => "allowed-once"),
    "rejected",
  );

  // A token mismatch must not degrade into a grant or into `rejected`: it is an
  // unavailable decider, which is the fail-closed outcome.
  const guarded = await withRealEndpoint(t, async () => "allowed-once");
  const wrongCtx = new Context();
  // eslint-disable-next-line no-new
  new Answerer(wrongCtx, { mode: "session", endpoint: guarded.endpoint, token: "0".repeat(64) });
  assert.equal(
    await wrongCtx.waterfall("approval/request", { toolName: "pwsh" }, async () => "rejected"),
    "unavailable",
  );
});

test("the endpoint and token fall back to the spawn environment", async (t) => {
  const endpoint = await withRealEndpoint(t, async () => "allowed-once");
  const previousEndpoint = process.env.CYBERBOSS_DSH_APPROVAL_ENDPOINT;
  const previousToken = process.env.CYBERBOSS_DSH_APPROVAL_TOKEN;
  process.env.CYBERBOSS_DSH_APPROVAL_ENDPOINT = endpoint.endpoint;
  process.env.CYBERBOSS_DSH_APPROVAL_TOKEN = endpoint.token;
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.CYBERBOSS_DSH_APPROVAL_ENDPOINT;
    else process.env.CYBERBOSS_DSH_APPROVAL_ENDPOINT = previousEndpoint;
    if (previousToken === undefined) delete process.env.CYBERBOSS_DSH_APPROVAL_TOKEN;
    else process.env.CYBERBOSS_DSH_APPROVAL_TOKEN = previousToken;
  });

  const { Context, Answerer } = await loadPlugin();
  const ctx = new Context();
  // No transport in config at all: the per-spawn environment must supply it.
  // eslint-disable-next-line no-new
  new Answerer(ctx, { mode: "session" });
  assert.equal(
    await ctx.waterfall("approval/request", { toolName: "pwsh" }, async () => "rejected"),
    "allowed-once",
  );
});

test("a half-configured transport fails closed instead of calling out", async () => {
  const { Context, Answerer } = await loadPlugin();
  // The environment fallback is exercised by another test in this file, so it
  // must be cleared here or a half-configured case would look configured.
  const savedEndpoint = process.env.CYBERBOSS_DSH_APPROVAL_ENDPOINT;
  const savedToken = process.env.CYBERBOSS_DSH_APPROVAL_TOKEN;
  delete process.env.CYBERBOSS_DSH_APPROVAL_ENDPOINT;
  delete process.env.CYBERBOSS_DSH_APPROVAL_TOKEN;
  try {
    for (const config of [
      { mode: "session", endpoint: "http://127.0.0.1:1/decide", token: "" },
      { mode: "session", endpoint: "", token: "a".repeat(64) },
    ]) {
      const plugin = new Answerer(new Context(), config);
      let called = false;
      plugin.decide = async () => { called = true; return "allowed-once"; };
      assert.equal(
        await plugin.answer({ toolName: "pwsh" }, async () => "allowed-once"),
        "unavailable",
      );
      assert.equal(called, false, "an incomplete transport must not attempt a call");
    }
  } finally {
    if (savedEndpoint !== undefined) process.env.CYBERBOSS_DSH_APPROVAL_ENDPOINT = savedEndpoint;
    if (savedToken !== undefined) process.env.CYBERBOSS_DSH_APPROVAL_TOKEN = savedToken;
  }
});
