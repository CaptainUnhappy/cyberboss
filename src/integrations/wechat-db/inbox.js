// inbox.js - the inbound source that reads the WeChat database itself.
//
// Why this exists: the RDP-era WeFlow reader is dead (its licence service
// stopped answering) and the CUA reader is blind in three ways that cost real
// behaviour -
//
//   * it sees a conversation ROW, so two messages sent a second apart collapse
//     into one event, and text is a truncated preview;
//   * it cannot tell who sent a row except by our own echo ledger;
//   * anything in a conversation that is not open is invisible.
//
// A database row has none of those limits: it carries the sender's wxid, the
// server id, the full body and a direction that is read rather than guessed. It
// also costs nothing to look at, so the poll can be fast and the bot can hear a
// chat nobody has opened.
//
// What it does NOT do: send. Replies still go out through the CUA writer (the
// same route the CUA inbox uses), so `snapshot.chatUsername` deliberately carries
// the chat's DISPLAY NAME - that is what the writer opens. The raw wxid travels
// alongside as `chatTalker` for logging and the ledger.

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const MAX_SEEN_IDS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_REPLAY_LIMIT = 20;

class WechatDbInboxSource {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {Function} options.onMessage   (message, snapshot) => Promise<boolean|void>
   * @param {object} options.worker        a WechatDbWorker (injected: testable, shared)
   * @param {string[]} [options.chats]     talkers or display names to watch
   * @param {object} [options.ledger]      echo ledger shared with the CUA sender
   * @param {Function} [options.isReady]   gate: only dispatch when a reply route exists
   */
  constructor({
    config = {},
    onMessage,
    worker,
    chats = [],
    ledger = null,
    isReady = () => true,
    logger = console,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    historyLimit = DEFAULT_HISTORY_LIMIT,
    replayOnStart = false,
    replayLimit = DEFAULT_REPLAY_LIMIT,
  } = {}) {
    if (typeof onMessage !== "function") {
      throw new Error("WechatDbInboxSource needs an onMessage callback");
    }
    if (!worker || typeof worker.snapshots !== "function") {
      throw new Error("WechatDbInboxSource needs a WechatDbWorker");
    }
    this.config = config;
    this.onMessage = onMessage;
    this.worker = worker;
    this.chats = chats.slice();
    this.ledger = ledger;
    this.isReady = isReady;
    this.logger = logger;
    this.pollIntervalMs = pollIntervalMs;
    this.historyLimit = historyLimit;
    this.replayOnStart = replayOnStart;
    this.replayLimit = replayLimit;
    this.state = loadCursorState(config.wechatDbInboxCursorFile);
    this.running = false;
    this.timer = null;
    this.inFlight = null;
    this.stats = {
      polls: 0,
      delivered: 0,
      suppressed: 0,
      deferred: 0,
      errors: 0,
      lastError: "",
      lastPollAt: "",
      lastPollMs: 0,
    };
  }

  async start() {
    if (this.running) {
      return this;
    }
    this.running = true;
    this.logger.log?.(
      `[cyberboss] wechat-db inbox enabled chats=${JSON.stringify(this.chats)} `
      + `pollMs=${this.pollIntervalMs} limit=${this.historyLimit} `
      + `replayOnStart=${Boolean(this.replayOnStart)}`
    );
    // The first poll is the baseline: everything already in the database is old
    // news, and replaying it would answer yesterday's conversation on every boot.
    await this.runCycle();
    this.scheduleNext();
    return this;
  }

  async stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await Promise.resolve(this.inFlight).catch(() => {});
    return this;
  }

  scheduleNext() {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.runCycle().finally(() => {
        this.inFlight = null;
        this.scheduleNext();
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async runCycle() {
    const startedAt = Date.now();
    try {
      const result = await this.pollOnce();
      this.stats.lastPollMs = Date.now() - startedAt;
      return result;
    } catch (error) {
      this.stats.errors += 1;
      this.stats.lastError = error instanceof Error ? error.message : String(error || "");
      // A reader that stopped answering looks exactly like a quiet chat from the
      // outside, so this is logged at error level rather than swallowed.
      this.logger.error?.(`[cyberboss] wechat-db inbox read failed: ${this.stats.lastError}`);
      return { status: "error", processed: 0, error: this.stats.lastError };
    }
  }

  /** One poll: read every watched chat, hand new rows to the app. */
  async pollOnce() {
    if (!await this.isReady()) {
      this.stats.deferred += 1;
      return { status: "waiting_for_reply_target", processed: 0 };
    }
    const payload = await this.worker.snapshots({
      chats: this.chats,
      limit: this.historyLimit,
    });
    const snapshots = Array.isArray(payload?.chats) ? payload.chats : [];
    const failures = Array.isArray(payload?.failures) ? payload.failures : [];
    for (const failure of failures) {
      this.logger.warn?.(`[cyberboss] wechat-db inbox could not read a chat: ${failure}`);
    }
    this.stats.polls += 1;
    this.stats.lastPollAt = new Date().toISOString();

    const firstSnapshot = !this.state.initialized;
    const replayIds = firstSnapshot && this.replayOnStart
      ? new Set(collectIncoming(snapshots).slice(-this.replayLimit).map((item) => item.message.id))
      : new Set();
    let processed = 0;

    for (const snapshot of snapshots) {
      const peer = normalizeText(snapshot?.displayName) || normalizeText(snapshot?.chatUsername);
      const talker = normalizeText(snapshot?.talker) || normalizeText(snapshot?.chatUsername);
      const chatSnapshot = {
        chat: normalizeText(snapshot?.chat),
        // The CUA writer opens a conversation by its displayed name, so that is
        // what the reply route has to carry.
        chatUsername: peer,
        chatTalker: talker,
      };
      const seen = new Set(this.state.seenIds);
      for (const raw of Array.isArray(snapshot?.messages) ? snapshot.messages : []) {
        const message = normalizeSnapshotMessage(raw);
        if (!message || seen.has(message.id)) {
          continue;
        }
        const ownEcho = message.direction === "outgoing" && this.isOwnEcho(peer, message.text);
        if (ownEcho) {
          this.stats.suppressed += 1;
        }
        const shouldDispatch = !ownEcho
          && (!firstSnapshot || replayIds.has(message.id));
        if (shouldDispatch) {
          const accepted = await this.onMessage(buildEnvelope(message, { peer, talker }), chatSnapshot);
          if (accepted === false) {
            // Not accepted means "ask me again later" (no reply route yet, the
            // ledger has not caught up). Leave it unseen so the next poll
            // retries instead of dropping a real message on the floor.
            this.stats.deferred += 1;
            await this.saveState();
            return { status: "deferred", processed };
          }
          processed += 1;
          this.stats.delivered += 1;
        }
        this.rememberSeen(message.id);
        seen.add(message.id);
      }
    }
    if (!this.state.initialized) {
      this.state.initialized = true;
    }
    await this.saveState();
    // A periodic, information-bearing line. Without it "the bot is quiet" and
    // "the bot cannot hear" look identical from outside the process, and a
    // channel whose whole job is to answer people must never look healthy while
    // it is deaf.
    if (this.stats.polls <= 1 || this.stats.polls % 30 === 0) {
      this.logger.log?.(
        `[cyberboss] wechat-db inbox stats polls=${this.stats.polls} delivered=${this.stats.delivered} `
        + `suppressed=${this.stats.suppressed} deferred=${this.stats.deferred} errors=${this.stats.errors} `
        + `lastPollMs=${this.stats.lastPollMs}`
      );
    }
    return {
      status: firstSnapshot && !this.replayOnStart ? "baselined" : "ok",
      processed,
      failures: failures.length,
    };
  }

  /** Is this outgoing row something this bot sent (rather than the operator)? */
  isOwnEcho(peer, text) {
    if (!this.ledger || typeof this.ledger.matches !== "function") {
      return false;
    }
    try {
      return Boolean(this.ledger.matches(peer, text));
    } catch (error) {
      this.logger.warn?.(`[cyberboss] wechat-db echo check failed: ${error.message}`);
      return false;
    }
  }

  rememberSeen(messageId) {
    const normalized = normalizeText(messageId);
    if (!normalized) {
      return;
    }
    this.state.seenIds = this.state.seenIds.filter((item) => item !== normalized);
    this.state.seenIds.push(normalized);
    if (this.state.seenIds.length > MAX_SEEN_IDS) {
      this.state.seenIds = this.state.seenIds.slice(-MAX_SEEN_IDS);
    }
  }

  async saveState() {
    const filePath = normalizeText(this.config.wechatDbInboxCursorFile);
    if (!filePath) {
      return;
    }
    this.state.lastPollAt = this.stats.lastPollAt;
    await writeJsonAtomic(filePath, this.state);
  }

  describe() {
    return {
      id: "wechat-db-inbox",
      kind: "inbound-source",
      chats: this.chats.slice(),
      pollIntervalMs: this.pollIntervalMs,
      stats: { ...this.stats },
      worker: typeof this.worker.describe === "function" ? this.worker.describe() : null,
    };
  }
}

/**
 * The envelope the app's WeFlow-style handler expects.
 *
 * `provider` and `source` say where this came from; `directionVerified` is true
 * because a database row states the sender instead of leaving it to be inferred
 * from pixels.
 */
function buildEnvelope(message, { peer, talker }) {
  return {
    id: message.id,
    messageId: message.id,
    pendingId: message.id,
    localId: String(message.localId),
    serverId: message.serverId,
    talker,
    senderId: message.senderId || talker,
    provider: "wechat-db",
    chatId: `weflow:${peer}`,
    text: message.text,
    direction: message.direction,
    directionVerified: true,
    origin: message.direction === "outgoing" ? "self_manual" : "",
    contentKind: message.kind,
    kind: message.kind,
    title: message.title,
    url: message.url,
    timestamp: message.timestamp,
    receivedAt: message.receivedAt,
    quotedContexts: message.quotedContexts,
    attachments: [],
    attachmentFailures: [],
    source: "wechat-db",
    confidence: "db-row",
    isGroup: message.isGroup,
  };
}

function collectIncoming(snapshots) {
  const items = [];
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    for (const raw of Array.isArray(snapshot?.messages) ? snapshot.messages : []) {
      const message = normalizeSnapshotMessage(raw);
      if (message && message.direction === "incoming") {
        items.push({ message, snapshot });
      }
    }
  }
  return items.sort((left, right) => (
    left.message.timestamp - right.message.timestamp || left.message.localId - right.message.localId
  ));
}

function normalizeSnapshotMessage(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const id = normalizeText(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    localId: toInt(value.localId),
    serverId: normalizeText(value.serverId),
    timestamp: toInt(value.timestamp),
    receivedAt: normalizeText(value.receivedAt),
    direction: normalizeText(value.direction).toLowerCase() === "outgoing" ? "outgoing" : "incoming",
    kind: normalizeText(value.kind) || "text",
    title: normalizeText(value.title),
    text: String(value.text ?? ""),
    url: normalizeText(value.url),
    senderId: normalizeText(value.senderId),
    isGroup: Boolean(value.isGroup),
    quotedContexts: Array.isArray(value.quotedContexts) ? value.quotedContexts : [],
  };
}

function loadCursorState(filePath) {
  const empty = { version: 1, initialized: false, seenIds: [], lastPollAt: "" };
  const normalized = normalizeText(filePath);
  if (!normalized) {
    return empty;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(normalized, "utf8"));
    return {
      ...empty,
      initialized: Boolean(parsed?.initialized),
      seenIds: Array.isArray(parsed?.seenIds)
        ? parsed.seenIds.map((item) => normalizeText(item)).filter(Boolean).slice(-MAX_SEEN_IDS)
        : [],
      lastPollAt: normalizeText(parsed?.lastPollAt),
    };
  } catch {
    return empty;
  }
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fsPromises.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fsPromises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsPromises.rename(tempPath, filePath);
}

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  WechatDbInboxSource,
  buildEnvelope,
  normalizeSnapshotMessage,
  MAX_SEEN_IDS,
};
