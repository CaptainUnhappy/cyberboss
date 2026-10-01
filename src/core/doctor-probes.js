/**
 * Read-only channel readiness probes for `cyberboss doctor`.
 *
 * Why this module exists: two message channels run side by side — the official
 * iLink bot (HTTPS) and the personal-account channel driven by local UI
 * automation ("weflow-uia") — but nothing ever *declared* which one is usable.
 * The only way to find out was to send a message and see whether a reply came
 * back, which is the worst possible probe: on the official channel a send
 * consumes the inbound `context_token`, and on the personal channel it puts
 * visible noise in the user's own WeChat.
 *
 * Every judgement below is copied from an existing, already-validated probe —
 * see `.agents/notes/implemented/process/2026-09-18-rdpwrap-isolated-session-deployment.md`
 * (reader/writer failure signatures, `/readyz`, `/api/probe`) and
 * `.agents/notes/implemented/architecture/2026-09-30-ilink-bot-api-observed-contract.md`
 * (`-14` means the server could not establish context, NOT that the session died).
 *
 * Hard rules:
 *   - no sends: the iLink branch must never touch `ilink/bot/sendmessage`;
 *   - no cursor writes: the messages query is a fresh time window, never the
 *     durable inbox cursor;
 *   - no `?move=1` on `/api/probe`: that one calls SetCursorPos and would steal
 *     the cursor, which is exactly what this project exists to avoid.
 */

const { getConfig } = require("../adapters/channel/weixin/api");
const { listWeixinAccounts } = require("../adapters/channel/weixin/account-store");
const { redactSensitiveText } = require("../adapters/channel/weixin/redact");
const { driverStatus } = require("../integrations/wechat-cua/daemon");
const { findWeChatWindow } = require("../integrations/wechat-cua/client");
const { execFileSync } = require("node:child_process");

/** Injected in tests; the real driver CLI otherwise. */
function defaultExecDriver(driver, args) {
  const { DRIVER } = require("../integrations/wechat-cua/daemon");
  return execFileSync(driver || DRIVER, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
}
function defaultFindWeChatWindow() {
  return findWeChatWindow();
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const CHANNEL_IDS = ["ilink", "weflow-uia", "wechat-cua"];

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBaseUrl(value, fallback) {
  const raw = normalizeText(value) || fallback;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/**
 * Resolve the declared channel list. `config.enabledChannels` (from
 * `CYBERBOSS_ENABLED_CHANNELS`) is the source of truth; the env fallback keeps
 * the helper usable standalone in tests. An empty list means "every channel is
 * eligible, derive availability as before".
 */
function readDeclaredChannels(config, env = process.env) {
  const fromConfig = Array.isArray(config?.enabledChannels)
    ? config.enabledChannels.map((item) => normalizeText(item).toLowerCase()).filter(Boolean)
    : null;
  const raw = fromConfig && fromConfig.length
    ? fromConfig.join(",")
    : normalizeText(env?.CYBERBOSS_ENABLED_CHANNELS);
  if (!raw) {
    return { declared: [], invalid: [] };
  }
  const tokens = String(raw).split(",").map((item) => normalizeText(item).toLowerCase()).filter(Boolean);
  const declared = tokens.filter((item) => CHANNEL_IDS.includes(item));
  const invalid = tokens.filter((item) => !CHANNEL_IDS.includes(item));
  return { declared, invalid };
}

function isWeFlowUiaConfigured(config, env = process.env) {
  const flag = normalizeText(env.CYBERBOSS_ENABLE_WEFLOW_INBOX).toLowerCase();
  const enabled = flag === "1" || flag === "true" || flag === "yes" || flag === "on";
  const hasToken = Boolean(normalizeText(config?.weflowToken));
  const hasChats = Array.isArray(config?.weflowInboxChats)
    ? config.weflowInboxChats.length > 0
    : Boolean(normalizeText(config?.weflowInboxChat));
  return { enabled, hasToken, hasChats, configured: enabled && hasToken && hasChats };
}

function summarizeError(error) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error || "unknown error"));
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- ilink

async function probeIlink(config, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const result = { channel: "ilink", enabled: false, ready: false, reason: "", detail: "" };
  let account;
  try {
    const accounts = listWeixinAccounts(config);
    account = accounts.length ? accounts[0] : null;
  } catch (error) {
    result.reason = "account-store-unreadable";
    result.detail = summarizeError(error);
    return result;
  }
  if (!account || !normalizeText(account.token)) {
    result.reason = "no-paired-account";
    result.detail = "run `npm run login` to pair the official bot";
    return result;
  }
  result.enabled = true;

  try {
    const parsed = await getConfig({
      baseUrl: account.baseUrl || config.weixinBaseUrl,
      token: account.token,
      ilinkUserId: normalizeText(account.userId),
      contextToken: "",
      timeoutMs,
    });
    const ret = parsed?.ret;
    if (ret === 0 || ret === undefined) {
      result.ready = true;
      result.detail = "getconfig ok (read-only session check)";
      return result;
    }
    result.reason = "unexpected-ret";
    result.detail = `ret=${ret}`;
    return result;
  } catch (error) {
    const message = summarizeError(error);
    if (/ret=-14|errcode=-14/.test(message)) {
      // Measured contract: -14 means the server could not establish context for
      // this request (the plugin maps notifyStart's -14 to `stale-token`). It is
      // *not* proof that the session died, so this stays an actionable warning.
      result.reason = "stale-token";
      result.detail = `the bot token looks stale (${message}); re-run \`npm run login\` if it persists`;
      return result;
    }
    if (/ret=-2|errcode=-2/.test(message)) {
      result.reason = "context-token-required";
      result.detail = "the official channel can only reply while an inbound message supplies a fresh context_token";
      return result;
    }
    result.reason = "unreachable";
    result.detail = message;
    return result;
  }
}

// -------------------------------------------------------------- weflow-uia

function parseJsonSafe(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function probeWeFlowUia(config, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, env = process.env } = {}) {
  const result = { channel: "weflow-uia", enabled: false, ready: false, reason: "", detail: "" };
  const state = isWeFlowUiaConfigured(config, env);
  result.enabled = state.configured;
  if (!state.configured) {
    result.reason = "disabled";
    const missing = [];
    if (!state.enabled) missing.push("CYBERBOSS_ENABLE_WEFLOW_INBOX");
    if (!state.hasToken) missing.push("CYBERBOSS_WEFLOW_TOKEN");
    if (!state.hasChats) missing.push("CYBERBOSS_WEFLOW_INBOX_CHATS");
    result.detail = `not configured in this process: missing ${missing.join(", ")}`;
    return result;
  }

  const readerBase = normalizeBaseUrl(config.weflowBaseUrl, "http://127.0.0.1:5031");
  const writerBase = normalizeBaseUrl(config.weflowBridgeBaseUrl, "http://127.0.0.1:8766");
  const authHeaders = { authorization: `Bearer ${normalizeText(config.weflowToken)}` };

  // Reader, step 1: liveness.
  try {
    const response = await fetchWithTimeout(fetchImpl, new URL("api/v1/health", readerBase).toString(), { headers: authHeaders }, timeoutMs);
    if (!response.ok) {
      result.reason = "reader-unhealthy";
      result.detail = `GET /api/v1/health -> HTTP ${response.status}`;
      return result;
    }
  } catch (error) {
    result.reason = "reader-unreachable";
    result.detail = `GET /api/v1/health failed: ${summarizeError(error)}`;
    return result;
  }

  // Reader, step 2: the real question. Health stays 200 while every messages
  // query returns 500, and in that state the bot reads nothing at all.
  const talker = Array.isArray(config.weflowInboxChats) && config.weflowInboxChats.length
    ? config.weflowInboxChats[0]
    : normalizeText(config.weflowInboxChat);
  try {
    const now = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      talker,
      limit: "1",
      start: String(now - 3600),
      end: String(now),
    });
    const response = await fetchWithTimeout(
      fetchImpl,
      new URL(`api/v1/messages?${params}`, readerBase).toString(),
      { headers: authHeaders },
      timeoutMs
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const parsed = parseJsonSafe(body);
      const errorCode = normalizeText(parsed?.error);
      result.reason = "reader-messages-failed";
      result.detail = errorCode.includes("-105")
        ? `GET /api/v1/messages -> HTTP ${response.status} 错误码: -105 (WCDB anchor state; see the anchor-rebuild recipe, a restart will not fix it)`
        : `GET /api/v1/messages -> HTTP ${response.status} ${summarizeError(body).slice(0, 160)}`;
      return result;
    }
  } catch (error) {
    result.reason = "reader-messages-failed";
    result.detail = `GET /api/v1/messages failed: ${summarizeError(error)}`;
    return result;
  }

  // Writer, step 1: does the bridge see a logged-in main window?
  try {
    const response = await fetchWithTimeout(fetchImpl, new URL("readyz", writerBase).toString(), {}, timeoutMs);
    if (!response.ok) {
      result.reason = "writer-not-ready";
      result.detail = `GET /readyz -> HTTP ${response.status} (no logged-in WeChat main window in the isolated session)`;
      return result;
    }
  } catch (error) {
    result.reason = "writer-unreachable";
    result.detail = `GET /readyz failed: ${summarizeError(error)}`;
    return result;
  }

  // Writer, step 2: is the input desktop still injectable? Read-only form only:
  // `?move=1` calls SetCursorPos and would steal the cursor.
  try {
    const response = await fetchWithTimeout(fetchImpl, new URL("api/probe", writerBase).toString(), {}, timeoutMs);
    if (!response.ok) {
      result.reason = "writer-probe-failed";
      result.detail = `GET /api/probe -> HTTP ${response.status}`;
      return result;
    }
    const payload = await response.json().catch(() => null);
    if (payload?.ok !== true) {
      result.reason = "writer-desktop-unavailable";
      result.detail = `GET /api/probe -> ok=false foreground=${payload?.foreground ?? "(none)"} (the isolated session lost its input desktop)`;
      return result;
    }
    result.ready = true;
    result.detail = `reader=ok writer=ready foreground=${payload?.foreground ?? "(none)"} desktopIdleSeconds=${payload?.desktopIdleSeconds ?? "(none)"}`;
    return result;
  } catch (error) {
    result.reason = "writer-probe-failed";
    result.detail = `GET /api/probe failed: ${summarizeError(error)}`;
    return result;
  }
}

// -------------------------------------------------------------------- api

/**
 * Readiness of the Cua-driven channel, in the order that actually breaks:
 *
 *   1. the driver daemon is not running  -> nothing can be read or written;
 *   2. no WeChat window is visible        -> the client is closed or minimized away;
 *   3. the allow-list is empty            -> the bot answers nobody (fail-closed);
 *   4. a peer has no chat mapping         -> sending to it fails hard by design.
 *
 * Every one of these was observed live on 2026-10-01, and all four look identical
 * from the outside: the bot is up, and no reply ever comes. That is exactly the
 * question `doctor` exists to answer, so the channel that now carries production
 * traffic has to be covered by it.
 */
async function probeWeChatCua(config, {
  exec = defaultExecDriver,
  findWindow = defaultFindWeChatWindow,
  env = process.env,
} = {}) {
  const result = { channel: "wechat-cua", enabled: false, ready: false, reason: "", detail: "" };
  const enabled = Boolean(config.wechatCuaEnabled || config.wechatCuaInboxEnabled);
  result.enabled = enabled;
  if (!enabled) {
    result.reason = "disabled";
    result.detail = "not enabled in this process: set CYBERBOSS_ENABLE_WECHAT_CUA (and ..._INBOX for the read half)";
    return result;
  }

  const status = driverStatus({ exec });
  if (!status.running) {
    result.reason = "driver-not-running";
    result.detail = `${status.raw} - start it with "cua-driver serve" or re-enable its autostart entry`;
    return result;
  }

  try {
    const win = findWindow();
    result.detail = `driver up, window ${JSON.stringify(win?.title || "")} (pid ${win?.pid})`;
    if (win?.minimized) {
      // A minimized window still reads, but every write fails (measured).
      result.reason = "window-minimized";
      result.detail += " - the window is minimized, so sends will fail until it is restored";
      return result;
    }
  } catch (error) {
    result.reason = "no-wechat-window";
    result.detail = `the driver is up but sees no WeChat window: ${summarizeError(error)}`;
    return result;
  }

  const peers = String(config.wechatCuaAllowPeers || "")
    .split(",").map((item) => item.trim()).filter(Boolean);
  if (!peers.length) {
    result.reason = "allow-list-empty";
    result.detail = "CYBERBOSS_WECHAT_CUA_ALLOW_PEERS is empty, so the bot will answer nobody";
    return result;
  }
  const mapping = String(config.wechatCuaChatByTalker || "");
  const mapped = new Set(mapping
    .split(",").map((item) => item.trim()).filter(Boolean)
    .map((item) => (item.includes("=") ? item.slice(0, item.indexOf("=")).trim() : ""))
    .filter(Boolean));
  const unmapped = peers.filter((peer) => !mapped.has(peer));
  if (unmapped.length) {
    result.reason = "missing-chat-mapping";
    result.detail = `no CYBERBOSS_CUA_CHAT_BY_TALKER entry for ${unmapped.map((p) => JSON.stringify(p)).join(", ")} - sends to them refuse rather than guess`;
    return result;
  }

  result.ready = true;
  result.detail += `; answers ${peers.map((peer) => JSON.stringify(peer)).join(", ")}`;
  return result;
}

/**
 * Probe every eligible channel. Never throws: a channel that cannot be probed
 * is reported as `ready: false` with a reason, because the whole point is to
 * turn "no reply" into a readable string.
 */
async function probeChannels(config, options = {}) {
  const { declared, invalid } = readDeclaredChannels(config, options.env || process.env);
  const probes = [
    { id: "ilink", run: () => probeIlink(config, options) },
    { id: "weflow-uia", run: () => probeWeFlowUia(config, options) },
    { id: "wechat-cua", run: () => probeWeChatCua(config, options) },
  ];
  const selected = declared.length ? probes.filter((probe) => declared.includes(probe.id)) : probes;

  const results = [];
  for (const probe of selected) {
    try {
      results.push(await probe.run());
    } catch (error) {
      results.push({ channel: probe.id, enabled: true, ready: false, reason: "probe-crashed", detail: summarizeError(error) });
    }
  }
  if (invalid.length) {
    results.push({
      channel: "config",
      enabled: false,
      ready: false,
      reason: "unknown-channel-name",
      detail: `CYBERBOSS_ENABLED_CHANNELS has unknown value(s): ${invalid.join(", ")} (known: ${CHANNEL_IDS.join(", ")})`,
    });
  }
  return results;
}

/** Doctor exits non-zero only when an *enabled* channel is not ready. */
function summarizeChannels(results) {
  const enabled = results.filter((item) => item.enabled);
  const notReady = enabled.filter((item) => !item.ready);
  return {
    enabled: enabled.map((item) => item.channel),
    ready: enabled.filter((item) => item.ready).map((item) => item.channel),
    notReady: notReady.map((item) => item.channel),
    ok: notReady.length === 0,
  };
}

module.exports = {
  CHANNEL_IDS,
  DEFAULT_PROBE_TIMEOUT_MS,
  probeChannels,
  probeIlink,
  probeWeFlowUia,
  probeWeChatCua,
  readDeclaredChannels,
  summarizeChannels,
};
