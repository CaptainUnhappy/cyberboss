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
    await Answerer.prototype.answer.call(hanging, {}, async () => "allowed-once"),
    "unavailable",
    "a decider that never answers must not stall the turn",
  );
});
