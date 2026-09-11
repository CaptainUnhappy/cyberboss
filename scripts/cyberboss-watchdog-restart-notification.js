#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { WeFlowMessageLedgerStore } = require("../src/integrations/weflow-message-ledger-store");
const { sendWeFlowUiaText } = require("../src/integrations/weflow-outbound");

const STATE_VERSION = 1;
const MESSAGE_KIND = "watchdog_restart_notification";
const MAX_NOTIFICATIONS = 256;
const VERIFIED_STATUSES = new Set(["verified"]);
const UNCERTAIN_LEDGER_STATUSES = new Set(["sending", "failed_uncertain"]);
const ACTIVE_STATUSES = new Set(["pending", "uncertain_pending"]);
const TERMINAL_STATUSES = new Set(["verified", "cancelled"]);
const VALID_NOTIFICATION_STATUSES = new Set([
  "awaiting_repair_verification",
  ...ACTIVE_STATUSES,
  ...TERMINAL_STATUSES,
]);

function buildRestartNotificationIdempotencyKey(repairIdentity) {
  const identity = normalizeText(repairIdentity);
  if (!identity) throw new Error("restart notification repairIdentity is required");
  return `watchdog-restart:${identity}`;
}

function createRestartNotification(options = {}, nowMs = Date.now()) {
  const repairIdentity = normalizeText(options.repairIdentity);
  const targetTalker = normalizeText(options.primaryTalker);
  const targetContact = normalizeText(options.primaryContact);
  const canaryTalker = normalizeText(options.canaryTalker);
  const text = normalizeText(options.text);
  assertTargetIsolation({ targetTalker, targetContact, canaryTalker });
  if (!repairIdentity) throw new Error("restart notification repairIdentity is required");
  if (!text) throw new Error("restart notification text is required");
  const createdAt = toIsoTime(options.createdAt, nowMs);
  return {
    id: buildRestartNotificationIdempotencyKey(repairIdentity),
    repairIdentity,
    repairMode: normalizeText(options.repairMode),
    components: normalizeComponents(options.components),
    targetTalker,
    targetContact,
    canaryTalker,
    text,
    contentHash: hashText(text),
    messageKind: MESSAGE_KIND,
    idempotencyKey: buildRestartNotificationIdempotencyKey(repairIdentity),
    status: "awaiting_repair_verification",
    attemptCount: 0,
    localId: "",
    createdAt,
    updatedAt: createdAt,
    activatedAt: "",
    lastAttemptAt: "",
    verifiedAt: "",
    cancelledAt: "",
    cancelReason: "",
    lastError: "",
  };
}

function readRestartNotificationState(filePath) {
  const resolved = path.resolve(filePath);
  const backup = `${resolved}.bak`;
  if (!fs.existsSync(resolved) && !fs.existsSync(backup)) return emptyState();
  const errors = [];
  for (const candidate of [resolved, backup]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return parseRestartNotificationStatePayload(fs.readFileSync(candidate, "utf8"));
    } catch (error) {
      errors.push(`${candidate === resolved ? "primary" : "backup"}=${error.message}`);
    }
  }
  throw new Error(`restart notification state is unreadable: ${errors.join("; ")}`);
}

function parseRestartNotificationStatePayload(rawText) {
  const parsed = JSON.parse(rawText);
  if (!parsed || Number(parsed.version) !== STATE_VERSION || !Array.isArray(parsed.notifications)) {
    throw new Error("restart notification state schema is invalid");
  }
  const notifications = parsed.notifications.map(normalizePersistedNotification);
  if (notifications.some((entry) => !entry)) {
    throw new Error("restart notification state contains an invalid obligation");
  }
  return { version: STATE_VERSION, notifications: pruneRestartNotifications(notifications) };
}

function writeRestartNotificationState(filePath, state) {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });
  const rawNotifications = Array.isArray(state?.notifications) ? state.notifications : [];
  const notifications = rawNotifications.map(normalizePersistedNotification);
  if (notifications.some((entry) => !entry)) {
    throw new Error("restart notification state contains an invalid obligation");
  }
  const normalized = {
    version: STATE_VERSION,
    notifications: pruneRestartNotifications(notifications),
  };
  const temporary = `${resolved}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    // Parse the completed and flushed temporary before replacing the durable primary.
    JSON.parse(fs.readFileSync(temporary, "utf8"));
    replaceRestartNotificationStateFile(temporary, resolved);
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  return normalized;
}

function replaceRestartNotificationStateFile(temporary, resolved) {
  if (!fs.existsSync(resolved)) {
    fs.renameSync(temporary, resolved);
    return;
  }

  // Keep a flushed last-known-good copy before attempting replacement. On
  // Windows an antivirus/indexer can make rename-over-existing fail. Never
  // delete the only primary file as a workaround; move it aside and restore it
  // if publishing the new primary fails.
  const backup = `${resolved}.bak`;
  fs.copyFileSync(resolved, backup);
  fsyncFile(backup);
  try {
    fs.renameSync(temporary, resolved);
    return;
  } catch (initialError) {
    const previous = `${resolved}.${process.pid}.${Math.random().toString(16).slice(2)}.previous`;
    fs.renameSync(resolved, previous);
    try {
      fs.renameSync(temporary, resolved);
    } catch (publishError) {
      try {
        if (!fs.existsSync(resolved) && fs.existsSync(previous)) {
          fs.renameSync(previous, resolved);
        }
      } catch {}
      const error = new Error(`restart notification state replacement failed: ${publishError.message}`);
      error.cause = initialError;
      throw error;
    }
    try { fs.rmSync(previous, { force: true }); } catch {}
  }
}

function fsyncFile(filePath) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, "r+");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function fsyncDirectory(directoryPath) {
  if (process.platform === "win32") return;
  let descriptor = null;
  try {
    descriptor = fs.openSync(directoryPath, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some filesystems do not expose directory fsync. File data is still
    // flushed and the previous primary remains available as .bak.
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function ensureRestartNotification(options = {}, deps = {}) {
  validateDispatchOptions(options);
  const nowMs = resolveNowMs(deps.now);
  const stateFile = resolveStateFile(options);
  const state = readRestartNotificationState(stateFile);
  const candidate = createRestartNotification(options, nowMs);
  const existing = state.notifications.find((entry) => entry.repairIdentity === candidate.repairIdentity);
  if (existing) {
    assertSameObligation(existing, candidate);
    return { state, notification: existing, created: false, stateFile };
  }
  state.notifications.push(candidate);
  writeRestartNotificationState(stateFile, state);
  return { state, notification: candidate, created: true, stateFile };
}

function activateRestartNotification(options = {}, deps = {}) {
  const nowMs = resolveNowMs(deps.now);
  const loaded = loadPersistedRestartNotification(options, { validateCurrentTarget: true });
  const { state, stateFile } = loaded;
  let { notification } = loaded;
  if (notification.status === "verified" && isPositiveLocalId(notification.localId)) {
    return resultFor(notification, "already_verified", true);
  }
  if (notification.status === "cancelled") {
    return resultFor(notification, "cancelled", false);
  }
  if (ACTIVE_STATUSES.has(notification.status)) {
    return resultFor(notification, "already_activated", false);
  }
  if (notification.status !== "awaiting_repair_verification") {
    throw new Error(`restart notification cannot be activated from status ${notification.status}`);
  }
  const activatedAt = new Date(nowMs).toISOString();
  notification = updateNotification(state, notification.repairIdentity, {
    status: "pending",
    activatedAt,
    updatedAt: activatedAt,
    lastError: "",
  });
  writeRestartNotificationState(stateFile, state);
  return resultFor(notification, "activated", false);
}

function cancelRestartNotification(options = {}, deps = {}) {
  const nowMs = resolveNowMs(deps.now);
  const loaded = loadPersistedRestartNotification(options);
  const { state, stateFile } = loaded;
  let { notification } = loaded;
  if (notification.status === "verified" && isPositiveLocalId(notification.localId)) {
    return resultFor(notification, "already_verified", true);
  }
  if (notification.status === "cancelled") {
    return resultFor(notification, "already_cancelled", false);
  }
  const cancelledAt = new Date(nowMs).toISOString();
  notification = updateNotification(state, notification.repairIdentity, {
    status: "cancelled",
    cancelledAt,
    cancelReason: normalizeText(options.cancelReason || options.reason) || "repair_not_verified",
    updatedAt: cancelledAt,
    lastError: "",
  });
  writeRestartNotificationState(stateFile, state);
  return resultFor(notification, "cancelled", false);
}

async function dispatchRestartNotification(options = {}, deps = {}) {
  const stateFile = resolveStateFile(options);
  const ledgerFile = resolveLedgerFile(options);
  const now = deps.now;
  const nowMs = resolveNowMs(now);
  const loaded = loadPersistedRestartNotification(options, { validateCurrentTarget: true });
  let { state, notification } = loaded;

  if (notification.status === "verified" && isPositiveLocalId(notification.localId)) {
    return resultFor(notification, "already_verified", true);
  }
  if (notification.status === "awaiting_repair_verification") {
    return resultFor(notification, "awaiting_repair_verification", false);
  }
  if (notification.status === "cancelled") {
    return resultFor(notification, "cancelled", false);
  }
  if (!ACTIVE_STATUSES.has(notification.status)) {
    throw new Error(`restart notification is not activated: ${notification.status}`);
  }

  const ledger = deps.messageLedger || new WeFlowMessageLedgerStore({
    filePath: ledgerFile,
    ...(typeof now === "function" ? { now } : {}),
  });
  const ledgerEntry = ledger.findEntry({
    talker: notification.targetTalker,
    idempotencyKey: notification.idempotencyKey,
  });
  if (ledgerEntry?.status === "verified" && isPositiveLocalId(ledgerEntry.localId)) {
    notification = updateNotification(state, notification.repairIdentity, {
      status: "verified",
      localId: String(ledgerEntry.localId),
      verifiedAt: normalizeIsoTime(ledgerEntry.verifiedAt) || new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      lastError: "",
    });
    writeRestartNotificationState(stateFile, state);
    return resultFor(notification, "already_verified", true);
  }
  if (UNCERTAIN_LEDGER_STATUSES.has(normalizeText(ledgerEntry?.status).toLowerCase())
      || (VERIFIED_STATUSES.has(normalizeText(ledgerEntry?.status).toLowerCase())
        && !isPositiveLocalId(ledgerEntry?.localId))
      || notification.status === "uncertain_pending") {
    notification = updateNotification(state, notification.repairIdentity, {
      status: "uncertain_pending",
      updatedAt: new Date(nowMs).toISOString(),
      lastError: notification.lastError || "delivery is awaiting a verified local id",
    });
    writeRestartNotificationState(stateFile, state);
    return resultFor(notification, "uncertain_pending", false);
  }

  // Persist the obligation and increment its attempt before anything can press
  // Enter. A watchdog/process crash can therefore never erase an in-flight send.
  notification = updateNotification(state, notification.repairIdentity, {
    status: "pending",
    attemptCount: notification.attemptCount + 1,
    lastAttemptAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    lastError: "",
  });
  writeRestartNotificationState(stateFile, state);

  try {
    const sendResult = await sendWeFlowUiaText({
      ...(options.config || {}),
      weflowInboxChat: notification.targetTalker,
      weflowInboxDisplayName: notification.targetContact,
    }, {
      text: notification.text,
      messageKind: notification.messageKind,
      idempotencyKey: notification.idempotencyKey,
      messageLedger: ledger,
      contact: notification.targetContact,
      talker: notification.targetTalker,
      exactContact: true,
      requireDesktopIdleSeconds: normalizeNonNegativeInteger(options.requireDesktopIdleSeconds),
    }, deps.fetchImpl || globalThis.fetch);

    const localId = normalizePositiveLocalId(sendResult?.localId);
    if (sendResult?.verified === true && localId) {
      // sendWeFlowUiaText updates the ledger first. Re-read it and require the
      // same verified receipt before clearing the independent durable obligation.
      const verifiedEntry = ledger.findEntry({
        talker: notification.targetTalker,
        idempotencyKey: notification.idempotencyKey,
      });
      if (verifiedEntry?.status === "verified"
          && normalizePositiveLocalId(verifiedEntry.localId) === localId) {
        notification = updateNotification(state, notification.repairIdentity, {
          status: "verified",
          localId,
          verifiedAt: new Date(nowMs).toISOString(),
          updatedAt: new Date(nowMs).toISOString(),
          lastError: "",
        });
        writeRestartNotificationState(stateFile, state);
        return resultFor(notification, "verified", true);
      }
    }

    const errorText = normalizeText(sendResult?.verificationError)
      || "restart notification dispatch is awaiting a verified local id";
    notification = updateNotification(state, notification.repairIdentity, {
      status: "uncertain_pending",
      updatedAt: new Date(nowMs).toISOString(),
      lastError: errorText,
    });
    writeRestartNotificationState(stateFile, state);
    return resultFor(notification, "uncertain_pending", false);
  } catch (error) {
    const uncertain = error?.deliveryUncertain !== false;
    notification = updateNotification(state, notification.repairIdentity, {
      status: uncertain ? "uncertain_pending" : "pending",
      updatedAt: new Date(nowMs).toISOString(),
      lastError: formatError(error),
    });
    writeRestartNotificationState(stateFile, state);
    return resultFor(notification, uncertain ? "uncertain_pending" : "retry_pending", false);
  }
}

async function dispatchPendingRestartNotifications(options = {}, deps = {}) {
  const stateFile = resolveStateFile(options);
  const state = readRestartNotificationState(stateFile);
  const results = [];
  for (const pending of state.notifications) {
    if (!ACTIVE_STATUSES.has(pending.status)) continue;
    try {
      // The persisted target is the immutable payload, but the *current*
      // configuration must still name that same primary target and remain
      // isolated from the current canary target. Never overwrite current
      // configuration with values read from the obligation itself.
      results.push(await dispatchRestartNotification({
        ...options,
        repairIdentity: pending.repairIdentity,
      }, deps));
    } catch (error) {
      results.push({
        action: "configuration_blocked",
        verified: false,
        localId: "",
        idempotencyKey: pending.idempotencyKey,
        talker: pending.targetTalker,
        repairIdentity: pending.repairIdentity,
        attemptCount: pending.attemptCount,
        lastError: formatError(error),
      });
    }
  }
  return results;
}

function readLatestRestartNotificationStatus(options = {}) {
  const state = readRestartNotificationState(resolveStateFile(options));
  const latest = state.notifications[state.notifications.length - 1] || null;
  if (!latest) {
    return {
      action: "none",
      pendingCount: 0,
      awaitingRepairVerificationCount: 0,
      verified: false,
      localId: "",
    };
  }
  return {
    action: latest.status,
    pendingCount: state.notifications.filter((entry) => ACTIVE_STATUSES.has(entry.status)).length,
    awaitingRepairVerificationCount: state.notifications.filter(
      (entry) => entry.status === "awaiting_repair_verification",
    ).length,
    repairIdentity: latest.repairIdentity,
    repairMode: latest.repairMode,
    verified: latest.status === "verified" && isPositiveLocalId(latest.localId),
    localId: latest.localId,
    attemptCount: latest.attemptCount,
    lastAttemptAt: latest.lastAttemptAt,
    verifiedAt: latest.verifiedAt,
    activatedAt: latest.activatedAt,
    cancelledAt: latest.cancelledAt,
    cancelReason: latest.cancelReason,
    lastError: latest.lastError,
    targetTalker: latest.targetTalker,
  };
}

function loadPersistedRestartNotification(options = {}, { validateCurrentTarget = false } = {}) {
  const repairIdentity = normalizeText(options.repairIdentity);
  if (!repairIdentity) throw new Error("restart notification repairIdentity is required");
  const stateFile = resolveStateFile(options);
  const state = readRestartNotificationState(stateFile);
  const notification = state.notifications.find((entry) => entry.repairIdentity === repairIdentity);
  if (!notification) {
    throw new Error(`restart notification obligation was not enqueued: ${repairIdentity}`);
  }
  if (validateCurrentTarget) {
    assertCurrentTargetConfiguration(options, notification);
  }
  return { state, notification, stateFile };
}

function assertCurrentTargetConfiguration(options, notification) {
  const currentTalker = normalizeText(options.primaryTalker);
  const currentContact = normalizeText(options.primaryContact);
  const currentCanaryTalker = normalizeText(options.canaryTalker);
  assertTargetIsolation({
    targetTalker: currentTalker,
    targetContact: currentContact,
    canaryTalker: currentCanaryTalker,
  });
  if (currentTalker !== notification.targetTalker) {
    throw new Error("restart notification persisted primaryTalker differs from current primaryTalker");
  }
  if (currentContact !== notification.targetContact) {
    throw new Error("restart notification persisted primaryContact differs from current primaryContact");
  }
  if (currentCanaryTalker
      && notification.targetTalker.toLowerCase() === currentCanaryTalker.toLowerCase()) {
    throw new Error("restart notification persisted primaryTalker aliases the current canaryTalker");
  }
}

function validateDispatchOptions(options) {
  const primaryTalker = normalizeText(options.primaryTalker);
  const primaryContact = normalizeText(options.primaryContact);
  const canaryTalker = normalizeText(options.canaryTalker);
  assertTargetIsolation({ targetTalker: primaryTalker, targetContact: primaryContact, canaryTalker });
  if (!normalizeText(options.repairIdentity)) {
    throw new Error("restart notification repairIdentity is required");
  }
  if (!normalizeText(options.text)) {
    throw new Error("restart notification text is required");
  }
}

function assertTargetIsolation({ targetTalker, targetContact, canaryTalker }) {
  if (!targetTalker) throw new Error("restart notification primaryTalker is required");
  if (!targetContact) throw new Error("restart notification primaryContact is required");
  if (canaryTalker && targetTalker.toLowerCase() === canaryTalker.toLowerCase()) {
    throw new Error("restart notification primaryTalker must differ from canaryTalker");
  }
}

function assertSameObligation(existing, candidate) {
  for (const field of [
    "repairIdentity",
    "repairMode",
    "targetTalker",
    "targetContact",
    "canaryTalker",
    "text",
    "contentHash",
    "messageKind",
    "idempotencyKey",
  ]) {
    if (existing[field] !== candidate[field]) {
      throw new Error(`restart notification identity was reused with different ${field}`);
    }
  }
  if (JSON.stringify(existing.components) !== JSON.stringify(candidate.components)) {
    throw new Error("restart notification identity was reused with different components");
  }
}

function normalizePersistedNotification(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const repairIdentity = normalizeText(raw.repairIdentity);
  const targetTalker = normalizeText(raw.targetTalker);
  const targetContact = normalizeText(raw.targetContact);
  const text = normalizeText(raw.text);
  const contentHash = normalizeSha256(raw.contentHash);
  const messageKind = normalizeText(raw.messageKind);
  const idempotencyKey = normalizeText(raw.idempotencyKey);
  const status = normalizeText(raw.status).toLowerCase();
  if (!repairIdentity || !targetTalker || !targetContact || !text
      || contentHash !== hashText(text)
      || messageKind !== MESSAGE_KIND
      || idempotencyKey !== buildRestartNotificationIdempotencyKey(repairIdentity)
      || (normalizeText(raw.id) && normalizeText(raw.id) !== idempotencyKey)
      || !VALID_NOTIFICATION_STATUSES.has(status)) return null;
  try {
    assertTargetIsolation({
      targetTalker,
      targetContact,
      canaryTalker: normalizeText(raw.canaryTalker),
    });
  } catch {
    return null;
  }
  const localId = normalizePositiveLocalId(raw.localId);
  // Keep an incomplete receipt active rather than losing the duty. The ledger
  // still suppresses another send until an observed positive local id arrives.
  const normalizedStatus = status === "verified" && !localId ? "uncertain_pending" : status;
  return {
    id: normalizeText(raw.id) || idempotencyKey,
    repairIdentity,
    repairMode: normalizeText(raw.repairMode),
    components: normalizeComponents(raw.components),
    targetTalker,
    targetContact,
    canaryTalker: normalizeText(raw.canaryTalker),
    text,
    contentHash,
    messageKind,
    idempotencyKey,
    status: normalizedStatus,
    attemptCount: normalizeNonNegativeInteger(raw.attemptCount),
    localId,
    createdAt: normalizeIsoTime(raw.createdAt) || new Date(0).toISOString(),
    updatedAt: normalizeIsoTime(raw.updatedAt) || new Date(0).toISOString(),
    activatedAt: normalizeIsoTime(raw.activatedAt),
    lastAttemptAt: normalizeIsoTime(raw.lastAttemptAt),
    verifiedAt: normalizeIsoTime(raw.verifiedAt),
    cancelledAt: normalizeIsoTime(raw.cancelledAt),
    cancelReason: normalizeText(raw.cancelReason),
    lastError: normalizeText(raw.lastError),
  };
}

function updateNotification(state, repairIdentity, patch) {
  const index = state.notifications.findIndex((entry) => entry.repairIdentity === repairIdentity);
  if (index < 0) throw new Error(`restart notification obligation disappeared: ${repairIdentity}`);
  state.notifications[index] = { ...state.notifications[index], ...patch };
  return state.notifications[index];
}

function resultFor(notification, action, verified) {
  return {
    action,
    verified: Boolean(verified),
    localId: normalizePositiveLocalId(notification.localId),
    idempotencyKey: notification.idempotencyKey,
    talker: notification.targetTalker,
    repairIdentity: notification.repairIdentity,
    attemptCount: notification.attemptCount,
    lastError: notification.lastError,
  };
}

function emptyState() {
  return { version: STATE_VERSION, notifications: [] };
}

function resolveStateFile(options) {
  return path.resolve(normalizeText(options.stateFile)
    || path.join(normalizeText(options.stateDir) || path.join(os.homedir(), ".cyberboss"), "cyberboss-watchdog-restart-notifications.json"));
}

function resolveLedgerFile(options) {
  return path.resolve(normalizeText(options.ledgerFile)
    || path.join(normalizeText(options.stateDir) || path.join(os.homedir(), ".cyberboss"), "weflow-message-ledger.json"));
}

function resolveNowMs(now) {
  const value = typeof now === "function" ? now() : Date.now();
  const numeric = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function toIsoTime(value, fallbackMs) {
  return normalizeIsoTime(value) || new Date(fallbackMs).toISOString();
}

function normalizeIsoTime(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeComponents(value) {
  const source = Array.isArray(value) ? value : normalizeText(value).split(",");
  return [...new Set(source.map((item) => normalizeText(String(item))).filter(Boolean))];
}

function pruneRestartNotifications(notifications) {
  const source = Array.isArray(notifications) ? notifications : [];
  if (source.length <= MAX_NOTIFICATIONS) return source;
  const nonTerminalCount = source.reduce(
    (count, entry) => count + (TERMINAL_STATUSES.has(entry.status) ? 0 : 1),
    0,
  );
  const terminalBudget = Math.max(0, MAX_NOTIFICATIONS - nonTerminalCount);
  const retainedTerminalIndexes = new Set();
  for (let index = source.length - 1; index >= 0 && retainedTerminalIndexes.size < terminalBudget; index -= 1) {
    if (TERMINAL_STATUSES.has(source[index].status)) {
      retainedTerminalIndexes.add(index);
    }
  }
  return source.filter((entry, index) => (
    !TERMINAL_STATUSES.has(entry.status) || retainedTerminalIndexes.has(index)
  ));
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizeSha256(value) {
  const normalized = normalizeText(value).toLowerCase();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : "";
}

function normalizeNonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function normalizePositiveLocalId(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/u.test(text)) return "";
  try { return BigInt(text) > 0n ? text : ""; } catch { return ""; }
}

function isPositiveLocalId(value) {
  return Boolean(normalizePositiveLocalId(value));
}

function formatError(error) {
  return normalizeText(error instanceof Error ? error.message : String(error || "unknown error"));
}

function parseArgs(argv) {
  const result = { action: "dispatch", requestFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--action") result.action = String(argv[++index] || "").trim();
    else if (token === "--request-file") result.requestFile = String(argv[++index] || "").trim();
  }
  return result;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const request = args.requestFile
    ? JSON.parse(fs.readFileSync(path.resolve(args.requestFile), "utf8"))
    : {};
  let result;
  if (args.action === "enqueue") {
    const ensured = ensureRestartNotification(request);
    result = resultFor(ensured.notification, ensured.created ? "enqueued" : "already_enqueued", false);
  } else if (args.action === "activate") {
    result = activateRestartNotification(request);
  } else if (args.action === "cancel") {
    result = cancelRestartNotification(request);
  } else if (args.action === "drain") {
    result = await dispatchPendingRestartNotifications(request);
  } else if (args.action === "status") {
    result = readLatestRestartNotificationStatus(request);
  } else if (args.action === "dispatch") {
    result = await dispatchRestartNotification(request);
  } else {
    throw new Error(`unsupported restart notification action: ${args.action}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stdout.write(`${JSON.stringify({ action: "error", verified: false, error: formatError(error) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  activateRestartNotification,
  buildRestartNotificationIdempotencyKey,
  cancelRestartNotification,
  createRestartNotification,
  dispatchPendingRestartNotifications,
  dispatchRestartNotification,
  ensureRestartNotification,
  readLatestRestartNotificationStatus,
  readRestartNotificationState,
  writeRestartNotificationState,
};
