const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");

const MAX_SEEN_IDS = 4_000;
const MAX_PENDING_EVENTS = 1_000;
const MAX_DEAD_LETTERS = 1_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MESSAGE_LIMIT = 50;
const DEFAULT_OUTGOING_POLL_INTERVAL_MS = 2_000;
const DEFAULT_OUTGOING_REPLAY_WINDOW_MS = 10 * 60_000;
const DEFAULT_OUTGOING_POLL_MAX_REQUESTS = 64;
const DEFAULT_PENDING_RETRY_MAX_MS = 60_000;
const DEFAULT_POLL_STALL_RETRY_MAX_MS = 60_000;
const MEDIA_RETRY_DELAYS_MS = [0, 250, 750, 1_500];
const IMAGE_COMPANION_OBSERVATION_WINDOW_MS = 15_000;
// A generic short caption is only structural evidence when it is effectively
// adjacent in time. An explicit visual prompt (for example `图中有什么`) may
// legitimately precede the desktop image send by several seconds, so it can
// use the same bounded window in which we already wait for that image.
const IMAGE_COMPANION_STRUCTURAL_MAX_SKEW_SECONDS = 2;
const IMAGE_COMPANION_PROMPT_MAX_SKEW_SECONDS = Math.floor(
  IMAGE_COMPANION_OBSERVATION_WINDOW_MS / 1_000
);
const DIRECT_MEDIA_EXPORT_WINDOW_MS = 60_000;
const IMAGE_MEDIA_EXPORT_WINDOW_MS = 5 * 60_000;
const MAX_IMAGE_COMPANIONS = 10;
const MAX_LEADING_IMAGE_PROMPT_LENGTH = 64;

class WeFlowInboxSource {
  constructor({
    config,
    onMessage,
    onActivity,
    isReady = () => true,
    fetchImpl = globalThis.fetch,
    logger = console,
    now = () => Date.now(),
  }) {
    this.config = config || {};
    this.onMessage = typeof onMessage === "function" ? onMessage : async () => true;
    this.onActivity = typeof onActivity === "function" ? onActivity : async () => true;
    this.isReady = typeof isReady === "function" ? isReady : () => true;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.state = loadCursorState(this.config.weflowInboxCursorFile, {
      chat: this.config.weflowInboxChat,
    });
    this.eventTombstones = buildDurableEventTombstoneSet(this.state);
    this.running = false;
    this.stopping = false;
    this.abortController = null;
    this.loopPromise = null;
    this.outgoingPollAbortController = null;
    this.outgoingPollPromise = null;
    this.pendingEvents = new Map(
      this.state.pendingEvents
        .filter((item) => {
          const chat = normalizeText(item?.push?.sessionId || item?.push?.talker || item?.push?.chatUsername);
          return item?.key
            && !this.eventTombstones.has(item.key)
            && (Array.isArray(this.config.weflowInboxChats) && this.config.weflowInboxChats.length
              ? this.config.weflowInboxChats.includes(chat)
              : chat === normalizeText(this.config.weflowInboxChat));
        })
        .map((item) => {
          const pairing = normalizePendingPairing(item.pairing, {
            key: item.key,
            companionKeys: item.companionKeys,
          });
          return [item.key, {
            eventType: item.eventType,
            push: item.push,
            receivedAt: normalizeIsoDate(item.receivedAt),
            mediaDeadline: normalizeIsoDate(item.mediaDeadline),
            retryAttempt: normalizePendingItemRetryAttempt(item.retryAttempt),
            retryNotBefore: normalizeIsoDate(item.retryNotBefore),
            companionKeys: normalizeCompanionKeys(item.companionKeys, {
              anchorKey: pairing?.anchorKey,
            }),
            pairing,
          }];
        })
    );
    this.syncPendingState();
    this.pendingTimer = null;
    this.pendingTimerDueAtMs = 0;
    this.pendingDrainPromise = null;
    this.pendingRetryAttempt = 0;
    this.pendingRetryNotBeforeMs = 0;
    this.stateWriteChain = Promise.resolve();
  }

  async start() {
    if (this.running) {
      return;
    }
    if (typeof this.fetchImpl !== "function") {
      throw new Error("WeFlow inbox requires fetch support");
    }
    this.stopping = false;
    this.running = true;
    this.loopPromise = this.runLoop().catch((error) => {
      if (this.running && !isAbortError(error)) {
        this.logger.error?.(`[cyberboss] WeFlow inbox stopped: ${formatError(error)}`);
      }
    });
    if (normalizeText(this.config.weflowInboxChat)) {
      this.outgoingPollAbortController = new AbortController();
      this.outgoingPollPromise = this.runOutgoingPollLoop(this.outgoingPollAbortController.signal)
        .catch((error) => {
          if (this.running && !isAbortError(error)) {
            this.logger.error?.(`[cyberboss] WeFlow outgoing poll stopped: ${formatError(error)}`);
          }
        });
    }
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      this.pendingTimerDueAtMs = 0;
    }
    this.abortController?.abort();
    this.outgoingPollAbortController?.abort();
    const pendingWork = [
      this.pendingDrainPromise,
      this.loopPromise,
      this.outgoingPollPromise,
      this.stateWriteChain,
    ].filter(Boolean).map((promise) => Promise.resolve(promise).catch(() => {}));
    if (pendingWork.length) {
      let stopTimer = null;
      try {
        await Promise.race([
          Promise.all(pendingWork),
          new Promise((resolve) => {
            stopTimer = setTimeout(resolve, 5_000);
          }),
        ]);
      } finally {
        if (stopTimer) {
          clearTimeout(stopTimer);
        }
      }
    }
    this.abortController = null;
    this.loopPromise = null;
    this.outgoingPollAbortController = null;
    this.outgoingPollPromise = null;
  }

  async runLoop() {
    while (this.running) {
      this.abortController = new AbortController();
      try {
        if (this.pendingEvents.size) {
          await this.drainPendingEvents();
        }
        if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
          const retryDelayMs = Math.max(
            normalizePositiveInt(
              this.config.weflowReconnectDelayMs,
              DEFAULT_RECONNECT_DELAY_MS,
              100
            ),
            Math.min(
              DEFAULT_PENDING_RETRY_MAX_MS,
              Math.max(0, this.pendingRetryNotBeforeMs - Date.now())
            )
          );
          await delayUntilAbort(retryDelayMs, this.abortController.signal);
          continue;
        }
        await this.consumePushStream(this.abortController.signal);
      } catch (error) {
        if (this.running && !isAbortError(error)) {
          this.logger.error?.(`[cyberboss] WeFlow push reconnecting: ${formatError(error)}`);
        }
      }
      if (this.running) {
        await delay(normalizePositiveInt(
          this.config.weflowReconnectDelayMs,
          DEFAULT_RECONNECT_DELAY_MS,
          100
        ));
      }
    }
  }

  async consumePushStream(signal) {
    const response = await this.fetchImpl(buildApiUrl(this.config, "/api/v1/push/messages"), {
      headers: buildHeaders(this.config, { accept: "text/event-stream" }),
      signal,
    });
    assertHttpOk(response, "WeFlow message push");
    if (!response.body) {
      throw new Error("WeFlow message push returned an empty stream");
    }
    await consumeSseStream(response.body, async (event) => {
      await this.handleSseEvent(event);
    });
  }

  async runOutgoingPollLoop(signal) {
    let consecutiveFailures = 0;
    while (this.running && !signal.aborted) {
      let retryAfterMs = 0;
      try {
        const result = await this.pollOutgoingMessagesOnce({ signal });
        const nextRetryAtMs = Date.parse(normalizeText(result?.nextRetryAt));
        retryAfterMs = Number.isFinite(nextRetryAtMs)
          ? Math.max(0, nextRetryAtMs - Date.now())
          : 0;
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (this.running && !isAbortError(error)) {
          this.logger.error?.(`[cyberboss] WeFlow outgoing poll failed: ${formatError(error)}`);
        }
      }
      if (this.running && !signal.aborted) {
        const baseDelayMs = normalizePositiveInt(
          this.config.weflowOutgoingPollIntervalMs,
          DEFAULT_OUTGOING_POLL_INTERVAL_MS,
          250
        );
        const delayMs = consecutiveFailures
          ? Math.min(60_000, baseDelayMs * (2 ** Math.min(5, consecutiveFailures)))
          : Math.max(baseDelayMs, Math.min(DEFAULT_PENDING_RETRY_MAX_MS, retryAfterMs));
        await delayUntilAbort(delayMs, signal);
      }
    }
  }

  inboundChatScope() {
    const configured = Array.isArray(this.config.weflowInboxChats) && this.config.weflowInboxChats.length
      ? this.config.weflowInboxChats
      : [this.config.weflowInboxChat];
    const scope = [];
    for (const item of configured) {
      const chat = normalizeText(item);
      if (chat && !scope.includes(chat)) {
        scope.push(chat);
      }
    }
    return scope;
  }

  async pollOutgoingMessagesOnce({ signal } = {}) {
    const scope = this.inboundChatScope();
    if (!scope.length) {
      return { status: "disabled", fetched: 0, queued: 0, processed: 0 };
    }
    let aggregate = null;
    for (const chat of scope) {
      const result = await this.pollOutgoingMessagesOnceForChat(chat, { signal });
      if (!aggregate) {
        aggregate = result;
        continue;
      }
      aggregate = {
        ...result,
        fetched: (aggregate.fetched || 0) + (result.fetched || 0),
        queued: (aggregate.queued || 0) + (result.queued || 0),
        processed: (aggregate.processed || 0) + (result.processed || 0),
        requestCount: (aggregate.requestCount || 0) + (result.requestCount || 0),
        backlog: Boolean(aggregate.backlog || result.backlog),
      };
    }
    return aggregate;
  }

  async pollOutgoingMessagesOnceForChat(chat, { signal } = {}) {
    if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
      const pendingResult = await this.drainPendingEvents();
      if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
        return {
          ...pendingResult,
          status: pendingResult?.status === "cooldown" ? "cooldown" : "backlog",
          fetched: 0,
          queued: 0,
          processed: Number(pendingResult?.processed) || 0,
          backlog: true,
        };
      }
    }
    const rawNowMs = Number(this.now());
    const nowMs = Number.isFinite(rawNowMs) ? rawNowMs : Date.now();
    const nowSeconds = Math.max(0, Math.floor(nowMs / 1_000));
    const replayWindowMs = normalizePositiveInt(
      this.config.weflowOutgoingReplayWindowMs,
      DEFAULT_OUTGOING_REPLAY_WINDOW_MS,
      1_000
    );
    const replayWindowSeconds = Math.max(1, Math.ceil(replayWindowMs / 1_000));
    const cursor = normalizeOutgoingPollCursor(this.state.outgoingPollCursor);
    const cursorRetryNotBeforeMs = Date.parse(cursor.retryNotBefore);
    if (Number.isFinite(cursorRetryNotBeforeMs) && Date.now() < cursorRetryNotBeforeMs) {
      return {
        status: "cooldown",
        fetched: 0,
        queued: 0,
        processed: 0,
        requestCount: 0,
        backfillActive: cursor.backfillActive,
        nextRetryAt: cursor.retryNotBefore,
      };
    }
    const cursorThroughSeconds = cursor.chat === chat ? cursor.polledThrough : 0;
    const replayStartSeconds = cursor.chat === chat && cursor.backfillActive && cursorThroughSeconds
      ? cursorThroughSeconds + 1
      : Math.max(0, (cursorThroughSeconds || nowSeconds) - replayWindowSeconds);
    const limit = normalizePositiveInt(this.config.weflowMessageLimit, DEFAULT_MESSAGE_LIMIT, 1);
    const range = await fetchMessageRangePaginated({
      config: this.config,
      chat,
      startSeconds: replayStartSeconds,
      endSeconds: nowSeconds,
      limit,
      maxRequests: normalizePositiveInt(
        this.config.weflowOutgoingPollMaxRequests,
        DEFAULT_OUTGOING_POLL_MAX_REQUESTS,
        1
      ),
      fetchImpl: this.fetchImpl,
      signal,
    });
    const { rows, requestCount } = range;
    const candidates = rows
      .map((row) => buildPolledMessagePush(row, chat, replayStartSeconds))
      .filter(Boolean)
      .sort(comparePolledPushes);
    let queued = 0;
    let backlog = false;
    let backlogAtSeconds = 0;
    for (const push of candidates) {
      const key = buildEventKey("message.new", push);
      if (!key || this.eventTombstones.has(key) || this.pendingEvents.has(key)) {
        continue;
      }
      if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
        backlog = true;
        backlogAtSeconds = normalizeEpochSeconds(push.timestamp);
        break;
      }
      this.pendingEvents.set(key, { eventType: "message.new", push });
      queued += 1;
    }
    const rangeComplete = range.complete && !backlog;
    const safeThrough = backlogAtSeconds
      ? Math.min(range.throughSeconds, Math.max(0, backlogAtSeconds - 1))
      : range.throughSeconds;
    const nextPolledThrough = rangeComplete
      ? nowSeconds
      : Math.max(cursorThroughSeconds, safeThrough);
    const madeCursorProgress = rangeComplete || nextPolledThrough > cursorThroughSeconds;
    const stalled = !rangeComplete && !madeCursorProgress;
    const stallAttempt = stalled ? Math.min(16, cursor.stallAttempt + 1) : 0;
    const retryNotBefore = stalled
      ? new Date(Date.now() + Math.min(
        DEFAULT_POLL_STALL_RETRY_MAX_MS,
        1_000 * (2 ** Math.min(6, stallAttempt - 1))
      )).toISOString()
      : "";
    if (rangeComplete
      || nextPolledThrough > cursorThroughSeconds
      || (!rangeComplete && cursor.chat === chat && !cursor.backfillActive)) {
      this.state.outgoingPollCursor = advanceOutgoingPollCursor({
        previous: cursor.chat === chat ? cursor : null,
        chat,
        polledThrough: nextPolledThrough,
        backfillActive: !rangeComplete,
        candidates,
        stallAttempt,
        retryNotBefore,
      });
    } else if (stalled) {
      this.state.outgoingPollCursor = {
        ...cursor,
        chat,
        backfillActive: true,
        stallAttempt,
        retryNotBefore,
      };
    }
    this.syncPendingState();
    await this.saveState();
    if (!this.pendingEvents.size) {
      return {
        status: backlog ? "backlog" : "ok",
        fetched: rows.length,
        queued: 0,
        processed: 0,
        requestCount,
        backfillActive: !rangeComplete,
        ...(stalled ? { status: "stalled", nextRetryAt: retryNotBefore } : {}),
      };
    }
    const result = await this.drainPendingEvents();
    if (this.pendingEvents.size) {
      this.schedulePendingDrain();
    }
    return {
      ...result,
      fetched: rows.length,
      queued,
      processed: Number(result?.processed) || 0,
      requestCount,
      backlog,
      backfillActive: !rangeComplete,
      ...(stalled ? { status: "stalled", nextRetryAt: retryNotBefore } : {}),
    };
  }

  async handleSseEvent(event) {
    const eventType = normalizeText(event?.event) || "message";
    if (eventType !== "message.new" && eventType !== "message.revoke") {
      return { status: "ignored_event" };
    }
    const push = normalizePushData(event?.data);
    const chat = normalizeText(push.sessionId || push.talker || push.chatUsername);
    if (!chat || !(Array.isArray(this.config.weflowInboxChats) && this.config.weflowInboxChats.length ? this.config.weflowInboxChats.includes(chat) : chat === normalizeText(this.config.weflowInboxChat))) {
      return { status: "ignored_chat" };
    }
    const key = buildEventKey(eventType, push);
    if (!key || this.eventTombstones.has(key)) {
      return { status: "duplicate" };
    }
    if (this.pendingEvents.has(key)) {
      // A repeated revoke is only a transport duplicate. In particular it must
      // not call the activity sink again or refresh the batching deadline while
      // the original durable item is waiting for its scheduled retry.
      if (eventType === "message.revoke") {
        return { status: "duplicate" };
      }
      const result = await this.drainPendingEvents();
      if (this.pendingEvents.size) {
        this.schedulePendingDrain();
      }
      return result;
    }
    if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
      this.logger.error?.(
        `[cyberboss] WeFlow pending queue is full (${MAX_PENDING_EVENTS}); reconnecting while poll backfill catches up`
      );
      this.abortController?.abort();
      return { status: "backpressure" };
    }
    this.pendingEvents.set(key, {
      eventType,
      push,
      ...(eventType === "message.revoke" ? { receivedAt: isoFromNow(this.now) } : {}),
    });
    this.syncPendingState();
    await this.saveState();
    const result = await this.drainPendingEvents();
    if (this.pendingEvents.size) {
      this.schedulePendingDrain();
    }
    return result;
  }

  schedulePendingDrain() {
    if (!this.running || !this.pendingEvents.size) {
      return;
    }
    const nowMs = Date.now();
    const pairingOwnerByParticipant = buildPendingPairingReservationMap(this.pendingEvents);
    const perEventRetryAtMs = [...this.pendingEvents.entries()]
      .filter(([key]) => !pairingOwnerByParticipant.has(key))
      .map(([, item]) => {
        const retryAtMs = Date.parse(normalizeIsoDate(item?.retryNotBefore));
        return Number.isFinite(retryAtMs) && retryAtMs > nowMs ? retryAtMs : nowMs;
      })
      .reduce((earliest, retryAtMs) => Math.min(earliest, retryAtMs), Number.POSITIVE_INFINITY);
    // A global cooldown represents a source-wide failure and therefore gates
    // every item. Otherwise the earliest per-item retry (including a newly
    // ready item) decides the timer.
    const scheduledAtMs = this.pendingRetryNotBeforeMs > nowMs
      ? this.pendingRetryNotBeforeMs
      : perEventRetryAtMs;
    const delayMs = Math.max(
      250,
      (Number.isFinite(scheduledAtMs) ? scheduledAtMs : (nowMs + 1_000)) - nowMs
    );
    const dueAtMs = nowMs + delayMs;
    if (this.pendingTimer) {
      if (this.pendingTimerDueAtMs > 0 && this.pendingTimerDueAtMs <= dueAtMs) {
        return;
      }
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      this.pendingTimerDueAtMs = 0;
    }
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.pendingTimerDueAtMs = 0;
      void this.drainPendingEvents()
        .catch((error) => {
          if (this.running && !isAbortError(error)) {
            this.logger.error?.(`[cyberboss] WeFlow pending retry failed: ${formatError(error)}`);
          }
        })
        .finally(() => {
          if (this.pendingEvents.size) {
            this.schedulePendingDrain();
          }
        });
    }, delayMs);
    this.pendingTimerDueAtMs = dueAtMs;
    this.pendingTimer.unref?.();
  }

  async drainPendingEvents() {
    if (this.pendingDrainPromise) {
      return this.pendingDrainPromise;
    }
    if (this.pendingEvents.size && Date.now() < this.pendingRetryNotBeforeMs) {
      return {
        status: "cooldown",
        processed: 0,
        nextRetryAt: new Date(this.pendingRetryNotBeforeMs).toISOString(),
      };
    }
    const drainPromise = (async () => {
      try {
        const result = await this.drainPendingEventsExclusive();
        this.updatePendingRetryState(result);
        return this.pendingRetryNotBeforeMs && this.pendingEvents.size
          ? { ...result, nextRetryAt: new Date(this.pendingRetryNotBeforeMs).toISOString() }
          : result;
      } catch (error) {
        this.recordPendingRetryFailure();
        throw error;
      }
    })();
    this.pendingDrainPromise = drainPromise;
    try {
      return await drainPromise;
    } finally {
      if (this.pendingDrainPromise === drainPromise) {
        this.pendingDrainPromise = null;
      }
    }
  }

  updatePendingRetryState(result) {
    if (result?.perEventWaiting) {
      this.pendingRetryAttempt = 0;
      this.pendingRetryNotBeforeMs = 0;
      return;
    }
    if (!this.pendingEvents.size || result?.status === "ok") {
      this.pendingRetryAttempt = 0;
      this.pendingRetryNotBeforeMs = 0;
      return;
    }
    if (result?.status === "stopped" || result?.status === "cooldown") {
      return;
    }
    if (Number(result?.processed) > 0) {
      this.pendingRetryAttempt = 0;
    }
    this.recordPendingRetryFailure();
  }

  recordPendingRetryFailure() {
    this.pendingRetryAttempt = Math.min(16, this.pendingRetryAttempt + 1);
    const delayMs = Math.min(
      DEFAULT_PENDING_RETRY_MAX_MS,
      1_000 * (2 ** Math.min(6, this.pendingRetryAttempt - 1))
    );
    this.pendingRetryNotBeforeMs = Date.now() + delayMs;
  }

  capturePendingTransitionState() {
    return {
      seenIds: [...this.state.seenIds],
      lastEventAt: this.state.lastEventAt,
      deadLetters: Array.isArray(this.state.deadLetters)
        ? this.state.deadLetters.map((item) => ({
          ...item,
          push: { ...item.push },
          participantKeys: [...(item.participantKeys || [])],
        }))
        : [],
      pendingEntries: [...this.pendingEvents.entries()].map(([key, item]) => [
        key,
        {
          ...item,
          push: { ...item.push },
          companionKeys: [...(item.companionKeys || [])],
          pairing: item.pairing ? { ...item.pairing } : null,
        },
      ]),
    };
  }

  restorePendingTransitionState(snapshot) {
    this.state.seenIds = [...snapshot.seenIds];
    this.state.lastEventAt = snapshot.lastEventAt;
    this.state.deadLetters = snapshot.deadLetters.map((item) => ({
      ...item,
      push: { ...item.push },
      participantKeys: [...(item.participantKeys || [])],
    }));
    this.eventTombstones = buildDurableEventTombstoneSet(this.state);
    this.pendingEvents.clear();
    for (const [key, item] of snapshot.pendingEntries) {
      this.pendingEvents.set(key, {
        ...item,
        push: { ...item.push },
        companionKeys: [...(item.companionKeys || [])],
        pairing: item.pairing ? { ...item.pairing } : null,
      });
    }
    this.syncPendingState();
  }

  canonicalizePendingPairingOwners() {
    const descriptors = [];
    const parentByKey = new Map();
    const ensureKey = (key) => {
      const normalized = normalizeEventKey(key);
      if (normalized && !parentByKey.has(normalized)) {
        parentByKey.set(normalized, normalized);
      }
      return normalized;
    };
    const findRoot = (key) => {
      const normalized = ensureKey(key);
      if (!normalized) {
        return "";
      }
      let root = normalized;
      while (parentByKey.get(root) !== root) {
        root = parentByKey.get(root);
      }
      let cursor = normalized;
      while (parentByKey.get(cursor) !== cursor) {
        const next = parentByKey.get(cursor);
        parentByKey.set(cursor, root);
        cursor = next;
      }
      return root;
    };
    const unionKeys = (left, right) => {
      const leftRoot = findRoot(left);
      const rightRoot = findRoot(right);
      if (leftRoot && rightRoot && leftRoot !== rightRoot) {
        parentByKey.set(rightRoot, leftRoot);
      }
    };

    for (const [ownerKey, ownerItem] of this.pendingEvents.entries()) {
      const pairing = normalizePendingPairing(ownerItem?.pairing, {
        key: ownerKey,
        companionKeys: ownerItem?.companionKeys,
      });
      if (!pairing) {
        continue;
      }
      const participantKeys = normalizePairingParticipantKeys(
        ownerKey,
        pairing,
        ownerItem?.companionKeys
      );
      descriptors.push({ ownerKey, ownerItem, pairing, participantKeys });
      for (const participantKey of participantKeys) {
        unionKeys(ownerKey, participantKey);
      }
    }

    const ownerByParticipant = new Map();
    if (!descriptors.length) {
      return { ownerByParticipant, changed: false, quarantined: 0 };
    }
    const groups = new Map();
    for (const descriptor of descriptors) {
      const root = findRoot(descriptor.ownerKey);
      const group = groups.get(root) || [];
      group.push(descriptor);
      groups.set(root, group);
    }

    let changed = false;
    let quarantined = 0;
    for (const group of groups.values()) {
      const participantKeys = [...new Set(group.flatMap((item) => item.participantKeys))];
      const anchorCandidates = [...new Set(group
        .map((item) => normalizeEventKey(item.pairing?.anchorKey))
        .filter(Boolean))];
      const anchorKey = anchorCandidates.find((key) => this.pendingEvents.has(key))
        || anchorCandidates[0]
        || group[0].ownerKey;
      const canonicalKey = this.pendingEvents.has(anchorKey)
        ? anchorKey
        : group.map((item) => item.ownerKey).find((key) => this.pendingEvents.has(key));
      const canonicalItem = canonicalKey ? this.pendingEvents.get(canonicalKey) : null;
      if (!canonicalKey || !canonicalItem) {
        continue;
      }

      const seenParticipants = participantKeys.filter((key) => this.eventTombstones.has(key));
      if (seenParticipants.length) {
        if (!seenParticipants.includes(anchorKey)) {
          this.rememberDeadLetter({
            key: canonicalKey,
            eventType: normalizeText(canonicalItem?.eventType) || "message.new",
            push: normalizePushData(canonicalItem?.push),
            code: "partial_pairing_already_seen",
            reason: "图片配对的部分参与项已有处理记录，残余组已原子隔离以避免重复附件",
            kind: "image",
            messageId: normalizeText(canonicalItem?.push?.rawid || canonicalItem?.push?.serverId),
            participantKeys,
            quarantinedAt: new Date(this.now()).toISOString(),
          });
          quarantined += 1;
        }
        for (const participantKey of participantKeys) {
          this.rememberSeen(participantKey);
          this.pendingEvents.delete(participantKey);
        }
        for (const descriptor of group) {
          this.pendingEvents.delete(descriptor.ownerKey);
        }
        changed = true;
        continue;
      }

      const companionKeys = normalizeCompanionKeys(
        participantKeys.filter((key) => key !== anchorKey),
        { anchorKey }
      );
      const observationDeadline = group
        .map((item) => normalizeIsoDate(item.pairing?.observationDeadline))
        .filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || "";
      const canonicalPairing = {
        status: companionKeys.length ? "locked" : "awaiting_companion",
        anchorKey,
        ...(!companionKeys.length && observationDeadline ? { observationDeadline } : {}),
      };
      const mediaDeadline = group
        .map((item) => normalizeIsoDate(item.ownerItem?.mediaDeadline))
        .filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || "";
      const retryAttempt = Math.max(
        0,
        ...group.map((item) => normalizePendingItemRetryAttempt(item.ownerItem?.retryAttempt))
      );
      const retryNotBefore = group
        .map((item) => normalizeIsoDate(item.ownerItem?.retryNotBefore))
        .filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || "";
      if (JSON.stringify(normalizePendingPairing(canonicalItem.pairing, {
        key: canonicalKey,
        companionKeys: canonicalItem.companionKeys,
      })) !== JSON.stringify(canonicalPairing)
        || JSON.stringify(normalizeCompanionKeys(canonicalItem.companionKeys, { anchorKey }))
          !== JSON.stringify(companionKeys)
        || (mediaDeadline && normalizeIsoDate(canonicalItem.mediaDeadline) !== mediaDeadline)
        || normalizePendingItemRetryAttempt(canonicalItem.retryAttempt) !== retryAttempt
        || (retryNotBefore && normalizeIsoDate(canonicalItem.retryNotBefore) !== retryNotBefore)) {
        canonicalItem.pairing = canonicalPairing;
        canonicalItem.companionKeys = companionKeys;
        if (mediaDeadline) {
          canonicalItem.mediaDeadline = mediaDeadline;
        }
        canonicalItem.retryAttempt = retryAttempt;
        if (retryNotBefore) {
          canonicalItem.retryNotBefore = retryNotBefore;
        }
        this.pendingEvents.set(canonicalKey, canonicalItem);
        changed = true;
      }
      for (const descriptor of group) {
        if (descriptor.ownerKey === canonicalKey) {
          continue;
        }
        if (descriptor.ownerItem.pairing
          || normalizeCompanionKeys(descriptor.ownerItem.companionKeys).length) {
          descriptor.ownerItem.pairing = null;
          descriptor.ownerItem.companionKeys = [];
          this.pendingEvents.set(descriptor.ownerKey, descriptor.ownerItem);
          changed = true;
        }
      }
      for (const participantKey of participantKeys) {
        if (participantKey !== canonicalKey && this.pendingEvents.has(participantKey)) {
          ownerByParticipant.set(participantKey, canonicalKey);
        }
      }
    }
    return { ownerByParticipant, changed, quarantined };
  }

  async drainPendingEventsExclusive() {
    this.syncPendingState();
    await this.saveState();
    if (!await this.isReady()) {
      return { status: "waiting_for_reply_target", processed: 0 };
    }
    const pairingMigrationRollback = this.capturePendingTransitionState();
    const pairingMigration = this.canonicalizePendingPairingOwners();
    if (pairingMigration.changed) {
      this.syncPendingState();
      try {
        await this.saveState();
      } catch (error) {
        this.restorePendingTransitionState(pairingMigrationRollback);
        throw error;
      }
    }
    let processed = 0;
    let quarantined = pairingMigration.quarantined;
    let waitingStatus = "";
    let nextRetryAtMs = Number.POSITIVE_INFINITY;
    let perEventWaiting = false;
    const pairingOwnerByParticipant = pairingMigration.ownerByParticipant;
    for (const [key, item] of [...this.pendingEvents.entries()]) {
      if (this.eventTombstones.has(key)) {
        this.pendingEvents.delete(key);
        this.syncPendingState();
        await this.saveState();
        continue;
      }
      // A locked/observed pair is one atomic source event. Its companion may
      // also have its own SSE/poll entry, but only the pairing owner may resolve
      // or acknowledge it.
      if (pairingOwnerByParticipant.has(key)) {
        continue;
      }
      if (this.stopping) {
        return {
          status: "stopped",
          processed,
          ...(quarantined ? { quarantined } : {}),
        };
      }
      const itemRetryAtMs = Date.parse(normalizeIsoDate(item?.retryNotBefore));
      if (Number.isFinite(itemRetryAtMs) && this.now() < itemRetryAtMs) {
        perEventWaiting = true;
        waitingStatus = waitingStatus || "waiting_for_pending_retry";
        nextRetryAtMs = Math.min(nextRetryAtMs, itemRetryAtMs);
        continue;
      }
      if (normalizeText(item?.eventType) === "message.revoke") {
        const rawId = item?.push?.rawid ?? item?.push?.serverId ?? item?.push?.id ?? "";
        const revokedMessageId = normalizeText(
          typeof rawId === "string" ? rawId : String(rawId)
        );
        const rawPushTimestamp = item?.push?.timestamp ?? item?.push?.createTime;
        const activity = {
          kind: "revoke",
          eventType: "message.revoke",
          revokedMessageId,
          receivedAt: normalizeIsoDate(item.receivedAt) || isoFromNow(this.now),
          ...(rawPushTimestamp !== undefined && rawPushTimestamp !== null && rawPushTimestamp !== ""
            ? { pushTimestamp: rawPushTimestamp }
            : {}),
        };
        const snapshot = {
          chat: normalizeText(item?.push?.sourceName)
            || normalizeText(this.config.weflowInboxDisplayName),
          chatUsername: normalizeText(
            item?.push?.sessionId || item?.push?.talker || item?.push?.chatUsername
          ) || normalizeText(this.config.weflowInboxChat),
          messages: [],
          failures: [],
        };
        const accepted = await this.onActivity(activity, snapshot);
        if (this.stopping) {
          return {
            status: "stopped",
            processed,
            ...(quarantined ? { quarantined } : {}),
          };
        }
        if (accepted === false) {
          const retry = buildPendingItemRetry(item, { nowMs: this.now() });
          item.retryAttempt = retry.retryAttempt;
          item.retryNotBefore = retry.retryNotBefore;
          this.pendingEvents.set(key, item);
          this.syncPendingState();
          await this.saveState();
          perEventWaiting = true;
          waitingStatus = waitingStatus || "deferred";
          nextRetryAtMs = Math.min(nextRetryAtMs, Date.parse(retry.retryNotBefore));
          continue;
        }
        processed += 1;
        const transitionRollback = this.capturePendingTransitionState();
        const revokedEventKey = revokedMessageId
          ? `message.new:${revokedMessageId}`
          : "";
        const canceledMessageKeys = collectPendingLogicalMessageKeys(
          this.pendingEvents,
          revokedEventKey
        );
        // Committing a revoke also commits a durable tombstone for the original
        // message.new event. This closes the SSE ordering race where the revoke
        // is observed before a delayed message.new/backfill row. If the recalled
        // row belongs to an in-flight image pairing, every participant is one
        // logical event and must be canceled in the same cursor transaction.
        for (const canceledKey of canceledMessageKeys) {
          this.rememberSeen(canceledKey);
          this.pendingEvents.delete(canceledKey);
        }
        this.rememberSeen(key);
        this.pendingEvents.delete(key);
        this.syncPendingState();
        try {
          await this.saveState();
        } catch (error) {
          this.restorePendingTransitionState(transitionRollback);
          throw error;
        }
        continue;
      }
      const resolved = await this.resolvePushMessage(item.push, { key, item });
      if (this.stopping) {
        return {
          status: "stopped",
          processed,
          ...(quarantined ? { quarantined } : {}),
        };
      }
      if (resolved.clearPairing) {
        item.companionKeys = [];
        item.pairing = null;
        this.pendingEvents.set(key, item);
        this.syncPendingState();
        await this.saveState();
      }
      if (resolved.mediaDeadline
        && normalizeIsoDate(item.mediaDeadline) !== normalizeIsoDate(resolved.mediaDeadline)) {
        item.mediaDeadline = normalizeIsoDate(resolved.mediaDeadline);
        this.pendingEvents.set(key, item);
        this.syncPendingState();
        await this.saveState();
      }
      if (resolved.pairing) {
        item.companionKeys = normalizeCompanionKeys(resolved.companionKeys, {
          anchorKey: resolved.pairing.anchorKey,
        });
        item.pairing = normalizePendingPairing(resolved.pairing, {
          key,
          companionKeys: item.companionKeys,
        });
        this.pendingEvents.set(key, item);
        this.syncPendingState();
        await this.saveState();
        // Pairing may be discovered for the first time during this drain. Make
        // its participants atomic immediately, not only after the next drain
        // rebuilds the reservation map from cursor state.
        for (const participantKey of normalizePairingParticipantKeys(
          key,
          item.pairing,
          item.companionKeys
        )) {
          if (participantKey !== key && !pairingOwnerByParticipant.has(participantKey)) {
            pairingOwnerByParticipant.set(participantKey, key);
          }
        }
      }
      if (resolved.ready === false) {
        const retry = buildPendingItemRetry(item, {
          nowMs: this.now(),
          deadline: resolved.mediaDeadline || resolved.pairing?.observationDeadline,
        });
        item.retryAttempt = retry.retryAttempt;
        item.retryNotBefore = retry.retryNotBefore;
        this.pendingEvents.set(key, item);
        this.syncPendingState();
        await this.saveState();
        perEventWaiting = true;
        waitingStatus = waitingStatus || resolved.status || "waiting_for_companion_media";
        nextRetryAtMs = Math.min(nextRetryAtMs, Date.parse(retry.retryNotBefore));
        continue;
      }
      if (this.stopping) {
        return {
          status: "stopped",
          processed,
          ...(quarantined ? { quarantined } : {}),
        };
      }
      if (resolved.deadLetter) {
        const transitionRollback = this.capturePendingTransitionState();
        const participantKeys = normalizeDeadLetterParticipantKeys(
          resolved.deadLetter.participantKeys,
          { fallbackKey: key }
        );
        this.rememberDeadLetter({
          key,
          eventType: normalizeText(item?.eventType) || "message.new",
          push: normalizePushData(item?.push),
          ...resolved.deadLetter,
          participantKeys,
          quarantinedAt: new Date(this.now()).toISOString(),
        });
        for (const participantKey of participantKeys) {
          this.rememberSeen(participantKey);
          this.pendingEvents.delete(participantKey);
        }
        quarantined += 1;
        this.syncPendingState();
        try {
          await this.saveState();
        } catch (error) {
          this.restorePendingTransitionState(transitionRollback);
          throw error;
        }
        continue;
      }
      const accepted = await this.onMessage(resolved.message, resolved.snapshot);
      if (this.stopping) {
        return {
          status: "stopped",
          processed,
          ...(quarantined ? { quarantined } : {}),
        };
      }
      if (accepted === false) {
        const retry = buildPendingItemRetry(item, { nowMs: this.now() });
        item.retryAttempt = retry.retryAttempt;
        item.retryNotBefore = retry.retryNotBefore;
        this.pendingEvents.set(key, item);
        this.syncPendingState();
        await this.saveState();
        perEventWaiting = true;
        waitingStatus = waitingStatus || "deferred";
        nextRetryAtMs = Math.min(nextRetryAtMs, Date.parse(retry.retryNotBefore));
        continue;
      }
      processed += 1;
      const acknowledgedKeys = resolved.pairing?.status === "locked"
        ? normalizePairingParticipantKeys(key, resolved.pairing, resolved.companionKeys)
        : [key];
      for (const acknowledgedKey of acknowledgedKeys) {
        this.rememberSeen(acknowledgedKey);
        this.pendingEvents.delete(acknowledgedKey);
      }
      this.syncPendingState();
      await this.saveState();
    }
    return {
      status: waitingStatus || "ok",
      processed,
      ...(quarantined ? { quarantined } : {}),
      ...(perEventWaiting ? { perEventWaiting: true } : {}),
      ...(Number.isFinite(nextRetryAtMs)
        ? { nextRetryAt: new Date(nextRetryAtMs).toISOString() }
        : {}),
    };
  }

  async resolvePushMessage(push, { key = "", item = null } = {}) {
    let details = [];
    let matched = null;
    let pairingResolution = null;
    let clearPairing = false;
    const persistedPairing = normalizePendingPairing(item?.pairing, {
      key,
      companionKeys: item?.companionKeys,
    });
    let observationDeadline = persistedPairing?.status === "awaiting_companion"
      ? normalizeIsoDate(persistedPairing.observationDeadline)
      : "";
    let mediaDeadline = normalizeIsoDate(item?.mediaDeadline);
    // Empty awaiting_companion records were written by the first cursor-v3
    // implementation. Let those complete with the legacy bounded probe instead
    // of silently extending them by a fresh observation window after upgrade.
    const legacyAwaitingPairing = persistedPairing?.status === "awaiting_companion"
      && !observationDeadline;
    // A durable retry has already paid the initial short observation probes.
    // Use one REST lookup per due attempt so several unavailable media events
    // cannot serially impose N * 2.5 seconds on a later ordinary message.
    const mediaRetryDelays = normalizePendingItemRetryAttempt(item?.retryAttempt)
      ? [0]
      : MEDIA_RETRY_DELAYS_MS;
    for (const retryMs of mediaRetryDelays) {
      if (retryMs) {
        const remainingDeadlineMs = [observationDeadline, mediaDeadline]
          .map((deadline) => Date.parse(deadline))
          .filter(Number.isFinite)
          .reduce((remaining, deadlineMs) => (
            Math.min(remaining, Math.max(0, deadlineMs - this.now()))
          ), retryMs);
        await delay(Math.min(retryMs, remainingDeadlineMs));
      }
      details = await fetchMessageDetails(this.config, push, this.fetchImpl);
      matched = findPushedMessage(details, push);
      pairingResolution = resolveImageCompanionPairing({
        details,
        push,
        eventKey: key || buildEventKey("message.new", push),
        persistedPairing,
        persistedCompanionKeys: item?.companionKeys,
        seenIds: [...this.eventTombstones],
        chat: normalizeText(push?.sessionId) || normalizeText(this.config.weflowInboxChat),
      });
      if (pairingResolution?.status === "awaiting_companion"
        && !normalizeCompanionKeys(pairingResolution.companionKeys).length) {
        if (!observationDeadline && !legacyAwaitingPairing) {
          observationDeadline = new Date(
            this.now() + IMAGE_COMPANION_OBSERVATION_WINDOW_MS
          ).toISOString();
          if (item && key) {
            // Persist before the remaining in-process probes so a service stop
            // or crash cannot silently restart the full fifteen-second window.
            item.companionKeys = [];
            item.pairing = {
              status: "awaiting_companion",
              anchorKey: pairingResolution.anchorKey,
              observationDeadline,
            };
            this.pendingEvents.set(key, item);
            this.syncPendingState();
            await this.saveState();
          }
        }
        pairingResolution.observationDeadline = observationDeadline;
        if (observationDeadline && this.now() >= Date.parse(observationDeadline)) {
          break;
        }
      }
      const discoveredCompanionKeys = normalizeCompanionKeys(pairingResolution?.companionKeys, {
        anchorKey: pairingResolution?.anchorKey,
      });
      if (pairingResolution && discoveredCompanionKeys.length && !pairingResolution.ready) {
        if (!mediaDeadline) {
          mediaDeadline = buildDirectMediaDeadline(
            pairingResolution.anchor || matched || push,
            this.now(),
            "image"
          );
          if (item && key) {
            item.mediaDeadline = mediaDeadline;
            this.pendingEvents.set(key, item);
            this.syncPendingState();
            await this.saveState();
          }
        }
        if (this.now() >= Date.parse(mediaDeadline)) {
          break;
        }
      }
      if (pairingResolution) {
        if (pairingResolution.ready) {
          break;
        }
        continue;
      }
      const mediaCandidate = matched || push;
      const directMediaKind = resolveDeadlineBoundDirectMediaKind(mediaCandidate);
      if (directMediaKind && (!matched || !hasUsableMedia(matched))) {
        if (!mediaDeadline) {
          mediaDeadline = buildDirectMediaDeadline(mediaCandidate, this.now(), directMediaKind);
          if (item && key) {
            // The source timestamp makes legacy/backfilled media expire
            // immediately while a fresh event keeps the full bounded window.
            // Persist before the remaining probes so restart never resets it.
            item.mediaDeadline = mediaDeadline;
            this.pendingEvents.set(key, item);
            this.syncPendingState();
            await this.saveState();
          }
        }
        if (this.now() >= Date.parse(mediaDeadline)) {
          break;
        }
        continue;
      }
      if (matched && (!messageExpectsMedia(matched) || hasUsableMedia(matched))) {
        break;
      }
    }
    if (pairingResolution?.status === "awaiting_companion"
      && !normalizeCompanionKeys(pairingResolution.companionKeys).length) {
      const observationExpired = legacyAwaitingPairing
        || (observationDeadline && this.now() >= Date.parse(observationDeadline));
      if (observationExpired) {
        // A narrow prompt is only a pairing candidate, not proof that media will
        // follow. Deliver it exactly once when the durable observation window
        // expires. Legacy empty v3 pairings take this path after the old bounded
        // probe so they cannot remain blocked forever after upgrade.
        clearPairing = Boolean(persistedPairing);
        pairingResolution = null;
      }
    }
    if (pairingResolution) {
      const companionKeys = normalizeCompanionKeys(pairingResolution.companionKeys, {
        anchorKey: pairingResolution.anchorKey,
      });
      const pairing = {
        // Once REST exposes stable participant ids, persist an immutable lock.
        // Media readiness is intentionally only a property of this attempt.
        status: companionKeys.length ? "locked" : pairingResolution.status,
        anchorKey: pairingResolution.anchorKey,
        ...(pairingResolution.status === "awaiting_companion" && observationDeadline
          ? { observationDeadline }
          : {}),
      };
      const snapshot = {
        chat: normalizeText(push.sourceName) || normalizeText(this.config.weflowInboxDisplayName),
        chatUsername: normalizeText(push.sessionId) || normalizeText(this.config.weflowInboxChat),
        messages: details,
        failures: [],
      };
      if (!pairingResolution.ready) {
        if (companionKeys.length) {
          mediaDeadline = mediaDeadline || buildDirectMediaDeadline(
            pairingResolution.anchor || matched || push,
            this.now(),
            "image"
          );
          if (this.now() >= Date.parse(mediaDeadline)) {
            const participantKeys = normalizePairingParticipantKeys(
              key || pairing.anchorKey,
              pairing,
              companionKeys
            );
            const failure = {
              code: "media_export_deadline_exceeded",
              kind: "image",
              messageId: normalizeText(
                pairingResolution.anchor?.serverId
                  || pairingResolution.anchor?.rawid
                  || push?.rawid
              ),
              deadline: mediaDeadline,
            };
            snapshot.failures.push(failure);
            this.logger.warn?.(
              `[cyberboss] WeFlow paired image export deadline exceeded; quarantining atomic group message=${failure.messageId || "unknown"} deadline=${mediaDeadline}`
            );
            return {
              ready: true,
              mediaDeadline,
              pairing,
              companionKeys,
              deadLetter: {
                ...failure,
                participantKeys,
                reason: `图片配对附件在 ${Math.round(IMAGE_MEDIA_EXPORT_WINDOW_MS / 1_000)} 秒内未完成本地导出`,
              },
              snapshot,
            };
          }
        }
        return {
          ready: false,
          status: pairingResolution.status === "awaiting_companion"
            ? "waiting_for_companion"
            : "waiting_for_companion_media",
          pairing,
          companionKeys,
          ...(mediaDeadline ? { mediaDeadline } : {}),
          snapshot,
        };
      }
      const message = normalizeWeFlowMessage(pairingResolution.anchor);
      const latestSourceTimestamp = Math.max(
        normalizeEpochSeconds(
          pairingResolution.anchor?.createTime || pairingResolution.anchor?.timestamp
        ),
        ...pairingResolution.companions.map((raw) => (
          normalizeEpochSeconds(raw?.createTime || raw?.timestamp)
        ))
      );
      if (latestSourceTimestamp > 0) {
        // The paired rows are one logical turn, but every physical arrival must
        // still move the outer inactivity window. Anchoring the logical message
        // to the newest source row preserves “last message + 15 seconds” without
        // adding another 15 seconds merely because media preparation was slow.
        message.receivedAt = new Date(latestSourceTimestamp * 1_000).toISOString();
      }
      const attachments = pairingResolution.companions
        .map((raw, index) => buildMediaAttachment(
          raw,
          "direct",
          `weflow:${message.id}:direct:${index + 1}`
        ));
      if (attachments.some((attachment) => !attachment)) {
        mediaDeadline = mediaDeadline || buildDirectMediaDeadline(
          pairingResolution.anchor || matched || push,
          this.now(),
          "image"
        );
        return {
          ready: false,
          status: "waiting_for_companion_media",
          pairing,
          companionKeys,
          mediaDeadline,
          snapshot,
        };
      }
      message.attachments = [...message.attachments, ...attachments];
      message.sourceMessageIds = [...new Set([
        message.id,
        ...pairingResolution.companions.map((raw) => raw?.serverId || raw?.rawid),
      ].map(normalizeText).filter(Boolean))]
        .map((id) => `weflow:${id}`);
      return {
        ready: true,
        message,
        snapshot,
        pairing,
        companionKeys,
      };
    }
    const raw = matched || push;
    const directMediaKind = resolveDeadlineBoundDirectMediaKind(raw);
    if (directMediaKind && (!matched || !hasUsableMedia(matched))) {
      mediaDeadline = mediaDeadline || buildDirectMediaDeadline(raw, this.now(), directMediaKind);
      const snapshot = {
        chat: normalizeText(push.sourceName) || normalizeText(this.config.weflowInboxDisplayName),
        chatUsername: normalizeText(push.sessionId) || normalizeText(this.config.weflowInboxChat),
        messages: details,
        failures: [],
      };
      if (this.now() >= Date.parse(mediaDeadline)) {
        const failure = {
          code: "media_export_deadline_exceeded",
          kind: directMediaKind,
          messageId: normalizeText(raw?.serverId || raw?.rawid || push?.rawid),
          deadline: mediaDeadline,
        };
        snapshot.failures.push(failure);
        this.logger.warn?.(
          `[cyberboss] WeFlow media export deadline exceeded; quarantining source event message=${failure.messageId || "unknown"} kind=${directMediaKind} deadline=${mediaDeadline}`
        );
        return {
          ready: true,
          mediaDeadline,
          deadLetter: {
            ...failure,
            reason: `${defaultKindTitle(directMediaKind)}附件在 ${Math.round(resolveMediaExportWindowMs(directMediaKind) / 1_000)} 秒内未完成本地导出`,
          },
          snapshot,
        };
      }
      return {
        ready: false,
        status: "waiting_for_media",
        mediaDeadline,
        snapshot,
      };
    }
    if ((messageExpectsMedia(raw) || isDirectImageMessage(raw))
      && (!matched || !hasUsableMedia(matched))) {
      return {
        ready: false,
        status: "waiting_for_media",
        snapshot: {
          chat: normalizeText(push.sourceName) || normalizeText(this.config.weflowInboxDisplayName),
          chatUsername: normalizeText(push.sessionId) || normalizeText(this.config.weflowInboxChat),
          messages: details,
          failures: [],
        },
      };
    }
    const quoteId = normalizeText(raw.replyToMessageId || raw.quote?.platformMessageId);
    let quoteMessage = quoteId
      ? details.find((item) => normalizeText(item?.serverId) === quoteId) || null
      : null;
    if (quoteId && !quoteMessage) {
      quoteMessage = await this.fetchQuotedMessage(raw, push, quoteId);
    }
    return {
      ready: true,
      clearPairing,
      message: normalizeWeFlowMessage(raw, { quoteMessage }),
      snapshot: {
        chat: normalizeText(push.sourceName) || normalizeText(this.config.weflowInboxDisplayName),
        chatUsername: normalizeText(push.sessionId) || normalizeText(this.config.weflowInboxChat),
        messages: details,
        failures: [],
      },
    };
  }

  async fetchQuotedMessage(raw, push, quoteId) {
    const quoteTimestamp = extractQuotedCreateTime(raw?.rawContent);
    if (!quoteTimestamp) {
      return null;
    }
    let quoteMessage = null;
    for (const retryMs of MEDIA_RETRY_DELAYS_MS) {
      if (retryMs) {
        await delay(retryMs);
      }
      const quotedDetails = await fetchMessageDetails(this.config, {
        sessionId: normalizeText(push?.sessionId) || normalizeText(this.config.weflowInboxChat),
        timestamp: quoteTimestamp,
        rawid: quoteId,
      }, this.fetchImpl);
      quoteMessage = quotedDetails.find((item) => normalizeText(item?.serverId) === quoteId) || null;
      if (quoteMessage && (!messageExpectsMedia(quoteMessage) || hasUsableMedia(quoteMessage))) {
        return quoteMessage;
      }
    }
    return quoteMessage;
  }

  rememberSeen(key) {
    this.state.seenIds = this.state.seenIds.filter((item) => item !== key);
    this.state.seenIds.push(key);
    if (this.state.seenIds.length > MAX_SEEN_IDS) {
      this.state.seenIds = this.state.seenIds.slice(-MAX_SEEN_IDS);
      this.eventTombstones = buildDurableEventTombstoneSet(this.state);
    } else {
      this.eventTombstones.add(key);
    }
    this.state.lastEventAt = new Date().toISOString();
  }

  rememberDeadLetter(entry) {
    const key = normalizeEventKey(entry?.key);
    if (!key) {
      return;
    }
    const prior = Array.isArray(this.state.deadLetters) ? this.state.deadLetters : [];
    this.state.deadLetters = [
      ...prior.filter((item) => normalizeEventKey(item?.key) !== key),
      {
        key,
        eventType: normalizeText(entry?.eventType) || "message.new",
        push: normalizePushData(entry?.push),
        code: normalizeText(entry?.code) || "media_export_deadline_exceeded",
        reason: normalizeText(entry?.reason),
        kind: normalizeText(entry?.kind),
        messageId: normalizeText(entry?.messageId),
        deadline: normalizeIsoDate(entry?.deadline),
        participantKeys: normalizeDeadLetterParticipantKeys(entry?.participantKeys, {
          fallbackKey: key,
        }),
        quarantinedAt: normalizeIsoDate(entry?.quarantinedAt) || new Date().toISOString(),
      },
    ].slice(-MAX_DEAD_LETTERS);
    this.eventTombstones = buildDurableEventTombstoneSet(this.state);
  }

  async saveState() {
    const filePath = normalizeText(this.config.weflowInboxCursorFile);
    if (!filePath) {
      return;
    }
    const snapshot = {
      version: 3,
      seenIds: [...this.state.seenIds],
      lastEventAt: this.state.lastEventAt,
      deadLetters: Array.isArray(this.state.deadLetters)
        ? this.state.deadLetters.map((item) => ({
          ...item,
          push: { ...item.push },
          participantKeys: [...(item.participantKeys || [])],
        }))
        : [],
      outgoingPollCursor: normalizeOutgoingPollCursor(this.state.outgoingPollCursor),
      pendingEvents: this.state.pendingEvents.map((item) => ({
        key: item.key,
        eventType: item.eventType,
        push: { ...item.push },
        ...(normalizeIsoDate(item.receivedAt)
          ? { receivedAt: normalizeIsoDate(item.receivedAt) }
          : {}),
        ...(normalizeIsoDate(item.mediaDeadline)
          ? { mediaDeadline: normalizeIsoDate(item.mediaDeadline) }
          : {}),
        ...(normalizePendingItemRetryAttempt(item.retryAttempt)
          ? { retryAttempt: normalizePendingItemRetryAttempt(item.retryAttempt) }
          : {}),
        ...(normalizeIsoDate(item.retryNotBefore)
          ? { retryNotBefore: normalizeIsoDate(item.retryNotBefore) }
          : {}),
        ...(item.companionKeys?.length ? { companionKeys: [...item.companionKeys] } : {}),
        ...(item.pairing ? { pairing: { ...item.pairing } } : {}),
      })),
    };
    const write = this.stateWriteChain
      .catch(() => {})
      .then(() => writeJsonAtomic(filePath, snapshot));
    this.stateWriteChain = write;
    await write;
  }

  syncPendingState() {
    this.state.pendingEvents = [...this.pendingEvents.entries()]
      .slice(-MAX_PENDING_EVENTS)
      .map(([key, item]) => {
        const pairing = normalizePendingPairing(item?.pairing, {
          key,
          companionKeys: item?.companionKeys,
        });
        const companionKeys = normalizeCompanionKeys(item?.companionKeys, {
          anchorKey: pairing?.anchorKey,
        });
        return {
          key,
          eventType: normalizeText(item?.eventType) || "message.new",
          push: normalizePushData(item?.push),
          ...(normalizeIsoDate(item?.receivedAt)
            ? { receivedAt: normalizeIsoDate(item.receivedAt) }
            : {}),
          ...(normalizeIsoDate(item?.mediaDeadline)
            ? { mediaDeadline: normalizeIsoDate(item.mediaDeadline) }
            : {}),
          ...(normalizePendingItemRetryAttempt(item?.retryAttempt)
            ? { retryAttempt: normalizePendingItemRetryAttempt(item.retryAttempt) }
            : {}),
          ...(normalizeIsoDate(item?.retryNotBefore)
            ? { retryNotBefore: normalizeIsoDate(item.retryNotBefore) }
            : {}),
          ...(companionKeys.length ? { companionKeys } : {}),
          ...(pairing ? { pairing } : {}),
        };
      });
  }
}

function resolveImageCompanionPairing({
  details,
  push,
  eventKey,
  persistedPairing,
  persistedCompanionKeys,
  seenIds,
  chat,
}) {
  const rows = Array.isArray(details)
    ? details.filter((item) => item && typeof item === "object")
    : [];
  const current = findPushedMessage(rows, push) || (push && typeof push === "object" ? push : null);
  const saved = normalizePendingPairing(persistedPairing, {
    key: eventKey,
    companionKeys: persistedCompanionKeys,
  });
  const savedCompanionKeys = normalizeCompanionKeys(persistedCompanionKeys, {
    anchorKey: saved?.anchorKey,
  });

  if (saved?.status === "locked") {
    const anchor = findMessageByEventKey(rows, saved.anchorKey)
      || (buildEventKey("message.new", current) === saved.anchorKey ? current : null);
    const companions = savedCompanionKeys
      .map((key) => findMessageByEventKey(rows, key)
        || (buildEventKey("message.new", current) === key ? current : null))
      .filter(Boolean);
    const complete = Boolean(anchor)
      && companions.length === savedCompanionKeys.length
      && isValidImageCompanionSequence(anchor, companions, chat)
      && companions.every(hasUsableMedia);
    return {
      ready: complete,
      status: complete ? "locked" : "awaiting_media",
      anchor,
      anchorKey: saved.anchorKey,
      companions,
      companionKeys: savedCompanionKeys,
    };
  }

  let anchor = saved?.anchorKey ? findMessageByEventKey(rows, saved.anchorKey) : null;
  if (!anchor && current && isLeadingImagePrompt(current)) {
    anchor = current;
  }
  if (!anchor && current && isPotentialImageCaption(current)
    && collectTrailingImageCompanions(rows, current, chat).length) {
    // When REST already exposes a strict text -> image tuple, the stable
    // message structure is stronger evidence than any finite prompt lexicon.
    // Generic short text never starts an observation window on its own.
    anchor = current;
  }
  if (!anchor && current && isDirectImageMessage(current)) {
    anchor = findLeadingPromptForImage(rows, current, chat);
  }
  if ((!anchor || !isLeadingImagePrompt(anchor))
    && saved?.status === "awaiting_companion") {
    // The REST detail row may disappear transiently while an observation is
    // already durable. Keep the same anchor/deadline instead of degrading the
    // prompt into a normal turn before its window expires.
    return {
      ready: false,
      status: "awaiting_companion",
      anchor: anchor || current,
      anchorKey: saved.anchorKey,
      companions: [],
      companionKeys: [],
    };
  }
  if (!anchor || !isPotentialImageCaption(anchor)) {
    return null;
  }
  const anchorKey = buildEventKey("message.new", anchor)
    || saved?.anchorKey
    || (isSameMessage(anchor, current) ? normalizeText(eventKey) : "");
  if (!anchorKey) {
    return null;
  }
  const companions = collectTrailingImageCompanions(rows, anchor, chat);
  const companionKeys = companions
    .map((row) => buildEventKey("message.new", row))
    .filter(Boolean)
    .slice(0, MAX_IMAGE_COMPANIONS);
  if (!companions.length || companionKeys.length !== companions.length) {
    if (!isLeadingImagePrompt(anchor)) {
      return null;
    }
    return {
      ready: false,
      status: "awaiting_companion",
      anchor,
      anchorKey,
      companions: [],
      companionKeys: [],
    };
  }
  const normalizedEventKey = normalizeText(eventKey);
  const previouslySeen = new Set(Array.isArray(seenIds) ? seenIds.map(normalizeText).filter(Boolean) : []);
  if ([anchorKey, ...companionKeys].some((key) => (
    key !== normalizedEventKey && previouslySeen.has(key)
  ))) {
    return null;
  }
  const ready = companions.every(hasUsableMedia);
  return {
    ready,
    status: ready ? "locked" : "awaiting_media",
    anchor,
    anchorKey,
    companions,
    companionKeys,
  };
}

function findLeadingPromptForImage(rows, image, chat) {
  const imageLocalId = normalizeLocalId(image?.localId);
  if (!imageLocalId) {
    return null;
  }
  for (let offset = 1; offset <= MAX_IMAGE_COMPANIONS; offset += 1) {
    const candidate = rows.find((row) => normalizeLocalId(row?.localId) === imageLocalId - offset);
    if (!candidate || !hasSameCompanionTuple(candidate, image, chat)) {
      return null;
    }
    if (isPotentialImageCaption(candidate)) {
      return candidate;
    }
    if (!isDirectImageMessage(candidate)) {
      return null;
    }
  }
  return null;
}

function collectTrailingImageCompanions(rows, anchor, chat) {
  const anchorLocalId = normalizeLocalId(anchor?.localId);
  if (!anchorLocalId) {
    return [];
  }
  const companions = [];
  for (let offset = 1; offset <= MAX_IMAGE_COMPANIONS; offset += 1) {
    const candidate = rows.find((row) => normalizeLocalId(row?.localId) === anchorLocalId + offset);
    if (!candidate
      || !hasSameCompanionTuple(anchor, candidate, chat)
      || !isDirectImageMessage(candidate)) {
      break;
    }
    companions.push(candidate);
  }
  return companions;
}

function isValidImageCompanionSequence(anchor, companions, chat) {
  if (!isPotentialImageCaption(anchor)
    || !Array.isArray(companions)
    || !companions.length
    || companions.length > MAX_IMAGE_COMPANIONS) {
    return false;
  }
  const anchorLocalId = normalizeLocalId(anchor?.localId);
  return Boolean(anchorLocalId) && companions.every((candidate, index) => (
    normalizeLocalId(candidate?.localId) === anchorLocalId + index + 1
    && hasSameCompanionTuple(anchor, candidate, chat)
    && isDirectImageMessage(candidate)
  ));
}

function hasSameCompanionTuple(anchor, candidate, fallbackChat) {
  const expectedChat = normalizeText(fallbackChat);
  const anchorChat = messageChat(anchor) || expectedChat;
  const candidateChat = messageChat(candidate) || expectedChat;
  const anchorTime = normalizeEpochSeconds(anchor?.createTime || anchor?.timestamp);
  const candidateTime = normalizeEpochSeconds(candidate?.createTime || candidate?.timestamp);
  const maxSkewSeconds = isLeadingImagePrompt(anchor)
    ? IMAGE_COMPANION_PROMPT_MAX_SKEW_SECONDS
    : IMAGE_COMPANION_STRUCTURAL_MAX_SKEW_SECONDS;
  return Boolean(anchorChat)
    && anchorChat === candidateChat
    && (!expectedChat || anchorChat === expectedChat)
    && anchorTime > 0
    && candidateTime >= anchorTime
    && candidateTime - anchorTime <= maxSkewSeconds
    && isSentMessage(anchor) === isSentMessage(candidate)
    && messageSender(anchor) === messageSender(candidate);
}

function isLeadingImagePrompt(raw) {
  const text = normalizePotentialImageCaption(raw);
  if (!text) {
    return false;
  }
  const explanationPrompt = /^(?:(?:(?:请|麻烦)(?:你)?(?:帮我)?|帮我))?(?:解释|解读|说明)(?:一下|下)?(?:(?:这|这个|这些|这张|这几张)?(?:图片内容|图片?|图像|照片|图中内容|内容)|下图)?(?:吧)?[，,。.!！?？]*$/u;
  const referentialQuestion = /^(?:(?:这|这个|这张(?:图|图片|照片)?)?(?:是)?(?:什么|啥)(?:意思|含义)|(?:这|这个)(?:是)?(?:什么|啥))(?:呢|啊|呀|么)?[，,。.!！?？]*$/u;
  const visualQuestion = /^(?:(?:请|麻烦)?(?:你)?(?:帮我)?(?:看看|看下|看一下|分析|识别)?(?:这|这张)?(?:图|图片|照片|截图|画面)?|(?:图|图片|照片|截图|画面)(?:中|里|内))(?:有|是)?(?:什么|啥|哪些)(?:内容|东西|信息)?(?:呢|啊|呀|么)?[，,。.!！?？]*$/u;
  return explanationPrompt.test(text)
    || referentialQuestion.test(text)
    || visualQuestion.test(text);
}

function isPotentialImageCaption(raw) {
  return Boolean(normalizePotentialImageCaption(raw));
}

function normalizePotentialImageCaption(raw) {
  const quotedMessageId = normalizeText(raw?.replyToMessageId || raw?.quote?.platformMessageId);
  const rawContent = normalizeText(raw?.rawContent);
  const localType = Number(raw?.localType);
  if (!raw
    || messageExpectsMedia(raw)
    || quotedMessageId
    || /<refermsg\b/iu.test(rawContent)
    || Number(extractXmlTag(rawContent, "type")) === 57
    || (Number.isFinite(localType) && localType !== 0 && localType !== 1)
    || raw?.isSystem === true) {
    return "";
  }
  const text = collapseText(raw?.parsedContent || raw?.content, MAX_LEADING_IMAGE_PROMPT_LENGTH + 1)
    .replace(/\s+/gu, "");
  if (!text
    || Array.from(text).length > MAX_LEADING_IMAGE_PROMPT_LENGTH
    || /^[\/／]/u.test(text)
    || /^\[(?:图片|照片|截图|视频|语音消息?|文件|聊天记录)\]$/u.test(text)
    || /^(?:处理中|系统消息|服务已恢复)$/u.test(text)
    || /(?:Cyberboss.*(?:心跳|重启|恢复)|\[Cyberboss心跳探针)/iu.test(text)) {
    return "";
  }
  return text;
}

function isDirectImageMessage(raw) {
  const content = normalizeText(raw?.parsedContent || raw?.content);
  return normalizeMediaKind(raw?.mediaType) === "image"
    || Number(raw?.localType) === 3
    || /^\[图片\]$/.test(content);
}

function findMessageByEventKey(rows, key) {
  const normalizedKey = normalizeText(key);
  return normalizedKey
    ? rows.find((row) => buildEventKey("message.new", row) === normalizedKey) || null
    : null;
}

function isSameMessage(left, right) {
  if (!left || !right) {
    return false;
  }
  const leftKey = buildEventKey("message.new", left);
  const rightKey = buildEventKey("message.new", right);
  return Boolean(leftKey) && leftKey === rightKey;
}

function messageChat(raw) {
  return normalizeText(raw?.talker || raw?.sessionId || raw?.chatUsername);
}

function messageSender(raw) {
  return normalizeText(raw?.senderUsername || raw?.senderUserName || raw?.senderId || raw?.sender);
}

function normalizeLocalId(value) {
  const localId = Number.parseInt(value, 10);
  return Number.isSafeInteger(localId) && localId > 0 ? localId : 0;
}

function normalizeEventKey(value) {
  const key = normalizeText(value);
  return /^message\.new:[^\s].*$/u.test(key) ? key : "";
}

function normalizeDurableEventKey(value) {
  const key = normalizeText(value);
  return /^message\.(?:new|revoke):[^\s].*$/u.test(key) ? key : "";
}

function normalizeCompanionKeys(value, { anchorKey = "" } = {}) {
  const unique = [];
  const excludedAnchor = normalizeEventKey(anchorKey);
  for (const item of Array.isArray(value) ? value : []) {
    const key = normalizeEventKey(item);
    if (key && key !== excludedAnchor && !unique.includes(key)) {
      unique.push(key);
    }
    if (unique.length >= MAX_IMAGE_COMPANIONS) {
      break;
    }
  }
  return unique;
}

function normalizePendingPairing(value, { key = "", companionKeys = [] } = {}) {
  const raw = value && typeof value === "object" ? value : {};
  let status = ["awaiting_companion", "awaiting_media", "locked"].includes(raw.status)
    ? raw.status
    : "";
  const currentKey = normalizeEventKey(key);
  const anchorKey = normalizeEventKey(raw.anchorKey)
    || (status && !normalizeCompanionKeys(companionKeys).includes(currentKey) ? currentKey : "");
  const stableCompanionKeys = normalizeCompanionKeys(companionKeys, { anchorKey });
  if (status && anchorKey) {
    status = stableCompanionKeys.length ? "locked" : "awaiting_companion";
  }
  const observationDeadline = status === "awaiting_companion"
    ? normalizeIsoDate(raw.observationDeadline)
    : "";
  return status && anchorKey
    ? {
      status,
      anchorKey,
      ...(observationDeadline ? { observationDeadline } : {}),
    }
    : null;
}

function normalizePairingParticipantKeys(key, pairing, companionKeys) {
  return [...new Set([
    normalizeEventKey(pairing?.anchorKey),
    ...normalizeCompanionKeys(companionKeys, { anchorKey: pairing?.anchorKey }),
    normalizeEventKey(key),
  ].filter(Boolean))];
}

function buildPendingPairingReservationMap(pendingEvents) {
  const ownerByParticipant = new Map();
  for (const [ownerKey, ownerItem] of pendingEvents instanceof Map ? pendingEvents.entries() : []) {
    const pairing = normalizePendingPairing(ownerItem?.pairing, {
      key: ownerKey,
      companionKeys: ownerItem?.companionKeys,
    });
    if (!pairing) {
      continue;
    }
    const canonicalKey = pendingEvents.has(pairing.anchorKey) ? pairing.anchorKey : ownerKey;
    for (const participantKey of normalizePairingParticipantKeys(
      ownerKey,
      pairing,
      ownerItem?.companionKeys
    )) {
      if (participantKey !== canonicalKey && pendingEvents.has(participantKey)) {
        ownerByParticipant.set(participantKey, canonicalKey);
      }
    }
  }
  return ownerByParticipant;
}

function collectPendingLogicalMessageKeys(pendingEvents, recalledKey) {
  const targetKey = normalizeEventKey(recalledKey);
  if (!targetKey) {
    return [];
  }
  const selected = new Set([targetKey]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [ownerKey, ownerItem] of pendingEvents instanceof Map
      ? pendingEvents.entries()
      : []) {
      if (normalizeText(ownerItem?.eventType) !== "message.new") {
        continue;
      }
      const pairing = normalizePendingPairing(ownerItem?.pairing, {
        key: ownerKey,
        companionKeys: ownerItem?.companionKeys,
      });
      if (!pairing) {
        continue;
      }
      const participantKeys = normalizePairingParticipantKeys(
        ownerKey,
        pairing,
        ownerItem?.companionKeys
      );
      if (!participantKeys.some((participantKey) => selected.has(participantKey))) {
        continue;
      }
      for (const participantKey of participantKeys) {
        if (!selected.has(participantKey)) {
          selected.add(participantKey);
          changed = true;
        }
      }
    }
  }
  return [...selected];
}

function normalizeDeadLetterParticipantKeys(value, { fallbackKey = "" } = {}) {
  const keys = [...new Set([
    ...(Array.isArray(value) ? value : []),
    fallbackKey,
  ].map(normalizeEventKey).filter(Boolean))];
  return keys.slice(0, MAX_IMAGE_COMPANIONS + 1);
}

function normalizePendingItemRetryAttempt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(16, parsed) : 0;
}

function buildPendingItemRetry(item, { nowMs = Date.now(), deadline = "" } = {}) {
  const currentMs = Number.isFinite(Number(nowMs)) && Number(nowMs) > 0
    ? Number(nowMs)
    : Date.now();
  const retryAttempt = Math.min(
    16,
    normalizePendingItemRetryAttempt(item?.retryAttempt) + 1
  );
  const delayMs = Math.min(
    DEFAULT_PENDING_RETRY_MAX_MS,
    1_000 * (2 ** Math.min(6, retryAttempt - 1))
  );
  const deadlineMs = Date.parse(normalizeIsoDate(deadline));
  const retryAtMs = Number.isFinite(deadlineMs)
    ? Math.min(currentMs + delayMs, Math.max(currentMs, deadlineMs))
    : currentMs + delayMs;
  return {
    retryAttempt,
    retryNotBefore: new Date(retryAtMs).toISOString(),
  };
}

function normalizeDeadLetter(value) {
  const raw = value && typeof value === "object" ? value : {};
  const key = normalizeEventKey(raw.key);
  if (!key) {
    return null;
  }
  return {
    key,
    eventType: normalizeText(raw.eventType) || "message.new",
    push: normalizePushData(raw.push),
    code: normalizeText(raw.code) || "media_export_deadline_exceeded",
    reason: normalizeText(raw.reason),
    kind: normalizeText(raw.kind),
    messageId: normalizeText(raw.messageId),
    deadline: normalizeIsoDate(raw.deadline),
    participantKeys: normalizeDeadLetterParticipantKeys(raw.participantKeys, {
      fallbackKey: key,
    }),
    quarantinedAt: normalizeIsoDate(raw.quarantinedAt),
  };
}

function buildDurableEventTombstoneSet(state) {
  const tombstones = new Set(
    (Array.isArray(state?.seenIds) ? state.seenIds : [])
      .map(normalizeDurableEventKey)
      .filter(Boolean)
  );
  for (const entry of Array.isArray(state?.deadLetters) ? state.deadLetters : []) {
    for (const key of normalizeDeadLetterParticipantKeys(entry?.participantKeys, {
      fallbackKey: entry?.key,
    })) {
      tombstones.add(key);
    }
  }
  return tombstones;
}

async function fetchMessageDetails(config, push, fetchImpl = globalThis.fetch) {
  const chat = normalizeText(push?.sessionId || config.weflowInboxChat);
  if (!chat) {
    return [];
  }
  const timestamp = normalizeEpochSeconds(push?.timestamp || push?.createTime);
  const params = new URLSearchParams({
    talker: chat,
    limit: String(normalizePositiveInt(config.weflowMessageLimit, DEFAULT_MESSAGE_LIMIT, 1)),
    media: "1",
    image: "1",
    voice: "1",
    video: "1",
    emoji: "1",
  });
  if (timestamp) {
    params.set("start", String(Math.max(0, timestamp - 300)));
    params.set("end", String(timestamp + 30));
  }
  const response = await fetchImpl(buildApiUrl(config, `/api/v1/messages?${params}`), {
    headers: buildHeaders(config),
  });
  assertHttpOk(response, "WeFlow message detail");
  const payload = await response.json();
  return Array.isArray(payload?.messages)
    ? payload.messages.filter((item) => item && typeof item === "object")
    : [];
}

function normalizeWeFlowMessage(value, { quoteMessage = null } = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const timestamp = normalizeEpochSeconds(raw.createTime || raw.timestamp);
  const serverId = normalizeText(raw.serverId || raw.rawid || raw.id);
  const localId = normalizeText(String(raw.localId ?? ""));
  const id = serverId || localId || `weflow-${timestamp || Date.now()}`;
  const rawContent = normalizeText(raw.rawContent);
  const content = normalizeText(raw.parsedContent || raw.content);
  const appType = Number(extractXmlTag(rawContent, "type")) || 0;
  const mediaKind = normalizeMediaKind(raw.mediaType);
  const url = extractMessageUrl(raw, rawContent, content);
  const merged = appType === 19 || /^\[聊天记录\]$/.test(content)
    ? parseCombinedForward(rawContent)
    : null;
  const quote = buildQuotedContext(raw.quote, quoteMessage, rawContent);
  const attachments = [];
  const directAttachment = buildMediaAttachment(raw, "direct", `weflow:${id}:direct:1`);
  if (directAttachment) {
    attachments.push(directAttachment);
  }
  const quotedAttachment = quoteMessage
    ? buildMediaAttachment(quoteMessage, "quoted", `weflow:${id}:quoted:1`)
    : null;
  if (quotedAttachment) {
    attachments.push(quotedAttachment);
    if (quote) {
      quote.attachmentRefs = [quotedAttachment.attachmentRef];
    }
  } else if (quote && ["image", "voice", "video", "file"].includes(quote.kind) && !quote.text) {
    quote.text = `引用${defaultKindTitle(quote.kind)}的本地附件缺失，请勿使用当前线程中的其他附件代替。`;
  }

  let kind = mediaKind;
  if (merged) {
    kind = "text";
  } else if (appType === 57) {
    // A type-57 message is the user's current reply text. Media markers and
    // placeholder URLs inside <refermsg> describe the quoted source, not the
    // current message itself.
    kind = content ? "text" : "unknown";
  } else if (appType === 6) {
    kind = "file";
  } else if (url) {
    kind = "link";
  } else if (!kind || kind === "unknown") {
    kind = inferContentKind(content, rawContent);
  }
  const title = merged?.title
    || cleanMessagePlaceholder(extractXmlTag(rawContent, "title"))
    || cleanMessagePlaceholder(raw.mediaFileName)
    || defaultKindTitle(kind);
  let text = merged?.text || content;
  if (appType === 57) {
    text = cleanMessagePlaceholder(extractXmlTag(rawContent, "title")) || content;
  } else if (kind === "link") {
    const description = cleanMessagePlaceholder(extractXmlTag(rawContent, "des"));
    text = [cleanMessagePlaceholder(extractXmlTag(rawContent, "title")), description]
      .filter(Boolean)
      .join("\n") || content;
  }
  if (kind !== "text" && isPlaceholderText(text)) {
    text = "";
  }

  return {
    id,
    localId: Number.parseInt(localId, 10) || 0,
    timestamp,
    receivedAt: timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
    direction: isSentMessage(raw) ? "outgoing" : "incoming",
    kind,
    isLinkCard: kind === "link" && (appType > 0 || /<appmsg\b/iu.test(rawContent)),
    title: collapseText(title, 500),
    text: collapseText(text, 12_000, { preserveNewlines: true }),
    url,
    quotedContexts: quote ? [quote] : [],
    attachments,
  };
}

function buildQuotedContext(quote, quoteMessage, rawContent) {
  const snapshot = quote && typeof quote === "object" ? quote : {};
  const referXml = extractXmlTag(rawContent, "refermsg");
  const referContent = decodeXmlEntities(extractXmlTag(referXml, "content"));
  const combined = parseQuotedCombinedForward({
    quoteMessage,
    referContent,
    snapshotContent: snapshot.content,
  });
  if (combined) {
    return {
      kind: "text",
      title: collapseText(combined.title || "合并转发的聊天记录", 500),
      text: collapseText(combined.text, 12_000, { preserveNewlines: true }),
      // The URL embedded in a merged-forward card is only WeChat's unsupported
      // viewer placeholder. The useful source material is the record transcript.
      url: "",
      attachmentRefs: [],
    };
  }
  const content = normalizeText(quoteMessage?.parsedContent || quoteMessage?.content)
    || normalizeText(snapshot.content)
    || cleanMessagePlaceholder(referContent);
  const title = normalizeText(snapshot.accountName || snapshot.displayname)
    || cleanMessagePlaceholder(extractXmlTag(referXml, "displayname"));
  const quoteId = normalizeText(snapshot.platformMessageId)
    || normalizeText(quoteMessage?.serverId)
    || cleanMessagePlaceholder(extractXmlTag(referXml, "svrid"));
  if (!quoteId && !content && !title) {
    return null;
  }
  const kind = quoteMessage
    ? (normalizeMediaKind(quoteMessage.mediaType) || inferContentKind(content, quoteMessage.rawContent))
    : inferContentKind(content, referContent);
  return {
    kind,
    title: collapseText(title || defaultKindTitle(kind), 500),
    text: isPlaceholderText(content) ? "" : collapseText(content, 4_000, { preserveNewlines: true }),
    url: extractMessageUrl(quoteMessage || snapshot, normalizeText(quoteMessage?.rawContent) || referContent, content),
    attachmentRefs: [],
  };
}

function parseQuotedCombinedForward({ quoteMessage, referContent, snapshotContent } = {}) {
  const candidates = [
    {
      rawContent: normalizeText(quoteMessage?.rawContent),
      content: normalizeText(quoteMessage?.parsedContent || quoteMessage?.content),
    },
    {
      rawContent: normalizeText(referContent),
      content: normalizeText(snapshotContent),
    },
  ];
  for (const candidate of candidates) {
    if (!isCombinedForwardMessage(candidate.rawContent, candidate.content)) {
      continue;
    }
    const parsed = parseCombinedForward(candidate.rawContent);
    if (parsed?.text && parsed.text !== "[合并转发]") {
      return parsed;
    }
  }
  return null;
}

function isCombinedForwardMessage(rawContent, content) {
  return Number(extractXmlTag(rawContent, "type")) === 19
    || /^\[聊天记录\]$/.test(normalizeText(content));
}

function buildMediaAttachment(raw, origin, attachmentRef) {
  const mediaPath = chooseMediaPath(raw);
  if (!mediaPath) {
    return null;
  }
  return {
    kind: normalizeMediaKind(raw.mediaType) || inferContentKind(raw.content, raw.rawContent),
    path: mediaPath,
    fileName: path.basename(normalizeText(raw.mediaFileName) || mediaPath),
    origin,
    attachmentRef,
  };
}

function chooseMediaPath(raw) {
  const candidates = [
    raw?.mediaLocalPath,
    raw?.imageLocalPath,
    raw?.voiceLocalPath,
    raw?.videoLocalPath,
    raw?.fileLocalPath,
  ]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .map((value) => path.resolve(value))
    .filter((value) => {
      try {
        return fs.statSync(value).isFile();
      } catch {
        return false;
      }
    });
  return candidates.find((value) => !isThumbnailPath(value)) || candidates[0] || "";
}

function parseCombinedForward(rawContent) {
  const record = decodeXmlEntities(extractXmlTag(rawContent, "recorditem"));
  const title = cleanMessagePlaceholder(extractXmlTag(rawContent, "title")) || "合并转发的聊天记录";
  const items = extractXmlBlocks(record, "dataitem");
  const lines = items.map((item) => {
    const source = cleanMessagePlaceholder(extractXmlTag(item, "sourcename"));
    const itemTitle = cleanMessagePlaceholder(extractXmlTag(item, "datatitle"));
    const description = cleanMessagePlaceholder(extractXmlTag(item, "datadesc"));
    const time = cleanMessagePlaceholder(extractXmlTag(item, "sourcetime"));
    const body = [itemTitle, description].filter(Boolean).join(" — ");
    return body ? `${time ? `[${time}] ` : ""}${source ? `${source}: ` : ""}${body}` : "";
  }).filter(Boolean);
  const fallback = cleanMessagePlaceholder(extractXmlTag(record, "info"))
    || cleanMessagePlaceholder(extractXmlTag(rawContent, "des"));
  return {
    title,
    text: lines.length ? `[合并转发]\n${lines.join("\n")}` : (fallback ? `[合并转发]\n${fallback}` : "[合并转发]"),
  };
}

function extractMessageUrl(raw, rawContent, content) {
  const candidates = [
    raw?.url,
    extractXmlTag(rawContent, "url"),
    ...(String(content || "").match(/https?:\/\/[^\s<>'\"]+/gi) || []),
  ];
  for (const candidate of candidates) {
    const normalized = decodeXmlEntities(normalizeText(candidate)).replace(/[）)】\],，。]+$/g, "");
    if (/^https?:\/\//i.test(normalized)) {
      return normalized.slice(0, 2_000);
    }
  }
  return "";
}

function findPushedMessage(messages, push) {
  const rawId = normalizeText(push?.rawid || push?.serverId || push?.id);
  if (rawId) {
    const exact = messages.find((item) => (
      normalizeText(String(item?.serverId ?? item?.rawid ?? item?.id ?? "")) === rawId
    ));
    if (exact) {
      return exact;
    }
    // A push id is authoritative. Falling back to a same-second/content row
    // here can resolve a temporarily missing image as its prompt or neighbour.
    return null;
  }
  const localId = normalizeLocalId(push?.localId);
  if (localId) {
    const exactLocal = messages.find((item) => normalizeLocalId(item?.localId) === localId) || null;
    if (exactLocal) {
      return exactLocal;
    }
  }
  const timestamp = normalizeEpochSeconds(push?.timestamp || push?.createTime);
  const content = normalizeText(push?.content);
  return messages.find((item) => (
    (!timestamp || normalizeEpochSeconds(item?.createTime) === timestamp)
    && (!content || normalizeText(item?.content) === content || normalizeText(item?.parsedContent) === content)
  )) || null;
}

function extractQuotedCreateTime(rawContent) {
  const referXml = extractXmlTag(rawContent, "refermsg");
  return normalizeEpochSeconds(extractXmlTag(referXml, "createtime"));
}

function resolveDeadlineBoundDirectMediaKind(raw) {
  if (!raw || normalizeText(raw?.replyToMessageId || raw?.quote?.platformMessageId)) {
    return "";
  }
  const localType = Number(raw?.localType);
  const explicitMediaKind = normalizeMediaKind(raw?.mediaType);
  const content = normalizeText(raw?.parsedContent || raw?.content);
  const inferredKind = explicitMediaKind
    || ({ 3: "image", 34: "voice", 43: "video" })[localType]
    || (Number(extractXmlTag(raw?.rawContent, "type")) === 6 ? "file" : "")
    || inferContentKind(content, raw?.rawContent);
  // Arbitrary cards and merged-forward XML may contain nested media tags. Only
  // explicit direct-message markers own an export deadline.
  const explicitDirect = explicitMediaKind === inferredKind
    || (inferredKind === "image" && (localType === 3 || /^\[图片\]$/.test(content)))
    || (inferredKind === "voice" && (localType === 34 || /^\[语音消息?\]$/.test(content)))
    || (inferredKind === "video" && (localType === 43 || /^\[视频\]$/.test(content)))
    || (inferredKind === "file" && (
      Number(extractXmlTag(raw?.rawContent, "type")) === 6 || /^\[文件\]$/.test(content)
    ));
  return explicitDirect ? inferredKind : "";
}

function resolveMediaExportWindowMs(kind) {
  return kind === "image" ? IMAGE_MEDIA_EXPORT_WINDOW_MS : DIRECT_MEDIA_EXPORT_WINDOW_MS;
}

function buildDirectMediaDeadline(raw, nowMs, kind = "") {
  const currentMs = Number.isFinite(Number(nowMs)) && Number(nowMs) > 0
    ? Number(nowMs)
    : Date.now();
  const sourceMs = normalizeEpochSeconds(raw?.createTime || raw?.timestamp) * 1_000;
  const baseMs = sourceMs > 0 && sourceMs <= currentMs ? sourceMs : currentMs;
  const mediaKind = kind || resolveDeadlineBoundDirectMediaKind(raw);
  return new Date(baseMs + resolveMediaExportWindowMs(mediaKind)).toISOString();
}

function messageExpectsMedia(raw) {
  return ["image", "voice", "video", "file"].includes(normalizeMediaKind(raw?.mediaType))
    || [3, 34, 43].includes(Number(raw?.localType));
}

function hasUsableMedia(raw) {
  const mediaPath = chooseMediaPath(raw);
  if (!mediaPath) {
    return false;
  }
  return normalizeMediaKind(raw?.mediaType) !== "image" || !isThumbnailPath(mediaPath);
}

function isThumbnailPath(filePath) {
  return /(?:^|[_-])t(?:\.[^.]+)?$/i.test(path.parse(filePath).name)
    || /(?:^|[\\/])thumb(?:nail)?s?(?:[\\/]|$)/i.test(filePath);
}

function normalizePushData(value) {
  if (value && typeof value === "object") {
    return value.data && typeof value.data === "object" ? value.data : value;
  }
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  } catch {
    return {};
  }
}

async function consumeSseStream(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const boundary = buffer.match(/\r?\n\r?\n/);
      if (!boundary || boundary.index == null) {
        break;
      }
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const event = parseSseBlock(block);
      if (event) {
        await onEvent(event);
      }
    }
  }
  buffer += decoder.decode();
  const event = parseSseBlock(buffer);
  if (event) {
    await onEvent(event);
  }
}

function parseSseBlock(block) {
  const lines = String(block || "").split(/\r?\n/);
  let event = "message";
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (!data.length) {
    return null;
  }
  const dataText = data.join("\n");
  try {
    return { event, data: JSON.parse(dataText) };
  } catch {
    return { event, data: dataText };
  }
}

function buildApiUrl(config, pathname) {
  const baseUrl = normalizeText(config?.weflowBaseUrl) || "http://127.0.0.1:5031";
  return new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function buildHeaders(config, extra = {}) {
  const token = normalizeText(config?.weflowToken);
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function assertHttpOk(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} returned HTTP ${response?.status || "error"}`);
  }
}

function buildEventKey(eventType, push) {
  const rawValue = push?.rawid ?? push?.serverId ?? push?.id ?? "";
  const rawId = normalizeText(typeof rawValue === "string" ? rawValue : String(rawValue));
  return rawId ? `${eventType}:${rawId}` : "";
}

function buildPolledMessagePush(row, chat, replayStartSeconds) {
  const rowChat = normalizeText(row?.talker || row?.sessionId || row?.chatUsername);
  if (rowChat && rowChat !== chat) {
    return null;
  }
  const serverId = normalizeText(String(row?.serverId ?? ""));
  const timestamp = normalizeEpochSeconds(row?.createTime || row?.timestamp);
  if (!serverId || !timestamp || timestamp < replayStartSeconds) {
    return null;
  }
  return {
    sessionId: chat,
    talker: chat,
    rawid: serverId,
    serverId,
    timestamp,
    createTime: timestamp,
    localId: Number.parseInt(row?.localId, 10) || 0,
    isSend: isSentMessage(row) ? 1 : 0,
    localType: Number(row?.localType) || 0,
    senderUsername: normalizeText(row?.senderUsername),
    content: normalizeText(row?.content),
    parsedContent: normalizeText(row?.parsedContent),
    rawContent: normalizeText(row?.rawContent),
  };
}

function comparePolledPushes(left, right) {
  return normalizeEpochSeconds(left?.timestamp) - normalizeEpochSeconds(right?.timestamp)
    || (Number(left?.localId) || 0) - (Number(right?.localId) || 0)
    || normalizeText(left?.serverId).localeCompare(normalizeText(right?.serverId));
}

async function fetchMessageRangePaginated({
  config,
  chat,
  startSeconds,
  endSeconds,
  limit,
  maxRequests,
  fetchImpl,
  signal,
}) {
  let requestCount = 0;
  const requestRange = async (rangeStart, rangeEnd, offset = 0) => {
    if (requestCount >= maxRequests) {
      return null;
    }
    requestCount += 1;
    const params = new URLSearchParams({
      talker: chat,
      limit: String(limit),
      start: String(rangeStart),
      end: String(rangeEnd),
    });
    if (offset > 0) {
      params.set("offset", String(offset));
    }
    const response = await fetchImpl(buildApiUrl(config, `/api/v1/messages?${params}`), {
      headers: buildHeaders(config),
      signal,
    });
    assertHttpOk(response, "WeFlow outgoing message poll");
    const payload = await response.json();
    const rows = Array.isArray(payload?.messages)
      ? payload.messages.filter((item) => item && typeof item === "object")
      : [];
    return { rows, hasMore: payload?.hasMore === true };
  };

  const fetchSingleSecond = async (timestamp, firstPage) => {
    const rows = [...firstPage.rows];
    let page = firstPage;
    let offset = page.rows.length;
    while (page.hasMore) {
      page = await requestRange(timestamp, timestamp, offset);
      if (!page) {
        return { rows: [], complete: false, throughSeconds: timestamp - 1 };
      }
      if (!page.rows.length) {
        throw new Error(`WeFlow outgoing pagination made no progress at ${timestamp} offset ${offset}`);
      }
      rows.push(...page.rows);
      offset += page.rows.length;
    }
    return { rows, complete: true, throughSeconds: timestamp };
  };

  const fetchRange = async (rangeStart, rangeEnd) => {
    const page = await requestRange(rangeStart, rangeEnd);
    if (!page) {
      return { rows: [], complete: false, throughSeconds: rangeStart - 1 };
    }
    if (!page.hasMore) {
      return { rows: page.rows, complete: true, throughSeconds: rangeEnd };
    }
    if (rangeStart >= rangeEnd) {
      return fetchSingleSecond(rangeStart, page);
    }
    const midpoint = rangeStart + Math.floor((rangeEnd - rangeStart) / 2);
    const older = await fetchRange(rangeStart, midpoint);
    if (!older.complete) {
      return older;
    }
    const newer = await fetchRange(midpoint + 1, rangeEnd);
    return {
      rows: [...older.rows, ...newer.rows],
      complete: newer.complete,
      throughSeconds: newer.complete ? rangeEnd : newer.throughSeconds,
    };
  };

  const fetched = await fetchRange(startSeconds, Math.max(startSeconds, endSeconds));
  const deduplicated = new Map();
  for (const row of fetched.rows) {
    const serverId = normalizeText(String(row?.serverId ?? row?.rawid ?? row?.id ?? ""));
    const localId = Number.parseInt(row?.localId, 10) || 0;
    const timestamp = normalizeEpochSeconds(row?.createTime || row?.timestamp);
    const key = serverId || `${timestamp}:${localId}:${normalizeText(row?.content || row?.parsedContent)}`;
    if (key && !deduplicated.has(key)) {
      deduplicated.set(key, row);
    }
  }
  return {
    rows: [...deduplicated.values()],
    requestCount,
    complete: fetched.complete,
    throughSeconds: Math.max(0, normalizeEpochSeconds(fetched.throughSeconds)),
  };
}

function normalizeOutgoingPollCursor(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    chat: normalizeText(raw.chat),
    polledThrough: normalizeEpochSeconds(raw.polledThrough),
    backfillActive: raw.backfillActive === true,
    latestTimestamp: normalizeEpochSeconds(raw.latestTimestamp),
    latestLocalId: Number.parseInt(raw.latestLocalId, 10) || 0,
    latestServerId: normalizeText(raw.latestServerId),
    stallAttempt: Math.max(0, Number.parseInt(raw.stallAttempt, 10) || 0),
    retryNotBefore: normalizeIsoDate(raw.retryNotBefore),
  };
}

function advanceOutgoingPollCursor({
  previous,
  chat,
  polledThrough,
  backfillActive = false,
  candidates,
  stallAttempt = 0,
  retryNotBefore = "",
}) {
  const prior = normalizeOutgoingPollCursor(previous);
  const latest = [...(Array.isArray(candidates) ? candidates : [])].sort(comparePolledPushes).pop() || null;
  const latestTimestamp = normalizeEpochSeconds(latest?.timestamp);
  const priorTuple = {
    timestamp: prior.latestTimestamp,
    localId: prior.latestLocalId,
    serverId: prior.latestServerId,
  };
  const latestTuple = {
    timestamp: latestTimestamp,
    localId: Number(latest?.localId) || 0,
    serverId: normalizeText(latest?.serverId),
  };
  const selected = latest && comparePolledPushes(latestTuple, priorTuple) >= 0 ? latestTuple : priorTuple;
  return {
    chat: normalizeText(chat),
    polledThrough: normalizeEpochSeconds(polledThrough),
    backfillActive: Boolean(backfillActive),
    latestTimestamp: normalizeEpochSeconds(selected.timestamp),
    latestLocalId: Number(selected.localId) || 0,
    latestServerId: normalizeText(selected.serverId),
    stallAttempt: Math.max(0, Number.parseInt(stallAttempt, 10) || 0),
    retryNotBefore: normalizeIsoDate(retryNotBefore),
  };
}

function isSentMessage(raw) {
  return raw?.isSend === true || Number(raw?.isSend) === 1;
}

function normalizeMediaKind(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "audio") {
    return "voice";
  }
  return ["image", "voice", "video", "file"].includes(normalized) ? normalized : "";
}

function inferContentKind(content, rawContent) {
  const text = `${normalizeText(content)}\n${normalizeText(rawContent)}`;
  if (/\[图片\]|<img\b/i.test(text)) return "image";
  if (/\[语音消息?\]|<voicemsg\b/i.test(text)) return "voice";
  if (/\[视频\]|<videomsg\b/i.test(text)) return "video";
  if (/\[文件\]|<appattach>[\s\S]*?<fileext>/i.test(text)) return "file";
  if (/https?:\/\//i.test(text)) return "link";
  return normalizeText(content) ? "text" : "unknown";
}

function defaultKindTitle(kind) {
  return ({ image: "图片", voice: "语音", video: "视频", file: "文件", link: "链接" })[kind] || "";
}

function extractXmlTag(xml, tag) {
  const source = String(xml || "");
  if (!source) return "";
  const escapedTag = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  return match ? decodeXmlEntities(match[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "")) : "";
}

function extractXmlBlocks(xml, tag) {
  const source = String(xml || "");
  const escapedTag = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escapedTag}>`, "gi"))]
    .map((match) => match[0]);
}

function decodeXmlEntities(value) {
  let text = String(value || "");
  for (let index = 0; index < 3; index += 1) {
    const decoded = text
      .replace(/&#x([0-9a-f]+);/gi, (_match, digits) => decodeXmlCodePoint(digits, 16))
      .replace(/&#([0-9]+);/g, (_match, digits) => decodeXmlCodePoint(digits, 10))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

function decodeXmlCodePoint(digits, radix) {
  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function cleanMessagePlaceholder(value) {
  return decodeXmlEntities(String(value || ""))
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function isPlaceholderText(value) {
  return /^\[(?:图片|语音消息?|视频|文件|聊天记录)\]$/.test(normalizeText(value));
}

function collapseText(value, limit, { preserveNewlines = false } = {}) {
  const source = String(value || "");
  const normalized = preserveNewlines
    ? source.split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n")
    : source.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function normalizeEpochSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed > 10_000_000_000 ? Math.floor(parsed / 1_000) : Math.floor(parsed);
}

function normalizePositiveInt(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function loadCursorState(filePath, { chat = "" } = {}) {
  const empty = {
    version: 3,
    seenIds: [],
    lastEventAt: "",
    deadLetters: [],
    pendingEvents: [],
    outgoingPollCursor: normalizeOutgoingPollCursor(null),
  };
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    const lastEventAt = normalizeText(parsed?.lastEventAt);
    const persistedPollCursor = normalizeOutgoingPollCursor(parsed?.outgoingPollCursor);
    const migratedPollCursor = !persistedPollCursor.chat && lastEventAt
      ? buildLegacyOutgoingPollCursor({ chat, lastEventAt })
      : persistedPollCursor;
    return {
      ...empty,
      seenIds: Array.isArray(parsed?.seenIds)
        ? parsed.seenIds.map(normalizeText).filter(Boolean).slice(-MAX_SEEN_IDS)
        : [],
      lastEventAt,
      deadLetters: Array.isArray(parsed?.deadLetters)
        ? parsed.deadLetters
          .map(normalizeDeadLetter)
          .filter(Boolean)
          .slice(-MAX_DEAD_LETTERS)
        : [],
      outgoingPollCursor: migratedPollCursor,
      pendingEvents: Array.isArray(parsed?.pendingEvents)
        ? parsed.pendingEvents
          .map((item) => {
            const eventType = normalizeText(item?.eventType) || "message.new";
            const push = normalizePushData(item?.push);
            const key = normalizeText(item?.key) || buildEventKey(eventType, push);
            const pairing = normalizePendingPairing(item?.pairing, {
              key,
              companionKeys: item?.companionKeys,
            });
            const companionKeys = normalizeCompanionKeys(item?.companionKeys, {
              anchorKey: pairing?.anchorKey,
            });
            const supportedEvent = eventType === "message.new" || eventType === "message.revoke";
            return supportedEvent && key
              ? {
                key,
                eventType,
                push,
                ...(eventType === "message.revoke" && normalizeIsoDate(item?.receivedAt)
                  ? { receivedAt: normalizeIsoDate(item.receivedAt) }
                  : {}),
                ...(eventType === "message.new" && normalizeIsoDate(item?.mediaDeadline)
                  ? { mediaDeadline: normalizeIsoDate(item.mediaDeadline) }
                  : {}),
                ...(normalizePendingItemRetryAttempt(item?.retryAttempt)
                  ? { retryAttempt: normalizePendingItemRetryAttempt(item.retryAttempt) }
                  : {}),
                ...(normalizeIsoDate(item?.retryNotBefore)
                  ? { retryNotBefore: normalizeIsoDate(item.retryNotBefore) }
                  : {}),
                ...(eventType === "message.new" && companionKeys.length ? { companionKeys } : {}),
                ...(eventType === "message.new" && pairing ? { pairing } : {}),
              }
              : null;
          })
          .filter(Boolean)
          .slice(-MAX_PENDING_EVENTS)
        : [],
    };
  } catch {
    return empty;
  }
}

function buildLegacyOutgoingPollCursor({ chat, lastEventAt }) {
  const normalizedChat = normalizeText(chat);
  const lastEventMs = Date.parse(normalizeText(lastEventAt));
  if (!normalizedChat || !Number.isFinite(lastEventMs) || lastEventMs <= 0) {
    return normalizeOutgoingPollCursor(null);
  }
  const lastEventSeconds = Math.floor(lastEventMs / 1_000);
  return normalizeOutgoingPollCursor({
    chat: normalizedChat,
    // The v1 cursor only recorded wall-clock receipt time. Start at the same
    // second (rather than the following one) and let persisted serverId keys
    // remove overlap, so an event racing the old save is still recovered.
    polledThrough: Math.max(0, lastEventSeconds - 1),
    backfillActive: true,
  });
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fsPromises.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fsPromises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsPromises.rename(temp, filePath);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayUntilAbort(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function isAbortError(error) {
  return error?.name === "AbortError" || /aborted/i.test(String(error?.message || ""));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIsoDate(value) {
  const normalized = normalizeText(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : "";
}

function isoFromNow(now) {
  const candidate = typeof now === "function" ? Number(now()) : Number.NaN;
  const timestamp = Number.isFinite(candidate) ? candidate : Date.now();
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

module.exports = {
  WeFlowInboxSource,
  consumeSseStream,
  fetchMessageDetails,
  normalizeWeFlowMessage,
  parseCombinedForward,
  parseSseBlock,
};
