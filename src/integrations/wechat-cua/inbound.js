// inbound.js - inbound events for WeChat, read through Cua Driver.
//
// ## Why a preview-level reader
//
// The chat list is the only inbound surface a pure-UIA client can read: message
// bubbles are self-drawn and never appear in the accessibility tree (measured
// 2026-10-01 - the tree carries the rows, and inside a conversation only the
// timestamp and preview ListItems show up, never the bubble text).
//
// So an inbound event here is "a conversation row's last message changed". That
// gives the sender, the preview text, the time and an unread count. It does NOT
// give full message bodies or history; a database reader (WeFlow) is still the
// only way to get those. This module exists so the loop can close without one.
//
// ## What it deliberately does not do
//
// It never guesses that a changed row means "the human wrote to us": WeChat rows
// can change because *we* sent something, because the conversation was opened
// and marked read, or because an unsent draft was restored. Those are separated
// by explicit rules below rather than by hope.

const { CuaSession, findWeChatWindow, currentConversation, elements } = require("./client");
const { decodePng, classifyBubbleDirection, greenShare } = require("./pixels");

const ROW_SPLIT = /\n+/;

/**
 * Parse one conversation row into its parts.
 *
 * WeChat renders a row as: peer, last-message preview, time, and (when unread)
 * an unread badge that is prefixed to the preview. Empty lines are padding.
 */
function parseRow(label) {
  const parts = String(label || "").split(ROW_SPLIT).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) {
    return null;
  }
  const [peer, ...rest] = parts;
  // The time is the last part when it looks like one: HH:MM, MM/DD, 昨天, weekday.
  const timeRe = /^(\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|昨天|星期[一二三四五六日]|周[一二三四五六日])$/;
  let time = "";
  if (rest.length && timeRe.test(rest[rest.length - 1])) {
    time = rest.pop();
  }
  let preview = rest.join(" ").trim();
  let unread = 0;
  const badge = /^\[(\d+)条?\]\s*/u.exec(preview);
  if (badge) {
    unread = Number(badge[1]);
    preview = preview.slice(badge[0].length).trim();
  }
  return { peer, preview, time, unread, raw: String(label || "") };
}

/** A stable identity for "this row's content", so a reorder is not a new message. */
function rowDigest(row) {
  if (!row) return "";
  return `${row.peer}\u0000${row.preview}\u0000${row.time}\u0000${row.unread}`;
}

/**
 * Read every conversation row currently in the chat list.
 *
 * Read-only: a single snapshot, no clicks, no keys, no focus change.
 *
 * Telling a row apart from a message bubble is not cosmetic - getting it wrong
 * attributes a message to the wrong peer (measured 2026-10-01: a bubble in the
 * open conversation was reported as a row for that conversation's peer). The two
 * are separated structurally, by frame width:
 *
 *   conversation row   ~300 x 78 px, label has newlines (peer / preview / time)
 *   message bubble     ~722 x 68 px, label is a single line
 *
 * Width is the reliable half: a preview can itself contain newlines, so "has a
 * newline" alone is not enough.
 */
function readRows(session, target) {
  const snap = session.snapshot(target);
  // A failed snapshot must not look like "a chat list with no rows". Measured
  // 2026-10-01: when the driver daemon died, every poll returned an empty list, so
  // the bot kept reporting healthy while hearing nothing - the failure mode this
  // whole reader exists to avoid. Loud beats silent.
  if (snap?.__failed) {
    const detail = typeof snap.payload === "string"
      ? snap.payload.split("\n")[0]
      : (snap.payload?.refusal?.message || "driver refused the snapshot");
    throw new Error(`cua snapshot failed: ${detail}`);
  }
  const candidates = elements(snap)
    .filter((el) => el.role === "ListItem")
    .map((el) => ({ el, label: String(el.label || ""), width: el.frame?.w || 0, height: el.frame?.h || 0 }))
    .filter((c) => c.label.includes("\n"));

  if (!candidates.length) {
    return [];
  }
  // The chat list is the narrower column; take the modal width of multi-line
  // rows and keep only those, so a wide bubble with a newline cannot sneak in.
  const widths = candidates.map((c) => c.width).filter((w) => w > 0);
  const modal = widths.length
    ? widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)]
    : 0;
  const isRow = (c) => (modal > 0 ? c.width <= modal * 1.2 : true);

  return candidates
    .filter(isRow)
    .map((c) => ({ ...parseRow(c.label), token: c.el.element_token, index: c.el.element_index, width: c.width }))
    .filter((row) => row && row.peer);
}

/**
 * The message list of the OPEN conversation, in reading order, with direction.
 *
 * This corrects an earlier claim of mine ("bubble text is unreadable"): it is
 * readable. Measured 2026-10-01 on WeChat desktop, the bubbles come back as wide
 * ListItems whose `label` IS the message text:
 *
 *   y=176 w=722 "收到，RDP 重连后链路正常"
 *   y=245 w=722 "[probe] s4 bridge after fg fix"
 *   y=451 w=722 "9月18日 11:03"          <- a timestamp, not a message
 *
 * Sorting by `y` therefore yields the conversation in order. The UIA tree has no
 * direction field - measured on a real 1:1 conversation, an incoming "hi" and an
 * outgoing "处理中" are the same full-width ListItem - so direction is read from the
 * screenshot (`pixels.js`), which is where the client actually says it: this
 * account's messages are green, the peer's are white.
 *
 * `direction` is "unknown" when the frame or screenshot is missing. That is not a
 * synonym for "incoming": callers that must not answer themselves have to treat
 * "unknown" as untrusted.
 */
function readConversation(session, target, { maxItems = 40, withPixels = true } = {}) {
  const snap = session.snapshot(target);
  const all = elements(snap);
  const widths = all.filter((el) => el.frame?.w > 0).map((el) => el.frame.w);
  if (!widths.length) {
    return [];
  }
  const widest = Math.max(...widths);
  const timeOnly = /^(\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|昨天|星期[一二三四五六日]|周[一二三四五六日]|.{0,6}\d{1,2}月\d{1,2}日.*)$/u;
  let image = null;
  if (withPixels && snap.screenshot_png_b64) {
    try {
      image = decodePng(Buffer.from(snap.screenshot_png_b64, "base64"));
    } catch {
      image = null; // an undecodable screenshot degrades to "unknown", never to a guess
    }
  }
  return all
    .filter((el) => el.role === "ListItem" && el.frame && el.frame.w > widest * 0.4)
    .sort((a, b) => a.frame.y - b.frame.y)
    .map((el) => ({
      text: String(el.label || "").trim(),
      y: el.frame.y,
      token: el.element_token,
      // `screenshot_frame` is the same region expressed in screenshot coordinates;
      // `frame` is absolute screen coordinates and cannot index the image directly.
      direction: classifyBubbleDirection(image, el.screenshot_frame),
      greenShare: el.screenshot_frame && image
        ? Number(greenShare(image, el.screenshot_frame).toFixed(3))
        : null,
    }))
    .filter((item) => item.text && !timeOnly.test(item.text))
    .slice(-maxItems);
}

/**
 * A preview-level inbound source.
 *
 * State machine, in order of precedence for each poll:
 *   - a row that was not seen before      -> event (new conversation appeared)
 *   - a row whose digest changed          -> event, unless we caused it
 *   - a row whose unread count grew       -> event, even if the digest is reused
 *
 * "We caused it" is decided by the caller through `isOwnEcho(row)`: after a send
 * the conversation we sent to moves to the top with our text as the preview.
 * Without that rule every reply would be answered by itself - the same trap the
 * RDP-era deployment hit and solved with a ledger.
 *
 * `deepRead: true` additionally opens a changed conversation and reads its
 * message list, so several messages sent in quick succession become several
 * events instead of one collapsed preview. That costs a foreground click (see
 * client.js: only a foreground click switches conversations), so it is opt-in.
 */
class PreviewInboundSource {
  constructor(target, {
    session = new CuaSession(),
    allowPeers = null,
    pollMs = 2000,
    deepRead = false,
    openConversation = null,
  } = {}) {
    this.target = target;
    this.session = session;
    this.allowPeers = allowPeers ? new Set(allowPeers) : null;
    this.pollMs = pollMs;
    this.deepRead = deepRead;
    // Injected so tests can drive the deep path without a live client.
    this.openConversation = openConversation;
    this.seen = new Map(); // peer -> digest
    this.watermarks = new Map(); // peer -> last message text read from the conversation
    this.primed = false;
    this.stats = { polls: 0, events: 0, skippedOwnEcho: 0, skippedNotAllowed: 0, deepReads: 0, selfManual: 0, directionWithoutClick: 0 };
  }

  /** One read, no side effects. Returns the events observed since the last call. */
  poll({ isOwnEcho = () => false } = {}) {
    const rows = readRows(this.session, this.target);
    this.stats.polls += 1;
    const events = [];

    for (const row of rows) {
      const digest = rowDigest(row);
      const previous = this.seen.get(row.peer);
      const changed = previous !== undefined && previous !== digest;
      const appeared = previous === undefined;
      this.seen.set(row.peer, digest);
      if (!changed && !appeared) {
        continue;
      }

      // First poll only establishes the baseline: every row is "new" by
      // definition, and treating that as inbound would replay the whole list.
      if (!this.primed) {
        continue;
      }
      if (!changed) {
        continue;
      }
      if (this.allowPeers && !this.allowPeers.has(row.peer)) {
        this.stats.skippedNotAllowed += 1;
        continue;
      }
      if (isOwnEcho(row)) {
        this.stats.skippedOwnEcho += 1;
        continue;
      }
      const pieces = this.deepRead
        ? this.expand(row)
        : (this.readOpenConversation(row) || [{ text: row.preview, direction: "unknown" }]);
      for (const piece of pieces) {
        const text = typeof piece === "string" ? piece : piece.text;
        const direction = typeof piece === "string" ? "unknown" : (piece.direction || "unknown");
        // The screenshot is the only honest answer to "did the user send this?".
        // When it says the bubble is this account's own, the message is NOT an
        // inbound user message - either we sent it (ledger) or the operator typed it
        // in this account (here or on another signed-in device), which is recorded
        // as such instead of being answered like a peer's message.
        if (direction === "outgoing") {
          if (isOwnEcho(row, text)) {
            this.stats.skippedOwnEcho += 1;
            continue;
          }
          events.push({
            direction: "outgoing",
            origin: "self_manual",
            peer: row.peer,
            text,
            time: row.time,
            unread: row.unread,
            replyTarget: row.peer,
            confidence: "bubble-direction",
            source: "cua-conversation",
          });
          this.stats.events += 1;
          this.stats.selfManual += 1;
          continue;
        }
        if (direction === "unknown" && isOwnEcho(row, text)) {
          // No pixels to judge by (preview-only poll, or an undecodable capture):
          // fall back to the ledger, which is what this path did before direction
          // existed.
          this.stats.skippedOwnEcho += 1;
          continue;
        }
        events.push({
          direction: "incoming",
          peer: row.peer,
          text,
          time: row.time,
          unread: row.unread,
          // What the loop must answer *to*: the row is the only handle a UIA
          // writer has, and WeChat labels the message box with the peer's name.
          replyTarget: row.peer,
          confidence: direction === "incoming"
            ? "bubble-direction"
            : (row.unread > 0 ? "unread-badge" : "preview-changed"),
          source: this.deepRead ? "cua-conversation" : "cua-preview",
        });
        this.stats.events += 1;
      }
    }

    this.primed = true;
    return events;
  }

  /**
   * Read a changed conversation's message list and return only the messages after
   * the last one we already emitted for that peer.
   *
   * This is what stops "the user sent three things quickly" from collapsing into
   * one preview event, and it is also the only place where direction is knowable:
   * the chat-list preview carries no alignment, the screenshot of the conversation
   * does. It needs the conversation open, which costs one foreground click - so it
   * only runs for a peer whose row actually changed, and only when enabled.
   */
  expand(row) {
    if (typeof this.openConversation !== "function") {
      return [{ text: row.preview, direction: "unknown" }];
    }
    let opened;
    try {
      opened = this.openConversation(this.session, this.target, row.peer);
    } catch (error) {
      this.stats.deepReads += 1;
      return [{ text: row.preview, direction: "unknown" }];
    }
    if (opened === false) {
      this.stats.deepReads += 1;
      return [{ text: row.preview, direction: "unknown" }];
    }
    this.stats.deepReads += 1;
    const messages = readConversation(this.session, this.target);
    if (!messages.length) {
      return [{ text: row.preview, direction: "unknown" }];
    }
    return this.freshMessages(row, messages);
  }

  /**
   * Direction without paying for it.
   *
   * The expensive half of a deep read is OPENING the conversation (one foreground
   * activation, measured at 150-300ms). But when the changed peer happens to be the
   * conversation that is already open - which is the common case for a chat the bot
   * is active in - its bubbles can be read with a background snapshot: no click, no
   * focus change, and the answer to "did the user send this?" comes for free.
   *
   * Returns null when the peer is not the open conversation, so the caller falls
   * back to the preview/ledger path exactly as before.
   */
  readOpenConversation(row) {
    if (typeof this.session?.snapshot !== "function") {
      return null;
    }
    let current;
    try {
      current = currentConversation(this.session, this.target);
    } catch {
      return null;
    }
    if (!current?.label || current.label !== row.peer) {
      return null;
    }
    let messages;
    try {
      messages = readConversation(this.session, this.target);
    } catch {
      return null;
    }
    if (!messages.length) {
      return null;
    }
    this.stats.directionWithoutClick += 1;
    return this.freshMessages(row, messages);
  }

  /** The messages after this peer's watermark, shared by both read paths. */
  freshMessages(row, messages) {
    const texts = messages.map((m) => m.text);
    const mark = this.watermarks.get(row.peer);
    let fresh;
    if (!mark) {
      fresh = messages;
    } else {
      const index = texts.lastIndexOf(mark);
      fresh = index >= 0 ? messages.slice(index + 1) : messages.slice(-1);
    }
    this.watermarks.set(row.peer, texts[texts.length - 1]);
    // A message whose direction could not be read must not be silently dropped:
    // falling back to the preview keeps the previous behaviour for it.
    return fresh.length ? fresh : [{ text: row.preview, direction: "unknown" }];
  }

  /** Forget a peer's baseline so its next change counts as new (after a send). */
  forget(peer) {
    this.seen.delete(peer);
  }
}

module.exports = {
  PreviewInboundSource,
  readConversation,
  parseRow,
  rowDigest,
  readRows,
};
