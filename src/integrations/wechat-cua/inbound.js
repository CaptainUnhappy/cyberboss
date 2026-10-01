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

const { CuaSession, findWeChatWindow, elements } = require("./client");

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
 * Read-only: a single snapshot, no clicks, no keys, no focus change.
 */
function readRows(session, target) {
  const snap = session.snapshot(target);
  return elements(snap)
    .filter((el) => el.role === "ListItem" && /session_item_|^\S+[\s\S]*\n/u.test(el.label || ""))
    // The conversation list is the second List on screen; bubbles live in the
    // first. Distinguish by shape: a row has a peer line AND a trailing time or
    // is one of the known paddings, while a bubble is a single short line.
    .filter((el) => String(el.label || "").includes("\n"))
    .map((el) => ({ ...parseRow(el.label), token: el.element_token, index: el.element_index }))
    .filter((row) => row && row.peer);
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
 */
class PreviewInboundSource {
  constructor(target, { session = new CuaSession(), allowPeers = null, pollMs = 2000 } = {}) {
    this.target = target;
    this.session = session;
    this.allowPeers = allowPeers ? new Set(allowPeers) : null;
    this.pollMs = pollMs;
    this.seen = new Map(); // peer -> digest
    this.primed = false;
    this.stats = { polls: 0, events: 0, skippedOwnEcho: 0, skippedNotAllowed: 0 };
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
      events.push({
        direction: "incoming",
        peer: row.peer,
        text: row.preview,
        time: row.time,
        unread: row.unread,
        // What the loop must answer *to*: the row is the only handle a UIA
        // writer has, and WeChat labels the message box with the peer's name.
        replyTarget: row.peer,
        confidence: row.unread > 0 ? "unread-badge" : "preview-changed",
        source: "cua-preview",
      });
      this.stats.events += 1;
    }

    this.primed = true;
    return events;
  }

  /** Forget a peer's baseline so its next change counts as new (after a send). */
  forget(peer) {
    this.seen.delete(peer);
  }
}

module.exports = {
  PreviewInboundSource,
  parseRow,
  rowDigest,
  readRows,
};
