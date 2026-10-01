"use strict";

/**
 * ACP client: drives `dsh --profile acp` (@deepseek-ai/dsh-acp) over JSON-RPC stdio.
 *
 * Why a second surface: the sdk profile (`dsh-sdk-app`) serves only
 * initialize/session/prompt/shutdown, so a session created by one runtime process
 * can never be continued by the next one - every restart opened another session
 * and lost the conversation. The ACP profile advertises
 * `sessionCapabilities {close, list, resume}`, keeps its sessions in the same
 * `~/.dsh/sessions` store, and was verified on a real machine to resume a
 * session **with its context intact** after a process swap (tmp/acp-probe.js).
 *
 * The transport (spawn, newline framing, timeouts, Windows env sanitising) is the
 * hardened one from the sdk client; only the method vocabulary differs, so this
 * is a subclass rather than a copy.
 */

const {
  DshRpcClient,
  DshProtocolError,
} = require("../dsh/rpc-client");

const ACP_PROTOCOL_VERSION = 1;
/**
 * A `session/prompt` response arrives when the *turn* ends, not when it starts, so
 * the default 60s request timeout would kill any real task. Turns are long by
 * nature (a search or a skill run takes minutes), and the server refuses a second
 * prompt for a session that is busy, so aborting early loses the answer entirely.
 */
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;
/** The ACP server identifies itself by this name; there is no version negotiation. */
const EXPECTED_AGENT_NAME = "deepseek-harness-acp";
const DEFAULT_CLIENT_INFO = Object.freeze({ name: "cyberboss", version: "0.1.0" });

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

class AcpRpcClient extends DshRpcClient {
  constructor(options = {}) {
    super({
      ...options,
      // ACP is its own shipped profile; a caller that wants another one still can.
      profile: normalizeText(options.profile) || "acp",
    });
    this.protocolVersion = Number.isInteger(options.protocolVersion)
      ? options.protocolVersion
      : ACP_PROTOCOL_VERSION;
    this.clientInfo = options.clientInfo && typeof options.clientInfo === "object"
      ? options.clientInfo
      : DEFAULT_CLIENT_INFO;
    this.agentCapabilities = null;
    this.agentInfo = null;
    /** sessionId -> last advertised ACP config options (see getSessionConfigOptions). */
    this.sessionConfigOptionsBySession = new Map();
    this.promptTimeoutMs = Number(options.promptTimeoutMs) || DEFAULT_PROMPT_TIMEOUT_MS;
  }

  async initialize() {
    if (this.isReady()) {
      return this.initializeResult;
    }
    if (!this.isRunning()) {
      this.start();
    }
    const result = await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      clientCapabilities: {
        // The client offers no filesystem or terminal surface: Cyberboss answers
        // permission requests, but every file operation stays inside the agent.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: this.clientInfo,
    }, { timeoutMs: this.initializeTimeoutMs });

    const agentName = normalizeText(result?.agentInfo?.name);
    if (agentName !== EXPECTED_AGENT_NAME) {
      throw new DshProtocolError(
        `unexpected ACP agent identity: expected=${EXPECTED_AGENT_NAME} observed=${agentName || "(empty)"}`,
      );
    }
    this.agentInfo = result.agentInfo;
    this.agentCapabilities = result.agentCapabilities || {};
    this.initializeResult = result;
    return result;
  }

  sessionCapability(name) {
    const key = normalizeText(name);
    if (!key) {
      return false;
    }
    const capabilities = this.agentCapabilities?.sessionCapabilities;
    return Boolean(capabilities && Object.prototype.hasOwnProperty.call(capabilities, key));
  }

  /**
   * Whether the agent advertised one prompt-content capability at initialize.
   *
   * `promptCapabilities.image` is the agent's answer to "will the configured model
   * accept inline images"; sending an image anyway is rejected as invalid params.
   */
  promptCapability(name) {
    const key = normalizeText(name);
    if (!key) {
      return false;
    }
    const capabilities = this.agentCapabilities?.promptCapabilities;
    return Boolean(capabilities && capabilities[key] === true);
  }

  /**
   * Create a session. ACP assigns the id (the client does not choose it), which is
   * why the conversation keeps the returned id in its own store.
   */
  async newSession({ cwd = this.cwd, mcpServers = [] } = {}) {
    await this.initialize();
    const result = await this.request("session/new", { cwd, mcpServers });
    const sessionId = normalizeText(result?.sessionId);
    if (!sessionId) {
      throw new DshProtocolError("session/new returned no sessionId");
    }
    this.rememberSessionConfigOptions(sessionId, result?.configOptions);
    return sessionId;
  }

  /**
   * Standard configuration state advertised for one session.
   *
   * ACP only hands these out with `session/new`, `session/resume` and
   * `session/set_config_option`, so they are cached per session as they arrive. The
   * `model` option (category `model`) is what decides whether a turn may carry
   * inline images: a session created before the image-capable model was pinned keeps
   * the old model and rejects them with "does not declare image input".
   */
  getSessionConfigOptions(sessionId) {
    const cached = this.sessionConfigOptionsBySession.get(normalizeText(sessionId));
    return Array.isArray(cached) ? cached : [];
  }

  rememberSessionConfigOptions(sessionId, configOptions) {
    const normalizedSessionId = normalizeText(sessionId);
    if (!normalizedSessionId || !Array.isArray(configOptions)) {
      return;
    }
    this.sessionConfigOptionsBySession.set(normalizedSessionId, configOptions);
  }

  /** Apply one advertised standard option; returns the resulting option state. */
  async setSessionConfigOption(sessionId, configId, value) {
    const normalizedSessionId = normalizeText(sessionId);
    const normalizedConfigId = normalizeText(configId);
    if (!normalizedSessionId || !normalizedConfigId) {
      throw new DshProtocolError("session/set_config_option requires a sessionId and configId");
    }
    await this.initialize();
    const result = await this.request("session/set_config_option", {
      sessionId: normalizedSessionId,
      configId: normalizedConfigId,
      value,
    }, { timeoutMs: this.requestTimeoutMs });
    this.rememberSessionConfigOptions(normalizedSessionId, result?.configOptions);
    return Array.isArray(result?.configOptions) ? result.configOptions : [];
  }

  /** Re-attach to a persisted session, restoring its log without replaying it. */
  async resumeSession(sessionId, { cwd = this.cwd, mcpServers = [] } = {}) {
    const normalizedSessionId = normalizeText(sessionId);
    if (!normalizedSessionId) {
      throw new DshProtocolError("session/resume requires a sessionId");
    }
    if (!normalizeText(cwd)) {
      throw new DshProtocolError("session/resume requires a cwd");
    }
    await this.initialize();
    const result = await this.request("session/resume", {
      sessionId: normalizedSessionId,
      cwd,
      mcpServers,
    }, { timeoutMs: this.requestTimeoutMs });
    this.rememberSessionConfigOptions(normalizedSessionId, result?.configOptions);
    return result;
  }

  async listSessions({ cwd = "", cursor = "" } = {}) {
    await this.initialize();
    const params = {};
    if (normalizeText(cwd)) {
      params.cwd = cwd;
    }
    if (normalizeText(cursor)) {
      params.cursor = cursor;
    }
    const result = await this.request("session/list", params);
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    return {
      sessions: sessions.map((session) => ({
        sessionId: normalizeText(session?.sessionId),
        cwd: normalizeText(session?.cwd),
        title: normalizeText(session?.title),
        updatedAt: normalizeText(session?.updatedAt),
      })),
      nextCursor: normalizeText(result?.nextCursor),
    };
  }

  async closeSession(sessionId) {
    const normalizedSessionId = normalizeText(sessionId);
    if (!normalizedSessionId) {
      throw new DshProtocolError("session/close requires a sessionId");
    }
    await this.initialize();
    return this.request("session/close", { sessionId: normalizedSessionId }, { timeoutMs: 10_000 });
  }

  async prompt(sessionId, promptBlocks) {
    const normalizedSessionId = normalizeText(sessionId);
    if (!normalizedSessionId) {
      throw new DshProtocolError("session/prompt requires a sessionId");
    }
    if (!Array.isArray(promptBlocks) || promptBlocks.length === 0) {
      throw new DshProtocolError("session/prompt requires at least one content block");
    }
    await this.initialize();
    return this.request("session/prompt", {
      sessionId: normalizedSessionId,
      prompt: promptBlocks,
    }, { timeoutMs: this.promptTimeoutMs });
  }

  /**
   * ACP has no `shutdown` method: the agent ends when its input stream ends, so
   * closing stdin is the protocol-correct goodbye (the sdk surface needed an
   * explicit request).
   */
  async shutdown() {
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return;
    }
    try {
      child.stdin.end();
    } catch {
      // Stream already gone; the teardown below still applies.
    }
    await this.waitForExit(5_000);
    this.kill();
  }
}

module.exports = {
  AcpRpcClient,
  ACP_PROTOCOL_VERSION,
  EXPECTED_AGENT_NAME,
};
