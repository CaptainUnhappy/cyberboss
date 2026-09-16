const crypto = require("crypto");
const { sanitizeProtocolLeakText } = require("../adapters/runtime/codex/protocol-leak-monitor");
const { buildReplyDeliveryIdempotencyKey } = require("./reply-obligation-store");
const { MODEL_CANARY_DELIVERY_POLICY } = require("../integrations/weflow-model-canary");

const CURRENT_REPLY_HEADER = "===== 本轮模型回复 =====";
const MAX_MEDIA_DELIVERY_ATTEMPTS = 2;
// At most one 【进度】 message per turn per window. A multi-step turn can raise a
// dozen tool events, and relaying each one would flood the chat.
const TOOL_PROGRESS_THROTTLE_MS = 30_000;
// Longest command fragment worth putting in a progress line before it stops
// being a status and starts being a wall of text.
const TOOL_PROGRESS_COMMAND_MAX = 80;

class StreamDelivery {
  constructor({
    channelAdapter,
    sessionStore,
    runtimeId = "",
    onDeferredSystemReply,
    onReplyDeliveryStarted,
    onReplyDeliveryVerified,
    onReplyDeliveryDeferred,
    onReplyDeliveryFailed,
    onReplyTurnCompleted,
    onReplyTurnFailed,
    onReplyExplicitSilent,
    onModelCanaryEvent,
    systemReplyRetryScheduleMs,
    sameTokenRetryDelayMs,
  }) {
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.runtimeId = normalizeRuntimeId(runtimeId);
    this.systemReplyPolicy = createSystemReplyPolicy(this.runtimeId);
    this.onDeferredSystemReply = typeof onDeferredSystemReply === "function" ? onDeferredSystemReply : null;
    this.onReplyDeliveryStarted = normalizeCallback(onReplyDeliveryStarted);
    this.onReplyDeliveryVerified = normalizeCallback(onReplyDeliveryVerified);
    this.onReplyDeliveryDeferred = normalizeCallback(onReplyDeliveryDeferred);
    this.onReplyDeliveryFailed = normalizeCallback(onReplyDeliveryFailed);
    this.onReplyTurnCompleted = normalizeCallback(onReplyTurnCompleted);
    this.onReplyTurnFailed = normalizeCallback(onReplyTurnFailed);
    this.onReplyExplicitSilent = normalizeCallback(onReplyExplicitSilent);
    this.onModelCanaryEvent = normalizeCallback(onModelCanaryEvent);
    this.systemReplyRetryScheduleMs = Array.isArray(systemReplyRetryScheduleMs) && systemReplyRetryScheduleMs.length
      ? systemReplyRetryScheduleMs.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
      : [1_500, 2_500, 4_000, 6_000];
    this.sameTokenRetryDelayMs = Number.isFinite(sameTokenRetryDelayMs) && sameTokenRetryDelayMs >= 0
      ? sameTokenRetryDelayMs
      : 800;
    this.replyTargetByBindingKey = new Map();
    this.replyTargetByTurnKey = new Map();
    this.replyTargetQueueByThreadId = new Map();
    this.deferredReplyPrefixByBindingKey = new Map();
    this.stateByRunKey = new Map();
    this.runSequence = 0;
  }

  setReplyTarget(bindingKey, target) {
    const normalizedTarget = normalizeReplyTarget(target);
    if (!bindingKey || !normalizedTarget) {
      return;
    }
    this.replyTargetByBindingKey.set(bindingKey, normalizedTarget);
  }

  queueReplyTargetForThread(threadId, target) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTarget) {
      return;
    }
    const queue = this.replyTargetQueueByThreadId.get(normalizedThreadId) || [];
    queue.push(normalizedTarget);
    this.replyTargetQueueByThreadId.set(normalizedThreadId, queue);
    this.bindQueuedReplyTargetsToActiveThreadRuns(normalizedThreadId);
  }

  bindReplyTargetForTurn({ threadId = "", turnId = "", target = null } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTurnId || !normalizedTarget) {
      this.queueReplyTargetForThread(normalizedThreadId, target);
      return;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    this.replyTargetByTurnKey.set(runKey, normalizedTarget);
    const activeState = this.stateByRunKey.get(runKey);
    if (activeState) {
      this.applyThreadReplyTarget(activeState, normalizedTarget);
    }
  }

  setDeferredReplyPrefix(bindingKey, text) {
    const normalizedBindingKey = normalizeText(bindingKey);
    const normalizedText = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalizedBindingKey || !normalizedText) {
      return;
    }
    this.deferredReplyPrefixByBindingKey.set(normalizedBindingKey, normalizedText);
  }

  resolveReplyTargetForRun({ threadId = "", turnId = "" } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId) {
      return null;
    }
    const linked = this.sessionStore.findBindingForThreadId(normalizedThreadId);

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    const state = this.stateByRunKey.get(runKey);
    if (state?.replyTarget) {
      return constrainReplyTargetForBinding(state.replyTarget, linked);
    }

    const exactTurnTarget = this.replyTargetByTurnKey.get(runKey);
    if (exactTurnTarget) {
      return constrainReplyTargetForBinding(exactTurnTarget, linked);
    }

    const queuedTargets = this.replyTargetQueueByThreadId.get(normalizedThreadId);
    if (Array.isArray(queuedTargets) && queuedTargets.length > 0) {
      return constrainReplyTargetForBinding(queuedTargets[0], linked);
    }

    if (!linked?.bindingKey) {
      return null;
    }
    return constrainReplyTargetForBinding(this.replyTargetByBindingKey.get(linked.bindingKey), linked);
  }

  async handleRuntimeEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    if (!threadId) {
      return;
    }

    switch (event.type) {
      case "runtime.turn.started": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.attachReplyTarget(state);
        return;
      }
      case "runtime.tool.started": {
        const state = this.ensureRunState(threadId, turnId);
        this.attachReplyTarget(state);
        // Progress used to depend entirely on the model volunteering an interim
        // text block. Codex did that; DSH's model goes straight from reasoning to
        // a tool call, so nothing was ever rendered as 【进度】. Tool events are
        // the one genuinely live signal, so progress is derived from them here.
        //
        // Throttled per run because a multi-step turn raises many of them; the
        // first tool of a turn always reports, then at most one per window.
        const nowMs = Date.now();
        const lastProgressAtMs = Number(state.toolProgressAtMs) || 0;
        if (nowMs - lastProgressAtMs < TOOL_PROGRESS_THROTTLE_MS) {
          return;
        }
        const progressText = buildToolProgressText(event.payload);
        if (!progressText) {
          return;
        }
        state.toolProgressAtMs = nowMs;
        this.upsertItem(state, {
          itemId: `tool-progress-${normalizeText(event.payload.itemId) || state.itemOrder.length + 1}`,
          text: progressText,
          completed: true,
          // Rendered as 【进度】 by the channel adapter. Progress never closes the
          // reply obligation - the delivery path keys that off messageKind.
          phase: "commentary",
        });
        await this.flush(state, { force: false });
        return;
      }
      case "runtime.reply.delta": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: false,
          phase: normalizeMessagePhase(event.payload.phase),
        });
        return;
      }
      case "runtime.reply.completed": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: true,
          phase: normalizeMessagePhase(event.payload.phase),
        });
        if (!isModelCanaryReplyTarget(state.replyTarget)) {
          await this.flush(state, { force: false });
        }
        return;
      }
      case "runtime.media.completed": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertMediaItem(state, {
          itemId: normalizeText(event.payload.itemId) || `media-${state.itemOrder.length + 1}`,
          kind: normalizeText(event.payload.kind) || "file",
          filePath: normalizeText(event.payload.filePath),
          mimeType: normalizeText(event.payload.mimeType),
          sha256: normalizeText(event.payload.sha256),
          idempotencyKey: normalizeText(event.payload.idempotencyKey),
        });
        if (!isModelCanaryReplyTarget(state.replyTarget)) {
          await this.flush(state, { force: false });
        }
        return;
      }
      case "runtime.turn.completed": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.captureTurnCompletionText(state, event.payload.text);
        if (isModelCanaryReplyTarget(state.replyTarget)) {
          await this.flushModelCanary(state);
        } else {
          await this.flush(state, { force: true });
          await this.invokeReplyLifecycle(this.onReplyTurnCompleted, state, {
            hadFinalReply: state.finalReplyCandidateObserved,
            completedAt: normalizeText(event?.payload?.completedAt),
          });
        }
        this.disposeRunState(state.runKey);
        return;
      }
      case "runtime.turn.failed": {
        const runKey = buildRunKey(threadId, turnId);
        const state = this.stateByRunKey.get(runKey) || {
          runKey,
          threadId,
          turnId,
          replyTarget: this.resolveReplyTargetForRun({ threadId, turnId }),
        };
        if (isModelCanaryReplyTarget(state.replyTarget)) {
          await this.invokeModelCanaryEvent(state, { type: "turn_failed" });
        } else {
          await this.invokeReplyLifecycle(this.onReplyTurnFailed, state, {
            error: event?.payload?.error || event?.payload?.text || "runtime turn failed",
            failedAt: normalizeText(event?.payload?.failedAt),
          });
        }
        this.disposeRunState(runKey);
        return;
      }
      default:
        return;
    }
  }

  ensureRunState(threadId, turnId = "") {
    const runKey = buildRunKey(threadId, turnId);
    const existing = this.stateByRunKey.get(runKey);
    if (existing) {
      return existing;
    }

    const created = {
      runKey,
      threadId,
      bindingKey: "",
      replyTarget: null,
      deferredReplyPrefix: "",
      turnId: normalizeText(turnId),
      itemOrder: [],
      items: new Map(),
      sentItemIds: new Set(),
      sendChain: Promise.resolve(),
      flushPromise: null,
      sequence: this.runSequence += 1,
      threadReplyTargetAttached: false,
      finalReplyCandidateObserved: false,
    };
    this.stateByRunKey.set(runKey, created);
    this.attachReplyTarget(created);
    return created;
  }

  attachReplyTarget(state) {
    if (!state.threadReplyTargetAttached && state.turnId) {
      const exactTurnTarget = this.replyTargetByTurnKey.get(buildRunKey(state.threadId, state.turnId)) || null;
      if (exactTurnTarget) {
        this.applyThreadReplyTarget(state, exactTurnTarget);
      }
    }
    if (!state.threadReplyTargetAttached) {
      const threadTarget = this.consumeQueuedReplyTarget(state.threadId);
      if (threadTarget) {
        this.applyThreadReplyTarget(state, threadTarget);
      }
    }
    const linked = this.sessionStore.findBindingForThreadId(state.threadId);
    if (!linked?.bindingKey) {
      return;
    }
    state.bindingKey = linked.bindingKey;
    if (isModelCanaryBinding(linked) && !isModelCanaryReplyTarget(state.replyTarget)) {
      state.replyTarget = null;
      return;
    }
    if (!state.replyTarget) {
      const target = this.replyTargetByBindingKey.get(linked.bindingKey);
      state.replyTarget = target;
    }
    if (!state.deferredReplyPrefix) {
      const prefix = this.deferredReplyPrefixByBindingKey.get(linked.bindingKey) || "";
      if (prefix) {
        state.deferredReplyPrefix = prefix;
        this.deferredReplyPrefixByBindingKey.delete(linked.bindingKey);
      }
    }
  }

  captureTurnCompletionText(state, text) {
    const normalized = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalized || state.itemOrder.length > 0) {
      return;
    }
    this.upsertItem(state, {
      itemId: `result-${state.turnId || state.threadId}`,
      text: normalized,
      completed: true,
    });
  }

  upsertItem(state, { itemId, text, completed, phase = "" }) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        kind: "text",
        currentText: "",
        completedText: "",
        completed: false,
        phase: "",
      });
    }

    const current = state.items.get(itemId);
    const normalizedPhase = normalizeMessagePhase(phase);
    if (normalizedPhase) {
      current.phase = normalizedPhase;
    }
    if (completed) {
      current.currentText = text;
      current.completedText = text;
      current.completed = true;
      return;
    }

    current.currentText = appendStreamingText(current.currentText, text);
  }

  upsertMediaItem(state, { itemId, kind, filePath, mimeType = "", sha256 = "", idempotencyKey = "" }) {
    if (!itemId || !filePath) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
    }
    const existing = state.items.get(itemId);
    state.items.set(itemId, {
      kind: "media",
      mediaKind: kind,
      filePath,
      mimeType,
      sha256,
      idempotencyKey,
      completed: true,
      deliveryAttempts: Number.isFinite(Number(existing?.deliveryAttempts))
        ? Number(existing.deliveryAttempts)
        : 0,
    });
  }

  setItemText(state, itemId, text, completed) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        kind: "text",
        currentText: "",
        completedText: "",
        completed: false,
        phase: "",
      });
    }

    const current = state.items.get(itemId);
    current.currentText = text;
    if (completed) {
      current.completedText = text;
    }
    current.completed = Boolean(completed);
  }

  async flush(state, { force }) {
    const previous = state.flushPromise || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.flushNow(state, { force }));
    const tracked = current.finally(() => {
      const latestState = this.stateByRunKey.get(state.runKey);
      if (latestState && latestState.flushPromise === tracked) {
        latestState.flushPromise = null;
      }
    });
    state.flushPromise = tracked;
    await tracked;
  }

  async flushNow(state, { force }) {
    if (!state.replyTarget) {
      return;
    }

    // Model probes have a separate terminal-only delivery path. Never let a
    // delta, commentary item, generated file, or raw model answer reach the
    // ordinary reply formatter.
    if (isModelCanaryReplyTarget(state.replyTarget)) {
      return;
    }

    if (state.replyTarget.deliveryPolicy === "silent") {
      this.restoreDeferredReplyPrefix(state);
      this.markAllItemsSent(state);
      console.log(`[cyberboss] suppressed background reply thread=${state.threadId}`);
      return;
    }

    if (state.replyTarget.provider === "system") {
      await this.flushSystemReply(state, { force });
      return;
    }

    const pendingDeliveries = collectPendingReplyDeliveries(state, { force });
    if (!pendingDeliveries.length) {
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      let shouldSendMediaFailureNotice = false;
      for (let index = 0; index < pendingDeliveries.length; index += 1) {
        const delivery = pendingDeliveries[index];
        const prependDeferredPrefix = Boolean(state.deferredReplyPrefix) && delivery.kind !== "media";
        try {
          await this.sendReplyDelivery(state, delivery, {
            prependDeferredPrefix,
          });
        } catch (error) {
          if (delivery.kind !== "media") {
            throw error;
          }
          const mediaItem = state.items.get(delivery.itemId);
          if (mediaItem) {
            mediaItem.deliveryAttempts = (Number(mediaItem.deliveryAttempts) || 0) + 1;
          }
          const attempts = Number(mediaItem?.deliveryAttempts) || 1;
          console.error(
            `[cyberboss] generated image send attempt failed thread=${state.threadId} item=${delivery.itemId} attempt=${attempts}: ${error.message}`
          );
          if (attempts >= MAX_MEDIA_DELIVERY_ATTEMPTS) {
            state.sentItemIds.add(delivery.itemId);
            shouldSendMediaFailureNotice = true;
          }
          continue;
        }
        state.sentItemIds.add(delivery.itemId);
        if (prependDeferredPrefix) {
          state.deferredReplyPrefix = "";
        }
      }
      if (shouldSendMediaFailureNotice) {
        await this.sendMediaFailureNotice(state);
      }
    }).catch((error) => {
      console.error(`[cyberboss] failed to deliver reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async flushModelCanary(state) {
    if (!state?.replyTarget || !isModelCanaryReplyTarget(state.replyTarget)) {
      return;
    }
    const assistantFinal = resolveModelCanaryFinalText(state);
    if (!assistantFinal) {
      await this.invokeModelCanaryEvent(state, { type: "turn_completed_without_final" });
      this.markAllItemsSent(state);
      return;
    }

    const completed = await this.invokeModelCanaryEvent(state, {
      type: "model_completed",
      assistantFinalSha256: crypto.createHash("sha256").update(assistantFinal, "utf8").digest("hex"),
      assistantFinalLength: [...assistantFinal].length,
      assistantFinalBytes: Buffer.byteLength(assistantFinal, "utf8"),
    });
    if (completed?.accepted !== true) {
      this.markAllItemsSent(state);
      return;
    }
    const claim = await this.invokeModelCanaryEvent(state, { type: "claim_reply_dispatch" });
    if (claim?.claimed !== true) {
      this.markAllItemsSent(state);
      return;
    }

    const target = state.replyTarget;
    const payload = {
      userId: target.userId,
      text: target.canonicalText,
      contextToken: target.contextToken,
      preserveBlock: true,
      provider: "weflow-uia",
      messageKind: target.messageKind,
      idempotencyKey: target.idempotencyKey,
      weflowContact: target.weflowContact,
      weflowTalker: target.weflowTalker,
      weflowExactContact: true,
      desktopInputLease: target.desktopInputLease,
    };
    try {
      const sendResult = await this.channelAdapter.sendText(payload);
      await this.invokeModelCanaryEvent(state, {
        type: "reply_dispatched",
        sendResult,
      });
    } catch (error) {
      await this.invokeModelCanaryEvent(state, {
        type: "reply_delivery_failed",
        error,
      });
    }
    this.markAllItemsSent(state);
  }

  async flushSystemReply(state, { force }) {
    if (!force) {
      return;
    }

    const replyText = buildReplyText(state, { completedOnly: false });
    const resolved = resolveSystemReplyDelivery(replyText, this.systemReplyPolicy);
    if (resolved.kind === "silent") {
      this.markAllItemsSent(state);
      console.log(
        `[cyberboss] suppressed system reply thread=${state.threadId} action=silent preview=${JSON.stringify(replyText.slice(0, 120))}`
      );
      return;
    }

    if (resolved.kind !== "send_message") {
      console.error(
        `[cyberboss] invalid system reply thread=${state.threadId} reason=${resolved.reason} preview=${JSON.stringify(replyText.slice(0, 160))}`
      );
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      await this.sendSystemReply(state, resolved.message);
      this.markAllItemsSent(state);
    }).catch((error) => {
      console.error(`[cyberboss] failed to deliver system reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async sendReplyDelivery(state, delivery, { prependDeferredPrefix = false } = {}) {
    if (!delivery || !state.replyTarget) {
      return;
    }
    const isProgress = delivery.messageKind === "progress";

    if (delivery.kind === "silent") {
      if (!isProgress) {
        state.finalReplyCandidateObserved = true;
        await this.invokeReplyLifecycle(this.onReplyExplicitSilent, state, {
          itemId: delivery.itemId,
        });
      }
      return;
    }

    if (delivery.kind === "invalid_action") {
      console.error(
        `[cyberboss] invalid structured action item thread=${state.threadId} reason=${delivery.reason} preview=${JSON.stringify((delivery.sourceText || "").slice(0, 160))}`
      );
      if (!isProgress) {
        state.finalReplyCandidateObserved = true;
        await this.invokeReplyLifecycle(this.onReplyDeliveryFailed, state, {
          error: new Error(`invalid structured action: ${delivery.reason || "unknown reason"}`),
          deliveryUncertain: false,
        });
      }
      return;
    }

    if (delivery.kind === "media") {
      const obligationId = normalizeText(state.replyTarget.replyObligationId);
      const idempotencyKey = obligationId
        ? buildReplyDeliveryIdempotencyKey(obligationId, delivery.itemId)
        : delivery.idempotencyKey;
      const payload = {
        userId: state.replyTarget.userId,
        filePath: delivery.filePath,
        contextToken: state.replyTarget.contextToken,
        messageKind: "generated_image",
        idempotencyKey,
        sha256: delivery.sha256,
      };
      if (state.replyTarget.provider) {
        payload.provider = state.replyTarget.provider;
      }
      if (!obligationId) {
        await this.channelAdapter.sendFile(payload);
        return;
      }

      state.finalReplyCandidateObserved = true;
      try {
        await this.invokeReplyLifecycle(this.onReplyDeliveryStarted, state, {
          itemId: delivery.itemId,
          text: "",
          messageKind: "generated_image",
          idempotencyKey,
          sha256: delivery.sha256,
        }, { propagate: true });
      } catch (error) {
        error.deliveryUncertain = false;
        await this.invokeReplyLifecycle(this.onReplyDeliveryFailed, state, {
          error,
          deliveryUncertain: false,
        });
        return;
      }

      try {
        const result = await this.channelAdapter.sendFile(payload);
        const localId = normalizePositiveIntegerText(result?.localId);
        if (result?.verified === true && localId) {
          await this.invokeReplyLifecycle(this.onReplyDeliveryVerified, state, {
            localId,
            verifiedAt: normalizeText(result?.verifiedAt),
          });
        } else {
          await this.invokeReplyLifecycle(this.onReplyDeliveryFailed, state, {
            error: new Error("WeFlow UIA media send did not return a verified local id"),
            deliveryUncertain: result?.uncertain !== false,
          });
        }
      } catch (error) {
        await this.invokeReplyLifecycle(this.onReplyDeliveryFailed, state, {
          error,
          deliveryUncertain: error?.deliveryUncertain,
        });
      }
      return;
    }

    const baseText = delivery.kind === "action" ? delivery.message : delivery.text;
    if (!baseText) {
      return;
    }

    if (!isProgress) {
      state.finalReplyCandidateObserved = true;
    }

    const payload = {
      userId: state.replyTarget.userId,
      text: prependDeferredPrefix ? buildEffectiveReplyText(state.deferredReplyPrefix, baseText) : baseText,
      contextToken: state.replyTarget.contextToken,
    };
    if (delivery.messageKind) {
      payload.messageKind = delivery.messageKind;
    }
    if (state.replyTarget.provider === "weflow-uia") {
      payload.provider = "weflow-uia";
    }
    if (prependDeferredPrefix) {
      payload.preserveBlock = true;
    }
    const obligationId = isProgress ? "" : normalizeText(state.replyTarget.replyObligationId);
    const idempotencyKey = obligationId
      ? buildReplyDeliveryIdempotencyKey(obligationId, delivery.itemId)
      : "";
    if (idempotencyKey) {
      payload.idempotencyKey = idempotencyKey;
    }
    if (obligationId) {
      try {
        await this.invokeReplyLifecycle(this.onReplyDeliveryStarted, state, {
          itemId: delivery.itemId,
          text: payload.text,
          messageKind: delivery.messageKind || "plain_reply",
          idempotencyKey,
        }, { propagate: true });
      } catch (error) {
        error.deliveryUncertain = false;
        const deferred = await this.deferSystemReply(state, payload.text, error, "plain_reply");
        if (deferred) {
          await this.invokeReplyLifecycle(this.onReplyDeliveryDeferred, state, { error });
          return;
        }
        await this.invokeReplyLifecycle(this.onReplyDeliveryFailed, state, {
          error,
          deliveryUncertain: false,
        });
        return;
      }
    }

    try {
      const outcome = await this.sendTextWithRetry(state, payload, { kind: "plain_reply" });
      if (!obligationId) {
        return;
      }
      if (outcome.status === "deferred") {
        await this.invokeReplyLifecycle(this.onReplyDeliveryDeferred, state, {
          error: outcome.error,
        });
        return;
      }
      const localId = normalizePositiveIntegerText(outcome.result?.localId);
      if (outcome.status === "sent" && outcome.result?.verified === true && localId) {
        try {
          await this.invokeReplyLifecycle(this.onReplyDeliveryVerified, state, {
            localId,
            verifiedAt: normalizeText(outcome.result?.verifiedAt),
          }, { propagate: true });
        } catch (error) {
          // The outbound call already returned a verified local id. A failed
          // lifecycle write is therefore uncertain from the stream's point of
          // view and must never cause a duplicate retry/defer.
          error.deliveryUncertain = true;
          throw error;
        }
        return;
      }
      const resultWasCertainlyNotDispatched = outcome.result?.uncertain === false
        && outcome.result?.verified !== true;
      await this.invokeReplyLifecycle(this.onReplyDeliveryFailed, state, {
        error: new Error("WeFlow UIA send did not return a verified local id"),
        deliveryUncertain: !resultWasCertainlyNotDispatched,
      });
    } catch (error) {
      if (obligationId) {
        await this.invokeReplyLifecycle(this.onReplyDeliveryFailed, state, {
          error,
          deliveryUncertain: error?.deliveryUncertain,
        });
        return;
      }
      throw error;
    }
  }

  async sendSystemReply(state, text) {
    const initialTarget = state.replyTarget;
    const payload = {
      userId: initialTarget.userId,
      text,
      contextToken: initialTarget.contextToken,
    };
    if (initialTarget.provider === "weflow-uia") {
      payload.provider = "weflow-uia";
    }
    await this.sendTextWithRetry(state, payload, { kind: "system_reply" });
  }

  async sendTextWithRetry(state, payload, { kind }) {
    const initialTarget = state.replyTarget;
    let latestError = null;
    try {
      const result = await this.channelAdapter.sendText(payload);
      return { status: "sent", result };
    } catch (error) {
      latestError = error;
      const retryTarget = this.resolveRetriableReplyTarget(initialTarget, error);
      if (retryTarget) {
        console.warn(
          `[cyberboss] system reply retrying with refreshed context token thread=${state.threadId} user=${retryTarget.userId}`
        );
        try {
          const retryPayload = this.buildRetryPayload(payload, retryTarget);
          const result = await this.channelAdapter.sendText(retryPayload);
          this.rememberSuccessfulReplyTarget(state, retryTarget);
          return { status: "sent", result };
        } catch (retryError) {
          latestError = retryError;
        }
      }
    }

    const contextlessTarget = this.resolveContextlessReplyTarget(initialTarget, latestError);
    if (contextlessTarget) {
      console.warn(
        `[cyberboss] system reply retrying without context token thread=${state.threadId} user=${contextlessTarget.userId}`
      );
      try {
        const retryPayload = this.buildRetryPayload(payload, contextlessTarget);
        retryPayload.omitContextToken = true;
        const result = await this.channelAdapter.sendText(retryPayload);
        this.rememberSuccessfulReplyTarget(state, contextlessTarget);
        return { status: "sent", result };
      } catch (retryError) {
        latestError = retryError;
      }
    }

    if (payload.messageKind === "progress") {
      console.warn(
        `[cyberboss] dropped stale progress reply thread=${state.threadId} user=${initialTarget?.userId || ""}`
      );
      return { status: "dropped_progress", error: latestError };
    }

    const deferred = await this.deferSystemReply(state, payload.text, latestError, kind);
    if (deferred) {
      return { status: "deferred", error: latestError };
    }
    throw latestError;
  }

  async sendMediaFailureNotice(state) {
    const target = state.replyTarget;
    if (!target?.userId) {
      return;
    }
    const payload = {
      userId: target.userId,
      text: "❌ 图片已经生成，但发送到微信失败；原图已保留，可稍后补发。",
      contextToken: target.contextToken,
    };
    if (target.provider === "weflow-uia") {
      payload.provider = "weflow-uia";
    }
    await this.channelAdapter.sendText(payload);
  }

  buildRetryPayload(payload, target) {
    const retryPayload = {
      userId: target.userId,
      text: payload.text,
      contextToken: target.contextToken,
    };
    if (payload.preserveBlock) {
      retryPayload.preserveBlock = true;
    }
    if (payload.provider) {
      retryPayload.provider = payload.provider;
    }
    if (payload.messageKind) {
      retryPayload.messageKind = payload.messageKind;
    }
    if (payload.idempotencyKey) {
      retryPayload.idempotencyKey = payload.idempotencyKey;
    }
    return retryPayload;
  }

  rememberSuccessfulReplyTarget(state, target) {
    state.replyTarget = normalizeReplyTarget(target);
    if (state.bindingKey) {
      this.replyTargetByBindingKey.set(state.bindingKey, normalizeReplyTarget(target));
    }
  }

  async deferSystemReply(state, text, error, kind = "plain_reply") {
    if (typeof this.onDeferredSystemReply !== "function") {
      return false;
    }
    const target = state?.replyTarget || {};
    const isCertainWeFlowUiaFailure = target.provider === "weflow-uia"
      && error?.deliveryUncertain === false;
    if (!isSystemReplyContextFailure(error) && !isCertainWeFlowUiaFailure) {
      return false;
    }
    if (!target.userId || !text) {
      return false;
    }
    try {
      await this.onDeferredSystemReply({
        threadId: state.threadId,
        userId: target.userId,
        text,
        error,
        kind,
      });
      console.warn(
        `[cyberboss] deferred system reply until the next inbound message thread=${state.threadId} user=${target.userId}`
      );
      return true;
    } catch (deferError) {
      console.error(`[cyberboss] failed to defer system reply thread=${state.threadId}: ${deferError.message}`);
      return false;
    }
  }

  async invokeReplyLifecycle(callback, state, payload = {}, { propagate = false } = {}) {
    const obligationId = normalizeText(state?.replyTarget?.replyObligationId);
    if (!obligationId || typeof callback !== "function") {
      return false;
    }
    try {
      await callback({
        replyObligationId: obligationId,
        threadId: normalizeText(state?.threadId),
        turnId: normalizeText(state?.turnId),
        ...payload,
      });
      return true;
    } catch (error) {
      if (propagate) throw error;
      console.error(
        `[cyberboss] reply obligation lifecycle write failed id=${obligationId}: ${error.message}`
      );
      return false;
    }
  }

  async invokeModelCanaryEvent(state, payload = {}) {
    if (!isModelCanaryReplyTarget(state?.replyTarget)
      || typeof this.onModelCanaryEvent !== "function") {
      return { accepted: false, reason: "model_canary_callback_missing" };
    }
    try {
      return await this.onModelCanaryEvent({
        ...payload,
        target: normalizeReplyTarget(state.replyTarget),
        threadId: normalizeText(state.threadId),
        turnId: normalizeText(state.turnId),
      });
    } catch (error) {
      console.error(
        `[cyberboss] model canary lifecycle failed runId=${state.replyTarget.modelCanaryRunId || "(unknown)"}: ${error.message}`
      );
      return { accepted: false, reason: "model_canary_lifecycle_failed" };
    }
  }

  resolveRetriableReplyTarget(currentTarget, error) {
    if (!isSystemReplyContextFailure(error)) {
      return null;
    }
    if (!currentTarget?.userId) {
      return null;
    }
    if (typeof this.channelAdapter.getKnownContextTokens !== "function") {
      return null;
    }
    const tokens = this.channelAdapter.getKnownContextTokens();
    const refreshedContextToken = normalizeText(tokens?.[currentTarget.userId]);
    if (!refreshedContextToken || refreshedContextToken === currentTarget.contextToken) {
      return null;
    }
    return normalizeReplyTarget({
      userId: currentTarget.userId,
      contextToken: refreshedContextToken,
      provider: currentTarget.provider,
      deliveryPolicy: currentTarget.deliveryPolicy,
      replyObligationId: currentTarget.replyObligationId,
    });
  }

  resolveContextlessReplyTarget(currentTarget, error) {
    if (!isSystemReplyContextFailure(error) || !currentTarget?.userId) {
      return null;
    }
    return normalizeReplyTarget({
      userId: currentTarget.userId,
      contextToken: "",
      provider: currentTarget.provider,
      deliveryPolicy: currentTarget.deliveryPolicy,
      replyObligationId: currentTarget.replyObligationId,
    });
  }

  disposeRunState(runKey) {
    const normalizedRunKey = normalizeText(runKey);
    if (!normalizedRunKey) {
      return;
    }
    this.replyTargetByTurnKey.delete(normalizedRunKey);
    this.stateByRunKey.delete(normalizedRunKey);
  }

  bindQueuedReplyTargetsToActiveThreadRuns(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return;
    }
    const states = [...this.stateByRunKey.values()]
      .filter((state) => state.threadId === threadId && !state.threadReplyTargetAttached)
      .sort((left, right) => left.sequence - right.sequence);
    for (const state of states) {
      const nextTarget = queue.shift();
      if (!nextTarget) {
        break;
      }
      this.applyThreadReplyTarget(state, nextTarget);
    }
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
      return;
    }
    this.replyTargetQueueByThreadId.delete(threadId);
  }

  consumeQueuedReplyTarget(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return null;
    }
    const target = queue.shift() || null;
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
    } else {
      this.replyTargetQueueByThreadId.delete(threadId);
    }
    return target;
  }

  applyThreadReplyTarget(state, target) {
    state.replyTarget = normalizeReplyTarget(target);
    state.threadReplyTargetAttached = true;
  }

  restoreDeferredReplyPrefix(state) {
    if (!state?.bindingKey || !state.deferredReplyPrefix) {
      return;
    }
    if (!this.deferredReplyPrefixByBindingKey.has(state.bindingKey)) {
      this.deferredReplyPrefixByBindingKey.set(state.bindingKey, state.deferredReplyPrefix);
    }
    state.deferredReplyPrefix = "";
  }

  markAllItemsSent(state) {
    for (const itemId of state.itemOrder) {
      state.sentItemIds.add(itemId);
    }
  }
}

function buildRunKey(threadId, turnId = "") {
  const normalizedThreadId = normalizeText(threadId);
  const normalizedTurnId = normalizeText(turnId);
  return normalizedTurnId
    ? `${normalizedThreadId}:${normalizedTurnId}`
    : `${normalizedThreadId}:pending`;
}

function buildReplyText(state, { completedOnly }) {
  const parts = [];
  for (const itemId of state.itemOrder) {
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }

    const sourceText = completedOnly
      ? (item.completed ? item.completedText : "")
      : (item.completed ? item.completedText : item.currentText);
    const normalized = trimOuterBlankLines(sourceText);
    if (normalized) {
      parts.push(normalized);
    }
  }
  return parts.join("\n\n");
}

function collectPendingReplyDeliveries(state, { force }) {
  const pending = [];
  for (const itemId of state.itemOrder) {
    if (state.sentItemIds.has(itemId)) {
      continue;
    }
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }
    if (item.kind === "media") {
      if (item.completed && item.filePath) {
        pending.push({
          itemId,
          kind: "media",
          mediaKind: item.mediaKind,
          filePath: item.filePath,
          mimeType: item.mimeType,
          sha256: item.sha256,
          idempotencyKey: item.idempotencyKey,
        });
      }
      continue;
    }
    const sourceText = resolvePlainReplySourceText(item, force);
    if (!sourceText) {
      continue;
    }
    const structuredAction = classifyReplyItemSourceText(sourceText);
    const messageKind = normalizeMessagePhase(item.phase) === "commentary" ? "progress" : "";
    if (structuredAction) {
      pending.push(buildActionDelivery(itemId, sourceText, structuredAction, messageKind));
      continue;
    }
    const plainText = markdownToPlainText(sourceText);
    const sanitizedText = sanitizeReplyText(plainText);
    if (!sanitizedText) {
      continue;
    }
    pending.push({ itemId, kind: "plain", text: sanitizedText, messageKind });
  }
  return pending;
}

function resolvePlainReplySourceText(item, force) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.completed) {
    return trimOuterBlankLines(item.completedText || item.currentText || "");
  }
  if (!force) {
    return "";
  }
  return trimOuterBlankLines(item.currentText || "");
}

function buildEffectiveReplyText(deferredPrefix, replyText) {
  const prefix = trimOuterBlankLines(normalizeLineEndings(deferredPrefix));
  const body = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (prefix && body) {
    return `${prefix}\n\n${CURRENT_REPLY_HEADER}\n${body}`;
  }
  return prefix || body;
}

function markdownToPlainText(text) {
  let result = normalizeLineEndings(text);
  result = result.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/```([^\n]*)\n?([\s\S]*)$/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^#{1,6}\s*(.+)$/gm, "$1");
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/^>\s?/gm, "> ");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner) =>
    String(inner || "").split("|").map((cell) => cell.trim()).join("  ")
  );
  result = result.replace(/\n{3,}/g, "\n\n");
  return trimOuterBlankLines(result);
}

function appendStreamingText(current, next) {
  const base = String(current || "");
  const incoming = String(next || "");
  if (!incoming) {
    return base;
  }
  if (!base) {
    return incoming;
  }
  if (base.endsWith(incoming)) {
    return base;
  }
  if (incoming.startsWith(base)) {
    return incoming;
  }

  const maxOverlap = Math.min(base.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === incoming.slice(0, size)) {
      return `${base}${incoming.slice(size)}`;
    }
  }

  return `${base}${incoming}`;
}

function indentBlock(text) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(text));
  if (!normalized) {
    return "";
  }
  return normalized.split("\n").map((line) => `    ${line}`).join("\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCallback(value) {
  return typeof value === "function" ? value : null;
}

function normalizePositiveIntegerText(value) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  try {
    return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text).toString() : "";
  } catch {
    return "";
  }
}

function normalizeReplyTarget(target) {
  if (!target?.userId) {
    return null;
  }
  const normalized = {
    userId: String(target.userId).trim(),
    contextToken: normalizeText(target.contextToken),
    provider: normalizeText(target.provider),
  };
  const deliveryPolicy = normalizeText(target.deliveryPolicy);
  if (deliveryPolicy) {
    normalized.deliveryPolicy = deliveryPolicy;
  }
  const replyObligationId = normalizeText(target.replyObligationId);
  if (replyObligationId) {
    normalized.replyObligationId = replyObligationId;
  }
  for (const key of [
    "modelCanaryRunId",
    "modelCanaryNonce",
    "modelCanaryObligationFingerprint",
    "modelCanaryExecutionPolicy",
    "weflowContact",
    "weflowTalker",
    "messageKind",
    "idempotencyKey",
    "canonicalText",
  ]) {
    const value = normalizeText(target[key]);
    if (value) normalized[key] = value;
  }
  if (target.weflowExactContact === true) normalized.weflowExactContact = true;
  const desktopInputLease = normalizeDesktopInputLease(target.desktopInputLease);
  if (desktopInputLease) normalized.desktopInputLease = desktopInputLease;
  const requireDesktopIdleSeconds = normalizePositiveInteger(target.requireDesktopIdleSeconds);
  if (requireDesktopIdleSeconds) normalized.requireDesktopIdleSeconds = requireDesktopIdleSeconds;
  return normalized;
}

function normalizeDesktopInputLease(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    version: Number(raw.version),
    mode: normalizeText(raw.mode),
    runId: normalizeText(raw.runId).toLowerCase(),
    nonce: normalizeText(raw.nonce).toLowerCase(),
    targetFingerprint: normalizeText(raw.targetFingerprint).toLowerCase(),
    replyIdempotencyKey: normalizeText(raw.replyIdempotencyKey),
    expiresAt: normalizeText(raw.expiresAt),
    token: normalizeText(raw.token).toLowerCase(),
  };
}

function constrainReplyTargetForBinding(target, linked) {
  const normalized = normalizeReplyTarget(target);
  if (isModelCanaryBinding(linked) && !isModelCanaryReplyTarget(normalized)) {
    return null;
  }
  return normalized;
}

function isModelCanaryBinding(linked) {
  return normalizeText(linked?.senderId).startsWith("cyberboss-model-canary:");
}

function isModelCanaryReplyTarget(target) {
  return target?.deliveryPolicy === MODEL_CANARY_DELIVERY_POLICY;
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function resolveModelCanaryFinalText(state) {
  const items = (Array.isArray(state?.itemOrder) ? state.itemOrder : [])
    .map((itemId) => state.items?.get?.(itemId))
    .filter((item) => item?.kind !== "media" && item?.completed === true);
  const explicitFinal = items
    .filter((item) => normalizeMessagePhase(item.phase) === "final_answer")
    .map((item) => trimOuterBlankLines(item.completedText || item.currentText))
    .filter(Boolean);
  if (explicitFinal.length) return explicitFinal.join("\n\n");
  return items
    .filter((item) => normalizeMessagePhase(item.phase) !== "commentary")
    .map((item) => trimOuterBlankLines(item.completedText || item.currentText))
    .filter(Boolean)
    .join("\n\n");
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function sanitizeReplyText(plainReplyText) {
  const normalized = normalizeLineEndings(String(plainReplyText || ""));
  if (!normalized) {
    return "";
  }
  const protocolSanitized = sanitizeProtocolLeakText(normalized);
  return trimOuterBlankLines(protocolSanitized.text || "");
}

function resolveSystemReplyDelivery(replyText, policy = createSystemReplyPolicy("")) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return { kind: "invalid", reason: "final reply is empty" };
  }

  const source = normalizeSystemReplySource(normalized);
  if (source.requiresStructuredAction || source.text.startsWith("{")) {
    return resolveSystemReplyAction(source.text);
  }

  if (!policy.allowPlainTextSendMessage) {
    return { kind: "invalid", reason: "final reply is not a JSON object" };
  }

  return resolvePlainTextSystemReply(source.text, policy);
}

function resolveSystemReplyAction(candidate) {
  const parsed = tryParseJson(candidate);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return { kind: "invalid", reason: "final reply is not a JSON object" };
  }

  const action = normalizeSystemActionName(parsed.action || parsed.cyberboss_action);
  if (action === "silent") {
    return { kind: "silent" };
  }
  if (action !== "send_message") {
    return { kind: "invalid", reason: "unsupported action" };
  }

  const message = sanitizeProtocolLeakText(normalizeLineEndings(String(parsed.message || parsed.text || ""))).text.trim();
  if (!message) {
    return { kind: "invalid", reason: "send_message requires a non-empty message" };
  }

  return { kind: "send_message", message };
}

function normalizeSystemReplySource(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  const unfenced = unwrapJsonCodeFence(normalized);
  if (unfenced) {
    return {
      text: unfenced.replace(/^json\s*:\s*/i, "").trim(),
      requiresStructuredAction: true,
    };
  }
  const strippedJsonPrefix = normalized.replace(/^json\s*:\s*/i, "").trim();
  return {
    text: strippedJsonPrefix,
    requiresStructuredAction: strippedJsonPrefix !== normalized,
  };
}

function resolvePlainTextSystemReply(replyText, policy) {
  const message = sanitizePlainTextSystemReply(replyText, policy);
  if (!message) {
    return { kind: "invalid", reason: "plain text system reply is unsafe" };
  }
  return { kind: "send_message", message };
}

function sanitizePlainTextSystemReply(replyText, policy) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (!normalized) {
    return "";
  }
  if (normalized.length > policy.maxPlainTextLength) {
    return "";
  }
  if (normalized.split("\n").length > policy.maxPlainTextLines) {
    return "";
  }
  if (containsPlainTextSystemHazard(normalized)) {
    return "";
  }
  return sanitizeReplyText(normalized);
}

function containsPlainTextSystemHazard(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized) {
    return true;
  }
  return /```/.test(normalized)
    || /^\s*[\[{]/.test(normalized)
    || /(?:^|\n)\s*(?:analysis|commentary|final)\s+to=/i.test(normalized)
    || /\b(?:tool_use|tool_result|function_call|mcp__|exec_command|apply_patch|read_mcp_resource)\b/i.test(normalized)
    || /(?:^|\n)\s*(?:\{|\[).*"(?:action|cyberboss_action|tool|toolName|tool_name)"\s*:/i.test(normalized);
}

function createSystemReplyPolicy(runtimeId) {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  /*
   * System/check-in turns are intentionally stricter than normal WeChat replies.
   * The stable protocol is one JSON action object: {"action":"silent"} or
   * {"action":"send_message","message":"..."}. JSON may be wrapped in a pure
   * ```json fence or prefixed with "json:" because those are presentation
   * wrappers around the same object, not alternate meanings.
   *
   * Codex must stay JSON-only: its streaming item protocol has historically been
   * able to expose tool/protocol fragments as assistant text, so plain system
   * text is not trusted. Claude Code is different in this bridge: tool use,
   * thinking, and assistant text are non-deliverable events, and WeChat receives
   * only the final result event. For claudecode only, a short natural final text
   * with no code fence, JSON/action fragment, tool marker, or protocol marker is
   * treated as send_message so random check-ins do not disappear when the model
   * forgets the JSON wrapper.
   */
  return {
    runtimeId: normalizedRuntimeId,
    allowPlainTextSendMessage: normalizedRuntimeId === "claudecode",
    maxPlainTextLength: 280,
    maxPlainTextLines: 3,
  };
}

function classifyReplyItemSourceText(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return null;
  }
  const unfenced = unwrapJsonCodeFence(normalized) || normalized;
  const stripped = unfenced.replace(/^json\s*:\s*/i, "").trim();
  const candidate = extractSystemActionJsonCandidate(stripped) || (stripped.startsWith("{") ? stripped : "");
  if (!candidate) {
    return null;
  }
  if (candidate !== stripped) {
    return null;
  }
  return resolveSystemReplyAction(candidate);
}

function unwrapJsonCodeFence(text) {
  const match = String(text || "").trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? String(match[1] || "").trim() : "";
}

function buildActionDelivery(itemId, sourceText, action, messageKind = "") {
  if (!action || typeof action !== "object") {
    return null;
  }
  if (action.kind === "silent") {
    return { itemId, kind: "silent", sourceText, messageKind };
  }
  if (action.kind === "send_message") {
    return { itemId, kind: "action", sourceText, message: action.message, messageKind };
  }
  return {
    itemId,
    kind: "invalid_action",
    sourceText,
    reason: action.reason || "invalid structured action",
    messageKind,
  };
}

function buildDeliveryPreviewText(delivery) {
  if (!delivery || typeof delivery !== "object") {
    return "";
  }
  if (delivery.kind === "action") {
    return delivery.message || "";
  }
  if (delivery.kind === "plain") {
    return delivery.text || "";
  }
  return "";
}

function normalizeSystemActionName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

// Tools that are quick read-only inspection rather than work worth narrating.
// Announcing every `read` turned one question into four chat messages.
const QUIET_TOOL_TYPES = new Set(["read", "grep", "glob", "list", "ls", "cat", "search_files", "view"]);

/**
 * Build the 【进度】 line for a tool call, or "" when it should not be announced.
 *
 * Deliberately plain: the text is sanitized and markdown-stripped downstream, and
 * a command that reads like a structured action payload would be routed to the
 * action formatter instead of a progress message.
 */
function buildToolProgressText(payload) {
  const toolType = normalizeText(payload?.toolType);
  if (!toolType || QUIET_TOOL_TYPES.has(toolType.toLowerCase())) {
    return "";
  }
  const command = normalizeText(payload?.command).replace(/\s+/gu, " ").slice(0, TOOL_PROGRESS_COMMAND_MAX);
  // Tool events often describe the call with the tool's own name, which produced
  // status lines like "read（read）". Say it once.
  const redundant = !command || command.toLowerCase() === toolType.toLowerCase();
  return redundant ? `正在执行 ${toolType}` : `正在执行 ${toolType}（${command}）`;
}

function normalizeMessagePhase(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === "commentary" || normalized === "final_answer"
    ? normalized
    : "";
}

function normalizeRuntimeId(value) {
  return String(value || "").trim().toLowerCase();
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractSystemActionJsonCandidate(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized || !normalized.endsWith("}")) {
    return "";
  }
  if (normalized.startsWith("{")) {
    return normalized;
  }
  for (let index = normalized.lastIndexOf("{"); index >= 0; index = normalized.lastIndexOf("{", index - 1)) {
    const candidate = normalized.slice(index).trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    const parsed = tryParseJson(candidate);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      continue;
    }
    if ("action" in parsed || "cyberboss_action" in parsed) {
      return candidate;
    }
  }
  return "";
}

function isSystemReplyContextFailure(error) {
  const message = String(error?.message || "");
  const ret = normalizeNumericErrorCode(error?.ret);
  const errcode = normalizeNumericErrorCode(error?.errcode);
  return ret === -2
    || errcode === -2
    || message.includes("sendMessage ret=-2")
    || message.includes("errcode=-2");
}

function normalizeNumericErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

module.exports = { StreamDelivery };
