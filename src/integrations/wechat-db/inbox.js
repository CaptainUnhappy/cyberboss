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
    imageUpgradeNoticeMs = 2_500,
    imageUpgradeDeadlineMs = 90_000,
    onImageUpgraded = null,
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
    // How long a poll waits for the original of a picture it has ALREADY handed
    // over: this is the wait that no longer delays the acknowledgement, so it can
    // be longer than the one before delivery.
    this.imageUpgradeNoticeMs = imageUpgradeNoticeMs;
    // How long a preview stays worth chasing before the entry is dropped. Past
    // this the turn has long started and nothing can be swapped into it.
    this.imageUpgradeDeadlineMs = imageUpgradeDeadlineMs;
    // Called when a picture that was delivered as a preview turns out to have a
    // better copy. The app uses it to swap the attachment in a turn it has not
    // started yet; it must never start a second turn.
    this.onImageUpgraded = typeof onImageUpgraded === "function" ? onImageUpgraded : null;
    this.pendingImageUpgrades = new Map();
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
   * Open the conversation once when a picture is only a preview, then read the
   * database again and keep whichever answer is better.
   *
   * Measured 2026-10-03: WeChat writes `<md5>_t.dat` (a 157x210 preview) the
   * moment a picture arrives and the full `<md5>.dat` **14 seconds later**. The
   * original in that case is the only copy that will ever exist - opening the
   * conversation afterwards does NOT bring it back (measured: 2.5 minutes, no
   * re-download), so it has to be caught as it lands.
   *
   * The wait is bounded by the caller, because the caller is what decides whether
   * the acknowledgement ("处理中") waits with it. It must not: the operator's rule
   * is "the formal reply may be late, the acknowledgement may not".
   */
  async upgradeThumbnailImages(snapshots, { maxWaitMs = 0, sessionMs = 0 } = {}) {
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
    const deadline = Date.now() + Math.max(0, maxWaitMs);
    for (const snapshot of stale) {
      const index = snapshots.indexOf(snapshot);
      const peer = normalizeText(snapshot?.displayName) || normalizeText(snapshot?.chatUsername);
      const talker = normalizeText(snapshot?.talker) || normalizeText(snapshot?.chatUsername);
      let current = snapshot;
      try {
        // ONE foreground click per picture per cooldown. The waiting that follows
        // is re-reading, not re-opening: the conversation is already on screen, so
        // the client is downloading what it is going to download.
        const opened = await this.imageUpgrade(peer, talker);
        if (opened !== false) {
          this.markUpgradeAttempt(index, snapshot);
          for (;;) {
            // The gap has to exceed the reader's own wait budget
            // (`CYBERBOSS_WECHAT_DB_IMAGE_WAIT_MS`, 8s by default) so each pass
            // re-resolves from disk instead of returning the reader's own answer.
            await sleep(Math.max(this.imageUpgradeWaitMs, sessionMs));
            const fresh = await this.worker.snapshots({ chats: [talker], limit: this.historyLimit });
            const refreshed = Array.isArray(fresh?.chats) ? fresh.chats[0] : null;
            if (!refreshed) {
              break;
            }
            current = this.mergeUpgrade(current, refreshed);
            if (!stillPreview(current) || Date.now() >= deadline) {
              break;
            }
          }
        }
      } catch (error) {
        this.logger.warn?.(`[cyberboss] wechat-db image upgrade failed chat=${peer}: ${error.message}`);
      }
      upgraded[index] = current;
      this.reportUpgrade(peer, snapshot, current);
    }
    return upgraded;
  }

  /**
   * Fold a re-read into the snapshot it came from.
   *
   * A picture this side declares a preview is replaced by the re-read whenever the
   * re-read did better (`original`/`fallback`) - and only then: keeping the preview
   * is better than losing the attachment while the client thinks. Any message the
   * re-read added (a text that arrived during the wait) is kept as well, because
   * dropping it would mean answering a later poll about an earlier state.
   */
  mergeUpgrade(before, refreshed) {
    const previous = new Map((before.messages || []).map((message) => [normalizeText(message?.id), message]));
    const improved = new Map();
    for (const message of refreshed.messages || []) {
      const id = normalizeText(message?.id);
      const old = previous.get(id);
      if (old && normalizeText(old.imageQuality) === "thumbnail"
        && normalizeText(message.imageQuality) === "thumbnail") {
        improved.set(id, old);
      } else {
        improved.set(id, message);
      }
    }
    for (const [id, message] of previous) {
      if (!improved.has(id)) {
        improved.set(id, message);
      }
    }
    const order = (refreshed.messages || []).map((message) => normalizeText(message?.id));
    for (const id of previous.keys()) {
      if (!order.includes(id)) {
        order.push(id);
      }
    }
    return {
      ...refreshed,
      messages: order.map((id) => improved.get(id)).filter(Boolean),
      upgradeBefore: before,
    };
  }

  /** What an upgrade attempt did, said out loud either way. */
  reportUpgrade(peer, before, after) {
    const ids = new Set([...(before.messages || []), ...(after.messages || [])]
      .filter((message) => normalizeText(message?.imageQuality) === "thumbnail"
        || normalizeText(message?.imageQuality) === "original")
      .map((message) => normalizeText(message?.id)));
    let improved = 0;
    const better = [];
    const afterById = new Map((after.messages || []).map((message) => [normalizeText(message?.id), message]));
    for (const id of ids) {
      const old = (before.messages || []).find((message) => normalizeText(message?.id) === id);
      const next = afterById.get(id);
      if (old && next && normalizeText(next.imageQuality) === "original"
        && normalizeText(old.imageQuality) !== "original") {
        improved += 1;
        better.push(`${old.imageSize || "?"}->${next.imageSize || "?"}`);
      }
    }
    this.stats.imageUpgrades += 1;
    if (improved) {
      this.stats.imageUpgraded += improved;
    }
    this.logger.log?.(
      `[cyberboss] wechat-db image upgrade chat=${peer} improved=${improved} `
      + `waitedMs=${this.imageUpgradeWaitMs}`
      + (better.length ? ` size=${better.join(",")}` : "")
    );
    if (improved || !stillPreview(after)) {
      return;
    }
    // Report the state the turn will run with. Silence here is how a preview
    // reaches the model while every counter says "upgraded".
    const stuck = (after.messages || []).filter(
      (message) => normalizeText(message?.imageQuality) === "thumbnail"
    );
    if (!stuck.length) {
      return;
    }
    const first = stuck[0];
    this.logger.warn?.(
      `[cyberboss] wechat-db image upgrade chat=${peer} still a preview after `
      + `${this.imageUpgradeWaitMs}ms: ${stuck.length} picture(s) `
      + `size=${normalizeText(first.imageSize) || "unknown"} `
      + `source=${normalizeText(first.imageSource) || "unknown"}; the client has nothing better on disk`
    );
  }

  /**
   * Note that this message was delivered while its picture was only a preview.
   *
   * Returns the tracking record when the caller should treat the message as
   * "delivered early, original expected" - which is exactly when the app has to
   * be told later that the picture got better.
   */
  rememberPendingImageUpgrade(item) {
    const message = item.message;
    if (!this.onImageUpgraded || normalizeText(message?.imageQuality) !== "thumbnail") {
      return null;
    }
    const existing = this.pendingImageUpgrades.get(normalizeText(message.id));
    if (existing) {
      // Keep the FIRST sighting: `atMs` is the start of the wait budget and
      // `deliveredAtMs` is what stops the row from being delivered twice, so a
      // later poll must not reset either of them.
      return existing;
    }
    const key = normalizeText(item.talker) || normalizeText(item.peer);
    const entry = {
      id: message.id,
      talker: key,
      peer: normalizeText(item.peer),
      atMs: Date.now(),
      deliveredAtMs: 0,
      first: `${normalizeText(message.imageSize) || "unknown"} ${normalizeText(message.imageSource) || "unknown"}`,
      quality: normalizeText(message.imageQuality),
      // The app persists the picture when it is delivered, so this exact state
      // has already been announced. Without this the same unchanged preview was
      // handed over once more inside the same poll - two copies of one picture in
      // `<state>/inbox/<date>/` instead of one.
      announcedFingerprint: `${normalizeText(message.imageSize)}|${normalizeText(message.imageSource)}`,
    };
    this.pendingImageUpgrades.set(message.id, entry);
    return entry;
  }

  pendingImageUpgradeFor(messageId) {
    return this.pendingImageUpgrades.get(normalizeText(messageId)) || null;
  }

  isAwaitingImageUpgrade(message) {
    return Boolean(this.pendingImageUpgradeFor(message?.id));
  }

  clearPendingImageUpgrade(message) {
    this.pendingImageUpgrades.delete(normalizeText(message?.id));
  }

  /**
   * Tell the app that a picture it already handed over has a better copy now.
   *
   * The app swaps the attachment inside the turn it has NOT started yet; if that
   * turn already ran, the callback is a no-op on its side. What must never happen
   * here is a second turn: the operator asked for the original picture, not for a
   * second answer.
   */
  notifyImageUpgraded(message, entry, snapshots) {
    const quality = normalizeText(message.imageQuality);
    if (quality !== "original" && quality !== "fallback") {
      return false;
    }
    const size = normalizeText(message.imageSize) || "unknown";
    this.stats.imageUpgrades += 1;
    this.stats.imageUpgraded += 1;
    this.pendingImageUpgrades.delete(entry.id);
    this.logger.log?.(
      `[cyberboss] wechat-db image upgrade chat=${entry.peer} improved=1 `
      + `size=${entry.first}->${size} source=${normalizeText(message.imageSource) || "unknown"}`
    );
    try {
      this.onImageUpgraded(message, {
        talker: entry.talker,
        peer: entry.peer,
        waitedMs: Date.now() - entry.atMs,
        quality,
        size,
        snapshots,
      });
    } catch (error) {
      this.logger.warn?.(`[cyberboss] wechat-db image upgrade handover failed: ${error.message}`);
    }
    return true;
  }

  /**
   * Give every picture that was delivered as a preview a chance to be upgraded,
   * once per poll, without opening any conversation again (the per-chat cooldown
   * already prevents a second click).
   *
   * A picture that is STILL a preview is only handed over when its fingerprint
   * changed. Without that rule the same unchanged preview was announced on every
   * poll, and the app persisted a fresh copy each time - measured 2026-10-04, 46
   * identical files in `<state>/inbox/<date>/` for two pictures, a file flood
   * caused by a "nothing changed" message.
   */
  async notifyPendingImageUpgrades(snapshots) {
    if (!this.onImageUpgraded || !this.pendingImageUpgrades.size) {
      return 0;
    }
    let improved = 0;
    for (const entry of [...this.pendingImageUpgrades.values()]) {
      const message = findByEnvelopeId(snapshots, entry.id);
      if (!message) {
        continue;
      }
      if (this.notifyImageUpgraded(message, entry, snapshots)) {
        improved += 1;
        continue;
      }
      const fingerprint = `${normalizeText(message.imageSize)}|${normalizeText(message.imageSource)}`;
      const announced = entry.announcedFingerprint === fingerprint;
      entry.announcedFingerprint = fingerprint;
      if (!announced) {
        // Better pixels are not always a better quality word: a `fallback` frame
        // that replaced a preview is worth handing over too.
        this.handOverBetterPicture(message, entry, snapshots);
      }
      if (Date.now() - entry.atMs > this.imageUpgradeDeadlineMs) {
        // The window is over: whatever the turn is going to run with, it is not
        // going to change, and holding the entry forever would only hide that.
        this.pendingImageUpgrades.delete(entry.id);
        this.logger.warn?.(
          `[cyberboss] wechat-db image upgrade chat=${entry.peer} gave up after `
          + `${Date.now() - entry.atMs}ms: still ${normalizeText(message.imageSize) || "unknown"} `
          + `from ${normalizeText(message.imageSource) || "unknown"}`
        );
      }
    }
    return improved;
  }

  /** A preview that became a `fallback` (a readable non-original) is still better. */
  handOverBetterPicture(message, entry, snapshots) {
    const quality = normalizeText(message.imageQuality);
    if (quality !== "fallback") {
      return false;
    }
    const size = normalizeText(message.imageSize) || "unknown";
    this.stats.imageUpgraded += 1;
    this.pendingImageUpgrades.delete(entry.id);
    this.logger.log?.(
      `[cyberboss] wechat-db image upgrade chat=${entry.peer} improved=1 `
      + `size=${entry.first}->${size} source=${normalizeText(message.imageSource) || "unknown"}`
    );
    try {
      this.onImageUpgraded(message, {
        talker: entry.talker,
        peer: entry.peer,
        waitedMs: Date.now() - entry.atMs,
        quality,
        size,
        snapshots,
      });
    } catch (error) {
      this.logger.warn?.(`[cyberboss] wechat-db image upgrade handover failed: ${error.message}`);
    }
    return true;
  }

  /**
   * Is it worth blocking this poll to wait for an original?
   *
   * Yes for a picture whose source files changed since the last look - that is a
   * client mid-download - and for one that has never been waited on. No for a
   * picture that has already been waited on and has not moved: the answer cannot
   * change, and the wait is charged to every chat this poll serves.
   */
  shouldWaitForImages(batch) {
    const fingerprints = new Map();
    for (const item of batch) {
      const message = item.message;
      if (normalizeText(message?.imageQuality) !== "thumbnail") {
        continue;
      }
      fingerprints.set(message.id, `${normalizeText(message.imageSize)}|${normalizeText(message.imageSource)}`);
    }
    let wait = false;
    for (const [id, fingerprint] of fingerprints) {
      const entry = this.pendingImageUpgrades.get(id);
      if (!entry) {
        continue;
      }
      entry.waits = Number(entry.waits || 0);
      if (!entry.waits || entry.fingerprint !== fingerprint) {
        wait = true;
      }
      entry.waits += 1;
      entry.fingerprint = fingerprint;
    }
    return wait;
  }

  isUpgradeCoolingDown(index, snapshot) {    const key = normalizeText(snapshot?.talker) || normalizeText(snapshot?.chatUsername) || String(index);
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
    // A picture whose original is not on disk yet: ask the client for it once. This
    // call DOES wait the short `imageUpgradeWaitMs` - long enough to catch a client
    // that was already downloading - but it deliberately does not wait the big
    // picture budget. That wait belongs after delivery, because delivery is what
    // triggers the acknowledgement ("处理中").
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
    const batch = collectBatch(snapshots, (peer, text) => this.isOwnEcho(peer, text));
    let processed = 0;

    // EVERY picture that is still a preview goes on the watch list - not just the
    // ones delivered on this poll. Tracking them only at delivery was a real bug
    // (caught 2026-10-03 by forcing the state on a live bot): a preview that
    // arrived before the baseline, or that was delivered an hour ago, was never
    // watched again, so the original landing later changed nothing at all.
    for (const item of batch) {
      if (!item.echo && normalizeText(item.message?.imageQuality) === "thumbnail") {
        this.rememberPendingImageUpgrade(item);
      }
    }

    // The acknowledgement rides on delivery, so a preview is handed over the
    // moment it is seen. Measured 2026-10-03: WeChat stored a 157x210 preview 14s
    // before the only copy of the original that would ever exist, and the earlier
    // design waited here for the original, which pushed the acknowledgement out by
    // the whole image budget. The operator's rule is the other way round: the
    // formal reply may be late, the acknowledgement may not.
    for (const item of batch) {
      if (item.echo || !isDeliverable(item.message, { firstSnapshot, replayIds })) {
        continue;
      }
      const pending = this.pendingImageUpgradeFor(item.message.id);
      if (!pending || pending.deliveredAtMs) {
        continue;
      }
      const lagMs = item.message.timestamp ? Date.now() - item.message.timestamp * 1000 : 0;
      const accepted = await this.onMessage(
        buildEnvelope(item.message, item),
        item.chatSnapshot,
        { lagMs },
      );
      if (accepted === false) {
        this.stats.deferred += 1;
        await this.saveState();
        return { status: "deferred", processed };
      }
      processed += 1;
      this.stats.delivered += 1;
      pending.deliveredAtMs = Date.now();
      // Seen right here: the loop below must not hand the same row over again just
      // because the picture improved (an upgrade is a swap inside the pending
      // turn, not a second turn).
      this.rememberSeen(item.message.id);
      this.noteImage(item.message, item.peer);
      this.logger.log?.(
        `[cyberboss] wechat-db inbox delivered talker=${item.talker} localId=${item.message.localId} `
        + `direction=${item.message.direction} lagMs=${lagMs} early=preview`
      );
    }

    // Now spend the picture budget: one conversation open (the per-chat cooldown
    // allows it only once), then re-read until the original lands or the budget is
    // gone. This happens AFTER the delivery above, which is what keeps the
    // acknowledgement fast.
    //
    // "Until it lands" is not "every poll": a picture whose source files have not
    // changed cannot answer differently, and waiting 2.5s for it on every poll
    // pushed the whole loop to 2.7-2.9s per cycle (measured 2026-10-04 in
    // production, `slow poll costMs=2852` on repeat). The first look at a preview
    // pays the wait; every later look at an unchanged one skips it.
    if (this.pendingImageUpgrades.size && this.shouldWaitForImages(batch)) {
      await sleep(Math.max(this.imageUpgradeWaitMs, this.imageUpgradeNoticeMs));
      const fresh = await this.worker.snapshots({ chats: this.chats, limit: this.historyLimit });
      if (Array.isArray(fresh?.chats) && fresh.chats.length) {
        snapshots = await this.upgradeThumbnailImages(fresh.chats);
        await this.notifyPendingImageUpgrades(snapshots);
      }
    }

    // How long the bot took to NOTICE: from the moment WeChat stored the row to
    // the moment this poll handed it over. This is the first half of the
    // operator's "处理中 is late" complaint, and without it the only number
    // available was the ack's total latency, which cannot say whether the time
    // went into noticing or into sending.
    //
    // Built AFTER the early handovers above on purpose: the loop marks those rows
    // seen, and a set snapshotted before that would deliver every preview twice
    // (measured 2026-10-04 in production - `localId=66 … early=preview` appeared
    // twice in one poll).
    const seen = new Set(this.state.seenIds);
    for (const item of batch) {
      const message = item.message;
      const peer = item.peer;
      const talker = item.talker;
      if (seen.has(message.id)) {
        continue;
      }
      const ownEcho = item.echo;
      if (ownEcho) {
        this.stats.suppressed += 1;
      }
      const shouldDispatch = !ownEcho && isDeliverable(message, { firstSnapshot, replayIds });
      if (shouldDispatch) {
        if (this.isAwaitingImageUpgrade(message)) {
          // Delivered once already (with its acknowledgement) and still waiting for
          // the picture: hand it over again only when we have something better, or
          // when its window is over. Delivering the preview early keeps the
          // acknowledgement fast; delivering it a second time unchanged would only
          // make noise.
          const first = this.pendingImageUpgradeFor(message.id);
          if (!first || first.deliveredAtMs) {
            this.rememberSeen(message.id);
            seen.add(message.id);
            continue;
          }
          first.deliveredAtMs = Date.now();
        }
        const lagMs = message.timestamp ? Date.now() - message.timestamp * 1000 : 0;
        if (lagMs > 0) {
          this.stats.lastLagMs = lagMs;
          this.stats.maxLagMs = Math.max(this.stats.maxLagMs || 0, lagMs);
        }
        const accepted = await this.onMessage(buildEnvelope(message, { peer, talker }), item.chatSnapshot, { lagMs });
        if (accepted === false) {
          // Not accepted means "ask me again later" (no reply route yet, the
          // ledger has not caught up). Leave it unseen so the next poll retries
          // instead of dropping a real message on the floor.
          this.stats.deferred += 1;
          await this.saveState();
          return { status: "deferred", processed };
        }
        processed += 1;
        this.stats.delivered += 1;
        this.noteImage(message, peer);
        this.clearPendingImageUpgrade(message);
        this.logger.log?.(
          `[cyberboss] wechat-db inbox delivered talker=${talker} localId=${message.localId} `
          + `direction=${message.direction} lagMs=${lagMs} pollMs=${this.pollIntervalMs}`
        );
      }
      this.rememberSeen(message.id);
      seen.add(message.id);
    }
    await this.notifyPendingImageUpgrades(snapshots);
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

/**
 * Is any picture in this snapshot still "a preview and nothing better"?
 *
 * The question that decides whether another look is worth taking. `missing` is NOT
 * a preview here: a picture whose file cannot be read at all will not improve by
 * waiting, and waiting on it would hold a text message hostage.
 */
function stillPreview(snapshot) {
  return (snapshot?.messages || []).some(
    (message) => normalizeText(message?.imageQuality) === "thumbnail"
  );
}

/**
 * Every row this poll saw, in order, with the routing facts each one needs.
 *
 * A flat list rather than a per-snapshot loop: the delivery order is what decides
 * whether the acknowledgement goes out before the picture's wait, so it is worth
 * being able to read in one place.
 */
function collectBatch(snapshots, isOwnEcho) {
  const batch = [];
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const peer = normalizeText(snapshot?.displayName) || normalizeText(snapshot?.chatUsername);
    const talker = normalizeText(snapshot?.talker) || normalizeText(snapshot?.chatUsername);
    const chatSnapshot = {
      chat: normalizeText(snapshot?.chat),
      // The CUA writer opens a conversation by its displayed name, so that is
      // what the reply route has to carry.
      chatUsername: peer,
      chatTalker: talker,
    };
    for (const raw of Array.isArray(snapshot?.messages) ? snapshot.messages : []) {
      const message = normalizeSnapshotMessage(raw);
      if (!message) {
        continue;
      }
      batch.push({
        message,
        snapshot,
        chatSnapshot,
        peer,
        talker,
        echo: message.direction === "outgoing" && isOwnEcho(peer, message.text),
      });
    }
  }
  return batch;
}

/** Should this row be handed to the app (as opposed to suppressed or baselined)? */
function isDeliverable(message, { firstSnapshot, replayIds }) {
  return !firstSnapshot || replayIds.has(message.id);
}

/** The same message, as the freshest read of the database describes it. */
function findByEnvelopeId(snapshots, id) {
  const wanted = normalizeText(id);
  if (!wanted) {
    return null;
  }
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    for (const raw of Array.isArray(snapshot?.messages) ? snapshot.messages : []) {
      const message = normalizeSnapshotMessage(raw);
      if (message && message.id === wanted) {
        return message;
      }
    }
  }
  return null;
}

function collectIncoming(snapshots) {  const items = [];
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
