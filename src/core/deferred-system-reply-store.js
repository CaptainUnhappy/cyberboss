const fs = require("fs");
const path = require("path");

class DeferredSystemReplyStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { replies: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const replies = Array.isArray(parsed?.replies) ? parsed.replies : [];
      this.state = {
        replies: replies
          .map(normalizeDeferredSystemReply)
          .filter(Boolean)
          .sort(compareDeferredReplies),
      };
    } catch {
      this.state = { replies: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  /**
   * Queue one reply, keyed by its id.
   *
   * The retry path re-queues a batch it failed to send, and it may race the
   * next-inbound flush.  A plain push would then hold the same reply twice and the
   * user would read it twice, so the id is the queue's identity: an entry that is
   * already queued is replaced instead of appended.  Comparison is by id only;
   * everything else about the newer record wins (it carries the updated attempt
   * count and next retry time).
   */
  enqueue(reply) {
    this.load();
    const normalized = normalizeDeferredSystemReply(reply);
    if (!normalized) {
      throw new Error("invalid deferred system reply");
    }
    const existingIndex = this.state.replies.findIndex((entry) => entry.id === normalized.id);
    if (existingIndex >= 0) {
      this.state.replies[existingIndex] = normalized;
    } else {
      this.state.replies.push(normalized);
    }
    this.state.replies.sort(compareDeferredReplies);
    this.save();
    return normalized;
  }

  /**
   * Queue a reply only when its id is not already queued.
   *
   * The flush path uses this so a retry cannot resurrect an entry that a
   * concurrent drain already handed to the delivery pipeline.
   */
  enqueueUnique(reply) {
    this.load();
    const normalized = normalizeDeferredSystemReply(reply);
    if (!normalized) {
      throw new Error("invalid deferred system reply");
    }
    if (this.state.replies.some((entry) => entry.id === normalized.id)) {
      return null;
    }
    return this.enqueue(normalized);
  }

  drainForSender(accountId, senderId) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    const normalizedSenderId = normalizeText(senderId);
    const drained = [];
    const pending = [];

    for (const reply of this.state.replies) {
      if (reply.accountId === normalizedAccountId && reply.senderId === normalizedSenderId) {
        drained.push(reply);
      } else {
        pending.push(reply);
      }
    }

    if (drained.length) {
      this.state.replies = pending;
      this.save();
    }

    return drained;
  }
}

function normalizeDeferredSystemReply(reply) {
  if (!reply || typeof reply !== "object") {
    return null;
  }
  const id = normalizeText(reply.id);
  const accountId = normalizeText(reply.accountId);
  const senderId = normalizeText(reply.senderId);
  const threadId = normalizeText(reply.threadId);
  const text = normalizeText(reply.text);
  const kind = normalizeDeferredReplyKind(reply.kind);
  const createdAt = normalizeIsoTime(reply.createdAt);
  const failedAt = normalizeIsoTime(reply.failedAt);
  const lastError = normalizeText(reply.lastError);
  // Retry bookkeeping (deferred-reply-retry-scheduler.js): a strict field list
  // dropped these once, resetting the attempt counter on every re-queue.
  const attemptCount = Number.isFinite(Number(reply.attemptCount)) && Number(reply.attemptCount) > 0 ? Math.floor(Number(reply.attemptCount)) : 0;
  const nextRetryAtMs = Number.isFinite(Number(reply.nextRetryAtMs)) && Number(reply.nextRetryAtMs) > 0 ? Math.floor(Number(reply.nextRetryAtMs)) : null;
  const exhausted = reply.exhausted === true;
  if (!id || !accountId || !senderId || !text) {
    return null;
  }
  return {
    id,
    accountId,
    senderId,
    threadId,
    text,
    kind,
    createdAt: createdAt || new Date().toISOString(),
    failedAt: failedAt || new Date().toISOString(),
    lastError,
    attemptCount,
    nextRetryAtMs,
    exhausted,
  };
}

function compareDeferredReplies(left, right) {
  const leftTime = Date.parse(left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.createdAt || "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDeferredReplyKind(value) {
  const normalized = normalizeText(value);
  return normalized === "system_reply" ? normalized : "plain_reply";
}

module.exports = { DeferredSystemReplyStore };
