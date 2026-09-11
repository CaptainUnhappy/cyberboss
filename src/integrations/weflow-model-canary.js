const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MODEL_CANARY_VERSION = 1;
const MODEL_CANARY_DIRECTORY = "model-e2e-probes";
const MODEL_CANARY_QUARANTINE_DIRECTORY = "model-e2e-probe-quarantine";
const MODEL_CANARY_DELIVERY_POLICY = "weflow_model_canary";
const MODEL_CANARY_EXECUTION_POLICY = "model_canary_deny_side_effects";
const MODEL_CANARY_MIN_DESKTOP_IDLE_SECONDS = 300;
const MODEL_CANARY_PROMPT = [
  "[Cyberboss internal model health probe]",
  "Return one short, non-empty final answer.",
  "Do not call tools and do not include analysis or commentary.",
].join("\n");
const DEFAULT_MODEL_CANARY_TTL_MS = 5 * 60_000;
const MAX_MODEL_CANARY_TTL_MS = 10 * 60_000;
const MAX_CLOCK_SKEW_MS = 10_000;
const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NONCE_PATTERN = /^[a-f0-9]{24}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const LEASE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MODEL_CANARY_DESKTOP_INPUT_LEASE_RECEIPT = "desktop-input-lease.json";
const DEFAULT_LEASE_RECEIPT_WAIT_MS = 5_000;
const LEASE_RECEIPT_POLL_MS = 50;
const TRIGGER_PATTERN = /^\[Cyberboss心跳模型探针 trigger=([a-f0-9-]+) nonce=([a-f0-9]+)\]$/;
const REPLY_PATTERN = /^\[Cyberboss心跳模型正常 trigger=([a-f0-9-]+)\]$/;

class WeFlowModelCanary {
  constructor({
    config,
    onTrigger,
    now = () => Date.now(),
    logger = console,
    leaseReceiptWaitMs = DEFAULT_LEASE_RECEIPT_WAIT_MS,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    this.config = config || {};
    this.onTrigger = typeof onTrigger === "function" ? onTrigger : null;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.logger = logger || console;
    this.leaseReceiptWaitMs = Math.max(0, Number(leaseReceiptWaitMs) || 0);
    this.sleep = typeof sleep === "function" ? sleep : () => Promise.resolve();
    this.rootDir = path.resolve(this.config.stateDir || ".", MODEL_CANARY_DIRECTORY);
    this.quarantineDir = path.resolve(
      this.config.stateDir || ".",
      MODEL_CANARY_QUARANTINE_DIRECTORY,
    );
  }

  isEnabled() {
    return this.config.weflowModelCanaryEnabled === true;
  }

  async handleObservedMessage({ message, classification, talker } = {}) {
    const candidate = parseModelCanaryText(message?.text);
    if (!candidate) {
      return { handled: false };
    }
    if (!this.isEnabled()) {
      return {
        handled: true,
        accepted: true,
        status: "disabled",
        reason: "feature_disabled",
      };
    }

    const normalizedTalker = normalizeText(talker);
    const validation = this.validateCandidate(candidate, normalizedTalker);
    if (!validation.ok) {
      this.recordQuarantine({ candidate, message, classification, reason: validation.reason });
      return { handled: true, accepted: true, status: "quarantined", reason: validation.reason };
    }
    if (candidate.type === "trigger") {
      return this.handleTrigger({
        candidate,
        manifest: validation.manifest,
        runDir: validation.runDir,
        message,
        classification,
        talker: normalizedTalker,
      });
    }
    return this.handleReplyEcho({
      candidate,
      manifest: validation.manifest,
      runDir: validation.runDir,
      message,
      classification,
      talker: normalizedTalker,
    });
  }

  validateCandidate(candidate, talker) {
    if (!RUN_ID_PATTERN.test(candidate.runId)
      || (candidate.type === "trigger" && !NONCE_PATTERN.test(candidate.nonce))) {
      return { ok: false, reason: "marker_invalid" };
    }
    const runDir = resolveRunDirectory(this.rootDir, candidate.runId);
    if (!runDir) {
      return { ok: false, reason: "run_id_invalid" };
    }
    const manifest = readJsonIfPresent(path.join(runDir, "manifest.json"));
    if (!manifest) {
      return { ok: false, reason: "manifest_missing" };
    }
    const checked = validateModelCanaryManifest(manifest, {
      candidate,
      talker,
      expectedTalker: normalizeText(this.config.weflowCanaryChat),
      expectedContact: normalizeText(this.config.weflowCanaryDisplayName),
      nowMs: normalizeNowMs(this.now()),
    });
    return checked.ok ? { ok: true, manifest: checked.manifest, runDir } : checked;
  }

  async handleTrigger({ candidate, manifest, runDir, message, classification, talker }) {
    if (normalizeText(message?.direction).toLowerCase() !== "outgoing") {
      return this.quarantineResult({
        candidate,
        message,
        classification,
        reason: "trigger_direction_invalid",
      });
    }
    if (normalizeText(classification?.origin).toLowerCase() !== "self_manual") {
      return this.quarantineResult({
        candidate,
        message,
        classification,
        reason: "trigger_origin_invalid",
      });
    }

    const desktopInputLease = await this.waitForDesktopInputLeaseReceipt(runDir, manifest);
    if (!desktopInputLease.ok) {
      if (desktopInputLease.reason === "receipt_missing") {
        // The trigger can be observed before the bridge's send response reaches
        // the runner. Keep the dedicated cursor on this row and retry after the
        // runner has durably recorded (or recovered) the lease; never turn a
        // bounded response-ordering race into a write-once terminal failure.
        return {
          handled: true,
          accepted: false,
          status: "waiting_for_desktop_input_lease",
          reason: desktopInputLease.reason,
        };
      }
      const failure = this.recordHandoffFailure(
        runDir,
        manifest,
        `desktop_input_lease_${desktopInputLease.reason || "missing"}`,
      );
      return {
        handled: true,
        accepted: true,
        status: "handoff_failed",
        failure,
      };
    }

    const recordedAt = new Date(normalizeNowMs(this.now())).toISOString();
    const ingested = writeJsonAtomicOnce(path.join(runDir, "ingested.json"), {
      version: MODEL_CANARY_VERSION,
      mode: "model_e2e",
      runId: manifest.runId,
      nonce: manifest.nonce,
      obligationFingerprint: manifest.obligationFingerprint,
      status: "ingested",
      talker,
      direction: "outgoing",
      triggerLocalId: normalizeLocalId(message?.localId),
      triggerMessageId: normalizeText(message?.id),
      triggerObservedAt: normalizeObservedAt(message, recordedAt),
      ingestedAt: recordedAt,
    });

    const existingHandoff = readJsonIfPresent(path.join(runDir, "handoff.json"));
    if (existingHandoff) {
      return {
        handled: true,
        accepted: true,
        status: "handoff_already_recorded",
        ingested,
        handoff: existingHandoff,
      };
    }
    const existingFailure = readJsonIfPresent(path.join(runDir, "handoff-failed.json"));
    if (existingFailure) {
      return {
        handled: true,
        accepted: true,
        status: "handoff_failed",
        ingested,
        failure: existingFailure,
      };
    }
    const existingEnqueued = readJsonIfPresent(path.join(runDir, "handoff-enqueued.json"));
    if (existingEnqueued) {
      return {
        handled: true,
        accepted: true,
        status: "handoff_queued",
        ingested,
        handoff: existingEnqueued,
      };
    }

    const claim = acquireClaimDirectory(path.join(runDir, "handoff-claim"), {
      version: MODEL_CANARY_VERSION,
      mode: "model_e2e",
      runId: manifest.runId,
      nonce: manifest.nonce,
      obligationFingerprint: manifest.obligationFingerprint,
      triggerLocalId: normalizeLocalId(message?.localId),
      triggerMessageId: normalizeText(message?.id),
      claimedAt: recordedAt,
    });
    if (!claim.acquired) {
      return {
        handled: true,
        accepted: true,
        status: "handoff_unknown",
        reason: "durable_handoff_claim_already_exists",
        ingested,
      };
    }

    if (!this.onTrigger) {
      const failure = this.recordHandoffFailure(runDir, manifest, "trigger_handler_missing");
      return { handled: true, accepted: true, status: "handoff_failed", ingested, failure };
    }

    try {
      const dispatch = await this.onTrigger({
        manifest,
        runDir,
        prepared: buildModelCanaryPreparedMessage({
          manifest,
          desktopInputLeaseReceipt: desktopInputLease.receipt,
          replyUserId: normalizeText(this.config.weflowInboxReplyUserId),
          receivedAt: normalizeObservedAt(message, recordedAt),
          nowMs: normalizeNowMs(this.now()),
        }),
      });
      if (dispatch === false || dispatch?.accepted === false) {
        const failure = this.recordHandoffFailure(runDir, manifest, "runtime_handoff_rejected");
        return { handled: true, accepted: true, status: "handoff_failed", ingested, failure };
      }
      const threadId = normalizeText(dispatch?.threadId);
      const turnId = normalizeText(dispatch?.turnId);
      const handoffFile = threadId && turnId ? "handoff.json" : "handoff-enqueued.json";
      const handoff = writeJsonAtomicOnce(path.join(runDir, handoffFile), {
        version: MODEL_CANARY_VERSION,
        mode: "model_e2e",
        runId: manifest.runId,
        nonce: manifest.nonce,
        obligationFingerprint: manifest.obligationFingerprint,
        status: threadId && turnId ? "accepted" : "queued",
        bindingKey: normalizeText(dispatch?.bindingKey),
        workspaceRoot: normalizeText(dispatch?.workspaceRoot),
        threadId,
        turnId,
        acceptedAt: new Date(normalizeNowMs(this.now())).toISOString(),
      });
      return {
        handled: true,
        accepted: true,
        status: threadId && turnId ? "handoff_accepted" : "handoff_queued",
        ingested,
        handoff,
      };
    } catch (error) {
      const failure = this.recordHandoffFailure(runDir, manifest, formatError(error));
      return { handled: true, accepted: true, status: "handoff_failed", ingested, failure };
    }
  }

  async waitForDesktopInputLeaseReceipt(runDir, manifest) {
    const receiptPath = path.join(runDir, MODEL_CANARY_DESKTOP_INPUT_LEASE_RECEIPT);
    const deadline = Date.now() + this.leaseReceiptWaitMs;
    while (true) {
      const raw = readJsonIfPresent(receiptPath);
      if (raw) {
        return validateModelCanaryDesktopInputLeaseReceipt(raw, manifest, {
          nowMs: normalizeNowMs(this.now()),
        });
      }
      if (fs.existsSync(receiptPath)) {
        return { ok: false, reason: "receipt_invalid" };
      }
      if (Date.now() >= deadline) {
        return { ok: false, reason: "receipt_missing" };
      }
      await this.sleep(Math.min(LEASE_RECEIPT_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  handleReplyEcho({ candidate, manifest, runDir, message, classification, talker }) {
    const expectedKind = buildModelCanaryMessageKind(manifest.runId);
    const expectedIdempotencyKey = buildModelCanaryIdempotencyKey(manifest.runId);
    const entry = classification?.entry || {};
    const messageLocalId = normalizeLocalId(message?.localId);
    const ledgerLocalId = normalizeLocalId(entry.localId);
    if (normalizeText(message?.direction).toLowerCase() !== "outgoing"
      || normalizeText(classification?.origin).toLowerCase() !== "cyberboss"
      || normalizeText(entry.messageKind) !== expectedKind
      || normalizeText(entry.idempotencyKey) !== expectedIdempotencyKey
      || normalizeText(message?.text) !== manifest.replyText
      || !messageLocalId
      || !ledgerLocalId
      || ledgerLocalId !== messageLocalId) {
      return this.quarantineResult({
        candidate,
        message,
        classification,
        reason: "reply_authentication_failed",
      });
    }

    // The outbound echo can be polled before StreamDelivery records its
    // reply_dispatched event.  In that ordering, the echo reconciler is the
    // first writer of reply-dispatched.json.  The accepted runtime handoff and
    // the pre-send claim are the durable authorities for thread/turn identity;
    // never manufacture an unbound receipt from the echo alone.
    const handoff = readJsonIfPresent(path.join(runDir, "handoff.json"));
    const replyClaim = readJsonIfPresent(path.join(runDir, "reply-send-claim", "claim.json"));
    const runtimeBinding = validateReplyEchoRuntimeBinding({
      manifest,
      handoff,
      replyClaim,
      expectedKind,
      expectedIdempotencyKey,
    });
    if (!runtimeBinding.ok) {
      return this.quarantineResult({
        candidate,
        message,
        classification,
        reason: runtimeBinding.reason,
      });
    }

    const recordedAt = new Date(normalizeNowMs(this.now())).toISOString();
    const replyDispatchPath = path.join(runDir, "reply-dispatched.json");
    let dispatched = readJsonIfPresent(replyDispatchPath);
    if (!dispatched && fs.existsSync(replyDispatchPath)) {
      return this.quarantineResult({
        candidate,
        message,
        classification,
        reason: "reply_dispatch_receipt_invalid",
      });
    }
    if (!dispatched) {
      writeJsonAtomicOnce(replyDispatchPath, {
        version: MODEL_CANARY_VERSION,
        mode: "model_e2e",
        runId: manifest.runId,
        nonce: manifest.nonce,
        obligationFingerprint: manifest.obligationFingerprint,
        status: "reconciled_from_echo",
        threadId: runtimeBinding.threadId,
        turnId: runtimeBinding.turnId,
        talker,
        contact: manifest.contact,
        replyLocalId: messageLocalId,
        messageKind: expectedKind,
        idempotencyKey: expectedIdempotencyKey,
        recordedAt,
      });
      dispatched = readJsonIfPresent(replyDispatchPath);
    }
    const checkedDispatch = validateReplyEchoDispatchReceipt(dispatched, {
      manifest,
      threadId: runtimeBinding.threadId,
      turnId: runtimeBinding.turnId,
      replyLocalId: messageLocalId,
      expectedKind,
      expectedIdempotencyKey,
    });
    if (!checkedDispatch.ok) {
      return this.quarantineResult({
        candidate,
        message,
        classification,
        reason: checkedDispatch.reason,
      });
    }

    const replyObservedPath = path.join(runDir, "reply-observed.json");
    let observed = readJsonIfPresent(replyObservedPath);
    if (!observed && fs.existsSync(replyObservedPath)) {
      return this.quarantineResult({
        candidate,
        message,
        classification,
        reason: "reply_observed_receipt_invalid",
      });
    }
    if (!observed) writeJsonAtomicOnce(replyObservedPath, {
      version: MODEL_CANARY_VERSION,
      mode: "model_e2e",
      runId: manifest.runId,
      nonce: manifest.nonce,
      obligationFingerprint: manifest.obligationFingerprint,
      status: "observed",
      threadId: runtimeBinding.threadId,
      turnId: runtimeBinding.turnId,
      talker,
      direction: "outgoing",
      replyLocalId: messageLocalId,
      replyMessageId: normalizeText(message?.id),
      replyObservedAt: normalizeObservedAt(message, recordedAt),
      messageKind: expectedKind,
      idempotencyKey: expectedIdempotencyKey,
      matchedBy: normalizeText(classification?.matchedBy),
      recordedAt,
    });
    observed = readJsonIfPresent(replyObservedPath);
    const checkedObserved = validateReplyEchoObservedReceipt(observed, {
      manifest,
      threadId: runtimeBinding.threadId,
      turnId: runtimeBinding.turnId,
      replyLocalId: messageLocalId,
      expectedKind,
      expectedIdempotencyKey,
    });
    if (!checkedObserved.ok) {
      return this.quarantineResult({
        candidate,
        message,
        classification,
        reason: checkedObserved.reason,
      });
    }
    return { handled: true, accepted: true, status: "reply_observed", observed };
  }

  async handleDeliveryEvent(event = {}) {
    const target = event.target || {};
    const runId = normalizeText(target.modelCanaryRunId).toLowerCase();
    const runDir = resolveRunDirectory(this.rootDir, runId);
    if (!runDir) {
      return { accepted: false, reason: "run_id_invalid" };
    }
    const manifest = readJsonIfPresent(path.join(runDir, "manifest.json"));
    const validation = validateModelCanaryDeliveryTarget(manifest, target, {
      nowMs: normalizeNowMs(this.now()),
      expectedTalker: normalizeText(this.config.weflowCanaryChat),
      expectedContact: normalizeText(this.config.weflowCanaryDisplayName),
    });
    if (!validation.ok) {
      return { accepted: false, reason: validation.reason };
    }
    if (!fs.existsSync(path.join(runDir, "handoff-claim"))) {
      return { accepted: false, reason: "handoff_claim_missing" };
    }
    const base = {
      version: MODEL_CANARY_VERSION,
      mode: "model_e2e",
      runId: manifest.runId,
      nonce: manifest.nonce,
      obligationFingerprint: manifest.obligationFingerprint,
      threadId: normalizeText(event.threadId),
      turnId: normalizeText(event.turnId),
      recordedAt: new Date(normalizeNowMs(this.now())).toISOString(),
    };

    if (normalizeText(event.type) === "runtime_handoff_accepted") {
      if (!base.threadId || !base.turnId) {
        return { accepted: false, reason: "runtime_handoff_identity_missing" };
      }
      const receipt = writeJsonAtomicOnce(path.join(runDir, "handoff.json"), {
        ...base,
        status: "accepted",
        bindingKey: normalizeText(event.bindingKey),
        workspaceRoot: normalizeText(event.workspaceRoot),
        acceptedAt: base.recordedAt,
      });
      return { accepted: true, receipt };
    }
    const handoff = readJsonIfPresent(path.join(runDir, "handoff.json"));
    if (!handoff) {
      return { accepted: false, reason: "runtime_handoff_receipt_missing" };
    }

    const eventType = normalizeText(event.type);
    if (["model_completed", "reply_dispatched", "turn_released"].includes(eventType)) {
      const handoffThreadId = normalizeText(handoff.threadId);
      const handoffTurnId = normalizeText(handoff.turnId);
      if (!base.threadId || !base.turnId || !handoffThreadId || !handoffTurnId) {
        return { accepted: false, reason: "runtime_event_identity_missing" };
      }
      if (base.threadId !== handoffThreadId || base.turnId !== handoffTurnId) {
        return { accepted: false, reason: "runtime_event_identity_mismatch" };
      }
    }

    switch (eventType) {
      case "model_completed": {
        const assistantFinalSha256 = normalizeText(event.assistantFinalSha256).toLowerCase();
        const assistantFinalLength = Number(event.assistantFinalLength);
        const assistantFinalBytes = Number(event.assistantFinalBytes);
        if (!FINGERPRINT_PATTERN.test(assistantFinalSha256)
          || !Number.isSafeInteger(assistantFinalLength) || assistantFinalLength <= 0
          || !Number.isSafeInteger(assistantFinalBytes) || assistantFinalBytes <= 0) {
          return { accepted: false, reason: "assistant_final_proof_invalid" };
        }
        const receipt = writeJsonAtomicOnce(path.join(runDir, "model-completed.json"), {
          ...base,
          status: "completed",
          assistantFinalPresent: true,
          assistantFinalSha256,
          assistantFinalLength,
          assistantFinalBytes,
        });
        return { accepted: true, receipt };
      }
      case "claim_reply_dispatch": {
        if (readJsonIfPresent(path.join(runDir, "approval-denied.json"))
          || readJsonIfPresent(path.join(runDir, "tool-attempted.json"))) {
          return {
            accepted: true,
            claimed: false,
            reason: "model_side_effect_attempted",
          };
        }
        const claim = acquireClaimDirectory(path.join(runDir, "reply-send-claim"), {
          ...base,
          status: "claimed",
          messageKind: manifest.replyMessageKind,
          idempotencyKey: manifest.replyIdempotencyKey,
        });
        return {
          accepted: true,
          claimed: claim.acquired,
          reason: claim.acquired ? "claimed" : "reply_dispatch_already_claimed",
        };
      }
      case "reply_dispatched": {
        if (!fs.existsSync(path.join(runDir, "reply-send-claim"))) {
          return { accepted: false, reason: "reply_dispatch_claim_missing" };
        }
        const sendResult = event.sendResult || {};
        const receipt = writeJsonAtomicOnce(path.join(runDir, "reply-dispatched.json"), {
          ...base,
          status: sendResult.verified === true ? "verified" : "dispatched",
          talker: manifest.talker,
          contact: manifest.contact,
          replyLocalId: normalizeLocalId(sendResult.localId),
          messageKind: manifest.replyMessageKind,
          idempotencyKey: manifest.replyIdempotencyKey,
          verified: sendResult.verified === true,
          deduplicated: sendResult.deduplicated === true,
        });
        return { accepted: true, receipt };
      }
      case "reply_delivery_failed": {
        const receipt = writeJsonAtomicOnce(path.join(runDir, "reply-delivery-failed.json"), {
          ...base,
          status: "failed",
          deliveryUncertain: event.error?.deliveryUncertain !== false,
          code: normalizeText(event.error?.code),
          error: formatError(event.error).slice(0, 500),
        });
        return { accepted: true, receipt };
      }
      case "turn_completed_without_final": {
        const receipt = writeJsonAtomicOnce(path.join(runDir, "turn-completed-without-final.json"), {
          ...base,
          status: "failed",
          reason: "assistant_final_missing",
        });
        return { accepted: true, receipt };
      }
      case "turn_failed": {
        const receipt = writeJsonAtomicOnce(path.join(runDir, "turn-failed.json"), {
          ...base,
          status: "failed",
          reason: "runtime_turn_failed",
        });
        return { accepted: true, receipt };
      }
      case "approval_denied": {
        const receipt = writeJsonAtomicOnce(path.join(runDir, "approval-denied.json"), {
          ...base,
          status: "failed",
          reason: "model_requested_approval",
          requestId: normalizeText(event.requestId),
        });
        return { accepted: true, receipt };
      }
      case "tool_attempted": {
        const receipt = writeJsonAtomicOnce(path.join(runDir, "tool-attempted.json"), {
          ...base,
          status: "failed",
          reason: "model_attempted_tool_use",
          itemId: normalizeText(event.itemId),
          toolType: normalizeText(event.toolType),
        });
        return { accepted: true, receipt };
      }
      case "turn_released": {
        const receipt = writeJsonAtomicOnce(path.join(runDir, "turn-released.json"), {
          ...base,
          status: "released",
        });
        return { accepted: true, receipt };
      }
      case "turn_release_failed": {
        const receipt = writeJsonAtomicOnce(path.join(runDir, "turn-release-failed.json"), {
          ...base,
          status: "failed",
          reason: "turn_gate_release_not_verified",
          expectedScopeKey: normalizeText(event.expectedScopeKey),
          releasedScopeKey: normalizeText(event.releasedScopeKey),
        });
        return { accepted: true, receipt };
      }
      default:
        return { accepted: false, reason: "event_type_invalid" };
    }
  }

  recordHandoffFailure(runDir, manifest, reason) {
    return writeJsonAtomicOnce(path.join(runDir, "handoff-failed.json"), {
      version: MODEL_CANARY_VERSION,
      mode: "model_e2e",
      runId: manifest.runId,
      nonce: manifest.nonce,
      obligationFingerprint: manifest.obligationFingerprint,
      status: "failed",
      reason: normalizeText(reason).slice(0, 500) || "runtime_handoff_failed",
      recordedAt: new Date(normalizeNowMs(this.now())).toISOString(),
    });
  }

  quarantineResult({ candidate, message, classification, reason }) {
    this.recordQuarantine({ candidate, message, classification, reason });
    return { handled: true, accepted: true, status: "quarantined", reason };
  }

  recordQuarantine({ candidate, message, classification, reason }) {
    try {
      fs.mkdirSync(this.quarantineDir, { recursive: true });
      const identity = crypto.createHash("sha256")
        .update([
          candidate?.type,
          candidate?.runId,
          message?.localId,
          message?.id,
          message?.text,
          reason,
        ].map((value) => String(value ?? "")).join("\n"), "utf8")
        .digest("hex");
      writeJsonAtomicOnce(path.join(this.quarantineDir, `${identity}.json`), {
        version: MODEL_CANARY_VERSION,
        mode: "model_e2e",
        status: "quarantined",
        reason: normalizeText(reason) || "unknown",
        markerType: normalizeText(candidate?.type),
        runId: normalizeText(candidate?.runId),
        localId: normalizeLocalId(message?.localId),
        messageId: normalizeText(message?.id),
        direction: normalizeText(message?.direction),
        classification: normalizeText(classification?.origin),
        recordedAt: new Date(normalizeNowMs(this.now())).toISOString(),
      });
      this.logger.warn?.(
        `[cyberboss] reserved model canary marker quarantined runId=${candidate?.runId || "(invalid)"} reason=${reason}`,
      );
    } catch (error) {
      this.logger.warn?.(`[cyberboss] model canary quarantine record failed: ${formatError(error)}`);
    }
  }
}

function validateReplyEchoRuntimeBinding({
  manifest,
  handoff,
  replyClaim,
  expectedKind,
  expectedIdempotencyKey,
} = {}) {
  if (!isModelCanaryBoundReceipt(handoff, manifest)
    || normalizeText(handoff?.status) !== "accepted") {
    return { ok: false, reason: "reply_handoff_binding_invalid" };
  }
  const threadId = normalizeText(handoff.threadId);
  const turnId = normalizeText(handoff.turnId);
  if (!threadId || !turnId) {
    return { ok: false, reason: "reply_handoff_identity_missing" };
  }
  if (!isModelCanaryBoundReceipt(replyClaim, manifest)
    || normalizeText(replyClaim?.status) !== "claimed"
    || normalizeText(replyClaim?.threadId) !== threadId
    || normalizeText(replyClaim?.turnId) !== turnId
    || normalizeText(replyClaim?.messageKind) !== expectedKind
    || normalizeText(replyClaim?.idempotencyKey) !== expectedIdempotencyKey) {
    return { ok: false, reason: "reply_dispatch_claim_binding_invalid" };
  }
  return { ok: true, threadId, turnId };
}

function validateReplyEchoDispatchReceipt(receipt, {
  manifest,
  threadId,
  turnId,
  replyLocalId,
  expectedKind,
  expectedIdempotencyKey,
} = {}) {
  if (!isModelCanaryBoundReceipt(receipt, manifest)
    || !["verified", "dispatched", "reconciled_from_echo"].includes(normalizeText(receipt?.status))
    || normalizeText(receipt?.threadId) !== threadId
    || normalizeText(receipt?.turnId) !== turnId
    || normalizeText(receipt?.talker) !== manifest?.talker
    || normalizeText(receipt?.contact) !== manifest?.contact
    || normalizeLocalId(receipt?.replyLocalId) !== replyLocalId
    || normalizeText(receipt?.messageKind) !== expectedKind
    || normalizeText(receipt?.idempotencyKey) !== expectedIdempotencyKey) {
    return { ok: false, reason: "reply_dispatch_receipt_binding_invalid" };
  }
  return { ok: true };
}

function validateReplyEchoObservedReceipt(receipt, {
  manifest,
  threadId,
  turnId,
  replyLocalId,
  expectedKind,
  expectedIdempotencyKey,
} = {}) {
  if (!isModelCanaryBoundReceipt(receipt, manifest)
    || normalizeText(receipt?.status) !== "observed"
    || normalizeText(receipt?.threadId) !== threadId
    || normalizeText(receipt?.turnId) !== turnId
    || normalizeText(receipt?.talker) !== manifest?.talker
    || normalizeText(receipt?.direction).toLowerCase() !== "outgoing"
    || normalizeLocalId(receipt?.replyLocalId) !== replyLocalId
    || normalizeText(receipt?.messageKind) !== expectedKind
    || normalizeText(receipt?.idempotencyKey) !== expectedIdempotencyKey) {
    return { ok: false, reason: "reply_observed_receipt_binding_invalid" };
  }
  return { ok: true };
}

function isModelCanaryBoundReceipt(receipt, manifest) {
  return receipt?.version === MODEL_CANARY_VERSION
    && normalizeText(receipt?.mode) === "model_e2e"
    && normalizeText(receipt?.runId).toLowerCase() === normalizeText(manifest?.runId).toLowerCase()
    && normalizeText(receipt?.nonce).toLowerCase() === normalizeText(manifest?.nonce).toLowerCase()
    && normalizeText(receipt?.obligationFingerprint).toLowerCase()
      === normalizeText(manifest?.obligationFingerprint).toLowerCase();
}

function createModelCanaryManifest({
  stateDir,
  talker,
  contact,
  demandKey,
  runId = crypto.randomUUID(),
  nonce = crypto.randomBytes(12).toString("hex"),
  nowMs = Date.now(),
  ttlMs = DEFAULT_MODEL_CANARY_TTL_MS,
} = {}) {
  const normalizedStateDir = normalizeText(stateDir);
  const normalizedTalker = normalizeText(talker);
  const normalizedContact = normalizeText(contact);
  const normalizedDemandKey = normalizeText(demandKey);
  const normalizedRunId = normalizeText(runId).toLowerCase();
  const normalizedNonce = normalizeText(nonce).toLowerCase();
  const normalizedNowMs = normalizeNowMs(nowMs);
  const normalizedTtlMs = Number(ttlMs);
  if (!normalizedStateDir || !normalizedTalker || !normalizedContact || !normalizedDemandKey
    || !RUN_ID_PATTERN.test(normalizedRunId) || !NONCE_PATTERN.test(normalizedNonce)
    || !Number.isFinite(normalizedTtlMs) || normalizedTtlMs <= 0
    || normalizedTtlMs > MAX_MODEL_CANARY_TTL_MS) {
    throw new Error("model canary manifest parameters are invalid");
  }

  const rootDir = path.resolve(normalizedStateDir, MODEL_CANARY_DIRECTORY);
  const runDir = resolveRunDirectory(rootDir, normalizedRunId);
  if (!runDir) {
    throw new Error("model canary run directory is invalid");
  }
  const triggerText = buildModelCanaryTriggerText(normalizedRunId, normalizedNonce);
  const replyText = buildModelCanaryReplyText(normalizedRunId);
  const manifest = {
    version: MODEL_CANARY_VERSION,
    mode: "model_e2e",
    runId: normalizedRunId,
    nonce: normalizedNonce,
    triggerText,
    replyText,
    replyMessageKind: buildModelCanaryMessageKind(normalizedRunId),
    replyIdempotencyKey: buildModelCanaryIdempotencyKey(normalizedRunId),
    promptHash: hashText(MODEL_CANARY_PROMPT),
    obligationFingerprint: hashText(normalizedDemandKey),
    talker: normalizedTalker,
    contact: normalizedContact,
    targetFingerprint: hashText(`${normalizedContact}\n${normalizedTalker}`),
    createdAt: new Date(normalizedNowMs).toISOString(),
    expiresAt: new Date(normalizedNowMs + normalizedTtlMs).toISOString(),
  };
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: false });
  writeJsonAtomicOnce(path.join(runDir, "manifest.json"), manifest);
  return { manifest, runDir };
}

function buildModelCanaryManifestFingerprint(manifest = {}) {
  return hashText([
    MODEL_CANARY_VERSION,
    "model_e2e",
    normalizeText(manifest.runId).toLowerCase(),
    normalizeText(manifest.nonce).toLowerCase(),
    normalizeText(manifest.triggerText),
    normalizeText(manifest.replyText),
    normalizeText(manifest.replyMessageKind),
    normalizeText(manifest.replyIdempotencyKey),
    normalizeText(manifest.promptHash).toLowerCase(),
    normalizeText(manifest.obligationFingerprint).toLowerCase(),
    normalizeText(manifest.talker),
    normalizeText(manifest.contact),
    normalizeText(manifest.targetFingerprint).toLowerCase(),
    normalizeIsoTime(manifest.createdAt),
    normalizeIsoTime(manifest.expiresAt),
  ].join("\n"));
}

function createModelCanaryDesktopInputLeaseReceipt(manifest, rawLease, { nowMs = Date.now() } = {}) {
  const checkedManifest = validateModelCanaryManifest(manifest, {
    nowMs: Math.min(normalizeNowMs(nowMs), Date.parse(manifest?.expiresAt) || normalizeNowMs(nowMs)),
  });
  if (!checkedManifest.ok || !rawLease || typeof rawLease !== "object" || Array.isArray(rawLease)) {
    throw new Error("model canary desktop input lease response is invalid");
  }
  const normalizedManifest = checkedManifest.manifest;
  const receipt = {
    version: MODEL_CANARY_VERSION,
    mode: "model_e2e",
    runId: normalizeText(rawLease.runId).toLowerCase(),
    nonce: normalizeText(rawLease.nonce).toLowerCase(),
    obligationFingerprint: normalizedManifest.obligationFingerprint,
    targetFingerprint: normalizeText(rawLease.targetFingerprint).toLowerCase(),
    talker: normalizedManifest.talker,
    contact: normalizedManifest.contact,
    replyIdempotencyKey: normalizeText(rawLease.replyIdempotencyKey),
    manifestFingerprint: buildModelCanaryManifestFingerprint(normalizedManifest),
    leaseToken: normalizeText(rawLease.token).toLowerCase(),
    triggerLastInputTick: Number(rawLease.lastInputTick),
    issuedAt: normalizeIsoTime(rawLease.issuedAt),
    expiresAt: normalizeIsoTime(rawLease.expiresAt),
    recordedAt: new Date(normalizeNowMs(nowMs)).toISOString(),
  };
  const validation = validateModelCanaryDesktopInputLeaseReceipt(receipt, normalizedManifest, { nowMs });
  if (!validation.ok) {
    throw new Error(`model canary desktop input lease response failed binding: ${validation.reason}`);
  }
  return validation.receipt;
}

function validateModelCanaryDesktopInputLeaseReceipt(raw, manifest, { nowMs = Date.now() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "receipt_invalid" };
  }
  const normalizedNowMs = normalizeNowMs(nowMs);
  const checkedManifest = validateModelCanaryManifest(manifest, {
    nowMs: Math.min(normalizedNowMs, Date.parse(manifest?.expiresAt) || normalizedNowMs),
  });
  if (!checkedManifest.ok) return { ok: false, reason: "manifest_invalid" };
  const normalizedManifest = checkedManifest.manifest;
  const receipt = {
    version: Number(raw.version),
    mode: normalizeText(raw.mode),
    runId: normalizeText(raw.runId).toLowerCase(),
    nonce: normalizeText(raw.nonce).toLowerCase(),
    obligationFingerprint: normalizeText(raw.obligationFingerprint).toLowerCase(),
    targetFingerprint: normalizeText(raw.targetFingerprint).toLowerCase(),
    talker: normalizeText(raw.talker),
    contact: normalizeText(raw.contact),
    replyIdempotencyKey: normalizeText(raw.replyIdempotencyKey),
    manifestFingerprint: normalizeText(raw.manifestFingerprint).toLowerCase(),
    leaseToken: normalizeText(raw.leaseToken).toLowerCase(),
    triggerLastInputTick: Number(raw.triggerLastInputTick),
    issuedAt: normalizeIsoTime(raw.issuedAt),
    expiresAt: normalizeIsoTime(raw.expiresAt),
    recordedAt: normalizeIsoTime(raw.recordedAt),
  };
  const issuedAtMs = Date.parse(receipt.issuedAt);
  const recordedAtMs = Date.parse(receipt.recordedAt);
  const expiresAtMs = Date.parse(receipt.expiresAt);
  if (receipt.version !== MODEL_CANARY_VERSION
    || receipt.mode !== "model_e2e"
    || receipt.runId !== normalizedManifest.runId
    || receipt.nonce !== normalizedManifest.nonce
    || receipt.obligationFingerprint !== normalizedManifest.obligationFingerprint
    || receipt.targetFingerprint !== normalizedManifest.targetFingerprint
    || receipt.talker !== normalizedManifest.talker
    || receipt.contact !== normalizedManifest.contact
    || receipt.replyIdempotencyKey !== normalizedManifest.replyIdempotencyKey
    || receipt.manifestFingerprint !== buildModelCanaryManifestFingerprint(normalizedManifest)
    || !LEASE_TOKEN_PATTERN.test(receipt.leaseToken)
    || !Number.isSafeInteger(receipt.triggerLastInputTick)
    || receipt.triggerLastInputTick < 0
    || receipt.triggerLastInputTick > 0xFFFFFFFF
    || !Number.isFinite(issuedAtMs)
    || !Number.isFinite(recordedAtMs)
    || !Number.isFinite(expiresAtMs)
    || receipt.expiresAt !== normalizedManifest.expiresAt
    || issuedAtMs < Date.parse(normalizedManifest.createdAt) - MAX_CLOCK_SKEW_MS
    || issuedAtMs > recordedAtMs + MAX_CLOCK_SKEW_MS
    || recordedAtMs > normalizedNowMs + MAX_CLOCK_SKEW_MS
    || expiresAtMs <= normalizedNowMs) {
    return { ok: false, reason: "receipt_binding_invalid" };
  }
  return { ok: true, receipt };
}

function buildModelCanaryPreparedMessage({
  manifest,
  desktopInputLeaseReceipt,
  replyUserId,
  receivedAt = "",
  nowMs = Date.now(),
} = {}) {
  if (!manifest || !RUN_ID_PATTERN.test(normalizeText(manifest.runId))
    || !NONCE_PATTERN.test(normalizeText(manifest.nonce))
    || !normalizeText(replyUserId)) {
    throw new Error("model canary prepared message identity is invalid");
  }
  const checkedLease = validateModelCanaryDesktopInputLeaseReceipt(
    desktopInputLeaseReceipt,
    manifest,
    { nowMs },
  );
  if (!checkedLease.ok) {
    throw new Error(`model canary desktop input lease receipt is invalid: ${checkedLease.reason}`);
  }
  const lease = checkedLease.receipt;
  return {
    provider: "weflow-uia",
    accountId: "cyberboss-model-canary",
    workspaceId: "cyberboss-model-canary",
    senderId: `cyberboss-model-canary:${manifest.runId}`,
    chatId: `weflow-model-canary:${manifest.talker}`,
    messageId: `weflow-model-canary:${manifest.runId}:${manifest.nonce}`,
    contextToken: "",
    text: MODEL_CANARY_PROMPT,
    quotedContexts: [],
    attachments: [],
    persistedAttachments: [],
    persistedAttachmentFailures: [],
    sharedContent: false,
    explicitPrompt: true,
    receivedAt: normalizeIsoTime(receivedAt) || new Date().toISOString(),
    deliveryPolicy: MODEL_CANARY_DELIVERY_POLICY,
    suppressAcknowledgement: true,
    modelCanaryExecutionPolicy: MODEL_CANARY_EXECUTION_POLICY,
    modelCanaryRunId: manifest.runId,
    modelCanaryNonce: manifest.nonce,
    modelCanaryObligationFingerprint: manifest.obligationFingerprint,
    replyUserId: normalizeText(replyUserId),
    replyWeflowContact: manifest.contact,
    replyWeflowTalker: manifest.talker,
    replyWeflowExactContact: true,
    replyMessageKind: manifest.replyMessageKind,
    replyIdempotencyKey: manifest.replyIdempotencyKey,
    replyCanonicalText: manifest.replyText,
    replyDesktopInputLease: {
      version: MODEL_CANARY_VERSION,
      mode: "model_e2e",
      runId: manifest.runId,
      nonce: manifest.nonce,
      targetFingerprint: manifest.targetFingerprint,
      replyIdempotencyKey: manifest.replyIdempotencyKey,
      expiresAt: manifest.expiresAt,
      token: lease.leaseToken,
    },
  };
}

function validateModelCanaryManifest(raw, {
  candidate = null,
  talker = "",
  expectedTalker = "",
  expectedContact = "",
  nowMs = Date.now(),
} = {}) {
  if (!raw || typeof raw !== "object" || Number(raw.version) !== MODEL_CANARY_VERSION
    || normalizeText(raw.mode) !== "model_e2e") {
    return { ok: false, reason: "manifest_version_invalid" };
  }
  const manifest = {
    version: MODEL_CANARY_VERSION,
    mode: "model_e2e",
    runId: normalizeText(raw.runId).toLowerCase(),
    nonce: normalizeText(raw.nonce).toLowerCase(),
    triggerText: normalizeText(raw.triggerText),
    replyText: normalizeText(raw.replyText),
    replyMessageKind: normalizeText(raw.replyMessageKind),
    replyIdempotencyKey: normalizeText(raw.replyIdempotencyKey),
    promptHash: normalizeText(raw.promptHash).toLowerCase(),
    obligationFingerprint: normalizeText(raw.obligationFingerprint).toLowerCase(),
    createdAt: normalizeIsoTime(raw.createdAt),
    expiresAt: normalizeIsoTime(raw.expiresAt),
    talker: normalizeText(raw.talker),
    contact: normalizeText(raw.contact),
    targetFingerprint: normalizeText(raw.targetFingerprint).toLowerCase(),
  };
  if (!RUN_ID_PATTERN.test(manifest.runId)
    || !NONCE_PATTERN.test(manifest.nonce)
    || !FINGERPRINT_PATTERN.test(manifest.promptHash)
    || manifest.promptHash !== hashText(MODEL_CANARY_PROMPT)
    || !FINGERPRINT_PATTERN.test(manifest.obligationFingerprint)
    || !manifest.talker || !manifest.contact
    || !FINGERPRINT_PATTERN.test(manifest.targetFingerprint)
    || manifest.targetFingerprint !== hashText(`${manifest.contact}\n${manifest.talker}`)
    || (normalizeText(talker) && manifest.talker !== normalizeText(talker))
    || (normalizeText(expectedTalker) && manifest.talker !== normalizeText(expectedTalker))
    || (normalizeText(expectedContact) && manifest.contact !== normalizeText(expectedContact))) {
    return { ok: false, reason: "manifest_identity_mismatch" };
  }
  if (manifest.triggerText !== buildModelCanaryTriggerText(manifest.runId, manifest.nonce)
    || manifest.replyText !== buildModelCanaryReplyText(manifest.runId)
    || manifest.replyMessageKind !== buildModelCanaryMessageKind(manifest.runId)
    || manifest.replyIdempotencyKey !== buildModelCanaryIdempotencyKey(manifest.runId)) {
    return { ok: false, reason: "manifest_text_mismatch" };
  }
  if (candidate) {
    if (manifest.runId !== candidate.runId) {
      return { ok: false, reason: "manifest_identity_mismatch" };
    }
    if (candidate.type === "trigger"
      && (candidate.nonce !== manifest.nonce || candidate.text !== manifest.triggerText)) {
      return { ok: false, reason: "trigger_text_mismatch" };
    }
    if (candidate.type === "reply" && candidate.text !== manifest.replyText) {
      return { ok: false, reason: "reply_text_mismatch" };
    }
  }
  const createdAtMs = Date.parse(manifest.createdAt);
  const expiresAtMs = Date.parse(manifest.expiresAt);
  const normalizedNowMs = normalizeNowMs(nowMs);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= createdAtMs
    || expiresAtMs - createdAtMs > MAX_MODEL_CANARY_TTL_MS
    || createdAtMs > normalizedNowMs + MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "manifest_ttl_invalid" };
  }
  if (normalizedNowMs > expiresAtMs) {
    return { ok: false, reason: "manifest_expired" };
  }
  return { ok: true, manifest };
}

function validateModelCanaryDeliveryTarget(rawManifest, target, options = {}) {
  const checked = validateModelCanaryManifest(rawManifest, options);
  if (!checked.ok) return checked;
  const manifest = checked.manifest;
  const desktopInputLease = validateModelCanaryDesktopInputLease(
    target?.desktopInputLease,
    manifest,
  );
  if (normalizeText(target.deliveryPolicy) !== MODEL_CANARY_DELIVERY_POLICY
    || normalizeText(target.provider) !== "weflow-uia"
    || normalizeText(target.modelCanaryExecutionPolicy) !== MODEL_CANARY_EXECUTION_POLICY
    || normalizeText(target.modelCanaryRunId) !== manifest.runId
    || normalizeText(target.modelCanaryNonce) !== manifest.nonce
    || normalizeText(target.modelCanaryObligationFingerprint) !== manifest.obligationFingerprint
    || normalizeText(target.weflowContact) !== manifest.contact
    || normalizeText(target.weflowTalker) !== manifest.talker
    || target.weflowExactContact !== true
    || normalizeText(target.messageKind) !== manifest.replyMessageKind
    || normalizeText(target.idempotencyKey) !== manifest.replyIdempotencyKey
    || normalizeText(target.canonicalText) !== manifest.replyText
    || normalizePositiveInteger(target.requireDesktopIdleSeconds) !== 0
    || !desktopInputLease.ok) {
    return { ok: false, reason: "delivery_target_mismatch" };
  }
  return { ok: true, manifest, desktopInputLease: desktopInputLease.lease };
}

function validateModelCanaryDesktopInputLease(raw, manifest) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "desktop_input_lease_missing" };
  }
  const lease = {
    version: Number(raw.version),
    mode: normalizeText(raw.mode),
    runId: normalizeText(raw.runId).toLowerCase(),
    nonce: normalizeText(raw.nonce).toLowerCase(),
    targetFingerprint: normalizeText(raw.targetFingerprint).toLowerCase(),
    replyIdempotencyKey: normalizeText(raw.replyIdempotencyKey),
    expiresAt: normalizeIsoTime(raw.expiresAt),
    token: normalizeText(raw.token).toLowerCase(),
  };
  if (lease.version !== MODEL_CANARY_VERSION
    || lease.mode !== "model_e2e"
    || lease.runId !== normalizeText(manifest?.runId).toLowerCase()
    || lease.nonce !== normalizeText(manifest?.nonce).toLowerCase()
    || lease.targetFingerprint !== normalizeText(manifest?.targetFingerprint).toLowerCase()
    || lease.replyIdempotencyKey !== normalizeText(manifest?.replyIdempotencyKey)
    || lease.expiresAt !== normalizeIsoTime(manifest?.expiresAt)
    || !LEASE_TOKEN_PATTERN.test(lease.token)) {
    return { ok: false, reason: "desktop_input_lease_binding_invalid" };
  }
  return { ok: true, lease };
}

function buildModelCanaryTriggerText(runId, nonce) {
  const normalizedRunId = normalizeText(runId).toLowerCase();
  const normalizedNonce = normalizeText(nonce).toLowerCase();
  if (!RUN_ID_PATTERN.test(normalizedRunId) || !NONCE_PATTERN.test(normalizedNonce)) {
    throw new Error("model canary runId or nonce is invalid");
  }
  return `[Cyberboss心跳模型探针 trigger=${normalizedRunId} nonce=${normalizedNonce}]`;
}

function buildModelCanaryReplyText(runId) {
  const normalizedRunId = normalizeText(runId).toLowerCase();
  if (!RUN_ID_PATTERN.test(normalizedRunId)) {
    throw new Error("model canary runId is invalid");
  }
  return `[Cyberboss心跳模型正常 trigger=${normalizedRunId}]`;
}

function buildModelCanaryMessageKind(runId) {
  const normalizedRunId = normalizeText(runId).toLowerCase();
  if (!RUN_ID_PATTERN.test(normalizedRunId)) {
    throw new Error("model canary message kind is invalid");
  }
  return `model_canary_reply:${normalizedRunId}`;
}

function buildModelCanaryIdempotencyKey(runId) {
  const normalizedRunId = normalizeText(runId).toLowerCase();
  if (!RUN_ID_PATTERN.test(normalizedRunId)) {
    throw new Error("model canary idempotency identity is invalid");
  }
  return `model-canary-reply:${normalizedRunId}`;
}

function parseModelCanaryText(value) {
  const text = normalizeText(value);
  if (!text.startsWith("[Cyberboss心跳模型")) return null;
  const trigger = text.match(TRIGGER_PATTERN);
  if (trigger) {
    return { type: "trigger", runId: trigger[1], nonce: trigger[2], text };
  }
  const reply = text.match(REPLY_PATTERN);
  if (reply) {
    return { type: "reply", runId: reply[1], nonce: "", text };
  }
  return { type: "invalid", runId: "", nonce: "", text };
}

function acquireClaimDirectory(directory, payload) {
  try {
    fs.mkdirSync(directory, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") return { acquired: false };
    throw error;
  }
  try {
    writeJsonAtomicOnce(path.join(directory, "claim.json"), payload);
  } catch (error) {
    // Directory presence is the fail-closed claim even if its detail receipt was
    // interrupted. A replay will never dispatch a second turn or message.
    throw error;
  }
  return { acquired: true };
}

function resolveRunDirectory(rootDir, runId) {
  if (!RUN_ID_PATTERN.test(normalizeText(runId))) return null;
  const resolved = path.resolve(rootDir, runId);
  const relative = path.relative(rootDir, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? resolved : null;
}

function writeJsonAtomicOnce(filePath, payload) {
  const existing = readJsonIfPresent(filePath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    if (fs.existsSync(filePath)) return readJsonIfPresent(filePath) || payload;
    fs.renameSync(temporary, filePath);
    return payload;
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizeObservedAt(message, fallback) {
  const direct = normalizeIsoTime(message?.receivedAt);
  if (direct) return direct;
  const timestamp = Number(message?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const milliseconds = timestamp > 9_999_999_999 ? timestamp : timestamp * 1_000;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

function normalizeIsoTime(value) {
  const text = normalizeText(value);
  if (!text) return "";
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function normalizeNowMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function normalizeLocalId(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && text !== "0" ? text.replace(/^0+(?=\d)/, "") : "";
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

module.exports = {
  DEFAULT_MODEL_CANARY_TTL_MS,
  MAX_MODEL_CANARY_TTL_MS,
  MODEL_CANARY_DELIVERY_POLICY,
  MODEL_CANARY_DIRECTORY,
  MODEL_CANARY_EXECUTION_POLICY,
  MODEL_CANARY_MIN_DESKTOP_IDLE_SECONDS,
  MODEL_CANARY_PROMPT,
  MODEL_CANARY_VERSION,
  WeFlowModelCanary,
  buildModelCanaryManifestFingerprint,
  buildModelCanaryIdempotencyKey,
  buildModelCanaryMessageKind,
  buildModelCanaryPreparedMessage,
  buildModelCanaryReplyText,
  buildModelCanaryTriggerText,
  createModelCanaryManifest,
  createModelCanaryDesktopInputLeaseReceipt,
  parseModelCanaryText,
  validateModelCanaryDeliveryTarget,
  validateModelCanaryDesktopInputLease,
  validateModelCanaryDesktopInputLeaseReceipt,
  validateModelCanaryManifest,
};
