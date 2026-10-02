"use strict";

/**
 * Worker half of the MCP transport: it owns ONE `cua-driver mcp` child and answers
 * tool calls over the worker port.
 *
 * Why a worker at all: the client's whole surface is synchronous (`execFileSync`),
 * and rewriting it to async would touch every call site and every test. A worker
 * thread plus a port keeps the sync API and still removes the per-call process
 * spawn that dominated every latency in this channel.
 *
 * Measured 2026-10-02 on 0.31.0 (Windows 11, WeChat 4.x):
 *   `cua-driver call <tool>`     ~1500-2000ms per call   (new process each time)
 *   `cua-driver mcp` tools/call  ~140-180ms per call     (one long-lived process)
 *
 * The worker maps an MCP answer back into the exact payload shape `cua-driver call`
 * prints, because that shape is what `client.js` parses and what its refusal
 * predicates (`stale_element_token`, `window_minimized`, `session has ended`,
 * `daemon is not running`) match on.
 */

const { spawn } = require("node:child_process");

const INIT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;

let port = null;
let child = null;
let childDriver = "";
let readyPromise = null;
let buffer = "";
let nextId = 1;
const pending = new Map();

function fail(error) {
  return { __failed: true, payload: String((error && error.message) || error || "mcp failure"), exit: null };
}

/** One line of JSON per message, per the MCP stdio transport. */
function handleLine(line) {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  waiter(message);
}

function request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`mcp ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function teardown() {
  for (const waiter of pending.values()) {
    waiter({ error: { message: "cua-driver mcp exited" } });
  }
  pending.clear();
  child = null;
  childDriver = "";
  readyPromise = null;
  buffer = "";
}

function ensureReady(driver) {
  if (child && childDriver === driver && readyPromise) {
    return readyPromise;
  }
  if (child) {
    try { child.kill(); } catch { /* already gone */ }
    teardown();
  }
  childDriver = driver;
  buffer = "";
  child = spawn(driver, ["mcp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      handleLine(line);
    }
  });
  child.on("exit", () => teardown());
  child.on("error", () => teardown());
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => { /* diagnostics only; refusals arrive as data */ });
  child.stdin.on("error", () => teardown());

  readyPromise = (async () => {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cyberboss", version: "0.1.0" },
    }, INIT_TIMEOUT_MS);
    if (init.error) {
      throw new Error(init.error.message || "mcp initialize failed");
    }
    notify("notifications/initialized", {});
    return true;
  })().catch((error) => {
    readyPromise = null;
    throw error;
  });
  return readyPromise;
}

/**
 * An MCP tool answer, in the shape `cua-driver call` writes to stdout.
 *
 * A refusal is data, not a transport failure: the driver answers HTTP-200-style with
 * `isError: true` and `structuredContent.refusal`, which is exactly what
 * `client.js#outcome()` reads (`reason` comes from `refusal.code`).
 */
function toCliPayload(message) {
  if (!message) return fail("mcp returned no message");
  if (message.error) {
    const text = message.error.message || JSON.stringify(message.error);
    return { __failed: true, payload: text, exit: null };
  }
  const result = message.result || {};
  const structured = result.structuredContent;
  const text = Array.isArray(result.content)
    ? (result.content.find((part) => part && part.type === "text")?.text || "")
    : "";
  if (result.isError) {
    if (structured?.refusal) {
      return { __failed: true, payload: structured, exit: 1 };
    }
    return {
      __failed: true,
      payload: {
        ...(structured || {}),
        refusal: { code: structured?.code || "tool_failed", message: text },
      },
      exit: 1,
    };
  }
  if (!structured) {
    return { __failed: true, payload: text || "mcp returned no structured content", exit: 1 };
  }
  return structured;
}

async function callTool(driver, tool, args) {
  await ensureReady(driver);
  const message = await request("tools/call", { name: tool, arguments: args });
  return toCliPayload(message);
}

/**
 * The main thread hands us a port so its synchronous `receiveMessageOnPort` can read
 * the answers; `parentPort` is only a fallback for a worker started without one.
 * `toCliPayload` is exported so its mapping can be tested without a driver.
 */
const { parentPort } = require("node:worker_threads");
let channel = null;

async function handleCall(message, respond) {
  const { id, driver, tool, args } = message || {};
  try {
    const payload = await callTool(driver, tool, args);
    respond({ id, ok: true, text: JSON.stringify(payload) });
  } catch (error) {
    respond({ id, ok: false, error: String((error && error.message) || error) });
  }
}

if (parentPort) {
  parentPort.on("message", (message) => {
    if (message && message.type === "connect" && message.port) {
      channel = message.port;
      channel.on("message", (call) => handleCall(call, (payload) => channel.postMessage(payload)));
      return;
    }
    handleCall(message, (payload) => (channel || parentPort).postMessage(payload));
  });
}

module.exports = { toCliPayload };
