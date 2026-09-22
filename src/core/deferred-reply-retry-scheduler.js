"use strict";

/**
 * Retry scheduler for deferred system replies.
 *
 * Why this exists: a reply that fails to send lands in the deferred queue, and the
 * only flush point is `primeDeferredRepliesForSender` - "the next inbound from the
 * same sender". The cost of a failure therefore equals however long the user stays
 * silent; on 2026-09-18 eight replies sat in the queue for days while the user saw
 * only the "处理中" acknowledgement.
 *
 * This module owns the missing half: it retries on a timer instead of waiting for
 * the user, and it is deliberately decoupled from `app.js` (it takes the store, a
 * formatter and a send callback) so the reply pipeline itself does not change shape
 * until the wiring is reviewed.
 *
 * Contract:
 *  - the queue's identity is the entry `id`; re-queueing after a failed attempt
 *    overwrites the same id, so a retry can never produce a duplicate delivery
 *    (see `DeferredSystemReplyStore#enqueue`);
 *  - backoff is 30s, 1m, 2m, 5m (capped), 8 attempts, then `onGiveUp` and the entry
 *    is restored to the queue so an operator or the repair session can see it;
 *  - attempts for the same sender never overlap (`running` guard), and a sender with
 *    nothing queued costs nothing.
 *
 * NOTE: not wired into the bot yet. Wiring is two lines in `app.js`
 * (`new DeferredReplyRetryScheduler({ store, format: formatDeferredSystemReplyBatch,
 * send })` plus `scheduler.schedule(accountId, senderId)` inside `deferSystemReply`).
 */

const DEFAULT_FIRST_DELAY_MS = 30_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;

function senderKey(accountId, senderId) {
  return `${String(accountId || "")}\u0000${String(senderId || "")}`;
}

/** 30s, 1m, 2m, 5m, 5m ... indexed by the attempts already made. */
function backoffDelayMs(attempts, firstDelayMs, maxDelayMs) {
  const steps = Math.max(0, Number(attempts) || 0);
  return Math.min(maxDelayMs, firstDelayMs * 2 ** steps);
}

class DeferredReplyRetryScheduler {
  constructor({
    store,
    send,
    format,
    onGiveUp = () => {},
    log = () => {},
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    firstDelayMs = DEFAULT_FIRST_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = {}) {
    if (!store || typeof store.drainForSender !== "function" || typeof store.enqueue !== "function") {
      throw new Error("DeferredReplyRetryScheduler requires a deferred reply store");
    }
    if (typeof send !== "function") {
      throw new Error("DeferredReplyRetryScheduler requires a send callback");
    }
    if (typeof format !== "function") {
      throw new Error("DeferredReplyRetryScheduler requires a batch formatter");
    }
    this.store = store;
    this.send = send;
    this.format = format;
    this.onGiveUp = onGiveUp;
    this.log = log;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.firstDelayMs = firstDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxAttempts = maxAttempts;
    this.timers = new Map();
    this.running = new Set();
    this.stopped = false;
  }

  /** Arm a retry for this sender; called right after a reply is deferred. */
  schedule(accountId, senderId) {
    if (this.stopped || !accountId || !senderId) {
      return;
    }
    this.#arm(accountId, senderId, this.firstDelayMs);
  }

  /**
   * Re-arm retries for whatever the queue still holds. Called once at startup: the
   * timers live in memory while the backlog lives on disk, so without this a
   * restart leaves every queued reply waiting for the sender's next message again
   * (measured 2026-09-22: eight replies, oldest four days).
   */
  rehydrate({ delayMs = this.firstDelayMs } = {}) {
    if (this.stopped || typeof this.store.listSenders !== "function") {
      return 0;
    }
    const senders = this.store.listSenders();
    for (const sender of senders) {
      if (sender?.accountId && sender?.senderId) {
        this.#arm(sender.accountId, sender.senderId, delayMs);
      }
    }
    if (senders.length) {
      this.log(`deferred retry re-armed senders=${senders.length}`);
    }
    return senders.length;
  }

  cancel(accountId, senderId) {
    const key = senderKey(accountId, senderId);
    const timer = this.timers.get(key);
    if (timer) {
      this.clearTimeoutFn(timer);
      this.timers.delete(key);
    }
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) {
      this.clearTimeoutFn(timer);
    }
    this.timers.clear();
  }

  #arm(accountId, senderId, delayMs) {
    const key = senderKey(accountId, senderId);
    this.cancel(accountId, senderId);
    const timer = this.setTimeoutFn(() => {
      this.timers.delete(key);
      this.runNow(accountId, senderId).catch((error) => {
        this.log(`deferred retry failed unexpectedly sender=${senderId}: ${error && error.message}`);
      });
    }, Math.max(0, delayMs));
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
    this.timers.set(key, timer);
  }

  /**
   * One attempt for one sender, callable directly (this is what the self-test and
   * the future wiring both use). Returns a small report so callers can assert.
   */
  async runNow(accountId, senderId) {
    const key = senderKey(accountId, senderId);
    if (this.stopped || this.running.has(key)) {
      return { sent: 0, requeued: 0, givenUp: 0, skipped: true };
    }
    const entries = this.store.drainForSender(accountId, senderId);
    if (!entries.length) {
      return { sent: 0, requeued: 0, givenUp: 0, skipped: false };
    }
    this.running.add(key);
    try {
      await this.send({ accountId, senderId, text: this.format(entries), entries });
      this.log(`deferred retry delivered sender=${senderId} count=${entries.length}`);
      return { sent: entries.length, requeued: 0, givenUp: 0, skipped: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      let requeued = 0;
      let givenUp = 0;
      let earliest = Infinity;
      for (const entry of entries) {
        const attempts = (Number(entry.attemptCount) || 0) + 1;
        const updated = {
          ...entry,
          attemptCount: attempts,
          lastError: message,
          failedAt: new Date(this.now()).toISOString(),
        };
        if (attempts >= this.maxAttempts) {
          updated.exhausted = true;
          updated.nextRetryAtMs = null;
          this.store.enqueue(updated);
          givenUp += 1;
          this.onGiveUp(updated);
          continue;
        }
        // The delay before the *next* attempt is indexed by the attempts made
        // before it: after the first failure that is 30s, after the second 60s.
        const delay = backoffDelayMs(Math.max(0, attempts - 1), this.firstDelayMs, this.maxDelayMs);
        updated.nextRetryAtMs = this.now() + delay;
        this.store.enqueue(updated);
        requeued += 1;
        earliest = Math.min(earliest, delay);
      }
      this.log(
        `deferred retry failed sender=${senderId} count=${entries.length} requeued=${requeued} givenUp=${givenUp}: ${message}`,
      );
      if (Number.isFinite(earliest)) {
        this.#arm(accountId, senderId, earliest);
      }
      return { sent: 0, requeued, givenUp, skipped: false };
    } finally {
      this.running.delete(key);
    }
  }
}

module.exports = {
  DeferredReplyRetryScheduler,
  backoffDelayMs,
  DEFAULT_FIRST_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
};

if (require.main === module) {
  // Self-test with fake timers: proves backoff, id-dedupe on requeue, the attempt
  // cap, and that a successful attempt never re-queues anything.
  const assert = require("assert");
  const { DeferredSystemReplyStore } = require("./deferred-system-reply-store");
  const os = require("os");
  const path = require("path");

  (async () => {
    const filePath = path.join(os.tmpdir(), `drq-scheduler-test-${process.pid}.json`);
    const store = new DeferredSystemReplyStore({ filePath });
    const armed = [];
    const giveUps = [];
    const failures = [];
    let attempt = 0;
    const scheduler = new DeferredReplyRetryScheduler({
      store,
      format: (entries) => entries.map((entry) => entry.text).join("\n"),
      send: async () => {
        attempt += 1;
        if (failures.includes(attempt)) {
          throw new Error(`synthetic failure ${attempt}`);
        }
        return { dispatched: true };
      },
      onGiveUp: (entry) => giveUps.push(entry.id),
      setTimeoutFn: (fn, delay) => {
        armed.push(delay);
        return { unref() {} };
      },
      clearTimeoutFn: () => {},
      firstDelayMs: 30_000,
      maxDelayMs: 300_000,
      maxAttempts: 3,
    });
    const reply = {
      id: "acct:1",
      accountId: "acct",
      senderId: "user",
      threadId: "t",
      text: "hello",
      kind: "plain_reply",
      createdAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      lastError: "",
    };

    store.enqueue(reply);
    let report = await scheduler.runNow("acct", "user");
    assert.strictEqual(report.sent, 1, "a healthy send delivers the batch");
    assert.strictEqual(store.drainForSender("acct", "user").length, 0, "delivered entries leave the queue");

    failures.push(2, 3, 4);
    store.enqueue(reply);
    report = await scheduler.runNow("acct", "user");
    assert.strictEqual(report.requeued, 1, "failure re-queues exactly one entry");
    const requeued = store.drainForSender("acct", "user");
    assert.strictEqual(requeued.length, 1, "re-queue keeps a single entry per id");
    assert.strictEqual(requeued[0].attemptCount, 1, "attempt count advances");

    store.enqueue({ ...requeued[0], attemptCount: 1 });
    report = await scheduler.runNow("acct", "user");
    assert.strictEqual(report.requeued, 1);
    const second = store.drainForSender("acct", "user");
    assert.strictEqual(second[0].attemptCount, 2);
    assert.strictEqual(second.length, 1, "still one entry after the second failure");

    store.enqueue({ ...second[0], attemptCount: 2 });
    report = await scheduler.runNow("acct", "user");
    assert.strictEqual(report.givenUp, 1, "the attempt cap stops the retry loop");
    assert.deepStrictEqual(giveUps, ["acct:1"]);
    const afterGiveUp = store.drainForSender("acct", "user");
    assert.strictEqual(afterGiveUp[0].exhausted, true, "exhausted entries stay visible in the queue");
    assert.ok(armed.length >= 1, "a failed attempt arms a retry timer");
    assert.deepStrictEqual(armed.slice(0, 2), [30_000, 60_000], `backoff climbs: ${armed.join(",")}`);
    console.log("DeferredReplyRetryScheduler self-test ok", { armed, giveUps });
    require("fs").rmSync(filePath, { force: true });
  })().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}
