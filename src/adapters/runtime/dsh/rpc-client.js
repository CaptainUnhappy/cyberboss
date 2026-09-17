"use strict";

/**
 * JSON-RPC 2.0 over a newline-delimited stdio stream, speaking the DSH SDK
 * protocol to a `dsh --profile sdk` child process.
 *
 * Protocol facts here are taken from a live capture, not the README; see
 * docs/dsh-sdk-protocol-notes.md. The short version: one JSON object per line,
 * requests carry {id, method, params}, notifications carry {method, params} and
 * arrive as `session.event` / `session.status`, and a cold `dsh --profile sdk`
 * boot can take ~50s on first use because it auto-initializes the profile.
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const DEFAULT_INITIALIZE_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/**
 * `session/resume` is a read of persisted state, not a turn: bound it so a
 * transport that never answers cannot hold a reply hostage. The caller falls
 * back to creating the session.
 */
const RESUME_SESSION_TIMEOUT_MS = 30_000;
const EXPECTED_SERVER_NAME = "deepseek-harness-sdk-runtime";

class DshProtocolError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = "DshProtocolError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Windows rejects process creation when the environment block carries keys that
 * differ only by case (`Path`/`PATH`, `NO_PROXY`/`no_proxy`). Collapse them so a
 * spawned runtime always starts.
 */
function sanitizeEnvironment(source) {
  const groups = new Map();
  for (const [key, value] of Object.entries(source || {})) {
    const folded = key.toUpperCase();
    if (!groups.has(folded)) groups.set(folded, []);
    groups.get(folded).push([key, value]);
  }
  const out = {};
  for (const entries of groups.values()) {
    if (entries.length === 1) {
      const [key, value] = entries[0];
      out[key] = value;
      continue;
    }
    const preferred = entries.find(([, value]) => typeof value === "string" && value.length)
      || entries[0];
    out[preferred[0]] = preferred[1];
  }
  return out;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

class DshRpcClient {
  constructor(options = {}) {
    this.nodePath = options.nodePath || process.execPath;
    this.dshBin = options.dshBin;
    this.profile = normalizeText(options.profile) || "sdk";
    // Additional patch overlays, applied after the profile layer. `--patch` is
    // repeatable and merges by `id`; an id absent from the composed tree is
    // silently a no-op, so a caller relying on an overlay must verify the
    // resulting config (see docs/dsh-helper-notools.patch.yml).
    this.patchPaths = (Array.isArray(options.patchPaths) ? options.patchPaths : [])
      .map((item) => normalizeText(item))
      .filter(Boolean);
    this.cwd = options.cwd;
    // Extra environment for the child. The approval answerer receives its
    // per-spawn endpoint and bearer token this way: both change on every spawn,
    // and a `--patch` file is static.
    this.envOverrides = (options.env && typeof options.env === "object" && !Array.isArray(options.env))
      ? options.env
      : {};
    this.provider = normalizeText(options.provider);
    this.model = normalizeText(options.model);
    this.reasoningEffort = normalizeText(options.reasoningEffort);
    this.maxTokens = Number.isFinite(Number(options.maxTokens)) ? Number(options.maxTokens) : null;
    this.logger = options.logger || console;
    this.initializeTimeoutMs = Number(options.initializeTimeoutMs) || DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.requestTimeoutMs = Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;

    this.child = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.exitListeners = new Set();
    this.stdoutBuffer = "";
    this.stderrTail = "";
    this.initializeResult = null;
    this.closed = false;
    this.spawnError = null;
  }

  isRunning() {
    return Boolean(this.child) && this.child.exitCode === null && !this.closed;
  }

  isReady() {
    return this.isRunning() && Boolean(this.initializeResult);
  }

  onNotification(listener) {
    if (typeof listener !== "function") return () => {};
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener) {
    if (typeof listener !== "function") return () => {};
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  start() {
    if (this.isRunning()) return;
    if (!this.dshBin) {
      throw new DshProtocolError("dsh launcher path is required");
    }
    this.closed = false;
    this.spawnError = null;
    this.initializeResult = null;
    this.stdoutBuffer = "";
    this.stderrTail = "";

    const args = [this.dshBin, "--profile", this.profile];
    for (const patchPath of this.patchPaths) {
      args.push("--patch", patchPath);
    }
    const child = spawn(
      this.nodePath,
      args,
      {
        cwd: this.cwd,
        env: sanitizeEnvironment({ ...process.env, ...this.envOverrides }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000);
    });
    child.on("error", (error) => {
      this.spawnError = error;
      this.rejectAllPending(new DshProtocolError(`dsh runtime process error: ${error?.message || error}`));
      this.emitExit({ code: null, signal: null, error });
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      const detail = this.stderrTail.trim();
      this.rejectAllPending(new DshProtocolError(
        `dsh runtime exited (code=${code ?? "null"}, signal=${signal ?? "null"})`
        + (detail ? `; stderr: ${detail}` : ""),
      ));
      this.emitExit({ code, signal });
    });
  }

  emitExit(payload) {
    for (const listener of this.exitListeners) {
      try {
        listener(payload);
      } catch (error) {
        this.logger.error?.(`[cyberboss] dsh exit listener failed: ${error?.message || error}`);
      }
    }
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.logger.error?.(`[cyberboss] dsh emitted an unparsable line: ${line.slice(0, 200)}`);
      return;
    }
    if (frame && frame.id != null && frame.method == null) {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return;
      this.pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error) {
        waiter.reject(new DshProtocolError(
          normalizeText(frame.error.message) || "dsh request failed",
          { code: frame.error.code ?? null, data: frame.error.data ?? null },
        ));
      } else {
        waiter.resolve(frame.result);
      }
      return;
    }
    if (frame && frame.method) {
      for (const listener of this.notificationListeners) {
        try {
          listener(frame.method, frame.params || {});
        } catch (error) {
          this.logger.error?.(`[cyberboss] dsh notification listener failed: ${error?.message || error}`);
        }
      }
    }
  }

  rejectAllPending(error) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  request(method, params, { timeoutMs } = {}) {
    if (!this.isRunning()) {
      return Promise.reject(new DshProtocolError("dsh runtime is not running"));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const frame = { jsonrpc: "2.0", id, method };
    if (params !== undefined) frame.params = params;
    const effectiveTimeout = Number(timeoutMs) || this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DshProtocolError(`dsh request timed out: ${method}`));
      }, effectiveTimeout);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new DshProtocolError(`dsh request could not be written: ${error?.message || error}`));
      }
    });
  }

  async initialize() {
    if (this.isReady()) return this.initializeResult;
    if (!this.isRunning()) this.start();
    const result = await this.request("initialize", {
      cwd: this.cwd,
      provider: this.provider,
      model: this.model,
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
      ...(this.maxTokens ? { maxTokens: this.maxTokens } : {}),
    }, { timeoutMs: this.initializeTimeoutMs });
    const serverName = normalizeText(result?.serverInfo?.name);
    if (serverName !== EXPECTED_SERVER_NAME) {
      // The protocol has no version negotiation and the version field is
      // unvalidated, so the wire-stable server name is the only identity check
      // available. Refuse to drive an unexpected runtime.
      throw new DshProtocolError(
        `unexpected dsh server identity: expected=${EXPECTED_SERVER_NAME} observed=${serverName || "(empty)"}`,
      );
    }
    this.initializeResult = result;
    return result;
  }

  async prompt(sessionId, contentBlocks) {
    const normalizedSessionId = normalizeText(sessionId);
    if (!normalizedSessionId) {
      throw new DshProtocolError("session/prompt requires a sessionId");
    }
    if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
      throw new DshProtocolError("session/prompt requires at least one content block");
    }
    await this.initialize();
    return this.request("session/prompt", {
      sessionId: normalizedSessionId,
      contentBlocks,
    });
  }

  /**
   * Re-attach to a persisted session instead of creating another one.
   *
   * DSH's ACP surface advertises `session/resume`: it loads an inactive session
   * whose canonical workspace matches, restores its log, and replays no old
   * updates. A client-chosen id that already exists on disk can therefore be
   * continued after a runtime respawn - which is what keeps one conversation on
   * one session instead of opening a new one per restart.
   */
  async resumeSession(sessionId, { cwd = "" } = {}) {
    const normalizedSessionId = normalizeText(sessionId);
    if (!normalizedSessionId) {
      throw new DshProtocolError("session/resume requires a sessionId");
    }
    const normalizedCwd = normalizeText(cwd);
    if (!normalizedCwd) {
      throw new DshProtocolError("session/resume requires a cwd");
    }
    await this.initialize();
    return this.request("session/resume", {
      sessionId: normalizedSessionId,
      cwd: normalizedCwd,
      mcpServers: [],
    }, { timeoutMs: RESUME_SESSION_TIMEOUT_MS });
  }

  async shutdown() {
    this.closed = true;
    if (!this.isRunning()) return;
    try {
      await this.request("shutdown", undefined, { timeoutMs: 10_000 });
    } catch {
      // A runtime that refuses to answer shutdown is torn down below anyway.
    }
    await this.waitForExit(5_000);
    this.kill();
  }

  waitForExit(timeoutMs) {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      function onExit() {
        clearTimeout(timer);
        resolve();
      }
      child.once("exit", onExit);
    });
  }

  kill() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    this.child = null;
  }

  async close() {
    await this.shutdown();
    this.notificationListeners.clear();
    this.exitListeners.clear();
  }
}

function newSessionId(prefix = "cyberboss") {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Resolve the `dsh` launcher, preferring an installed dependency over the npx
 * cache. `@deepseek-ai/dsh` is declared in package.json, so a normal install puts
 * it under node_modules; the npx cache path is a development fallback that
 * disappears whenever that cache is pruned.
 */
function defaultDshBin() {
  const packageBin = path.join("@deepseek-ai", "dsh", "lib", "bin.js");
  try {
    return require.resolve(packageBin);
  } catch {
    // Not installed as a dependency; fall through to the development cache.
  }
  return path.join(
    process.env.LOCALAPPDATA || "",
    "npm-cache",
    "_npx",
    "1e7f6d9597241db0",
    "node_modules",
    packageBin,
  );
}

module.exports = {
  DshRpcClient,
  DshProtocolError,
  EXPECTED_SERVER_NAME,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  sanitizeEnvironment,
  newSessionId,
  defaultDshBin,
};
