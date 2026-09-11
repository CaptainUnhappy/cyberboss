const fs = require("fs");
const path = require("path");

const CURSOR_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_SEEN_IDENTITIES = 1_000;
const RESERVED_PREFIX = "[Cyberboss心跳";

class WeFlowCanaryInboxSource {
  constructor({
    config,
    onMessage,
    fetchImpl = globalThis.fetch,
    logger = console,
  } = {}) {
    this.config = config || {};
    this.onMessage = typeof onMessage === "function" ? onMessage : async () => true;
    this.fetchImpl = fetchImpl;
    this.logger = logger || console;
    this.running = false;
    this.abortController = null;
    this.loopPromise = null;
    this.cursor = loadCursor(this.config.weflowCanaryInboxCursorFile, {
      talker: this.config.weflowCanaryChat,
    });
  }

  async start() {
    if (this.running) return;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("WeFlow canary inbox requires fetch support");
    }
    if (!normalizeText(this.config.weflowCanaryChat)
      || !normalizeText(this.config.weflowCanaryDisplayName)) {
      throw new Error("WeFlow canary inbox requires a dedicated talker and display name");
    }
    this.running = true;
    this.abortController = new AbortController();
    this.loopPromise = this.runLoop(this.abortController.signal).catch((error) => {
      if (this.running && !isAbortError(error)) {
        this.logger.error?.(`[cyberboss] WeFlow canary inbox stopped: ${formatError(error)}`);
      }
    });
  }

  async stop() {
    this.running = false;
    this.abortController?.abort();
    await Promise.resolve(this.loopPromise).catch(() => {});
    this.abortController = null;
    this.loopPromise = null;
  }

  async runLoop(signal) {
    let failures = 0;
    while (this.running && !signal.aborted) {
      try {
        await this.pollOnce({ signal });
        failures = 0;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) break;
        failures += 1;
        this.logger.error?.(`[cyberboss] WeFlow canary poll failed: ${formatError(error)}`);
      }
      if (this.running && !signal.aborted) {
        const base = normalizePositiveInt(
          this.config.weflowOutgoingPollIntervalMs,
          DEFAULT_POLL_INTERVAL_MS,
          250,
        );
        const waitMs = failures ? Math.min(60_000, base * (2 ** Math.min(5, failures))) : base;
        await delayUntilAbort(waitMs, signal);
      }
    }
  }

  async pollOnce({ signal } = {}) {
    const talker = normalizeText(this.config.weflowCanaryChat);
    if (!talker) return { status: "disabled", fetched: 0, candidates: 0, processed: 0 };
    if (normalizeText(this.cursor.talker) !== talker) {
      this.cursor = emptyCursor(talker);
    }

    const url = new URL("/api/v1/messages", `${normalizeBaseUrl(this.config.weflowBaseUrl)}/`);
    url.searchParams.set("talker", talker);
    url.searchParams.set("limit", String(normalizePositiveInt(
      this.config.weflowCanaryMessageLimit,
      DEFAULT_MESSAGE_LIMIT,
      1,
    )));
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${normalizeText(this.config.weflowToken)}` },
      signal,
    });
    if (!response?.ok) {
      throw new Error(`WeFlow canary messages failed: HTTP ${response?.status || "unknown"}`);
    }
    const rows = extractMessages(await response.json());
    const candidates = rows
      .map((row) => buildCandidate(row, { talker }))
      .filter(Boolean)
      .sort(compareCandidates);
    let processed = 0;
    for (const candidate of candidates) {
      if (this.hasSeen(candidate)) continue;
      const accepted = await this.onMessage(candidate.message, {
        chat: normalizeText(this.config.weflowCanaryDisplayName),
        chatUsername: talker,
        messages: rows,
        failures: [],
        canaryOnly: true,
      });
      if (accepted === false) {
        this.cursor.lastPolledAt = new Date().toISOString();
        saveCursor(this.config.weflowCanaryInboxCursorFile, this.cursor);
        return { status: "deferred", fetched: rows.length, candidates: candidates.length, processed };
      }
      this.remember(candidate);
      processed += 1;
      // Commit after every accepted marker. A process stop can at most replay
      // the current idempotent marker, never silently jump over a failed one.
      saveCursor(this.config.weflowCanaryInboxCursorFile, this.cursor);
    }
    this.cursor.lastPolledAt = new Date().toISOString();
    saveCursor(this.config.weflowCanaryInboxCursorFile, this.cursor);
    return { status: "ok", fetched: rows.length, candidates: candidates.length, processed };
  }

  hasSeen(candidate) {
    if (this.cursor.seenIdentities.includes(candidate.identity)) return true;
    return candidate.localId > 0n && candidate.localId <= BigInt(this.cursor.lastLocalId || "0");
  }

  remember(candidate) {
    this.cursor.talker = normalizeText(this.config.weflowCanaryChat);
    if (candidate.localId > BigInt(this.cursor.lastLocalId || "0")) {
      this.cursor.lastLocalId = candidate.localId.toString();
    }
    this.cursor.seenIdentities = [
      ...this.cursor.seenIdentities.filter((value) => value !== candidate.identity),
      candidate.identity,
    ].slice(-MAX_SEEN_IDENTITIES);
    this.cursor.updatedAt = new Date().toISOString();
  }
}

function buildCandidate(row, { talker = "" } = {}) {
  if (!row || typeof row !== "object" || !isOutgoing(row)) return null;
  const expectedTalker = normalizeText(talker);
  const sender = normalizeText(row.senderUsername ?? row.sender_username);
  if (expectedTalker && sender !== expectedTalker) return null;
  const text = readText(row);
  if (!text.startsWith(RESERVED_PREFIX)) return null;
  const localIdText = positiveIntegerText(row.localId ?? row.local_id ?? row.id);
  const serverId = normalizeText(row.serverId ?? row.server_id ?? row.msgId ?? row.msg_id);
  if (!localIdText && !serverId) return null;
  const identity = localIdText ? `local:${localIdText}` : `server:${serverId}`;
  return {
    identity,
    localId: localIdText ? BigInt(localIdText) : 0n,
    message: {
      id: serverId || localIdText,
      localId: localIdText,
      direction: "outgoing",
      text,
      receivedAt: normalizeReceivedAt(row),
      contentKind: "text",
      kind: "text",
    },
  };
}

function compareCandidates(left, right) {
  if (left.localId > 0n && right.localId > 0n && left.localId !== right.localId) {
    return left.localId < right.localId ? -1 : 1;
  }
  return left.identity.localeCompare(right.identity);
}

function isOutgoing(row) {
  const sent = row?.isSend ?? row?.is_send;
  return sent === true || sent === 1 || sent === "1"
    || normalizeText(row?.direction).toLowerCase() === "outgoing";
}

function readText(row) {
  for (const key of ["parsedContent", "parsed_content", "content", "text"]) {
    const value = normalizeText(row?.[key]);
    if (value) return value;
  }
  return "";
}

function normalizeReceivedAt(row) {
  const raw = row?.createTime ?? row?.create_time ?? row?.timestamp;
  let numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    while (numeric >= 100_000_000_000) numeric /= 1_000;
    return new Date(numeric * 1_000).toISOString();
  }
  const parsed = Date.parse(normalizeText(raw));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function loadCursor(filePath, { talker } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.version === CURSOR_VERSION && normalizeText(parsed.talker) === normalizeText(talker)) {
      return {
        ...emptyCursor(talker),
        ...parsed,
        lastLocalId: positiveIntegerText(parsed.lastLocalId),
        seenIdentities: Array.isArray(parsed.seenIdentities)
          ? parsed.seenIdentities.map(normalizeText).filter(Boolean).slice(-MAX_SEEN_IDENTITIES)
          : [],
      };
    }
  } catch {}
  return emptyCursor(talker);
}

function emptyCursor(talker = "") {
  return {
    version: CURSOR_VERSION,
    talker: normalizeText(talker),
    lastLocalId: "",
    seenIdentities: [],
    updatedAt: "",
    lastPolledAt: "",
  };
}

function saveCursor(filePath, cursor) {
  const resolved = path.resolve(filePath || "");
  if (!filePath) throw new Error("WeFlow canary cursor file is required");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ ...cursor, version: CURSOR_VERSION }, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, resolved);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function extractMessages(payload) {
  if (Array.isArray(payload)) return payload.filter(isObject);
  for (const key of ["messages", "data", "items"]) {
    const candidate = payload?.[key];
    if (Array.isArray(candidate)) return candidate.filter(isObject);
    if (isObject(candidate)) {
      for (const nested of ["messages", "items", "list"]) {
        if (Array.isArray(candidate[nested])) return candidate[nested].filter(isObject);
      }
    }
  }
  throw new Error("WeFlow canary messages response did not contain a list");
}

function normalizeBaseUrl(value) {
  return normalizeText(value) || "http://127.0.0.1:5031";
}

function positiveIntegerText(value) {
  const text = normalizeText(value);
  try { return /^\d+$/.test(text) && BigInt(text) > 0n ? BigInt(text).toString() : ""; } catch { return ""; }
}

function normalizePositiveInt(value, fallback, minimum) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= minimum ? numeric : fallback;
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function delayUntilAbort(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      signal?.removeEventListener?.("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}

module.exports = {
  WeFlowCanaryInboxSource,
  buildCandidate,
  emptyCursor,
  loadCursor,
};
