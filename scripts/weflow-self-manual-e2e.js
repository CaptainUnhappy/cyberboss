#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(PROJECT_ROOT, ".env") });

const PROCESSING_TEXT = "处理中";
const DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:8766";
const DEFAULT_WEFLOW_BASE_URL = "http://127.0.0.1:5031";
const DEFAULT_RESULT_TIMEOUT_MS = 300_000;
const DEFAULT_QUIET_WINDOW_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_BRIDGE_SEND_TIMEOUT_MS = 30_000;
const DEFAULT_BRIDGE_RESPONSE_GRACE_MS = 15_000;
const MESSAGE_LIMIT = 200;

async function main() {
  const startedAtMs = Date.now();
  const config = readConfig();
  await assertBridgeReady(config);
  await assertAzzySendSource(config);

  // Verify the message API before the operation that has an observable effect.
  await fetchMessages(config);

  const runId = `${formatCompactUtc(new Date())}-${crypto.randomBytes(5).toString("hex")}`;
  const marker = `E2E_OK_${runId}`;
  const triggerText = [
    `Cyberboss 同号人工控制消息端到端测试 ${runId}。`,
    `请简短回复，并确保最终回复原样包含唯一标记：${marker}`,
  ].join(" ");

  // This intentionally calls the UIA bridge directly instead of the normal
  // Cyberboss outbound path. The message therefore has no ledger entry and
  // must be recognized by Cyberboss as a same-account manual message.
  const trigger = await requestJson(
    buildUrl(config.bridgeBaseUrl, "/api/send"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        contact: config.contact,
        talker: config.talker,
        text: triggerText,
        timeout: Math.max(1, Math.ceil(config.bridgeSendTimeoutMs / 1_000)),
      }),
    },
    {
      label: "WeFlow UIA same-account trigger",
      timeoutMs: config.bridgeSendTimeoutMs + DEFAULT_BRIDGE_RESPONSE_GRACE_MS,
    }
  );
  if (trigger?.dispatched !== true) {
    throw new Error("WeFlow UIA bridge did not dispatch the same-account trigger");
  }
  const bridgeVerified = trigger?.verified === true;
  const bridgeUncertain = trigger?.verified === false && trigger?.uncertain === true;
  if (!bridgeVerified && !bridgeUncertain) {
    throw new Error("WeFlow UIA bridge returned an invalid trigger verification state");
  }
  const triggerLocalId = bridgeVerified
    ? requireLocalId(trigger?.localId, "same-account trigger")
    : await waitForUniqueTrigger(config, { triggerText });
  const observed = await waitForExpectedReplies(config, {
    marker,
    triggerLocalId,
  });

  // Keep this window deliberately quiet: a delayed echo-loop normally appears
  // only after the first final reply has itself been observed by the inbox.
  await sleep(config.quietWindowMs);
  const quietMessages = await fetchMessages(config);
  const quietObserved = inspectReplies(quietMessages, { marker, triggerLocalId });
  assertExactlyOnce(quietObserved, { marker, phase: "quiet-window recheck" });
  assertReplyOrder(quietObserved, triggerLocalId);

  const result = {
    ok: true,
    runId,
    marker,
    checks: {
      bridgeReady: true,
      sendSource: "azzy",
      triggerBridgeVerified: bridgeVerified,
      triggerBridgeUncertain: bridgeUncertain,
      quietWindowMs: config.quietWindowMs,
    },
    localIds: {
      trigger: triggerLocalId.text,
      processing: quietObserved.processing.map((message) => message.localId.text),
      final: quietObserved.final.map((message) => message.localId.text),
    },
    elapsedMs: Date.now() - startedAtMs,
  };

  // Retain the first observation as an invariant: the quiet-window query must
  // still point to the same two replies, rather than a later replacement.
  if (
    observed.processing[0].localId.text !== quietObserved.processing[0].localId.text
    || observed.final[0].localId.text !== quietObserved.final[0].localId.text
  ) {
    throw new Error("reply localIds changed during the quiet-window recheck");
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function waitForUniqueTrigger(config, { triggerText }) {
  const deadlineMs = Date.now() + config.resultTimeoutMs;
  let lastError = null;
  let matching = [];
  while (Date.now() < deadlineMs) {
    try {
      const messages = await fetchMessages(config);
      const byLocalId = new Map();
      for (const message of messages) {
        if (!isOutgoingMessage(message) || readMessageText(message) !== triggerText) {
          continue;
        }
        const localId = optionalLocalId(readLocalId(message));
        if (!localId) {
          throw new Error("same-account trigger appeared without a positive localId");
        }
        byLocalId.set(localId.text, localId);
      }
      matching = [...byLocalId.values()].sort((left, right) => (
        left.value < right.value ? -1 : left.value > right.value ? 1 : 0
      ));
      if (matching.length > 1) {
        const error = new Error(
          `found duplicate same-account triggers: [${matching.map((item) => item.text).join(",")}]`
        );
        error.code = "E2E_DUPLICATE_TRIGGER";
        throw error;
      }
      if (matching.length === 1) {
        return matching[0];
      }
      lastError = null;
    } catch (error) {
      if (error?.code === "E2E_DUPLICATE_TRIGGER") {
        throw error;
      }
      lastError = error;
    }
    await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadlineMs - Date.now())));
  }
  const detail = lastError ? `; last poll error: ${formatError(lastError)}` : "";
  const error = new Error(
    `timed out waiting for the unique outgoing same-account trigger (matches=${matching.length})${detail}`
  );
  error.code = "E2E_TRIGGER_TIMEOUT";
  throw error;
}

function readConfig() {
  const bridgeBaseUrl = normalizeBaseUrl(
    process.env.CYBERBOSS_WEFLOW_BRIDGE_BASE_URL || DEFAULT_BRIDGE_BASE_URL,
    "CYBERBOSS_WEFLOW_BRIDGE_BASE_URL"
  );
  const bridgeUrl = new URL(bridgeBaseUrl);
  const bridgePort = bridgeUrl.port || (bridgeUrl.protocol === "https:" ? "443" : "80");
  if (bridgePort !== "8766") {
    throw new Error(`WeFlow UIA E2E requires the local bridge on port 8766, got ${bridgePort}`);
  }
  if (!isLoopbackHost(bridgeUrl.hostname)) {
    throw new Error(`WeFlow UIA E2E requires a loopback bridge host, got ${bridgeUrl.hostname}`);
  }

  const token = requiredEnv("CYBERBOSS_WEFLOW_TOKEN");
  const talker = requiredEnv("CYBERBOSS_WEFLOW_INBOX_CHAT");
  const contact = requiredEnv("CYBERBOSS_WEFLOW_INBOX_DISPLAY_NAME");
  return {
    bridgeBaseUrl,
    weflowBaseUrl: normalizeBaseUrl(
      process.env.CYBERBOSS_WEFLOW_BASE_URL || DEFAULT_WEFLOW_BASE_URL,
      "CYBERBOSS_WEFLOW_BASE_URL"
    ),
    token,
    talker,
    contact,
    resultTimeoutMs: positiveIntegerEnv(
      "CYBERBOSS_WEFLOW_E2E_TIMEOUT_MS",
      DEFAULT_RESULT_TIMEOUT_MS,
      10_000
    ),
    quietWindowMs: positiveIntegerEnv(
      "CYBERBOSS_WEFLOW_E2E_QUIET_WINDOW_MS",
      DEFAULT_QUIET_WINDOW_MS,
      1_000
    ),
    pollIntervalMs: positiveIntegerEnv(
      "CYBERBOSS_WEFLOW_E2E_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
      100
    ),
    requestTimeoutMs: positiveIntegerEnv(
      "CYBERBOSS_WEFLOW_E2E_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
      1_000
    ),
    bridgeSendTimeoutMs: positiveIntegerEnv(
      "CYBERBOSS_WEFLOW_BRIDGE_TIMEOUT_MS",
      DEFAULT_BRIDGE_SEND_TIMEOUT_MS,
      1_000
    ),
  };
}

async function assertBridgeReady(config) {
  const payload = await requestJson(
    buildUrl(config.bridgeBaseUrl, "/readyz"),
    {},
    { label: "WeFlow UIA readyz", timeoutMs: config.requestTimeoutMs }
  );
  if (payload?.ok !== true || payload?.wechatWindow !== true) {
    throw new Error("WeFlow UIA readyz did not confirm the desktop WeChat chat window");
  }
}

async function assertAzzySendSource(config) {
  const payload = await requestJson(
    buildUrl(config.bridgeBaseUrl, "/api/send-source"),
    {},
    { label: "WeFlow UIA send source", timeoutMs: config.requestTimeoutMs }
  );
  const source = String(payload?.send_source || "").trim().toLowerCase();
  if (payload?.ok !== true || source !== "azzy") {
    throw new Error(`WeFlow UIA send source must be azzy, got ${source || "empty"}`);
  }
}

async function waitForExpectedReplies(config, { marker, triggerLocalId }) {
  const deadlineMs = Date.now() + config.resultTimeoutMs;
  let lastError = null;
  let lastObserved = { processing: [], final: [] };

  while (Date.now() < deadlineMs) {
    try {
      const messages = await fetchMessages(config);
      lastObserved = inspectReplies(messages, { marker, triggerLocalId });
      assertNoDuplicates(lastObserved, { marker, phase: "reply polling" });
      if (lastObserved.processing.length === 1 && lastObserved.final.length === 1) {
        assertReplyOrder(lastObserved, triggerLocalId);
        return lastObserved;
      }
      lastError = null;
    } catch (error) {
      if (error?.code === "E2E_DUPLICATE" || error?.code === "E2E_ORDER") {
        throw error;
      }
      lastError = error;
    }
    await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadlineMs - Date.now())));
  }

  const detail = lastError ? `; last poll error: ${formatError(lastError)}` : "";
  const error = new Error(
    `timed out waiting for exactly one ${JSON.stringify(PROCESSING_TEXT)} and one final reply containing ${marker}`
    + ` (processing=${lastObserved.processing.length}, final=${lastObserved.final.length})${detail}`
  );
  error.code = "E2E_TIMEOUT";
  throw error;
}

async function fetchMessages(config) {
  const url = new URL("/api/v1/messages", `${config.weflowBaseUrl}/`);
  url.searchParams.set("talker", config.talker);
  url.searchParams.set("limit", String(MESSAGE_LIMIT));
  const payload = await requestJson(url, {
    headers: { Authorization: `Bearer ${config.token}` },
  }, {
    label: "WeFlow messages",
    timeoutMs: config.requestTimeoutMs,
  });
  return extractMessages(payload);
}

function extractMessages(payload) {
  if (Array.isArray(payload)) {
    return payload.filter(isObject);
  }
  for (const key of ["messages", "data", "items"]) {
    const candidate = payload?.[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isObject);
    }
    if (isObject(candidate)) {
      for (const nestedKey of ["messages", "items", "list"]) {
        if (Array.isArray(candidate[nestedKey])) {
          return candidate[nestedKey].filter(isObject);
        }
      }
    }
  }
  throw new Error("WeFlow messages response did not contain a message list");
}

function inspectReplies(messages, { marker, triggerLocalId }) {
  const afterTrigger = new Map();
  for (const message of messages) {
    if (!isOutgoingMessage(message)) {
      continue;
    }
    const localId = optionalLocalId(readLocalId(message));
    const text = readMessageText(message);
    const relevant = text === PROCESSING_TEXT || text.includes(marker);
    if (relevant && !localId) {
      throw new Error(`matching WeFlow message is missing localId: ${JSON.stringify(text)}`);
    }
    if (!localId || localId.value <= triggerLocalId.value) {
      continue;
    }
    // Treat repeated representations of the same localId as one stored message.
    afterTrigger.set(localId.text, { raw: message, localId, text });
  }

  const candidates = [...afterTrigger.values()].sort((left, right) => (
    left.localId.value < right.localId.value ? -1 : left.localId.value > right.localId.value ? 1 : 0
  ));
  return {
    processing: candidates.filter((message) => message.text === PROCESSING_TEXT),
    final: candidates.filter((message) => message.text.includes(marker)),
  };
}

function isOutgoingMessage(message) {
  const isSend = message?.isSend ?? message?.is_send;
  return isSend === true
    || isSend === 1
    || isSend === "1"
    || String(message?.direction || "").trim().toLowerCase() === "outgoing";
}

function assertNoDuplicates(observed, { marker, phase }) {
  if (observed.processing.length > 1 || observed.final.length > 1) {
    const error = new Error(
      `${phase} found duplicate replies after the trigger: `
      + `${JSON.stringify(PROCESSING_TEXT)}=${formatLocalIds(observed.processing)}, `
      + `${marker}=${formatLocalIds(observed.final)}`
    );
    error.code = "E2E_DUPLICATE";
    throw error;
  }
}

function assertExactlyOnce(observed, context) {
  assertNoDuplicates(observed, context);
  if (observed.processing.length !== 1 || observed.final.length !== 1) {
    throw new Error(
      `${context.phase} expected exactly one acknowledgement and final reply; `
      + `processing=${observed.processing.length}, final=${observed.final.length}`
    );
  }
}

function assertReplyOrder(observed, triggerLocalId) {
  const processingId = observed.processing[0]?.localId;
  const finalId = observed.final[0]?.localId;
  if (!processingId || !finalId) {
    return;
  }
  if (processingId.value <= triggerLocalId.value || finalId.value <= processingId.value) {
    const error = new Error(
      `unexpected reply order: trigger=${triggerLocalId.text}, `
      + `processing=${processingId.text}, final=${finalId.text}`
    );
    error.code = "E2E_ORDER";
    throw error;
  }
}

function readMessageText(message) {
  for (const key of ["parsedContent", "content", "text"]) {
    if (typeof message?.[key] === "string" && message[key].trim()) {
      return message[key].trim();
    }
  }
  return "";
}

function readLocalId(message) {
  for (const key of ["localId", "local_id", "id", "msgId", "msg_id"]) {
    const localId = optionalLocalId(message?.[key]);
    if (localId) {
      return localId.text;
    }
  }
  return "";
}

function requireLocalId(value, label) {
  const localId = optionalLocalId(value);
  if (!localId) {
    throw new Error(`${label} returned a missing or non-numeric localId`);
  }
  return localId;
}

function optionalLocalId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const numeric = BigInt(text);
  return numeric > 0n ? { text: numeric.toString(), value: numeric } : null;
}

async function requestJson(url, init = {}, { label = "request", timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`${label} failed: ${formatError(error)}`);
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
    const detail = typeof payload?.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : `HTTP ${response.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  if (payload === null || typeof payload !== "object") {
    throw new Error(`${label} returned invalid JSON`);
  }
  return payload;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is required in ${path.join(PROJECT_ROOT, ".env")}`);
  }
  return value;
}

function positiveIntegerEnv(name, fallback, minimum) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function normalizeBaseUrl(value, name) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error(`${name} must be a valid HTTP URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return url.toString().replace(/\/$/, "");
}

function buildUrl(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`);
}

function isLoopbackHost(hostname) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(String(hostname).toLowerCase());
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatLocalIds(messages) {
  return `[${messages.map((message) => message.localId.text).join(",")}]`;
}

function formatCompactUtc(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error?.code || "E2E_FAILED",
    error: formatError(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
