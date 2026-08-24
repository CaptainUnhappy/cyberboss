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
  { text = "", timeoutMs = 0, messageKind = "", messageLedger = null } = {},
  fetchImpl = globalThis.fetch
) {
  const contact = normalizeText(config?.weflowInboxDisplayName);
  const talker = normalizeText(config?.weflowInboxChat);
  const content = String(text || "");
  if (!contact || !talker || !content.trim()) {
    throw new Error("WeFlow UIA send requires contact, talker, and text");
  }
  const verificationTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : resolveTimeoutMs(config);
  let operation = null;
  let requestStarted = false;
  try {
    operation = messageLedger
      ? await messageLedger.planOutbound({
        talker,
        text: content,
        messageKind,
        expectedDirection: "outgoing",
      })
      : null;
    if (operation) {
      await messageLedger.markSending(operation);
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
      }),
    }, fetchImpl, { timeoutMs: verificationTimeoutMs + 15_000 });
    const verifiedLocalId = normalizePositiveLocalId(payload?.localId);
    if (payload?.dispatched === true && (payload?.verified !== true || !verifiedLocalId)) {
      const verificationError = normalizeText(payload?.verificationError)
        || "WeFlow UIA dispatch was not observed with a stable local id";
      if (operation) {
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
    if (operation) {
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
    if (operation) {
      await Promise.resolve().then(() => messageLedger.markFailed(operation, {
        uncertain: requestStarted && error?.deliveryUncertain !== false,
        error: error instanceof Error ? error.message : String(error),
      })).catch(() => {});
    }
    throw error;
  }
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

module.exports = {
  executeWeFlowControlCommand,
  formatWeFlowControlConfirmation,
  isWeFlowControlConfirmation,
  isWeFlowControlCommand,
  resolveWeFlowSendSource,
  sendWeFlowUiaText,
};
