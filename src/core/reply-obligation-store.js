const crypto = require("crypto");
const DESKTOP_PROVIDERS = new Set(["weflow-uia", "wechat-cua"]);
const fs = require("fs");
const path = require("path");

const STORE_VERSION = 1;
const DEFAULT_NO_REPLY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_ENTRIES = 2_000;
const OPEN_STATUSES = new Set([
  "handoff_pending",
  "awaiting_final",
  "final_delivery_pending",
]);
const TERMINAL_FAILURE_OUTCOMES = new Set([
  "handoff_uncertain",
  "runtime_failed",
  "delivery_failed",
  "delivery_uncertain",
  "turn_completed_without_final",
  "no_reply_timeout",
]);
const TERMINAL_OUTCOMES = new Set([
  "verified",
  "deferred_durable",
  "explicit_silent",
  ...TERMINAL_FAILURE_OUTCOMES,
]);

class ReplyObligationStore {
  constructor({
    filePath,
    now = () => Date.now(),
    noReplyTimeoutMs = DEFAULT_NO_REPLY_TIMEOUT_MS,
    retentionMs = DEFAULT_RETENTION_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    instanceId = crypto.randomUUID(),
  } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("reply obligation filePath is required");
    }
    this.filePath = path.resolve(filePath);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.noReplyTimeoutMs = normalizePositiveInteger(noReplyTimeoutMs, DEFAULT_NO_REPLY_TIMEOUT_MS);
    this.retentionMs = normalizePositiveInteger(retentionMs, DEFAULT_RETENTION_MS);
    this.maxEntries = normalizePositiveInteger(maxEntries, DEFAULT_MAX_ENTRIES);
    this.instanceId = normalizeText(instanceId) || crypto.randomUUID();
    this.state = emptyState(this);

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.load();
    const recovered = this.recoverInterruptedHandoffs();
    const expired = this.expireOverdue();
    if (recovered === 0 && expired === 0 && this.state.writerInstanceId !== this.instanceId) {
      this.state.writerInstanceId = this.instanceId;
      this.save();
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.state = emptyState(this);
      this.save();
      return this.snapshot();
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.state = normalizeState(parsed, this);
    } catch (error) {
      this.recoverCorruptFile();
      this.state = emptyState(this, {
        integrityStatus: "recovered_corrupt",
        recoveredAt: this.isoNow(),
        lastError: formatError(error),
      });
      this.save();
    }
    return this.snapshot();
  }

  begin({
    sourceMessageIds,
    provider,
    talker = "",
    accountId = "",
    senderId,
    contextToken = "",
    bindingKey = "",
    workspaceRoot = "",
  } = {}) {
    const normalizedIds = normalizeSourceMessageIds(sourceMessageIds);
    const normalizedProvider = normalizeText(provider);
    const normalizedSenderId = normalizeText(senderId);
    if (!normalizedIds.length || !DESKTOP_PROVIDERS.has(normalizedProvider) || !normalizedSenderId) {
      throw new Error("reply obligation requires a desktop-provider source message id and a sender");
    }
    const id = buildReplyObligationId({
      sourceMessageIds: normalizedIds,
      provider: normalizedProvider,
      accountId,
      senderId: normalizedSenderId,
    });
    const existing = this.findMutable(id);
    if (existing) {
      if (!existing.terminal && existing.status === "handoff_pending") {
        existing.handoffAttemptCount += 1;
        existing.handoffStartedAt = existing.handoffStartedAt || this.isoNow();
        existing.updatedAt = this.isoNow();
        existing.writerInstanceId = this.instanceId;
        this.save();
      }
      return { created: false, entry: clone(existing) };
    }

    const createdAt = this.isoNow();
    const entry = {
      id,
      sourceProvider: normalizedProvider,
      sourceMessageIds: normalizedIds,
      talker: normalizeText(talker),
      accountId: normalizeText(accountId),
      senderId: normalizedSenderId,
      contextToken: normalizeText(contextToken),
      bindingKey: normalizeText(bindingKey),
      workspaceRoot: normalizeText(workspaceRoot),
      writerInstanceId: this.instanceId,
      status: "handoff_pending",
      terminal: false,
      terminalOutcome: "",
      createdAt,
      updatedAt: createdAt,
      handoffStartedAt: createdAt,
      handoffAcceptedAt: "",
      handoffAttemptCount: 1,
      lastHandoffFailureAt: "",
      threadId: "",
      turnId: "",
      finalPreparedAt: "",
      finalMessageKind: "",
      finalContentHash: "",
      finalArtifactSha256: "",
      deliveryStartedAt: "",
      deliveryAttemptCount: 0,
      deliveryIdempotencyKey: "",
      deliveryVerifiedAt: "",
      deliveryLocalId: "",
      deliveryCertainty: "unknown",
      deferredAt: "",
      turnCompletedAt: "",
      runtimeFailedAt: "",
      terminalAt: "",
      failureNotifiedAt: "",
      noReplyTimeoutMs: this.noReplyTimeoutMs,
      noReplyDeadlineAt: new Date(this.currentTimeMs() + this.noReplyTimeoutMs).toISOString(),
      noReplyTimedOutAt: "",
      lastError: "",
    };
    this.state.obligations.push(entry);
    this.save();
    return { created: true, entry: clone(entry) };
  }

  get(id) {
    const entry = this.findMutable(id);
    return entry ? clone(entry) : null;
  }

  listOpen() {
    return this.state.obligations
      .filter((entry) => !entry.terminal && OPEN_STATUSES.has(entry.status))
      .map(clone);
  }

  markHandoffFailure(id, error) {
    return this.updateOpen(id, (entry, now) => {
      entry.lastHandoffFailureAt = now;
      entry.lastError = formatError(error);
    });
  }

  markTurnAccepted(id, { threadId = "", turnId = "" } = {}) {
    return this.updateOpen(id, (entry, now) => {
      entry.status = "awaiting_final";
      entry.handoffAcceptedAt = entry.handoffAcceptedAt || now;
      entry.threadId = normalizeText(threadId) || entry.threadId;
      entry.turnId = normalizeText(turnId) || entry.turnId;
      entry.lastError = "";
    });
  }

  markFinalDeliveryStarted(id, {
    text = "",
    messageKind = "plain_reply",
    idempotencyKey = "",
    sha256 = "",
  } = {}) {
    return this.updateOpen(id, (entry, now) => {
      entry.status = "final_delivery_pending";
      entry.finalPreparedAt = entry.finalPreparedAt || now;
      entry.finalMessageKind = normalizeFinalMessageKind(messageKind);
      entry.finalContentHash = hashText(text);
      entry.finalArtifactSha256 = normalizeHash(sha256);
      entry.deliveryStartedAt = now;
      entry.deliveryAttemptCount += 1;
      entry.deliveryIdempotencyKey = normalizeText(idempotencyKey);
      entry.deliveryCertainty = "unknown";
      entry.lastError = "";
    });
  }

  markVerified(id, { localId = "", verifiedAt = "" } = {}) {
    return this.terminate(id, "verified", {
      at: verifiedAt,
      mutate(entry, now) {
        entry.deliveryVerifiedAt = now;
        entry.deliveryLocalId = normalizePositiveIntegerText(localId);
        entry.deliveryCertainty = "certain";
        entry.lastError = "";
      },
    });
  }

  markDeferred(id, { error = null, deferredAt = "" } = {}) {
    return this.terminate(id, "deferred_durable", {
      at: deferredAt,
      mutate(entry, now) {
        entry.deferredAt = now;
        entry.deliveryCertainty = "certain_not_dispatched";
        entry.lastError = formatError(error);
      },
    });
  }

  markExplicitSilent(id) {
    return this.terminate(id, "explicit_silent", {
      mutate(entry) {
        entry.deliveryCertainty = "certain_not_dispatched";
        entry.lastError = "";
      },
    });
  }

  /**
   * Claim the one-time "this turn produced no reply" notice.
   *
   * Returns true only for the caller that wins the claim, so the user is told at
   * most once per obligation even if the process restarts between the terminal
   * outcome and the send. Unknown or already-claimed entries return false.
   */
  markFailureNotified(id, { at = "" } = {}) {
    const entry = this.findMutable(id);
    if (!entry) return false;
    if (entry.failureNotifiedAt) return false;
    entry.failureNotifiedAt = normalizeIsoTime(at, this.currentTimeMs());
    entry.updatedAt = entry.failureNotifiedAt;
    this.save();
    return true;
  }

  markDeliveryFailure(id, { error = null, deliveryUncertain } = {}) {
    const uncertain = deliveryUncertain !== false;
    return this.terminate(id, uncertain ? "delivery_uncertain" : "delivery_failed", {
      mutate(entry) {
        entry.deliveryCertainty = uncertain ? "uncertain" : "certain_not_dispatched";
        entry.lastError = formatError(error);
      },
    });
  }

  markTurnCompleted(id, { hadFinalReply = false, completedAt = "" } = {}) {
    const entry = this.findMutable(id);
    if (!entry) return null;
    const now = normalizeIsoTime(completedAt, this.currentTimeMs());
    if (!entry.turnCompletedAt) {
      entry.turnCompletedAt = now;
    }
    if (entry.terminal) {
      entry.updatedAt = now;
      this.save();
      return clone(entry);
    }
    const outcome = hadFinalReply || entry.finalPreparedAt
      ? "delivery_failed"
      : "turn_completed_without_final";
    entry.lastError = outcome === "turn_completed_without_final"
      ? "runtime turn completed without a final reply"
      : "runtime turn completed before final delivery reached a terminal state";
    terminateEntry(entry, outcome, now);
    this.save();
    return clone(entry);
  }

  markRuntimeFailed(id, { error = null, failedAt = "" } = {}) {
    return this.terminate(id, "runtime_failed", {
      at: failedAt,
      mutate(entry, now) {
        entry.runtimeFailedAt = now;
        entry.lastError = formatError(error);
      },
    });
  }

  expireOverdue() {
    const nowMs = this.currentTimeMs();
    const now = new Date(nowMs).toISOString();
    let count = 0;
    for (const entry of this.state.obligations) {
      if (entry.terminal || !OPEN_STATUSES.has(entry.status)) continue;
      const deadlineMs = Date.parse(entry.noReplyDeadlineAt);
      if (!Number.isFinite(deadlineMs) || deadlineMs > nowMs) continue;
      entry.noReplyTimedOutAt = now;
      entry.lastError = "reply obligation exceeded its no-reply deadline";
      terminateEntry(entry, "no_reply_timeout", now);
      count += 1;
    }
    if (count > 0) this.save();
    return count;
  }

  reconcileWithLedger(messageLedger) {
    if (!messageLedger || typeof messageLedger.findEntry !== "function") return 0;
    let count = 0;
    for (const obligation of this.state.obligations) {
      const terminalUncertain = obligation.terminal
        && obligation.terminalOutcome === "delivery_uncertain";
      if ((obligation.terminal && !terminalUncertain) || !obligation.deliveryIdempotencyKey) continue;
      const ledgerEntry = messageLedger.findEntry({
        talker: obligation.talker,
        idempotencyKey: obligation.deliveryIdempotencyKey,
      });
      if (!ledgerEntry) continue;
      const status = normalizeText(ledgerEntry.status).toLowerCase();
      if (status === "verified" && normalizePositiveIntegerText(ledgerEntry.localId)) {
        if (terminalUncertain) {
          if (!isLateVerifiedLedgerProof(obligation, ledgerEntry)) continue;
          const verifiedAt = normalizeOptionalIsoTime(
            ledgerEntry.verifiedAt || ledgerEntry.updatedAt
          );
          obligation.deliveryVerifiedAt = verifiedAt;
          obligation.deliveryLocalId = normalizePositiveIntegerText(ledgerEntry.localId);
          obligation.deliveryCertainty = "certain";
          obligation.lastError = "";
          terminateEntry(obligation, "verified", this.isoNow());
          this.save();
        } else {
          this.markVerified(obligation.id, {
            localId: ledgerEntry.localId,
            verifiedAt: ledgerEntry.verifiedAt || ledgerEntry.updatedAt,
          });
        }
        count += 1;
      } else if (terminalUncertain) {
        // An uncertain terminal receipt is intentionally sticky until the same
        // durable ledger claim becomes a strict verified proof. Never downgrade
        // or reclassify it from another transient ledger state.
        continue;
      } else if (status === "failed") {
        this.markDeliveryFailure(obligation.id, {
          error: ledgerEntry.failureCode || "ledger recorded a certain outbound failure",
          deliveryUncertain: false,
        });
        count += 1;
      } else if (status === "sending" || status === "failed_uncertain") {
        this.markDeliveryFailure(obligation.id, {
          error: ledgerEntry.failureCode || "ledger retained an uncertain outbound dispatch",
          deliveryUncertain: true,
        });
        count += 1;
      }
    }
    return count;
  }

  recoverInterruptedHandoffs() {
    const now = this.isoNow();
    let count = 0;
    for (const entry of this.state.obligations) {
      if (entry.terminal
        || entry.status !== "handoff_pending"
        || entry.writerInstanceId === this.instanceId) {
        continue;
      }
      entry.lastError = "the prior process stopped before runtime handoff acceptance was durably recorded";
      terminateEntry(entry, "handoff_uncertain", now);
      count += 1;
    }
    this.state.writerInstanceId = this.instanceId;
    if (count > 0) this.save();
    return count;
  }

  snapshot() {
    return clone(this.state);
  }

  save() {
    this.prune();
    this.state.version = STORE_VERSION;
    this.state.writerInstanceId = this.instanceId;
    this.state.updatedAt = this.isoNow();
    this.state.policy = {
      noReplyTimeoutMs: this.noReplyTimeoutMs,
      retentionMs: this.retentionMs,
      maxEntries: this.maxEntries,
    };
    this.state.summary = buildSummary(this.state.obligations, this.currentTimeMs());
    atomicWriteJson(this.filePath, this.state);
  }

  updateOpen(id, mutate) {
    const entry = this.findMutable(id);
    if (!entry || entry.terminal) return entry ? clone(entry) : null;
    const now = this.isoNow();
    mutate(entry, now);
    entry.updatedAt = now;
    this.save();
    return clone(entry);
  }

  terminate(id, outcome, { at = "", mutate = null } = {}) {
    const entry = this.findMutable(id);
    if (!entry || entry.terminal) return entry ? clone(entry) : null;
    const now = normalizeIsoTime(at, this.currentTimeMs());
    if (typeof mutate === "function") mutate(entry, now);
    terminateEntry(entry, outcome, now);
    this.save();
    return clone(entry);
  }

  findMutable(id) {
    const normalizedId = normalizeText(id);
    return normalizedId
      ? this.state.obligations.find((entry) => entry.id === normalizedId) || null
      : null;
  }

  prune() {
    const cutoff = this.currentTimeMs() - this.retentionMs;
    const open = [];
    const terminal = [];
    for (const entry of this.state.obligations) {
      if (!entry.terminal) {
        open.push(entry);
        continue;
      }
      const terminalMs = Date.parse(entry.terminalAt || entry.updatedAt);
      if (Number.isFinite(terminalMs) && terminalMs >= cutoff) terminal.push(entry);
    }
    terminal.sort(compareEntries);
    const terminalLimit = Math.max(0, this.maxEntries - open.length);
    this.state.obligations = [...open, ...terminal.slice(-terminalLimit)].sort(compareEntries);
  }

  recoverCorruptFile() {
    if (!fs.existsSync(this.filePath)) return;
    const backup = `${this.filePath}.corrupt-${this.currentTimeMs()}-${process.pid}`;
    try { fs.renameSync(this.filePath, backup); } catch {}
  }

  currentTimeMs() {
    const value = Number(this.now());
    return Number.isFinite(value) ? value : Date.now();
  }

  isoNow() {
    return new Date(this.currentTimeMs()).toISOString();
  }
}

function emptyState(store, { integrityStatus = "healthy", recoveredAt = "", lastError = "" } = {}) {
  const now = new Date(store.currentTimeMs()).toISOString();
  return {
    version: STORE_VERSION,
    writerInstanceId: store.instanceId,
    updatedAt: now,
    integrity: {
      status: integrityStatus,
      recoveredAt: normalizeText(recoveredAt),
      lastError: normalizeText(lastError),
    },
    policy: {
      noReplyTimeoutMs: store.noReplyTimeoutMs,
      retentionMs: store.retentionMs,
      maxEntries: store.maxEntries,
    },
    summary: buildSummary([], store.currentTimeMs()),
    obligations: [],
  };
}

function normalizeState(raw, store) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Number(raw.version) !== STORE_VERSION
    || !Array.isArray(raw.obligations)) {
    throw new Error("reply obligation state schema is invalid");
  }
  const obligations = raw.obligations.map(normalizeEntry);
  if (obligations.some((entry) => !entry)) {
    throw new Error("reply obligation entry schema is invalid");
  }
  const integrityStatus = ["healthy", "recovered_corrupt"].includes(normalizeText(raw.integrity?.status))
    ? normalizeText(raw.integrity.status)
    : "healthy";
  return {
    version: STORE_VERSION,
    writerInstanceId: normalizeText(raw.writerInstanceId),
    updatedAt: normalizeRequiredIsoTime(raw.updatedAt, "updatedAt"),
    integrity: {
      status: integrityStatus,
      recoveredAt: normalizeOptionalIsoTime(raw.integrity?.recoveredAt),
      lastError: normalizeText(raw.integrity?.lastError),
    },
    policy: {
      noReplyTimeoutMs: store.noReplyTimeoutMs,
      retentionMs: store.retentionMs,
      maxEntries: store.maxEntries,
    },
    summary: buildSummary(obligations, store.currentTimeMs()),
    obligations: obligations.sort(compareEntries),
  };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const sourceMessageIds = normalizeSourceMessageIds(raw.sourceMessageIds);
  const status = normalizeText(raw.status);
  const terminal = raw.terminal === true;
  const terminalOutcome = normalizeText(raw.terminalOutcome);
  if (!/^reply-obligation:[a-f0-9]{64}$/.test(normalizeText(raw.id))
    || !DESKTOP_PROVIDERS.has(normalizeText(raw.sourceProvider))
    || !sourceMessageIds.length
    || !normalizeText(raw.senderId)
    || (!terminal && !OPEN_STATUSES.has(status))
    || (terminal && (
      !TERMINAL_OUTCOMES.has(terminalOutcome)
      || status !== statusForTerminalOutcome(terminalOutcome)
    ))) {
    return null;
  }
  const requiredTimes = ["createdAt", "updatedAt", "handoffStartedAt", "noReplyDeadlineAt"];
  try {
    for (const name of requiredTimes) normalizeRequiredIsoTime(raw[name], name);
  } catch {
    return null;
  }
  return {
    id: normalizeText(raw.id),
    sourceProvider: "weflow-uia",
    sourceMessageIds,
    talker: normalizeText(raw.talker),
    accountId: normalizeText(raw.accountId),
    senderId: normalizeText(raw.senderId),
    contextToken: normalizeText(raw.contextToken),
    bindingKey: normalizeText(raw.bindingKey),
    workspaceRoot: normalizeText(raw.workspaceRoot),
    writerInstanceId: normalizeText(raw.writerInstanceId),
    status,
    terminal,
    terminalOutcome,
    createdAt: normalizeRequiredIsoTime(raw.createdAt, "createdAt"),
    updatedAt: normalizeRequiredIsoTime(raw.updatedAt, "updatedAt"),
    handoffStartedAt: normalizeRequiredIsoTime(raw.handoffStartedAt, "handoffStartedAt"),
    handoffAcceptedAt: normalizeOptionalIsoTime(raw.handoffAcceptedAt),
    handoffAttemptCount: normalizeNonNegativeInteger(raw.handoffAttemptCount),
    lastHandoffFailureAt: normalizeOptionalIsoTime(raw.lastHandoffFailureAt),
    threadId: normalizeText(raw.threadId),
    turnId: normalizeText(raw.turnId),
    finalPreparedAt: normalizeOptionalIsoTime(raw.finalPreparedAt),
    finalMessageKind: normalizeText(raw.finalMessageKind),
    finalContentHash: normalizeHash(raw.finalContentHash),
    finalArtifactSha256: normalizeHash(raw.finalArtifactSha256),
    deliveryStartedAt: normalizeOptionalIsoTime(raw.deliveryStartedAt),
    deliveryAttemptCount: normalizeNonNegativeInteger(raw.deliveryAttemptCount),
    deliveryIdempotencyKey: normalizeText(raw.deliveryIdempotencyKey),
    deliveryVerifiedAt: normalizeOptionalIsoTime(raw.deliveryVerifiedAt),
    deliveryLocalId: normalizePositiveIntegerText(raw.deliveryLocalId),
    deliveryCertainty: ["unknown", "certain", "certain_not_dispatched", "uncertain"].includes(normalizeText(raw.deliveryCertainty))
      ? normalizeText(raw.deliveryCertainty)
      : "unknown",
    deferredAt: normalizeOptionalIsoTime(raw.deferredAt),
    turnCompletedAt: normalizeOptionalIsoTime(raw.turnCompletedAt),
    runtimeFailedAt: normalizeOptionalIsoTime(raw.runtimeFailedAt),
    terminalAt: normalizeOptionalIsoTime(raw.terminalAt),
    // Persisted so the one-time "no reply" notice survives a restart instead of
    // being re-sent on the next observation of the same terminal obligation.
    failureNotifiedAt: normalizeOptionalIsoTime(raw.failureNotifiedAt),
    noReplyTimeoutMs: normalizePositiveInteger(raw.noReplyTimeoutMs, DEFAULT_NO_REPLY_TIMEOUT_MS),
    noReplyDeadlineAt: normalizeRequiredIsoTime(raw.noReplyDeadlineAt, "noReplyDeadlineAt"),
    noReplyTimedOutAt: normalizeOptionalIsoTime(raw.noReplyTimedOutAt),
    lastError: normalizeText(raw.lastError),
  };
}

function isLateVerifiedLedgerProof(obligation, ledgerEntry) {
  if (!obligation || !ledgerEntry || ledgerEntry.uncertain !== false) return false;
  if (normalizeText(ledgerEntry.idempotencyKey) !== obligation.deliveryIdempotencyKey) return false;
  if (normalizeText(ledgerEntry.talker) !== obligation.talker) return false;
  if (!normalizePositiveIntegerText(ledgerEntry.localId)) return false;
  // The ledger hashes the NFKC/whitespace-normalized payload while the
  // obligation stores the raw runtime text hash. The exact durable
  // idempotency claim is therefore the cross-store identity; requiring the two
  // intentionally different hashes to match would strand valid late echoes.
  if (!normalizeHash(ledgerEntry.contentHash)) return false;
  const expectedContentKind = obligation.finalArtifactSha256 ? "image" : "text";
  if (normalizeText(ledgerEntry.contentKind).toLowerCase() !== expectedContentKind) return false;
  if (obligation.finalArtifactSha256
    && normalizeHash(ledgerEntry.imageDigest) !== obligation.finalArtifactSha256) {
    return false;
  }
  const obligationAttempts = normalizeNonNegativeInteger(obligation.deliveryAttemptCount);
  const ledgerAttempts = normalizeNonNegativeInteger(ledgerEntry.attemptCount);
  if (obligationAttempts < 1 || ledgerAttempts !== obligationAttempts) return false;
  const startedAtMs = Date.parse(obligation.deliveryStartedAt);
  const verifiedAtMs = Date.parse(ledgerEntry.verifiedAt || ledgerEntry.updatedAt);
  return Number.isFinite(startedAtMs)
    && Number.isFinite(verifiedAtMs)
    && verifiedAtMs >= startedAtMs;
}

function terminateEntry(entry, outcome, at) {
  entry.terminal = true;
  entry.terminalOutcome = normalizeText(outcome);
  entry.status = statusForTerminalOutcome(outcome);
  entry.terminalAt = at;
  entry.updatedAt = at;
}

function statusForTerminalOutcome(outcome) {
  return outcome === "verified"
    ? "verified"
    : outcome === "deferred_durable"
      ? "deferred"
      : outcome === "explicit_silent"
        ? "suppressed"
        : outcome === "no_reply_timeout"
          ? "timed_out"
          : "failed";
}

function buildSummary(entries, nowMs) {
  const obligations = Array.isArray(entries) ? entries : [];
  const open = obligations.filter((entry) => !entry.terminal);
  const deadlines = open
    .map((entry) => Date.parse(entry.noReplyDeadlineAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const created = open
    .map((entry) => Date.parse(entry.createdAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return {
    totalCount: obligations.length,
    openCount: open.length,
    overdueCount: deadlines.filter((value) => value <= nowMs).length,
    verifiedCount: obligations.filter((entry) => entry.terminalOutcome === "verified").length,
    deferredCount: obligations.filter((entry) => entry.terminalOutcome === "deferred_durable").length,
    suppressedCount: obligations.filter((entry) => entry.terminalOutcome === "explicit_silent").length,
    terminalFailureCount: obligations.filter((entry) => TERMINAL_FAILURE_OUTCOMES.has(entry.terminalOutcome)).length,
    attentionRequiredCount: obligations.filter((entry) => (
      entry.terminalOutcome === "deferred_durable"
      || TERMINAL_FAILURE_OUTCOMES.has(entry.terminalOutcome)
    )).length,
    oldestOpenCreatedAt: created.length ? new Date(created[0]).toISOString() : "",
    nextDeadlineAt: deadlines.length ? new Date(deadlines[0]).toISOString() : "",
  };
}

function buildReplyObligationId({ sourceMessageIds, provider, accountId = "", senderId }) {
  const digest = crypto.createHash("sha256").update(JSON.stringify({
    version: STORE_VERSION,
    sourceMessageIds: normalizeSourceMessageIds(sourceMessageIds).sort(),
    provider: normalizeText(provider),
    accountId: normalizeText(accountId),
    senderId: normalizeText(senderId),
  }), "utf8").digest("hex");
  return `reply-obligation:${digest}`;
}

function buildReplyDeliveryIdempotencyKey(obligationId, itemId = "final") {
  const normalizedId = normalizeText(obligationId);
  if (!/^reply-obligation:[a-f0-9]{64}$/.test(normalizedId)) return "";
  const itemHash = crypto.createHash("sha256")
    .update(normalizeText(itemId) || "final", "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${normalizedId}:delivery:${itemHash}`;
}

function hashText(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  return normalized
    ? crypto.createHash("sha256").update(normalized, "utf8").digest("hex")
    : "";
}

function normalizeSourceMessageIds(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = normalizeText(value);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizeFinalMessageKind(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized && normalized !== "progress" ? normalized : "plain_reply";
}

function normalizeRequiredIsoTime(value, name) {
  const normalized = normalizeOptionalIsoTime(value);
  if (!normalized) throw new Error(`${name} must be an ISO timestamp`);
  return normalized;
}

function normalizeOptionalIsoTime(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeIsoTime(value, fallbackMs) {
  return normalizeOptionalIsoTime(value) || new Date(fallbackMs).toISOString();
}

function normalizePositiveIntegerText(value) {
  const text = normalizeText(value);
  try { return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text).toString() : ""; } catch { return ""; }
}

function normalizeNonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeHash(value) {
  const normalized = normalizeText(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function compareEntries(left, right) {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id);
}

function formatError(error) {
  return error instanceof Error ? error.message : normalizeText(error);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
  }
}

module.exports = {
  DEFAULT_NO_REPLY_TIMEOUT_MS,
  ReplyObligationStore,
  STORE_VERSION,
  buildReplyDeliveryIdempotencyKey,
  buildReplyObligationId,
};
