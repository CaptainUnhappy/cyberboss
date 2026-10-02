#!/usr/bin/env node
/**
 * Offline tests for the MCP transport.
 *
 * What matters here is not "does it speak MCP" (that is measured live in
 * scripts/cua-wechat-*-live.js) but the two promises the channel now depends on:
 *
 *   1. an MCP answer is mapped into the exact payload shape `cua-driver call` prints,
 *      refusals included - `client.js` matches on `payload.refusal.code`;
 *   2. the fast path is an optimisation, never a dependency: anything that goes wrong
 *      falls back to the CLI for that call and disables the fast path for a cooldown,
 *      so a broken worker degrades to the old behaviour instead of going mute.
 *
 * Run: node --test test/wechat-cua-mcp-transport.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createMcpTransport } = require("../src/integrations/wechat-cua/mcp-transport");
const { toCliPayload } = require("../src/integrations/wechat-cua/mcp-transport-worker");

/** A worker that cannot be talked to at all (spawn died / port closed). */
const brokenWorkerFactory = () => ({
  postMessage() { throw new Error("worker is gone"); },
  on() {},
  unref() {},
  terminate() {},
});

test("a successful MCP answer becomes the CLI payload the client parses", () => {
  const payload = toCliPayload({
    result: {
      content: [{ type: "text", text: "22 windows" }],
      structuredContent: { elements: [{ role: "Edit" }], element_count: 1, snapshot_id: "s1" },
    },
  });
  assert.equal(payload.element_count, 1);
  assert.equal(payload.elements[0].role, "Edit");
  assert.equal(payload.__failed, undefined, "a success must not look like a failure");
});

test("an MCP refusal keeps its refusal code where the client looks for it", () => {
  const payload = toCliPayload({
    result: {
      isError: true,
      content: [{ type: "text", text: "element_token is stale; call get_window_state again" }],
      structuredContent: { refusal: { code: "stale_element_token", message: "element_token is stale" }, status: "refused" },
    },
  });
  assert.equal(payload.__failed, true);
  assert.equal(payload.refusal, undefined, "the refusal lives under payload, as the CLI prints it");
  assert.equal(payload.payload.refusal.code, "stale_element_token");
});

test("a tool error without a refusal keeps its code and its message", () => {
  const payload = toCliPayload({
    result: {
      isError: true,
      content: [{ type: "text", text: "the window is minimized" }],
      structuredContent: { code: "window_minimized", effect: "refused" },
    },
  });
  assert.equal(payload.__failed, true);
  assert.equal(payload.payload.refusal.code, "window_minimized");
  assert.match(payload.payload.refusal.message, /minimized/);
});

test("a JSON-RPC level error is a failure with readable text", () => {
  const payload = toCliPayload({ error: { code: -32000, message: "daemon is not running" } });
  assert.equal(payload.__failed, true);
  assert.match(String(payload.payload), /daemon is not running/);
});

test("only tool calls take the fast path; lifecycle commands stay on the CLI", () => {
  const cliCalls = [];
  const exec = createMcpTransport({
    cliExec: (driver, args, input) => { cliCalls.push(args.join(" ")); return "cli-out"; },
    workerFactory: brokenWorkerFactory,
  });
  assert.equal(exec("cua-driver.exe", ["status"], ""), "cli-out");
  assert.equal(exec("cua-driver.exe", ["serve"], ""), "cli-out");
  assert.deepEqual(cliCalls, ["status", "serve"]);
  assert.equal(exec.stats().mcp, 0);
});

test("a broken worker falls back to the CLI for that call", () => {
  const cliCalls = [];
  const exec = createMcpTransport({
    cliExec: (driver, args, input) => { cliCalls.push(input); return "cli-out"; },
    workerFactory: brokenWorkerFactory,
  });
  const out = exec("cua-driver.exe", ["call", "list_windows"], JSON.stringify({ session: "t" }));
  assert.equal(out, "cli-out");
  assert.equal(cliCalls.length, 1);
  const stats = exec.stats();
  assert.equal(stats.fallbackCli, 1);
  assert.equal(stats.mcp, 0);
  assert.equal(stats.failures, 1);
  assert.match(stats.lastError, /worker is gone/);
  assert.ok(stats.disabledUntil > 0, "the fast path must be parked after a failure");
});

test("the fast path stays parked for the cooldown instead of retrying per call", () => {
  const cliCalls = [];
  let spawned = 0;
  const exec = createMcpTransport({
    cliExec: () => { cliCalls.push("cli"); return "cli-out"; },
    workerFactory: () => { spawned += 1; throw new Error("cannot spawn worker"); },
    cooldownMs: 60_000,
  });
  exec("cua-driver.exe", ["call", "list_windows"], "{}");
  exec("cua-driver.exe", ["call", "list_windows"], "{}");
  exec("cua-driver.exe", ["call", "get_window_state"], "{}");
  assert.equal(cliCalls.length, 3, "every call still happened, through the CLI");
  assert.equal(spawned, 1, "the worker must not be re-spawned on every call during the cooldown");
  assert.equal(exec.stats().mcp, 0);
});

test("the transport can be switched off entirely by config", () => {
  const cliCalls = [];
  const exec = createMcpTransport({
    enabled: false,
    cliExec: () => { cliCalls.push("cli"); return "cli-out"; },
    workerFactory: brokenWorkerFactory,
  });
  assert.equal(exec("cua-driver.exe", ["call", "list_windows"], "{}"), "cli-out");
  assert.deepEqual(exec.stats().counts ?? {}, {}, "no counts on the exec object itself");
  assert.equal(exec.stats().mcp, 0);
  assert.equal(cliCalls.length, 1);
});
