const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CANARY_VERSION = 1;
const CANARY_DIRECTORY = "e2e-probes";
const QUARANTINE_DIRECTORY = "e2e-probe-quarantine";
const MAX_CANARY_TTL_MS = 2 * 60_000;
const MAX_CLOCK_SKEW_MS = 10_000;
const MAX_QUARANTINE_FILES = 100;
const QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NONCE_PATTERN = /^[a-f0-9]{24}$/;
const TRIGGER_PATTERN = /^\[Cyberboss心跳探针 trigger=([a-f0-9-]+) nonce=([a-f0-9]+)\]$/;
const REPLY_PATTERN = /^\[Cyberboss心跳正常 trigger=([a-f0-9-]+)\]$/;

class WeFlowHeartbeatCanary {
  constructor({
    config,
    channelAdapter,
    messageLedger,
    now = () => Date.now(),
    logger = console,
  } = {}) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.messageLedger = messageLedger;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.logger = logger || console;
    this.rootDir = path.resolve(this.config.stateDir || ".", CANARY_DIRECTORY);
    this.quarantineDir = path.resolve(this.config.stateDir || ".", QUARANTINE_DIRECTORY);
  }

  async handleObservedMessage({ message, classification, talker } = {}) {
    const candidate = parseHeartbeatCanaryText(message?.text);
    if (!candidate) {
      return { handled: false };
    }

    const normalizedTalker = normalizeText(talker);
    const validation = this.validateCandidate(candidate, normalizedTalker);
    if (!validation.ok) {
      this.recordQuarantine({
        candidate,
        message,
        classification,
        reason: validation.reason,
      });
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
    const manifestPath = path.join(runDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, reason: "manifest_missing" };
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      return { ok: false, reason: "manifest_invalid" };
    }
    const manifestValidation = validateManifest(manifest, {
      candidate,
      talker,
      expectedTalker: normalizeText(this.config.weflowCanaryChat),
      expectedContact: normalizeText(this.config.weflowCanaryDisplayName),
      nowMs: normalizeNowMs(this.now()),
    });
    return manifestValidation.ok
      ? { ok: true, manifest: manifestValidation.manifest, runDir }
      : manifestValidation;
  }

  async handleTrigger({ candidate, manifest, runDir, message, classification, talker }) {
    if (normalizeText(message?.direction).toLowerCase() !== "outgoing") {
      this.recordQuarantine({ candidate, message, classification, reason: "trigger_direction_invalid" });
      return { handled: true, accepted: true, status: "quarantined", reason: "trigger_direction_invalid" };
    }
    if (normalizeText(classification?.origin).toLowerCase() !== "self_manual") {
      // The runner intentionally sends through the bridge without touching the
      // ledger. A ledger-owned row with this reserved marker is therefore not a
      // valid trigger and must not fall through to the model.
      this.recordQuarantine({ candidate, message, classification, reason: "trigger_origin_invalid" });
      return { handled: true, accepted: true, status: "quarantined", reason: "trigger_origin_invalid" };
    }

    const recordedAt = new Date(normalizeNowMs(this.now())).toISOString();
    const ingested = writeJsonAtomicOnce(path.join(runDir, "ingested.json"), {
      version: CANARY_VERSION,
      runId: candidate.runId,
      nonce: candidate.nonce,
      status: "ingested",
      talker,
      direction: "outgoing",
      triggerLocalId: normalizeLocalId(message?.localId),
      triggerMessageId: normalizeText(message?.id),
      triggerObservedAt: normalizeObservedAt(message, recordedAt),
      ingestedAt: recordedAt,
    });

    const replyDispatchPath = path.join(runDir, "reply-dispatched.json");
    const existingDispatch = readJsonIfPresent(replyDispatchPath);
    if (existingDispatch) {
      return {
        handled: true,
        accepted: true,
        status: "reply_already_dispatched",
        ingested,
        reply: existingDispatch,
      };
    }
    const existingFailure = readJsonIfPresent(path.join(runDir, "reply-failed.json"));
    if (normalizeText(existingFailure?.code) === "TARGET_NOT_CONFIRMED") {
      return {
        handled: true,
        accepted: true,
        status: "reply_target_not_confirmed",
        failed: existingFailure,
      };
    }

    const replyMessageKind = buildHeartbeatCanaryMessageKind("reply", candidate.runId);
    const idempotencyKey = buildHeartbeatCanaryIdempotencyKey("reply", candidate.runId);
    let sendResult;
    try {
      sendResult = await this.channelAdapter.sendText({
        userId: normalizeText(this.config.weflowInboxReplyUserId),
        text: manifest.replyText,
        preserveBlock: true,
        provider: "weflow-uia",
        messageKind: replyMessageKind,
        idempotencyKey,
        weflowContact: manifest.contact,
        weflowTalker: manifest.talker,
        weflowExactContact: true,
      });
    } catch (error) {
      this.logger.warn?.(
        `[cyberboss] heartbeat canary reply deferred runId=${candidate.runId}: ${formatError(error)}`
      );
      if (normalizeText(error?.code) === "TARGET_NOT_CONFIRMED") {
        const failed = writeJsonAtomicOnce(path.join(runDir, "reply-failed.json"), {
          version: CANARY_VERSION,
          runId: candidate.runId,
          nonce: candidate.nonce,
          status: "failed",
          code: "TARGET_NOT_CONFIRMED",
          repairable: false,
          talker,
          contact: manifest.contact,
          error: formatError(error),
          recordedAt: new Date(normalizeNowMs(this.now())).toISOString(),
        });
        // Commit this pre-dispatch failure once so the lightweight poller does
        // not repeatedly foreground/search the desktop UI.
        return {
          handled: true,
          accepted: true,
          status: "reply_target_not_confirmed",
          failed,
        };
      }
      return {
        handled: true,
        accepted: false,
        status: "reply_deferred",
        reason: formatError(error),
      };
    }

    const ledgerEntry = this.messageLedger?.findEntry?.({ talker, idempotencyKey }) || null;
    const replyLocalId = normalizeLocalId(sendResult?.localId)
      || normalizeLocalId(ledgerEntry?.localId);
    const ledgerStatus = normalizeText(ledgerEntry?.status);
    const dispatchedAt = normalizeIsoTime(ledgerEntry?.sendingAt)
      || normalizeIsoTime(ledgerEntry?.createdAt)
      || recordedAt;
    const reply = writeJsonAtomicOnce(replyDispatchPath, {
      version: CANARY_VERSION,
      runId: candidate.runId,
      nonce: candidate.nonce,
      status: ledgerStatus === "verified" || sendResult?.verified === true
        ? "verified"
        : (sendResult?.uncertain === true || ledgerStatus === "failed_uncertain" ? "uncertain" : "dispatched"),
      talker,
      replyLocalId,
      dispatchedAt,
      recordedAt: new Date(normalizeNowMs(this.now())).toISOString(),
      ledgerStatus,
      deduplicated: sendResult?.deduplicated === true,
    });
    return { handled: true, accepted: true, status: "reply_dispatched", ingested, reply };
  }

  handleReplyEcho({ candidate, manifest, runDir, message, classification, talker }) {
    const expectedKind = buildHeartbeatCanaryMessageKind("reply", candidate.runId);
    if (normalizeText(message?.direction).toLowerCase() !== "outgoing"
      || normalizeText(classification?.origin).toLowerCase() !== "cyberboss"
      || normalizeText(classification?.entry?.messageKind) !== expectedKind
      || normalizeText(message?.text) !== manifest.replyText) {
      this.recordQuarantine({ candidate, message, classification, reason: "reply_authentication_failed" });
      return { handled: true, accepted: true, status: "quarantined", reason: "reply_authentication_failed" };
    }

    const recordedAt = new Date(normalizeNowMs(this.now())).toISOString();
    const observed = writeJsonAtomicOnce(path.join(runDir, "reply-observed.json"), {
      version: CANARY_VERSION,
      runId: candidate.runId,
      nonce: manifest.nonce,
      status: "observed",
      talker,
      direction: "outgoing",
      replyLocalId: normalizeLocalId(message?.localId)
        || normalizeLocalId(classification?.entry?.localId),
      replyMessageId: normalizeText(message?.id),
      replyObservedAt: normalizeObservedAt(message, recordedAt),
      recordedAt,
      matchedBy: normalizeText(classification?.matchedBy),
    });
    return { handled: true, accepted: true, status: "reply_observed", observed };
  }

  recordQuarantine({ candidate, message, classification, reason }) {
    try {
      fs.mkdirSync(this.quarantineDir, { recursive: true });
      pruneQuarantine(this.quarantineDir, normalizeNowMs(this.now()));
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
        version: CANARY_VERSION,
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
        `[cyberboss] reserved heartbeat canary marker quarantined runId=${candidate?.runId || "(invalid)"} reason=${reason}`
      );
    } catch (error) {
      this.logger.warn?.(`[cyberboss] heartbeat canary quarantine record failed: ${formatError(error)}`);
    }
  }
}

function buildHeartbeatCanaryTriggerText(runId, nonce) {
  const normalizedRunId = normalizeText(runId).toLowerCase();
  const normalizedNonce = normalizeText(nonce).toLowerCase();
  if (!RUN_ID_PATTERN.test(normalizedRunId) || !NONCE_PATTERN.test(normalizedNonce)) {
    throw new Error("heartbeat canary runId or nonce is invalid");
  }
  return `[Cyberboss心跳探针 trigger=${normalizedRunId} nonce=${normalizedNonce}]`;
}

function buildHeartbeatCanaryReplyText(runId) {
  const normalizedRunId = normalizeText(runId).toLowerCase();
  if (!RUN_ID_PATTERN.test(normalizedRunId)) {
    throw new Error("heartbeat canary runId is invalid");
  }
  return `[Cyberboss心跳正常 trigger=${normalizedRunId}]`;
}

function buildHeartbeatCanaryMessageKind(type, runId) {
  const normalizedType = type === "trigger" ? "trigger" : type === "reply" ? "reply" : "";
  const normalizedRunId = normalizeText(runId).toLowerCase();
  if (!normalizedType || !RUN_ID_PATTERN.test(normalizedRunId)) {
    throw new Error("heartbeat canary message kind is invalid");
  }
  return `heartbeat_canary_${normalizedType}:${normalizedRunId}`;
}

function buildHeartbeatCanaryIdempotencyKey(type, runId) {
  const normalizedType = type === "trigger" ? "trigger" : type === "reply" ? "reply" : "";
  const normalizedRunId = normalizeText(runId).toLowerCase();
  if (!normalizedType || !RUN_ID_PATTERN.test(normalizedRunId)) {
    throw new Error("heartbeat canary idempotency identity is invalid");
  }
  return `heartbeat-canary-${normalizedType}:${normalizedRunId}`;
}

function parseHeartbeatCanaryText(value) {
  const text = normalizeText(value);
  if (!text.startsWith("[Cyberboss心跳")) {
    return null;
  }
  const trigger = text.match(TRIGGER_PATTERN);
  if (trigger) {
    return {
      type: "trigger",
      runId: normalizeText(trigger[1]).toLowerCase(),
      nonce: normalizeText(trigger[2]).toLowerCase(),
      text,
    };
  }
  const reply = text.match(REPLY_PATTERN);
  if (reply) {
    return {
      type: "reply",
      runId: normalizeText(reply[1]).toLowerCase(),
      nonce: "",
      text,
    };
  }
  return { type: "invalid", runId: "", nonce: "", text };
}

function validateManifest(raw, { candidate, talker, expectedTalker = "", expectedContact = "", nowMs }) {
  if (!raw || typeof raw !== "object" || Number(raw.version) !== CANARY_VERSION) {
    return { ok: false, reason: "manifest_version_invalid" };
  }
  const manifest = {
    version: CANARY_VERSION,
    runId: normalizeText(raw.runId).toLowerCase(),
    nonce: normalizeText(raw.nonce).toLowerCase(),
    triggerText: normalizeText(raw.triggerText),
    replyText: normalizeText(raw.replyText),
    createdAt: normalizeIsoTime(raw.createdAt),
    expiresAt: normalizeIsoTime(raw.expiresAt),
    talker: normalizeText(raw.talker),
    contact: normalizeText(raw.contact),
    targetFingerprint: normalizeText(raw.targetFingerprint).toLowerCase(),
  };
  if (manifest.runId !== candidate.runId
    || !RUN_ID_PATTERN.test(manifest.runId)
    || !NONCE_PATTERN.test(manifest.nonce)
    || manifest.talker !== talker
    || !manifest.contact
    || !/^[a-f0-9]{64}$/.test(manifest.targetFingerprint)
    || manifest.targetFingerprint !== crypto.createHash("sha256")
      .update(`${manifest.contact}\n${manifest.talker}`, "utf8")
      .digest("hex")
    || (normalizeText(expectedTalker) && manifest.talker !== normalizeText(expectedTalker))
    || (normalizeText(expectedContact) && manifest.contact !== normalizeText(expectedContact))) {
    return { ok: false, reason: "manifest_identity_mismatch" };
  }
  if (manifest.triggerText !== buildHeartbeatCanaryTriggerText(manifest.runId, manifest.nonce)
    || manifest.replyText !== buildHeartbeatCanaryReplyText(manifest.runId)) {
    return { ok: false, reason: "manifest_text_mismatch" };
  }
  if (candidate.type === "trigger"
    && (candidate.nonce !== manifest.nonce || candidate.text !== manifest.triggerText)) {
    return { ok: false, reason: "trigger_text_mismatch" };
  }
  if (candidate.type === "reply" && candidate.text !== manifest.replyText) {
    return { ok: false, reason: "reply_text_mismatch" };
  }
  const createdAtMs = Date.parse(manifest.createdAt);
  const expiresAtMs = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= createdAtMs
    || expiresAtMs - createdAtMs > MAX_CANARY_TTL_MS
    || createdAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "manifest_ttl_invalid" };
  }
  if (nowMs > expiresAtMs) {
    return { ok: false, reason: "manifest_expired" };
  }
  return { ok: true, manifest };
}

function resolveRunDirectory(rootDir, runId) {
  const resolved = path.resolve(rootDir, runId);
  const relative = path.relative(rootDir, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? resolved
    : null;
}

function writeJsonAtomicOnce(filePath, payload) {
  const existing = readJsonIfPresent(filePath);
  if (existing) {
    return existing;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    if (fs.existsSync(filePath)) {
      return readJsonIfPresent(filePath) || payload;
    }
    fs.renameSync(temporary, filePath);
    return payload;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename removed the temporary path, or cleanup can be retried by the
      // state-directory maintenance outside this latency-sensitive path.
    }
  }
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON root must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`heartbeat canary state is invalid at ${filePath}: ${formatError(error)}`);
  }
}

function pruneQuarantine(directory, nowMs) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      let modifiedAtMs = 0;
      try {
        modifiedAtMs = fs.statSync(filePath).mtimeMs;
      } catch {
        modifiedAtMs = 0;
      }
      return { filePath, modifiedAtMs };
    })
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  for (const [index, entry] of entries.entries()) {
    if (index < MAX_QUARANTINE_FILES && nowMs - entry.modifiedAtMs <= QUARANTINE_RETENTION_MS) {
      continue;
    }
    try {
      fs.unlinkSync(entry.filePath);
    } catch {
      // A concurrent check may already have pruned the same bounded record.
    }
  }
}

function normalizeObservedAt(message, fallback) {
  const direct = normalizeIsoTime(message?.receivedAt);
  if (direct) {
    return direct;
  }
  const timestamp = Number(message?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const milliseconds = timestamp > 9_999_999_999 ? timestamp : timestamp * 1_000;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return fallback;
}

function normalizeIsoTime(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function normalizeNowMs(now) {
  const value = Number(now);
  return Number.isFinite(value) ? value : Date.now();
}

function normalizeLocalId(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && text !== "0" ? text.replace(/^0+(?=\d)/, "") : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

module.exports = {
  CANARY_DIRECTORY,
  CANARY_VERSION,
  MAX_CANARY_TTL_MS,
  WeFlowHeartbeatCanary,
  buildHeartbeatCanaryIdempotencyKey,
  buildHeartbeatCanaryMessageKind,
  buildHeartbeatCanaryReplyText,
  buildHeartbeatCanaryTriggerText,
  parseHeartbeatCanaryText,
};
