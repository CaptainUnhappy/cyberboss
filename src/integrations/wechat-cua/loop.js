// loop.js - the closed loop: inbound event -> decide -> send -> verify.
//
// One turn of this loop is the unit the bot would run forever:
//
//   1. read    (PreviewInboundSource, Cua, background, read-only)
//   2. decide  (injected: the real bot hands in its runtime; tests hand in a stub)
//   3. send    (sendMessage, Cua: a foreground click only when the conversation
//               is not already open, then a background write and a background
//               return)
//   4. verify  (the conversation's preview row must carry the reply, and the
//               message box must be empty again)
//
// The loop is deliberately transport-injected at both ends so it can be exercised
// without WeChat: `runOnce` takes an `inbound` array (or a source) and returns a
// per-event report instead of throwing, because "the send failed" is a normal
// outcome the caller has to schedule a retry for, not an exception.
//
// What it does NOT do: read message bodies. The preview is all a UIA reader gets
// (see inbound.js), so `event.text` may be a truncation. Anything that needs the
// full text has to come from a database reader.

const { CuaSession, findWeChatWindow, sendMessage } = require("./client");
const { PreviewInboundSource } = require("./inbound");

/** Default decision: echo the preview back, prefixed, so a probe is recognisable. */
function echoDecider(event, { prefix = "echo: " } = {}) {
  return { reply: `${prefix}${event.text}`, reason: "echo-decider" };
}

/**
 * Remembers what this loop itself sent, so its own output cannot come back as
 * input.
 *
 * Without this the bot answers itself forever: a send changes the conversation
 * row, the row change is the inbound signal, and the loop would treat its own
 * reply as a new message. The RDP-era deployment hit exactly this and solved it
 * with a message ledger; a UIA reader has less information than a database
 * reader, so the guard has to be at least as strict.
 */
class SentLedger {
  constructor({ ttlMs = 10 * 60_000 } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map(); // peer -> [{ text, at }]
  }

  record(peer, text) {
    const list = this.entries.get(peer) || [];
    list.push({ text: String(text), at: Date.now() });
    this.entries.set(peer, list.filter((e) => Date.now() - e.at < this.ttlMs));
  }

  /** True when this peer's current preview is something we recently sent. */
  matches(peer, preview) {
    const list = this.entries.get(peer);
    if (!list || !list.length) return false;
    const now = Date.now();
    const live = list.filter((e) => now - e.at < this.ttlMs);
    this.entries.set(peer, live);
    const text = String(preview || "").trim();
    if (!text) return false;
    return live.some((e) => e.text === text || e.text.startsWith(text) || text.startsWith(e.text));
  }
}

/**
 * One pass over the inbox.
 *
 * @param {object} options
 * @param {{pid:number,window_id:number}} [options.target]  defaults to the live WeChat window
 * @param {CuaSession} [options.session]
 * @param {object} [options.source]        a PreviewInboundSource (omit to build one)
 * @param {Array} [options.inbound]        explicit events instead of polling (tests, replays)
 * @param {Function} [options.decide]      (event) => {reply, reason} | null
 * @param {Function} [options.isOwnEcho]   (row) => boolean, suppress our own rows
 * @param {boolean} [options.dryRun]       decide and report, send nothing
 */
function runOnce({
  target = null,
  session = new CuaSession(),
  source = null,
  inbound = null,
  decide = echoDecider,
  isOwnEcho = null,
  ledger = null,
  dryRun = false,
} = {}) {
  const resolved = target || findWeChatWindow(session);
  const ownEcho = isOwnEcho || ((row) => Boolean(ledger && ledger.matches(row.peer, row.preview)));
  const events = inbound || (source || new PreviewInboundSource(resolved, { session })).poll({ isOwnEcho: ownEcho });
  const report = { target: resolved, events: [], sent: 0, failed: 0, skipped: 0 };

  for (const event of events) {
    const decision = decide(event);
    if (!decision || !decision.reply) {
      report.events.push({ event, action: "no-reply", reason: decision?.reason || "decider returned nothing" });
      report.skipped += 1;
      continue;
    }
    if (dryRun) {
      report.events.push({ event, action: "dry-run", wouldSend: decision.reply });
      continue;
    }
    const result = sendMessage(resolved, event.replyTarget, decision.reply, { session });
    if (result.ok && ledger) {
      // Record before the next poll so the row we just changed cannot be read
      // back as an inbound message.
      ledger.record(event.replyTarget, decision.reply);
    }
    report.events.push({
      event,
      action: result.ok ? "sent" : "send-failed",
      reply: decision.reply,
      verify: result.verify,
      // Keep the driver's own vocabulary. A failed send is diagnosed from
      // `refusal.code` / `escalation`, not from prose, so the report carries the
      // whole outcome rather than a summary that hides it.
      steps: result.steps.map((s) => ({
        step: s.step,
        ...(s.outcome || {}),
        ...(s.landed !== undefined ? { landed: s.landed } : {}),
        ...(s.cost ? { cost: s.cost } : {}),
        ...(s.route && !s.outcome ? { route: s.route } : {}),
      })),
    });
    if (result.ok) {
      report.sent += 1;
    } else {
      report.failed += 1;
    }
  }
  return report;
}

/**
 * Poll forever, one turn per inbound event.
 *
 * `onEvent` is called with each event before it is answered, so a caller can
 * observe or veto. Returning false from `decide` (or null) means "stay silent",
 * which is a legitimate decision for this product: the bot is allowed to say
 * nothing.
 */
function runLoop(options = {}) {
  const {
    pollMs = 3000,
    maxTurns = Infinity,
    onReport = null,
    stopFile = null,
    ...once
  } = options;
  const session = once.session || new CuaSession();
  const target = once.target || findWeChatWindow(session);
  const source = new PreviewInboundSource(target, { session, ...(once.sourceOptions || {}) });
  // Every production loop gets an echo ledger: it is the difference between a
  // bot and a self-conversation.
  const ledger = once.ledger || new SentLedger();
  let turns = 0;
  const startedAt = Date.now();

  while (turns < maxTurns) {
    if (stopFile) {
      try {
        require("node:fs").accessSync(stopFile);
        break;
      } catch { /* keep looping */ }
    }
    const report = runOnce({ ...once, session, target, source, ledger, inbound: null });
    turns += 1;
    if (report.events.length && typeof onReport === "function") {
      onReport(report);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
  return { turns, elapsedMs: Date.now() - startedAt };
}

module.exports = { runOnce, runLoop, echoDecider, SentLedger };
