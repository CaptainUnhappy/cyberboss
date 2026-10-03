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
    imageUpgrade = null,
    imageUpgradeWaitMs = 2_500,
    imageUpgradeCooldownMs = 30_000,
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
    // Injected: opening a conversation is the ONE thing here that takes the
    // foreground, so a test can assert the cooldown without a live client.
    this.imageUpgrade = typeof imageUpgrade === "function" ? imageUpgrade : null;
    this.imageUpgradeWaitMs = imageUpgradeWaitMs;
    this.imageUpgradeCooldownMs = imageUpgradeCooldownMs;
    this.imageUpgradeAt = new Map();
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
      // Detection lag: how long after WeChat stored a row the inbox noticed it.
      lastLagMs: 0,
      maxLagMs: 0,
      // Pictures that arrived as previews, and how many were upgraded to the
      // original by opening the conversation once.
      imageUpgrades: 0,
      imageUpgraded: 0,
      // What the model actually received, per picture. Measured 2026-10-03: the
      // operator could not tell a 171x180 preview from a 1280x1356 original in
      // the log, so "did the bot get the real picture?" was unanswerable without
      // reading the disk by hand.
      imageOriginal: 0,
      imageFallback: 0,
      imageThumbnail: 0,
      imageMissing: 0,
      lastImage: "",
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
      // A poll that costs more than its own interval pushes the next one out, and
      // that delay is invisible in the delivered/ack numbers - measured
      // 2026-10-03, a re-decrypting poll cost seconds and the "处理中" arrived
      // late with nothing in the log saying why.
      if (this.stats.lastPollMs > Math.max(500, this.pollIntervalMs)) {
        this.logger.warn?.(
          `[cyberboss] wechat-db inbox slow poll costMs=${this.stats.lastPollMs} `
          + `intervalMs=${this.pollIntervalMs} chats=${this.chats.length}`
        );
      }
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

  /**
   * Ask the desktop client for the original of a picture it has only previewed.
   *
   * Measured 2026-10-03: WeChat writes `<md5>_t.dat` (a 94x210 preview) the moment
   * a picture arrives and the full `<md5>.dat` only when the conversation is
   * rendered - the original in that case appeared 22 seconds later, exactly when
   * the bot opened the chat to send its reply. Reading pixels cannot fetch what
   * the client has not downloaded, and the CDN route was tried first and does not
   * work (the message's `cdnthumburl` locator answers HTTP 400 on
   * novac2c.cdn.weixin.qq.com whatever the parameter shape; see the note).
   *
   * So: open that one conversation, wait a moment, read the database again, and
   * hand over the original if it arrived. Bounded by a per-chat cooldown so a
   * chat full of previews cannot turn the desktop into a slideshow.
   */
  async upgradeThumbnailImages(snapshots) {
    if (!this.imageUpgrade) {
      return snapshots;
    }
    const stale = snapshots.filter((snapshot, index) => (
      Array.isArray(snapshot?.messages)
      && snapshot.messages.some((message) => normalizeText(message?.imageQuality) === "thumbnail")
      && !this.isUpgradeCoolingDown(index, snapshot)
    ));
    if (!stale.length) {
      return snapshots;
    }
    const upgraded = snapshots.slice();
    for (const snapshot of stale) {
      const index = snapshots.indexOf(snapshot);
      const peer = normalizeText(snapshot?.displayName) || normalizeText(snapshot?.chatUsername);
      const talker = normalizeText(snapshot?.talker) || normalizeText(snapshot?.chatUsername);
      try {
        const opened = await this.imageUpgrade(peer, talker);
        if (opened === false) {
          continue;
        }
        this.markUpgradeAttempt(index, snapshot);
        await sleep(this.imageUpgradeWaitMs);
        const fresh = await this.worker.snapshots({ chats: [talker], limit: this.historyLimit });
        const refreshed = Array.isArray(fresh?.chats) ? fresh.chats[0] : null;
        if (!refreshed) {
          continue;
        }
        const before = new Map((snapshot.messages || []).map((message) => [normalizeText(message?.id), message]));
        const after = new Map((refreshed.messages || []).map((message) => [normalizeText(message?.id), message]));
        let improved = 0;
        const better = [];
        for (const [id, message] of before) {
          const next = after.get(id);
          if (next && normalizeText(next.imageQuality) === "original"
            && normalizeText(message.imageQuality) !== "original") {
            improved += 1;
            better.push(`${message.imageSize || "?"}->${next.imageSize || "?"}`);
          }
        }
        upgraded[index] = {
          ...refreshed,
          messages: (refreshed.messages || []).map((message) => {
            const previous = before.get(normalizeText(message?.id));
            // Keep the preview when the re-read did not improve on it: a
            // thumbnail is still better than nothing while the client thinks.
            return previous
              && normalizeText(previous.imageQuality) === "thumbnail"
              && normalizeText(message.imageQuality) !== "original"
              ? previous
              : message;
          }),
        };
        this.stats.imageUpgrades += 1;
        if (improved) {
          this.stats.imageUpgraded += improved;
        }
        this.logger.log?.(
          `[cyberboss] wechat-db image upgrade chat=${peer} improved=${improved} `
          + `waitedMs=${this.imageUpgradeWaitMs}`
          + (better.length ? ` size=${better.join(",")}` : "")
        );
        if (!improved) {
          // Report the state the turn will actually run with. Silence here is how
          // a preview reaches the model while every counter says "upgraded".
          const stuck = (upgraded[index].messages || []).filter(
            (message) => normalizeText(message?.imageQuality) === "thumbnail"
          );
          if (stuck.length) {
            const first = stuck[0];
            this.logger.warn?.(
              `[cyberboss] wechat-db image upgrade chat=${peer} still a preview after `
              + `${this.imageUpgradeWaitMs}ms: ${stuck.length} picture(s) `
              + `size=${normalizeText(first.imageSize) || "unknown"} `
              + `source=${normalizeText(first.imageSource) || "unknown"}; the client has nothing better on disk`
            );
          }
        }
      } catch (error) {
        this.logger.warn?.(`[cyberboss] wechat-db image upgrade failed chat=${peer}: ${error.message}`);
      }
    }
    return upgraded;
  }

  isUpgradeCoolingDown(index, snapshot) {
    const key = normalizeText(snapshot?.talker) || normalizeText(snapshot?.chatUsername) || String(index);
    const last = Number(this.imageUpgradeAt.get(key) || 0);
    return Date.now() - last < this.imageUpgradeCooldownMs;
  }

  markUpgradeAttempt(index, snapshot) {
    const key = normalizeText(snapshot?.talker) || normalizeText(snapshot?.chatUsername) || String(index);
    this.imageUpgradeAt.set(key, Date.now());
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
    let snapshots = Array.isArray(payload?.chats) ? payload.chats : [];
    const failures = Array.isArray(payload?.failures) ? payload.failures : [];
    // A picture whose original is not on disk yet: WeChat only downloads it when
    // the conversation is shown, so ask for it once, then read the database again.
    snapshots = await this.upgradeThumbnailImages(snapshots);
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
          // How long the bot took to NOTICE: from the moment WeChat stored the row
          // to the moment this poll handed it over. This is the first half of the
          // operator's "处理中 is late" complaint, and without it the only number
          // available was the ack's total latency, which cannot say whether the
          // time went into noticing or into sending.
          const lagMs = message.timestamp ? Date.now() - message.timestamp * 1000 : 0;
          if (lagMs > 0) {
            this.stats.lastLagMs = lagMs;
            this.stats.maxLagMs = Math.max(this.stats.maxLagMs || 0, lagMs);
          }
          const accepted = await this.onMessage(buildEnvelope(message, { peer, talker }), chatSnapshot, { lagMs });
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
          this.noteImage(message, peer);
          this.logger.log?.(
            `[cyberboss] wechat-db inbox delivered talker=${talker} localId=${message.localId} `
            + `direction=${message.direction} lagMs=${lagMs} pollMs=${this.pollIntervalMs}`
          );
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
        + `lastPollMs=${this.stats.lastPollMs} lastLagMs=${this.stats.lastLagMs} maxLagMs=${this.stats.maxLagMs} `
        + `imageUpgrades=${this.stats.imageUpgrades} imageUpgraded=${this.stats.imageUpgraded} `
        + `imageOriginal=${this.stats.imageOriginal} imageFallback=${this.stats.imageFallback} `
        + `imageThumbnail=${this.stats.imageThumbnail} imageMissing=${this.stats.imageMissing}`
      );
    }
    return {
      status: firstSnapshot && !this.replayOnStart ? "baselined" : "ok",
      processed,
      failures: failures.length,
    };
  }

  /** Is this outgoing row something this bot sent (rather than the operator)? */
  isOwnEcho(peer, text) {    if (!this.ledger || typeof this.ledger.matches !== "function") {
      return false;
    }
    try {
      return Boolean(this.ledger.matches(peer, text));
    } catch (error) {
      this.logger.warn?.(`[cyberboss] wechat-db echo check failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Record what a delivered picture actually is, and say it in the log.
   *
   * The operator's complaint was "the bot did not get the original picture", and
   * for a whole day the log could not confirm or deny it: a delivered image was
   * one word (`kind=image`) whether the file was 171x180 or 1280x1356. These four
   * counters are what make the next question answerable from the log alone.
   */
  noteImage(message, peer) {
    if (normalizeText(message?.kind) !== "image") {
      return;
    }
    const quality = normalizeText(message.imageQuality) || "missing";
    const size = normalizeText(message.imageSize) || "unknown";
    const source = normalizeText(message.imageSource) || "unknown";
    if (quality === "original") {
      this.stats.imageOriginal += 1;
    } else if (quality === "thumbnail") {
      this.stats.imageThumbnail += 1;
    } else if (quality === "missing") {
      this.stats.imageMissing += 1;
    } else {
      this.stats.imageFallback += 1;
    }
    this.stats.lastImage = `${quality} ${size} ${source}`;
    const line = `[cyberboss] wechat-db inbox image chat=${peer} quality=${quality} `
      + `size=${size} source=${source}`;
    // A picture the model will see as a preview (or not at all) is a defect the
    // operator has to be able to find; a full-size one is routine.
    if (quality === "original" || quality === "fallback") {
      this.logger.log?.(line);
    } else {
      this.logger.warn?.(line);
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
    attachments: message.attachments,
    // Which file the picture came from, and how big it is. Carried into the turn
    // so a reply that says "this is 171x180" is checkable against the row that
    // produced it.
    imageQuality: message.imageQuality,
    imageSize: message.imageSize,
    imageSource: message.imageSource,
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
    // `original` / `thumbnail` / `fallback` / `missing`: whether the picture on
    // disk is the real one. The source opens the conversation once when it is only
    // a preview.
    imageQuality: normalizeText(value.imageQuality),
    // Which file that was and how many pixels it has, on the message: the pair
    // that turns "the bot got a picture" into "the bot got the 1280x1356 one".
    imageSize: normalizeText(value.imageSize),
    imageSource: normalizeText(value.imageSource),
    // Media the reader already put on disk (a decrypted image, say). The app's
    // attachment persistence takes it from here; dropping it would turn every
    // picture back into the "[图片]" the operator complained about.
    attachments: normalizeLocalAttachments(value.attachments),
  };
}

function normalizeLocalAttachments(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => item && typeof item === "object" && normalizeText(item.path))
    .map((item) => ({
      kind: normalizeText(item.kind) || "file",
      path: item.path,
      fileName: normalizeText(item.fileName) || path.basename(item.path),
      origin: normalizeText(item.origin) || "direct",
      attachmentRef: normalizeText(item.attachmentRef),
    }));
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

/** Synchronous pause; used only between "open the chat" and "read it again". */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(ms) || 0));
}

module.exports = {
  WechatDbInboxSource,
  buildEnvelope,
  normalizeSnapshotMessage,
  MAX_SEEN_IDS,
};
