"use strict";

/**
 * DSH runtime adapter.
 *
 * DSH's SDK entry point (`dsh --profile sdk`) speaks JSON-RPC over stdio, which
 * makes it the structural peer of `codex app-server`. Two DSH-specific
 * constraints shape this adapter, both established by live capture (see
 * docs/dsh-sdk-protocol-notes.md):
 *
 * 1. `initialize` fixes `cwd` process-wide, and DSH derives its sandbox
 *    workspace root from `process.cwd()`. Cyberboss drives several workspaces
 *    through one adapter instance, so each workspace gets its own DSH child
 *    process, and a child is only ever spawned with `cwd` equal to that
 *    workspace. Getting this wrong would silently widen the sandbox.
 * 2. The SDK surface has no cancel and no session-close method. `cancelTurn` is
 *    therefore implemented by tearing down and respawning that workspace's
 *    runtime, which abandons any other turn in flight in the same workspace.
 */

const path = require("node:path");
const fs = require("node:fs");

const { DshRpcClient, defaultDshBin } = require("./rpc-client");
const { mapDshSessionEvent } = require("./events");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { ApprovalEndpoint } = require("../../../core/approval-endpoint");
const { decideApprovalWithHelper } = require("../../../core/approval-decider");
const {
  MODEL_CANARY_EXECUTION_POLICY,
} = require("../../../integrations/weflow-model-canary");

/**
 * How long to wait for `turn/start` after DSH has accepted a prompt. A runtime
 * that accepts the prompt but never starts a turn would otherwise hang the
 * caller forever.
 */
const TURN_START_TIMEOUT_MS = 120_000;

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Detect DSH's "this session already exists" conflict.
 *
 * `dsh-session` throws a plain Error with `session "<id>" already exists` (the
 * forking path uses a typed `SessionForkError` with code SESSION_ALREADY_EXISTS,
 * which does not apply here). The message is the only stable signal, so match it
 * narrowly rather than treating every prompt failure as a session conflict.
 */
function isSessionConflictError(error) {
  const code = normalizeText(error?.code);
  if (code === "SESSION_ALREADY_EXISTS") return true;
  const message = normalizeText(error?.message);
  return /^session ".+" already exists$/u.test(message);
}

// The only raster types DSH admits inline (SdkEncodedImageBlock.mimeType).
const SUPPORTED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const IMAGE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function isSupportedImageMime(value) {
  return SUPPORTED_IMAGE_MIMES.has(normalizeText(value).toLowerCase());
}

function imageMimeForPath(filePath) {
  return IMAGE_MIME_BY_EXTENSION.get(path.extname(normalizeText(filePath)).toLowerCase()) || "";
}

/**
 * Path to the overlay that composes the approval answerer into a DSH profile.
 *
 * A wrong path here is fatal rather than degraded: cordis resolves an insert's
 * `name` relative to the profile directory, so a missing overlay target makes
 * DSH exit 5 and the whole runtime unusable. Exported so a test can pin it
 * against the repository instead of discovering it at spawn time.
 */
function resolveApprovalPatchPath(dirname = __dirname) {
  return path.resolve(dirname, "..", "..", "..", "..", "dsh-plugins", "cyberboss-approval", "main.patch.yml");
}

/**
 * Path to the overlay that widens DSH's attachment admission limits.
 *
 * Applied unconditionally: the shipped default rejects any image with a side
 * over 8192 px, which is an ordinary long screenshot. Same fatality rule as the
 * approval overlay - a path that does not exist makes DSH exit 5 - so a test
 * pins it against the repository.
 */
function resolveAttachmentLimitsPatchPath(dirname = __dirname) {
  return path.resolve(dirname, "attachment-limits.patch.yml");
}

/**
 * Build the DSH `contentBlocks` for one turn.
 *
 * Accepts both shapes the app can hand over - an `absolutePath` reference (what
 * the WeChat inbound path produces, and what the Codex adapter consumes) and
 * already-inlined `{data, mimeType}` - so an image is never silently dropped.
 * `readFileSync` is injected so this contract is testable without touching disk.
 */
function buildDshContentBlocks({ text, attachments, readFileSync } = {}) {
  const blocks = [];
  const body = normalizeText(text);
  if (body) blocks.push({ type: "text", text: body });
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const absolutePath = normalizeText(attachment?.absolutePath || attachment?.filePath);
    const declaredMime = normalizeText(attachment?.mimeType).toLowerCase();
    const inlineData = normalizeText(attachment?.data || attachment?.base64);

    if (inlineData && isSupportedImageMime(declaredMime)) {
      blocks.push({ type: "image", data: inlineData, mimeType: declaredMime });
      continue;
    }
    if (!absolutePath) continue;

    const mime = isSupportedImageMime(declaredMime) ? declaredMime : imageMimeForPath(absolutePath);
    if (isSupportedImageMime(mime)) {
      let encoded = "";
      try {
        encoded = readFileSync(absolutePath).toString("base64");
      } catch (error) {
        // An unreadable image must not abort the turn: the text still has to
        // reach the model, and the failure has to be visible.
        console.error(
          `[cyberboss] dsh could not read image attachment ${absolutePath}: `
          + `${error?.message || error}`
        );
        continue;
      }
      if (encoded) {
        blocks.push({ type: "image", data: encoded, mimeType: mime });
        continue;
      }
    }
    // Not an inline-capable image: tell the model where the file is instead.
    blocks.push({ type: "text", text: `[attachment] ${absolutePath}` });
  }
  return blocks;
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function resolveDshBin(config) {
  return normalizeText(config.dshBin)
    || normalizeText(process.env.CYBERBOSS_DSH_BIN)
    || defaultDshBin();
}

function createDshRuntimeAdapter(config = {}) {
  const sessionStore = new SessionStore({
    filePath: config.dshSessionsFile || config.sessionsFile,
    runtimeId: "dsh",
  });

  const eventListeners = new Set();
  /** workspaceRoot -> runtime record */
  const runtimes = new Map();
  let readyState = null;
  let closed = false;

  // `session` turns every escalation into a question for a constrained
  // collaborative session; `never` rejects without asking; "" composes no
  // answerer at all, which DSH resolves to `unavailable` (fail closed).
  const approvalMode = normalizeText(config.dshApprovalMode).toLowerCase();
  const approvalEnabled = approvalMode === "session" || approvalMode === "never";
  const approvalPatchPath = approvalEnabled ? resolveApprovalPatchPath() : "";
  // Always applied: the shipped 8192-per-side default refuses ordinary long
  // screenshots before the model ever sees them.
  const attachmentLimitsPatchPath = resolveAttachmentLimitsPatchPath();
  let approvalEndpoint = null;
  let approvalEndpointStarting = null;

  /**
   * Resolve the tool arguments for one escalation.
   *
   * `ApprovalRequestEvent` carries only `{toolName, callId, reason}`, so the
   * command and justification have to come from the `tool/call` this adapter
   * already recorded under that callId. Entries live per workspace runtime, and
   * the endpoint is shared, so every runtime is searched. An unresolved callId
   * yields empty fields rather than a guess.
   */
  function resolveApprovalCallContext(callId) {
    const wanted = normalizeText(callId);
    if (!wanted) return {};
    for (const record of runtimes.values()) {
      const block = record.pendingToolCalls?.get(wanted);
      if (!block) continue;
      const args = block.arguments && typeof block.arguments === "object" ? block.arguments : {};
      return {
        toolName: normalizeText(block.name),
        command: normalizeText(args.command),
        justification: normalizeText(args.justification),
        requestedPermissions: normalizeText(args.sandbox_permissions),
      };
    }
    return {};
  }

  async function ensureApprovalEndpoint() {
    if (!approvalEnabled) return null;
    if (approvalEndpoint) return approvalEndpoint;
    if (approvalEndpointStarting) return approvalEndpointStarting;
    approvalEndpointStarting = (async () => {
      const endpoint = new ApprovalEndpoint({
        logger: console,
        decide: async ({ callId, reason }) => {
          const context = resolveApprovalCallContext(callId);
          return decideApprovalWithHelper({
            ...context,
            reason,
            dshBin: resolveDshBin(config),
            model: configuredModel,
            provider: configuredProvider,
            timeoutMs: config.dshApprovalTimeoutMs,
            logger: console,
          });
        },
      });
      await endpoint.start();
      approvalEndpoint = endpoint;
      return endpoint;
    })();
    try {
      return await approvalEndpointStarting;
    } finally {
      approvalEndpointStarting = null;
    }
  }

  const configuredModel = normalizeText(config.dshModel);
  const configuredProvider = normalizeText(config.dshProvider) || "deepseek-official";

  function emit(event) {
    if (!event) return;
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch (error) {
        // A broken listener must not take down the runtime.
        console.error(`[cyberboss] dsh event listener failed: ${error?.message || error}`);
      }
    }
  }

  /**
   * Per-workspace runtime: one DSH child, its session map, and the mapping from
   * DSH's numeric turn counter to the turn id Cyberboss correlates on.
   */
  function ensureRuntime(workspaceRoot) {
    const normalizedRoot = normalizeText(workspaceRoot) || config.workspaceRoot || process.cwd();
    let record = runtimes.get(normalizedRoot);
    if (record && record.client.isRunning()) {
      return record;
    }
    if (record) {
      // The child died; start a fresh one for the same workspace.
      record.client.kill();
      runtimes.delete(normalizedRoot);
    }

    const client = new DshRpcClient({
      dshBin: resolveDshBin(config),
      profile: normalizeText(config.dshProfile) || "sdk",
      cwd: normalizedRoot,
      provider: configuredProvider,
      model: configuredModel,
      reasoningEffort: normalizeText(config.dshReasoningEffort),
      maxTokens: config.dshMaxTokens,
      initializeTimeoutMs: config.dshInitializeTimeoutMs,
      requestTimeoutMs: config.dshRequestTimeoutMs,
      logger: console,
      // The answerer overlay names its plugin by absolute path, and the endpoint
      // and bearer token are per-spawn, so both travel to the child here.
      patchPaths: [attachmentLimitsPatchPath, approvalPatchPath].filter(Boolean),
      env: approvalEndpoint
        ? {
          CYBERBOSS_DSH_APPROVAL_ENDPOINT: approvalEndpoint.endpoint,
          CYBERBOSS_DSH_APPROVAL_TOKEN: approvalEndpoint.token,
        }
        : {},
    });

    record = {
      workspaceRoot: normalizedRoot,
      client,
      pendingToolCalls: new Map(),
      /** sessionId -> active turn id */
      activeTurnBySession: new Map(),
      /** sessionId -> active turn id, kept past turn end for late events */
      lastTurnBySession: new Map(),
      /**
       * sessionId -> resolver awaiting the next `turn/start`. DSH emits
       * `turn/start` while `session/prompt` is still in flight, so the turn id
       * cannot be handed back from sendTurn unless the handler and the caller
       * agree on one through this rendezvous.
       */
      turnStartWaiters: new Map(),
    };

    client.onNotification((method, params) => {
      handleNotification(record, method, params);
    });
    client.onExit(({ code, signal }) => {
      // Surface the death as a failed turn so a waiting reply is not left open.
      const detail = `DSH runtime exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      for (const [sessionId, turnId] of record.activeTurnBySession) {
        emit({
          type: "runtime.turn.failed",
          payload: { threadId: sessionId, turnId, text: detail },
        });
      }
      record.activeTurnBySession.clear();
      if (runtimes.get(normalizedRoot) === record) {
        runtimes.delete(normalizedRoot);
      }
    });

    runtimes.set(normalizedRoot, record);
    // Spawn eagerly. `initialize()` on the client is lazy, so relying on it would
    // hand out a runtime whose process does not exist yet to any caller that
    // reaches a runtime without going through the adapter's initialize() first.
    client.start();
    return record;
  }

  function handleNotification(record, method, params) {
    if (method !== "session.event") {
      // `session.status` mirrors agent liveness, which `turn/end` already
      // reports authoritatively; ignore it rather than double-reporting.
      return;
    }
    const sessionId = normalizeText(params?.sessionId);
    const type = normalizeText(params?.event?.type);

    if (type === "turn/start") {
      const turnId = `turn-${Date.now()}`;
      record.activeTurnBySession.set(sessionId, turnId);
      record.lastTurnBySession.set(sessionId, turnId);
      const waiter = record.turnStartWaiters.get(sessionId);
      if (waiter) {
        record.turnStartWaiters.delete(sessionId);
        waiter(turnId);
      }
    } else if (type === "turn/end") {
      // Keep the id available for the terminal event itself, then retire it.
      const turnId = record.activeTurnBySession.get(sessionId)
        || record.lastTurnBySession.get(sessionId)
        || "";
      const mapped = mapDshSessionEvent(params, {
        turnId,
        pendingToolCalls: record.pendingToolCalls,
      });
      record.activeTurnBySession.delete(sessionId);
      for (const event of mapped) emit(event);
      return;
    }

    const context = {
      turnId: record.activeTurnBySession.get(sessionId)
        || record.lastTurnBySession.get(sessionId)
        || "",
      pendingToolCalls: record.pendingToolCalls,
    };
    for (const event of mapDshSessionEvent(params, context)) emit(event);
  }

  /**
   * Convert Cyberboss turn input into DSH content blocks.
   *
   * Cyberboss hands the runtime attachment *references*, not bytes: the Codex
   * adapter reads `attachment.absolutePath` and sends {type:'localImage', path}.
   * DSH has no local-path image block - `SdkEncodedImageBlock` takes base64 - so
   * the file is read here and inlined. Reading by path (rather than expecting
   * inline data) is what makes inbound WeChat images actually reach the model;
   * an adapter that only understood {data, mimeType} would silently drop them.
   */
  function buildContentBlocks({ text, attachments }) {
    return buildDshContentBlocks({ text, attachments, readFileSync: fs.readFileSync });
  }

  function resolveModel(model = "", storedParams = null) {
    if (configuredModel) return configuredModel;
    if (storedParams && normalizeText(storedParams.modelProvider)
      && normalizeText(storedParams.modelProvider) !== configuredProvider) {
      return "";
    }
    return normalizeText(model);
  }

  return {
    describe() {
      return {
        id: "dsh",
        kind: "runtime",
        endpoint: resolveDshBin(config) || "(spawn)",
        sessionsFile: config.dshSessionsFile || config.sessionsFile,
        model: configuredModel,
        modelProvider: configuredProvider,
        // Be explicit about what this runtime cannot do, so operators are not
        // misled by a Codex-shaped describe() payload.
        limitations: {
          streamingReplyDelta: false,
          cancelTurn: "runtime-restart",
          approvalRespond: false,
          compactThread: false,
        },
        // Reported separately from `limitations` because it is configuration,
        // not a capability gap: `""` is the fail-closed default, `session` means
        // a collaborative session decides, `never` means reject outright.
        approval: approvalMode || "(none)",
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
      // DSH admits inline png/jpeg/webp/gif blocks, which covers native image
      // input. It has no read-image-from-disk tool contract we can rely on.
      return { nativeImageInput: true, toolImageRead: false };
    },
    supportsExecutionPolicy(executionPolicy) {
      // The model-canary execution policy selects an isolated runtime profile
      // (e.g. a separate Codex app-server with its own auth profile). DSH has no
      // equivalent isolation mode, so the adapter must refuse it rather than
      // accept a policy it cannot enforce.
      const requested = normalizeText(executionPolicy);
      if (!requested) return true;
      return requested !== MODEL_CANARY_EXECUTION_POLICY;
    },
    async initialize() {
      if (readyState || closed) return readyState;
      // The endpoint must exist before the first child spawns, because the child
      // receives its URL and token through the environment.
      await ensureApprovalEndpoint();
      const runtime = ensureRuntime(config.workspaceRoot || process.cwd());
      const result = await runtime.client.initialize();
      readyState = {
        endpoint: resolveDshBin(config),
        models: configuredModel ? [{ id: configuredModel, provider: configuredProvider }] : [],
        serverInfo: result?.serverInfo || null,
      };
      return readyState;
    },
    async close() {
      closed = true;
      const records = [...runtimes.values()];
      runtimes.clear();
      for (const record of records) {
        await record.client.close();
      }
      const endpoint = approvalEndpoint;
      approvalEndpoint = null;
      if (endpoint) {
        await endpoint.close();
      }
      eventListeners.clear();
      readyState = null;
    },
    async startFreshThreadDraft({ bindingKey, workspaceRoot } = {}) {
      // A fresh DSH session is created lazily by prompting an unused sessionId,
      // so clearing the stored id is all a draft needs.
      if (bindingKey && workspaceRoot) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
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
      const runtime = ensureRuntime(workspaceRoot);
      await runtime.client.initialize();

      let threadId = bindingKey
        ? sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot)
        : "";
      const openingTurn = !threadId;
      if (!threadId) {
        // DSH session ids are client-chosen and an unknown id lazily creates the
        // agent+session pair, so a fresh id is how a conversation starts.
        threadId = `dsh-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        if (bindingKey) {
          sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, {
            model: normalizeText(model) || configuredModel,
            modelProvider: configuredProvider,
            ...metadata,
          });
        }
      }

      // The Cyberboss persona travels inside the opening user message, exactly as
      // the Codex and Claude Code adapters do it. Without this a fresh DSH
      // session runs on DSH's own generic coding-agent system prompt alone, so
      // the WeChat persona never applies to the first turn.
      const turnText = openingTurn ? buildOpeningTurnText(config, text) : text;
      const contentBlocks = buildContentBlocks({ text: turnText, attachments });
      if (contentBlocks.length === 0) {
        throw new Error("dsh turn requires text or an attachment");
      }

      // DSH emits `turn/start` while `session/prompt` is still in flight, so the
      // authoritative turn id is the one the handler mints. Register a
      // rendezvous before prompting and return whatever it hands back, otherwise
      // the id returned here would never match the ids on the emitted events.
      let settleTurnStart;
      let turnStarted = new Promise((resolve) => {
        settleTurnStart = resolve;
      });
      runtime.turnStartWaiters.set(threadId, settleTurnStart);

      try {
        await runtime.client.prompt(threadId, contentBlocks);
      } catch (error) {
        runtime.turnStartWaiters.delete(threadId);
        runtime.activeTurnBySession.delete(threadId);
        if (!isSessionConflictError(error)) {
          throw error;
        }
        // The SDK server resolves a `session/prompt` for an id it does not hold
        // in memory by *creating* it, and `dsh-session` refuses to create an id
        // that already exists in its durable store. The protocol has no resume
        // method (only initialize/session/prompt/shutdown), so a session created
        // by an earlier process can never be prompted again: every runtime
        // restart - and every `/stop`, which respawns the runtime - would fail
        // the next message with `session "..." already exists`.
        //
        // Recovery is to continue the conversation on a new session. That costs
        // the model's context for this thread, which is worth stating plainly
        // rather than surfacing as a hard request failure.
        const replacedThreadId = threadId;
        threadId = `dsh-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        if (bindingKey) {
          sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, {
            model: normalizeText(model) || configuredModel,
            modelProvider: configuredProvider,
            ...metadata,
          });
        }
        console.warn(
          `[cyberboss] dsh session ${replacedThreadId} is not resumable in a new runtime process; `
          + `continuing on a fresh session ${threadId} (this thread's context was reset)`,
        );
        // A fresh session has no history, so the persona has to be re-sent.
        const retryBlocks = buildContentBlocks({
          text: buildOpeningTurnText(config, text),
          attachments,
        });
        turnStarted = new Promise((resolve) => {
          settleTurnStart = resolve;
        });
        runtime.turnStartWaiters.set(threadId, settleTurnStart);
        try {
          await runtime.client.prompt(threadId, retryBlocks);
        } catch (retryError) {
          runtime.turnStartWaiters.delete(threadId);
          runtime.activeTurnBySession.delete(threadId);
          throw retryError;
        }
      }

      const turnId = await withTimeout(turnStarted, TURN_START_TIMEOUT_MS);
      if (!turnId) {
        runtime.turnStartWaiters.delete(threadId);
        throw new Error("DSH accepted the prompt but never reported turn/start");
      }
      return { threadId, turnId };
    },
    async sendTextTurn(args = {}) {
      return this.sendTurn({ ...args, attachments: [] });
    },
    async cancelTurn({ threadId } = {}) {
      const normalizedThread = normalizeText(threadId);
      for (const record of [...runtimes.values()]) {
        const ownsThread = record.activeTurnBySession.has(normalizedThread)
          || record.lastTurnBySession.has(normalizedThread);
        // With no thread hint every runtime is a candidate; with a hint, only the
        // runtime that actually owns that thread is torn down.
        if (normalizedThread && !ownsThread) {
          continue;
        }
        // The SDK has no cancel, so abandoning the turn means ending the runtime
        // that owns it. Other turns in the same workspace are abandoned too,
        // because one runtime serves the whole workspace.
        record.client.kill();
        runtimes.delete(record.workspaceRoot);
      }
      return { threadId: normalizedThread };
    },
    async respondApproval() {
      // DSH answers approvals through answerers composed inside its own profile.
      // The SDK wire has no server-to-client request, so a client-side response
      // cannot exist; without an answerer DSH resolves `unavailable` and fails
      // closed. Report that plainly instead of pretending to answer.
      return false;
    },
    async resumeThread({ threadId, workspaceRoot, bindingKey } = {}) {
      const normalizedThread = normalizeText(threadId);
      if (!normalizedThread) {
        throw new Error("dsh resumeThread requires a threadId");
      }
      if (bindingKey && workspaceRoot) {
        sessionStore.setThreadIdForWorkspace(
          bindingKey,
          workspaceRoot,
          normalizedThread,
          { model: configuredModel, modelProvider: configuredProvider },
        );
      }
      const runtime = ensureRuntime(workspaceRoot);
      await runtime.client.initialize();
      return { threadId: normalizedThread };
    },
    async compactThread() {
      // No SDK compaction request exists; DSH compacts internally and reports
      // it as session events only.
      return { compacted: false, reason: "unsupported_by_dsh_sdk" };
    },
    async refreshThreadInstructions({ workspaceRoot, bindingKey, text } = {}) {
      const body = normalizeText(text) || buildInstructionRefreshText(config);
      if (!body) return { refreshed: false };
      // DSH has no instruction-reload method; the only way to add context is
      // another user turn carrying the refresh text.
      await this.sendTurn({ bindingKey, workspaceRoot, text: body, attachments: [] });
      return { refreshed: true };
    },
    async listTurnGeneratedImages() {
      return [];
    },
    createClient() {
      const runtime = ensureRuntime(config.workspaceRoot || process.cwd());
      return runtime.client;
    },
  };
}

module.exports = {
  createDshRuntimeAdapter,
  resolveDshBin,
  isSupportedImageMime,
  imageMimeForPath,
  buildDshContentBlocks,
  resolveApprovalPatchPath,
  resolveAttachmentLimitsPatchPath,
};
