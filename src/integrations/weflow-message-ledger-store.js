const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_MATCH_WINDOW_MS = 120_000;
const DEFAULT_UNCERTAIN_MATCH_WINDOW_MS = 15 * 60_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 4_000;
const LEDGER_VERSION = 3;
const VALID_EXPECTED_DIRECTIONS = new Set(["incoming", "outgoing"]);
const MATCHABLE_STATUSES = new Set(["sending", "failed_uncertain"]);
const VALID_STATUSES = new Set([
  "planned",
  "sending",
  "verified",
  "failed",
  "failed_uncertain",
]);

class WeFlowMessageLedgerStore {
  constructor({
    filePath,
    now = () => Date.now(),
    matchWindowMs = DEFAULT_MATCH_WINDOW_MS,
    uncertainMatchWindowMs = DEFAULT_UNCERTAIN_MATCH_WINDOW_MS,
    retentionMs = DEFAULT_RETENTION_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("weflow message ledger filePath is required");
    }
    this.filePath = path.resolve(filePath);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.matchWindowMs = normalizePositiveInteger(matchWindowMs, DEFAULT_MATCH_WINDOW_MS);
    this.uncertainMatchWindowMs = Math.max(
      this.matchWindowMs,
      normalizePositiveInteger(uncertainMatchWindowMs, DEFAULT_UNCERTAIN_MATCH_WINDOW_MS),
    );
    this.retentionMs = normalizePositiveInteger(retentionMs, DEFAULT_RETENTION_MS);
    this.maxEntries = normalizePositiveInteger(maxEntries, DEFAULT_MAX_ENTRIES);
    this.state = emptyState();

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.state = emptyState();
      return this.state;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      this.recoverCorruptFile();
      this.state = emptyState();
      this.save();
      return this.state;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      this.recoverCorruptFile();
      this.state = emptyState();
      this.save();
      return this.state;
    }

    const normalized = parsed.entries
      .map(normalizeLedgerEntry)
      .filter(Boolean)
      .sort(compareEntries);
    const entries = pruneEntries(normalized, {
      nowMs: this.currentTimeMs(),
      retentionMs: this.retentionMs,
      maxEntries: this.maxEntries,
    });
    this.state = { version: LEDGER_VERSION, entries };

    // A migration/prune write error is an I/O failure, not proof that the
    // successfully parsed primary file is corrupt. Preserve it and surface the
    // error so outbound delivery stops instead of losing loop-prevention state.
    if (parsed.version !== LEDGER_VERSION
      || normalized.length !== parsed.entries.length
      || entries.length !== normalized.length) {
      this.save();
    }
    return this.state;
  }

  save() {
    this.state.entries = pruneEntries(this.state.entries, {
      nowMs: this.currentTimeMs(),
      retentionMs: this.retentionMs,
      maxEntries: this.maxEntries,
    });
    atomicWriteJson(this.filePath, this.state);
  }

  planOutbound(payload = {}) {
    this.load();
    const normalized = normalizeOutboundPayload(payload, this.currentTimeMs());
    if (normalized.requestedIdempotencyKey) {
      const existing = this.state.entries.find((entry) => (
        entry.talker === normalized.talker
        && entry.idempotencyKey === normalized.requestedIdempotencyKey
      ));
      if (existing) {
        assertIdempotencyPayloadMatches(existing, normalized);
        return cloneEntry(existing);
      }
    }

    const entry = createPlannedEntry(normalized);
    this.state.entries.push(entry);
    this.state.entries.sort(compareEntries);
    this.save();
    return cloneEntry(entry);
  }

  planAndClaimOutbound(payload = {}) {
    this.load();
    const nowMs = this.currentTimeMs();
    const normalized = normalizeOutboundPayload(payload, nowMs);
    let entry = normalized.requestedIdempotencyKey
      ? this.state.entries.find((candidate) => (
        candidate.talker === normalized.talker
        && candidate.idempotencyKey === normalized.requestedIdempotencyKey
      ))
      : null;

    if (entry) {
      assertIdempotencyPayloadMatches(entry, normalized);
      if (entry.status !== "planned" && entry.status !== "failed") {
        return { entry: cloneEntry(entry), claimed: false };
      }
    } else {
      entry = createPlannedEntry(normalized);
      this.state.entries.push(entry);
      this.state.entries.sort(compareEntries);
    }

    const at = toIsoTime(payload.sendingAt ?? payload.at, nowMs);
    entry.status = "sending";
    entry.sendingAt = at;
    entry.updatedAt = at;
    entry.attemptCount += 1;
    entry.uncertain = false;
    entry.failureCode = "";
    entry.failureHash = "";
    this.save();
    return { entry: cloneEntry(entry), claimed: true };
  }

  markSending(reference, details = {}) {
    this.load();
    const update = mergeReferenceDetails(reference, details);
    const entry = this.findEntry(reference);
    if (!entry) {
      return null;
    }
    if (entry.status === "verified") {
      return cloneEntry(entry);
    }
    const at = toIsoTime(update.sendingAt ?? update.at, this.currentTimeMs());
    entry.status = "sending";
    entry.sendingAt = at;
    entry.updatedAt = at;
    entry.attemptCount += 1;
    entry.uncertain = false;
    entry.failureCode = "";
    entry.failureHash = "";
    this.save();
    return cloneEntry(entry);
  }

  markVerified(reference, details = {}) {
    this.load();
    const update = mergeReferenceDetails(reference, details);
    const entry = this.findEntry(reference);
    if (!entry) {
      return null;
    }
    const at = toIsoTime(
      update.verifiedAt ?? update.observedAt ?? update.at,
      this.currentTimeMs(),
    );
    const localId = firstValidLocalId(update.localId, update.messageId);
    entry.status = "verified";
    if (localId) {
      entry.localId = localId;
    }
    entry.verifiedAt = entry.verifiedAt || at;
    entry.observedAt = normalizeOptionalIsoTime(update.observedAt, this.currentTimeMs()) || entry.observedAt;
    entry.updatedAt = at;
    entry.uncertain = false;
    entry.failureCode = "";
    entry.failureHash = "";
    this.save();
    return cloneEntry(entry);
  }

  markFailed(reference, details = {}) {
    this.load();
    const update = mergeReferenceDetails(reference, details);
    const entry = this.findEntry(reference);
    if (!entry) {
      return null;
    }
    if (entry.status === "verified") {
      return cloneEntry(entry);
    }
    const uncertain = update.uncertain !== false;
    const at = toIsoTime(update.failedAt ?? update.at, this.currentTimeMs());
    entry.status = uncertain ? "failed_uncertain" : "failed";
    entry.failedAt = at;
    entry.updatedAt = at;
    entry.uncertain = uncertain;
    entry.failureCode = normalizeFailureCode(update);
    entry.failureHash = hashFailure(update.error ?? update.lastError ?? update.message);
    this.save();
    return cloneEntry(entry);
  }

  classifyObservedOutgoing(observed = {}) {
    this.load();
    const talker = normalizeTalker(resolveTalker(observed));
    const observedDirection = normalizeExpectedDirection(observed.direction);
    const localId = firstValidLocalId(observed.localId, observed.messageId);
    const observedAtMs = parseTimeMs(
      observed.observedAt ?? observed.createTime ?? observed.createdAt,
      this.currentTimeMs(),
    );
    const normalizedContent = normalizeWeFlowMessageContent(observed.text ?? observed.content);
    const contentHash = normalizedContent ? hashNormalizedContent(normalizedContent) : "";
    const explicitContentKind = normalizeContentKind(observed.contentKind ?? observed.kind);
    const observedContentKind = explicitContentKind
      || inferContentKindFromContent(normalizedContent);

    if (!talker) {
      return classification("self_manual");
    }

    if (localId) {
      const exact = this.state.entries.find((entry) => (
        entry.talker === talker
        && entry.localId === localId
        && entryMatchesDirection(entry, observedDirection)
      ));
      if (exact && entryMatchesObservedContent(exact, {
        contentHash,
        observedContentKind,
      }) && entryMatchesObservationTime(
        exact,
        observedAtMs,
        this.retentionMs,
      )) {
        this.verifyObservedEntry(exact, { localId, observedAtMs });
        return classification("cyberboss", exact, "local_id");
      }
      if (exact) {
        // A stable local id is stronger than every heuristic. If its content,
        // kind, or time is incompatible, do not let that same observation fall
        // through and consume an unrelated pending image FIFO row.
        return classification("self_manual");
      }
    }

    if (observedContentKind === "image") {
      const candidate = this.state.entries
        .filter((entry) => (
          entry.talker === talker
          && entry.contentKind === "image"
          && entryMatchesDirection(entry, observedDirection)
          && MATCHABLE_STATUSES.has(entry.status)
          && (!localId || !entry.localId || entry.localId === localId)
          && entryMatchesObservationTime(
            entry,
            observedAtMs,
            resolveEntryMatchWindowMs(entry, {
              matchWindowMs: this.matchWindowMs,
              uncertainMatchWindowMs: this.uncertainMatchWindowMs,
              nativeMatchWindowMs: this.retentionMs,
            }),
          )
        ))
        .sort(compareEntries)[0];
      if (!candidate) {
        return classification("self_manual");
      }
      this.verifyObservedEntry(candidate, { localId, observedAtMs });
      return classification("cyberboss", candidate, "content_kind_fifo");
    }

    if (!normalizedContent) {
      return classification("self_manual");
    }
    const fallbackContentKind = observedContentKind || "text";
    const candidate = this.state.entries
      .filter((entry) => {
        if (entry.talker !== talker
          || entry.contentHash !== contentHash
          || entry.contentKind !== fallbackContentKind
          || !entryMatchesDirection(entry, observedDirection)
          || !MATCHABLE_STATUSES.has(entry.status)) {
          return false;
        }
        if (localId && entry.localId && entry.localId !== localId) {
          return false;
        }
        return entryMatchesObservationTime(
          entry,
          observedAtMs,
          resolveEntryMatchWindowMs(entry, {
            matchWindowMs: this.matchWindowMs,
            uncertainMatchWindowMs: this.uncertainMatchWindowMs,
            nativeMatchWindowMs: this.retentionMs,
          }),
        );
      })
      .sort(compareEntries)[0];

    if (!candidate) {
      return classification("self_manual");
    }
    this.verifyObservedEntry(candidate, { localId, observedAtMs });
    return classification("cyberboss", candidate, "content_hash_fifo");
  }

  findEntry(reference) {
    const query = typeof reference === "string" ? { id: reference } : (reference || {});
    const id = normalizeOpaque(query.id ?? query.entryId);
    if (id) {
      const byId = this.state.entries.find((entry) => entry.id === id);
      if (byId) {
        return byId;
      }
    }
    const talker = normalizeTalker(resolveTalker(query));
    const localId = firstValidLocalId(query.localId, query.messageId);
    if (talker && localId) {
      const byLocalId = this.state.entries.find((entry) => (
        entry.talker === talker && entry.localId === localId
      ));
      if (byLocalId) {
        return byLocalId;
      }
    }
    const idempotencyKey = normalizeOpaque(query.idempotencyKey);
    return idempotencyKey
      ? this.state.entries.find((entry) => (
        (!talker || entry.talker === talker) && entry.idempotencyKey === idempotencyKey
      )) || null
      : null;
  }

  verifyObservedEntry(entry, { localId, observedAtMs }) {
    const observedAt = new Date(observedAtMs).toISOString();
    entry.status = "verified";
    if (localId) {
      entry.localId = localId;
    }
    entry.verifiedAt = entry.verifiedAt || observedAt;
    entry.observedAt = observedAt;
    entry.updatedAt = observedAt;
    entry.uncertain = false;
    entry.failureCode = "";
    entry.failureHash = "";
    this.save();
  }

  recoverCorruptFile() {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    const backupPath = `${this.filePath}.corrupt-${this.currentTimeMs()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    try {
      fs.renameSync(this.filePath, backupPath);
    } catch {
      // The following atomic save still replaces the unreadable primary file.
    }
  }

  currentTimeMs() {
    return parseTimeMs(this.now(), Date.now());
  }
}

function classification(origin, entry = null, matchedBy = "") {
  const isCyberboss = origin === "cyberboss";
  return {
    origin,
    classification: origin,
    isCyberboss,
    matched: Boolean(entry),
    matchedBy,
    entry: entry ? cloneEntry(entry) : null,
  };
}

function normalizeLedgerEntry(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const id = normalizeOpaque(raw.id);
  const talker = normalizeTalker(resolveTalker(raw));
  const contentHash = normalizeOpaque(raw.contentHash).toLowerCase();
  const createdAt = normalizeOptionalIsoTime(raw.createdAt);
  let status = normalizeOpaque(raw.status);
  const messageKind = normalizeOpaque(raw.messageKind);
  const contentKind = normalizeContentKind(raw.contentKind)
    || inferLegacyContentKind(raw);
  if (status === "failed" && raw.uncertain === true) {
    status = "failed_uncertain";
  }
  if (!id || !talker || !/^[a-f0-9]{64}$/.test(contentHash) || !createdAt || !VALID_STATUSES.has(status)) {
    return null;
  }
  return {
    id,
    idempotencyKey: normalizeOpaque(raw.idempotencyKey) || id,
    talker,
    contentHash,
    contentKind,
    imageDigest: contentKind === "image" ? normalizeImageDigest(raw.imageDigest) : "",
    messageKind,
    expectedDirection: normalizeExpectedDirection(raw.expectedDirection)
      || inferLegacyExpectedDirection(messageKind),
    status,
    localId: normalizeLocalId(raw.localId),
    attemptCount: normalizeNonNegativeInteger(raw.attemptCount),
    uncertain: status === "failed_uncertain",
    createdAt,
    updatedAt: normalizeOptionalIsoTime(raw.updatedAt) || createdAt,
    sendingAt: normalizeOptionalIsoTime(raw.sendingAt),
    verifiedAt: normalizeOptionalIsoTime(raw.verifiedAt),
    failedAt: normalizeOptionalIsoTime(raw.failedAt),
    observedAt: normalizeOptionalIsoTime(raw.observedAt),
    failureCode: normalizeOpaque(raw.failureCode).slice(0, 80),
    failureHash: /^[a-f0-9]{64}$/.test(normalizeOpaque(raw.failureHash).toLowerCase())
      ? normalizeOpaque(raw.failureHash).toLowerCase()
      : "",
  };
}

function pruneEntries(entries, { nowMs, retentionMs, maxEntries }) {
  const cutoffMs = nowMs - retentionMs;
  const retained = entries
    .map(normalizeLedgerEntry)
    .filter((entry) => entry && Date.parse(entry.createdAt) >= cutoffMs)
    .sort(compareEntries);
  return retained.length > maxEntries ? retained.slice(retained.length - maxEntries) : retained;
}

function compareEntries(left, right) {
  const timeDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return timeDifference || left.id.localeCompare(right.id);
}

function normalizeOutboundPayload(payload, nowMs) {
  const talker = normalizeTalker(resolveTalker(payload));
  const normalizedContent = normalizeWeFlowMessageContent(payload.text ?? payload.content);
  if (!talker || !normalizedContent) {
    throw new Error("outbound talker and text are required");
  }
  const contentKind = resolveContentKind(payload, normalizedContent);
  const id = normalizeOpaque(payload.id) || crypto.randomUUID();
  const createdAt = toIsoTime(payload.plannedAt ?? payload.createdAt, nowMs);
  return {
    id,
    requestedIdempotencyKey: normalizeOpaque(payload.idempotencyKey),
    talker,
    contentHash: hashNormalizedContent(normalizedContent),
    contentKind,
    imageDigest: contentKind === "image" ? normalizeImageDigest(payload.imageDigest) : "",
    messageKind: normalizeOpaque(payload.messageKind),
    expectedDirection: normalizeExpectedDirection(payload.expectedDirection) || "outgoing",
    createdAt,
  };
}

function createPlannedEntry(normalized) {
  return {
    id: normalized.id,
    idempotencyKey: normalized.requestedIdempotencyKey || normalized.id,
    talker: normalized.talker,
    contentHash: normalized.contentHash,
    contentKind: normalized.contentKind,
    imageDigest: normalized.imageDigest,
    messageKind: normalized.messageKind,
    expectedDirection: normalized.expectedDirection,
    status: "planned",
    localId: "",
    attemptCount: 0,
    uncertain: false,
    createdAt: normalized.createdAt,
    updatedAt: normalized.createdAt,
    sendingAt: "",
    verifiedAt: "",
    failedAt: "",
    observedAt: "",
    failureCode: "",
    failureHash: "",
  };
}

function assertIdempotencyPayloadMatches(existing, normalized) {
  const mismatchedFields = [
    "contentHash",
    "contentKind",
    "imageDigest",
    "expectedDirection",
    "messageKind",
  ].filter((field) => existing[field] !== normalized[field]);
  if (mismatchedFields.length === 0) {
    return;
  }
  const error = new Error(
    `idempotency key reuse does not match the original outbound payload (${mismatchedFields.join(", ")})`,
  );
  error.code = "IDEMPOTENCY_KEY_REUSE_MISMATCH";
  error.mismatchedFields = mismatchedFields;
  throw error;
}

function resolveTalker(value) {
  return value?.talker ?? value?.talkerId ?? value?.chatId ?? value?.weflowInboxChat;
}

function normalizeTalker(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

function resolveContentKind(payload, normalizedContent) {
  return normalizeContentKind(payload?.contentKind ?? payload?.kind)
    || inferContentKindFromContent(normalizedContent)
    || "text";
}

function normalizeContentKind(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .slice(0, 40);
}

function inferContentKindFromContent(normalizedContent) {
  return normalizedContent ? "text" : "";
}

function inferLegacyContentKind(raw) {
  return normalizeContentKind(raw?.kind)
    || (normalizeImageDigest(raw?.imageDigest) ? "image" : "")
    || "text";
}

function normalizeImageDigest(value) {
  return normalizeOpaque(value)
    .normalize("NFKC")
    .toLowerCase()
    .slice(0, 256);
}

function entryMatchesObservedContent(entry, { contentHash = "", observedContentKind = "" } = {}) {
  if (observedContentKind && entry.contentKind !== observedContentKind) {
    return false;
  }
  if (entry.contentKind === "image") {
    // WeFlow image rows may expose `[图片]`, another placeholder, or no text at
    // all. A stable local id plus talker/direction/kind remains authoritative.
    return !observedContentKind || observedContentKind === "image";
  }
  return !contentHash || entry.contentHash === contentHash;
}

function normalizeWeFlowMessageContent(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/gu, " ")
    .trim();
}

function hashWeFlowMessageContent(value) {
  const normalized = normalizeWeFlowMessageContent(value);
  return normalized ? hashNormalizedContent(normalized) : "";
}

function hashNormalizedContent(normalized) {
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

function normalizeLocalId(value) {
  if (value === undefined || value === null) {
    return "";
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    return "";
  }
  try {
    const parsed = BigInt(text);
    return parsed > 0n ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function firstValidLocalId(...values) {
  for (const value of values) {
    const normalized = normalizeLocalId(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizeOpaque(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeExpectedDirection(value) {
  const normalized = normalizeOpaque(value).toLowerCase();
  return VALID_EXPECTED_DIRECTIONS.has(normalized) ? normalized : "";
}

function inferLegacyExpectedDirection(messageKind) {
  return normalizeOpaque(messageKind).toLowerCase().startsWith("native_")
    ? "incoming"
    : "outgoing";
}

function entryMatchesDirection(entry, observedDirection) {
  // Older direct callers did not supply a direction. The production inbox now
  // always does, while retaining this compatibility path for historical tools.
  return !observedDirection || entry.expectedDirection === observedDirection;
}

function normalizeFailureCode(details) {
  const error = details?.error;
  const value = details?.failureCode
    ?? details?.errorCode
    ?? details?.code
    ?? (error && typeof error === "object" ? error.code ?? error.name : "");
  return String(value ?? "").trim().slice(0, 80);
}

function hashFailure(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const material = value instanceof Error
    ? `${value.name}:${value.message}`
    : typeof value === "object"
      ? `${value.name || "Error"}:${value.message || value.code || ""}`
      : String(value);
  return material ? crypto.createHash("sha256").update(material, "utf8").digest("hex") : "";
}

function mergeReferenceDetails(reference, details) {
  return typeof reference === "object" && reference
    ? { ...reference, ...(details || {}) }
    : (details || {});
}

function entryReferenceTimeMs(entry) {
  // An uncertain failure is recorded after the bridge verification timeout,
  // while the observed WeFlow row still carries the original send time.
  return Date.parse(entry.sendingAt || entry.createdAt) || 0;
}

function entryMatchesObservationTime(entry, observedAtMs, matchWindowMs) {
  const referenceMs = entryReferenceTimeMs(entry);
  const ageMs = observedAtMs - referenceMs;
  return ageMs >= -5_000 && ageMs <= matchWindowMs;
}

function resolveEntryMatchWindowMs(entry, {
  matchWindowMs,
  uncertainMatchWindowMs,
  nativeMatchWindowMs,
}) {
  // Native bot replies are observed by WeFlow in the opposite (incoming)
  // direction, which separates them from same-account manual outgoing input;
  // keeping them for the full ledger retention period is therefore low-risk.
  if (entry.expectedDirection === "incoming") {
    return nativeMatchWindowMs;
  }
  // A UIA transport/verification timeout may still have pressed Enter, and the
  // strict confirmation policy can take minutes before it does - so the echo row
  // is routinely observed well after the 2-minute normal window. Every outgoing
  // entry that is still unverified therefore gets the bounded catch-up window;
  // an already verified entry is excluded by MATCHABLE_STATUSES, so this cannot
  // eat a later human message except in the narrow "never observed + identical
  // outgoing text" case the uncertain window already accepts.
  return uncertainMatchWindowMs;
}

function parseTimeMs(value, fallbackMs) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : fallbackMs;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // WeFlow createTime is commonly expressed in Unix seconds.
    return value > 0 && value < 100_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return parseTimeMs(numeric, fallbackMs);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallbackMs;
}

function toIsoTime(value, fallbackMs) {
  return new Date(parseTimeMs(value, fallbackMs)).toISOString();
}

function normalizeOptionalIsoTime(value, fallbackMs = NaN) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const parsed = parseTimeMs(value, fallbackMs);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function emptyState() {
  return { version: LEDGER_VERSION, entries: [] };
}

function cloneEntry(entry) {
  return { ...entry };
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

module.exports = {
  DEFAULT_MATCH_WINDOW_MS,
  DEFAULT_UNCERTAIN_MATCH_WINDOW_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_RETENTION_MS,
  WeFlowMessageLedgerStore,
  hashWeFlowMessageContent,
  normalizeWeFlowMessageContent,
};
