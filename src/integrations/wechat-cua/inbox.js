// inbox.js - the bot's inbound source on the Cua path.
//
// It polls the chat list through Cua and hands each observed message to the same
// callback the WeFlow source uses (`onMessage(message, { chatUsername })`), so the
// turn pipeline, the ledger classification, the canary and the pending-inbound
// store are all reused rather than reimplemented. That is deliberate: those
// layers encode months of hard-won behaviour about not answering yourself, not
// losing messages and not replying twice.
//
// Differences from the WeFlow source, stated plainly because they are real:
//
//   * **The identity is a display name, not a wxid.** WeChat's conversation rows
//     are labelled with the peer's name; the talker id only exists in the config
//     mapping (`CYBERBOSS_CUA_CHAT_BY_TALKER`). Everything the bot routes on must
//     therefore accept the name.
//   * **Text is a preview unless a deep read is allowed.** A row only carries the
//     last message, so rapid-fire messages collapse into one event; `deepRead`
//     opens the conversation and reads the ordered message list, at the cost of
//     one foreground click for whichever conversation is opened. Deep reads are
//     therefore opt-in and bounded by `deepReadCooldownMs` so a busy chat cannot
//     turn the desktop into a slideshow.
//   * **There is no server id and no revoke feed.** Ids are synthesised from
//     talker+text+time, which is stable enough for de-duplication but cannot
//     distinguish two identical messages sent in the same minute.

const { CuaSession, findWeChatWindow } = require("./client");
const { PreviewInboundSource } = require("./inbound");
const { SentLedger } = require("./loop");
const { ensureDriverRunning, isDaemonDown } = require("./daemon");

/** Stable-ish id for de-duplication: there is no server id on this path. */
function synthesizeId(event) {
  const seed = `${event.peer}\u0000${event.text}\u0000${event.time}\u0000${event.unread}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `cua-${(hash >>> 0).toString(16)}`;
}

class WeChatCuaInboxSource {
  /**
   * @param {object} options
   * @param {object} [options.config]        the bot config (for the mapping/allow list)
   * @param {Function} options.onMessage     (message, { chatUsername }) => Promise<boolean|void>
   * @param {CuaSession} [options.session]
   * @param {object} [options.target]        the WeChat window (resolved lazily if omitted)
   * @param {number} [options.pollMs]        how often the chat list is read
   * @param {boolean} [options.deepRead]     open a changed conversation to get every message
   * @param {number} [options.deepReadCooldownMs]
   * @param {SentLedger} [options.ledger]    echo ledger shared with the outbound sender
   * @param {Function} [options.ensureDriver] how to bring the Cua daemon back (injected)
   * @param {number} [options.recoverAfterFailures] consecutive failed polls before recovering
   * @param {number} [options.recoveryCooldownMs]  how often recovery may run
   */
  constructor({
    config = {},
    onMessage,
    session = new CuaSession(`cyberboss-inbox-${process.pid}`),
    target = null,
    pollMs = 3000,
    deepRead = false,
    deepReadCooldownMs = 20_000,
    conversationOpener = null,
    ledger = null,
    logger = console,
    ensureDriver = ensureDriverRunning,
    execDriver = undefined,
    spawnDriver = undefined,
    recoverAfterFailures = 3,
    recoveryCooldownMs = 60_000,
  } = {}) {
    if (typeof onMessage !== "function") {
      throw new Error("WeChatCuaInboxSource needs an onMessage callback");
    }
    this.config = config;
    this.onMessage = onMessage;
    this.session = session;
    this.target = target;
    this.pollMs = pollMs;
    this.deepRead = deepRead;
    this.conversationOpener = conversationOpener;
    this.deepReadCooldownMs = deepReadCooldownMs;
    this.ledger = ledger;
    this.logger = logger;
    this.ensureDriver = ensureDriver;
    this.execDriver = execDriver;
    this.spawnDriver = spawnDriver;
    this.recoverAfterFailures = recoverAfterFailures;
    this.recoveryCooldownMs = recoveryCooldownMs;
    this.timer = null;
    this.running = false;
    this.lastDeepReadAt = 0;
    this.lastRecoveryAt = 0;
    // so the low-frequency stats line can report a CHANGE in the free-direction path
    this.lastLoggedDirectionCount = 0;
    this.stats = { polls: 0, delivered: 0, errors: 0, suppressed: 0, consecutiveErrors: 0, recoveries: 0, lastRecovery: null };
  }

  /** Peer names the bot may answer. Empty means "whatever the inbox config says". */
  allowPeers() {
    const configured = String(this.config.wechatCuaAllowPeers || "").trim();
    if (configured) {
      return configured.split(",").map((item) => item.trim()).filter(Boolean);
    }
    // Fall back to the WeFlow inbox chats' display names, which the operator has
    // already curated; an empty list would mean "answer anyone", which is not a
    // safe default for a bot with a real account.
    const labels = this.config.weflowWindowLabels || {};
    const names = Object.values(labels).map((value) => String(value || "").trim()).filter(Boolean);
    return names;
  }

  resolveTarget() {
    if (!this.target) {
      this.target = findWeChatWindow(this.session);
    }
    return this.target;
  }

  async start() {
    if (this.timer) {
      return this;
    }
    const allow = this.allowPeers();
    // Injected so the deep path can open a conversation; without it the source
    // stays read-only and never takes the foreground.
    // The opener is the ONLY thing here that takes the foreground, so it is
    // wrapped in a cooldown and is injectable: a test can assert the cooldown
    // without a live client, and an operator can substitute a different opener.
    const openConversation = this.deepRead
      ? (session, target, peer) => {
        const now = Date.now();
        if (now - this.lastDeepReadAt < this.deepReadCooldownMs) {
          return false; // cooldown: do not steal the foreground again yet
        }
        this.lastDeepReadAt = now;
        if (typeof this.conversationOpener === "function") {
          try {
            return this.conversationOpener(session, target, peer) !== false;
          } catch (error) {
            this.logger.warn?.(`[cyberboss] cua inbox opener failed: ${error.message}`);
            return false;
          }
        }
        // Lazy require: keeps the module loadable without a live client.
        const { ensureConversation } = require("./client");
        try {
          ensureConversation(session, target, peer);
          return true;
        } catch (error) {
          this.logger.warn?.(`[cyberboss] cua inbox could not open ${JSON.stringify(peer)}: ${error.message}`);
          return false;
        }
      }
      : null;

    this.source = new PreviewInboundSource(this.resolveTarget(), {
      session: this.session,
      // An EMPTY allow-list must mean "nobody", never "everybody": a bot holding
      // a real WeChat account must not start answering strangers because a
      // variable was left unset. `PreviewInboundSource` treats null as
      // "unrestricted", so an unconfigured peer list is turned into a list that
      // matches nothing.
      allowPeers: allow.length ? allow : ["\u0000never-match"],
      deepRead: this.deepRead,
      openConversation,
    });
    // Prime immediately: the first poll establishes the baseline and must not
    // replay the whole chat list as new messages. A throw here is not fatal: the
    // bot still starts, and the recovery below reports why it is deaf.
    try {
      this.source.poll({
        isOwnEcho: (row, text) => Boolean(this.ledger && this.ledger.matches(row.peer, text || row.preview)),
      });
    } catch (error) {
      this.stats.errors += 1;
      this.logger.warn?.(`[cyberboss] cua inbox could not prime: ${error.message}`);
      this.recoverFromFailure(error);
    }
    this.running = true;
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        // pollOnce already counted the error and ran recovery; this is only the log.
        this.logger.warn?.(`[cyberboss] cua inbox poll failed: ${error.message}`);
      });
    }, this.pollMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
    this.logger.log?.(
      `[cyberboss] cua inbox enabled pollMs=${this.pollMs} deepRead=${this.deepRead} `
      // The foreground policy belongs in the startup line: without it, "why did the
      // bot (not) pop my window?" needs a code read, and an experiment can silently
      // run under the wrong policy (that happened on 2026-10-01).
      + `foregroundSwitch=${this.config?.wechatCuaNoForegroundSwitch ? "off (replies to closed chats are deferred)" : "on"} `
      + `peers=${JSON.stringify(allow)}`
    );
    return this;
  }

  /** One poll: read, translate, hand over. Returns how many were delivered. */
  async pollOnce() {
    if (!this.source) {
      return 0;
    }
    this.stats.polls += 1;
    let events;
    try {
      events = this.source.poll({
        isOwnEcho: (row, text) => {
          const suppressed = Boolean(this.ledger && this.ledger.matches(row.peer, text || row.preview));
          if (suppressed) {
            this.stats.suppressed += 1;
          }
          return suppressed;
        },
      });
    } catch (error) {
      // Every failure goes through the same recovery path, however the poll was
      // started (timer or a direct call), and still reaches the caller.
      this.stats.errors += 1;
      this.recoverFromFailure(error);
      throw error;
    }
    // Reading worked: whatever was wrong is over, so the liveness counter resets.
    this.stats.consecutiveErrors = 0;
    let delivered = 0;
    for (const event of events) {
      const messageId = synthesizeId(event);
      // The envelope MUST satisfy `PendingInboundStore.normalizeMessage`, which
      // drops anything without a pendingId/messageId, a senderId and a provider -
      // and the caller only sees a warning plus `false`. Getting this wrong loses
      // real messages silently: measured 2026-10-01 by feeding this very shape to
      // the real store, which answered `invalid pending inbound message`.
      const message = {
        id: messageId,
        messageId,
        pendingId: messageId,
        localId: "",
        talker: event.peer,
        // A UIA reader has no wxid, so the peer's display name is both the sender
        // identity and the reply address.
        senderId: event.peer,
        provider: "wechat-cua",
        chatId: `weflow:${event.peer}`,
        text: event.text,
        // Who sent it, as far as this path can honestly tell:
        //   incoming        a bubble on the peer's side (or a preview we cannot judge)
        //   outgoing        this ACCOUNT's own bubble that our ledger does not know,
        //                   i.e. the operator typing in this account (here or on
        //                   another signed-in device). Recorded, never answered as if
        //                   a peer had written - see inbound.js.
        // `directionVerified` says whether a screenshot was actually read, so a
        // consumer can tell "the peer sent this" from "we could not tell".
        direction: event.direction === "outgoing" ? "outgoing" : "incoming",
        directionVerified: event.confidence === "bubble-direction",
        origin: event.origin || "",
        contentKind: "text",
        kind: "text",
        timestamp: Math.floor(Date.now() / 1000),
        receivedAt: new Date().toISOString(),
        quotedContexts: [],
        attachments: [],
        attachmentFailures: [],
        source: "cua-preview",
        confidence: event.confidence,
        unread: event.unread,
      };
      try {
        const accepted = await this.onMessage(message, { chatUsername: event.peer });
        if (accepted !== false) {
          delivered += 1;
          this.stats.delivered += 1;
        }
      } catch (error) {
        this.stats.errors += 1;
        this.logger.warn?.(`[cyberboss] cua inbox handler failed: ${error.message}`);
      }
    }
    // A low-frequency, information-bearing line: what the reader did, and how much
    // direction it got WITHOUT opening a conversation (the click-free path). Without
    // this the free-direction work is invisible from outside the process.
    if (this.stats.polls % 20 === 0 || this.lastLoggedDirectionCount !== (this.source?.stats?.directionWithoutClick ?? 0)) {
      this.lastLoggedDirectionCount = this.source?.stats?.directionWithoutClick ?? 0;
      this.logger.log?.(
        `[cyberboss] cua inbox stats polls=${this.stats.polls} `
        + `delivered=${this.stats.delivered} suppressed=${this.stats.suppressed} errors=${this.stats.errors} `
        // these three live on the INNER source: the outer object never had them, which
        // printed as "undefined" and made the free-direction path look unmeasurable
        + `events=${this.source?.stats?.events ?? 0} directionFree=${this.source?.stats?.directionWithoutClick ?? 0} `
        + `selfManual=${this.source?.stats?.selfManual ?? 0}`
      );
    }
    return delivered;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    return this;
  }

  /**
   * React to a failed poll: bring the driver back, and say so out loud.
   *
   * The daemon died once during a live session (2026-10-01) and the bot simply went
   * quiet - every poll returned an empty chat list, no error, no events. A channel
   * that cannot hear anything must not look healthy: after a few consecutive
   * failures this tries the driver's own autostart entry, and if it still cannot
   * read, it says that in the log on a slow cadence instead of every poll.
   */
  recoverFromFailure(error) {
    const detail = String(error?.message || "");
    this.stats.consecutiveErrors = (this.stats.consecutiveErrors || 0) + 1;
    if (this.stats.consecutiveErrors < this.recoverAfterFailures) {
      return this.stats.consecutiveErrors;
    }
    const now = Date.now();
    if (now - (this.lastRecoveryAt || 0) < this.recoveryCooldownMs) {
      return this.stats.consecutiveErrors;
    }
    this.lastRecoveryAt = now;
    const daemonDown = isDaemonDown(detail);
    if (!daemonDown) {
      this.stats.recoveries = (this.stats.recoveries || 0) + 1;
      this.logger.error?.(
        `[cyberboss] cua inbox cannot read the chat list (${this.stats.consecutiveErrors} failed polls): ${detail}`
      );
      return this.stats.consecutiveErrors;
    }
    let outcome = null;
    try {
      outcome = this.ensureDriver({ exec: this.execDriver, spawnImpl: this.spawnDriver });
    } catch (recoveryError) {
      outcome = { started: false, how: "failed", detail: recoveryError.message };
    }
    this.stats.recoveries = (this.stats.recoveries || 0) + 1;
    this.stats.lastRecovery = outcome;
    if (outcome?.started) {
      this.logger.warn?.(
        `[cyberboss] cua driver was down (${this.stats.consecutiveErrors} failed polls: ${detail}); `
        + `started it again via ${outcome.how}. The bot could not hear anything until now.`
      );
    } else {
      this.logger.error?.(
        `[cyberboss] cua inbox is DEAF: ${this.stats.consecutiveErrors} failed polls (${detail}) `
        + `and the driver could not be started (${outcome?.how}: ${outcome?.detail}). `
        + 'Run "cua-driver serve" or re-enable its autostart entry.'
      );
    }
    return this.stats.consecutiveErrors;
  }

  describe() {
    return {
      id: "wechat-cua-inbox",
      kind: "inbound-source",
      pollMs: this.pollMs,
      deepRead: this.deepRead,
      allowPeers: this.allowPeers(),
      stats: { ...this.stats },
    };
  }
}

module.exports = { WeChatCuaInboxSource, synthesizeId };
