"use strict";

/**
 * Loopback endpoint that lets the in-process DSH answerer ask Cyberboss for a
 * verdict on one tool escalation.
 *
 * The answerer has to live inside the DSH process: `@deepseek-ai/dsh-sdk-protocol`
 * documents server-to-client requests as a dead capability, so an SDK client can
 * never answer an approval. That inverts the usual direction - the child now has
 * to call back into Cyberboss - so this endpoint exists to carry exactly one
 * narrowly-scoped question and nothing else.
 *
 * Security properties, all deliberate:
 *   - binds 127.0.0.1 on an ephemeral port, so it is not reachable off-host and
 *     does not collide with a fixed port;
 *   - requires a 32-byte bearer token compared in constant time, handed to the
 *     child through its environment rather than through a world-readable file;
 *   - accepts one route and one method;
 *   - caps the request body;
 *   - answers *every* authenticated request with a closed outcome and fails
 *     closed on anything else, so the caller never has to interpret an HTTP
 *     error as permission.
 */

const crypto = require("node:crypto");
const http = require("node:http");

const OUTCOME_UNAVAILABLE = "unavailable";
const OUTCOME_VOCABULARY = new Set(["allowed-once", "rejected", "cancelled", "unavailable"]);
const DECIDE_PATH = "/approval/decide";
const MAX_BODY_BYTES = 16 * 1024;

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Constant-time compare that tolerates a length mismatch without early exit. */
function tokenMatches(expected, presented) {
  const expectedBuffer = Buffer.from(normalizeText(expected), "utf8");
  const presentedBuffer = Buffer.from(normalizeText(presented), "utf8");
  if (expectedBuffer.length === 0 || presentedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, presentedBuffer);
}

class ApprovalEndpoint {
  /**
   * @param {object} options
   * @param {(request: {toolName: string, callId: string, reason: string}) => Promise<string>} options.decide
   * @param {object} [options.logger]
   */
  constructor({ decide, logger = console } = {}) {
    if (typeof decide !== "function") {
      throw new TypeError("an approval endpoint requires a decide function");
    }
    this.decide = decide;
    this.logger = logger;
    this.token = crypto.randomBytes(32).toString("hex");
    this.server = null;
    this.port = 0;
  }

  get endpoint() {
    return this.port ? `http://127.0.0.1:${this.port}${DECIDE_PATH}` : "";
  }

  async start() {
    if (this.server) return this.endpoint;
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch(() => {
        // handle() answers every path itself; this is a last-resort guard so a
        // bug here can never leave a socket hanging or crash the bridge.
        try {
          sendJson(response, 200, { outcome: OUTCOME_UNAVAILABLE });
        } catch {
          // The response was already sent or the socket is gone.
        }
      });
    });
    // A bind failure must be fatal to the caller's enablement decision, not a
    // silently dead endpoint that makes every escalation look unanswered.
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address ? Number(address.port) : 0;
    return this.endpoint;
  }

  async handle(request, response) {
    if (request.method !== "POST" || request.url !== DECIDE_PATH) {
      sendJson(response, 404, { outcome: OUTCOME_UNAVAILABLE });
      return;
    }
    const presented = /^Bearer\s+(.+)$/iu.exec(normalizeText(request.headers.authorization));
    if (!tokenMatches(this.token, presented ? presented[1] : "")) {
      sendJson(response, 401, { outcome: OUTCOME_UNAVAILABLE });
      return;
    }

    // Refuse a declared-oversized body before reading a byte of it. Draining
    // with resume() discards the bytes instead of buffering them, so the
    // response still flushes and the caller gets a clean refusal.
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      sendJson(response, 400, { outcome: OUTCOME_UNAVAILABLE });
      request.resume();
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      this.logger.warn?.(`[cyberboss] approval request rejected: ${error.message}`);
      sendJson(response, 400, { outcome: OUTCOME_UNAVAILABLE });
      return;
    }

    let outcome = OUTCOME_UNAVAILABLE;
    try {
      outcome = await this.decide({
        toolName: normalizeText(body.toolName),
        callId: normalizeText(body.callId),
        reason: normalizeText(body.reason),
      });
    } catch (error) {
      // A decider that cannot answer must never read as approval.
      this.logger.error?.(
        `[cyberboss] approval decider failed closed: ${error?.message || error}`,
      );
    }
    if (!OUTCOME_VOCABULARY.has(outcome)) {
      this.logger.warn?.(
        `[cyberboss] approval decider returned a value outside the vocabulary: ${String(outcome)}`,
      );
      outcome = OUTCOME_UNAVAILABLE;
    }
    sendJson(response, 200, { outcome });
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = 0;
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("approval request body was too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        reject(new Error("approval request body was empty"));
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("approval request body was not an object"));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error("approval request body was not valid JSON"));
      }
    });
  });
}

module.exports = {
  ApprovalEndpoint,
  DECIDE_PATH,
  MAX_BODY_BYTES,
  OUTCOME_UNAVAILABLE,
  OUTCOME_VOCABULARY,
  tokenMatches,
};
