"use strict";

/**
 * ACP runtime adapter: one DSH session per chat window, resumable across restarts.
 *
 * The sdk-surface adapter (`runtime/dsh`) mints a random session id per runtime
 * process, because `dsh-sdk-app` cannot re-attach to a session that a previous
 * process created. This adapter drives `dsh --profile acp` instead, which
 * advertises `sessionCapabilities {close, list, resume}`, so a conversation keeps
 * one session id for its whole life: the id is stored per window, `session/resume`
 * brings the log back after a restart, and the transcript survives.
 *
 * Two more differences are worth naming, because they change behaviour rather
 * than plumbing:
 *  - approvals arrive as an ACP *request* (`session/request_permission`) which this
 *    client must answer, so `respondApproval` finally has a real path (the sdk
 *    surface could only report `false`);
 *  - cancellation is `session/cancel`, which ends one turn instead of killing the
 *    whole workspace runtime and abandoning its other turns.
 */

const path = require("node:path");
const fs = require("node:fs");

const { AcpRpcClient } = require("./rpc-client");
const {
  AcpTurnMapper,
  buildPermissionResponse,
  mapPermissionDecision,
  mapPermissionRequest,
  selectPermissionOption,
} = require("./events");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { resolveDshBin } = require("../dsh");
const {
  MODEL_CANARY_EXECUTION_POLICY,
} = require("../../../integrations/weflow-model-canary");

const RUNTIME_ID = "dsh-acp";
const TURN_START_TIMEOUT_MS = 120_000;
/** How long an approval request may wait for a human before it fails closed. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveAttachmentLimitsPatchPath() {
  const candidate = path.join(__dirname, "..", "dsh", "attachment-limits.patch.yml");
  return fs.existsSync(candidate) ? candidate : "";
}

/**
 * The profile's own approval policy is read from this variable; `ask` is what makes
 * the agent send `session/request_permission` at all. An access mode of
 * `full-access` means the operator asked for no prompts, so it maps to `never`.
 */
function resolveAcpPermissionMode(config = {}) {
  const accessMode = normalizeText(config.codexAccessMode) || normalizeText(config.accessMode);
  return accessMode === "full-access" ? "danger-full-access" : "workspace-write";
}

function createDshAcpRuntimeAdapter(config = {}, deps = {}) {
  // Injectable so a test can drive the adapter's decisions without a runtime
  // process; production always spawns the real ACP client.
  const createClient = typeof deps.createClient === "function"
    ? deps.createClient
    : (options) => new AcpRpcClient(options);
  const sessionStore = new SessionStore({
    filePath: config.dshSessionsFile || config.sessionsFile,
    runtimeId: RUNTIME_ID,
  });
  const configuredModel = normalizeText(config.dshModel) || normalizeText(config.model);
  const configuredProvider = normalizeText(config.dshProvider) || normalizeText(config.modelProvider);
  const patchPaths = [resolveAttachmentLimitsPatchPath()].filter(Boolean);

  const eventListeners = new Set();
  const runtimes = new Map();
  let readyState = null;
  let closed = false;

  function emit(event) {
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not take the turn down with it.
      }
    }
  }

  function emitAll(events) {
    for (const event of events) {
      emit(event);
    }
  }

  function ensureRuntime(workspaceRoot) {
    const normalizedRoot = normalizeText(workspaceRoot) || config.workspaceRoot || process.cwd();
    try {
      fs.mkdirSync(normalizedRoot, { recursive: true });
    } catch (error) {
      console.warn(
        `[cyberboss] dsh-acp workspace root could not be created (${normalizedRoot}): ${error?.message || error}`,
      );
    }
    const existing = runtimes.get(normalizedRoot);
    if (existing && existing.client.isRunning()) {
      return existing;
    }
    if (existing) {
      existing.client.kill();
      runtimes.delete(normalizedRoot);
    }

    const client = createClient({
      dshBin: resolveDshBin(config),
      cwd: normalizedRoot,
      patchPaths,
      env: { DSH_PERMISSION_MODE: resolveAcpPermissionMode(config) },
      initializeTimeoutMs: config.dshInitializeTimeoutMs,
      requestTimeoutMs: config.dshRequestTimeoutMs,
      logger: console,
    });
    const record = {
      workspaceRoot: normalizedRoot,
      client,
      /** sessionId -> {turnId, mapper} for the turn currently in flight. */
      activeTurnBySession: new Map(),
      /** sessionId -> sessions this process created or resumed. */
      liveSessions: new Set(),
      /** requestId -> resolver waiting for the human's decision. */
      pendingApprovals: new Map(),
      pendingToolCalls: new Map(),
    };

    client.onNotification((method, params) => {
      if (method !== "session/update") {
        return;
      }
      const sessionId = normalizeText(params?.sessionId);
      const active = record.activeTurnBySession.get(sessionId);
      if (!active) {
        return;
      }
      emitAll(active.mapper.mapUpdate(params));
    });

    client.onRequest("session/request_permission", (params) => (
      handlePermissionRequest(record, params)
    ));

    client.onExit(() => {
      for (const [, pending] of record.pendingApprovals) {
        pending.resolve("");
      }
      record.pendingApprovals.clear();
      runtimes.delete(record.workspaceRoot);
    });

    runtimes.set(normalizedRoot, record);
    return record;
  }

  /**
   * Ask the human, then answer the agent.
   *
   * The answer must be an ACP option id, and a decision that never arrives must
   * fail closed: `buildPermissionResponse` returns `cancelled` rather than
   * pretending the operator allowed something.
   */
  async function handlePermissionRequest(record, params) {
    const sessionId = normalizeText(params?.sessionId);
    const requestId = `acp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const active = record.activeTurnBySession.get(sessionId);
    const turnId = active?.turnId || "";
    const event = mapPermissionRequest({ ...params, requestId }, {
      threadId: sessionId,
      turnId,
      pendingToolCalls: record.pendingToolCalls,
    });
    emit(event);

    const optionId = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        record.pendingApprovals.delete(requestId);
        resolve("");
      }, APPROVAL_TIMEOUT_MS);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      record.pendingApprovals.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        options: params?.options,
      });
    });

    emit(mapPermissionDecision({
      requestId,
      optionId,
      decision: optionId ? "allow" : "deny",
    }));
    return buildPermissionResponse({ optionId, decision: optionId ? "allow" : "deny" });
  }

  async function resolveSessionId(record, { bindingKey, workspaceRoot, conversationKey, sessionName }) {
    const stored = bindingKey && conversationKey
      ? sessionStore.getThreadIdForConversation(bindingKey, workspaceRoot, conversationKey)
      : "";
    if (stored && record.liveSessions.has(stored)) {
      // Already open in this process: neither resume nor create, just talk to it.
      // Resuming a live session would be refused (resume takes a persisted,
      // inactive one) and must never be mistaken for "no session".
      return { sessionId: stored, resumed: false, opening: false };
    }
    if (stored) {
      try {
        await record.client.resumeSession(stored, { cwd: workspaceRoot });
        record.liveSessions.add(stored);
        return { sessionId: stored, resumed: true, opening: false };
      } catch (error) {
        console.warn(
          `[cyberboss] dsh-acp session ${stored} could not be resumed `
          + `(${error?.message || error}); opening a new one for this window`,
        );
      }
    }
    const sessionId = await record.client.newSession({ cwd: workspaceRoot });
    record.liveSessions.add(sessionId);
    if (bindingKey && conversationKey) {
      sessionStore.setThreadIdForConversation(bindingKey, workspaceRoot, conversationKey, sessionId, {
        model: configuredModel,
        modelProvider: configuredProvider,
        sessionName: normalizeText(sessionName),
      });
    }
    return { sessionId, resumed: false, opening: true };
  }

  return {
    describe() {
      return {
        id: RUNTIME_ID,
        kind: "runtime",
        endpoint: resolveDshBin(config) || "(spawn)",
        sessionsFile: config.dshSessionsFile || config.sessionsFile,
        model: configuredModel,
        modelProvider: configuredProvider,
        limitations: {
          streamingReplyDelta: false,
          // ACP cancels one turn instead of abandoning the workspace runtime.
          cancelTurn: "session-cancel",
          approvalRespond: true,
          compactThread: false,
        },
        approval: resolveAcpPermissionMode(config),
        protocol: "acp",
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") return () => {};
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities() {
      return { nativeImageInput: true, toolImageRead: false };
    },
    supportsExecutionPolicy(executionPolicy) {
      const requested = normalizeText(executionPolicy);
      if (!requested) return true;
      // The canary policy needs a runtime it cannot influence; ACP has no such
      // isolation mode, so the adapter refuses rather than pretend to enforce it.
      return requested !== MODEL_CANARY_EXECUTION_POLICY;
    },
    async initialize() {
      if (readyState || closed) return readyState;
      const runtime = ensureRuntime(config.workspaceRoot || process.cwd());
      const result = await runtime.client.initialize();
      readyState = {
        endpoint: resolveDshBin(config),
        protocol: "acp",
        models: configuredModel ? [{ id: configuredModel, provider: configuredProvider }] : [],
        serverInfo: result?.agentInfo || null,
        capabilities: result?.agentCapabilities || null,
      };
      return readyState;
    },
    async close() {
      closed = true;
      const records = [...runtimes.values()];
      runtimes.clear();
      for (const record of records) {
        for (const [, pending] of record.pendingApprovals) {
          pending.resolve("");
        }
        record.pendingApprovals.clear();
        await record.client.close();
      }
      eventListeners.clear();
      readyState = null;
    },
    async startFreshThreadDraft({ bindingKey, workspaceRoot, conversationKey } = {}) {
      // A fresh session is a `session/new` away, so forgetting the stored id is
      // the whole draft. It is recorded as empty rather than deleted, so the read
      // path cannot fall back to a legacy slot for the same workspace.
      if (bindingKey && workspaceRoot) {
        if (normalizeText(conversationKey)) {
          sessionStore.setThreadIdForConversation(bindingKey, workspaceRoot, conversationKey, "");
        } else {
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        }
      }
      return { workspaceRoot };
    },
    async sendTurn({
      bindingKey,
      workspaceRoot,
      text,
      attachments = [],
      model = "",
      metadata = {},
    } = {}) {
      const record = ensureRuntime(workspaceRoot);
      await record.client.initialize();

      const conversationKey = normalizeText(metadata?.conversationKey);
      const sessionName = normalizeText(metadata?.sessionName);
      const { sessionId, resumed, opening } = await resolveSessionId(record, {
        bindingKey,
        workspaceRoot,
        conversationKey,
        sessionName,
      });

      const turnId = `acp-turn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const mapper = new AcpTurnMapper({
        threadId: sessionId,
        turnId,
        pendingToolCalls: record.pendingToolCalls,
      });
      record.activeTurnBySession.set(sessionId, { turnId, mapper });
      emit({ type: "runtime.turn.started", payload: { threadId: sessionId, turnId } });

      const body = opening
        // A brand-new session has no history, so the persona travels in the
        // opening message - with the window's own name first, which is also what
        // makes the session recognizable in the client's list.
        ? (sessionName
          ? `${sessionName}\n\n${buildOpeningTurnText(config, text)}`
          : buildOpeningTurnText(config, text))
        : text;
      const blocks = buildAcpContentBlocks({ text: body, attachments });
      if (blocks.length === 0) {
        record.activeTurnBySession.delete(sessionId);
        throw new Error("dsh-acp turn requires text or an attachment");
      }

      try {
        await record.client.prompt(sessionId, blocks);
      } catch (error) {
        record.activeTurnBySession.delete(sessionId);
        emitAll(mapper.finish({ failed: true, reason: error?.message || String(error) }));
        throw error;
      }
      record.activeTurnBySession.delete(sessionId);
      emitAll(mapper.finish());
      return { threadId: sessionId, turnId, resumed };
    },
    async sendTextTurn(args = {}) {
      return this.sendTurn({ ...args, attachments: [] });
    },
    async cancelTurn({ threadId } = {}) {
      const normalizedThread = normalizeText(threadId);
      for (const record of [...runtimes.values()]) {
        const ownsThread = record.activeTurnBySession.has(normalizedThread)
          || record.liveSessions.has(normalizedThread);
        if (normalizedThread && !ownsThread) {
          continue;
        }
        if (normalizedThread && typeof record.client.notify === "function") {
          // Cancel the turn, not the runtime: other sessions in this workspace keep
          // their conversations.
          record.client.notify("session/cancel", { sessionId: normalizedThread });
          continue;
        }
        record.client.kill();
        runtimes.delete(record.workspaceRoot);
      }
      return { threadId: normalizedThread };
    },
    async respondApproval({ requestId, decision } = {}) {
      const normalizedRequestId = normalizeText(requestId);
      if (!normalizedRequestId) {
        return false;
      }
      for (const record of runtimes.values()) {
        const pending = record.pendingApprovals.get(normalizedRequestId);
        if (!pending) {
          continue;
        }
        record.pendingApprovals.delete(normalizedRequestId);
        const wanted = normalizeText(decision) === "allow" ? "allow" : "deny";
        pending.resolve(selectPermissionOption(pending.options, wanted));
        return true;
      }
      return false;
    },
    async resumeThread({ threadId, workspaceRoot, bindingKey, conversationKey } = {}) {
      const normalizedThread = normalizeText(threadId);
      if (!normalizedThread) {
        throw new Error("dsh-acp resumeThread requires a threadId");
      }
      if (bindingKey && workspaceRoot) {
        if (normalizeText(conversationKey)) {
          sessionStore.setThreadIdForConversation(
            bindingKey,
            workspaceRoot,
            conversationKey,
            normalizedThread,
            { model: configuredModel, modelProvider: configuredProvider },
          );
        } else {
          sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, normalizedThread, {
            model: configuredModel,
            modelProvider: configuredProvider,
          });
        }
      }
      const record = ensureRuntime(workspaceRoot);
      await record.client.initialize();
      return { threadId: normalizedThread };
    },
    async compactThread() {
      return { compacted: false, reason: "unsupported_by_dsh_acp" };
    },
    async refreshThreadInstructions({ workspaceRoot, bindingKey, text, conversationKey } = {}) {
      const body = normalizeText(text) || buildInstructionRefreshText(config);
      if (!body) return { refreshed: false };
      await this.sendTurn({
        bindingKey,
        workspaceRoot,
        text: body,
        attachments: [],
        metadata: { conversationKey },
      });
      return { refreshed: true };
    },
    async listTurnGeneratedImages() {
      return [];
    },
    createClient() {
      return ensureRuntime(config.workspaceRoot || process.cwd()).client;
    },
  };
}

/**
 * ACP prompt blocks. Text is always a `text` block; an image becomes an `image`
 * block only when the caller supplied inline base64, because the client offers no
 * filesystem surface for the agent to read a path itself.
 */
function buildAcpContentBlocks({ text = "", attachments = [] } = {}) {
  const blocks = [];
  const body = String(text || "");
  if (body.trim()) {
    blocks.push({ type: "text", text: body });
  }
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const data = normalizeText(attachment?.base64 || attachment?.data);
    const mimeType = normalizeText(attachment?.mimeType || attachment?.contentType);
    if (data && mimeType.startsWith("image/")) {
      blocks.push({ type: "image", data, mimeType });
    }
  }
  return blocks;
}

module.exports = {
  createDshAcpRuntimeAdapter,
  RUNTIME_ID,
  buildAcpContentBlocks,
  resolveAcpPermissionMode,
};
