const crypto = require("crypto");

const CONTROL_COMMANDS = new Set(["/bot", "/azzy", "/mode", "/状态"]);
const CONTROL_CONFIRMATIONS = new Set([
  "✅ 当前发信源：大号 ClawBot",
  "✅ 当前发信源：小号 UIA",
]);

function isWeFlowControlCommand(value) {
  return CONTROL_COMMANDS.has(normalizeText(value).toLowerCase());
}

function isWeFlowControlConfirmation(value) {
  return CONTROL_CONFIRMATIONS.has(normalizeText(value));
}

async function executeWeFlowControlCommand(
  config,
  { command = "", contact = "yourself", notify = false } = {},
  fetchImpl = globalThis.fetch
) {
  const normalizedCommand = normalizeText(command).toLowerCase();
  if (!CONTROL_COMMANDS.has(normalizedCommand)) {
    throw new Error(`unsupported WeFlow control command: ${normalizedCommand || "empty"}`);
  }
  const payload = await requestBridgeJson(config, "/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      command: normalizedCommand,
      contact: normalizeText(contact) || "yourself",
      notify: Boolean(notify),
    }),
  }, fetchImpl);
  const source = normalizeText(payload?.send_source).toLowerCase();
  if (payload?.ok !== true || (source !== "bot" && source !== "azzy")) {
    throw new Error("WeFlow bridge did not confirm the control command");
  }
  return {
    ...payload,
    send_source: source,
    label: normalizeText(payload?.label) || (source === "bot" ? "大号 ClawBot" : "小号 UIA"),
  };
}

function formatWeFlowControlConfirmation(result = {}) {
  const source = normalizeText(result?.send_source).toLowerCase();
  const label = normalizeText(result?.label)
    || (source === "bot" ? "大号 ClawBot" : source === "azzy" ? "小号 UIA" : "");
  if (!label) {
    throw new Error("WeFlow control result is missing a send source label");
  }
  return `✅ 当前发信源：${label}`;
}

async function resolveWeFlowSendSource(config, fetchImpl = globalThis.fetch) {
  const payload = await requestBridgeJson(config, "/api/send-source", {}, fetchImpl);
  const source = normalizeText(payload?.send_source).toLowerCase();
  if (source !== "bot" && source !== "azzy") {
    throw new Error(`unexpected WeFlow send source: ${source || "empty"}`);
  }
  return source;
}

async function sendWeFlowUiaText(
  config,
  {
    text = "",
    timeoutMs = 0,
    messageKind = "",
    idempotencyKey = "",
    messageLedger = null,
    contact: explicitContact = "",
    talker: explicitTalker = "",
    exactContact = false,
    requireDesktopIdleSeconds = 0,
    desktopInputLease = null,
  } = {},
  fetchImpl = globalThis.fetch
) {
  const contact = normalizeText(explicitContact) || normalizeText(config?.weflowInboxDisplayName);
  const talker = normalizeText(explicitTalker) || normalizeText(config?.weflowInboxChat);
  const content = String(text || "");
  if (!contact || !talker || !content.trim()) {
    throw new Error("WeFlow UIA send requires contact, talker, and text");
  }
  const verificationTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : resolveTimeoutMs(config);
  const resolvedIdempotencyKey = normalizeText(idempotencyKey);
  const requiredIdleSeconds = normalizePositiveInteger(requireDesktopIdleSeconds);
  const normalizedDesktopInputLease = normalizeDesktopInputLease(desktopInputLease);
  if (desktopInputLease !== null && desktopInputLease !== undefined) {
    const runId = normalizedDesktopInputLease?.runId || "";
    const expectedTargetFingerprint = crypto.createHash("sha256")
      .update(`${contact}\n${talker}`, "utf8")
      .digest("hex");
    if (!normalizedDesktopInputLease
      || exactContact !== true
      || requiredIdleSeconds !== 0
      || normalizedDesktopInputLease.targetFingerprint !== expectedTargetFingerprint
      || normalizeText(messageKind) !== `model_canary_reply:${runId}`
      || resolvedIdempotencyKey !== `model-canary-reply:${runId}`
      || normalizedDesktopInputLease.replyIdempotencyKey !== resolvedIdempotencyKey
      || content !== `[Cyberboss心跳模型正常 trigger=${runId}]`) {
      throw new Error("WeFlow UIA desktop input lease is not bound to an exact model canary reply");
    }
  }
  let operation = null;
  let ownsDeliveryClaim = false;
  let requestStarted = false;
  try {
    const ledgerClaim = await planAndClaimLedgerOperation(messageLedger, {
      talker,
      text: content,
      messageKind,
      expectedDirection: "outgoing",
      ...(resolvedIdempotencyKey ? { idempotencyKey: resolvedIdempotencyKey } : {}),
    });
    operation = ledgerClaim.entry;
    if (ledgerClaim.atomic) {
      if (!ledgerClaim.claimed) {
        const existingDelivery = describeExistingTextDelivery(operation);
        if (existingDelivery) {
          return existingDelivery;
        }
        throw invalidLedgerClaimError("text", operation);
      }
      ownsDeliveryClaim = Boolean(operation);
    } else {
      const existingDelivery = resolvedIdempotencyKey
        ? describeExistingTextDelivery(operation)
        : null;
      if (existingDelivery) {
        return existingDelivery;
      }
      if (operation) {
        await messageLedger.markSending(operation);
        ownsDeliveryClaim = true;
      }
    }
    requestStarted = true;
    const payload = await requestBridgeJson(config, "/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        contact,
        talker,
        text: content,
        timeout: Math.max(1, Math.ceil(verificationTimeoutMs / 1000)),
        ...(exactContact === true ? {
          exactContact: true,
          expectedContact: contact,
          expectedTalker: talker,
        } : {}),
        ...(requiredIdleSeconds ? { requireDesktopIdleSeconds: requiredIdleSeconds } : {}),
        ...(normalizedDesktopInputLease ? { desktopInputLease: normalizedDesktopInputLease } : {}),
      }),
    }, fetchImpl, { timeoutMs: verificationTimeoutMs + 15_000 });
    if (exactContact === true && (
      payload?.targetVerified !== true
      || normalizeText(payload?.selectedContact) !== contact
      || normalizeText(payload?.verifiedTalker) !== talker
    )) {
      const error = new Error("WeFlow UIA exact target was not confirmed");
      error.code = "TARGET_NOT_CONFIRMED";
      error.deliveryUncertain = payload?.dispatched === true;
      throw error;
    }
    const verifiedLocalId = normalizePositiveLocalId(payload?.localId);
    if (payload?.dispatched === true && (payload?.verified !== true || !verifiedLocalId)) {
      const verificationError = normalizeText(payload?.verificationError)
        || "WeFlow UIA dispatch was not observed with a stable local id";
      if (operation && ownsDeliveryClaim) {
        await Promise.resolve().then(() => messageLedger.markFailed(operation, {
          uncertain: true,
          error: verificationError,
        })).catch(() => {});
      }
      // UI Automation already pressed Enter. Treat this as delivered so the
      // stream layer does not retry and create a duplicate while WeFlow's read
      // API is still catching up.
      return {
        ...payload,
        verified: false,
        uncertain: true,
        verificationError,
      };
    }
    if (payload?.dispatched !== true) {
      const error = new Error("WeFlow UIA send was not verified");
      error.deliveryUncertain = false;
      throw error;
    }
    if (operation && ownsDeliveryClaim) {
      try {
        await messageLedger.markVerified(operation, { localId: verifiedLocalId });
      } catch (error) {
        // The UI action is already verified. Keep the previous planned/sending
        // row as a content-hash safety net and never invite a duplicate retry
        // merely because the verification update could not be persisted.
        await Promise.resolve().then(() => messageLedger.markFailed(operation, {
          uncertain: true,
          error: error instanceof Error ? error.message : String(error),
        })).catch(() => {});
        return { ...payload, ledgerUncertain: true };
      }
    }
    return payload;
  } catch (error) {
    if (error && typeof error === "object" && error.deliveryUncertain == null) {
      error.deliveryUncertain = requestStarted;
    }
    if (operation && ownsDeliveryClaim) {
      await Promise.resolve().then(() => messageLedger.markFailed(operation, {
        uncertain: requestStarted && error?.deliveryUncertain !== false,
        error: error instanceof Error ? error.message : String(error),
      })).catch(() => {});
    }
    throw error;
  }
}

function normalizeDesktopInputLease(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const normalized = {
    version: Number(raw.version),
    mode: normalizeText(raw.mode),
    runId: normalizeText(raw.runId).toLowerCase(),
    nonce: normalizeText(raw.nonce).toLowerCase(),
    targetFingerprint: normalizeText(raw.targetFingerprint).toLowerCase(),
    replyIdempotencyKey: normalizeText(raw.replyIdempotencyKey),
    expiresAt: normalizeText(raw.expiresAt),
    token: normalizeText(raw.token).toLowerCase(),
  };
  if (normalized.version !== 1
    || normalized.mode !== "model_e2e"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(normalized.runId)
    || !/^[a-f0-9]{24}$/u.test(normalized.nonce)
    || !/^[a-f0-9]{64}$/u.test(normalized.targetFingerprint)
    || normalized.replyIdempotencyKey !== `model-canary-reply:${normalized.runId}`
    || !normalizeIsoTime(normalized.expiresAt)
    || !/^[a-f0-9]{64}$/u.test(normalized.token)) {
    return null;
  }
  normalized.expiresAt = normalizeIsoTime(normalized.expiresAt);
  return normalized;
}

function describeExistingTextDelivery(operation) {
  const status = normalizeText(operation?.status).toLowerCase();
  if (status === "verified") {
    const localId = normalizePositiveLocalId(operation?.localId);
    return {
      dispatched: true,
      verified: Boolean(localId),
      uncertain: !localId,
      deduplicated: true,
      localId,
    };
  }
  if (status === "sending" || status === "failed_uncertain") {
    return {
      dispatched: true,
      verified: false,
      uncertain: true,
      deduplicated: true,
      localId: normalizePositiveLocalId(operation?.localId),
      verificationError: "an earlier text dispatch remains uncertain; duplicate send suppressed",
    };
  }
  return null;
}

async function sendWeFlowUiaImage(
  config,
  {
    filePath = "",
    sha256 = "",
    imageDigest = "",
    timeoutMs = 0,
    messageKind = "",
    contentKind = "image",
    idempotencyKey = "",
    messageLedger = null,
  } = {},
  fetchImpl = globalThis.fetch
) {
  const contact = normalizeText(config?.weflowInboxDisplayName);
  const talker = normalizeText(config?.weflowInboxChat);
  const resolvedPath = normalizeText(filePath);
  const resolvedDigest = normalizeSha256(imageDigest) || normalizeSha256(sha256);
  const resolvedContentKind = normalizeText(contentKind) || "image";
  const resolvedIdempotencyKey = normalizeText(idempotencyKey);
  if (!contact || !talker || !resolvedPath || !resolvedDigest) {
    throw new Error("WeFlow UIA image send requires contact, talker, filePath, and sha256");
  }

  const verificationTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : resolveTimeoutMs(config);
  let operation = null;
  let ownsDeliveryClaim = false;
  let requestStarted = false;
  try {
    const ledgerClaim = await planAndClaimLedgerOperation(messageLedger, {
      talker,
      text: "[图片]",
      messageKind,
      expectedDirection: "outgoing",
      idempotencyKey: resolvedIdempotencyKey,
      contentKind: resolvedContentKind,
      imageDigest: resolvedDigest,
    });
    operation = ledgerClaim.entry;
    if (ledgerClaim.atomic) {
      if (!ledgerClaim.claimed) {
        const existingDelivery = describeExistingImageDelivery(operation, resolvedDigest);
        if (existingDelivery) {
          return existingDelivery;
        }
        throw invalidLedgerClaimError("image", operation);
      }
      ownsDeliveryClaim = Boolean(operation);
    } else {
      const existingDelivery = describeExistingImageDelivery(operation, resolvedDigest);
      if (existingDelivery) {
        return existingDelivery;
      }
      if (operation) {
        await messageLedger.markSending(operation);
        ownsDeliveryClaim = true;
      }
    }

    requestStarted = true;
    const payload = await requestBridgeJson(config, "/api/send-image", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        contact,
        talker,
        filePath: resolvedPath,
        sha256: resolvedDigest,
        timeout: Math.max(1, Math.ceil(verificationTimeoutMs / 1000)),
      }),
    }, fetchImpl, { timeoutMs: verificationTimeoutMs + 15_000 });
    const verifiedLocalId = normalizePositiveLocalId(payload?.localId);
    if (payload?.dispatched === true && (payload?.verified !== true || !verifiedLocalId)) {
      const verificationError = normalizeText(payload?.verificationError)
        || "WeFlow UIA image dispatch was not observed with a stable local id";
      if (operation && ownsDeliveryClaim) {
        await Promise.resolve().then(() => messageLedger.markFailed(operation, {
          uncertain: true,
          error: verificationError,
        })).catch(() => {});
      }
      // UI Automation already pressed Enter. Returning success-with-uncertainty
      // prevents the stream layer from pasting the same image a second time.
      return {
        ...payload,
        verified: false,
        uncertain: true,
        imageDigest: resolvedDigest,
        verificationError,
      };
    }
    if (payload?.dispatched !== true) {
      const error = new Error("WeFlow UIA image send was not verified");
      error.deliveryUncertain = false;
      throw error;
    }
    if (operation && ownsDeliveryClaim) {
      try {
        await messageLedger.markVerified(operation, { localId: verifiedLocalId });
      } catch (error) {
        await Promise.resolve().then(() => messageLedger.markFailed(operation, {
          uncertain: true,
          error: error instanceof Error ? error.message : String(error),
        })).catch(() => {});
        return { ...payload, imageDigest: resolvedDigest, ledgerUncertain: true };
      }
    }
    return { ...payload, imageDigest: resolvedDigest };
  } catch (error) {
    if (error && typeof error === "object" && error.deliveryUncertain == null) {
      error.deliveryUncertain = requestStarted;
    }
    if (operation && ownsDeliveryClaim) {
      await Promise.resolve().then(() => messageLedger.markFailed(operation, {
        uncertain: requestStarted && error?.deliveryUncertain !== false,
        error: error instanceof Error ? error.message : String(error),
      })).catch(() => {});
    }
    throw error;
  }
}

function describeExistingImageDelivery(operation, imageDigest) {
  const status = normalizeText(operation?.status).toLowerCase();
  if (status === "verified") {
    const localId = normalizePositiveLocalId(operation?.localId);
    return {
      dispatched: true,
      verified: Boolean(localId),
      uncertain: !localId,
      deduplicated: true,
      localId,
      imageDigest,
    };
  }
  if (status === "sending" || status === "failed_uncertain") {
    return {
      dispatched: true,
      verified: false,
      uncertain: true,
      deduplicated: true,
      localId: normalizePositiveLocalId(operation?.localId),
      imageDigest,
      verificationError: "an earlier image dispatch remains uncertain; duplicate paste suppressed",
    };
  }
  return null;
}

async function planAndClaimLedgerOperation(messageLedger, payload) {
  if (!messageLedger) {
    return { entry: null, claimed: true, atomic: false };
  }
  if (typeof messageLedger.planAndClaimOutbound === "function") {
    const result = await messageLedger.planAndClaimOutbound(payload);
    if (!result || typeof result !== "object" || !result.entry || typeof result.claimed !== "boolean") {
      const error = new Error("WeFlow message ledger returned an invalid atomic claim");
      error.code = "INVALID_LEDGER_CLAIM";
      throw error;
    }
    return { entry: result.entry, claimed: result.claimed, atomic: true };
  }
  if (typeof messageLedger.planOutbound !== "function") {
    throw new Error("WeFlow message ledger does not support outbound planning");
  }
  return {
    entry: await messageLedger.planOutbound(payload),
    claimed: false,
    atomic: false,
  };
}

function invalidLedgerClaimError(contentKind, operation) {
  const status = normalizeText(operation?.status).toLowerCase() || "missing";
  const error = new Error(
    `WeFlow ${contentKind} ledger declined a claim in unsupported status: ${status}`,
  );
  error.code = "INVALID_LEDGER_CLAIM";
  return error;
}

async function requestBridgeJson(config, pathname, init, fetchImpl, { timeoutMs = resolveTimeoutMs(config) } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("WeFlow bridge requires fetch support");
  }
  const baseUrl = normalizeText(config?.weflowBridgeBaseUrl) || "http://127.0.0.1:8766";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(new URL(pathname, `${baseUrl.replace(/\/$/, "")}/`), {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = normalizeText(payload?.error) || `HTTP ${response.status}`;
    const error = new Error(`WeFlow bridge request failed: ${detail}`);
    error.bridgeStatus = response.status;
    error.code = normalizeText(payload?.code) || "WEFLOW_BRIDGE_HTTP_ERROR";
    // A completed HTTP error response is a certain pre-dispatch failure unless
    // the bridge explicitly says UI Automation already sent the message. A
    // transport interruption still has no such flag and remains uncertain.
    error.deliveryUncertain = payload?.dispatched === true;
    throw error;
  }
  return payload && typeof payload === "object" ? payload : {};
}

function resolveTimeoutMs(config) {
  const value = Number(config?.weflowBridgeTimeoutMs);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIsoTime(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizePositiveLocalId(value) {
  const text = String(value ?? "").trim();
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

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeSha256(value) {
  const text = normalizeText(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

module.exports = {
  CONTROL_COMMANDS,
  CONTROL_CONFIRMATIONS,
  executeWeFlowControlCommand,
  formatWeFlowControlConfirmation,
  isWeFlowControlConfirmation,
  isWeFlowControlCommand,
  resolveWeFlowSendSource,
  sendWeFlowUiaImage,
  sendWeFlowUiaText,
};
