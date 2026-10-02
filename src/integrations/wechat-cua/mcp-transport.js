"use strict";

/**
 * Synchronous facade over the worker-owned MCP transport.
 *
 * The channel's calls are synchronous everywhere (`execFileSync` inside `CuaSession`),
 * so the fast path has to stay synchronous too. This module spawns one worker thread
 * (which owns one `cua-driver mcp` child) and turns a call into:
 *
 *   postMessage -> poll the port with `receiveMessageOnPort` -> return the text
 *
 * Measured 2026-10-02, WeChat 4.x / 0.31.0, same machine:
 *
 *   transport                        per call      a conversation switch (~5 calls)
 *   `cua-driver call` (process)     1500-2000ms   ~10s   <- what the bot used to do
 *   `cua-driver mcp` (this module)   140-180ms    ~0.8s
 *
 * Why it matters beyond speed: the operator's two complaints - "处理中 is not the first
 * thing that arrives" and "the focus is still not given back" - are both paid per call.
 * The acknowledgement needs 4-6 calls after an inbound is detected, so it appeared
 * ~8-12s late; a switch holds the foreground for as long as its calls take.
 *
 * Failure policy: this is an optimisation, never a dependency. Any transport problem
 * (no worker, spawn error, timeout, crash) falls back to the CLI for that call and
 * disables the fast path for a cooldown, so a broken MCP path degrades to exactly the
 * old behaviour instead of going mute. `stats()` reports what happened.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { MessageChannel, Worker, receiveMessageOnPort } = require("node:worker_threads");

const WORKER_PATH = path.join(__dirname, "mcp-transport-worker.js");
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 120_000;
const POLL_SLEEP_MS = 2;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The CLI fallback: one `cua-driver` process per call, stderr captured. */
function defaultCliExec(driver, args, input) {
  return execFileSync(driver, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function createMcpTransport({
  cliExec = defaultCliExec,
  workerFactory = () => new Worker(WORKER_PATH),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  enabled = String(process.env.CYBERBOSS_CUA_MCP_TRANSPORT ?? "1") !== "0",
  now = () => Date.now(),
} = {}) {
  const state = {
    worker: null,
    port: null,
    nextId: 1,
    disabledUntil: 0,
    lastError: "",
    counts: { calls: 0, mcp: 0, fallbackCli: 0, failures: 0 },
  };

  function dropWorker(reason) {
    if (state.worker) {
      try { state.worker.terminate(); } catch { /* already gone */ }
    }
    state.worker = null;
    state.port = null;
    state.lastError = String(reason || "");
    state.disabledUntil = now() + cooldownMs;
    state.counts.failures += 1;
  }

  function ensureChannel() {
    if (state.worker && state.port) return true;
    if (!enabled || now() < state.disabledUntil) return false;
    try {
      const worker = workerFactory();
      const { port1, port2 } = new MessageChannel();
      worker.postMessage({ type: "connect", port: port2 }, [port2]);
      worker.on("exit", () => dropWorker("mcp worker exited"));
      worker.on("error", (error) => dropWorker(`mcp worker error: ${error && error.message}`));
      // Never keep the bot alive just for this optimisation.
      if (typeof worker.unref === "function") worker.unref();
      state.worker = worker;
      state.port = port1;
      return true;
    } catch (error) {
      dropWorker(`mcp worker could not start: ${error && error.message}`);
      return false;
    }
  }

  function awaitResponse(id, deadline) {
    for (;;) {
      const received = receiveMessageOnPort(state.port);
      if (received && received.message && received.message.id === id) {
        return received.message;
      }
      if (now() > deadline) return null;
      sleep(POLL_SLEEP_MS);
    }
  }

  /** `exec` in the same shape `CuaSession` already passes around. */
  function exec(driver, args, input) {
    state.counts.calls += 1;
    // Only tool calls can go over MCP; `status`, `serve`, `start_session`-style
    // lifecycle commands stay on the CLI.
    if (!enabled || args?.[0] !== "call" || typeof args[1] !== "string" || !ensureChannel()) {
      state.counts.fallbackCli += 1;
      return cliExec(driver, args, input);
    }
    let parsed;
    try {
      parsed = input ? JSON.parse(input) : {};
    } catch (error) {
      state.counts.fallbackCli += 1;
      return cliExec(driver, args, input);
    }
    const id = state.nextId++;
    try {
      state.port.postMessage({ id, driver, tool: args[1], args: parsed });
    } catch (error) {
      dropWorker(`mcp postMessage failed: ${error && error.message}`);
      state.counts.fallbackCli += 1;
      return cliExec(driver, args, input);
    }
    const response = awaitResponse(id, now() + timeoutMs);
    if (!response) {
      dropWorker(`mcp call ${args[1]} timed out after ${timeoutMs}ms`);
      state.counts.fallbackCli += 1;
      return cliExec(driver, args, input);
    }
    if (!response.ok) {
      dropWorker(`mcp call ${args[1]} failed: ${response.error}`);
      state.counts.fallbackCli += 1;
      return cliExec(driver, args, input);
    }
    state.counts.mcp += 1;
    return response.text;
  }

  exec.stats = () => ({ ...state.counts, active: Boolean(state.worker), disabledUntil: state.disabledUntil, lastError: state.lastError });
  exec.close = () => { if (state.worker) { try { state.worker.terminate(); } catch { /* gone */ } } state.worker = null; state.port = null; };
  return exec;
}

module.exports = { createMcpTransport, defaultCliExec, WORKER_PATH };
