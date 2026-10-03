// worker.js - one long-lived Python reader, spoken to over stdio.
//
// The reader itself is `scripts/wechat-db-inbox-read.py`, which decrypts the
// WeChat 4.x SQLCipher files in pure Python (vendored under
// `scripts/wechat_db_reader/`). Two ways to call it exist and the difference is
// worth stating, because it decides the poll interval:
//
//   * one shot (`--chat X --limit N`): a fresh interpreter re-decrypts every page
//     it touches. Measured 2026-10-03: ~1.3s per call on a small account, and it
//     grows with the message shards.
//   * serve (`--serve`): the same process keeps the plaintext snapshot cache in
//     memory, so the first query costs the decrypt and every later poll costs
//     milliseconds. Measured on the same account: 1307ms cold, then 3-4ms.
//
// So the inbox keeps a worker alive. What this module owns is the boring half:
// framing (one JSON object per line), correlation by request id, timeouts, and
// bringing the child back when it dies - because a reader that quietly stopped
// answering is indistinguishable from a quiet chat, which is the worst failure
// mode available to a channel whose whole job is to hear people.

const { spawn } = require("node:child_process");
const path = require("node:path");

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_RESTART_COOLDOWN_MS = 5_000;
const STDERR_LINES_KEPT = 20;

class WechatDbWorker {
  /**
   * @param {object} options
   * @param {string} options.pythonCommand  interpreter ("python")
   * @param {string} options.scriptPath     scripts/wechat-db-inbox-read.py
   * @param {object} [options.env]          extra environment (key/dir/cache)
   * @param {object} [options.logger]
   * @param {number} [options.requestTimeoutMs]
   * @param {number} [options.restartCooldownMs]
   * @param {Function} [options.spawnImpl]  injected for tests
   */
  constructor({
    pythonCommand = "python",
    scriptPath = path.resolve(__dirname, "..", "..", "..", "scripts", "wechat-db-inbox-read.py"),
    env = {},
    logger = console,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    restartCooldownMs = DEFAULT_RESTART_COOLDOWN_MS,
    spawnImpl = spawn,
  } = {}) {
    this.pythonCommand = pythonCommand;
    this.scriptPath = scriptPath;
    this.env = env;
    this.logger = logger;
    this.requestTimeoutMs = requestTimeoutMs;
    this.restartCooldownMs = restartCooldownMs;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.stderrTail = [];
    this.lastExit = null;
    this.lastSpawnAt = 0;
    this.starts = 0;
    this.stopping = false;
  }

  get running() {
    return Boolean(this.child) && this.child.exitCode === null && !this.child.killed;
  }

  /** Spawn the reader if it is not already up. Returns the child. */
  start() {
    if (this.running) {
      return this.child;
    }
    this.stopping = false;
    const args = ["-u", this.scriptPath, "--serve"];
    const child = this.spawnImpl(this.pythonCommand, args, {
      cwd: path.dirname(this.scriptPath),
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        ...this.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.starts += 1;
    this.lastSpawnAt = Date.now();
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => this.consumeStderr(chunk));
    }
    child.on("error", (error) => this.failAll(`reader could not start: ${error.message}`));
    child.on("exit", (code, signal) => {
      this.lastExit = { code, signal, at: new Date().toISOString() };
      this.child = null;
      // Every in-flight request belongs to the process that just died; failing
      // them loudly is what turns "no messages" into "the reader is not there".
      this.failAll(`reader exited (code=${code} signal=${signal || "none"})`);
    });
    return child;
  }

  consume(chunk) {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) {
        return;
      }
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (error) {
        this.logger.warn?.(`[cyberboss] wechat-db reader sent a line that is not JSON: ${line.slice(0, 200)}`);
        continue;
      }
      this.settle(payload);
    }
  }

  consumeStderr(chunk) {
    for (const line of String(chunk).split("\n")) {
      const text = line.trim();
      if (!text) {
        continue;
      }
      this.stderrTail.push(text);
      if (this.stderrTail.length > STDERR_LINES_KEPT) {
        this.stderrTail.shift();
      }
      // The reader logs its lifecycle on stderr on purpose, so it goes to the
      // bot's log at debug level instead of vanishing.
      this.logger.debug?.(`[cyberboss] wechat-db reader: ${text}`);
    }
  }

  settle(payload) {
    const id = payload?.id;
    const entry = id === undefined || id === null ? null : this.pending.get(id);
    if (!entry) {
      // No id: an unsolicited line (a crash note). Keep it visible.
      this.logger.warn?.(`[cyberboss] wechat-db reader sent an unclaimed response: ${JSON.stringify(payload).slice(0, 200)}`);
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (payload.ok === false) {
      entry.reject(new Error(String(payload.error || "reader refused the request")));
      return;
    }
    entry.resolve(payload);
  }

  failAll(message) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error(message));
    }
  }

  /**
   * One request. Resolves with the reader's payload, rejects on refusal,
   * timeout or a dead child (in which case the next call starts a new one).
   */
  request(payload, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.stopping) {
      return Promise.reject(new Error("reader is stopped"));
    }
    // A dead child is restarted here rather than by a supervisor: the poll that
    // finds it dead is exactly the poll that needs an answer.
    if (!this.running) {
      const since = Date.now() - (this.lastExit ? Date.parse(this.lastExit.at) : this.lastSpawnAt);
      if (this.lastExit && since < this.restartCooldownMs && this.starts > 0) {
        return Promise.reject(new Error(
          `reader is down (exited ${since}ms ago: code=${this.lastExit.code}); not restarting yet`
        ));
      }
      this.start();
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A reader that does not answer within the budget is not going to; kill
        // it so the next poll starts from a known state instead of queueing
        // behind a stuck process.
        this.kill("request timeout");
        reject(new Error(`reader did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.pending.set(id, { resolve, reject, timer, sentAt: Date.now() });
      try {
        this.child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`reader stdin is not writable: ${error.message}`));
      }
    });
  }

  /** Convenience wrappers, one per reader command. */
  ping(options) {
    return this.request({ cmd: "ping" }, options);
  }

  sessions(options) {
    return this.request({ cmd: "sessions" }, options);
  }

  snapshots({ chats, limit = 50, timeoutMs } = {}) {
    return this.request({ cmd: "snapshots", chats: chats || [], limit }, { timeoutMs });
  }

  kill(reason = "stop") {
    const child = this.child;
    this.child = null;
    this.failAll(`reader killed (${reason})`);
    if (!child) {
      return;
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  /** Ask the reader to exit, then make sure it did. */
  async stop({ graceMs = 1_500 } = {}) {
    // The graceful request has to go out BEFORE the stopped flag goes up, or
    // request() rejects its own shutdown message and every stop turns into a
    // kill (which is how this was written the first time).
    if (!this.running) {
      this.stopping = true;
      this.child = null;
      return { stopped: true, how: "not-running" };
    }
    let how = "asked";
    try {
      await this.request({ cmd: "stop" }, { timeoutMs: graceMs });
    } catch {
      how = "killed";
      this.kill("stop timeout");
    }
    this.stopping = true;
    return { stopped: true, how };
  }

  describe() {
    return {
      running: this.running,
      starts: this.starts,
      lastExit: this.lastExit,
      stderrTail: [...this.stderrTail],
    };
  }
}

module.exports = { WechatDbWorker, DEFAULT_REQUEST_TIMEOUT_MS };
