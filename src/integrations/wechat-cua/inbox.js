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
    this.timer = null;
    this.running = false;
    this.lastDeepReadAt = 0;
    this.stats = { polls: 0, delivered: 0, errors: 0, suppressed: 0 };
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
    // replay the whole chat list as new messages.
    this.source.poll({ isOwnEcho: (row) => Boolean(this.ledger && this.ledger.matches(row.peer, row.preview)) });
    this.running = true;
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        this.stats.errors += 1;
        this.logger.warn?.(`[cyberboss] cua inbox poll failed: ${error.message}`);
      });
    }, this.pollMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
    this.logger.log?.(
      `[cyberboss] cua inbox enabled pollMs=${this.pollMs} deepRead=${this.deepRead} peers=${JSON.stringify(allow)}`
    );
    return this;
  }

  /** One poll: read, translate, hand over. Returns how many were delivered. */
  async pollOnce() {
    if (!this.source) {
      return 0;
    }
    this.stats.polls += 1;
    const events = this.source.poll({
      isOwnEcho: (row) => {
        const suppressed = Boolean(this.ledger && this.ledger.matches(row.peer, row.preview));
        if (suppressed) {
          this.stats.suppressed += 1;
        }
        return suppressed;
      },
    });
    let delivered = 0;
    for (const event of events) {
      const message = {
        id: synthesizeId(event),
        localId: "",
        talker: event.peer,
        text: event.text,
        // Direction is not readable on this path (see inbound.js): an observed
        // row is treated as inbound only because our own sends are suppressed by
        // the echo ledger above. This is the weakest link in the design and is
        // documented rather than hidden.
        direction: "incoming",
        contentKind: "text",
        kind: "text",
        timestamp: Math.floor(Date.now() / 1000),
        receivedAt: new Date().toISOString(),
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
